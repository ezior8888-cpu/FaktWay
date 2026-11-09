/**
 * Pauza firmy po 429 z KSeF (L1a, plan „zero zgubionych faktur”, 08.11.2026).
 *
 * Po co: MF liczy limity API na parę (NIP, adres IP), a cała platforma wysyła
 * z jednego adresu. Po 429 MF tymczasowo blokuje kolejne żądania i podaje
 * w `Retry-After`, ile czekać; powtórki wydłużają blokadę, a przy powtarzających
 * się naruszeniach MF może zablokować podmiot albo zakres adresów IP, czyli
 * wszystkie firmy naraz (`ksef-docs/limity/limity-api.md`). Do tej zmiany 429
 * zatrzymywał tylko jedną fakturę, a kolejne żądania tej firmy (inne faktury,
 * UPO, skrzynka, historia) dalej uderzały w limit.
 *
 * Jak:
 *   - `recordKsefRateLimit` zapisuje koniec pauzy dla (środowisko, NIP) po
 *     każdej odpowiedzi 429: pełny `Retry-After` (bez obcięcia do godziny),
 *     tylko wydłużanie, nigdy skracanie;
 *   - `ksefPausedUntil` mówi, czy firma jest w pauzie; bramka w `ksefFetch`
 *     (`lib/ksef/client.ts`) nie wysyła wtedy żadnego żądania tej firmy;
 *   - NIP żądania niesie kontekst (`runWithKsefNip`), który zakłada kolejka
 *     per NIP (`ksefRateLimiter.enqueue`), więc logowanie, odświeżenie sesji
 *     i każde żądanie w środku zadania są objęte bez zmiany wywołań.
 *   - hamulec wysyłki (`ksefSendBrakeActive`): wiele firm z 429 naraz to już
 *     nie limit jednej firmy, tylko sygnał, że KSeF ogranicza nasz adres —
 *     jak `inboxRateLimitBrake` w skrzynce.
 *
 * Gdzie: Redis (`lib/cache/redis.ts`), bo pauza musi przeżyć restart workera
 * (wdrożenie w trakcie pauzy) i obejmować aplikację web (ten sam adres IP).
 * Zapas w pamięci procesu: awaria albo brak Redisa nie zatrzymuje wysyłki
 * (fail-open, odczyt z limitem czasu `KSEF_PAUSE_STORE_TIMEOUT_MS`), a pauzy
 * zapisane przez ten proces działają dalej. Worker pg-boss to jeden proces,
 * więc w nim pamięć wystarcza; Redis jest dla restartu i drugiego procesu.
 *
 * Bez migracji: stan jest ulotny (najdłużej doba), a jego utrata kosztuje
 * najwyżej jedno żądanie, które dostanie 429 i zapisze pauzę od nowa.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import { cacheKeys } from '@/lib/cache/keys';
import { getRedis, isRedisConfigured } from '@/lib/cache/redis';
import { RetryAfterError } from '@/lib/jobs/errors';
import type { KsefEnvironment } from '@/types/ksef';

/** 429 bez (czytelnego) `Retry-After`. MF podaje nagłówek, to tylko zapas. */
export const KSEF_PAUSE_DEFAULT_MS = 60_000;
/**
 * Bezpiecznik na absurdalny nagłówek (jak `RATE_LIMIT_MAX_MS` historii KSeF).
 * Dawne obcięcie do godziny (`retry-schedule.ts`) zakładało Offline24, który
 * jest wstrzymany od 02.10.2026; krótsze czekanie niż podał MF tylko
 * wydłużałoby blokadę.
 */
export const KSEF_PAUSE_MAX_MS = 24 * 3_600_000;
/** Limit czasu jednego odczytu/zapisu w Redisie: dłużej = zapas w pamięci (fail-open). */
export const KSEF_PAUSE_STORE_TIMEOUT_MS = 1_000;
/** Jak często proces pyta Redis o pauzę tej samej firmy (odpytywanie statusu idzie co 2 s). */
export const KSEF_PAUSE_REMOTE_REFRESH_MS = 5_000;

/** Okno hamulca wysyłki: firmy z 429 w ostatnich 10 minutach (jak `INBOX_BRAKE_WINDOW_SECONDS`). */
export const KSEF_SEND_BRAKE_WINDOW_MS = 10 * 60_000;
/** Od tylu firm z 429 w oknie hamulec działa (jak `INBOX_BRAKE_MIN_FIRMS`). */
export const KSEF_SEND_BRAKE_MIN_FIRMS = 5;
/** W hamulcu przechodzi co czwarte zadanie na minutę (jak `INBOX_BRAKE_CAPACITY_DIVISOR`). */
export const KSEF_SEND_BRAKE_DIVISOR = 4;
/** Zadanie zatrzymane przez hamulec próbuje znów po tylu ms (plus rozrzut). */
export const KSEF_SEND_BRAKE_RETRY_MS = 60_000;

/** Rozrzut końca czekania: 20% pozostałego czasu, najmniej 5 s, najwięcej 5 min. */
const JITTER_SHARE = 0.2;
const JITTER_MIN_MS = 5_000;
const JITTER_MAX_MS = 5 * 60_000;

// ═══════════════════════════════════════════════════════════════
// Kontekst NIP żądania
// ═══════════════════════════════════════════════════════════════

const nipContext = new AsyncLocalStorage<{ nip: string }>();

/** Uruchamia `fn` z NIP-em firmy w kontekście — każde `ksefFetch` w środku przechodzi przez pauzę tej firmy. */
export function runWithKsefNip<T>(nip: string, fn: () => Promise<T>): Promise<T> {
  return nipContext.run({ nip }, fn);
}

/** NIP firmy bieżącego żądania KSeF albo `null` (żądanie poza kolejką firmy). */
export function currentKsefNip(): string | null {
  return nipContext.getStore()?.nip ?? null;
}

// ═══════════════════════════════════════════════════════════════
// Magazyn: pamięć procesu + Redis
// ═══════════════════════════════════════════════════════════════

const memoryPauses = new Map<string, number>();
const remoteReads = new Map<string, { at: number; until: number | null }>();
const memoryFirms = new Map<string, Map<string, number>>();
const remoteBrakeReads = new Map<string, { at: number; firms: number }>();
let lastStoreWarningAt = 0;

function pauseKey(env: KsefEnvironment, nip: string): string {
  return cacheKeys.ksefRateLimitPause(env, nip);
}

function warnStore(operation: string, error: unknown): void {
  const now = Date.now();
  if (now - lastStoreWarningAt < 60_000) return;
  lastStoreWarningAt = now;
  console.warn(
    `[ksef.rate-limit-pause] Redis ${operation} nieudany — pauza tylko w pamięci procesu`,
    error instanceof Error ? error.message : String(error),
  );
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        handle = setTimeout(() => reject(new Error(`timeout ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    if (handle) clearTimeout(handle);
  }
}

function asMs(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Długość pauzy z `Retry-After`: pełna wartość, domyślnie minuta, najwyżej doba. */
export function ksefPauseLengthMs(retryAfterMs: number | null | undefined): number {
  const requested = typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs > 0
    ? retryAfterMs
    : KSEF_PAUSE_DEFAULT_MS;
  return Math.min(KSEF_PAUSE_MAX_MS, Math.max(1_000, requested));
}

/**
 * Zapisuje pauzę firmy po odpowiedzi 429 i dopisuje firmę do okna hamulca.
 * Zwraca koniec pauzy (ms). Nigdy nie rzuca: awaria Redisa zostawia pauzę
 * w pamięci procesu.
 */
export async function recordKsefRateLimit(
  env: KsefEnvironment,
  nip: string,
  retryAfterMs: number | null | undefined,
): Promise<number> {
  const now = Date.now();
  const key = pauseKey(env, nip);
  const candidate = now + ksefPauseLengthMs(retryAfterMs);
  const until = Math.max(candidate, memoryPauses.get(key) ?? 0);
  memoryPauses.set(key, until);
  remoteReads.set(key, { at: now, until });

  const firms = memoryFirms.get(env) ?? new Map<string, number>();
  firms.set(nip, now);
  memoryFirms.set(env, firms);
  remoteBrakeReads.delete(env);

  if (!isRedisConfigured()) return until;
  try {
    const redis = getRedis();
    const stored = asMs(await withTimeout(redis.get(key), KSEF_PAUSE_STORE_TIMEOUT_MS));
    if (stored === null || stored < until) {
      await withTimeout(redis.set(key, String(until), { px: Math.max(1_000, until - now) }), KSEF_PAUSE_STORE_TIMEOUT_MS);
    }
    const brakeKey = cacheKeys.ksefRateLimitedFirms(env);
    await withTimeout(
      Promise.all([
        redis.zadd(brakeKey, { score: now, member: nip }),
        redis.zremrangebyscore(brakeKey, 0, now - KSEF_SEND_BRAKE_WINDOW_MS),
        redis.pexpire(brakeKey, KSEF_SEND_BRAKE_WINDOW_MS),
      ]),
      KSEF_PAUSE_STORE_TIMEOUT_MS,
    );
  } catch (error) {
    warnStore('zapis', error);
  }
  return until;
}

/**
 * Koniec pauzy firmy (ms) albo `null`, gdy firma nie jest w pauzie. Czyta
 * pamięć procesu i (najwyżej co `KSEF_PAUSE_REMOTE_REFRESH_MS`) Redis.
 * Nigdy nie rzuca; awaria Redisa = sama pamięć (fail-open).
 */
export async function ksefPausedUntil(env: KsefEnvironment, nip: string): Promise<number | null> {
  const now = Date.now();
  const key = pauseKey(env, nip);
  let until = memoryPauses.get(key) ?? null;
  if (until !== null && until <= now) {
    memoryPauses.delete(key);
    until = null;
  }

  if (isRedisConfigured()) {
    const cached = remoteReads.get(key);
    let remote: number | null;
    if (cached && now - cached.at < KSEF_PAUSE_REMOTE_REFRESH_MS) {
      remote = cached.until;
    } else {
      try {
        remote = asMs(await withTimeout(getRedis().get(key), KSEF_PAUSE_STORE_TIMEOUT_MS));
      } catch (error) {
        warnStore('odczyt', error);
        remote = cached?.until ?? null;
      }
      remoteReads.set(key, { at: now, until: remote });
    }
    if (remote !== null && remote > now && (until === null || remote > until)) until = remote;
  }

  return until !== null && until > now ? until : null;
}

/**
 * Hamulec wysyłki: co najmniej `KSEF_SEND_BRAKE_MIN_FIRMS` różnych firm
 * dostało 429 w ostatnich 10 minutach. Nigdy nie rzuca.
 */
export async function ksefSendBrakeActive(env: KsefEnvironment): Promise<boolean> {
  const now = Date.now();
  const since = now - KSEF_SEND_BRAKE_WINDOW_MS;
  const firms = memoryFirms.get(env);
  let local = 0;
  if (firms) {
    for (const [nip, at] of firms) {
      if (at < since) firms.delete(nip);
      else local += 1;
    }
  }

  let remote = 0;
  if (isRedisConfigured()) {
    const cached = remoteBrakeReads.get(env);
    if (cached && now - cached.at < KSEF_PAUSE_REMOTE_REFRESH_MS) {
      remote = cached.firms;
    } else {
      try {
        const count = await withTimeout(
          getRedis().zcount(cacheKeys.ksefRateLimitedFirms(env), since, '+inf'),
          KSEF_PAUSE_STORE_TIMEOUT_MS,
        );
        remote = typeof count === 'number' ? count : 0;
      } catch (error) {
        warnStore('odczyt hamulca', error);
        remote = cached?.firms ?? 0;
      }
      remoteBrakeReads.set(env, { at: now, firms: remote });
    }
  }

  return Math.max(local, remote) >= KSEF_SEND_BRAKE_MIN_FIRMS;
}

// ═══════════════════════════════════════════════════════════════
// Rozrzut i przepustowość w hamulcu
// ═══════════════════════════════════════════════════════════════

/** Ułamek [0, 1) z tekstu (FNV-1a + mieszanie jak `inboxPhaseFraction`): ten sam ziarno = ten sam wynik. */
export function seedFraction(seed: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return (hash >>> 0) / 0x1_0000_0000;
}

/**
 * Ile czekać do końca pauzy: pozostały czas plus rozrzut tylko w górę
 * (`Retry-After` to dolna granica), żeby faktury, które padły razem, nie
 * wróciły w tej samej sekundzie i nie dostały 429 od nowa.
 */
export function ksefPauseWaitMs(remainingMs: number, seed: string): number {
  const remaining = Math.max(0, remainingMs);
  const spread = Math.min(JITTER_MAX_MS, Math.max(JITTER_MIN_MS, remaining * JITTER_SHARE));
  return Math.max(1_000, Math.ceil(remaining + seedFraction(seed) * spread));
}

/** W hamulcu: czy to zadanie przechodzi w tej minucie (deterministycznie, co `KSEF_SEND_BRAKE_DIVISOR`-te). */
export function ksefSendBrakeAllows(seed: string, nowMs: number): boolean {
  const minute = Math.floor(nowMs / 60_000);
  return Math.floor(seedFraction(`${seed}:${minute}`) * KSEF_SEND_BRAKE_DIVISOR) === 0;
}

/** Testy: czyści pauzy i okno hamulca w pamięci procesu (Redis w testach nie jest skonfigurowany). */
export function resetKsefRateLimitPausesForTests(): void {
  memoryPauses.clear();
  remoteReads.clear();
  memoryFirms.clear();
  remoteBrakeReads.clear();
  lastStoreWarningAt = 0;
}

/**
 * `tests/setup.ts` czyści stan przed każdym testem przez ten symbol, bez
 * importu modułu (import w pliku setup ładowałby prawdziwe moduły przed
 * atrapami `vi.mock` z plików testów). Bez tego 429 z jednego testu
 * zostawiałby pauzę dla `1234567890` w następnych.
 */
(globalThis as Record<symbol, unknown>)[Symbol.for('faktway.ksefRateLimitPause.reset')] =
  resetKsefRateLimitPausesForTests;

/**
 * Błąd ponowienia joba na czas pauzy firmy: `RetryAfterError` z `pause: true`
 * (bez zużycia próby i odczekań, `lib/jobs/retry.ts`), czekanie do końca
 * pauzy z rozrzutem w górę. `remainingMs` przycinany do ≥ 0 — ujemny albo
 * NaN rzuciłby w `parseDurationMs` zwykły błąd, który zużyłby próbę.
 */
export function ksefPauseRetryError(
  message: string,
  remainingMs: number,
  seed: string,
  cause?: unknown,
): RetryAfterError {
  const remaining = Number.isFinite(remainingMs) ? Math.max(0, remainingMs) : KSEF_PAUSE_DEFAULT_MS;
  return new RetryAfterError(message, ksefPauseWaitMs(remaining, seed), {
    pause: true,
    countsAsAttempt: false,
    ...(cause !== undefined ? { cause } : {}),
  });
}

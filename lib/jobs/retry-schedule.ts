/**
 * Custom retry schedule dla KSeF submit (Faza 23 sekcja 2).
 *
 * Spec: 30s → 2min → 5min → 15min → 1h. Pięć opóźnień = pięć retries =
 * sześć prób (initial + 5 retries). Po wyczerpaniu worker woła `onExhausted`
 * (`onSubmitInvoiceExhausted`) — dziś bez Offline24 (wstrzymany 02.10.2026).
 *
 * Dlaczego custom zamiast domyślnego backoffu workera:
 *   - domyślny (`defaultRetryDelayMs`) to 10s, 30s, 1m, 5m, 15m
 *   - My chcemy bardziej agresywny pierwszy retry (30s zamiast 10s), bo wiemy
 *     z prior projektów że MF rate-limity per-sekundę są chwilowe
 *   - Ostatni retry o 1h daje MF czas na recovery po większej awarii
 *     (np. wszystkie maintenance windowy < 1h)
 *
 * Schedule mapuje "after fail N → wait X before attempt N+1":
 *
 *   attempt 0 → fail → wait 30s  → attempt 1
 *   attempt 1 → fail → wait 2m   → attempt 2
 *   attempt 2 → fail → wait 5m   → attempt 3
 *   attempt 3 → fail → wait 15m  → attempt 4
 *   attempt 4 → fail → wait 1h   → attempt 5
 *   attempt 5 → fail → onExhausted
 */

/** Czas jak w `parseDurationMs`: '30s', '2m', '1h'. */
export type DurationStr = `${number}${'ms' | 's' | 'm' | 'h' | 'd'}`;

import { KsefApiError } from '@/lib/ksef/client';
import { KSEF_PAUSE_MAX_MS, seedFraction } from '@/lib/ksef/rate-limit-pause';

import { parseDurationMs } from './duration';

/**
 * Maksymalna liczba ponowień joba wysyłki (`maxRetries` w rejestrze workera).
 * Initial attempt + 5 retries = 6 prób total = 5 delay'ów ze schedulu poniżej.
 */
export const KSEF_MAX_RETRIES = 5;

/**
 * Schedule opóźnień przed kolejną próbą. Index = numer aktualnej (failed)
 * próby (zero-indexed, jak `attempt` w kontekście joba).
 */
const KSEF_BACKOFF_SCHEDULE = [
  '30s', // po fail #0
  '2m', // po fail #1
  '5m', // po fail #2
  '15m', // po fail #3
  '1h', // po fail #4
] as const satisfies readonly DurationStr[];

/**
 * Zwraca opóźnienie do `RetryAfterError`, biorąc pod uwagę numer próby.
 * Po wyczerpaniu schedulu — fallback do max (1h), żeby nie crashować z
 * out-of-bounds (defensive: gdyby ktoś podniósł `retries` ponad 5).
 */
export function getKsefRetryDelay(attempt: number): DurationStr {
  if (attempt < 0) return KSEF_BACKOFF_SCHEDULE[0];
  if (attempt >= KSEF_BACKOFF_SCHEDULE.length) {
    return KSEF_BACKOFF_SCHEDULE[KSEF_BACKOFF_SCHEDULE.length - 1]!;
  }
  return KSEF_BACKOFF_SCHEDULE[attempt]!;
}

/**
 * Opóźnienie ponowienia wysyłki: `Retry-After` z KSeF ma pierwszeństwo
 * przed harmonogramem (AUD-92). Dla 429 w pełnej długości (L1a, 08.11.2026),
 * z bezpiecznikiem doby (`KSEF_PAUSE_MAX_MS`): krótsze czekanie niż podał MF
 * tylko wydłuża blokadę (runner i tak obsługuje 429 jako pauzę firmy,
 * `lib/ksef/rate-limit-pause.ts`). Inne odpowiedzi z `Retry-After` (np. 503)
 * najwyżej godzinę (`KSEF_RETRY_AFTER_MAX_MS`), bo czekanie trwa z fakturą
 * w `sending`.
 */
export function ksefRetryDelayFor(error: unknown, attempt: number): DurationStr {
  if (error instanceof KsefApiError && error.retryAfterMs !== null) {
    // 429 = pauza firmy, pełna długość. Inne odpowiedzi (503 itp.) czekają
    // z fakturą przejętą (`sending`), więc najwyżej godzinę jak dawniej —
    // dłużej włączałoby alarm „faktura w sending” i I2 (przegląd L1a).
    const cap = error.status === 429 ? KSEF_PAUSE_MAX_MS : KSEF_RETRY_AFTER_MAX_MS;
    const seconds = Math.max(1, Math.ceil(Math.min(cap, error.retryAfterMs) / 1000));
    return `${seconds}s`;
  }
  return getKsefRetryDelay(attempt);
}

/** Górna granica `Retry-After` dla odpowiedzi innych niż 429 (czekanie z fakturą w `sending`). */
export const KSEF_RETRY_AFTER_MAX_MS = 3_600_000;

/** Rozrzut harmonogramu: do +20% opóźnienia, deterministycznie z ziarna (np. id faktury). */
const KSEF_RETRY_JITTER_SHARE = 0.2;

/**
 * Opóźnienie z harmonogramu z rozrzutem tylko w górę (L1a): faktury, które
 * padły razem (awaria KSeF, fala 429), nie wracają w tej samej sekundzie.
 * Ziarno = id faktury, więc ponowienie tej samej faktury dostaje ten sam rozrzut.
 */
export function ksefRetryDelayMs(attempt: number, seed: string): number {
  const base = parseDurationMs(getKsefRetryDelay(attempt));
  return base + Math.floor(seedFraction(seed) * base * KSEF_RETRY_JITTER_SHARE);
}

/**
 * Jedna reguła opóźnienia ponowienia w runnerze wysyłki (L1a, pkt 4 karty):
 * `Retry-After` z odpowiedzi KSeF, jeśli jest (`ksefRetryDelayFor`), inaczej
 * harmonogram z rozrzutem po ziarnie (id faktury).
 */
export function ksefRetryDelayMsFor(error: unknown, attempt: number, seed: string): number {
  if (error instanceof KsefApiError && error.retryAfterMs !== null) {
    return parseDurationMs(ksefRetryDelayFor(error, attempt));
  }
  return ksefRetryDelayMs(attempt, seed);
}

/**
 * Limit równoległości wysyłki na firmę w aplikacji (`groupConcurrency` kolejki
 * `invoice.submit.requested`, `groupId = tenantId`). 2 od L1a (08.11.2026),
 * wcześniej 100, czyli bez limitu: jedna firma mogła zająć wszystkie 5 slotów
 * (`localConcurrency`, `lib/jobs/handlers/package-d.ts`).
 *
 * Dlaczego 2: MF liczy limity na parę (NIP, adres IP), a wysyłka otwiera sesję
 * na fakturę i odpytuje status co 2 s (do 30 razy). Dwie wysyłki naraz to do
 * ok. 60 zapytań o status na minutę przy limicie 120 (`invoiceStatus`) i
 * zapas na otwarcia sesji (30/min); więcej równoległości nie daje
 * przepustowości, bo sufitem jest 120 otwarć sesji na godzinę. Liczba slotów
 * razem (5) bez zmian — podnosi ją sesja 15 planu skalowania po pomiarze.
 * Limit pg-boss jest miękki (równoległe pobrania mogą go chwilowo
 * przekroczyć); przed MF chroni pauza po 429.
 *
 * Kilka firm w aplikacji z tym samym NIP-em dzieli jeden budżet MF, a ten
 * limit liczy się per firma w aplikacji (multi-org) — budżet na NIP to L1b.
 */
export const KSEF_TENANT_CONCURRENCY_LIMIT = 2;

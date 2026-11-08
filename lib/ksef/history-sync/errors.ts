/**
 * Błędy synchronizacji historii KSeF → skutek (decyzja Bartosza 22.10.2026).
 *
 * Skutek jest jeden z pięciu:
 *   - `session`  — błąd całej firmy (`last_error_code`): przebieg się kończy,
 *     klient albo operator dostaje komunikat; nic nie liczy prób faktur,
 *   - `pause`    — 429: pauza firmy na pełny `Retry-After` (60 s – 24 h),
 *   - `transient`— 5xx / 408 / sieć: ponowimy; dwa w jednym przebiegu =
 *     `ksef_unavailable`,
 *   - `not_ready`— pobranie faktury: KSeF 21165 (jeszcze niedostępna) —
 *     za 15 min, bez liczenia próby,
 *   - `item_error`— pobranie faktury: inne 400/404 — próba się liczy.
 *
 * Szczegół dla operatora to `HTTP {status} {ścieżka} kody:{…}` — nigdy treść
 * odpowiedzi (mogłaby nieść dane kontrahenta).
 *
 * Kody błędów KSeF czyta LOKALNA kopia parsera z `lib/ksef/submit.ts`
 * (`ksefErrorCodes`) — tamtego modułu nie wolno importować: to ścieżka
 * wysyłki (strażnik OUTGOING_SINKS w tests/unit/flo-architecture.test.ts).
 */

import { KsefApiError } from '@/lib/ksef/client';
import { KsefCredentialsError } from '@/lib/supabase/admin-queries';

import { RATE_LIMIT_DEFAULT_MS, RATE_LIMIT_MAX_MS, RATE_LIMIT_MIN_MS } from './constants';

/** KSeF: faktura jeszcze niedostępna do pobrania (tuż po nadaniu numeru). */
export const KSEF_INVOICE_NOT_YET_AVAILABLE = 21165;

export type KsefHistorySessionCode =
  | 'credentials'
  | 'certificate_expired'
  | 'permission'
  | 'ksef_unavailable'
  | 'internal';

export type HistoryErrorOutcome =
  | { kind: 'session'; code: KsefHistorySessionCode; detail: string; invalidateSession: boolean }
  | { kind: 'pause'; pauseMs: number; detail: string }
  | { kind: 'transient'; detail: string }
  | { kind: 'not_ready'; detail: string }
  | { kind: 'item_error'; detail: string };

/** Gdzie wystąpił błąd: otwarcie sesji, zapytanie o metadane, pobranie XML faktury. */
export type HistoryCallPhase = 'session' | 'metadata' | 'download';

/** KSeF zwrócił pusty XML faktury — błąd pozycji, nie firmy. */
export class KsefHistoryEmptyXmlError extends Error {
  constructor(readonly ksefNumber: string) {
    super('KSeF zwrócił pusty XML faktury');
    this.name = 'KsefHistoryEmptyXmlError';
  }
}

/**
 * Kopia `ksefErrorCodes` z `lib/ksef/submit.ts` (ten sam kształt: `errors[].code`,
 * `exception.exceptionDetailList[].exceptionCode`, `exceptionDetailList[]` na
 * wierzchu; tekst `application/problem+json` parsowany jak JSON).
 */
export function historyKsefErrorCodes(body: unknown): number[] {
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      return [];
    }
  }
  if (!body || typeof body !== 'object') return [];
  const b = body as {
    errors?: Array<{ code?: unknown }>;
    exception?: { exceptionDetailList?: Array<{ exceptionCode?: unknown }> };
    exceptionDetailList?: Array<{ exceptionCode?: unknown }>;
  };
  const codes = [
    ...(b.errors ?? []).map((e) => e.code),
    ...(b.exception?.exceptionDetailList ?? []).map((e) => e.exceptionCode),
    ...(b.exceptionDetailList ?? []).map((e) => e.exceptionCode),
  ];
  return codes.map(Number).filter((c) => Number.isInteger(c));
}

/** Ścieżka z komunikatu `KSeF API {METODA} {ścieżka} …` — bez query i bez numerów faktur. */
function apiPath(error: KsefApiError): string {
  const match = /^KSeF API [A-Z]+ (\S+)/.exec(error.message);
  const path = match?.[1]?.split('?')[0] ?? '?';
  return path.replace(/\/invoices\/ksef\/[^/]+/, '/invoices/ksef/{n}');
}

export function ksefErrorDetail(error: KsefApiError): string {
  const codes = historyKsefErrorCodes(error.body);
  return `HTTP ${error.status} ${apiPath(error)} kody:${codes.length ? codes.join(',') : '-'}`.slice(0, 300);
}

const NETWORK_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
]);

/** Błąd sieci z `fetch` (undici) — bez statusu HTTP. */
export function isNetworkError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth++) {
    const code = (current as Error & { code?: unknown }).code;
    if (typeof code === 'string' && NETWORK_CODES.has(code)) return true;
    if (current.name === 'TypeError' && /fetch failed|network/i.test(current.message)) return true;
    current = (current as Error & { cause?: unknown }).cause;
  }
  return false;
}

/** Pauza po 429: `Retry-After` serwera (bez obcinania w dół poniżej jego wartości), 60 s – 24 h. */
export function rateLimitPauseMs(retryAfterMs: number | null | undefined): number {
  const requested = typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs)
    ? retryAfterMs
    : RATE_LIMIT_DEFAULT_MS;
  return Math.min(RATE_LIMIT_MAX_MS, Math.max(RATE_LIMIT_MIN_MS, requested));
}

function certificateExpired(certificateExpiry: string | null | undefined, now: Date): boolean {
  if (!certificateExpiry) return false;
  const at = Date.parse(certificateExpiry);
  return Number.isFinite(at) && at < now.getTime();
}

/**
 * Skutek błędu. `null` = błąd nieoczekiwany (nasz kod) — wywołujący zapisuje
 * `internal`, zgłasza do Sentry i rzuca dalej.
 */
export function classifyHistoryError(
  error: unknown,
  ctx: { phase: HistoryCallPhase; certificateExpiry: string | null; now: Date },
): HistoryErrorOutcome | null {
  if (error instanceof KsefCredentialsError || (error instanceof Error && error.name === 'KsefCredentialsError')) {
    const reason = (error as KsefCredentialsError).reason;
    // Brak certyfikatu albo NIP niezweryfikowany — naprawia klient. Klucz,
    // NIP z szyfrogramu, odczyt bazy — operator.
    const code = reason === 'missing' || reason === 'not-verified' ? 'credentials' : 'internal';
    return { kind: 'session', code, detail: `poświadczenia: ${reason}`, invalidateSession: false };
  }

  if (error instanceof KsefHistoryEmptyXmlError) {
    return ctx.phase === 'download'
      ? { kind: 'item_error', detail: 'pusty XML faktury' }
      : { kind: 'session', code: 'internal', detail: 'pusty XML poza pobraniem', invalidateSession: false };
  }

  if (error instanceof KsefApiError) {
    const detail = ksefErrorDetail(error);
    const status = error.status;
    if (status === 429) {
      return { kind: 'pause', pauseMs: rateLimitPauseMs(error.retryAfterMs), detail };
    }
    if (status === 408 || (status >= 500 && status < 600)) {
      return { kind: 'transient', detail };
    }
    if (ctx.phase === 'session') {
      if (status === 400 || status === 401 || status === 403) {
        return {
          kind: 'session',
          code: certificateExpired(ctx.certificateExpiry, ctx.now) ? 'certificate_expired' : 'credentials',
          detail,
          invalidateSession: false,
        };
      }
      return { kind: 'session', code: 'internal', detail, invalidateSession: false };
    }
    if (status === 401) {
      return { kind: 'session', code: 'credentials', detail, invalidateSession: true };
    }
    if (status === 403) {
      return { kind: 'session', code: 'permission', detail, invalidateSession: false };
    }
    if (ctx.phase === 'download') {
      if (status === 400 && historyKsefErrorCodes(error.body).includes(KSEF_INVOICE_NOT_YET_AVAILABLE)) {
        return { kind: 'not_ready', detail };
      }
      if (status === 400 || status === 404) return { kind: 'item_error', detail };
    }
    // 400 przy zapytaniu o metadane = nasze zapytanie jest złe — operator.
    return { kind: 'session', code: 'internal', detail, invalidateSession: false };
  }

  if (isNetworkError(error)) {
    return { kind: 'transient', detail: `sieć: ${(error as Error).message}`.slice(0, 300) };
  }

  if (ctx.phase === 'session' && error instanceof Error) {
    // Odrzucone uwierzytelnienie (status ≥ 400 w odpytywaniu `/auth/{ref}`).
    if (error.message.startsWith('KSeF auth failed')) {
      return {
        kind: 'session',
        code: certificateExpired(ctx.certificateExpiry, ctx.now) ? 'certificate_expired' : 'credentials',
        detail: 'uwierzytelnienie odrzucone przez KSeF',
        invalidateSession: false,
      };
    }
    if (error.message.startsWith('KSeF auth polling timed out')) {
      return { kind: 'transient', detail: 'uwierzytelnienie bez odpowiedzi KSeF' };
    }
  }

  return null;
}

/** Szczegół błędu nieoczekiwanego: nazwa + ≤ 200 znaków treści (bez treści odpowiedzi KSeF). */
export function unexpectedErrorDetail(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message.slice(0, 200)}`.slice(0, 300);
  return String(error).slice(0, 200);
}

/**
 * Błąd przebiegu skrzynki → klasa harmonogramu (`inbox-schedule.ts`).
 *
 *   - `credentials`: certyfikat, token, uprawnienie; naprawia klient, ponowienie
 *     co 15 minut niczego nie zmieni,
 *   - `rate_limit`: 429, czekamy tyle, ile każe KSeF,
 *   - `ksef`: 5xx, 408, sieć, brak odpowiedzi; firma nie jest niczemu winna,
 *   - `other`: nasz błąd; job pada, żeby trafił do Sentry i dziennika przebiegów.
 *
 * `KsefCredentialsError` rozpoznajemy po nazwie, jak `lib/jobs/retry.ts`: moduł
 * `admin-queries` ciągnie klienta Supabase, a tu wystarcza kształt błędu.
 */

import { isNetworkError, ksefErrorDetail } from '@/lib/ksef/history-sync/errors';

import { KsefApiError } from './client';
import type { InboxPollErrorClass } from './inbox-schedule';

export interface InboxPollFailure {
  errorClass: InboxPollErrorClass;
  /** `Retry-After` z KSeF (tylko 429). */
  retryAfterMs: number | null;
  /** Do logu: status, ścieżka, kody. Nigdy treść odpowiedzi ani dane firmy. */
  detail: string;
}

/** `tenant-read` to awaria odczytu bazy, nie złe poświadczenia. */
const CREDENTIAL_REASONS = new Set(['missing', 'not-verified', 'decrypt', 'nip-mismatch']);
const AUTH_PATH = /^KSeF API [A-Z]+ \/auth\//;

export function classifyInboxPollError(error: unknown): InboxPollFailure {
  if (error instanceof Error && error.name === 'KsefCredentialsError') {
    const reason = (error as Error & { reason?: string }).reason ?? '?';
    return {
      errorClass: CREDENTIAL_REASONS.has(reason) ? 'credentials' : 'other',
      retryAfterMs: null,
      detail: `poświadczenia: ${reason}`,
    };
  }

  if (error instanceof KsefApiError) {
    const detail = ksefErrorDetail(error);
    const { status } = error;
    if (status === 429) return { errorClass: 'rate_limit', retryAfterMs: error.retryAfterMs, detail };
    if (status === 408 || (status >= 500 && status < 600)) return { errorClass: 'ksef', retryAfterMs: null, detail };
    if (status === 401 || status === 403) return { errorClass: 'credentials', retryAfterMs: null, detail };
    // 400 przy logowaniu to KSeF odrzucający podpis albo certyfikat. 400 przy
    // zapytaniu o metadane znaczy, że nasze zapytanie jest złe.
    if (AUTH_PATH.test(error.message)) return { errorClass: 'credentials', retryAfterMs: null, detail };
    return { errorClass: 'other', retryAfterMs: null, detail };
  }

  if (isNetworkError(error)) {
    return { errorClass: 'ksef', retryAfterMs: null, detail: 'sieć: brak połączenia z KSeF' };
  }

  if (error instanceof Error) {
    if (error.message.startsWith('KSeF auth failed')) {
      return { errorClass: 'credentials', retryAfterMs: null, detail: 'uwierzytelnienie odrzucone przez KSeF' };
    }
    if (error.message.startsWith('KSeF auth polling timed out')) {
      return { errorClass: 'ksef', retryAfterMs: null, detail: 'uwierzytelnienie bez odpowiedzi KSeF' };
    }
  }

  return { errorClass: 'other', retryAfterMs: null, detail: 'błąd nieoczekiwany' };
}

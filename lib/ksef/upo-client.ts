/**
 * Klient KSeF API do pobierania Urzędowych Poświadczeń Odbioru (UPO).
 *
 * Wymaga `service_role` (ładowanie credentials z DB) — używać wyłącznie
 * w Inngest / API routes po stronie serwera, nie w Client Components.
 */

import type { KsefEnvironment } from '@/types/ksef';

import { getTenantKsefCredentials } from '@/lib/supabase/admin-queries';
import { requireMatchingKsefEnvironment } from './claim-environment';

import { getKsefBaseUrl, ksefErrorCodes } from './client';
import { ksefRateLimiter } from './rate-limiter';
import { ksefSessionCache } from './session-cache';

const DEFAULT_TIMEOUT_MS = 30_000;

export interface UpoDownloadResult {
  success: true;
  upoXml: string;
  upoXmlHash: string; // SHA-256
  upoId?: string;
  acceptanceTimestamp: string;
}

export interface UpoDownloadError {
  success: false;
  error: string;
  errorCode?: string;
  retryable: boolean;
}

export type UpoDownloadResponse = UpoDownloadResult | UpoDownloadError;

function resolveEnv(env?: KsefEnvironment): KsefEnvironment {
  return requireMatchingKsefEnvironment(env);
}

/**
 * Pobiera UPO z KSeF API.
 *
 * KSeF 2.0 udostępnia UPO pojedynczej faktury wyłącznie w zasobach sesji:
 * `GET /sessions/{sessionRef}/invoices/ksef/{ksefNumber}/upo`
 * (CIRFMF/ksef-api, „sesja — sprawdzenie stanu i pobranie UPO”). Wcześniejsza
 * ścieżka `/invoices/{ksefNumber}/upo` nie istnieje w API (AUD-17).
 */
export async function downloadUpoFromKsef(
  tenantId: string,
  ksefNumber: string,
  opts?: {
    env?: KsefEnvironment;
    timeoutMs?: number;
    /** Faza 23 sekcja 3: zapis do audit_logs (fire-and-forget). */
    invoiceId?: string;
    /** Numer sesji KSeF, w której faktura dostała numer. Bez niego UPO nie da się pobrać. */
    sessionReferenceNumber?: string | null;
  },
): Promise<UpoDownloadResponse> {
  if (!opts?.sessionReferenceNumber) {
    return {
      success: false,
      error:
        'Brak numeru sesji KSeF dla tej faktury — UPO trzeba pobrać ręcznie w Aplikacji Podatnika KSeF',
      errorCode: 'NO_SESSION_REFERENCE',
      retryable: false,
    };
  }
  const sessionReferenceNumber = opts.sessionReferenceNumber;
  const env = resolveEnv(opts?.env);
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const auditStart = Date.now();
  const auditInvoiceId = opts?.invoiceId;

  // Helper: fire-and-forget audit, w czystym wnętrzu downloadUpoFromKsef nie
  // używamy ksefFetch (raw `fetch` z streamingiem) — audit ręcznie.
  const writeAudit = (status: number, errorMsg?: string) => {
    void (async () => {
      try {
        const { logAuditSystem } = await import('@/lib/audit/log-system');
        await logAuditSystem({
          action: 'ksef.upo.download',
          tenantId,
          userId: null,
          entityType: auditInvoiceId ? 'invoice' : 'ksef',
          entityId: auditInvoiceId,
          metadata: {
            ksefNumber,
            httpStatus: status,
            durationMs: Date.now() - auditStart,
            ...(errorMsg ? { error: errorMsg } : {}),
          },
        });
      } catch (e) {
        console.error('[ksef.audit] upo download log failed', e);
      }
    })();
  };

  try {
    let auth;
    try {
      auth = await getTenantKsefCredentials(tenantId);
    } catch (credErr) {
      const message =
        credErr instanceof Error ? credErr.message : 'Unknown error';
      if (
        message.includes('nie ma skonfigurowanych credentials') ||
        message.includes('ksef_credentials_encrypted')
      ) {
        return {
          success: false,
          error: 'Brak aktywnej sesji KSeF — sprawdź certyfikat',
          errorCode: 'NO_CREDENTIALS',
          retryable: false,
        };
      }
      return {
        success: false,
        error: message,
        retryable: false,
      };
    }

    let session;
    try {
      session = await ksefRateLimiter.enqueue(auth.nip, () =>
        ksefSessionCache.getSession(auth, env),
      );
    } catch {
      return {
        success: false,
        error: 'Brak aktywnej sesji KSeF — sprawdź certyfikat',
        retryable: false,
      };
    }

    const baseUrl = getKsefBaseUrl(env);
    const upoEndpoint = `${baseUrl}/sessions/${encodeURIComponent(sessionReferenceNumber)}/invoices/ksef/${encodeURIComponent(ksefNumber)}/upo`;

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(upoEndpoint, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${session.accessToken}`,
          Accept: 'application/xml',
        },
        signal: controller.signal,
        redirect: 'error',
      });
    } finally {
      clearTimeout(timeoutHandle);
    }

    if (!response.ok) {
      writeAudit(response.status, `HTTP ${response.status}`);
      if (response.status === 404) {
        return {
          success: false,
          error: 'UPO nie zostało jeszcze wygenerowane przez KSeF',
          errorCode: 'UPO_NOT_READY',
          retryable: true,
        };
      }

      if (response.status === 401) {
        ksefSessionCache.invalidate(auth.nip, env);
        return {
          success: false,
          error: 'Sesja KSeF wygasła',
          errorCode: 'SESSION_EXPIRED',
          retryable: true,
        };
      }

      // Treść odpowiedzi czytamy tylko po kody KSeF. Komunikat idzie do
      // `upo_receipts.last_error`, komunikatu błędu joba (log workera,
      // `inngest_run_log`, Sentry po wyczerpaniu prób), więc treść nigdy:
      // może nieść dane kontrahenta (F-093-UPO).
      const codes = ksefErrorCodes(await response.text());
      return {
        success: false,
        error: upoHttpErrorMessage(response.status, codes),
        errorCode: `HTTP_${response.status}`,
        retryable: response.status >= 500,
      };
    }

    const upoXml = await response.text();
    const upoXmlHash = await sha256(upoXml);
    const acceptanceTimestamp = extractAcceptanceTimestamp(upoXml);
    const upoId = extractUpoId(upoXml);

    writeAudit(response.status);

    return {
      success: true,
      upoXml,
      upoXmlHash,
      upoId,
      acceptanceTimestamp,
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      writeAudit(408, 'timeout');
      return {
        success: false,
        error: `UPO — przekroczono limit czasu żądania (${timeoutMs} ms)`,
        errorCode: 'TIMEOUT',
        retryable: true,
      };
    }
    const message = error instanceof Error ? error.message : 'Unknown error';
    writeAudit(0, message);
    return {
      success: false,
      error: `Błąd pobierania UPO: ${message}`,
      retryable: true,
    };
  }
}

// ============================================================================
// Helpers
// ============================================================================

/** Najwyżej tyle kodów w komunikacie: lista przychodzi z zewnątrz. */
const MAX_CODES_IN_MESSAGE = 10;

/**
 * Komunikat błędu HTTP pobrania UPO: status i kody KSeF, bez treści odpowiedzi.
 * Reguła jak w `lib/ksef/history-sync/errors.ts` („HTTP {status} {ścieżka}
 * kody:{…}”), tylko bez ścieżki: UPO ma jedną, a krótki napis grupuje się
 * w `scripts/ops/kontrola-faktur-ksef.sh` (pierwsze 60 znaków `last_error`).
 */
function upoHttpErrorMessage(status: number, codes: readonly number[]): string {
  const shown = [...new Set(codes)].slice(0, MAX_CODES_IN_MESSAGE);
  return `KSeF zwrócił HTTP ${status} kody:${shown.length ? shown.join(',') : '-'}`;
}

async function sha256(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function extractAcceptanceTimestamp(upoXml: string): string {
  const match = upoXml.match(
    /<(?:DataPrzyjeciaWKsef|AcceptanceTimestamp|DataAkceptacji)>([^<]+)</,
  );
  return match?.[1] ?? new Date().toISOString();
}

function extractUpoId(upoXml: string): string | undefined {
  const match = upoXml.match(/<(?:NumerUPO|UpoNumber|IdUPO)>([^<]+)</);
  return match?.[1];
}

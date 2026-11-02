import { KsefApiError, ksefFetch } from './client';
import { ksefSessionCache } from './session-cache';
import { ksefRateLimiter } from './rate-limiter';
import type { KsefAuth } from './auth';
import type {
  QueryInvoicesRequest,
  QueryInvoicesResponse,
  InvoiceMetadata,
  KsefEnvironment,
} from '@/types/ksef';

/** Kontekst audytu (Faza 23 sekcja 3) — opcjonalny propagator do `ksefFetch`. */
export interface InboxAuditContext {
  tenantId: string;
}

/** Maksymalna strona `/invoices/query/metadata` (OpenAPI KSeF 2.0: 10–250). */
export const INBOX_PAGE_SIZE = 250;

/** Bezpiecznik: 400 stron × 250 = 100 tys. faktur w jednym oknie. */
const MAX_REQUESTS = 400;

export interface ReceivedInvoicesResult {
  /** Bez dubli po numerze KSeF (zawężanie po `isTruncated` zwraca rekord graniczny). */
  invoices: InvoiceMetadata[];
  /**
   * `permanentStorageHwmDate` z ostatniego zapytania: poniżej tej chwili KSeF
   * gwarantuje komplet — tu zaczyna się następne okno. `null` = KSeF go nie
   * podał i okna nie wolno przesunąć.
   */
  hwm: string | null;
}

/**
 * Faktury otrzymane (subject2) z okna dat — scenariusz przyrostowy MF (AUD-18).
 *
 * Kontrakt `POST /invoices/query/metadata` (OpenAPI KSeF 2.0):
 *   - data `PermanentStorage`, sortowanie `Asc`, `restrictToPermanentStorageHwmDate`
 *     — wtedy `dateRange.to` nie wychodzi poza HWM, a HWM jest stały dla
 *     wszystkich stron zapytania,
 *   - strony przez `pageOffset` (indeks strony) i `pageSize`, dopóki `hasMore`,
 *   - `isTruncated` (limit 10 000 rekordów) → nowe `from` od daty ostatniego
 *     rekordu i `pageOffset = 0`.
 * Wcześniejsza wersja czekała na `continuationToken`, którego ten endpoint
 * nie zwraca, więc kończyła na pierwszej stronie (domyślnie 10 faktur).
 */
async function queryReceivedInvoicesOnce(
  auth: KsefAuth,
  dateFrom: Date,
  dateTo: Date,
  env?: KsefEnvironment,
  auditContext?: InboxAuditContext,
): Promise<ReceivedInvoicesResult> {
  return ksefRateLimiter.enqueue(auth.nip, async () => {
    const authSession = await ksefSessionCache.getSession(auth, env);
    const accessToken = authSession.accessToken;

    const byNumber = new Map<string, InvoiceMetadata>();
    let from = dateFrom.toISOString();
    let pageOffset = 0;
    let hwm: string | null = null;

    for (let request = 0; ; request += 1) {
      // Rzucamy zamiast przerywać: HWM się wtedy nie przesunie, a alarm
      // zaległości skrzynki pokaże problem — urwane pobieranie byłoby ciche.
      if (request >= MAX_REQUESTS) {
        throw new Error(`KSeF: pobieranie skrzynki przekroczyło ${MAX_REQUESTS} zapytań w jednym oknie`);
      }
      const req: QueryInvoicesRequest = {
        subjectType: 'subject2',
        dateRange: {
          dateType: 'PermanentStorage',
          from,
          to: dateTo.toISOString(),
          restrictToPermanentStorageHwmDate: true,
        },
      };
      const params = new URLSearchParams({
        pageOffset: String(pageOffset),
        pageSize: String(INBOX_PAGE_SIZE),
        sortOrder: 'Asc',
      });

      const response: QueryInvoicesResponse = await ksefFetch<QueryInvoicesResponse>(
        `/invoices/query/metadata?${params.toString()}`,
        {
          method: 'POST',
          accessToken,
          body: req,
          env,
          audit: auditContext
            ? {
                tenantId: auditContext.tenantId,
                action: 'inbox.poll',
                metadata: { dateFrom: from, dateTo: dateTo.toISOString(), pageOffset },
              }
            : undefined,
        },
      );

      const page = response.invoices ?? [];
      for (const inv of page) byNumber.set(inv.ksefNumber, inv);
      hwm = response.permanentStorageHwmDate ?? null;

      if (!response.hasMore) break;
      const last = page[page.length - 1];
      if (response.isTruncated) {
        if (!last?.permanentStorageDate || Date.parse(last.permanentStorageDate) <= Date.parse(from)) {
          throw new Error('KSeF: wynik skrzynki ucięty, a okna nie da się zawęzić');
        }
        from = last.permanentStorageDate;
        pageOffset = 0;
      } else {
        pageOffset += 1;
      }
    }

    return { invoices: [...byNumber.values()], hwm };
  });
}

/**
 * Sesja z pamięci żyje teraz do 7 dni przez refresh token, więc 401 może znaczyć
 * unieważnioną sesję, a nie zły certyfikat. Jedna próba od czystej sesji rozstrzyga
 * to w tym samym przebiegu; drugie 401 idzie wyżej jako błąd poświadczeń.
 */
export async function queryReceivedInvoices(
  auth: KsefAuth,
  dateFrom: Date,
  dateTo: Date,
  env?: KsefEnvironment,
  auditContext?: InboxAuditContext,
): Promise<ReceivedInvoicesResult> {
  try {
    return await queryReceivedInvoicesOnce(auth, dateFrom, dateTo, env, auditContext);
  } catch (error) {
    if (!(error instanceof KsefApiError) || error.status !== 401) throw error;
    ksefSessionCache.invalidate(auth.nip, env);
    return queryReceivedInvoicesOnce(auth, dateFrom, dateTo, env, auditContext);
  }
}

/**
 * Pobiera pojedynczą fakturę po numerze KSeF (jako XML).
 */
export async function downloadInvoiceXml(
  ksefNumber: string,
  auth: KsefAuth,
  env?: KsefEnvironment,
): Promise<string> {
  return ksefRateLimiter.enqueue(auth.nip, async () => {
    const authSession = await ksefSessionCache.getSession(auth, env);
    const accessToken = authSession.accessToken;

    // Endpoint zwraca XML bezpośrednio, nie JSON
    const xml = await ksefFetch<string>(`/invoices/ksef/${ksefNumber}`, {
      accessToken,
      headers: { Accept: 'application/xml' },
      env,
    });

    return xml;
  });
}

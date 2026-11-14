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

/**
 * Kontekst audytu (Faza 23 sekcja 3) — opcjonalny propagator do `ksefFetch`.
 * Strona skrzynki trafia do `audit_logs` tylko przy błędzie (EXT-03); przebieg,
 * który dodał faktury, zapisuje runner jednym wierszem podsumowania.
 */
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
  /**
   * E1-W10-b: pobieranie skończyło się na budżecie zapytań, zanim KSeF oddał
   * całe okno. Data trwałego zapisu ostatniej pobranej faktury, obcięta do
   * milisekundy w dół: tu zaczyna się następne okno (`from` włącznie, więc
   * faktury z tą samą datą wracają i odsiewa je `filter-existing`). Nie wychodzi
   * poza `hwm`, bo zapytanie z `restrictToPermanentStorageHwmDate` nie wychodzi
   * poza HWM, więc poniżej tej daty KSeF też gwarantuje komplet.
   * `null` = okno pobrane w całości.
   */
  resumeFrom: string | null;
  /** Ile zapytań (stron) poszło do KSeF w tym oknie — do wiersza podsumowania audytu. */
  requests: number;
}

export interface ReceivedInvoicesOptions {
  /**
   * Budżet zapytań (stron) na wywołanie (E1-W10-b, skrzynka:
   * `INBOX_METADATA_REQUESTS_PER_RUN`). Po jego wyczerpaniu pobieranie kończy
   * się z `resumeFrom`, o ile ostatnia strona wyszła za `dateFrom`; inaczej pyta
   * dalej, do pierwszej strony z późniejszą datą. Bez budżetu: do końca okna.
   */
  maxRequests?: number;
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
 *     rekordu i `pageOffset = 0`, NIEZALEŻNIE od `hasMore` (E1-W10).
 * Wcześniejsza wersja czekała na `continuationToken`, którego ten endpoint
 * nie zwraca, więc kończyła na pierwszej stronie (domyślnie 10 faktur).
 *
 * E1-W10: skrócony scenariusz MF opisuje `hasMore = false` jako koniec, a
 * zawężenie tylko przy `hasMore = true`. Nie mówi, co znaczy `isTruncated`
 * przy `hasMore = false` — tak może wyglądać ostatnia strona obciętego wyniku
 * (ta z 10 000. rekordem). Koniec w tym miejscu gubił resztę okna, a HWM
 * z odpowiedzi przesuwał się ponad nią na zawsze. Dla `hasMore = true` (obie
 * wartości `isTruncated`) i dla `hasMore = false` bez `isTruncated` zachowanie
 * jest bez zmian; reguła MF „`hasMore = false` → koniec” dostaje jeden wyjątek:
 * `isTruncated`.
 *
 * E1-W10-b: z `options.maxRequests` pobieranie kończy się po tylu zapytaniach,
 * nawet gdy okno ma więcej stron (`resumeFrom`). MF liczy limit 16 zapytań na
 * minutę i 20 na godzinę na NIP, więc okno ponad 16 stron pobierane naraz
 * kończyło się 429, a wszystko pobrane do tej chwili przepadało.
 */
async function queryReceivedInvoicesOnce(
  auth: KsefAuth,
  dateFrom: Date,
  dateTo: Date,
  env?: KsefEnvironment,
  auditContext?: InboxAuditContext,
  options?: ReceivedInvoicesOptions,
): Promise<ReceivedInvoicesResult> {
  return ksefRateLimiter.enqueue(auth.nip, async () => {
    const authSession = await ksefSessionCache.getSession(auth, env);
    const accessToken = authSession.accessToken;

    const byNumber = new Map<string, InvoiceMetadata>();
    const maxRequests = options?.maxRequests ?? Number.POSITIVE_INFINITY;
    let from = dateFrom.toISOString();
    let pageOffset = 0;
    let hwm: string | null = null;
    let resumeFrom: string | null = null;
    let requests = 0;

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
                when: 'error',
                metadata: { dateFrom: from, dateTo: dateTo.toISOString(), pageOffset },
              }
            : undefined,
        },
      );
      requests = request + 1;

      const page = response.invoices ?? [];
      for (const inv of page) byNumber.set(inv.ksefNumber, inv);
      hwm = response.permanentStorageHwmDate ?? null;

      // Koniec okna: ani dalszych stron, ani ucięcia (E1-W10, opis wyżej).
      if (!response.isTruncated && !response.hasMore) break;

      // E1-W10-b: budżet wyczerpany, a w oknie jest więcej. Koniec na dacie
      // ostatniej faktury (sortowanie rosnące, więc wszystko pobrane ma datę nie
      // późniejszą). Obcięcie do milisekundy w dół: KSeF podaje ułamki do
      // mikrosekund, a zaokrąglenie w górę przeskoczyłoby faktury z tą samą
      // milisekundą na następnej stronie. Brak postępu za `dateFrom` (cała porcja
      // z datą początku okna) = pytamy dalej: przebieg z budżetem stałby w miejscu.
      const last = page[page.length - 1];
      if (requests >= maxRequests && last?.permanentStorageDate) {
        const lastMs = Date.parse(last.permanentStorageDate);
        if (lastMs > dateFrom.getTime()) {
          resumeFrom = new Date(lastMs).toISOString();
          break;
        }
      }

      // `isTruncated` przed `hasMore` (E1-W10, opis wyżej). Brak postępu rzuca:
      // HWM stoi, a alarm zaległości skrzynki pokaże problem.
      if (response.isTruncated) {
        if (!last?.permanentStorageDate || Date.parse(last.permanentStorageDate) <= Date.parse(from)) {
          throw new Error('KSeF: wynik skrzynki ucięty, a okna nie da się zawęzić');
        }
        from = last.permanentStorageDate;
        pageOffset = 0;
        continue;
      }
      pageOffset += 1;
    }

    return { invoices: [...byNumber.values()], hwm, resumeFrom, requests };
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
  options?: ReceivedInvoicesOptions,
): Promise<ReceivedInvoicesResult> {
  try {
    return await queryReceivedInvoicesOnce(auth, dateFrom, dateTo, env, auditContext, options);
  } catch (error) {
    if (!(error instanceof KsefApiError) || error.status !== 401) throw error;
    ksefSessionCache.invalidate(auth.nip, env);
    return queryReceivedInvoicesOnce(auth, dateFrom, dateTo, env, auditContext, options);
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

/**
 * Wywołania KSeF synchronizacji historii (decyzja Bartosza 22.10.2026).
 *
 * Każda funkcja to DOKŁADNIE jedno wywołanie API (budżet liczy wywołania,
 * `constants.ts`) i nie połyka błędów — skutek ustala `errors.ts`.
 * Kolejka per NIP (`ksefRateLimiter`) i sesja z pamięci procesu
 * (`ksefSessionCache`) jak w Skrzynce KSeF. `getValidSession` nie jest używane:
 * zamienia każdy błąd na `null`, a tu błąd ma rodzaj (poświadczenia, 429, sieć).
 *
 * Bez importów ścieżki wysyłki (`lib/ksef/submit*`, dziennik prób) — strażnik
 * OUTGOING_SINKS w tests/unit/flo-architecture.test.ts.
 */

import type { KsefAuth } from '@/lib/ksef/auth';
import { ksefFetch } from '@/lib/ksef/client';
import { ksefRateLimiter } from '@/lib/ksef/rate-limiter';
import { ksefSessionCache } from '@/lib/ksef/session-cache';
import type {
  InvoiceMetadata,
  KsefEnvironment,
  QueryInvoicesRequest,
  QueryInvoicesResponse,
} from '@/types/ksef';

import { PAGE_SIZE } from './constants';
import { KsefHistoryEmptyXmlError } from './errors';

export type KsefSubjectType = 'subject1' | 'subject2';

export interface MetadataPage {
  invoices: InvoiceMetadata[];
  hasMore: boolean;
  isTruncated: boolean;
  /** `permanentStorageHwmDate`: poniżej tej chwili KSeF gwarantuje komplet; `null` = nie podał. */
  hwm: string | null;
}

export interface MetadataPageParams {
  subjectType: KsefSubjectType;
  from: string;
  to: string;
  pageOffset: number;
  env: KsefEnvironment;
  tenantId: string;
}

/**
 * Jedna strona `POST /invoices/query/metadata` — data `PermanentStorage`,
 * rosnąco, z ograniczeniem do HWM (wtedy `to` nie wychodzi poza HWM, a HWM
 * jest stały dla wszystkich stron zapytania). Audyt: `ksef.history.query`.
 */
export async function queryMetadataPage(auth: KsefAuth, params: MetadataPageParams): Promise<MetadataPage> {
  return ksefRateLimiter.enqueue(auth.nip, async () => {
    const session = await ksefSessionCache.getSession(auth, params.env);
    const request: QueryInvoicesRequest = {
      subjectType: params.subjectType,
      dateRange: {
        dateType: 'PermanentStorage',
        from: params.from,
        to: params.to,
        restrictToPermanentStorageHwmDate: true,
      },
    };
    const search = new URLSearchParams({
      pageOffset: String(params.pageOffset),
      pageSize: String(PAGE_SIZE),
      sortOrder: 'Asc',
    });
    const response = await ksefFetch<QueryInvoicesResponse>(`/invoices/query/metadata?${search.toString()}`, {
      method: 'POST',
      accessToken: session.accessToken,
      body: request,
      env: params.env,
      audit: {
        tenantId: params.tenantId,
        action: 'history.query',
        metadata: {
          subjectType: params.subjectType,
          from: params.from,
          to: params.to,
          pageOffset: params.pageOffset,
        },
      },
    });
    return {
      invoices: response?.invoices ?? [],
      hasMore: Boolean(response?.hasMore),
      isTruncated: Boolean(response?.isTruncated),
      hwm: response?.permanentStorageHwmDate ?? null,
    };
  });
}

/**
 * Dokładne bajty XML faktury (`GET /invoices/ksef/{numer}`) — do archiwum
 * i skrótu SHA-256 (KOD I). Bez audytu na wywołanie: runner zapisuje jeden
 * zbiorczy wiersz `ksef.history.download` na przebieg.
 */
export async function downloadInvoiceXmlBytes(
  auth: KsefAuth,
  ksefNumber: string,
  env: KsefEnvironment,
): Promise<Buffer> {
  return ksefRateLimiter.enqueue(auth.nip, async () => {
    const session = await ksefSessionCache.getSession(auth, env);
    const body = await ksefFetch<Buffer>(`/invoices/ksef/${encodeURIComponent(ksefNumber)}`, {
      accessToken: session.accessToken,
      headers: { Accept: 'application/xml' },
      env,
      responseType: 'bytes',
    });
    if (!Buffer.isBuffer(body) || body.length === 0) throw new KsefHistoryEmptyXmlError(ksefNumber);
    return body;
  });
}

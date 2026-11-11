import { checkRateLimit, type RateLimitResult } from './index';

/**
 * Strona faktury dla nabywcy (`/faktura/<token>`, krok 2.10) i jej pliki:
 * jeden kubełek na adres IP dla otwarć strony i pobrań PDF i XML. Token ma 256
 * bitów losowości, więc limit nie chroni przed zgadywaniem, tylko przed
 * zalewem zapytań do bazy i renderowania PDF. Nabywca otwiera stronę kilka
 * razy, a biuro z jednym adresem obsługuje wiele faktur, stąd 60 w 10 minut.
 * Odmowa nie wydłuża blokady (`countDenied: false`): po `retryAfter` próba
 * naprawdę przejdzie.
 *
 * Wołający traktuje `fallback: true` (Redis nieskonfigurowany albo padł) jak
 * odmowę: limit w pamięci procesu nie jest wspólny dla instancji, a strona jest
 * publiczna (fail-closed, lista w `lib/cache/redis.ts`).
 */
export const BUYER_INVOICE_RATE_LIMIT = { limit: 60, windowSeconds: 10 * 60 } as const;

export function checkBuyerInvoiceRateLimit(ip: string): Promise<RateLimitResult> {
  return checkRateLimit({
    bucket: 'invoice_share_view',
    identifier: ip,
    limit: BUYER_INVOICE_RATE_LIMIT.limit,
    windowSeconds: BUYER_INVOICE_RATE_LIMIT.windowSeconds,
    countDenied: false,
  });
}

import { checkRateLimit, type RateLimitResult } from './index';

/**
 * Portal księgowej (`/accountant/<token>`, krok 6.2 planu kompletnej
 * aplikacji): jeden kubełek na adres IP dla stron portalu (dokumenty, koszty)
 * i plików (XML faktury, zdjęcie albo XML kosztu). Token ma 256 bitów
 * losowości, więc limit nie chroni przed zgadywaniem, tylko przed zalewem
 * zapytań do bazy i podpisów magazynu.
 *
 * 300 w 10 minut: biuro rachunkowe ma często jeden adres dla kilku osób,
 * a przegląd miesiąca ruchliwej firmy to lista, kilka stron i podgląd albo
 * pobranie każdego dokumentu (ok. 100 dokumentów to ok. 200 otwarć).
 * Odmowa nie wydłuża blokady (`countDenied: false`): po `retryAfter` próba
 * naprawdę przejdzie.
 *
 * `fallback: true` (Redis nieskonfigurowany albo padł) przepuszcza: limit
 * liczy wtedy pamięć jedynej instancji aplikacji, a portal działa jak przed
 * wprowadzeniem limitu. Eksport (`/api/portal/exports/generate`) jeszcze nie
 * jest pod tym limitem (osobny PR po #522, który zmienia ten plik).
 */
export const ACCOUNTANT_PORTAL_RATE_LIMIT = { limit: 300, windowSeconds: 10 * 60 } as const;

export function checkAccountantPortalRateLimit(ip: string): Promise<RateLimitResult> {
  return checkRateLimit({
    bucket: 'accountant_portal',
    identifier: ip,
    limit: ACCOUNTANT_PORTAL_RATE_LIMIT.limit,
    windowSeconds: ACCOUNTANT_PORTAL_RATE_LIMIT.windowSeconds,
    countDenied: false,
  });
}

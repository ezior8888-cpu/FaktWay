import 'server-only';

import { NextResponse } from 'next/server';

import { hashToken } from '@/lib/accountant/tokens';
import { logAuditSystem } from '@/lib/audit/log-system';
import { getClientIp } from '@/lib/auth/get-client-ip';
import type { RateLimitResult } from '@/lib/rate-limit';
import { checkAccountantPortalRateLimit } from '@/lib/rate-limit/accountant-portal';
import type { createAdminClient } from '@/lib/supabase/server';

/**
 * Wspólne zabezpieczenia stron i plików portalu księgowej (krok 6.2 planu
 * kompletnej aplikacji): token (w bazie tylko skrót SHA-256), cofnięcie,
 * wygasanie, limit prób na adres IP, licznik wejść i wpis w audycie. Firma
 * zawsze z wiersza dostępu, nigdy z adresu ani z formularza.
 *
 * Eksport (`/api/portal/exports/generate`) sprawdza token po swojemu i nie
 * jest jeszcze pod limitem prób: zmienia go PR #522, więc limit dostanie
 * w osobnym PR po scaleniu tamtego.
 */

type AdminClient = ReturnType<typeof createAdminClient>;

/** Strona listy portalu: 50 pozycji (do kroku 6.2 jedna lista, najwyżej 100). */
export const PORTAL_PAGE_SIZE = 50;

/** Ważność podpisanego adresu pliku: tyle, ile trzeba, by przeglądarka poszła za przekierowaniem. */
export const PORTAL_FILE_URL_TTL_SECONDS = 60;

export interface PortalAccess {
  id: string;
  tenant_id: string;
  accountant_name: string;
  accountant_email: string;
  /** `read_only` (podgląd) albo `download` (podgląd i pobieranie). */
  access_level: string;
  expires_at: string;
}

/** Wiersz dostępu z licznikiem wejść (tylko po stronie serwera). */
export interface ResolvedPortalAccess extends PortalAccess {
  use_count: number;
}

export interface PortalPage {
  page: number;
  pages: number;
  total: number;
  pageSize: number;
}

/** Teksty odmów portalu: co się stało i co zrobić. */
export const PORTAL_TEXTS = {
  LIMITED: 'Za dużo otwarć portalu z tego adresu. Spróbuj ponownie za kilka minut.',
  DENIED: 'Link wygasł, został odebrany lub jest nieprawidłowy. Poproś firmę o nowy link do portalu.',
  VIEW_ONLY:
    'Ten link pozwala tylko na podgląd. Pobranie pliku wymaga dostępu z pobieraniem: poproś firmę o taki link.',
  NO_FILE: 'Ten koszt nie ma w FaktWay zdjęcia ani pliku XML.',
  UNAVAILABLE: 'Plik jest chwilowo niedostępny. Spróbuj ponownie za kilka minut.',
} as const;

/** Nagłówki odpowiedzi portalu: bez cache, bez indeksowania i bez Referer z tokenem. */
export const PORTAL_RESPONSE_HEADERS = {
  'Cache-Control': 'private, no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
} as const;

/** Numer strony z `?strona=`: liczba całkowita od 1; cokolwiek innego to strona 1. */
export function parsePortalPage(raw: string | string[] | undefined): number {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || !/^\d{1,6}$/.test(value)) return 1;
  return Math.max(1, Number(value));
}

/** Strona z liczby pozycji: strona za końcem listy to ostatnia strona, `from`/`to` dla `.range()`. */
export function portalPage(
  total: number,
  requested: number,
  pageSize: number = PORTAL_PAGE_SIZE,
): PortalPage & { from: number; to: number } {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, Math.floor(requested)), pages);
  const from = (page - 1) * pageSize;
  return { page, pages, total, pageSize, from, to: from + pageSize - 1 };
}

/** Parametr trasy jako token; zły zapis procentowy to pusty token (portal odpowie „brak dostępu”). */
export function portalTokenParam(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return '';
  }
}

/**
 * Wiersz dostępu z tokenu: nieznany, cofnięty albo wygasły token to `null`.
 * Te same warunki co trasa XML faktury i eksport; brak albo zły termin
 * ważności to też `null` (bez pewności nie wpuszczamy).
 */
export async function resolvePortalAccess(
  admin: AdminClient,
  rawToken: string,
): Promise<ResolvedPortalAccess | null> {
  const trimmed = rawToken.trim();
  if (!trimmed) return null;

  const { data: access, error } = await admin
    .from('accountant_access')
    .select('id, tenant_id, accountant_name, accountant_email, access_level, expires_at, revoked_at, use_count')
    .eq('token_hash', hashToken(trimmed))
    .maybeSingle();

  if (error || !access) return null;
  if (access.revoked_at != null) return null;
  const expiresAt = Date.parse(String(access.expires_at ?? ''));
  if (Number.isNaN(expiresAt) || expiresAt < Date.now()) return null;

  return {
    id: access.id as string,
    tenant_id: access.tenant_id as string,
    accountant_name: access.accountant_name as string,
    accountant_email: access.accountant_email as string,
    access_level: access.access_level as string,
    expires_at: access.expires_at as string,
    use_count: Number(access.use_count ?? 0),
  };
}

/** Dane dostępu dla widoku: bez licznika wejść. */
export function publicPortalAccess(access: ResolvedPortalAccess): PortalAccess {
  return {
    id: access.id,
    tenant_id: access.tenant_id,
    accountant_name: access.accountant_name,
    accountant_email: access.accountant_email,
    access_level: access.access_level,
    expires_at: access.expires_at,
  };
}

/** Limit prób portalu dla bieżącego żądania (adres jak przy logowaniu: `X-Real-Ip`). */
export async function checkPortalLimit(): Promise<RateLimitResult> {
  return checkAccountantPortalRateLimit(await getClientIp());
}

/**
 * Wejście na stronę portalu: licznik użyć linku i wpis w audycie. Metadane
 * mówią, co oglądano (widok, miesiąc), bez treści dokumentów.
 */
export async function recordPortalVisit(
  admin: AdminClient,
  access: ResolvedPortalAccess,
  metadata: Record<string, string> = {},
): Promise<void> {
  await admin
    .from('accountant_access')
    .update({
      last_used_at: new Date().toISOString(),
      use_count: access.use_count + 1,
    })
    .eq('id', access.id);

  await logAuditSystem({
    action: 'accountant.access_used',
    tenantId: access.tenant_id,
    entityType: 'accountant_access',
    entityId: access.id,
    metadata: {
      accountantEmail: access.accountant_email,
      via: 'accountant_portal',
      ...metadata,
    },
  });
}

/** Odpowiedź tekstowa trasy portalu (odmowa, brak pliku), po polsku. */
export function portalTextResponse(
  status: number,
  message: string,
  extra: Record<string, string> = {},
): NextResponse {
  return new NextResponse(message, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', ...PORTAL_RESPONSE_HEADERS, ...extra },
  });
}

/** 429 z `Retry-After` dla przekroczonego limitu prób. */
export function portalLimitedResponse(retryAfter: number): NextResponse {
  return portalTextResponse(429, PORTAL_TEXTS.LIMITED, {
    'Retry-After': String(Math.max(1, Math.ceil(retryAfter))),
  });
}

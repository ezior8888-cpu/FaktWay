import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/** Adres i klucze bazy; domyślnie z konfiguracji aplikacji, w testach RLS jawnie. */
export interface MobileSupabaseTarget {
  url?: string;
  anonKey?: string;
  /** Tylko logowanie hasłem (`createMobileLoginClient`). */
  serviceRoleKey?: string;
}

function resolveTarget(target: MobileSupabaseTarget): { url: string; anonKey: string } {
  const url = target.url ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = target.anonKey ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) throw new Error('Brak adresu albo klucza anon Supabase');
  return { url, anonKey };
}

const NO_SESSION = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } as const;

/**
 * Klient GoTrue do sprawdzenia tokenu telefonu (`getUser(token)`, `getClaims(token)`).
 * Bez sesji w pamięci: token podaje się przy każdym wywołaniu.
 */
export function createMobileAuthClient(target: MobileSupabaseTarget = {}): SupabaseClient {
  const { url, anonKey } = resolveTarget(target);
  return createClient(url, anonKey, { auth: NO_SESSION });
}

/**
 * Klient bazy dla jednego żądania `/api/mobile/v1`: klucz anon (jak telefon
 * i przeglądarka) i token sesji klienta. PostgREST widzi wtedy `auth.uid()`
 * klienta, a nagłówek `x-active-org` daje `get_current_tenant_id()` (00037,
 * tylko przy aktywnym członkostwie): RLS działa jak na stronie. Nigdy klucz
 * serwisowy. Tworzyć dopiero po `authenticateMobileRequest`.
 */
export function createMobileDbClient(
  token: string,
  options: { activeOrg?: string | null; target?: MobileSupabaseTarget } = {},
): SupabaseClient {
  const { url, anonKey } = resolveTarget(options.target ?? {});
  return createClient(url, anonKey, {
    auth: NO_SESSION,
    global: {
      headers: {
        Authorization: `Bearer ${token}`,
        ...(options.activeOrg ? { 'x-active-org': options.activeOrg } : {}),
      },
    },
  });
}

/**
 * Klient GoTrue tylko do logowania hasłem z telefonu (`POST /api/mobile/v1/logowanie`,
 * M6b, decyzja D16). Klucz serwisowy w nagłówku `Authorization` jest jedyną drogą
 * logowania hasłem bez tokenu captchy, gdy GoTrue ją wymaga (`docs/runbooks/captcha-w-gotrue.md`):
 * GoTrue przepuszcza żądania z rolą serwisową, a sesja, którą wydaje, jest zwykłą sesją
 * klienta (rola `authenticated`, AAL1). Sprawdzone na GoTrue z captchą, `tests/rls-mobile-logowanie.test.ts`.
 *
 * Nowy klient na każde logowanie, bez zapisu sesji: po `signInWithPassword` ten klient
 * niesie już token klienta, więc nie wolno go użyć do niczego innego. Danych bazy tym
 * klientem nie czytamy (od tego jest `createMobileDbClient` z tokenem klienta).
 */
export function createMobileLoginClient(target: MobileSupabaseTarget = {}): SupabaseClient {
  const { url } = resolveTarget(target);
  const serviceRoleKey = target.serviceRoleKey ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) throw new Error('Brak klucza serwisowego Supabase');
  return createClient(url, serviceRoleKey, { auth: NO_SESSION });
}

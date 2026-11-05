import { createServerClient } from '@supabase/ssr';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';

import {
  ACTIVE_ORG_COOKIE,
  ACTIVE_ORG_HEADER,
  isUuid,
} from './active-org';

/**
 * Supabase client do użycia na serwerze:
 * - Server Components
 * - Server Actions
 * - Route Handlers
 *
 * Obsługuje cookies przez next/headers.
 *
 * Multi-org: jeżeli cookie `ksef.active_org` jest ustawione, dokleja
 * nagłówek `x-active-org` do każdego żądania PostgREST. Funkcja w bazie
 * `public.get_current_tenant_id()` waliduje membership — sfałszowanie
 * cookie z obcym uuid nie da dostępu.
 */
export async function createClient() {
  const cookieStore = await cookies();
  const activeOrg = cookieStore.get(ACTIVE_ORG_COOKIE)?.value;
  const headers: Record<string, string> = {};
  if (isUuid(activeOrg)) {
    headers[ACTIVE_ORG_HEADER] = activeOrg;
  }

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        // Drugi argument `setAll` (nagłówki anty-cache od `@supabase/ssr`)
        // pomijamy świadomie: `cookies()` z `next/headers` nie ustawia nagłówków
        // odpowiedzi. Sesję odświeża wcześniej proxy i to ono dokłada
        // `Cache-Control: private, no-store…` (`lib/supabase/middleware.ts`).
        // Trasa GET, która mimo to zapisze tu ciasteczko (np. skasowanie sesji
        // po odmowie GoTrue), sama ustawia `Cache-Control` swojej odpowiedzi.
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Wywołane z Server Component - ignoruj.
            // Proxy przejmie odpowiedzialność za zapis.
          }
        },
      },
      global: Object.keys(headers).length > 0 ? { headers } : undefined,
    }
  );
}

/**
 * Wariant `createClient()` z explicit aktywną org. Używaj w Server Actions
 * gdzie aktywna org pochodzi z parametru (np. `setActiveOrganizationAction`)
 * a nie z cookie — pozwala uniknąć race condition cookie-set vs request.
 */
export async function createClientForOrg(orgId: string | null | undefined) {
  const cookieStore = await cookies();
  const headers: Record<string, string> = {};
  if (isUuid(orgId)) {
    headers[ACTIVE_ORG_HEADER] = orgId as string;
  }

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        // Bez nagłówków z drugiego argumentu — zob. `createClient`.
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // ignore — Server Component context
          }
        },
      },
      global: Object.keys(headers).length > 0 ? { headers } : undefined,
    }
  );
}

/**
 * Server client z service_role - OBCHODZI RLS.
 * Używaj WYŁĄCZNIE w jobach pg-boss i Server Actions, które świadomie
 * chcą ominąć RLS (po uprzedniej weryfikacji auth.getUser()).
 *
 * DLACZEGO nie `@supabase/ssr` z cookies:
 * `createServerClient` z `@supabase/ssr` dokleja Bearer token z cookie
 * użytkownika, który w Supabase ma PIERWSZEŃSTWO przed apiKey. W efekcie
 * service_role jest "nadpisywany" rolą `authenticated` i RLS znów łapie
 * operacje. Dlatego używamy czystego `supabase-js` z wyłączonym persist
 * session - to prawdziwy admin bez kontekstu usera.
 */
export function createAdminClient() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    }
  );
}

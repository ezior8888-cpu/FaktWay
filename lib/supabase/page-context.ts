/**
 * Helpery dla Server Components stron — zwracają kontekst auth + aktywna org
 * i robią `redirect()` zamiast rzucać wyjątek (jak Server Actions).
 *
 * Membership weryfikujemy DETERMINISTYCZNIE przez admin client (omija RLS).
 * Bezpieczeństwo: cookie ksef.active_org jest httpOnly; gdy nawet zostanie
 * sfałszowane, RLS na tabelach faktycznych danych biznesowych (faktury,
 * expenses) i tak filtruje przez `is_member_of()` — admin client służy
 * wyłącznie do podjęcia decyzji "czy renderować dashboard czy przekierować
 * na /onboarding", po której wszystkie kolejne odczyty idą przez user-context
 * `supabase` zwracane w kontekście.
 *
 * Jedno sprawdzenie sesji i jedno zapytanie o członkostwo na żądanie RSC
 * (sesja 9 planu skalowania): użytkownik i wiersze członkostw to te same
 * odczyty w `cache()`, z których korzysta layout panelu
 * (`lib/dashboard-shell-data.ts`), a cały kontekst też jest w `cache()` —
 * layout ustawień i strona dostają ten sam obiekt. Przy miękkiej nawigacji
 * (layout się nie renderuje) pierwsze wywołanie robi oba odczyty, a dowód
 * KSeF z `lib/demo/tryb-danych.ts` trafia już w pamięć żądania.
 *
 * Zachowujemy `tenantId` jako nazwę pola dla ciągłości z istniejącym kodem;
 * semantycznie to jest `organization_id` (multi-org).
 */

import { cache } from 'react';
import { redirect } from 'next/navigation';

import { getCachedMembershipRowsWithTenants, getDashboardSessionUser } from '@/lib/dashboard-shell-data';
import { ACTIVE_ORG_COOKIE, getActiveOrgIdFromCookies } from './active-org';
import { createClient } from './server';
import type { UserRole } from './auth-context';

export interface PageContext {
  supabase: Awaited<ReturnType<typeof createClient>>;
  user: { id: string; email: string | null };
  tenantId: string;
  role: UserRole;
}

/**
 * Wiersz członkostwa wybieramy po firmie z ciasteczka — sprawdzenia nie
 * pomijamy, bo ciasteczko kontroluje klient. Wiersze to aktywne członkostwa
 * użytkownika (filtr `user_id` + `status = active`, klient admina), więc
 * brak wiersza firmy z ciasteczka = ta sama odmowa co dawne zapytanie
 * z `organization_id`. Porównanie tekstu jak w `assertDashboardShellAccess`:
 * baza oddaje UUID małymi literami, więc ciasteczko pisane wielkimi jest
 * odrzucane tak samo jak w layoucie. Błąd odczytu członkostw rzuca (strona
 * błędu, jak w layoucie), zamiast udawać brak firmy.
 */
export const getPageContext = cache(async (): Promise<PageContext> => {
  const user = await getDashboardSessionUser();
  if (!user) redirect('/login');

  const activeOrg = await getActiveOrgIdFromCookies();
  if (!activeOrg) redirect('/onboarding');

  const rows = await getCachedMembershipRowsWithTenants(user.id);
  const membership = rows.find((row) => row.organization_id === activeOrg);
  if (!membership) redirect('/onboarding');

  return {
    supabase: await createClient(),
    user: { id: user.id, email: user.email ?? null },
    tenantId: activeOrg,
    role: (membership.role ?? 'member') as UserRole,
  };
});

/**
 * Wariant z wymogiem konkretnej roli — przy braku robi redirect na fallback.
 */
export async function getPageContextWithRole(
  roles: UserRole | UserRole[],
  fallback: string = '/settings',
): Promise<PageContext> {
  const ctx = await getPageContext();
  const allowed = Array.isArray(roles) ? roles : [roles];
  if (!allowed.includes(ctx.role)) {
    redirect(fallback);
  }
  return ctx;
}

export { ACTIVE_ORG_COOKIE };

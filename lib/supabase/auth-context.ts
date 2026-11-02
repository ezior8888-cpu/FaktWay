/**
 * Centralny helper autoryzacji dla Server Actions / Server Components.
 *
 * Multi-org model:
 *   - User może mieć membership w wielu organizacjach.
 *   - Aktywna organizacja siedzi w cookie `ksef.active_org`, walidowana po
 *     stronie aplikacji (memberships) i RLS (`get_current_tenant_id()` w 00037
 *     zwraca tylko jeśli zalogowany user jest aktywnym członkiem).
 *
 * Funkcje:
 *   - `requireUserAndActiveOrg()` — zwraca kontekst dla zwykłej akcji
 *     (każdy aktywny członek). Zachowujemy też alias `requireUserAndTenant`
 *     dla istniejących wywołań.
 *   - `requireOrgRole(role)` — wymaga konkretnej roli w aktywnej org.
 *   - `requireOwner()` — alias dla `requireOrgRole('owner')`.
 *
 * Konwencja błędów: rzucamy `ActionAuthError`, akcja w `try/catch`
 * mapuje na `{ success: false, error: e.message }` dla zgodności
 * z istniejącym kontraktem zwrotnym.
 */

import { cookies } from 'next/headers';

import { getVerifiedMfaState } from '@/lib/auth/verified-mfa';
import { createAdminClient, createClient } from './server';
import { ACTIVE_ORG_COOKIE, isUuid } from './active-org';

export class ActionAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActionAuthError';
  }
}

export type UserRole = 'owner' | 'admin' | 'member' | 'accountant';

export interface AuthContext {
  supabase: Awaited<ReturnType<typeof createClient>>;
  user: { id: string; email?: string | null };
  /**
   * UUID aktywnej organizacji.
   * Nazwa pola pozostaje `tenantId` aby uniknąć ogromnego diffa po wszystkich
   * Server Actions — semantyka to `organization_id`.
   */
  tenantId: string;
  role: UserRole;
}

/**
 * UX-01 (WZR-02): formularz wyrenderowano dla innej firmy niż aktywna teraz —
 * np. przełącznik firm w drugiej karcie zmienił ciasteczko. Jeden tekst dla
 * wszystkich akcji wystawiania: która firma jest aktywna (gdy nazwa się
 * odczyta) i obie drogi wyjścia. Przełącznik w karcie z odmową pokazuje
 * jeszcze starą firmę, więc „z powrotem” działa tylko tam, gdzie ją zmieniono.
 */
export function tenantChangedMessage(activeName: string | null): string {
  const now = activeName ? ` (teraz: ${activeName})` : '';
  return `Aktywna firma zmieniła się od otwarcia formularza${now}. `
    + 'Przełącz firmę z powrotem w karcie, w której ją zmieniono, i zapisz ponownie '
    + '— albo odśwież tę stronę i wypełnij formularz dla aktywnej firmy.';
}

/**
 * Nazwa AKTYWNEJ firmy do komunikatu odmowy — członkostwo jest już
 * sprawdzone. Nigdy nie czytamy nazwy firmy z pola formularza: to id
 * z przeglądarki, a klient serwisowy pokazałby nazwę dowolnej firmy.
 * Błąd odczytu = komunikat bez nazwy, odmowa zostaje.
 */
async function activeOrgName(
  admin: ReturnType<typeof createAdminClient>,
  activeOrg: string,
): Promise<string | null> {
  try {
    const { data } = await admin.from('tenants').select('name').eq('id', activeOrg).maybeSingle();
    const name: unknown = data?.name;
    return typeof name === 'string' && name.trim() ? name.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Firma, dla której strona wyrenderowała formularz (UX-01). Przychodzi
 * z przeglądarki, więc służy WYŁĄCZNIE do porównania z firmą z ciasteczka —
 * nigdy nie wybiera firmy. Brak pola albo inna wartość = odmowa.
 */
export interface FormTenantCheck {
  expectedTenantId: unknown;
}

/**
 * Wymaga zalogowanego usera + ważnej aktywnej organizacji
 * (cookie + aktywne membership). Rzuca `ActionAuthError` w razie problemu.
 *
 * Z `formTenant` (akcje tworzące dokument z formularza) dodatkowo wymaga,
 * żeby formularz był wyrenderowany dla tej samej firmy, co aktywna teraz.
 */
export async function requireUserAndActiveOrg(formTenant?: FormTenantCheck): Promise<AuthContext> {
  const supabase = await createClient();
  const state = await getVerifiedMfaState(supabase).catch(() => null);
  if (!state) {
    throw new ActionAuthError('Nie udało się zweryfikować sesji. Zaloguj się ponownie.');
  }
  if (state.status === 'unauthenticated') throw new ActionAuthError('Niezalogowany');
  if (state.status === 'challenge_required') {
    throw new ActionAuthError('Wymagana weryfikacja dwuetapowa');
  }
  // MFA is optional for tenant users, but an enrolled user must finish the
  // challenge before any tenant lookup or construction of a service-role client.
  const { user } = state;

  const cookieStore = await cookies();
  const activeOrg = cookieStore.get(ACTIVE_ORG_COOKIE)?.value;

  if (!isUuid(activeOrg)) {
    throw new ActionAuthError('Brak aktywnej organizacji');
  }

  // Membership weryfikujemy admin clientem — pewny i deterministyczny check
  // (omija RLS). Bezpieczeństwo: filtrujemy po auth.uid() z user-context.
  const admin = createAdminClient();
  const { data: membership } = await admin
    .from('memberships')
    .select('role, status')
    .eq('user_id', user.id)
    .eq('organization_id', activeOrg)
    .eq('status', 'active')
    .maybeSingle();

  if (!membership) {
    throw new ActionAuthError('Brak dostępu do aktywnej organizacji');
  }

  // Przed każdym odczytem danych firmy: dokument z formularza firmy A nie może
  // powstać jako dokument firmy B. Karta bez pola (otwarta przed wdrożeniem)
  // też dostaje odmowę, niezależnie od tego, czy ID akcji się zmieni.
  if (formTenant && formTenant.expectedTenantId !== activeOrg) {
    throw new ActionAuthError(tenantChangedMessage(await activeOrgName(admin, activeOrg)));
  }

  return {
    supabase,
    user: { id: user.id, email: user.email ?? null },
    tenantId: activeOrg,
    role: (membership.role ?? 'member') as UserRole,
  };
}

/**
 * Zalogowany użytkownik po drugim kroku MFA (gdy go ma), bez organizacji —
 * dla akcji na danych samego użytkownika (np. własne rozmowy z pomocą).
 * Sam `getUser()` przepuszczał sesję AAL1 konta z włączonym MFA (AUD-58).
 */
export async function requireVerifiedUser(): Promise<Pick<AuthContext, 'supabase' | 'user'>> {
  const supabase = await createClient();
  const state = await getVerifiedMfaState(supabase).catch(() => null);
  if (!state) {
    throw new ActionAuthError('Nie udało się zweryfikować sesji. Zaloguj się ponownie.');
  }
  if (state.status === 'unauthenticated') throw new ActionAuthError('Niezalogowany');
  if (state.status === 'challenge_required') {
    throw new ActionAuthError('Wymagana weryfikacja dwuetapowa');
  }
  return { supabase, user: { id: state.user.id, email: state.user.email ?? null } };
}

/** Alias zachowany dla zgodności z istniejącymi wywołaniami w kodzie. */
export const requireUserAndTenant = requireUserAndActiveOrg;

/**
 * Wariant dla Route Handlerów (`app/api/*`), które zwracają JSON zamiast
 * rzucać wyjątek. Zwraca zweryfikowany (membership) tenantId aktywnej org
 * albo dyskryminowany błąd z gotowym statusem HTTP.
 *
 * KRYTYCZNE bezpieczeństwo: cookie `ksef.active_org` jest httpOnly, ale
 * wartość cookie jest kontrolowana przez klienta na poziomie HTTP (httpOnly
 * blokuje tylko JS, nie spreparowane żądanie). Dlatego każdy endpoint, który
 * używa `createAdminClient()` (omija RLS) NIE MOŻE ufać samemu formatowi UUID
 * z `getActiveOrgIdFromCookies()` — musi potwierdzić aktywne membership, co
 * robi ten helper. Endpointy na kliencie user-context (RLS) są chronione i
 * bez tego, ale użycie tego helpera i tam nie szkodzi.
 */
export type ApiOrgContext =
  | { ok: true; userId: string; tenantId: string; role: UserRole }
  | { ok: false; status: 401 | 403; error: string };

export async function resolveApiUserAndActiveOrg(): Promise<ApiOrgContext> {
  const supabase = await createClient();
  const state = await getVerifiedMfaState(supabase).catch(() => null);
  if (!state) return { ok: false, status: 401, error: 'session_verification_failed' };
  if (state.status === 'unauthenticated') {
    return { ok: false, status: 401, error: 'not_authenticated' };
  }
  if (state.status === 'challenge_required') {
    return { ok: false, status: 403, error: 'mfa_required' };
  }
  const { user } = state;

  const cookieStore = await cookies();
  const activeOrg = cookieStore.get(ACTIVE_ORG_COOKIE)?.value;
  if (!isUuid(activeOrg)) {
    return { ok: false, status: 403, error: 'no_active_org' };
  }

  const admin = createAdminClient();
  const { data: membership } = await admin
    .from('memberships')
    .select('role')
    .eq('user_id', user.id)
    .eq('organization_id', activeOrg)
    .eq('status', 'active')
    .maybeSingle();

  if (!membership) return { ok: false, status: 403, error: 'no_active_org' };

  return {
    ok: true,
    userId: user.id,
    tenantId: activeOrg,
    role: (membership.role ?? 'member') as UserRole,
  };
}

/**
 * Wymaga konkretnej roli w aktywnej organizacji.
 * Lista akceptowanych ról jako argument — np. `requireOrgRole(['owner','admin'])`.
 */
export async function requireOrgRole(
  roles: UserRole | UserRole[],
): Promise<AuthContext> {
  const ctx = await requireUserAndActiveOrg();
  const allowed = Array.isArray(roles) ? roles : [roles];
  if (!allowed.includes(ctx.role)) {
    throw new ActionAuthError(
      allowed.length === 1 && allowed[0] === 'owner'
        ? 'Tylko właściciel'
        : 'Niewystarczające uprawnienia',
    );
  }
  return ctx;
}

/**
 * Wymaga zalogowanego owner-a aktywnej organizacji.
 */
export async function requireOwner(): Promise<AuthContext> {
  return requireOrgRole('owner');
}

/**
 * Bezpieczny wrapper na akcje serwerowe — łapie `ActionAuthError`
 * i mapuje na typowy `{ success: false, error }`.
 */
export async function withActionAuth<T>(
  fn: () => Promise<{ success: true } & T>,
): Promise<({ success: true } & T) | { success: false; error: string }> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ActionAuthError) {
      return { success: false, error: e.message };
    }
    throw e;
  }
}

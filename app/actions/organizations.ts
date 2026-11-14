'use server';

import { createHash, randomBytes } from 'crypto';
import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { logAudit } from '@/lib/audit/log';
import { rememberLastActiveOrganization } from '@/lib/organizations/last-active';
import { requireCodeForAccessGrant } from '@/lib/auth/access-grant-mfa';
import { emailsForUserIds } from '@/lib/auth/auth-users';
import { checkRateLimit } from '@/lib/rate-limit';
import { getVerifiedUserContext } from '@/lib/auth/verified-user';
import { sendEmail } from '@/lib/email/send';
import { FIRST_COMPANY_CLOSED_MESSAGE, isSignupClosed } from '@/lib/feature-flags/signups';
import { createAdminClient } from '@/lib/supabase/server';
import { ACTIVE_ORG_COOKIE, isUuid } from '@/lib/supabase/active-org';
import { hasConfiguredKsefProof } from '@/lib/ksef/claim-environment';
import {
  ActionAuthError,
  requireOrgRole,
  requireVerifiedUser,
  type UserRole,
} from '@/lib/supabase/auth-context';
import {
  getCachedMembershipRowsWithTenants,
  getDashboardSessionUser,
  mapMembershipRowsToOrgSwitcher,
} from '@/lib/dashboard-shell-data';

/**
 * Wspólny helper ustawiający cookie ksef.active_org. Wywoływany ze Server
 * Actions zaraz przed `redirect()` — Next.js łączy Set-Cookie z 303 redirect
 * w jednym response HTTP, eliminując race condition cookie-set vs nawigacja.
 */
async function setActiveOrgCookie(orgId: string) {
  const cookieStore = await cookies();
  cookieStore.set({
    name: ACTIVE_ORG_COOKIE,
    value: orgId,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  });
}

// ═══════════════════════════════════════════════════════════════
// Typy
// ═══════════════════════════════════════════════════════════════

export type ActionOk<T = unknown> =
  T extends object ? { success: true } & T : { success: true };
/**
 * `mfaStepUp`: konto ma 2FA, a ta sesja (po biometrii) kodu nie podała. Formularz
 * pokazuje wtedy przejście na ekran kodu (`MfaStepUpNotice`), nie sam tekst błędu.
 */
export type ActionFail = { success: false; error: string; mfaStepUp?: true };

export interface OrganizationCompanyInput {
  nip: string;
  name: string;
  postalCode: string;
  city: string;
  street: string;
  buildingNumber: string;
  localNumber?: string;
}

type OrganizationAddressJson = {
  countryCode: string;
  addressLine1: string;
  addressLine2: string;
};

/** Czytelny komunikat przy INSERT tenants — tylko po nazwie constraincie / indeksu (bez ogólnego „tenants_nip”). */
function formatTenantInsertError(err: {
  message?: string;
  details?: string;
  code?: string | number;
} | null): string {
  const msg = err?.message ?? 'insert tenant failed';
  const details = err?.details ?? '';
  const blob = `${msg} ${details}`;
  const codeStr = err?.code != null ? String(err.code) : '';
  const isUnique = codeStr === '23505';

  if (!isUnique) {
    return msg;
  }
  // Wyłącznie stary globalny UNIQUE(nip) z initial schema — NIE łączyć z
  // „idx_tenants_nip*” (np. idx_tenants_nip_ksef_unique_verified z 00039).
  if (blob.includes('tenants_nip_key')) {
    return (
      'Ten NIP jest już zajęty w tej bazie (stare ograniczenie UNIQUE na nip — constraint tenants_nip_key). ' +
      'Na zdalnym Supabase: w katalogu projektu `pnpm exec supabase db push` (m.in. migracje 00035 i 00041). ' +
      'Lokalnie (`supabase start`): `pnpm exec supabase db reset`, żeby odtworzyć schemat z plików migracji. ' +
      'Albo tymczasowo inny numer NIP testowy.'
    );
  }
  if (blob.includes('idx_tenants_nip_ksef_unique_verified')) {
    return (
      'Dla tego NIP-u istnieje już organizacja ze zweryfikowanym KSeF. ' +
      'Może być tylko jedna taka na numer — poproś o dostęp do istniejącej firmy lub użyj innego NIP-u testowego.'
    );
  }
  return msg;
}

/**
 * Wyłącznik `disableSignups` przy zakładaniu PIERWSZEJ firmy (AUD-63).
 * Konto z Google albo prosto z GoTrue powstaje poza naszym formularzem —
 * bez firmy nic w aplikacji nie zrobi, więc to tu zamykamy rejestrację.
 * Klient z aktywnym członkostwem dodaje kolejne firmy jak dotąd.
 * Błąd odczytu członkostw przy zamkniętej rejestracji = odmowa (fail-closed).
 */
async function firstCompanyBlocked(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
): Promise<string | null> {
  if (!(await isSignupClosed())) return null;
  const { count, error } = await admin
    .from('memberships')
    .select('organization_id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('status', 'active');
  if (error || !count) return FIRST_COMPANY_CLOSED_MESSAGE;
  return null;
}

/**
 * Tenant + membership owner + last_active_tenant_id (jak RPC
 * `create_organization_with_owner`). Przez service_role — nie zależy od
 * PostgREST schema cache dla RPC (omija błąd „function … not in schema cache”).
 *
 * Nie wysyłamy `created_by_user_id` w INSERT — przy przestarzałym cache PostgREST
 * zdarza się błąd „column … not in schema cache”; kolumna jest nullable i czysto
 * informacyjna (uprawnienia są w memberships).
 */
async function insertOrganizationAsOwner(params: {
  admin: ReturnType<typeof createAdminClient>;
  userId: string;
  name: string;
  nip: string;
  addressJson: OrganizationAddressJson;
}): Promise<{ ok: true; organizationId: string } | { ok: false; message: string }> {
  const { admin, userId, name, nip, addressJson } = params;

  const { data: tenant, error: tenantErr } = await admin
    .from('tenants')
    .insert({
      name,
      nip,
      address_json: addressJson,
      is_active: true,
    })
    .select('id')
    .single();

  if (tenantErr || !tenant?.id) {
    return {
      ok: false,
      message: formatTenantInsertError(tenantErr),
    };
  }

  const organizationId = tenant.id;

  const { error: memErr } = await admin.from('memberships').insert({
    organization_id: organizationId,
    user_id: userId,
    role: 'owner',
    status: 'active',
  });

  if (memErr) {
    await admin.from('tenants').delete().eq('id', organizationId);
    return { ok: false, message: memErr.message };
  }

  const { error: userErr } = await admin
    .from('users')
    .update({ last_active_tenant_id: organizationId })
    .eq('id', userId);

  if (userErr) {
    await admin
      .from('memberships')
      .delete()
      .eq('organization_id', organizationId)
      .eq('user_id', userId);
    await admin.from('tenants').delete().eq('id', organizationId);
    return { ok: false, message: userErr.message };
  }

  return { ok: true, organizationId };
}

// ═══════════════════════════════════════════════════════════════
// Set active organization
// ═══════════════════════════════════════════════════════════════

export async function setActiveOrganizationAction(
  orgId: string,
): Promise<ActionOk | ActionFail> {
  if (!isUuid(orgId)) {
    return { success: false, error: 'Nieprawidłowy identyfikator organizacji' };
  }

  // Sesja po drugim kroku MFA, nie sam `getUser()` (AUD-58).
  let verified: Awaited<ReturnType<typeof requireVerifiedUser>>;
  try {
    verified = await requireVerifiedUser();
  } catch (e) {
    if (e instanceof ActionAuthError) return { success: false, error: e.message };
    throw e;
  }
  const { supabase, user } = verified;

  // Membership check przez admin (deterministyczne) — bezpieczne, bo
  // filtrujemy explicit po user.id zalogowanego.
  const admin = createAdminClient();
  const { data: membership } = await admin
    .from('memberships')
    .select('id')
    .eq('user_id', user.id)
    .eq('organization_id', orgId)
    .eq('status', 'active')
    .maybeSingle();

  if (!membership) {
    return { success: false, error: 'Brak dostępu do tej organizacji' };
  }

  await setActiveOrgCookie(orgId);

  // Ten sam zapis co wybór firmy w telefonie (`lib/organizations/last-active.ts`).
  await rememberLastActiveOrganization(supabase, user.id, orgId);

  revalidatePath('/');
  return { success: true };
}

// ═══════════════════════════════════════════════════════════════
// Create organization (onboarding: stwórz nową firmę)
// ═══════════════════════════════════════════════════════════════

/**
 * Tworzy organizację, ustawia cookie aktywnej org i przekierowuje na
 * /onboarding/import-source W RAMACH JEDNEGO HTTP RESPONSE (Set-Cookie + 303).
 *
 * Atomowość Set-Cookie + redirect eliminuje race condition, w którym klient
 * wykonywał `window.location.assign()` zanim cookie z poprzedniej akcji trafiło
 * do browsera — co skutkowało redirectem z `/onboarding/import-source` z
 * powrotem do `/onboarding` (pętla onboardingu).
 *
 * W razie błędu zwraca `{ success: false, error }`. W razie sukcesu nigdy nie
 * zwraca (rzuca NEXT_REDIRECT obsługiwany przez Next.js).
 */
export async function createOrganizationAction(
  company: OrganizationCompanyInput,
): Promise<ActionFail> {
  const context = await getVerifiedUserContext();
  if (!context.ok) return { success: false, error: context.error };
  const { user } = context;

  if (!/^\d{10}$/.test(company.nip)) {
    return { success: false, error: 'NIP musi zawierać 10 cyfr' };
  }
  if (!company.name?.trim()) {
    return { success: false, error: 'Nazwa firmy wymagana' };
  }

  const admin = createAdminClient();
  const closed = await firstCompanyBlocked(admin, user.id);
  if (closed) return { success: false, error: closed };
  const { data: nipMatches } = await admin
    .from('tenants')
    .select('id, ksef_verified_at, ksef_verified_environment')
    .eq('nip', company.nip)
    .limit(5);

  const duplicates = nipMatches ?? [];
  const nipDuplicate = duplicates.length > 0;
  const ksefVerifiedDuplicate = duplicates.some(
    (t) => hasConfiguredKsefProof(t.ksef_verified_at, t.ksef_verified_environment),
  );

  const addressLine1 = `${company.street} ${company.buildingNumber}${
    company.localNumber ? '/' + company.localNumber : ''
  }`.trim();
  const addressLine2 = `${company.postalCode} ${company.city}`;
  const addressJson: OrganizationAddressJson = {
    countryCode: 'PL',
    addressLine1,
    addressLine2,
  };

  const created = await insertOrganizationAsOwner({
    admin,
    userId: user.id,
    name: company.name,
    nip: company.nip,
    addressJson,
  });

  if (!created.ok) {
    return {
      success: false,
      error: `Błąd tworzenia firmy: ${created.message}`,
    };
  }

  const orgId = created.organizationId;

  await logAudit({
    action: 'tenant.created',
    tenantId: orgId,
    userId: user.id,
    metadata: {
      nip: company.nip,
      name: company.name,
      nip_duplicate: nipDuplicate,
      ksef_verified_duplicate: ksefVerifiedDuplicate,
    },
  });

  // Faza 25 Krok 1: eager Stripe customer creation. Spec ze speca wymaga
  // customer'a przy rejestracji (nawet bez karty), żeby tracking
  // ARR/lifecycle był od dnia 1. Fail-soft: jeśli Stripe niedostępne, tenant
  // i tak powstaje — user dostaje Stripe customer później (lazy fallback
  // w `/settings/billing`).
  if (user.email) {
    try {
      const { ensureStripeCustomer } = await import('@/lib/stripe/customer');
      const { isStripeConfigured } = await import('@/lib/stripe/client');
      if (isStripeConfigured()) {
        await ensureStripeCustomer({
          tenantId: orgId,
          email: user.email,
          name: company.name,
          nip: company.nip,
        });
      }
    } catch (e) {
      // Nie blokujemy onboardingu na Stripe outage. Sentry capture + dalej.
      const Sentry = await import('@sentry/nextjs');
      Sentry.captureException(e, {
        tags: { area: 'onboarding.stripe-customer' },
        extra: { tenantId: orgId },
      });
    }
  }

  await setActiveOrgCookie(orgId);

  // redirect() rzuca NEXT_REDIRECT — Next.js przejmie i zwróci 303 z
  // Set-Cookie + Location atomowo.
  redirect('/onboarding/import-source');
}

// ═══════════════════════════════════════════════════════════════
// Skip NIP (BUG-007): wejście do apki bez rejestrowania NIP-u
// ═══════════════════════════════════════════════════════════════

/**
 * „Pomiń NIP" w onboardingu — tworzy organizację-szkic („Moja firma",
 * nip = '') i wpuszcza usera do dashboardu na pełny podgląd aplikacji.
 *
 * Dlaczego organizacja-szkic zamiast „user bez organizacji": cały dashboard
 * (RLS, active-org cookie, `assertDashboardShellAccess`) wymaga tenanta.
 * Pusty NIP działa jako sentinel „NIP nieuzupełniony":
 *  - `uploadCertificateAction` odmawia przy pustym NIP (guard `if (!nip)`),
 *  - `/settings/ksef` pokazuje formularz uzupełnienia NIP zamiast uploadu,
 *  - po uzupełnieniu (`completeCompanyNipAction`) org staje się pełnoprawna.
 *
 * Idempotentne: ponowne kliknięcie „Pomiń" NIE tworzy drugiego szkicu —
 * ustawia cookie na istniejący szkic usera i przechodzi do dashboardu.
 * W razie sukcesu nie returnsuje (NEXT_REDIRECT).
 */
export async function skipOnboardingWithoutNipAction(): Promise<ActionFail> {
  const context = await getVerifiedUserContext();
  if (!context.ok) return { success: false, error: context.error };
  const { user } = context;

  const admin = createAdminClient();

  // Czy user ma już organizację-szkic (nip = '')? → reuse zamiast duplikatu.
  const { data: existing } = await admin
    .from('memberships')
    .select('organization_id, tenants:organization_id(nip)')
    .eq('user_id', user.id)
    .eq('status', 'active')
    .limit(50);

  const draft = (existing ?? []).find((m) => {
    const t = Array.isArray(m.tenants) ? m.tenants[0] : m.tenants;
    return t !== null && typeof t === 'object' && 'nip' in t && t.nip === '';
  });

  let orgId: string;

  if (draft) {
    orgId = draft.organization_id;
  } else {
    const closed = await firstCompanyBlocked(admin, user.id);
    if (closed) return { success: false, error: closed };
    const created = await insertOrganizationAsOwner({
      admin,
      userId: user.id,
      name: 'Moja firma',
      nip: '',
      addressJson: { countryCode: 'PL', addressLine1: '', addressLine2: '' },
    });
    if (!created.ok) {
      return {
        success: false,
        error: `Błąd tworzenia organizacji: ${created.message}`,
      };
    }
    orgId = created.organizationId;

    await logAudit({
      action: 'tenant.created',
      tenantId: orgId,
      userId: user.id,
      metadata: { skipped_nip: true, name: 'Moja firma' },
    });
  }

  await setActiveOrgCookie(orgId);
  redirect('/dashboard');
}

/**
 * Uzupełnienie NIP-u organizacji-szkicu (druga połowa BUG-007).
 *
 * UPDATE tenants ograniczony warunkiem `nip = ''` — nie da się tą akcją
 * podmienić NIP-u pełnoprawnej (tym bardziej zweryfikowanej w KSeF)
 * organizacji. Wymaga roli owner w aktywnej organizacji.
 */
export async function completeCompanyNipAction(
  company: OrganizationCompanyInput,
): Promise<ActionOk | ActionFail> {
  // Sesja po drugim kroku MFA (AUD-58); rola właściciela sprawdzana niżej.
  let verified: Awaited<ReturnType<typeof requireVerifiedUser>>;
  try {
    verified = await requireVerifiedUser();
  } catch (e) {
    if (e instanceof ActionAuthError) return { success: false, error: e.message };
    throw e;
  }
  const { user } = verified;

  const cookieStore = await cookies();
  const orgId = cookieStore.get(ACTIVE_ORG_COOKIE)?.value;
  if (!isUuid(orgId)) {
    return { success: false, error: 'Brak aktywnej organizacji' };
  }

  if (!/^\d{10}$/.test(company.nip)) {
    return { success: false, error: 'NIP musi zawierać 10 cyfr' };
  }
  if (!company.name?.trim()) {
    return { success: false, error: 'Nazwa firmy wymagana' };
  }

  const admin = createAdminClient();

  const { data: membership } = await admin
    .from('memberships')
    .select('role')
    .eq('user_id', user.id)
    .eq('organization_id', orgId)
    .eq('status', 'active')
    .maybeSingle();

  if (!membership || membership.role !== 'owner') {
    return {
      success: false,
      error: 'Tylko właściciel organizacji może uzupełnić NIP',
    };
  }

  const addressLine1 = `${company.street} ${company.buildingNumber}${
    company.localNumber ? '/' + company.localNumber : ''
  }`.trim();
  const addressJson: OrganizationAddressJson = {
    countryCode: 'PL',
    addressLine1,
    addressLine2: `${company.postalCode} ${company.city}`,
  };

  const { data: updated, error: updErr } = await admin
    .from('tenants')
    .update({
      name: company.name,
      nip: company.nip,
      address_json: addressJson,
    })
    .eq('id', orgId)
    .eq('nip', '') // tylko szkic — nigdy podmiana NIP-u istniejącej firmy
    .select('id')
    .maybeSingle();

  if (updErr) {
    return { success: false, error: formatTenantInsertError(updErr) };
  }
  if (!updated) {
    return {
      success: false,
      error:
        'Ta organizacja ma już przypisany NIP — nie można go nadpisać tą akcją.',
    };
  }

  await logAudit({
    action: 'tenant.updated',
    tenantId: orgId,
    userId: user.id,
    metadata: { nip_completed: true, nip: company.nip, name: company.name },
  });

  // Eager Stripe customer — jak w createOrganizationAction (fail-soft).
  if (user.email) {
    try {
      const { ensureStripeCustomer } = await import('@/lib/stripe/customer');
      const { isStripeConfigured } = await import('@/lib/stripe/client');
      if (isStripeConfigured()) {
        await ensureStripeCustomer({
          tenantId: orgId,
          email: user.email,
          name: company.name,
          nip: company.nip,
        });
      }
    } catch (e) {
      const Sentry = await import('@sentry/nextjs');
      Sentry.captureException(e, {
        tags: { area: 'settings.complete-nip.stripe-customer' },
        extra: { tenantId: orgId },
      });
    }
  }

  revalidatePath('/settings/ksef');
  revalidatePath('/', 'layout');
  return { success: true };
}

// ═══════════════════════════════════════════════════════════════
// Invitations
// ═══════════════════════════════════════════════════════════════

function generateInviteToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  return { token, tokenHash };
}

/** Limity zaproszeń firmy (AUD-32). */
const MAX_PENDING_INVITATIONS = 20;
const INVITATIONS_PER_HOUR = 20;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export async function inviteMemberAction(params: {
  email: string;
  role: 'admin' | 'member' | 'accountant';
}): Promise<ActionOk<{ invitationId: string }> | ActionFail> {
  let ctx;
  try {
    ctx = await requireOrgRole(['owner', 'admin']);
  } catch (e) {
    if (e instanceof ActionAuthError) return { success: false, error: e.message };
    throw e;
  }
  const { supabase, tenantId, user } = ctx;

  const email = params.email.trim().toLowerCase();
  if (!isValidEmail(email)) {
    return { success: false, error: 'Nieprawidłowy email' };
  }
  if (!['admin', 'member', 'accountant'].includes(params.role)) {
    return { success: false, error: 'Nieprawidłowa rola' };
  }

  // Zaproszenie oddaje dostęp osobie trzeciej: sesja po biometrii potrzebuje kodu.
  const stepUp = await requireCodeForAccessGrant(supabase, user.id, 'Zaproszenie do firmy');
  if (stepUp) return stepUp;

  // Czy ten email już jest aktywnym członkiem?
  // Membership wskazuje na user_id; email żyje w auth.users — zmatchujemy
  // poprzez auth.admin.listUsers() (jedyne źródło prawdy o emailu).
  const admin = createAdminClient();
  const { data: existing } = await admin
    .from('memberships')
    .select('user_id')
    .eq('organization_id', tenantId)
    .eq('status', 'active');

  if (existing && existing.length > 0) {
    // E-maile członków po identyfikatorach — nie z pierwszych 200 kont (AUD-125).
    const emails = await emailsForUserIds(admin, existing.map((m) => m.user_id));
    if ([...emails.values()].some((e) => e.toLowerCase() === email)) {
      return { success: false, error: 'Ten użytkownik jest już członkiem' };
    }
  }

  // Limit zaproszeń firmy (AUD-32): mail idzie z domeny FaktWay na dowolny
  // adres, z nazwą firmy, którą wpisuje użytkownik.
  const { count: pending, error: pendingError } = await admin
    .from('organization_invitations')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', tenantId)
    .is('accepted_at', null)
    .is('revoked_at', null)
    .gt('expires_at', new Date().toISOString());
  if (pendingError) {
    return { success: false, error: 'Nie można sprawdzić zaproszeń. Spróbuj ponownie.' };
  }
  if ((pending ?? 0) >= MAX_PENDING_INVITATIONS) {
    return {
      success: false,
      error: `Osiągnięto limit ${MAX_PENDING_INVITATIONS} oczekujących zaproszeń. Cofnij nieużywane albo poczekaj na akceptację.`,
    };
  }
  const quota = await checkRateLimit({
    bucket: 'invitation',
    identifier: tenantId,
    limit: INVITATIONS_PER_HOUR,
    windowSeconds: 3600,
  });
  if (!quota.allowed) {
    return { success: false, error: `Osiągnięto limit ${INVITATIONS_PER_HOUR} zaproszeń na godzinę. Spróbuj później.` };
  }

  const { token, tokenHash } = generateInviteToken();

  // Anuluj poprzednie aktywne zaproszenie dla tego samego emaila (idempotency).
  await admin
    .from('organization_invitations')
    .update({ revoked_at: new Date().toISOString() })
    .eq('organization_id', tenantId)
    .eq('email', email)
    .is('accepted_at', null)
    .is('revoked_at', null);

  const { data: inv, error } = await supabase
    .from('organization_invitations')
    .insert({
      organization_id: tenantId,
      email,
      role: params.role,
      token_hash: tokenHash,
      invited_by: user.id,
    })
    .select('id')
    .single();

  if (error || !inv) {
    return {
      success: false,
      error: `Błąd zapisu zaproszenia: ${error?.message ?? 'unknown'}`,
    };
  }

  // Pobierz nazwę org dla treści maila.
  const { data: org } = await supabase
    .from('tenants')
    .select('name')
    .eq('id', tenantId)
    .maybeSingle();

  const baseUrl =
    process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '') ??
    'http://localhost:3000';
  const inviteUrl = `${baseUrl}/invite/${token}`;
  const orgName = org?.name ?? 'organizacja';
  // Nazwa firmy pochodzi od użytkownika: w HTML escapowana, w temacie bez
  // znaków sterujących i przycięta (AUD-32).
  const orgNameHtml = escapeHtml(orgName);
  const orgNameSubject = orgName.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 80);

  try {
    await sendEmail({
      to: email,
      subject: `Zaproszenie do ${orgNameSubject} w FaktWay`,
      html: `
        <p>Cześć,</p>
        <p>Zostałeś/aś zaproszony/a do organizacji <strong>${orgNameHtml}</strong> w FaktWay w roli <strong>${params.role}</strong>.</p>
        <p><a href="${inviteUrl}">Kliknij aby zaakceptować zaproszenie</a></p>
        <p>Link wygasa za 7 dni.</p>
        <p style="color:#888;font-size:12px">Jeśli nie spodziewałeś/aś się tego maila, zignoruj go.</p>
      `,
    });
  } catch {
    // Mail nie poszedł — invitation zostaje, można retry lub skopiować link
    // ręcznie z UI. Nie failujemy całej akcji.
  }

  await logAudit({
    action: 'invitation.created',
    tenantId,
    userId: user.id,
    metadata: { email, role: params.role, invitation_id: inv.id },
  });

  return { success: true, invitationId: inv.id };
}

export async function revokeInvitationAction(
  invitationId: string,
): Promise<ActionOk | ActionFail> {
  let ctx;
  try {
    ctx = await requireOrgRole(['owner', 'admin']);
  } catch (e) {
    if (e instanceof ActionAuthError) return { success: false, error: e.message };
    throw e;
  }
  const { supabase, tenantId, user } = ctx;

  const { error } = await supabase
    .from('organization_invitations')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', invitationId)
    .eq('organization_id', tenantId)
    .is('accepted_at', null);

  if (error) {
    return { success: false, error: error.message };
  }

  await logAudit({
    action: 'invitation.revoked',
    tenantId,
    userId: user.id,
    metadata: { invitation_id: invitationId },
  });

  revalidatePath('/settings/team');
  return { success: true };
}

// ═══════════════════════════════════════════════════════════════
// Accept invitation (z poziomu zalogowanego usera, plaintext token z URL)
// ═══════════════════════════════════════════════════════════════

/**
 * Akceptuje zaproszenie, ustawia cookie aktywnej org i przekierowuje na
 * `/dashboard` (Dashboard). Cookie + redirect lecą w jednym HTTP response (atomowo).
 * W razie błędu zwraca `{ success: false, error }`.
 */
export async function acceptInvitationAction(
  token: string,
): Promise<ActionFail> {
  if (typeof token !== 'string' || token.length < 16) {
    return { success: false, error: 'Nieprawidłowy token' };
  }

  const context = await getVerifiedUserContext();
  if (!context.ok) return { success: false, error: context.error };
  const { supabase, user } = context;

  const tokenHash = createHash('sha256').update(token).digest('hex');

  const { data: orgId, error } = await supabase.rpc(
    'accept_organization_invitation',
    { p_token_hash: tokenHash },
  );

  if (error || !orgId) {
    const msg = error?.message ?? 'unknown';
    const friendly = mapInvitationError(msg);
    return { success: false, error: friendly };
  }

  await logAudit({
    action: 'invitation.accepted',
    tenantId: orgId,
    userId: user.id,
  });

  await setActiveOrgCookie(orgId);
  redirect('/dashboard');
}

function mapInvitationError(raw: string): string {
  if (raw.includes('invitation_email_mismatch')) {
    return 'Zaproszenie zostało wysłane na inny adres email — zaloguj się na właściwe konto';
  }
  if (raw.includes('invitation_expired')) return 'Zaproszenie wygasło';
  if (raw.includes('invitation_already_accepted')) {
    return 'Zaproszenie zostało już użyte';
  }
  if (raw.includes('invitation_revoked')) {
    return 'Zaproszenie zostało anulowane';
  }
  if (raw.includes('invitation_not_found')) {
    return 'Zaproszenie nie istnieje';
  }
  if (raw.includes('user_no_email')) {
    return 'Twoje konto nie ma adresu email';
  }
  return `Błąd akceptacji: ${raw}`;
}

// ═══════════════════════════════════════════════════════════════
// Join requests
// ═══════════════════════════════════════════════════════════════

export async function requestJoinAction(params: {
  organizationId: string;
  message?: string;
}): Promise<ActionOk<{ requestId: string }> | ActionFail> {
  if (!isUuid(params.organizationId)) {
    return { success: false, error: 'Nieprawidłowa organizacja' };
  }

  const context = await getVerifiedUserContext();
  if (!context.ok) return { success: false, error: context.error };
  const { supabase, user } = context;

  // Czy user już jest członkiem? Wtedy nie wysyłamy requestu.
  const { data: existing } = await supabase
    .from('memberships')
    .select('status')
    .eq('user_id', user.id)
    .eq('organization_id', params.organizationId)
    .maybeSingle();

  if (existing?.status === 'active') {
    return { success: false, error: 'Jesteś już członkiem tej organizacji' };
  }

  const { data: req, error } = await supabase
    .from('organization_join_requests')
    .insert({
      organization_id: params.organizationId,
      requested_by_user_id: user.id,
      message: params.message?.trim() || null,
    })
    .select('id')
    .single();

  if (error || !req) {
    if (error?.code === '23505') {
      return { success: false, error: 'Prośba już oczekuje na decyzję' };
    }
    return { success: false, error: error?.message ?? 'Błąd zapisu' };
  }

  await logAudit({
    action: 'join_request.created',
    tenantId: params.organizationId,
    userId: user.id,
    metadata: { request_id: req.id },
  });

  return { success: true, requestId: req.id };
}

export async function approveJoinRequestAction(
  requestId: string,
  role: 'admin' | 'member' | 'accountant' = 'member',
): Promise<ActionOk | ActionFail> {
  let ctx;
  try {
    ctx = await requireOrgRole(['owner', 'admin']);
  } catch (e) {
    if (e instanceof ActionAuthError) return { success: false, error: e.message };
    throw e;
  }
  const { supabase, tenantId, user } = ctx;

  // Przyjęcie prośby oddaje dostęp osobie trzeciej: sesja po biometrii potrzebuje kodu.
  const stepUp = await requireCodeForAccessGrant(supabase, user.id, 'Przyjęcie prośby o dostęp');
  if (stepUp) return stepUp;

  const { error } = await supabase.rpc('approve_join_request', {
    p_request_id: requestId,
    p_role: role,
  });

  if (error) {
    return { success: false, error: error.message };
  }

  await logAudit({
    action: 'join_request.approved',
    tenantId,
    userId: user.id,
    metadata: { request_id: requestId, role },
  });

  revalidatePath('/settings/team');
  return { success: true };
}

export async function denyJoinRequestAction(
  requestId: string,
): Promise<ActionOk | ActionFail> {
  let ctx;
  try {
    ctx = await requireOrgRole(['owner', 'admin']);
  } catch (e) {
    if (e instanceof ActionAuthError) return { success: false, error: e.message };
    throw e;
  }
  const { supabase, tenantId, user } = ctx;

  const { error } = await supabase.rpc('deny_join_request', {
    p_request_id: requestId,
  });

  if (error) {
    return { success: false, error: error.message };
  }

  await logAudit({
    action: 'join_request.denied',
    tenantId,
    userId: user.id,
    metadata: { request_id: requestId },
  });

  revalidatePath('/settings/team');
  return { success: true };
}

// ═══════════════════════════════════════════════════════════════
// Membership management (revoke / change role)
// ═══════════════════════════════════════════════════════════════

export async function revokeMembershipAction(
  membershipId: string,
): Promise<ActionOk | ActionFail> {
  // Sesja po drugim kroku MFA (AUD-58); uprawnienia sprawdza RPC (00103).
  let verified: Awaited<ReturnType<typeof requireVerifiedUser>>;
  try {
    verified = await requireVerifiedUser();
  } catch (e) {
    if (e instanceof ActionAuthError) return { success: false, error: e.message };
    throw e;
  }
  const { supabase, user } = verified;

  const { error } = await supabase.rpc('revoke_membership', {
    p_membership_id: membershipId,
  });

  if (error) {
    if (error.message.includes('cannot_remove_last_owner')) {
      return { success: false, error: 'Nie można usunąć ostatniego właściciela' };
    }
    if (error.message.includes('insufficient_role')) {
      return { success: false, error: 'Brak uprawnień' };
    }
    return { success: false, error: error.message };
  }

  await logAudit({
    action: 'membership.revoked',
    tenantId: null,
    userId: user.id,
    metadata: { membership_id: membershipId },
  });

  revalidatePath('/settings/team');
  return { success: true };
}

export async function changeMembershipRoleAction(params: {
  membershipId: string;
  newRole: 'owner' | 'admin' | 'member' | 'accountant';
}): Promise<ActionOk | ActionFail> {
  let ctx;
  try {
    ctx = await requireOrgRole('owner');
  } catch (e) {
    if (e instanceof ActionAuthError) return { success: false, error: e.message };
    throw e;
  }
  const { supabase, tenantId, user } = ctx;

  // Zmiana roli (także na właściciela) oddaje uprawnienia: sesja po biometrii potrzebuje kodu.
  const stepUp = await requireCodeForAccessGrant(supabase, user.id, 'Zmiana roli w firmie');
  if (stepUp) return stepUp;

  const { error } = await supabase.rpc('change_membership_role', {
    p_membership_id: params.membershipId,
    p_new_role: params.newRole,
  });

  if (error) {
    if (error.message.includes('cannot_demote_last_owner')) {
      return {
        success: false,
        error: 'Nie można zdegradować ostatniego właściciela',
      };
    }
    return { success: false, error: error.message };
  }

  await logAudit({
    action: 'membership.role_changed',
    tenantId,
    userId: user.id,
    metadata: { membership_id: params.membershipId, new_role: params.newRole },
  });

  revalidatePath('/settings/team');
  return { success: true };
}

// ═══════════════════════════════════════════════════════════════
// Helpery odczytu — używane w server components
// ═══════════════════════════════════════════════════════════════

/**
 * Zwraca listę organizacji do których user należy (active memberships).
 *
 * Czytamy admin clientem — używane w org switcherze tuż po założeniu nowej
 * org (admin INSERT), więc user-context z RLS bywa niedeterministyczny przy
 * fresh data. Bezpieczeństwo: filtruję po `auth.getUser()` więc widzimy
 * wyłącznie memberships zalogowanego usera.
 *
 * Implementacja deleguje do `lib/dashboard-shell-data` — jedno zapytanie
 * memberships+tenants na request (cache), bez drugiego `getUser()`.
 */
export async function listMyOrganizations(): Promise<
  Array<{
    organizationId: string;
    name: string;
    nip: string;
    role: UserRole;
    isActive: boolean;
  }>
> {
  const [user, cookieStore] = await Promise.all([
    getDashboardSessionUser(),
    cookies(),
  ]);
  if (!user) return [];

  const activeOrg = cookieStore.get(ACTIVE_ORG_COOKIE)?.value ?? null;

  const rows = await getCachedMembershipRowsWithTenants(user.id);
  return mapMembershipRowsToOrgSwitcher(rows, activeOrg);
}

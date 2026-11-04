import { createHmac, hkdfSync } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Nadawanie dostępu osobom trzecim w sesji po biometrii (recenzja #359, pkt 1).
 *
 * Prawdziwa ścieżka: `auth-context`, bramka panelu ze znacznikiem i ścisły
 * `getVerifiedMfaState`. Atrapą są tylko SDK Auth, baza, poczta i dziennik.
 * Biometria otwiera panel, ale ktoś z odblokowanym telefonem właściciela nie może
 * zaprosić siebie, awansować do `owner` ani wystawić linku księgowej bez kodu
 * z aplikacji. Konto bez 2FA działa jak dotąd.
 */

const s = vi.hoisted(() => ({
  aal: 'aal1' as 'aal1' | 'aal2',
  factors: [] as Array<{ id: string; factor_type: string; status: string }>,
  marker: undefined as string | undefined,
  ops: [] as string[],
  emails: [] as unknown[],
  getClaims: vi.fn(),
  audit: vi.fn(),
}));

const USER ='33333333-3333-4333-8333-333333333333';
const REQUEST = '44444444-4444-4444-8444-444444444444';
const SESSION = 'session-a';
const SERVICE_ROLE = 'fixture-service-role-key-do-testow';
const TOTP = [{ id: 'totp-1', factor_type: 'totp', status: 'verified' }];

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => {
      if (name === 'ksef.active_org') return { value: '11111111-1111-4111-8111-111111111111' };
      if (name === 'ksef.passkey_session' && s.marker) return { value: s.marker };
      return undefined;
    },
    set: vi.fn(),
  }),
  headers: async () => new Headers(),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('@/lib/audit/log', () => ({ logAudit: s.audit }));
vi.mock('@/lib/email/send', () => ({ sendEmail: async (m: unknown) => { s.emails.push(m); return { sent: true }; } }));

function query(table: string) {
  const q: Record<string, unknown> = {};
  Object.assign(q, {
    select: () => q,
    eq: () => q,
    is: () => q,
    gt: () => q,
    insert: () => { s.ops.push(`insert:${table}`); return q; },
    update: () => { s.ops.push(`update:${table}`); return q; },
    single: async () => ({ data: { id: 'row-1' }, error: null }),
    maybeSingle: async () => {
      if (table === 'memberships') return { data: { role: 'owner', status: 'active' }, error: null };
      if (table === 'tenants') return { data: { name: 'Firma' }, error: null };
      if (table === 'accountant_access') return { data: { tenant_id: '11111111-1111-4111-8111-111111111111' }, error: null };
      return { data: null, error: null };
    },
    then: (ok: (value: unknown) => unknown) => Promise.resolve(
      table === 'accountant_access' ? { data: [{ id: 'acc-1' }], error: null } : { data: [], count: 0, error: null },
    ).then(ok),
  });
  return q;
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      getSession: async () => ({ data: { session: { access_token: 'signed-token' } }, error: null }),
      getUser: async () => ({ data: { user: { id: '33333333-3333-4333-8333-333333333333', email: 'owner@example.test', factors: s.factors } }, error: null }),
      getClaims: s.getClaims,
    },
    from: query,
    rpc: async (name: string) => { s.ops.push(`rpc:${name}`); return { data: null, error: null }; },
  }),
  createAdminClient: () => ({ from: query }),
}));

import { approveJoinRequestAction, changeMembershipRoleAction, inviteMemberAction } from '@/app/actions/organizations';
import { createAccountantTokenAction, revokeAccountantTokenAction } from '@/components/settings/accountant-actions';

/** Znacznik liczony niezależnie od kodu aplikacji (jak w `panel-mfa.test.ts`). */
function marker(): string {
  const expiry = String(Math.floor(Date.now() / 1000) + 3600);
  const key = Buffer.from(hkdfSync('sha256', SERVICE_ROLE, Buffer.alloc(0), 'faktway/passkey-session-marker/v1', 32));
  const mac = createHmac('sha256', key).update(['v1', USER, SESSION, expiry].join('\n')).digest('base64url');
  return ['v1', expiry, mac].join('.');
}

const claimsFor = () => ({ data: { claims: { sub: USER, aal: s.aal, session_id: SESSION } }, error: null });

/** Sesja z logowania biometrią: AAL1, konto z TOTP, znacznik tej sesji. */
function passkeySession() {
  s.aal = 'aal1';
  s.factors = TOTP;
  s.marker = marker();
}

beforeEach(() => {
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', SERVICE_ROLE);
  s.aal = 'aal1';
  s.factors = [];
  s.marker = undefined;
  s.ops = [];
  s.emails = [];
  s.audit.mockReset();
  s.getClaims.mockReset();
  s.getClaims.mockImplementation(async () => claimsFor());
});
afterEach(() => vi.unstubAllEnvs());

const GRANTS = [
  ['zaproszenie do firmy', () => inviteMemberAction({ email: 'nowy@example.test', role: 'admin' }), 'insert:organization_invitations'],
  ['przyjęcie prośby o dostęp', () => approveJoinRequestAction(REQUEST, 'member'), 'rpc:approve_join_request'],
  ['zmiana roli na właściciela', () => changeMembershipRoleAction({ membershipId: REQUEST, newRole: 'owner' }), 'rpc:change_membership_role'],
  ['link dla księgowej', () => createAccountantTokenAction({ name: 'Anna', email: 'anna@biuro.example', accessLevel: 'download', validForDays: 30 }), 'insert:accountant_access'],
] as const;

describe.each(GRANTS)('%s', (_name, grant, effect) => {
  it('sesja po biometrii: odmowa z przejściem na ekran kodu, bez żadnego skutku', async () => {
    passkeySession();

    const result = await grant();

    expect(result).toMatchObject({ success: false, mfaStepUp: true });
    expect((result as { error: string }).error).toMatch(/kod/i);
    expect(s.ops).toEqual([]);
    expect(s.emails).toEqual([]);
    expect(s.audit).not.toHaveBeenCalled();
  });

  it('sesja po kodzie z aplikacji (AAL2): przechodzi', async () => {
    s.aal = 'aal2';
    s.factors = TOTP;

    await expect(grant()).resolves.toMatchObject({ success: true });
    expect(s.ops).toContain(effect);
  });

  it('konto bez 2FA działa jak dotąd', async () => {
    await expect(grant()).resolves.toMatchObject({ success: true });
    expect(s.ops).toContain(effect);
  });

  it('awaria drugiej kontroli po bramce panelu: odmowa, bez skutku i bez ścieżki kodu', async () => {
    passkeySession();
    s.getClaims
      .mockImplementationOnce(async () => claimsFor())
      .mockImplementationOnce(async () => ({ data: null, error: { message: 'auth niedostępny' } }));

    const result = await grant();

    expect(result).toMatchObject({ success: false });
    expect(result).not.toHaveProperty('mfaStepUp');
    expect(s.ops).toEqual([]);
  });
});

describe('cofanie dostępu księgowej niczego nie nadaje, więc zostaje bez kroku', () => {
  it('sesja po biometrii cofa token', async () => {
    passkeySession();

    const result = await revokeAccountantTokenAction('acc-1');

    expect(result).toEqual({ success: true });
    expect(s.ops).toContain('update:accountant_access');
  });
});

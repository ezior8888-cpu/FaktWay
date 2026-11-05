import { createHmac, hkdfSync } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Adres księgowej i kopie w sesji po biometrii (recenzja #361, pkt 8).
 *
 * `updateAccountantSettingsAction` ustawia dowolny adres i dowolne kopie (CC) dla
 * miesięcznych eksportów JPK i KPiR firmy, a "Wyślij teraz" w formularzu najpierw
 * zapisuje te ustawienia. Biometria otwiera panel, ale ktoś z odblokowanym telefonem
 * właściciela nie może przekierować eksportów na własny adres bez kodu z aplikacji
 * (ten sam krok co przy zaproszeniach i linku dla księgowej,
 * `lib/auth/access-grant-mfa.ts`). Konto bez 2FA działa jak dotąd.
 *
 * Prawdziwa ścieżka: `auth-context`, bramka panelu ze znacznikiem i ścisły
 * `getVerifiedMfaState`. Atrapą są tylko SDK Auth, baza, kolejka i magazyn plików.
 */

const s = vi.hoisted(() => ({
  aal: 'aal1' as 'aal1' | 'aal2',
  factors: [] as Array<{ id: string; factor_type: string; status: string }>,
  marker: undefined as string | undefined,
  role: 'owner' as 'owner' | 'admin' | 'member',
  ops: [] as string[],
  upserts: [] as Array<Record<string, unknown>>,
  events: [] as unknown[],
  getClaims: vi.fn(),
}));

const USER = '33333333-3333-4333-8333-333333333333';
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
vi.mock('@/lib/jobs/enqueue', () => ({
  sendJobEvent: async (event: unknown) => {
    s.events.push(event);
    return { ids: ['event-1'] };
  },
}));
vi.mock('@/lib/storage/r2', () => ({ downloadFromR2: vi.fn() }));

function query(table: string) {
  const q: Record<string, unknown> = {};
  Object.assign(q, {
    select: () => q,
    eq: () => q,
    upsert: (row: Record<string, unknown>) => {
      s.ops.push(`upsert:${table}`);
      s.upserts.push(row);
      return q;
    },
    maybeSingle: async () => {
      if (table === 'memberships') return { data: { role: s.role, status: 'active' }, error: null };
      if (table === 'accountant_settings') {
        return {
          data: { accountant_email: 'anna@biuro.example', accountant_name: 'Anna', co_pilot_enabled: true, preferred_formats: ['jpk_fa'] },
          error: null,
        };
      }
      return { data: null, error: null };
    },
    then: (ok: (value: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(ok),
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
  }),
  createAdminClient: () => ({ from: query }),
}));

import { triggerCoPilotNowAction, updateAccountantSettingsAction } from '@/app/actions/exports';

/** Znacznik liczony niezależnie od kodu aplikacji (jak w `dostep-osob-trzecich-kod.test.ts`). */
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

const SETTINGS = {
  co_pilot_enabled: true,
  accountant_email: 'cudzy-adres@example.test',
  accountant_name: 'Ktoś',
  preferred_formats: ['jpk_fa', 'kpir_excel'],
  send_day_of_month: 5,
  include_issued_invoices: true,
  include_received_invoices: true,
  include_corrections: true,
  cc_emails: ['kopia@example.test'],
};

beforeEach(() => {
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', SERVICE_ROLE);
  s.aal = 'aal1';
  s.factors = [];
  s.marker = undefined;
  s.role = 'owner';
  s.ops = [];
  s.upserts = [];
  s.events = [];
  s.getClaims.mockReset();
  s.getClaims.mockImplementation(async () => claimsFor());
});
afterEach(() => vi.unstubAllEnvs());

describe('updateAccountantSettingsAction: adres księgowej i kopie wymagają kodu z aplikacji', () => {
  it('sesja po biometrii: odmowa z przejściem na ekran kodu, bez zapisu', async () => {
    passkeySession();

    const result = await updateAccountantSettingsAction(SETTINGS);

    expect(result).toMatchObject({ success: false, mfaStepUp: true });
    expect((result as { error: string }).error).toMatch(/kod/i);
    expect(s.ops).toEqual([]);
    expect(s.upserts).toEqual([]);
  });

  it('zmiana samych kopii (CC) też wymaga kodu', async () => {
    passkeySession();

    const result = await updateAccountantSettingsAction({ ...SETTINGS, accountant_email: 'anna@biuro.example', cc_emails: ['obcy@example.test'] });

    expect(result).toMatchObject({ success: false, mfaStepUp: true });
    expect(s.upserts).toEqual([]);
  });

  it('sesja po kodzie z aplikacji (AAL2): zapisuje', async () => {
    s.aal = 'aal2';
    s.factors = TOTP;

    await expect(updateAccountantSettingsAction(SETTINGS)).resolves.toEqual({ success: true });
    expect(s.upserts).toHaveLength(1);
    expect(s.upserts[0]).toMatchObject({ accountant_email: 'cudzy-adres@example.test', cc_emails: ['kopia@example.test'] });
  });

  it('konto bez 2FA działa jak dotąd', async () => {
    await expect(updateAccountantSettingsAction(SETTINGS)).resolves.toEqual({ success: true });
    expect(s.upserts).toHaveLength(1);
  });

  it('awaria drugiej kontroli po bramce panelu: odmowa, bez zapisu i bez ścieżki kodu', async () => {
    passkeySession();
    s.getClaims
      .mockImplementationOnce(async () => claimsFor())
      .mockImplementationOnce(async () => ({ data: null, error: { message: 'auth niedostępny' } }));

    const result = await updateAccountantSettingsAction(SETTINGS);

    expect(result).toMatchObject({ success: false });
    expect(result).not.toHaveProperty('mfaStepUp');
    expect(s.upserts).toEqual([]);
  });

  it('rola i walidacja idą przed krokiem kodu: członek i błędne dane nie dostają ekranu kodu', async () => {
    passkeySession();

    s.role = 'member';
    const member = await updateAccountantSettingsAction(SETTINGS);
    expect(member).toEqual({ success: false, error: 'Niewystarczające uprawnienia' });

    s.role = 'owner';
    const invalid = await updateAccountantSettingsAction({ ...SETTINGS, accountant_email: 'to nie jest adres' });
    expect(invalid).toEqual({ success: false, error: 'Nieprawidłowy email' });
    expect(s.upserts).toEqual([]);
  });
});

describe('triggerCoPilotNowAction nie przyjmuje adresu, więc nie ma własnego kroku kodu', () => {
  it('bierze tylko okres: adres idzie z ustawień zapisanych za kodem', async () => {
    // Gdyby kiedyś przyjęła adres albo kopie, dostaje ten sam krok co zapis ustawień.
    expect(triggerCoPilotNowAction).toHaveLength(2);

    passkeySession();
    await expect(triggerCoPilotNowAction(10, 2026)).resolves.toMatchObject({ success: true });
    expect(s.events).toHaveLength(1);
    expect(s.events[0]).toMatchObject({ data: { accountantEmail: 'anna@biuro.example' } });
  });
});

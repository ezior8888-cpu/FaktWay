import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Plan aplikacji mobilnej, M10b: karty Firma, KSeF i Przypomnienia z
 * prawdziwego konta do odczytu (`GET /api/mobile/v1/ustawienia`).
 *
 * Prawdziwe: trasa, bramka `authenticateMobileRequest`,
 * `lib/api/mobile/ustawienia.ts`, `hasConfiguredKsefProof` (środowisko z
 * `KSEF_ENV`), `reminderSettingsFromRow` (te same wartości co formularz strony).
 * Atrapy: HTTP (GoTrue, PostgREST), Redis.
 */

const SUPABASE_URL = 'https://db.fixture.test';
const OWNER = 'aaaaaaaa-1111-4111-8111-000000000001';
const MEMBER = 'aaaaaaaa-1111-4111-8111-000000000002';
const ORG_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const NOW = new Date('2026-11-14T09:00:00Z');

const fake = vi.hoisted(() => {
  const client = {
    pipeline() {
      const pipe = {
        zremrangebyscore: () => pipe,
        zadd: () => pipe,
        zcard: () => pipe,
        expire: () => pipe,
        exec: async () => [0, 1, 1, 1],
      };
      return pipe;
    },
    zrange: async () => [],
    zrem: async () => 0,
  };
  return { client };
});

vi.mock('@/lib/cache/redis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cache/redis')>();
  return { ...actual, isRedisConfigured: () => true, getRedis: () => fake.client };
});
vi.mock('@/lib/feature-flags/maintenance', () => ({ isMaintenanceMode: async () => false, MAINTENANCE_PATH: '/przerwa-techniczna' }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

import { GET as ustawieniaRoute } from '@/app/api/mobile/v1/ustawienia/route';

const b64url = (value: string) => Buffer.from(value).toString('base64url');
function accessToken(sub: string, n: number): string {
  const now = Math.floor(NOW.getTime() / 1000);
  return [
    b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' })),
    b64url(JSON.stringify({ aud: 'authenticated', role: 'authenticated', iat: now, exp: now + 3600, sub, aal: 'aal1', session_id: `cccccccc-2222-4222-8222-00000000000${n}`, amr: [{ method: 'password', timestamp: now - 60 }] })),
    b64url('fixture-signature'),
  ].join('.');
}
const TOKEN_OWNER = accessToken(OWNER, 1);
const TOKEN_MEMBER = accessToken(MEMBER, 2);
const issued = new Map([[TOKEN_OWNER, OWNER], [TOKEN_MEMBER, MEMBER]]);
const memberships = [
  { user_id: OWNER, organization_id: ORG_A, role: 'owner', status: 'active' },
  { user_id: MEMBER, organization_id: ORG_A, role: 'member', status: 'active' },
];

type Tenant = Record<string, unknown>;
let tenant: Tenant;
let reminderRow: Record<string, unknown> | null;
let reads: Array<{ path: string; select: string | null; org: string | null }> = [];
let failReminders = false;

const eq = (url: URL, column: string) => {
  const value = url.searchParams.get(column);
  return value?.startsWith('eq.') ? decodeURIComponent(value.slice(3)) : null;
};

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.origin !== SUPABASE_URL) throw new Error(`nieoczekiwane wyjście do ${url.origin}`);
  const token = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? null;
  const sub = token ? issued.get(token) : undefined;

  if (url.pathname === '/auth/v1/user') {
    if (!sub) return Response.json({ msg: 'invalid JWT' }, { status: 401 });
    return Response.json({ id: sub, aud: 'authenticated', role: 'authenticated', email: `${sub}@example.test`, factors: [], app_metadata: { provider: 'email', providers: ['email'] } });
  }
  if (!sub) return Response.json({ message: 'JWT invalid' }, { status: 401 });
  const asObject = request.headers.get('accept')?.includes('vnd.pgrst.object');
  const one = (row: unknown) => (row ? Response.json(row) : asObject ? Response.json({ code: 'PGRST116' }, { status: 406 }) : Response.json([]));

  if (url.pathname === '/rest/v1/memberships') {
    const rows = memberships.filter((m) => m.user_id === sub && (eq(url, 'organization_id') === null || m.organization_id === eq(url, 'organization_id')));
    return asObject ? one(rows[0]) : Response.json(rows);
  }
  reads.push({ path: url.pathname, select: url.searchParams.get('select'), org: request.headers.get('x-active-org') });
  if (url.pathname === '/rest/v1/tenants') return one(eq(url, 'id') === ORG_A ? tenant : null);
  if (url.pathname === '/rest/v1/reminder_settings') {
    if (failReminders) return Response.json({ message: 'boom' }, { status: 500 });
    // maybeSingle bez wiersza: PostgREST oddaje pustą listę, supabase-js daje `null`.
    return reminderRow && eq(url, 'tenant_id') === ORG_A ? Response.json(reminderRow) : Response.json(null);
  }
  return Response.json({ message: `nieznana ścieżka ${url.pathname}` }, { status: 404 });
}

let ip = 0;
function req(options: { token?: string; org?: string | null } = {}): Request {
  const headers: Record<string, string> = { 'x-real-ip': `198.51.100.${(ip += 1) % 250}`, authorization: `Bearer ${options.token ?? TOKEN_OWNER}` };
  if (options.org !== null) headers['x-active-org'] = options.org ?? ORG_A;
  return new Request('https://app.example.test/api/mobile/v1/ustawienia', { method: 'GET', headers });
}

const REMINDERS = {
  tenant_id: ORG_A,
  enabled: true,
  stage_1_enabled: true,
  stage_1_days_after_due: 5,
  stage_2_enabled: false,
  stage_2_days_after_due: 10,
  stage_3_enabled: true,
  stage_3_days_after_due: 30,
  send_hour: 23,
  send_on_weekdays_only: false,
  max_reminders_per_invoice: 50,
  sender_name: '  ',
  sender_email: 'stary@example.test',
  reply_to_email: null,
  pause_on_reply: true,
  pause_on_partial_payment: false,
};

beforeEach(() => {
  reads = [];
  failReminders = false;
  reminderRow = null;
  tenant = {
    name: 'Pracownia Testowa',
    nip: '1234567890',
    address_json: { addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa' },
    bank_account: '11 1111 1111 1111 1111 1111 1111',
    business_started_on: '2024-07-01',
    vat_exemption_basis: null,
    vat_cash_method: true,
    has_ksef_credentials: true,
    ksef_certificate_expiry: '2027-10-14T00:00:00+00:00',
    ksef_verified_at: '2026-10-01T10:00:00Z',
    ksef_verified_environment: 'test',
    ksef_credentials_encrypted: 'NIE-WOLNO-TEGO-ODDAC',
  };
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SUPABASE_URL);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-fixture-key');
  vi.stubEnv('KSEF_ENV', 'test');
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('GET /api/mobile/v1/ustawienia', () => {
  it('firma i KSeF jak na stronie; zaszyfrowany certyfikat nie wychodzi', async () => {
    const response = await ustawieniaRoute(req());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.firma).toEqual({
      nazwa: 'Pracownia Testowa',
      nip: '1234567890',
      adres: { linia1: 'ul. Testowa 1', linia2: '00-001 Warszawa' },
      rachunek: '11 1111 1111 1111 1111 1111 1111',
      rozpoczecie: '2024-07-01',
      zwolnienie: null,
      zwolnieniePodmiotowe: false,
      metodaKasowa: true,
    });
    expect(body.ksef).toEqual({ stan: 'polaczono', certyfikatDo: '2027-10-14' });
    expect(JSON.stringify(body)).not.toContain('NIE-WOLNO');
    const tenantRead = reads.find((r) => r.path === '/rest/v1/tenants');
    expect(tenantRead?.select).not.toContain('ksef_credentials_encrypted');
    expect(tenantRead?.org).toBe(ORG_A);
  });

  it('certyfikat potwierdzony w innym środowisku niż aplikacja: „do potwierdzenia”, bez daty (jak plakietka strony)', async () => {
    tenant.ksef_verified_environment = 'production';
    const body = await (await ustawieniaRoute(req())).json();
    expect(body.ksef).toEqual({ stan: 'do_potwierdzenia', certyfikatDo: null });

    tenant.has_ksef_credentials = false;
    const bez = await (await ustawieniaRoute(req())).json();
    expect(bez.ksef).toEqual({ stan: 'brak', certyfikatDo: null });
  });

  it('nieustawione KSEF_ENV: nigdy „połączono”', async () => {
    vi.stubEnv('KSEF_ENV', '');
    const body = await (await ustawieniaRoute(req())).json();
    expect(body.ksef.stan).toBe('do_potwierdzenia');
  });

  it('zwolnienie z art. 113 to zwolnienie podmiotowe; art. 43 nie', async () => {
    tenant.vat_exemption_basis = 'art. 113 ust. 1 ustawy o VAT';
    expect((await (await ustawieniaRoute(req())).json()).firma).toMatchObject({ zwolnienie: 'art. 113 ust. 1 ustawy o VAT', zwolnieniePodmiotowe: true });
    tenant.vat_exemption_basis = 'art. 43 ust. 1 pkt 37 ustawy o VAT';
    expect((await (await ustawieniaRoute(req())).json()).firma).toMatchObject({ zwolnieniePodmiotowe: false });
  });

  it('właściciel bez zapisanych przypomnień: nie zapisane i wyłączone (scheduler bez wiersza nic nie przygotowuje), nadawca z nazwy firmy', async () => {
    const body = await (await ustawieniaRoute(req())).json();
    expect(body.przypomnienia).toMatchObject({ zapisane: false, wlaczone: false, nadawca: 'Pracownia Testowa', godzina: 9, najwiecej: 3 });
    expect(body.przypomnienia.etapy).toEqual([
      { etap: 1, wlaczony: true, dniPoTerminie: 3 },
      { etap: 2, wlaczony: true, dniPoTerminie: 7 },
      { etap: 3, wlaczony: true, dniPoTerminie: 14 },
    ]);
  });

  it('zapisane przypomnienia z granicami formularza strony i Reply-To z dawnego pola nadawcy', async () => {
    reminderRow = REMINDERS;
    const body = await (await ustawieniaRoute(req())).json();
    expect(body.przypomnienia).toEqual({
      zapisane: true,
      wlaczone: true,
      etapy: [
        { etap: 1, wlaczony: true, dniPoTerminie: 5 },
        { etap: 2, wlaczony: false, dniPoTerminie: 10 },
        { etap: 3, wlaczony: true, dniPoTerminie: 30 },
      ],
      godzina: 18,
      tylkoDniRobocze: false,
      najwiecej: 20,
      nadawca: 'Pracownia Testowa',
      odpowiedzNa: 'stary@example.test',
      wstrzymajPoOdpowiedzi: true,
      wstrzymajPoCzesciowej: false,
    });
  });

  it('członek zespołu: firma i KSeF bez przypomnień (zakładka strony tylko dla właściciela), bez odczytu tabeli', async () => {
    reminderRow = REMINDERS;
    const body = await (await ustawieniaRoute(req({ token: TOKEN_MEMBER }))).json();
    expect(body.przypomnienia).toBeNull();
    expect(reads.some((r) => r.path === '/rest/v1/reminder_settings')).toBe(false);
  });

  it('błąd odczytu przypomnień: 503, nie „wyłączone”', async () => {
    failReminders = true;
    const response = await ustawieniaRoute(req());
    expect(response.status).toBe(503);
  });

  it('bez firmy w nagłówku: 400', async () => {
    const response = await ustawieniaRoute(req({ org: null }));
    expect(response.status).toBe(400);
  });
});

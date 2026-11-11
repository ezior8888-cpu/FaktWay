import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import { fakeSupabase, memoryDb, type MemoryDb } from '../helpers/fake-supabase-memory';
import { SoftAuthenticator } from '../helpers/soft-webauthn';

/**
 * Logowanie biometrią na prawdziwej ścieżce: końcówki i `@simplewebauthn/server`
 * są prawdziwe, atrapą są tylko baza (w pamięci) i GoTrue. Jednorazowość
 * wyzwania i RLS na prawdziwym Postgresie sprawdza `tests/rls-passkeys.test.ts`,
 * przeglądarkę `e2e/tests/09-biometria.spec.ts`.
 */

const h = vi.hoisted(() => ({
  createClient: vi.fn(), createAdminClient: vi.fn(), cookies: vi.fn(), headers: vi.fn(),
  audit: vi.fn(), track: vi.fn(),
  getUserById: vi.fn(), generateLink: vi.fn(),
  verifyOtp: vi.fn(), getClaims: vi.fn(), signOut: vi.fn(), sendJob: vi.fn(),
}));
vi.mock('@/lib/jobs/enqueue', () => ({ sendJobEvent: h.sendJob }));
vi.mock('next/headers', () => ({ cookies: h.cookies, headers: h.headers }));
vi.mock('@/lib/supabase/server', () => ({ createClient: h.createClient, createAdminClient: h.createAdminClient }));
vi.mock('@/lib/audit/log', () => ({ logAudit: h.audit }));
vi.mock('@/lib/analytics/server', () => ({ trackServer: h.track }));

import { POST as loginOptions } from '@/app/api/auth/passkey/login/options/route';
import { POST as loginVerify } from '@/app/api/auth/passkey/login/verify/route';
import { verifyPasskeySessionMarker } from '@/lib/auth/passkey/session-marker';

const ORIGIN = 'https://faktway.pl';
const RP_ID = 'faktway.pl';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const EMAIL = 'wlasciciel@example.test';
const GENERIC_FAILURE = { error: 'passkey_login_failed' };

let db: MemoryDb;
let authenticator: SoftAuthenticator;
let cookieWrites: Map<string, { value: string; options: Record<string, unknown> }>;
let ip: string;

function postRequest(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(ORIGIN + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function issueChallenge(headers: Record<string, string> = {}): Promise<string> {
  const response = await loginOptions(postRequest('/api/auth/passkey/login/options', {}, headers));
  expect(response.status).toBe(200);
  const { options } = await response.json();
  return options.challenge;
}

function seedPasskey(overrides: Record<string, unknown> = {}) {
  db.tables.user_passkeys!.push({
    id: 'passkey-1', user_id: USER_ID, credential_id: authenticator.id, public_key: authenticator.publicKey,
    counter: 0, transports: ['internal'], device_label: 'iPhone', backed_up: true,
    created_at: '2026-10-01T00:00:00.000Z', last_used_at: null, ...overrides,
  });
}

async function verify(body: unknown, headers: Record<string, string> = {}) {
  const response = await loginVerify(postRequest('/api/auth/passkey/login/verify', body, headers));
  return { response, json: await response.json() };
}

function expectNoSession() {
  expect(h.generateLink).not.toHaveBeenCalled();
  expect(h.verifyOtp).not.toHaveBeenCalled();
  expect(cookieWrites.has('ksef.passkey_session')).toBe(false);
  expect(cookieWrites.has('ksef.remember_me')).toBe(false);
}

let ipCounter = 0;

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('NEXT_PUBLIC_APP_URL', ORIGIN);
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'fixture-service-role-key-do-testow');
  db = memoryDb({ user_passkeys: [], webauthn_challenges: [], users: [{ id: USER_ID, last_active_tenant_id: 'tenant-1' }] });
  authenticator = new SoftAuthenticator({ rpId: RP_ID, origin: ORIGIN });
  cookieWrites = new Map();
  // Osobne IP na test: limit w pamięci procesu nie ma przeciekać między przypadkami.
  // Licznik, nie losowanie: test limitu wyczerpuje okno swojego adresu, a trafienie
  // w ten sam adres później dawało przypadkowe 429 (raz na kilka przebiegów CI).
  ip = `203.0.113.${++ipCounter}`;
  h.headers.mockImplementation(async () => new Headers({ 'x-real-ip': ip, 'user-agent': 'Vitest' }));
  h.cookies.mockImplementation(async () => ({
    get: (name: string) => cookieWrites.has(name) ? { value: cookieWrites.get(name)!.value } : undefined,
    set: (name: string, value: string, options: Record<string, unknown>) => {
      cookieWrites.set(name, { value, options });
    },
  }));
  h.createAdminClient.mockImplementation(() => ({
    ...fakeSupabase(db),
    auth: { admin: { getUserById: h.getUserById, generateLink: h.generateLink } },
  }));
  h.createClient.mockImplementation(async () => ({
    ...fakeSupabase(db),
    auth: { verifyOtp: h.verifyOtp, getClaims: h.getClaims, signOut: h.signOut },
  }));
  h.getUserById.mockResolvedValue({ data: { user: { id: USER_ID, email: EMAIL, email_confirmed_at: '2026-01-01T00:00:00Z' } }, error: null });
  h.generateLink.mockResolvedValue({
    data: { user: { id: USER_ID }, properties: { hashed_token: 'hashed-token-fixture', verification_type: 'magiclink' } },
    error: null,
  });
  h.verifyOtp.mockResolvedValue({
    data: { user: { id: USER_ID }, session: { access_token: 'signed-token' } },
    error: null,
  });
  h.getClaims.mockResolvedValue({ data: { claims: { sub: USER_ID, aal: 'aal1', session_id: SESSION_ID } }, error: null });
  h.signOut.mockResolvedValue({ error: null });
});
afterEach(() => vi.unstubAllEnvs());

describe('POST /api/auth/passkey/login/options', () => {
  it('wydaje wyzwanie dla poświadczeń wykrywalnych z wymaganą weryfikacją użytkownika', async () => {
    const response = await loginOptions(postRequest('/api/auth/passkey/login/options', {}));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const { options } = await response.json();
    expect(options).toMatchObject({ rpId: RP_ID, userVerification: 'required' });
    expect(options.allowCredentials ?? []).toEqual([]);
    expect(db.tables.webauthn_challenges).toEqual([
      expect.objectContaining({ challenge: options.challenge, purpose: 'login', user_id: null }),
    ]);
  });

  it('sprząta wygasłe wyzwania przy tworzeniu nowego', async () => {
    db.tables.webauthn_challenges!.push(
      { id: 'stare', challenge: 'stare', purpose: 'login', user_id: null, expires_at: '2020-01-01T00:00:00.000Z' },
      { id: 'zywe', challenge: 'zywe', purpose: 'login', user_id: null, expires_at: '2999-01-01T00:00:00.000Z' },
    );
    await issueChallenge();
    const left = db.tables.webauthn_challenges!.map((row) => row.challenge);
    expect(left).not.toContain('stare');
    expect(left).toContain('zywe');
    expect(left).toHaveLength(2);
  });

  it('odmawia obcemu Origin, zanim dotknie bazy', async () => {
    const response = await loginOptions(postRequest('/api/auth/passkey/login/options', {}, { origin: 'https://zly.example' }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'origin_not_allowed' });
    expect(db.touched).toEqual([]);
  });

  it('przepuszcza klienta bez nagłówka Origin (aplikacja natywna): asercję i tak sprawdza WebAuthn', async () => {
    const request = new Request(ORIGIN + '/api/auth/passkey/login/options', { method: 'POST', body: '{}' });
    expect((await loginOptions(request)).status).toBe(200);
  });

  it('po przekroczeniu limitu zwraca 429 z czasem ponowienia', async () => {
    let last: Response | null = null;
    for (let attempt = 0; attempt < 70; attempt += 1) {
      last = await loginOptions(postRequest('/api/auth/passkey/login/options', {}));
      if (last.status === 429) break;
    }
    expect(last?.status).toBe(429);
    expect(Number(last?.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await last?.json()).toEqual({ error: 'rate_limited' });
  });

  it('bez poprawnego adresu aplikacji odmawia zamiast zgadywać RP ID z nagłówków', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://evil.example');
    const response = await loginOptions(postRequest('/api/auth/passkey/login/options', {}, { host: 'evil.example' }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'passkey_unavailable' });
  });
});

describe('POST /api/auth/passkey/login/verify', () => {
  it('poprawna asercja: sesja z GoTrue bez maila, znacznik, „zapamiętane”, audyt i analityka', async () => {
    seedPasskey();
    const challenge = await issueChallenge();
    const { response, json } = await verify({ response: authenticator.assert(challenge), redirectTo: '/invoices?x=1' });

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(json).toEqual({ ok: true, redirectTo: '/invoices?x=1' });

    // Sesja: generateLink bez wysyłki + verifyOtp klientem serwerowym, który ustawia ciasteczka.
    expect(h.generateLink).toHaveBeenCalledExactlyOnceWith({ type: 'magiclink', email: EMAIL });
    expect(h.verifyOtp).toHaveBeenCalledExactlyOnceWith({ token_hash: 'hashed-token-fixture', type: 'magiclink' });

    const marker = cookieWrites.get('ksef.passkey_session');
    expect(marker?.options).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/' });
    await expect(verifyPasskeySessionMarker(marker!.value, { sub: USER_ID, sessionId: SESSION_ID })).resolves.toBe(true);
    await expect(verifyPasskeySessionMarker(marker!.value, { sub: USER_ID, sessionId: 'inna-sesja' })).resolves.toBe(false);

    // Logowanie passkey liczy się jak „zapamiętaj mnie”.
    expect(cookieWrites.get('ksef.remember_me')?.options).toMatchObject({ httpOnly: true, maxAge: 90 * 24 * 60 * 60 });

    // Krok 8.5: identyfikator sesji ze zweryfikowanych claimów łączy wpis z listą urządzeń (00174).
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'auth.login', userId: USER_ID, tenantId: 'tenant-1',
      metadata: { method: 'passkey', passkey_id: 'passkey-1', session_id: SESSION_ID },
    }));
    expect(h.track).toHaveBeenCalledWith(expect.objectContaining({
      userId: USER_ID, event: 'login_completed', properties: { method: 'passkey' },
    }));
    // Krok 8.5, część 2: sprawdzenie nowego urządzenia z kluczem równym sesji.
    expect(h.sendJob).toHaveBeenCalledExactlyOnceWith({
      name: 'auth/login.completed',
      data: { userId: USER_ID, sessionId: SESSION_ID },
      singletonKey: `new-login/${SESSION_ID}`,
    });

    // Licznik i ostatnie użycie.
    expect(db.tables.user_passkeys![0]).toMatchObject({ counter: 1, backed_up: true });
    expect(db.tables.user_passkeys![0]!.last_used_at).toEqual(expect.any(String));
    // Wyzwanie zużyte.
    expect(db.tables.webauthn_challenges).toEqual([]);
  });

  it('cudzy adres powrotu sprowadza do pulpitu', async () => {
    seedPasskey();
    const challenge = await issueChallenge();
    const { json } = await verify({ response: authenticator.assert(challenge), redirectTo: 'https://zly.example/' });
    expect(json).toEqual({ ok: true, redirectTo: '/dashboard' });
  });

  it('adres www jest dozwolony, bo RP ID to domena główna', async () => {
    seedPasskey();
    authenticator.origin = 'https://www.faktway.pl';
    const challenge = await issueChallenge({ origin: 'https://www.faktway.pl' });
    const { response } = await verify({ response: authenticator.assert(challenge) }, { origin: 'https://www.faktway.pl' });
    expect(response.status).toBe(200);
  });

  it('ta sama asercja drugi raz nie przechodzi: wyzwanie jest jednorazowe', async () => {
    seedPasskey();
    const challenge = await issueChallenge();
    const assertion = authenticator.assert(challenge);
    expect((await verify({ response: assertion })).response.status).toBe(200);
    vi.mocked(h.generateLink).mockClear();
    vi.mocked(h.verifyOtp).mockClear();
    cookieWrites.clear();

    const { response, json } = await verify({ response: assertion });
    expect(response.status).toBe(401);
    expect(json).toEqual(GENERIC_FAILURE);
    expectNoSession();
  });

  it('nieznane poświadczenie dostaje tę samą odpowiedź co każde inne niepowodzenie', async () => {
    const challenge = await issueChallenge();
    const { response, json } = await verify({ response: authenticator.assert(challenge) });
    expect(response.status).toBe(401);
    expect(json).toEqual(GENERIC_FAILURE);
    expectNoSession();
    // Nieudana próba też zużywa wyzwanie.
    expect(db.tables.webauthn_challenges).toEqual([]);
  });

  it('nieznane wyzwanie i wyzwanie po terminie: ta sama odpowiedź', async () => {
    seedPasskey();
    const unknown = await verify({ response: authenticator.assert('bm8tc3VjaC1jaGFsbGVuZ2U') });
    expect(unknown.response.status).toBe(401);
    expect(unknown.json).toEqual(GENERIC_FAILURE);

    const challenge = await issueChallenge();
    db.tables.webauthn_challenges![0]!.expires_at = '2020-01-01T00:00:00.000Z';
    const expired = await verify({ response: authenticator.assert(challenge) });
    expect(expired.response.status).toBe(401);
    expect(expired.json).toEqual(GENERIC_FAILURE);
    expectNoSession();
  });

  it('wyzwanie rejestracji nie loguje', async () => {
    seedPasskey();
    db.tables.webauthn_challenges!.push({
      id: 'rejestracja', challenge: 'cmVqZXN0cmFjamE', purpose: 'registration', user_id: USER_ID, expires_at: '2999-01-01T00:00:00.000Z',
    });
    const { response } = await verify({ response: authenticator.assert('cmVqZXN0cmFjamE') });
    expect(response.status).toBe(401);
    expectNoSession();
    expect(db.tables.webauthn_challenges).toHaveLength(1);
  });

  it('asercja bez weryfikacji użytkownika (brak biometrii) nie przechodzi', async () => {
    seedPasskey();
    authenticator.userVerified = false;
    const challenge = await issueChallenge();
    const { response, json } = await verify({ response: authenticator.assert(challenge) });
    expect(response.status).toBe(401);
    expect(json).toEqual(GENERIC_FAILURE);
    expectNoSession();
  });

  it('userHandle innego konta nie przechodzi, a właściciela tak (WebAuthn § 7.2, poświadczenie wykrywalne)', async () => {
    seedPasskey();
    const foreign = await issueChallenge();
    const foreignAssertion = authenticator.assert(foreign);
    const refused = await verify({
      response: {
        ...foreignAssertion,
        response: { ...foreignAssertion.response, userHandle: Buffer.from('inne-konto').toString('base64url') },
      },
    });
    expect(refused.response.status).toBe(401);
    expect(refused.json).toEqual(GENERIC_FAILURE);
    expectNoSession();

    const own = await issueChallenge();
    const ownAssertion = authenticator.assert(own);
    const accepted = await verify({
      response: { ...ownAssertion, response: { ...ownAssertion.response, userHandle: Buffer.from(USER_ID).toString('base64url') } },
    });
    expect(accepted.response.status).toBe(200);
  });

  it('podmieniony podpis nie przechodzi', async () => {
    seedPasskey();
    const challenge = await issueChallenge();
    const assertion = authenticator.assert(challenge);
    const other = new SoftAuthenticator({ rpId: RP_ID, origin: ORIGIN });
    assertion.response.signature = other.assert(challenge, { keepCounter: true }).response.signature;
    const { response, json } = await verify({ response: assertion });
    expect(response.status).toBe(401);
    expect(json).toEqual(GENERIC_FAILURE);
    expectNoSession();
  });

  it.each([
    ['inny origin w clientDataJSON', () => { authenticator.origin = 'https://faktway.pl.evil.example'; }],
    ['inne RP ID', () => { authenticator.rpId = 'evil.example'; }],
  ])('%s nie przechodzi', async (_name, tamper) => {
    seedPasskey();
    const challenge = await issueChallenge();
    tamper();
    const { response } = await verify({ response: authenticator.assert(challenge) });
    expect(response.status).toBe(401);
    expectNoSession();
  });

  it('licznik, który się cofa (możliwy klon), nie przechodzi i nie zmienia wiersza', async () => {
    seedPasskey({ counter: 5 });
    authenticator.counter = 2;
    const challenge = await issueChallenge();
    const { response } = await verify({ response: authenticator.assert(challenge) });
    expect(response.status).toBe(401);
    expectNoSession();
    expect(db.tables.user_passkeys![0]).toMatchObject({ counter: 5, last_used_at: null });
  });

  it('licznik aktualizujemy warunkowo: równoległa zmiana odbiera logowanie', async () => {
    seedPasskey();
    const challenge = await issueChallenge();
    const assertion = authenticator.assert(challenge);
    // Druga asercja wygrała wyścig między odczytem a zapisem.
    const client = h.createAdminClient();
    const realFrom = client.from;
    h.createAdminClient.mockImplementation(() => ({
      ...client,
      from(name: string) {
        const query = realFrom(name);
        if (name !== 'user_passkeys') return query;
        const realUpdate = query.update;
        return { ...query, update: (payload: Record<string, unknown>) => {
          // Nowy obiekt: atrapa oddaje wiersze przez referencję, a końcówka czyta z nich starą wartość.
          db.tables.user_passkeys![0] = { ...db.tables.user_passkeys![0], counter: 9 };
          return realUpdate(payload);
        } };
      },
    }));
    const { response } = await verify({ response: assertion });
    expect(response.status).toBe(401);
    expectNoSession();
  });

  it('konto zablokowane nie wchodzi', async () => {
    seedPasskey();
    h.getUserById.mockResolvedValue({ data: { user: {
      id: USER_ID, email: EMAIL, email_confirmed_at: '2026-01-01T00:00:00Z',
      banned_until: new Date(Date.now() + 3_600_000).toISOString(),
    } }, error: null });
    const challenge = await issueChallenge();
    const { response, json } = await verify({ response: authenticator.assert(challenge) });
    expect(response.status).toBe(401);
    expect(json).toEqual(GENERIC_FAILURE);
    expectNoSession();
  });

  it('blokada po terminie już nie zatrzymuje', async () => {
    seedPasskey();
    h.getUserById.mockResolvedValue({ data: { user: {
      id: USER_ID, email: EMAIL, email_confirmed_at: '2026-01-01T00:00:00Z',
      banned_until: '2020-01-01T00:00:00.000Z',
    } }, error: null });
    const challenge = await issueChallenge();
    expect((await verify({ response: authenticator.assert(challenge) })).response.status).toBe(200);
  });

  it.each([
    ['bez potwierdzonego adresu e-mail', { id: USER_ID, email: EMAIL, email_confirmed_at: null }],
    ['bez adresu e-mail', { id: USER_ID, email: null, email_confirmed_at: '2026-01-01T00:00:00Z' }],
    ['usunięte', { id: USER_ID, email: EMAIL, email_confirmed_at: '2026-01-01T00:00:00Z', deleted_at: '2026-10-01T00:00:00Z' }],
  ])('konto %s nie wchodzi', async (_name, user) => {
    seedPasskey();
    h.getUserById.mockResolvedValue({ data: { user }, error: null });
    const challenge = await issueChallenge();
    const { response } = await verify({ response: authenticator.assert(challenge) });
    expect(response.status).toBe(401);
    expectNoSession();
  });

  it('awaria generateLink: 503 bez ciasteczek', async () => {
    seedPasskey();
    h.generateLink.mockResolvedValue({ data: { user: null, properties: null }, error: { message: 'wewnętrzny szczegół' } });
    const challenge = await issueChallenge();
    const { response, json } = await verify({ response: authenticator.assert(challenge) });
    expect(response.status).toBe(503);
    expect(json).toEqual({ error: 'session_unavailable' });
    expect(JSON.stringify(json)).not.toContain('wewnętrzny');
    expect(cookieWrites.has('ksef.passkey_session')).toBe(false);
  });

  it('GoTrue odmawia sesji zablokowanemu kontu: ta sama odpowiedź co przy naszej blokadzie', async () => {
    seedPasskey();
    h.verifyOtp.mockResolvedValue({ data: { user: null, session: null }, error: { code: 'user_banned', status: 403, message: 'User is banned' } });
    const challenge = await issueChallenge();
    const { response, json } = await verify({ response: authenticator.assert(challenge) });
    expect(response.status).toBe(401);
    expect(json).toEqual(GENERIC_FAILURE);
    expect(cookieWrites.has('ksef.passkey_session')).toBe(false);
  });

  it('limit GoTrue na /verify: 503 z prośbą o ponowienie, bez ciasteczek', async () => {
    seedPasskey();
    h.verifyOtp.mockResolvedValue({ data: { user: null, session: null }, error: { code: 'over_request_rate_limit', status: 429, message: 'limit' } });
    const challenge = await issueChallenge();
    const { response, json } = await verify({ response: authenticator.assert(challenge) });
    expect(response.status).toBe(503);
    expect(json).toEqual({ error: 'session_unavailable' });
  });

  it('link wystawiony na inne konto niż właściciel poświadczenia: bez sesji', async () => {
    seedPasskey();
    h.generateLink.mockResolvedValue({
      data: { user: { id: 'inne-konto' }, properties: { hashed_token: 'x', verification_type: 'magiclink' } }, error: null,
    });
    const challenge = await issueChallenge();
    const { response } = await verify({ response: authenticator.assert(challenge) });
    expect(response.status).toBe(503);
    expect(h.verifyOtp).not.toHaveBeenCalled();
  });

  it('sesja innego konta z verifyOtp: wylogowanie lokalne i bez znacznika', async () => {
    seedPasskey();
    h.verifyOtp.mockResolvedValue({ data: { user: { id: 'inne-konto' }, session: { access_token: 'x' } }, error: null });
    const challenge = await issueChallenge();
    const { response } = await verify({ response: authenticator.assert(challenge) });
    expect(response.status).toBe(503);
    expect(h.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(cookieWrites.has('ksef.passkey_session')).toBe(false);
  });

  it('token bez session_id: wylogowanie lokalne zamiast znacznika bez sesji', async () => {
    seedPasskey();
    h.getClaims.mockResolvedValue({ data: { claims: { sub: USER_ID, aal: 'aal1' } }, error: null });
    const challenge = await issueChallenge();
    const { response } = await verify({ response: authenticator.assert(challenge) });
    expect(response.status).toBe(503);
    expect(h.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(cookieWrites.has('ksef.passkey_session')).toBe(false);
  });

  it.each([
    ['niepoprawny JSON', '{nie-json'],
    ['brak odpowiedzi', {}],
    ['zły typ poświadczenia', { response: { id: 'a', rawId: 'a', type: 'password', response: {} } }],
    ['ogromne pole', { response: { id: 'a'.repeat(100_000), rawId: 'a', type: 'public-key', response: {} } }],
  ])('%s: 400 bez dotykania wyzwań', async (_name, body) => {
    const { response, json } = await verify(body);
    expect(response.status).toBe(400);
    expect(json).toEqual({ error: 'invalid_request' });
    expect(db.touched).not.toContain('webauthn_challenges');
  });

  it('ciało ponad limit bez Content-Length (chunked): 400, strumień przerwany', async () => {
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(32 * 1024));
      },
    });
    const request = new Request(ORIGIN + '/api/auth/passkey/login/verify', {
      method: 'POST', headers: { origin: ORIGIN }, body: endless, duplex: 'half',
    } as RequestInit);
    const response = await loginVerify(request);
    expect(response.status).toBe(400);
    expect(pulled).toBeLessThan(10);
    expect(db.touched).not.toContain('webauthn_challenges');
  });

  it('obcy Origin: 403 przed bazą', async () => {
    const { response, json } = await verify({ response: authenticator.assert('abc') }, { origin: 'https://zly.example' });
    expect(response.status).toBe(403);
    expect(json).toEqual({ error: 'origin_not_allowed' });
    expect(db.touched).toEqual([]);
  });

  it('limit prób: 429 po serii nieudanych asercji', async () => {
    let status = 0;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      status = (await verify({ response: authenticator.assert('bm8tc3VjaC1jaGFsbGVuZ2U') })).response.status;
      if (status === 429) break;
    }
    expect(status).toBe(429);
  });
});

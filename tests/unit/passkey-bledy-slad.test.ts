import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { fakeSupabase, memoryDb, type MemoryDb } from '../helpers/fake-supabase-memory';
import { SoftAuthenticator } from '../helpers/soft-webauthn';

/**
 * Recenzja #359, pkt 3: błędy weryfikacji biometrii zostawiały po sobie pusty log
 * (`catch { return FAILED }`, rzucone wyjątki widoczne tylko jako stały napis w trasie),
 * więc zła konfiguracja RP ID po zmianie domeny wyglądała jak „użytkownicy mylą palec”.
 *
 * Wyjątek biblioteki i błąd po naszej stronie zostawiają `console.error` z etapem
 * i nazwą klasy błędu, bez treści asercji, kluczy i e-maila. Odpowiedź dla klienta
 * się nie zmienia, a zwykła odmowa (nieznany klucz, stare wyzwanie, zablokowane konto)
 * nie jest błędem i nie trafia do logu błędów.
 */

const h = vi.hoisted(() => ({
  createClient: vi.fn(), createAdminClient: vi.fn(), cookies: vi.fn(), headers: vi.fn(),
  audit: vi.fn(), track: vi.fn(),
  getUserById: vi.fn(), generateLink: vi.fn(), verifyOtp: vi.fn(), getClaims: vi.fn(), signOut: vi.fn(),
  verifyAuth: vi.fn(), verifyReg: vi.fn(),
}));
vi.mock('next/headers', () => ({ cookies: h.cookies, headers: h.headers }));
vi.mock('@/lib/supabase/server', () => ({ createClient: h.createClient, createAdminClient: h.createAdminClient }));
vi.mock('@/lib/audit/log', () => ({ logAudit: h.audit }));
vi.mock('@/lib/analytics/server', () => ({ trackServer: h.track }));
vi.mock('@simplewebauthn/server', async (original) => ({
  ...(await original<typeof import('@simplewebauthn/server')>()),
  verifyAuthenticationResponse: h.verifyAuth,
  verifyRegistrationResponse: h.verifyReg,
}));

import { POST as loginOptions } from '@/app/api/auth/passkey/login/options/route';
import { POST as loginVerify } from '@/app/api/auth/passkey/login/verify/route';
import { getPasskeyConfig } from '@/lib/auth/passkey/config';
import { beginPasskeyRegistration, finishPasskeyRegistration } from '@/lib/auth/passkey/registration';

const ORIGIN = 'https://faktway.pl';
const RP_ID = 'faktway.pl';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const EMAIL = 'wlasciciel@example.test';
const SECRET_MESSAGE = 'SEKRET-z-wyjatku: origin https://zly.example i dane asercji';
const DB_SECRET = 'SEKRET-z-bazy: duplicate key value';
const GENERIC_FAILURE = { error: 'passkey_login_failed' };
const REGISTRATION_CHALLENGE = 'cmVqZXN0cmFjamEtd3lhem5hbmll';

class VerifyBoom extends Error {
  override name = 'VerifyBoom';
}

let db: MemoryDb;
let authenticator: SoftAuthenticator;
let log: MockInstance<typeof console.error>;
let ipCounter = 0;

function postRequest(path: string, body: unknown) {
  return new Request(ORIGIN + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify(body),
  });
}

async function issueChallenge(): Promise<string> {
  const response = await loginOptions(postRequest('/api/auth/passkey/login/options', {}));
  return (await response.json()).options.challenge;
}

function seedPasskey() {
  db.tables.user_passkeys!.push({
    id: 'passkey-1', user_id: USER_ID, credential_id: authenticator.id, public_key: authenticator.publicKey,
    counter: 0, transports: ['internal'], device_label: 'iPhone', backed_up: true,
    created_at: '2026-10-01T00:00:00.000Z', last_used_at: null,
  });
}

/** Seria: znane poświadczenie, żywe wyzwanie, asercja w trasie logowania. */
async function loginAttempt() {
  seedPasskey();
  const challenge = await issueChallenge();
  const response = await loginVerify(postRequest('/api/auth/passkey/login/verify', { response: authenticator.assert(challenge) }));
  return { status: response.status, json: await response.json(), challenge };
}

const verified = { verified: true, authenticationInfo: { newCounter: 1, credentialBackedUp: true } };

/** Wpisy naszego logu (trasa dokłada własny, stały napis bez szczegółów). */
const ours = (flow: 'login' | 'registration') =>
  log.mock.calls.filter(([message]) => message === `[passkey] ${flow}_failed`);

/** Cały zapis do konsoli, jako tekst: tu nie wolno znaleźć żadnych wrażliwych pól. */
function expectNoSensitiveFields(extra: string[] = []) {
  const written = JSON.stringify(log.mock.calls);
  for (const field of [EMAIL, USER_ID, authenticator.id, authenticator.publicKey, SECRET_MESSAGE, DB_SECRET, ...extra]) {
    expect(written).not.toContain(field);
  }
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('NEXT_PUBLIC_APP_URL', ORIGIN);
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'fixture-service-role-key-do-testow');
  log = vi.spyOn(console, 'error').mockImplementation(() => {});
  db = memoryDb({ user_passkeys: [], webauthn_challenges: [], users: [{ id: USER_ID, last_active_tenant_id: 'tenant-1' }] });
  authenticator = new SoftAuthenticator({ rpId: RP_ID, origin: ORIGIN });
  ipCounter += 1;
  h.headers.mockImplementation(async () => new Headers({ 'x-real-ip': `203.0.114.${ipCounter}`, 'user-agent': 'Vitest' }));
  h.cookies.mockImplementation(async () => ({ get: () => undefined, set: () => {} }));
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
  h.verifyOtp.mockResolvedValue({ data: { user: { id: USER_ID }, session: { access_token: 'signed-token' } }, error: null });
  h.getClaims.mockResolvedValue({ data: { claims: { sub: USER_ID, aal: 'aal1', session_id: SESSION_ID } }, error: null });
  h.signOut.mockResolvedValue({ error: null });
  h.verifyAuth.mockResolvedValue(verified);
});
afterEach(() => {
  log.mockRestore();
  vi.unstubAllEnvs();
});

describe('logowanie biometrią: błędy zostawiają ślad', () => {
  it('wyjątek biblioteki: klient dostaje ten sam kod, log ma etap i klasę błędu bez treści', async () => {
    h.verifyAuth.mockRejectedValue(new VerifyBoom(SECRET_MESSAGE));

    const { status, json, challenge } = await loginAttempt();

    expect(status).toBe(401);
    expect(json).toEqual(GENERIC_FAILURE);
    expect(ours('login')).toEqual([['[passkey] login_failed', { stage: 'verify', errorName: 'VerifyBoom' }]]);
    expectNoSensitiveFields([challenge]);
  });

  it('znane poświadczenie, ale weryfikacja odrzucona bez wyjątku: ten sam kod, log z etapem', async () => {
    h.verifyAuth.mockResolvedValue({ verified: false });

    const { status, json } = await loginAttempt();

    expect(status).toBe(401);
    expect(json).toEqual(GENERIC_FAILURE);
    expect(ours('login')).toEqual([['[passkey] login_failed', { stage: 'verify_result', errorName: 'none' }]]);
    expectNoSensitiveFields();
  });

  // Awarie po naszej stronie: baza, GoTrue, brak sesji w tokenie. Klient dostaje 503 jak dotąd,
  // a log niesie etap i nazwę klasy błędu, nigdy jego treść.
  it.each([
    ['challenge', () => { db.failures['webauthn_challenges:delete'] = { code: 'XX000', message: DB_SECRET }; }, 'Error'],
    ['lookup', () => { db.failures['user_passkeys:select'] = { code: 'XX000', message: DB_SECRET }; }, 'Error'],
    ['account', () => h.getUserById.mockResolvedValue({
      data: { user: null }, error: Object.assign(new Error(SECRET_MESSAGE), { name: 'AuthRetryableFetchError', status: 502 }),
    }), 'AuthRetryableFetchError'],
    ['counter', () => { db.failures['user_passkeys:update'] = { code: 'XX000', message: DB_SECRET }; }, 'Error'],
    ['session_link', () => h.generateLink.mockResolvedValue({
      data: { properties: null, user: null }, error: Object.assign(new Error(SECRET_MESSAGE), { name: 'AuthApiError' }),
    }), 'AuthApiError'],
    ['session_verify', () => h.verifyOtp.mockResolvedValue({
      data: { user: null, session: null }, error: Object.assign(new Error(SECRET_MESSAGE), { name: 'AuthApiError', code: 'over_request_rate_limit' }),
    }), 'AuthApiError'],
    ['session_marker', () => h.getClaims.mockResolvedValue({ data: { claims: { sub: USER_ID, aal: 'aal1' } }, error: null }), 'none'],
    // Wyjątek (np. zerwane połączenie z GoTrue) zamiast zwróconego błędu: etap ogólny „session”.
    ['session', () => h.generateLink.mockRejectedValue(new TypeError(SECRET_MESSAGE)), 'TypeError'],
  ])('awaria po naszej stronie, etap %s: 503 jak dotąd, log z etapem i klasą błędu', async (stage, fail, errorName) => {
    fail();

    const { status, json, challenge } = await loginAttempt();

    expect(status).toBe(503);
    expect(json).toEqual({ error: 'session_unavailable' });
    expect(ours('login')).toEqual([['[passkey] login_failed', { stage, errorName }]]);
    expectNoSensitiveFields([challenge]);
  });

  it('userHandle innego konta: ta sama odmowa i ślad z etapem (anomalia, nie pomyłka palca)', async () => {
    seedPasskey();
    const challenge = await issueChallenge();
    const assertion = authenticator.assert(challenge);
    const forged = { ...assertion, response: { ...assertion.response, userHandle: Buffer.from('inne-konto').toString('base64url') } };

    const response = await loginVerify(postRequest('/api/auth/passkey/login/verify', { response: forged }));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual(GENERIC_FAILURE);
    expect(ours('login')).toEqual([['[passkey] login_failed', { stage: 'user_handle', errorName: 'none' }]]);
    expectNoSensitiveFields([challenge]);
  });

  it('nieznany klucz to zwykła odmowa: ta sama odpowiedź i zero wpisów w logu błędów', async () => {
    const challenge = await issueChallenge();

    const response = await loginVerify(postRequest('/api/auth/passkey/login/verify', { response: authenticator.assert(challenge) }));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual(GENERIC_FAILURE);
    expect(log).not.toHaveBeenCalled();
  });

  it('wyzwanie po terminie, konto zablokowane i konto usunięte to zwykłe odmowy bez wpisu w logu błędów', async () => {
    seedPasskey();
    const stale = await issueChallenge();
    db.tables.webauthn_challenges![0]!.expires_at = '2020-01-01T00:00:00.000Z';
    expect((await loginVerify(postRequest('/api/auth/passkey/login/verify', { response: authenticator.assert(stale) }))).status).toBe(401);

    h.getUserById.mockResolvedValue({
      data: { user: { id: USER_ID, email: EMAIL, email_confirmed_at: '2026-01-01T00:00:00Z', banned_until: '2999-01-01T00:00:00Z' } },
      error: null,
    });
    const fresh = await issueChallenge();
    const blocked = await loginVerify(postRequest('/api/auth/passkey/login/verify', { response: authenticator.assert(fresh) }));

    expect(blocked.status).toBe(401);
    expect(await blocked.json()).toEqual(GENERIC_FAILURE);

    // Konto, którego już nie ma (404), to też odmowa, a nie awaria.
    h.getUserById.mockResolvedValue({ data: { user: null }, error: Object.assign(new Error('not found'), { status: 404 }) });
    const gone = await loginVerify(postRequest('/api/auth/passkey/login/verify', { response: authenticator.assert(await issueChallenge()) }));

    expect(gone.status).toBe(401);
    expect(await gone.json()).toEqual(GENERIC_FAILURE);
    expect(log).not.toHaveBeenCalled();
  });
});

describe('rejestracja biometrii: błędy zostawiają ślad', () => {
  const config = () => getPasskeyConfig()!;

  /** Żywe wyzwanie rejestracji tego konta, jak po wywołaniu opcji. */
  function storeRegistrationChallenge() {
    db.tables.webauthn_challenges!.push({
      id: 'challenge-1', challenge: REGISTRATION_CHALLENGE, purpose: 'registration', user_id: USER_ID, expires_at: '2999-01-01T00:00:00.000Z',
    });
  }

  async function register() {
    storeRegistrationChallenge();
    return finishPasskeyRegistration(config(), USER_ID, authenticator.register(REGISTRATION_CHALLENGE), 'iPhone');
  }

  const registered = () => ({
    verified: true,
    registrationInfo: {
      credential: { id: authenticator.id, publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ['internal'] },
      credentialBackedUp: true,
    },
  });

  it('wyjątek biblioteki: ten sam wynik, log z etapem i klasą błędu bez treści', async () => {
    h.verifyReg.mockRejectedValue(new VerifyBoom(SECRET_MESSAGE));

    await expect(register()).resolves.toEqual({ ok: false, reason: 'failed' });

    expect(ours('registration')).toEqual([['[passkey] registration_failed', { stage: 'verify', errorName: 'VerifyBoom' }]]);
    expectNoSensitiveFields([REGISTRATION_CHALLENGE]);
  });

  it('odpowiedź bez potwierdzenia po stronie biblioteki: ten sam wynik, log z etapem', async () => {
    h.verifyReg.mockResolvedValue({ verified: false });

    await expect(register()).resolves.toEqual({ ok: false, reason: 'failed' });

    expect(ours('registration')).toEqual([['[passkey] registration_failed', { stage: 'verify_result', errorName: 'none' }]]);
    expectNoSensitiveFields();
  });

  it('błąd bazy przy zużywaniu wyzwania: wyjątek idzie dalej, log z etapem', async () => {
    storeRegistrationChallenge();
    db.failures['webauthn_challenges:delete'] = { code: 'XX000', message: DB_SECRET };

    await expect(finishPasskeyRegistration(config(), USER_ID, authenticator.register(REGISTRATION_CHALLENGE), 'iPhone'))
      .rejects.toThrow('webauthn_challenge_consume_failed');

    expect(ours('registration')).toEqual([['[passkey] registration_failed', { stage: 'challenge', errorName: 'Error' }]]);
    expectNoSensitiveFields([REGISTRATION_CHALLENGE]);
  });

  it('błąd zapisu urządzenia: wyjątek idzie dalej, a log ma etap bez treści błędu bazy', async () => {
    h.verifyReg.mockResolvedValue(registered());
    db.failures['user_passkeys:insert'] = { code: 'XX000', message: DB_SECRET };

    await expect(register()).rejects.toThrow('passkey_insert_failed');

    expect(ours('registration')).toEqual([['[passkey] registration_failed', { stage: 'insert', errorName: 'Error' }]]);
    expectNoSensitiveFields();
  });

  it('błąd bazy przy przygotowaniu opcji: wyjątek idzie dalej, log z etapem', async () => {
    db.failures['user_passkeys:select'] = { code: 'XX000', message: DB_SECRET };

    await expect(beginPasskeyRegistration(config(), { id: USER_ID, email: EMAIL } as never)).rejects.toThrow('passkey_lookup_failed');

    expect(ours('registration')).toEqual([['[passkey] registration_failed', { stage: 'options_lookup', errorName: 'Error' }]]);
    expectNoSensitiveFields();
  });

  it('urządzenie już dodane i obce wyzwanie to zwykłe odmowy bez wpisu w logu błędów', async () => {
    h.verifyReg.mockResolvedValue(registered());
    db.failures['user_passkeys:insert'] = { code: '23505', message: DB_SECRET };
    await expect(register()).resolves.toEqual({ ok: false, reason: 'already_registered' });

    await expect(finishPasskeyRegistration(config(), USER_ID, authenticator.register('bm9uZS1zdWNoLWNoYWxsZW5nZQ'), 'iPhone'))
      .resolves.toEqual({ ok: false, reason: 'failed' });

    expect(log).not.toHaveBeenCalled();
  });
});

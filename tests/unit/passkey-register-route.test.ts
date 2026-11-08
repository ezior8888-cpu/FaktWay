import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeSupabase, memoryDb, type MemoryDb } from '../helpers/fake-supabase-memory';
import { SoftAuthenticator } from '../helpers/soft-webauthn';

/**
 * Rejestracja, lista i usuwanie urządzeń: prawdziwe końcówki, prawdziwy
 * `getVerifiedMfaState` i `@simplewebauthn/server`; atrapą są baza i SDK Auth.
 */

const h = vi.hoisted(() => ({
  createClient: vi.fn(), createAdminClient: vi.fn(), cookies: vi.fn(), headers: vi.fn(),
  audit: vi.fn(), getSession: vi.fn(), getUser: vi.fn(), getClaims: vi.fn(), signOut: vi.fn(),
}));
vi.mock('next/headers', () => ({ cookies: h.cookies, headers: h.headers }));
vi.mock('@/lib/supabase/server', () => ({ createClient: h.createClient, createAdminClient: h.createAdminClient }));
vi.mock('@/lib/audit/log', () => ({ logAudit: h.audit }));

import { GET as listDevices } from '@/app/api/auth/passkey/route';
import { DELETE as removeDevice } from '@/app/api/auth/passkey/[id]/route';
import { POST as registerOptions } from '@/app/api/auth/passkey/register/options/route';
import { POST as registerVerify } from '@/app/api/auth/passkey/register/verify/route';

const ORIGIN = 'https://faktway.pl';
const RP_ID = 'faktway.pl';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '33333333-3333-4333-8333-333333333333';
const PASSKEY_ID = '44444444-4444-4444-8444-444444444444';
const EMAIL = 'wlasciciel@example.test';
const TOTP = { id: 'totp-1', factor_type: 'totp', status: 'verified' };

let db: MemoryDb;
let authenticator: SoftAuthenticator;
let aal: 'aal1' | 'aal2';
let factors: typeof TOTP[];
let markerCookie: string | undefined;

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

function request(path: string, method: string, body?: unknown, headers: Record<string, string> = {}) {
  return new Request(ORIGIN + path, {
    method,
    headers: { 'content-type': 'application/json', origin: ORIGIN, 'user-agent': IPHONE, ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const optionsCall = (headers: Record<string, string> = {}) => registerOptions(request('/api/auth/passkey/register/options', 'POST', {}, headers));
const verifyCall = (body: unknown, headers: Record<string, string> = {}) => registerVerify(request('/api/auth/passkey/register/verify', 'POST', body, headers));
const removeCall = (id: string, headers: Record<string, string> = {}) =>
  removeDevice(request('/api/auth/passkey/' + id, 'DELETE', undefined, headers), { params: Promise.resolve({ id }) });

async function issueChallenge(): Promise<string> {
  const response = await optionsCall();
  expect(response.status).toBe(200);
  return (await response.json()).options.challenge;
}

function seedPasskey(overrides: Record<string, unknown> = {}) {
  db.tables.user_passkeys!.push({
    id: PASSKEY_ID, user_id: USER_ID, credential_id: 'istniejace-poswiadczenie', public_key: 'klucz', counter: 0,
    transports: ['internal'], device_label: 'iPhone (Safari)', backed_up: true,
    created_at: '2026-10-01T10:00:00.000Z', last_used_at: '2026-10-20T10:00:00.000Z', ...overrides,
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('NEXT_PUBLIC_APP_URL', ORIGIN);
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'fixture-service-role-key-do-testow');
  db = memoryDb({ user_passkeys: [], webauthn_challenges: [] });
  authenticator = new SoftAuthenticator({ rpId: RP_ID, origin: ORIGIN });
  aal = 'aal2';
  factors = [TOTP];
  markerCookie = undefined;
  const ip = `198.51.100.${Math.floor(Math.random() * 250) + 1}`;
  h.headers.mockImplementation(async () => new Headers({ 'x-real-ip': ip }));
  h.cookies.mockImplementation(async () => ({
    get: (name: string) => name === 'ksef.passkey_session' && markerCookie ? { value: markerCookie } : undefined,
    set: vi.fn(),
  }));
  h.getSession.mockResolvedValue({ data: { session: { access_token: 'signed-token' } }, error: null });
  h.getUser.mockImplementation(async () => ({ data: { user: { id: USER_ID, email: EMAIL, factors } }, error: null }));
  h.getClaims.mockImplementation(async () => ({ data: { claims: { sub: USER_ID, aal, session_id: 'session-a' } }, error: null }));
  h.signOut.mockResolvedValue({ error: null });
  h.createAdminClient.mockImplementation(() => fakeSupabase(db));
  h.createClient.mockImplementation(async () => ({
    ...fakeSupabase(db),
    auth: { getSession: h.getSession, getUser: h.getUser, getClaims: h.getClaims, signOut: h.signOut },
  }));
});
afterEach(() => vi.unstubAllEnvs());

describe('rejestracja: kto może', () => {
  it('niezalogowany dostaje 401', async () => {
    h.getSession.mockResolvedValue({ data: { session: null }, error: null });
    const response = await optionsCall();
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'not_authenticated' });
    expect(db.touched).toEqual([]);
  });

  it('konto z 2FA bez potwierdzonego kodu dostaje 403 mfa_required, także na etapie zapisu', async () => {
    aal = 'aal1';
    const options = await optionsCall();
    expect(options.status).toBe(403);
    expect(await options.json()).toEqual({ error: 'mfa_required' });
    const save = await verifyCall({ response: authenticator.register('abc') });
    expect(save.status).toBe(403);
    expect(await save.json()).toEqual({ error: 'mfa_required' });
    expect(db.tables.user_passkeys).toEqual([]);
  });

  it('znacznik sesji biometrycznej nie zastępuje kodu przy dodawaniu urządzenia', async () => {
    const { createPasskeySessionMarker } = await import('@/lib/auth/passkey/session-marker');
    markerCookie = await createPasskeySessionMarker({ sub: USER_ID, sessionId: 'session-a' });
    aal = 'aal1';
    const response = await optionsCall();
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'mfa_required' });
  });

  it('konto bez 2FA dodaje urządzenie bez kodu', async () => {
    aal = 'aal1'; factors = [];
    expect((await optionsCall()).status).toBe(200);
  });

  it('awaria Auth to 503, nie wejście', async () => {
    h.getClaims.mockRejectedValue(new Error('szczegół wewnętrzny'));
    const response = await optionsCall();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'session_verification_failed' });
  });

  it('obcy Origin: 403 przed sprawdzeniem sesji', async () => {
    const response = await optionsCall({ origin: 'https://zly.example' });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'origin_not_allowed' });
    expect(h.getSession).not.toHaveBeenCalled();
  });
});

describe('rejestracja: opcje', () => {
  it('wymaga poświadczenia wykrywalnego i weryfikacji użytkownika, RP z konfiguracji', async () => {
    seedPasskey();
    const response = await optionsCall();
    expect(response.headers.get('cache-control')).toBe('no-store');
    const { options } = await response.json();
    expect(options.rp).toEqual({ id: RP_ID, name: 'FaktWay' });
    expect(options.user.name).toBe(EMAIL);
    expect(options.authenticatorSelection).toMatchObject({ residentKey: 'required', requireResidentKey: true, userVerification: 'required' });
    expect(options.excludeCredentials).toEqual([expect.objectContaining({ id: 'istniejace-poswiadczenie', type: 'public-key' })]);
    expect(db.tables.webauthn_challenges).toEqual([
      expect.objectContaining({ challenge: options.challenge, purpose: 'registration', user_id: USER_ID }),
    ]);
  });

  it('limit urządzeń na konto: 409 z własnym kodem', async () => {
    for (let index = 0; index < 10; index += 1) seedPasskey({ id: `p-${index}`, credential_id: `c-${index}` });
    const response = await optionsCall();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'too_many_passkeys' });
  });
});

describe('rejestracja: zapis', () => {
  it('poprawna odpowiedź zapisuje urządzenie i dziennik; nazwa z przeglądarki', async () => {
    const challenge = await issueChallenge();
    const response = await verifyCall({ response: authenticator.register(challenge) });
    expect(response.status).toBe(200);
    const { device } = await response.json();
    expect(device).toMatchObject({ deviceLabel: 'iPhone (Safari)', backedUp: true, lastUsedAt: null });
    expect(device).not.toHaveProperty('publicKey');
    expect(db.tables.user_passkeys).toEqual([expect.objectContaining({
      user_id: USER_ID, credential_id: authenticator.id, public_key: authenticator.publicKey, counter: 0,
      transports: ['internal'], backed_up: true, device_label: 'iPhone (Safari)',
    })]);
    expect(db.tables.webauthn_challenges).toEqual([]);
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'auth.passkey_added', userId: USER_ID, tenantId: null,
      metadata: expect.objectContaining({ passkey_id: expect.any(String), device_label: 'iPhone (Safari)' }),
    }));
  });

  it('aplikacja natywna podaje własną nazwę; znaki sterujące i nadmiar znikają', async () => {
    const challenge = await issueChallenge();
    const response = await verifyCall({ response: authenticator.register(challenge), deviceLabel: `  Telefon\u0007 Ani${'x'.repeat(200)}` });
    expect(response.status).toBe(200);
    const { device } = await response.json();
    expect(device.deviceLabel.startsWith('Telefon Ani')).toBe(true);
    expect(device.deviceLabel.length).toBeLessThanOrEqual(60);
  });

  it('bez weryfikacji użytkownika nie zapisuje', async () => {
    authenticator.userVerified = false;
    const challenge = await issueChallenge();
    const response = await verifyCall({ response: authenticator.register(challenge) });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'passkey_registration_failed' });
    expect(db.tables.user_passkeys).toEqual([]);
  });

  it('wyzwanie jest jednorazowe', async () => {
    const challenge = await issueChallenge();
    const body = authenticator.register(challenge);
    expect((await verifyCall({ response: body })).status).toBe(200);
    const again = await verifyCall({ response: body });
    expect(again.status).toBe(400);
    expect(await again.json()).toEqual({ error: 'passkey_registration_failed' });
    expect(db.tables.user_passkeys).toHaveLength(1);
  });

  it('wyzwanie innego konta nie działa', async () => {
    db.tables.webauthn_challenges!.push({
      id: 'cudze', challenge: 'Y3VkemUtd3l6d2FuaWU', purpose: 'registration', user_id: OTHER_USER,
      expires_at: '2999-01-01T00:00:00.000Z',
    });
    const response = await verifyCall({ response: authenticator.register('Y3VkemUtd3l6d2FuaWU') });
    expect(response.status).toBe(400);
    expect(db.tables.user_passkeys).toEqual([]);
    expect(db.tables.webauthn_challenges).toHaveLength(1);
  });

  it('wyzwanie logowania nie rejestruje', async () => {
    db.tables.webauthn_challenges!.push({
      id: 'login', challenge: 'bG9nb3dhbmll', purpose: 'login', user_id: null, expires_at: '2999-01-01T00:00:00.000Z',
    });
    const response = await verifyCall({ response: authenticator.register('bG9nb3dhbmll') });
    expect(response.status).toBe(400);
    expect(db.tables.user_passkeys).toEqual([]);
  });

  it('poświadczenie już dodane: 409, bez wpisu w dzienniku', async () => {
    const challenge = await issueChallenge();
    db.failures['user_passkeys:insert'] = { code: '23505', message: 'duplicate key' };
    const response = await verifyCall({ response: authenticator.register(challenge) });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'already_registered' });
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('niepoprawne dane: 400 bez dotykania wyzwań', async () => {
    const response = await verifyCall({ response: { id: 'a' } });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_request' });
    expect(db.touched).not.toContain('webauthn_challenges');
  });
});

describe('lista urządzeń', () => {
  it('oddaje swoje urządzenia bez klucza i mówi, czy wolno nimi zarządzać', async () => {
    seedPasskey();
    seedPasskey({ id: 'cudze', user_id: OTHER_USER });
    const response = await listDevices();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const json = await response.json();
    expect(json).toEqual({
      canManage: true,
      devices: [{
        id: PASSKEY_ID, deviceLabel: 'iPhone (Safari)', backedUp: true,
        createdAt: '2026-10-01T10:00:00.000Z', lastUsedAt: '2026-10-20T10:00:00.000Z',
      }],
    });
  });

  it('sesja po biometrii widzi listę, ale nie może zarządzać', async () => {
    const { createPasskeySessionMarker } = await import('@/lib/auth/passkey/session-marker');
    markerCookie = await createPasskeySessionMarker({ sub: USER_ID, sessionId: 'session-a' });
    aal = 'aal1';
    seedPasskey();
    const response = await listDevices();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ canManage: false, devices: [{ id: PASSKEY_ID }] });
  });
});

describe('usuwanie urządzenia', () => {
  it('usuwa swoje, wylogowuje pozostałe urządzenia i zapisuje dziennik', async () => {
    seedPasskey();
    const response = await removeCall(PASSKEY_ID);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, othersSignedOut: true });
    expect(db.tables.user_passkeys).toEqual([]);
    expect(h.signOut).toHaveBeenCalledExactlyOnceWith({ scope: 'others' });
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'auth.passkey_removed', userId: USER_ID, tenantId: null,
      metadata: expect.objectContaining({ passkey_id: PASSKEY_ID, others_signed_out: true }),
    }));
  });

  it('nieudane wylogowanie pozostałych nie cofa usunięcia, ale klient o tym wie', async () => {
    seedPasskey();
    h.signOut.mockResolvedValue({ error: { message: 'x' } });
    const response = await removeCall(PASSKEY_ID);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, othersSignedOut: false });
  });

  it('konto z 2FA bez kodu nie usunie urządzenia', async () => {
    aal = 'aal1';
    seedPasskey();
    const response = await removeCall(PASSKEY_ID);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'mfa_required' });
    expect(db.tables.user_passkeys).toHaveLength(1);
    expect(h.signOut).not.toHaveBeenCalled();
  });

  it('cudze urządzenie: 404 i bez wylogowania', async () => {
    seedPasskey({ user_id: OTHER_USER });
    const response = await removeCall(PASSKEY_ID);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not_found' });
    expect(db.tables.user_passkeys).toHaveLength(1);
    expect(h.signOut).not.toHaveBeenCalled();
  });

  it('identyfikator spoza UUID: 400 bez bazy', async () => {
    const response = await removeCall('nie-uuid');
    expect(response.status).toBe(400);
    expect(db.touched).toEqual([]);
  });

  it('obcy Origin: 403', async () => {
    seedPasskey();
    const response = await removeCall(PASSKEY_ID, { origin: 'https://zly.example' });
    expect(response.status).toBe(403);
    expect(db.tables.user_passkeys).toHaveLength(1);
  });
});

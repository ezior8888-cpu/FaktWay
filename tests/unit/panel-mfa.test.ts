import { createHmac, hkdfSync } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getPanelMfaState } from '@/lib/auth/panel-mfa';
import { getVerifiedMfaState } from '@/lib/auth/verified-mfa';

/**
 * Rozstrzyganie bramki panelu. `getVerifiedMfaState` jest prawdziwy, atrapą
 * jest tylko SDK Auth: ta sama ścieżka co w proxy i `auth-context`.
 */

const SERVICE_ROLE = 'fixture-service-role-key-do-testow';
const user = {
  id: 'user-a',
  factors: [{ id: 'totp-1', factor_type: 'totp', status: 'verified' }],
};
const SESSION = 'session-a';

const getSession = vi.fn();
const getUser = vi.fn();
const getClaims = vi.fn();
const client = { auth: { getSession, getUser, getClaims } } as never;

/** Znacznik liczony niezależnie od kodu aplikacji. */
function marker(sub: string, sessionId: string, expiry = Math.floor(Date.now() / 1000) + 3600): string {
  const key = Buffer.from(hkdfSync('sha256', SERVICE_ROLE, Buffer.alloc(0), 'faktway/passkey-session-marker/v1', 32));
  const mac = createHmac('sha256', key).update(['v1', sub, sessionId, String(expiry)].join('\n')).digest('base64url');
  return ['v1', String(expiry), mac].join('.');
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', SERVICE_ROLE);
  getSession.mockResolvedValue({ data: { session: { access_token: 'signed-token' } }, error: null });
  getUser.mockResolvedValue({ data: { user }, error: null });
  getClaims.mockResolvedValue({ data: { claims: { sub: user.id, aal: 'aal1', session_id: SESSION } }, error: null });
});
afterEach(() => vi.unstubAllEnvs());

describe('bramka panelu: AAL1 konta z 2FA', () => {
  it('bez znacznika zostaje challenge_required, a czytnik dostaje szansę tylko raz', async () => {
    const read = vi.fn(() => undefined);
    await expect(getPanelMfaState(client, read)).resolves.toMatchObject({ status: 'challenge_required' });
    expect(read).toHaveBeenCalledOnce();
  });

  it('ważny znacznik TEJ sesji przechodzi jak verified', async () => {
    const state = await getPanelMfaState(client, () => marker(user.id, SESSION));
    expect(state).toMatchObject({ status: 'verified', user: { id: user.id } });
  });

  it('getVerifiedMfaState dalej zwraca challenge_required dla tej samej sesji (operacje wrażliwe)', async () => {
    await getPanelMfaState(client, () => marker(user.id, SESSION));
    await expect(getVerifiedMfaState(client)).resolves.toMatchObject({ status: 'challenge_required' });
  });

  it.each([
    ['innej sesji', () => marker(user.id, 'session-b')],
    ['innego konta', () => marker('user-b', SESSION)],
    ['przeterminowany', () => marker(user.id, SESSION, Math.floor(Date.now() / 1000) - 1)],
    ['ze złym podpisem', () => marker(user.id, SESSION).slice(0, -2) + 'AA'],
    ['śmieciowy', () => 'v1.bzdura'],
  ])('znacznik %s nie przechodzi', async (_name, read) => {
    await expect(getPanelMfaState(client, read)).resolves.toMatchObject({ status: 'challenge_required' });
  });

  it('token bez session_id nie przechodzi nawet z poprawnym znacznikiem pustej sesji', async () => {
    getClaims.mockResolvedValue({ data: { claims: { sub: user.id, aal: 'aal1' } }, error: null });
    await expect(getPanelMfaState(client, () => marker(user.id, ''))).resolves.toMatchObject({ status: 'challenge_required' });
  });

  it('awaria czytnika ciasteczek to brak znacznika, nie wejście', async () => {
    const read = vi.fn(() => { throw new Error('poza żądaniem'); });
    await expect(getPanelMfaState(client, read)).resolves.toMatchObject({ status: 'challenge_required' });
  });

  it('nie dokłada zapytań do Auth: tożsamość i claims liczone raz, ten sam token', async () => {
    await getPanelMfaState(client, () => marker(user.id, SESSION));
    expect(getUser).toHaveBeenCalledExactlyOnceWith('signed-token');
    expect(getClaims).toHaveBeenCalledExactlyOnceWith('signed-token');
  });
});

describe('bramka panelu: pozostałe stany bez zmian i bez czytania ciasteczka', () => {
  it('AAL2 jest verified bez znacznika', async () => {
    getClaims.mockResolvedValue({ data: { claims: { sub: user.id, aal: 'aal2', session_id: SESSION } }, error: null });
    const read = vi.fn(() => undefined);
    await expect(getPanelMfaState(client, read)).resolves.toMatchObject({ status: 'verified' });
    expect(read).not.toHaveBeenCalled();
  });

  it('konto bez 2FA zostaje enrollment_required', async () => {
    getUser.mockResolvedValue({ data: { user: { id: user.id, factors: [] } }, error: null });
    const read = vi.fn(() => marker(user.id, SESSION));
    await expect(getPanelMfaState(client, read)).resolves.toMatchObject({ status: 'enrollment_required' });
    expect(read).not.toHaveBeenCalled();
  });

  it('brak sesji to unauthenticated nawet ze znacznikiem w ciasteczku', async () => {
    getSession.mockResolvedValue({ data: { session: null }, error: null });
    const read = vi.fn(() => marker(user.id, SESSION));
    await expect(getPanelMfaState(client, read)).resolves.toEqual({ status: 'unauthenticated' });
    expect(read).not.toHaveBeenCalled();
  });

  it('błąd weryfikacji claims rzuca jak dotąd (wołający odmawia)', async () => {
    getClaims.mockResolvedValue({ data: null, error: { message: 'zły podpis' } });
    await expect(getPanelMfaState(client, () => marker(user.id, SESSION))).rejects.toThrow('mfa_claims_invalid');
  });
});

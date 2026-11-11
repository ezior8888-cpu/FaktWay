import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Akcje „Wyloguj” i „Wyloguj wszystkie inne urządzenia” (krok 8.5) na prawdziwej
 * ścieżce akcji: atrapą są tylko klient Supabase (RPC z 00174), kontrola 2FA
 * i zapis audytu. Samo wylogowanie w GoTrue i uprawnienia funkcji sprawdza
 * `tests/rls-sesje-konta.test.ts` na prawdziwej bazie.
 */

const h = vi.hoisted(() => ({
  rpc: vi.fn(),
  mfaState: vi.fn(),
  audit: vi.fn(),
  revalidate: vi.fn(),
  client: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: h.revalidate }));
vi.mock('@/lib/supabase/server', () => ({ createClient: h.client }));
vi.mock('@/lib/auth/verified-mfa', () => ({ getVerifiedMfaState: h.mfaState }));
vi.mock('@/lib/audit/log', () => ({ logAudit: h.audit }));

const { revokeSessionAction, revokeOtherSessionsAction } = await import('@/app/(dashboard)/settings/security/session-actions');

const USER_ID = '0d5c6a1e-6a8b-4c55-9e0e-2f4b1a7c3d10';
const OTHER_SESSION = '5b7e2d1c-3f4a-4b6c-8d9e-0f1a2b3c4d5e';

beforeEach(() => {
  vi.resetAllMocks();
  h.client.mockResolvedValue({ rpc: h.rpc });
  h.mfaState.mockResolvedValue({ status: 'verified', user: { id: USER_ID } });
});

describe('revokeSessionAction', () => {
  it.each([
    ['bez identyfikatora', {}],
    ['nie UUID', { sessionId: 'abc' }],
    ['zły typ', { sessionId: 12 }],
    ['nie obiekt', 'x'],
  ])('%s: odmowa przed bazą', async (_name, input) => {
    await expect(revokeSessionAction(input)).resolves.toEqual({ ok: false, error: 'invalid_request' });
    expect(h.client).not.toHaveBeenCalled();
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it('wylogowuje wskazaną sesję, zapisuje audyt i odświeża ustawienia', async () => {
    h.rpc.mockResolvedValue({ data: true, error: null });
    await expect(revokeSessionAction({ sessionId: OTHER_SESSION })).resolves.toEqual({ ok: true, revoked: true });
    expect(h.rpc).toHaveBeenCalledExactlyOnceWith('revoke_account_session', { p_session_id: OTHER_SESSION });
    expect(h.audit).toHaveBeenCalledExactlyOnceWith({
      action: 'auth.session_revoked', tenantId: null, userId: USER_ID, metadata: { session_id: OTHER_SESSION },
    });
    expect(h.revalidate).toHaveBeenCalledWith('/settings/security');
  });

  it('sesji już nie ma (albo nie jest Twoja): wynik bez wpisu w audycie', async () => {
    h.rpc.mockResolvedValue({ data: false, error: null });
    await expect(revokeSessionAction({ sessionId: OTHER_SESSION })).resolves.toEqual({ ok: true, revoked: false });
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('sesja po biometrii na koncie z 2FA: prośba o kod, bez wywołania bazy', async () => {
    h.mfaState.mockResolvedValue({ status: 'challenge_required', user: { id: USER_ID } });
    await expect(revokeSessionAction({ sessionId: OTHER_SESSION })).resolves.toEqual({ ok: false, error: 'mfa_required' });
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it('niezalogowany i niesprawdzalna sesja', async () => {
    h.mfaState.mockResolvedValueOnce({ status: 'unauthenticated' });
    await expect(revokeSessionAction({ sessionId: OTHER_SESSION })).resolves.toEqual({ ok: false, error: 'not_authenticated' });
    h.mfaState.mockRejectedValueOnce(new Error('mfa_claims_invalid'));
    await expect(revokeSessionAction({ sessionId: OTHER_SESSION })).resolves.toEqual({ ok: false, error: 'verification_unavailable' });
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ['code_step_required', '42501', 'mfa_required'],
    ['session_not_found', '42501', 'not_authenticated'],
    ['not_authenticated', '42501', 'not_authenticated'],
    ['current_session', '22023', 'current_session'],
    ['coś innego', 'XX000', 'failed'],
  ])('odmowa bazy „%s” → %s', async (message, code, error) => {
    h.rpc.mockResolvedValue({ data: null, error: { message, code } });
    await expect(revokeSessionAction({ sessionId: OTHER_SESSION })).resolves.toEqual({ ok: false, error });
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('wyjątek klienta to błąd z komunikatem, nie wyjątek akcji', async () => {
    h.rpc.mockRejectedValue(new Error('fetch failed'));
    await expect(revokeSessionAction({ sessionId: OTHER_SESSION })).resolves.toEqual({ ok: false, error: 'failed' });
  });
});

describe('revokeOtherSessionsAction', () => {
  it('wylogowuje pozostałe sesje i zapisuje ich liczbę w audycie', async () => {
    h.rpc.mockResolvedValue({ data: 2, error: null });
    await expect(revokeOtherSessionsAction()).resolves.toEqual({ ok: true, count: 2 });
    expect(h.rpc).toHaveBeenCalledExactlyOnceWith('revoke_other_account_sessions');
    expect(h.audit).toHaveBeenCalledExactlyOnceWith({
      action: 'auth.other_sessions_revoked', tenantId: null, userId: USER_ID, metadata: { count: 2 },
    });
    expect(h.revalidate).toHaveBeenCalledWith('/settings/security');
  });

  it('nie było innych sesji: wynik 0 bez wpisu w audycie', async () => {
    h.rpc.mockResolvedValue({ data: 0, error: null });
    await expect(revokeOtherSessionsAction()).resolves.toEqual({ ok: true, count: 0 });
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('dziwny wynik bazy nie udaje sukcesu', async () => {
    h.rpc.mockResolvedValue({ data: 'dwa', error: null });
    await expect(revokeOtherSessionsAction()).resolves.toEqual({ ok: false, error: 'failed' });
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('sesja po biometrii na koncie z 2FA: prośba o kod', async () => {
    h.mfaState.mockResolvedValue({ status: 'challenge_required', user: { id: USER_ID } });
    await expect(revokeOtherSessionsAction()).resolves.toEqual({ ok: false, error: 'mfa_required' });
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it('kod wymagany przez bazę (np. token AAL1 po biometrii) też kończy się prośbą o kod', async () => {
    h.rpc.mockResolvedValue({ data: null, error: { message: 'code_step_required', code: '42501' } });
    await expect(revokeOtherSessionsAction()).resolves.toEqual({ ok: false, error: 'mfa_required' });
  });
});

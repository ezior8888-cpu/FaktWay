import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cancelOwnGdprDeletionAction, requestGdprDeletionAction } from '@/app/(dashboard)/settings/account/actions';
import { GdprSection } from '@/app/(dashboard)/settings/account/_components/gdpr-section';
import { GdprDeletionBlockedError } from '@/lib/gdpr/deletion-blockers';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(), getUser: vi.fn(), getClaims: vi.fn(), createClient: vi.fn(), reauthenticateWithPassword: vi.fn(),
  createGdprRequest: vi.fn(), cancelOwnGdprRequest: vi.fn(),
  sendGdprDeletionScheduledEmail: vi.fn(), logAudit: vi.fn(), revalidatePath: vi.fn(),
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.createClient }));
vi.mock('@/lib/auth/reauth', () => ({ reauthenticateWithPassword: mocks.reauthenticateWithPassword }));
vi.mock('@/lib/gdpr/deletion', () => ({ createGdprRequest: mocks.createGdprRequest, cancelOwnGdprRequest: mocks.cancelOwnGdprRequest }));
vi.mock('@/lib/email/send', () => ({ sendGdprDeletionScheduledEmail: mocks.sendGdprDeletionScheduledEmail }));
vi.mock('@/lib/audit/log', () => ({ logAudit: mocks.logAudit }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('next/headers', () => ({ headers: async () => new Headers({ origin: 'https://app.example.test' }) }));
const created = { id: 'request-1', scheduledFor: new Date('2030-01-16'), cancelToken: 'ab'.repeat(32), alreadyScheduled: false };
const form = () => { const data = new FormData(); data.set('current_password', 'test-password'); data.set('user_id', 'attacker-supplied-id'); data.set('cf-turnstile-response', 'synthetic-turnstile-token'); return data; };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.createClient.mockResolvedValue({ auth: {
    getSession: mocks.getSession, getUser: mocks.getUser, getClaims: mocks.getClaims,
  } });
  mocks.getSession.mockResolvedValue({ data: { session: {
    access_token: 'synthetic-original-token', user: { id: 'cookie-user', factors: [] },
  } }, error: null });
  mocks.getClaims.mockResolvedValue({ data: { claims: { sub: 'session-user', aal: 'aal1' } }, error: null });
  mocks.getUser.mockResolvedValue({ data: { user: { id: 'session-user', email: 'user@example.test' } } });
  mocks.reauthenticateWithPassword.mockResolvedValue({ ok: true });
  mocks.createGdprRequest.mockResolvedValue(created);
  mocks.cancelOwnGdprRequest.mockResolvedValue({ ok: true, requestId: created.id });
  mocks.sendGdprDeletionScheduledEmail.mockResolvedValue({ sent: true });
  mocks.logAudit.mockResolvedValue(undefined);
});

describe('GDPR account actions', () => {

  it.each(['phone', 'webauthn'])('blocks GDPR mutations from AAL1 with a verified %s factor', async (factor_type) => {
    mocks.getUser.mockResolvedValue({ data: { user: {
      id: 'session-user', email: 'user@example.test',
      factors: [{ id: 'unsupported-factor', factor_type, status: 'verified' }],
    } }, error: null });
    expect(await requestGdprDeletionAction(form())).toEqual({ ok: false, error: 'mfa_required' });
    expect(await cancelOwnGdprDeletionAction(form())).toEqual({ ok: false, error: 'mfa_required' });
    expect(mocks.reauthenticateWithPassword).not.toHaveBeenCalled();
    expect(mocks.createGdprRequest).not.toHaveBeenCalled();
    expect(mocks.cancelOwnGdprRequest).not.toHaveBeenCalled();
    expect(mocks.sendGdprDeletionScheduledEmail).not.toHaveBeenCalled();
    expect(mocks.logAudit).not.toHaveBeenCalled();
  });
  it('blocks AAL1 with enrolled MFA before password confirmation and all effects, ignoring cookie factors', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: {
      id: 'session-user', email: 'user@example.test',
      factors: [{ id: 'factor', factor_type: 'totp', status: 'verified' }],
      user_metadata: { mfa_verified: true, recovery_verified: true },
    } }, error: null });
    expect(await requestGdprDeletionAction(form())).toEqual({ ok: false, error: 'mfa_required' });
    expect(await cancelOwnGdprDeletionAction(form())).toEqual({ ok: false, error: 'mfa_required' });
    expect(mocks.reauthenticateWithPassword).not.toHaveBeenCalled();
    expect(mocks.createGdprRequest).not.toHaveBeenCalled();
    expect(mocks.cancelOwnGdprRequest).not.toHaveBeenCalled();
    expect(mocks.sendGdprDeletionScheduledEmail).not.toHaveBeenCalled();
    expect(mocks.logAudit).not.toHaveBeenCalled();
  });

  it('allows verified AAL2 without an organization and verifies the original token before reauthentication', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: {
      id: 'session-user', email: 'user@example.test',
      factors: [{ id: 'factor', factor_type: 'totp', status: 'verified' }],
    } }, error: null });
    mocks.getClaims.mockResolvedValue({ data: { claims: { sub: 'session-user', aal: 'aal2' } }, error: null });
    expect(await requestGdprDeletionAction(form())).toMatchObject({ ok: true });
    expect(await cancelOwnGdprDeletionAction(form())).toEqual({ ok: true });
    expect(mocks.getUser).toHaveBeenCalledWith('synthetic-original-token');
    expect(mocks.getClaims).toHaveBeenCalledWith('synthetic-original-token');
    expect(mocks.getClaims.mock.invocationCallOrder[0]).toBeLessThan(mocks.reauthenticateWithPassword.mock.invocationCallOrder[0]!);
    expect(mocks.reauthenticateWithPassword.mock.invocationCallOrder[0]).toBeLessThan(mocks.createGdprRequest.mock.invocationCallOrder[0]!);
  });

  it.each([
    { data: { claims: { sub: 'another-user', aal: 'aal2' } }, error: null },
    { data: { claims: { sub: 'session-user' } }, error: null },
    { data: null, error: { message: 'internal-signature-error' } },
  ])('fails closed on invalid claims before password or GDPR operations: %j', async (response) => {
    mocks.getClaims.mockResolvedValue(response);
    expect(await requestGdprDeletionAction(form())).toEqual({ ok: false, error: 'session_verification_failed' });
    expect(await cancelOwnGdprDeletionAction(form())).toEqual({ ok: false, error: 'session_verification_failed' });
    expect(mocks.reauthenticateWithPassword).not.toHaveBeenCalled();
    expect(mocks.createGdprRequest).not.toHaveBeenCalled();
    expect(mocks.cancelOwnGdprRequest).not.toHaveBeenCalled();
  });

  it.each(['getSession', 'getUser', 'getClaims'] as const)('fails closed if %s is unavailable', async (method) => {
    mocks[method].mockRejectedValue(new Error('internal-auth-detail'));
    expect(await requestGdprDeletionAction(form())).toEqual({ ok: false, error: 'session_verification_failed' });
    expect(await cancelOwnGdprDeletionAction(form())).toEqual({ ok: false, error: 'session_verification_failed' });
    expect(mocks.reauthenticateWithPassword).not.toHaveBeenCalled();
    expect(mocks.createGdprRequest).not.toHaveBeenCalled();
    expect(mocks.cancelOwnGdprRequest).not.toHaveBeenCalled();
  });

  it('requires a session and password before creating or cancelling anything', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } });
    expect(await requestGdprDeletionAction(form())).toEqual({ ok: false, error: 'not_authenticated' });
    expect(await cancelOwnGdprDeletionAction(form())).toEqual({ ok: false, error: 'not_authenticated' });
    expect(mocks.reauthenticateWithPassword).not.toHaveBeenCalled();
    expect(mocks.createGdprRequest).not.toHaveBeenCalled();
    expect(mocks.cancelOwnGdprRequest).not.toHaveBeenCalled();
  });

  it('a wrong password cannot create or cancel a request', async () => {
    mocks.reauthenticateWithPassword.mockResolvedValue({ ok: false });
    expect(await requestGdprDeletionAction(form())).toEqual({ ok: false, error: 'invalid_password' });
    expect(await cancelOwnGdprDeletionAction(form())).toEqual({ ok: false, error: 'invalid_password' });
    expect(mocks.createGdprRequest).not.toHaveBeenCalled();
    expect(mocks.cancelOwnGdprRequest).not.toHaveBeenCalled();
  });

  it('reports an email as sent only after confirmed delivery submission', async () => {
    const result = await requestGdprDeletionAction(form());
    expect(result).toMatchObject({ ok: true, emailSent: true, alreadyScheduled: false });
    expect(mocks.createGdprRequest).toHaveBeenCalledWith(expect.objectContaining({ userId: 'session-user', userEmail: 'user@example.test' }));
    expect(mocks.sendGdprDeletionScheduledEmail).toHaveBeenCalledWith(expect.objectContaining({ userEmail: 'user@example.test' }));
  });

  it('reports the saved request truthfully if email returns sent:false or throws', async () => {
    mocks.sendGdprDeletionScheduledEmail.mockResolvedValueOnce({ sent: false, reason: 'not-configured' });
    expect(await requestGdprDeletionAction(form())).toMatchObject({ ok: true, emailSent: false });
    mocks.sendGdprDeletionScheduledEmail.mockRejectedValueOnce(new Error('mail unavailable'));
    expect(await requestGdprDeletionAction(form())).toMatchObject({ ok: true, emailSent: false });
  });

  it('names the companies whose subscription blocks deletion, without email or audit entry', async () => {
    mocks.createGdprRequest.mockRejectedValue(new GdprDeletionBlockedError(['Firma Testowa']));
    expect(await requestGdprDeletionAction(form())).toEqual({
      ok: false, error: 'active_subscription', organizations: ['Firma Testowa'],
    });
    expect(mocks.sendGdprDeletionScheduledEmail).not.toHaveBeenCalled();
    expect(mocks.logAudit).not.toHaveBeenCalled();
    mocks.createGdprRequest.mockRejectedValue(new Error('gdpr_blocker_lookup_failed'));
    expect(await requestGdprDeletionAction(form())).toEqual({ ok: false, error: 'request_failed' });
  });

  it('does not resend or rotate the token for an already scheduled request', async () => {
    mocks.createGdprRequest.mockResolvedValue({ ...created, cancelToken: null, alreadyScheduled: true });
    expect(await requestGdprDeletionAction(form())).toMatchObject({ ok: true, alreadyScheduled: true, emailSent: false });
    expect(mocks.sendGdprDeletionScheduledEmail).not.toHaveBeenCalled();
    expect(mocks.logAudit).not.toHaveBeenCalled();
  });

  it('password cancellation uses only the authenticated user, ignoring form user_id', async () => {
    expect(await cancelOwnGdprDeletionAction(form())).toEqual({ ok: true });
    expect(mocks.cancelOwnGdprRequest).toHaveBeenCalledExactlyOnceWith('session-user');
    expect(mocks.reauthenticateWithPassword).toHaveBeenCalledWith('test-password', 'synthetic-turnstile-token');
    expect(mocks.logAudit).toHaveBeenCalledWith(expect.objectContaining({ userId: 'session-user' }));
  });

  it('a claimed or finished request cannot be presented as cancelled', async () => {
    mocks.cancelOwnGdprRequest.mockResolvedValue({ ok: false });
    expect(await cancelOwnGdprDeletionAction(form())).toEqual({ ok: false, error: 'not_pending' });
    expect(mocks.logAudit).not.toHaveBeenCalled();
  });

  it('renders password cancellation for a pending request after reloading account settings', () => {
    const markup = renderToStaticMarkup(<GdprSection initialRequest={{ status: 'pending', scheduledFor: '16 stycznia 2030' }} />);
    expect(markup).toContain('Anuluj usunięcie konta');
    expect(markup).toContain('type="password"');
    expect(markup).not.toContain('wysłaliśmy email');
  });

  it('does not offer cancellation for a request already being processed', () => {
    const markup = renderToStaticMarkup(<GdprSection initialRequest={{ status: 'processing', scheduledFor: '16 stycznia 2030' }} />);
    expect(markup).toContain('Usuwanie konta rozpoczęte');
    expect(markup).not.toContain('Anuluj usunięcie konta');
    expect(markup).not.toContain('type="password"');
  });
});

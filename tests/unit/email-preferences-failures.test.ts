import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ admin: vi.fn(), verified: vi.fn(), revalidate: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: mocks.admin }));
vi.mock('@/lib/auth/verified-user', () => ({ getVerifiedUserContext: mocks.verified }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }));
// Od 15.10.2026 przełącznik zapisuje też zgodę (lib/legal/record.ts) —
// dziennik i maile z tej ścieżki nie są przedmiotem tego testu.
vi.mock('@/lib/audit/log', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/email/send', () => ({ sendEmail: vi.fn() }));
import { canSendTo, unsubscribe, resubscribe, getUnsubscribedCategories } from '@/lib/email/preferences';
import { toggleEmailCategoryAction } from '@/app/(dashboard)/settings/notifications/email-actions';

let failedTable: string | null;
let thrown: boolean;
let optedOut: boolean;
let bounced: boolean;
let writes: Array<{ table: string; operation: string; filters: Array<[string, unknown]>; data?: unknown }>;
const PRIVATE = 'private-email@example.test: database internals';

beforeEach(() => {
  vi.resetAllMocks();
  failedTable = null; thrown = false; optedOut = false; bounced = false; writes = [];
  mocks.verified.mockResolvedValue({ ok: true, user: { id: 'verified-user' } });
  mocks.admin.mockImplementation(() => ({
    from: (table: string) => {
      let operation = 'select'; let data: unknown;
      const filters: Array<[string, unknown]> = [];
      const resolve = () => {
        if (thrown) throw new Error(PRIVATE);
        if (operation !== 'select') writes.push({ table, operation, filters, data });
        return { error: failedTable === table ? { message: PRIVATE } : null,
          data: table === 'email_bounces' ? bounced ? { bounce_type: 'complaint' } : null
            : optedOut ? { id: 'pref' } : null };
      };
      const query = {
        select: () => query,
        upsert: (value: unknown) => { operation = 'upsert'; data = value; return query; },
        delete: () => { operation = 'delete'; return query; },
        eq: (key: string, value: unknown) => { filters.push([key, value]); return query; },
        in: () => query, order: () => query, limit: () => query,
        maybeSingle: async () => resolve(),
        then: (done: (result: ReturnType<typeof resolve>) => unknown, fail: (error: unknown) => unknown) =>
          Promise.resolve().then(resolve).then(done, fail),
      };
      return query;
    },
    // Zgoda na e-maile w app_metadata (lib/legal/record.ts, `setEmailConsent`).
    auth: {
      admin: {
        getUserById: async (id: string) => ({ data: { user: { id, app_metadata: {} } }, error: null }),
        updateUserById: async (id: string, data: unknown) => {
          writes.push({ table: 'auth.users', operation: 'update', filters: [['id', id]], data });
          return { error: null };
        },
      },
    },
  }));
});

describe('email preference integrity', () => {
  it.each(['marketing', 'product_updates', 'transactional'] as const)('does not send %s with unavailable suppression state', async (category) => {
    failedTable = 'email_bounces';
    await expect(canSendTo('fixture@example.test', 'verified-user', category)).rejects.toThrow('email_suppression_unavailable');
  });
  it.each(['marketing', 'product_updates'] as const)('does not send %s past an unknown opt-out', async (category) => {
    failedTable = 'email_preferences';
    await expect(canSendTo('fixture@example.test', 'verified-user', category)).rejects.toThrow('email_preferences_unavailable');
  });
  it('preserves transactional policy and honors complaints for every category', async () => {
    optedOut = true;
    expect(await canSendTo('fixture@example.test', 'verified-user', 'marketing')).toEqual({ ok: false, reason: 'user_unsubscribed' });
    expect(await canSendTo('fixture@example.test', 'verified-user', 'transactional')).toEqual({ ok: true });
    bounced = true;
    expect(await canSendTo('fixture@example.test', 'verified-user', 'transactional')).toEqual({ ok: false, reason: 'complaint' });
  });
  it.each(['unsubscribe', 'resubscribe', 'read'])('does not hide %s database errors', async (operation) => {
    failedTable = 'email_preferences';
    const call = operation === 'unsubscribe' ? unsubscribe({ userId: 'verified-user', category: 'marketing', source: 'settings_ui' })
      : operation === 'resubscribe' ? resubscribe('verified-user', 'marketing') : getUnsubscribedCategories('verified-user');
    await expect(call).rejects.toThrow(/^email_preference(s_unavailable|_write_failed)$/);
  });
});

describe('settings authorization and outcome', () => {
  it.each(['unauthenticated', 'mfa_required', 'verification_failed'])('rejects %s without privileged access', async (reason) => {
    mocks.verified.mockResolvedValue({ ok: false, reason, error: 'Zweryfikuj sesję.' });
    expect(await toggleEmailCategoryAction('marketing', false)).toEqual({ success: false, error: 'Zweryfikuj sesję.' });
    expect(mocks.admin).not.toHaveBeenCalled();
  });
  it('uses the verified user for both opt-out and opt-in', async () => {
    expect(await toggleEmailCategoryAction('marketing', false)).toEqual({ success: true });
    const prefs = () => writes.filter((w) => w.table === 'email_preferences');
    const consents = () => writes.filter((w) => w.table === 'auth.users');
    expect(prefs()[0].data).toEqual(expect.objectContaining({ user_id: 'verified-user', category: 'marketing' }));
    expect(await toggleEmailCategoryAction('marketing', true)).toEqual({ success: true });
    expect(prefs()[1].filters).toContainEqual(['user_id', 'verified-user']);
    expect(prefs()[1].filters).toContainEqual(['category', 'marketing']);
    // Wyłączenie = wycofanie zgody, włączenie = zgoda — zapis na koncie tego samego użytkownika.
    const granted = consents().map((w) => (w.data as { app_metadata: { legal: { email_consents: { marketing: { granted: boolean } } } } })
      .app_metadata.legal.email_consents.marketing.granted);
    expect(granted).toEqual([false, true]);
    expect(consents().every((w) => w.filters[0][1] === 'verified-user')).toBe(true);
  });
  it.each([null, 'false', 1, {}])('rejects non-boolean state %j', async (value) => {
    expect((await toggleEmailCategoryAction('marketing', value as boolean)).success).toBe(false);
    expect(mocks.admin).not.toHaveBeenCalled();
  });
  it.each([false, true])('returns generic failure, no invalidation on a failed write (throw=%s)', async (throwError) => {
    thrown = throwError; failedTable = 'email_preferences';
    const result = await toggleEmailCategoryAction('marketing', false);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).not.toContain(PRIVATE);
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });
});

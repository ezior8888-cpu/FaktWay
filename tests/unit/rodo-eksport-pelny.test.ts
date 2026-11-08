import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

type Row = Record<string, unknown>;

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const EMAIL = 'wlasciciel@example.test';
const SECRET = 'sekret-nie-do-eksportu';

const s = vi.hoisted(() => ({ rows: {} as Record<string, Row[]>, columns: {} as Record<string, string> }));

vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: () => ({
    auth: {
      admin: {
        getUserById: async () => ({
          data: { user: { id: USER, email: EMAIL, created_at: '2026-01-01', last_sign_in_at: null, user_metadata: {} } },
          error: null,
        }),
      },
    },
    from(table: string) {
      const filters: Array<(r: Row) => boolean> = [];
      let columns: string[] | null = null;
      const q = {
        select(cols: string) {
          s.columns[table] = cols;
          columns = cols.split(',').map((c) => c.trim());
          return q;
        },
        eq(k: string, v: unknown) { filters.push((r) => r[k] === v); return q; },
        in(k: string, v: unknown[]) { filters.push((r) => v.includes(r[k])); return q; },
        order: () => q,
        limit: () => q,
        returns: async () => {
          const data = (s.rows[table] ?? [])
            .filter((r) => filters.every((f) => f(r)))
            .map((r) => (columns ? Object.fromEntries(columns.filter((c) => c in r).map((c) => [c, r[c]])) : r));
          return { data, count: data.length, error: null };
        },
      };
      return q;
    },
  }),
}));

import { collectUserData } from '@/lib/gdpr/data-collector';

/**
 * AUD-76: eksport danych konta (art. 15 i 20 RODO) zawierał tylko profil,
 * członkostwa i dziennik audytu. Brakowało danych, które dotyczą samej
 * osoby: preferencji poczty, urządzeń z powiadomieniami, rozmów z pomocą,
 * zaproszeń i próśb o dołączenie, żądań usunięcia, zapisu na newsletter
 * i odbić poczty. Sekrety (klucze push, skróty tokenów) i dane innych osób
 * zostają poza plikiem.
 */

beforeEach(() => {
  s.columns = {};
  s.rows = {
    memberships: [{ id: 'm1', user_id: USER, organization_id: 'org-1', role: 'owner', status: 'active' }],
    audit_logs: [{ id: 'a1', user_id: USER, action: 'auth.login' }],
    users: [{ id: USER, name: 'Jan Testowy', role: 'owner', last_login: null, created_at: '2026-01-01' }],
    email_preferences: [
      { user_id: USER, category: 'marketing', unsubscribed_at: '2026-02-01', source: 'link', reason: null },
      { user_id: OTHER, category: 'marketing', unsubscribed_at: '2026-02-01', source: 'link', reason: SECRET },
    ],
    push_subscriptions: [{
      id: 'p1', user_id: USER, tenant_id: 'org-1', endpoint: `https://push.example/${SECRET}`, p256dh: SECRET, auth: SECRET,
      device_type: 'mobile', device_name: 'Telefon', user_agent: 'UA', is_active: true, created_at: '2026-03-01',
    }],
    user_passkeys: [{
      id: 'k1', user_id: USER, credential_id: SECRET, public_key: SECRET, counter: 3, transports: ['internal'],
      device_label: 'iPhone (Safari)', backed_up: true, created_at: '2026-03-02', last_used_at: '2026-03-03',
    }],
    support_conversations: [
      { id: 'c1', user_id: USER, status: 'closed', category: 'faktury', subject: 'KOR', created_at: '2026-04-01' },
      { id: 'c2', user_id: OTHER, status: 'open', category: 'inne', subject: SECRET, created_at: '2026-04-01' },
    ],
    support_messages: [
      { conversation_id: 'c1', role: 'user', content: 'Jak wystawić korektę?', created_at: '2026-04-01' },
      { conversation_id: 'c2', role: 'user', content: SECRET, created_at: '2026-04-01' },
    ],
    organization_join_requests: [{ id: 'j1', requested_by_user_id: USER, organization_id: 'org-2', status: 'pending', message: 'Cześć', created_at: '2026-05-01' }],
    organization_invitations: [{ id: 'i1', email: EMAIL, organization_id: 'org-1', role: 'admin', token_hash: SECRET, invited_by: OTHER, invited_at: '2026-01-01' }],
    gdpr_deletion_requests: [{ id: 'g1', user_id: USER, status: 'canceled', scheduled_for: '2026-06-15', cancel_token_hash: SECRET, created_at: '2026-06-01' }],
    newsletter_subscribers: [{ email: EMAIL, source: 'blog', created_at: '2026-01-05', unsubscribed_at: null }],
    email_bounces: [{ email: EMAIL, bounce_type: 'soft', reason: 'mailbox full', occurred_at: '2026-07-01', raw_payload: { s: SECRET } }],
  };
});

describe('eksport danych konta — pełny zakres osoby (AUD-76)', () => {
  it('zawiera dane osoby z każdego miejsca, w którym są zapisane', async () => {
    const data = await collectUserData(USER);

    expect(data.format_version).toBe(3);
    expect(data.profile).toMatchObject({ name: 'Jan Testowy' });
    expect(data.email_preferences).toHaveLength(1);
    expect(data.push_devices).toEqual([expect.objectContaining({ device_name: 'Telefon' })]);
    expect(data.passkey_devices).toEqual([expect.objectContaining({ device_label: 'iPhone (Safari)' })]);
    expect(data.support_conversations).toEqual([
      expect.objectContaining({ id: 'c1', messages: [expect.objectContaining({ content: 'Jak wystawić korektę?' })] }),
    ]);
    expect(data.join_requests).toHaveLength(1);
    expect(data.invitations_received).toEqual([expect.objectContaining({ organization_id: 'org-1', role: 'admin' })]);
    expect(data.deletion_requests).toEqual([expect.objectContaining({ status: 'canceled' })]);
    expect(data.newsletter).toEqual([expect.objectContaining({ source: 'blog' })]);
    expect(data.email_bounces).toEqual([expect.objectContaining({ bounce_type: 'soft' })]);
  });

  it('bez sekretów i bez danych innych osób', async () => {
    const data = await collectUserData(USER);

    expect(JSON.stringify(data)).not.toContain(SECRET);
    expect(JSON.stringify(data)).not.toContain(OTHER);
    for (const forbidden of ['p256dh', 'auth', 'endpoint', 'token_hash', 'cancel_token_hash', 'raw_payload', 'invited_by', 'public_key', 'credential_id']) {
      for (const [table, cols] of Object.entries(s.columns)) {
        expect(cols.split(',').map((c) => c.trim()), `${table} wybiera ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('każda sekcja ma pokrycie (ile zwrócono z ilu)', async () => {
    const data = await collectUserData(USER);

    expect(data.coverage.support_conversations).toEqual({ returned: 1, total: 1, truncated: false });
    expect(data.coverage.email_bounces).toEqual({ returned: 1, total: 1, truncated: false });
  });
});

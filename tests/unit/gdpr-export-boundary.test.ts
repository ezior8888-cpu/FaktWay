import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ admin: vi.fn(), verified: vi.fn(), audit: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createAdminClient: mocks.admin }));
vi.mock('@/lib/auth/verified-user', () => ({ getVerifiedUserContext: mocks.verified }));
vi.mock('@/lib/audit/log', () => ({ logAudit: mocks.audit }));
import { collectUserData } from '@/lib/gdpr/data-collector';
import { GET } from '@/app/api/gdpr/export/route';

const USER = '11111111-1111-4111-8111-111111111111';
const apiRequest = () => new Request('https://faktway.pl/api/gdpr/export', { headers: { accept: 'application/json' } });
const OTHER = '22222222-2222-4222-8222-222222222222';
const PRIVATE = 'private-row-and-auth-diagnostic';
type Row = Record<string, unknown>;
let rows: Record<string, Row[]>;
let failedTable: string | null;
let rowLimit: number;
let authError: boolean;
let authId: string;
let tablesRead: string[];
let omitCount: boolean;

beforeEach(() => {
  vi.resetAllMocks();
  failedTable = null; rowLimit = 1000; authError = false; authId = USER;
  tablesRead = []; omitCount = false;
  rows = {
    memberships: [
      { id: 'm1', user_id: USER, organization_id: 'active-org', role: 'owner', status: 'active' },
      { id: 'm2', user_id: USER, organization_id: 'revoked-org', role: 'owner', status: 'revoked' },
      { id: 'm3', user_id: OTHER, organization_id: 'private-org', role: 'owner', status: 'active' },
    ],
    audit_logs: [
      { id: 'a1', user_id: USER, action: 'own-action' },
      { id: 'a2', user_id: OTHER, action: PRIVATE },
    ],
    // Sekcje osobowe z AUD-76 (format 3) — tu puste; zakres sprawdza rodo-eksport-pelny.
    users: [{ id: USER, name: 'Own' }],
    email_preferences: [], push_subscriptions: [], user_passkeys: [], support_conversations: [], support_messages: [],
    organization_join_requests: [], organization_invitations: [], gdpr_deletion_requests: [],
    newsletter_subscribers: [], email_bounces: [],
  };
  mocks.verified.mockResolvedValue({ ok: true, user: { id: USER } });
  mocks.audit.mockResolvedValue(undefined);
  mocks.admin.mockImplementation(() => ({
    auth: { admin: { getUserById: async () => ({
      data: { user: { id: authId, email: 'own@example.test', created_at: '2026-01-01', user_metadata: {} } },
      error: authError ? { message: PRIVATE } : null,
    }) } },
    from: (table: string) => {
      tablesRead.push(table);
      if (!rows[table]) throw new Error('Unexpected table: ' + table);
      const filters: Array<[string, unknown]> = [];
      let limit = 1000;
      const run = () => {
        const selected = rows[table].filter((row) => filters.every(([key, value]) => row[key] === value));
        return { data: selected.slice(0, Math.min(limit, rowLimit)),
          count: omitCount ? null : selected.length,
          error: failedTable === table ? { message: PRIVATE } : null };
      };
      const query = {
        select: (_columns: string, opts?: { count?: string }) => {
          expect(opts?.count).toBe('exact'); return query;
        },
        eq: (key: string, value: unknown) => { filters.push([key, value]); return query; },
        in: () => query,
        order: () => query,
        limit: (value: number) => { limit = value; return query; },
        // Sekcje stronami czekają na samo zapytanie, profil przez `returns()`.
        returns: () => query,
        then: <A, B>(ok: (value: ReturnType<typeof run>) => A, fail?: (error: unknown) => B) =>
          Promise.resolve().then(run).then(ok, fail),
      };
      return query;
    },
  }));
});

describe('bounded account export', () => {
  it('exports only the verified account, never organizational invoices or other users', async () => {
    const data = await collectUserData(USER);
    expect(data.format_version).toBe(3);
    expect(data.memberships.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(data.audit_logs.map((a) => a.id)).toEqual(['a1']);
    expect(data.organizations_owned).toEqual([{ organization_id: 'active-org', role: 'owner' }]);
    expect(data.organization_invoices.included).toBe(false);
    // Od formatu 3 (AUD-76) także dane osoby z innych tabel — nadal bez faktur.
    expect(tablesRead).not.toContain('invoices');
    expect(tablesRead.slice(0, 2)).toEqual(['memberships', 'audit_logs']);
    expect(JSON.stringify(data)).not.toContain(PRIVATE);
    expect(data).not.toHaveProperty('invoices_count');
  });

  // Sesja 29 planu skalowania: sekcje idą stronami w komplecie, więc ucięta
  // strona nie jest już „uczciwym kawałkiem” z truncated: true, tylko odmową.
  it('refuses a silently capped page rather than exporting a partial file', async () => {
    rowLimit = 1;
    await expect(collectUserData(USER)).rejects.toThrow(/^account_export_data_unavailable$/);
  });

  it.each(['memberships', 'audit_logs'])('refuses partial success on %s errors', async (table) => {
    failedTable = table;
    await expect(collectUserData(USER)).rejects.toThrow(/^account_export_data_unavailable$/);
  });

  it('refuses an unknown result count', async () => {
    omitCount = true;
    await expect(collectUserData(USER)).rejects.toThrow(/^account_export_count_unavailable$/);
  });

  it.each(['error', 'other-user'])('rejects an invalid Auth result: %s', async (mode) => {
    authError = mode === 'error'; authId = mode === 'other-user' ? OTHER : USER;
    await expect(collectUserData(USER)).rejects.toThrow(/^account_export_user_unavailable$/);
    expect(tablesRead).toEqual([]);
  });
});

describe('account export endpoint', () => {
  it.each([
    ['unauthenticated', 401], ['mfa_required', 403], ['verification_failed', 503],
  ])('rejects %s before creating privileged clients', async (reason, status) => {
    mocks.verified.mockResolvedValue({ ok: false, reason });
    const response = await GET(apiRequest());
    expect(response.status).toBe(status);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(mocks.admin).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  // Logowanie biometrią (FW1): eksport wymaga prawdziwego kodu, a link w panelu
  // to zwykła nawigacja. Goły JSON 403 byłby dla klienta martwym błędem.
  it('asks the shared context for full MFA, not the panel marker', async () => {
    await GET(apiRequest());
    expect(mocks.verified).toHaveBeenCalledWith({ fullMfa: true });
  });

  it('sends a browser navigation without the code to the code screen and back to the account page', async () => {
    mocks.verified.mockResolvedValue({ ok: false, reason: 'mfa_required' });
    const navigation = new Request('https://faktway.pl/api/gdpr/export', {
      headers: { 'sec-fetch-dest': 'document', accept: 'text/html' },
    });
    const response = await GET(navigation);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/login/two-factor?redirect=%2Fsettings%2Faccount&potwierdzenie=1');
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(mocks.admin).not.toHaveBeenCalled();
  });

  it('keeps a JSON refusal for API clients', async () => {
    mocks.verified.mockResolvedValue({ ok: false, reason: 'mfa_required' });
    const response = await GET(apiRequest());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'mfa_required' });
  });

  it('returns a private download and audits the actual scope', async () => {
    const response = await GET(apiRequest());
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect((await response.json()).user.id).toBe(USER);
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      userId: USER, metadata: expect.objectContaining({ format_version: 3 }),
    }));
  });

  it('does not leak raw exceptions or record export success on failure', async () => {
    mocks.admin.mockImplementation(() => { throw new Error(PRIVATE); });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = await GET(apiRequest());
      expect(response.status).toBe(500);
      expect(response.headers.get('cache-control')).toContain('no-store');
      expect(await response.json()).toEqual({ error: 'export_failed' });
      expect(JSON.stringify(log.mock.calls)).not.toContain(PRIVATE);
      expect(mocks.audit).not.toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });
});

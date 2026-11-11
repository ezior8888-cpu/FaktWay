import { createHash } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Krok 2.10: akcje „Link dla nabywcy” w karcie faktury. Atrapy tylko dla
 * sesji (rola i firma), klienta bazy i audytu. Reguły (kto, dla jakiej
 * faktury), token, skrót i adres są prawdziwe. Te same reguły po stronie bazy
 * (polityki RLS, wyzwalacz, funkcja odczytu) sprawdza
 * `tests/rls-link-dla-nabywcy.test.ts`.
 */

const TENANT = '00179179-0000-4000-8000-0000000000aa';
const INVOICE = '00179179-1111-4000-8000-0000000000bb';
const LINK = '00179179-2222-4000-8000-0000000000cc';
const OLD_LINK = '00179179-2222-4000-8000-0000000000dd';
const USER = '00179179-3333-4000-8000-0000000000ee';

type Filter = [string, string, unknown];
interface Call { table: string; op: 'select' | 'update' | 'insert'; payload: unknown; filters: Filter[] }

const mocks = vi.hoisted(() => ({
  role: 'owner',
  audit: vi.fn(),
  calls: [] as Array<{ table: string; op: string; payload: unknown; filters: Array<[string, string, unknown]> }>,
  invoice: null as Record<string, unknown> | null,
  xmlHash: null as string | null,
  liveLinks: [] as Array<{ id: string }>,
  insertError: null as { code?: string; message: string } | null,
  revokeRows: [] as Array<{ id: string; invoice_id: string }>,
  latest: null as Record<string, unknown> | null,
}));

function fakeClient() {
  return {
    from(table: string) {
      const call: Call = { table, op: 'select', payload: null, filters: [] };
      mocks.calls.push(call);
      const result = (): { data: unknown; error: unknown } => {
        if (table === 'invoices') return { data: mocks.invoice, error: null };
        if (table === 'xml_documents') return { data: mocks.xmlHash ? { sha256_hash: mocks.xmlHash } : null, error: null };
        if (call.op === 'insert') {
          if (mocks.insertError) return { data: null, error: mocks.insertError };
          return { data: { id: LINK, created_at: '2026-11-09T10:00:00+00:00', expires_at: '2099-02-07T10:00:00+00:00' }, error: null };
        }
        if (call.op === 'update') {
          const byId = call.filters.some(([, col]) => col === 'id');
          return { data: byId ? mocks.revokeRows : mocks.liveLinks, error: null };
        }
        return { data: mocks.latest, error: null };
      };
      const builder = {
        select: () => builder,
        eq: (col: string, value: unknown) => { call.filters.push(['eq', col, value]); return builder; },
        is: (col: string, value: unknown) => { call.filters.push(['is', col, value]); return builder; },
        order: () => builder,
        limit: () => builder,
        update: (payload: unknown) => { call.op = 'update'; call.payload = payload; return builder; },
        insert: (payload: unknown) => { call.op = 'insert'; call.payload = payload; return builder; },
        maybeSingle: async () => result(),
        single: async () => result(),
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(result()).then(resolve, reject),
      };
      return builder;
    },
  };
}

vi.mock('@/lib/audit/log', () => ({ logAudit: mocks.audit }));
vi.mock('@/lib/supabase/auth-context', async (orig) => ({
  ...(await orig<typeof import('@/lib/supabase/auth-context')>()),
  requireUserAndActiveOrg: async () => ({ supabase: fakeClient(), user: { id: USER }, tenantId: TENANT, role: mocks.role }),
}));

const { createBuyerLinkAction, revokeBuyerLinkAction, getBuyerLinkAction } = await import('@/components/invoices/buyer-link-actions');

const SHAREABLE = {
  id: INVOICE,
  internal_number: 'FV/1/11/2026',
  direction: 'outgoing',
  origin: 'app',
  ksef_status: 'accepted',
  invoice_kind: 'regular',
  ksef_number: '1234567890-20261109-0A1B2C3D4E5F-6A',
  ksef_environment: 'test',
  xml_storage_path: `${TENANT}/2026/11/${INVOICE}.xml`,
};

const inserts = () => mocks.calls.filter((c) => c.table === 'invoice_share_links' && c.op === 'insert');
const updates = () => mocks.calls.filter((c) => c.table === 'invoice_share_links' && c.op === 'update');

beforeEach(() => {
  mocks.calls = [];
  mocks.audit.mockReset();
  mocks.role = 'owner';
  mocks.invoice = { ...SHAREABLE };
  mocks.xmlHash = 'ab'.repeat(32);
  mocks.liveLinks = [];
  mocks.insertError = null;
  mocks.revokeRows = [{ id: LINK, invoice_id: INVOICE }];
  mocks.latest = null;
  vi.stubEnv('KSEF_ENV', 'test');
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.example.test');
});
afterEach(() => vi.unstubAllEnvs());

describe('createBuyerLinkAction', () => {
  it('tworzy link: w bazie tylko skrót tokenu, adres z tokenem wraca raz, audyt bez tokenu', async () => {
    const result = await createBuyerLinkAction(INVOICE);
    if (!result.success) throw new Error(result.error);

    const match = /^https:\/\/app\.example\.test\/faktura\/([A-Za-z0-9_-]{43})$/.exec(result.url);
    expect(match).not.toBeNull();
    const token = match![1]!;

    expect(inserts()).toHaveLength(1);
    const payload = inserts()[0]!.payload as Record<string, unknown>;
    expect(payload).toEqual({
      tenant_id: TENANT,
      invoice_id: INVOICE,
      token_hash: createHash('sha256').update(token).digest('hex'),
    });
    expect(JSON.stringify(mocks.calls)).not.toContain(token);

    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'invoice.share_link_created',
      tenantId: TENANT,
      userId: USER,
      entityType: 'invoice',
      entityId: INVOICE,
    }));
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain(token);
    expect(result.link).toMatchObject({ id: LINK, status: 'active', openCount: 0, expiresAt: '2099-02-07T10:00:00+00:00' });
  });

  it('dwa linki dają różne tokeny', async () => {
    const a = await createBuyerLinkAction(INVOICE);
    const b = await createBuyerLinkAction(INVOICE);
    expect(a.success && b.success && a.url !== b.url).toBe(true);
  });

  it('nowy link najpierw cofa żywy link tej faktury w tej firmie i zapisuje to w audycie', async () => {
    mocks.liveLinks = [{ id: OLD_LINK }];
    const result = await createBuyerLinkAction(INVOICE);
    expect(result.success).toBe(true);
    const revoke = updates()[0]!;
    expect(Object.keys(revoke.payload as object)).toEqual(['revoked_at']);
    expect(revoke.filters).toEqual(expect.arrayContaining([
      ['eq', 'tenant_id', TENANT],
      ['eq', 'invoice_id', INVOICE],
      ['is', 'revoked_at', null],
    ]));
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'invoice.share_link_revoked',
      entityId: INVOICE,
      metadata: expect.objectContaining({ linkId: OLD_LINK, reason: 'replaced' }),
    }));
  });

  it('członek zespołu tworzy link, księgowa nie', async () => {
    mocks.role = 'member';
    expect((await createBuyerLinkAction(INVOICE)).success).toBe(true);
    mocks.calls = [];
    mocks.role = 'accountant';
    const refused = await createBuyerLinkAction(INVOICE);
    expect(refused.success).toBe(false);
    expect(inserts()).toHaveLength(0);
    expect(updates()).toHaveLength(0);
  });

  it.each([
    ['szkic', { ksef_status: 'draft' }, /FV\/1\/11\/2026.*nie jest jeszcze przyjęta w KSeF/],
    ['odrzucona', { ksef_status: 'rejected' }, /FV\/1\/11\/2026.*nie jest jeszcze przyjęta w KSeF/],
    ['zakup', { direction: 'incoming' }, /sprzedaży/],
    ['import z KSeF', { origin: 'ksef_import' }, /wystawionej w FaktWay/],
    ['korekta', { invoice_kind: 'correction' }, /FV\/1\/11\/2026.*e-mailem/],
    ['rozliczeniowa', { invoice_kind: 'final' }, /FV\/1\/11\/2026.*e-mailem/],
    ['bez numeru KSeF', { ksef_number: null }, /FV\/1\/11\/2026/],
    ['bez pliku XML', { xml_storage_path: null }, /FV\/1\/11\/2026.*pliku XML/],
    ['inne środowisko KSeF', { ksef_environment: 'production' }, /FV\/1\/11\/2026.*środowiska KSeF/],
  ])('odmawia dla faktury: %s (komunikat z numerem i tym, co zrobić)', async (_name, change, message) => {
    mocks.invoice = { ...SHAREABLE, ...change };
    const result = await createBuyerLinkAction(INVOICE);
    expect(result.success).toBe(false);
    expect(!result.success && result.error).toMatch(message);
    expect(inserts()).toHaveLength(0);
    expect(updates()).toHaveLength(0);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('odmawia, gdy w bazie nie ma skrótu pliku XML wysłanego do KSeF', async () => {
    mocks.xmlHash = null;
    const result = await createBuyerLinkAction(INVOICE);
    expect(!result.success && result.error).toMatch(/FV\/1\/11\/2026.*pliku XML/);
    expect(inserts()).toHaveLength(0);
  });

  it('faktura spoza aktywnej firmy: brak faktury, bez zapisu', async () => {
    mocks.invoice = null;
    const result = await createBuyerLinkAction(INVOICE);
    expect(result.success).toBe(false);
    expect(inserts()).toHaveLength(0);
    const read = mocks.calls.find((c) => c.table === 'invoices')!;
    expect(read.filters).toEqual(expect.arrayContaining([['eq', 'id', INVOICE], ['eq', 'tenant_id', TENANT]]));
  });

  it('wyścig dwóch kliknięć (UNIQUE żywego linku): komunikat, bez audytu utworzenia', async () => {
    mocks.insertError = { code: '23505', message: 'duplicate key value violates unique constraint "uq_invoice_share_links_live"' };
    const result = await createBuyerLinkAction(INVOICE);
    expect(result.success).toBe(false);
    expect(mocks.audit).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'invoice.share_link_created' }));
  });

  it('identyfikator faktury w złym formacie: odmowa bez zapytań', async () => {
    const result = await createBuyerLinkAction('nie-uuid');
    expect(result.success).toBe(false);
    expect(mocks.calls).toHaveLength(0);
  });
});

describe('revokeBuyerLinkAction', () => {
  it('cofa żywy link aktywnej firmy i zapisuje audyt', async () => {
    const result = await revokeBuyerLinkAction(LINK);
    expect(result).toEqual({ success: true });
    const revoke = updates()[0]!;
    expect(Object.keys(revoke.payload as object)).toEqual(['revoked_at']);
    expect(revoke.filters).toEqual(expect.arrayContaining([
      ['eq', 'id', LINK],
      ['eq', 'tenant_id', TENANT],
      ['is', 'revoked_at', null],
    ]));
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'invoice.share_link_revoked',
      tenantId: TENANT,
      userId: USER,
      entityType: 'invoice',
      entityId: INVOICE,
      metadata: expect.objectContaining({ linkId: LINK, reason: 'manual' }),
    }));
  });

  it('link już cofnięty albo cudzy: komunikat, bez audytu', async () => {
    mocks.revokeRows = [];
    const result = await revokeBuyerLinkAction(LINK);
    expect(result.success).toBe(false);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('księgowa nie cofa linku', async () => {
    mocks.role = 'accountant';
    const result = await revokeBuyerLinkAction(LINK);
    expect(result.success).toBe(false);
    expect(updates()).toHaveLength(0);
  });
});

describe('getBuyerLinkAction', () => {
  it('stan ostatniego linku: aktywny, wygasły, cofnięty albo brak', async () => {
    const base = { id: LINK, created_at: '2026-11-09T10:00:00+00:00', revoked_at: null, open_count: 3, last_opened_at: '2026-11-10T08:00:00+00:00' };

    mocks.latest = { ...base, expires_at: '2099-01-01T00:00:00+00:00' };
    const active = await getBuyerLinkAction(INVOICE);
    expect(active).toMatchObject({ success: true, link: { id: LINK, status: 'active', openCount: 3, lastOpenedAt: base.last_opened_at } });

    mocks.latest = { ...base, expires_at: '2020-01-01T00:00:00+00:00' };
    expect(await getBuyerLinkAction(INVOICE)).toMatchObject({ success: true, link: { status: 'expired' } });

    mocks.latest = { ...base, expires_at: '2099-01-01T00:00:00+00:00', revoked_at: '2026-11-10T09:00:00+00:00' };
    expect(await getBuyerLinkAction(INVOICE)).toMatchObject({ success: true, link: { status: 'revoked' } });

    mocks.latest = null;
    expect(await getBuyerLinkAction(INVOICE)).toEqual({ success: true, link: null });

    const read = mocks.calls.filter((c) => c.table === 'invoice_share_links').at(-1)!;
    expect(read.filters).toEqual(expect.arrayContaining([['eq', 'tenant_id', TENANT], ['eq', 'invoice_id', INVOICE]]));
  });

  it('księgowa nie widzi panelu linku', async () => {
    mocks.role = 'accountant';
    expect((await getBuyerLinkAction(INVOICE)).success).toBe(false);
  });
});

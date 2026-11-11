import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';

/**
 * Dzwonek (plan kompletnej aplikacji, krok 8.1, część 2, 00188): nowa
 * faktura zakupu ze skrzynki KSeF. Wpis powstaje w `auto-categorize-inbox`
 * po utworzeniu kosztu (link do kosztu), tylko gdy ten przebieg go utworzył.
 * Błąd zapisu powiadomienia nie przerywa joba: koszt zostaje, skrzynka się
 * domyka, w logu ostrzeżenie (fail-open). Atrapa tylko dla bazy i XML.
 */

type Row = Record<string, unknown>;

const db = vi.hoisted(() => ({
  archive: vi.fn(),
  updates: [] as Array<{ table: string; patch: Row }>,
  rpcCalls: [] as Array<{ fn: string; args: Row }>,
  rpcResult: { data: 1, error: null } as { data: unknown; error: null | { message: string } },
  rpcThrows: null as Error | null,
  existingExpense: null as Row | null,
}));

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('@/lib/ksef/inbox-xml', () => ({ archiveInboxInvoiceXml: db.archive }));
vi.mock('@/lib/categorization', () => ({
  categorizeExpense: async () => ({ kpir_column: 'col_13', category_label: 'Usługi', method: 'rule', confidence: 0.95 }),
}));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    rpc: async (fn: string, args: Row) => {
      db.rpcCalls.push({ fn, args });
      if (db.rpcThrows) throw db.rpcThrows;
      return db.rpcResult;
    },
    from: (table: string) => {
      let patch: Row | null = null;
      let inserted = false;
      const q: Record<string, unknown> = {};
      Object.assign(q, {
        select: () => q,
        eq: () => q,
        limit: () => q,
        insert: () => ((inserted = true), q),
        update: (p: Row) => {
          patch = p;
          db.updates.push({ table, patch: p });
          return q;
        },
        single: async () => {
          if (table === 'invoices') {
            return {
              data: {
                id: '11111111-1111-4111-8111-111111111111',
                tenant_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                direction: 'incoming',
                ksef_number: '5260001246-20261111-000000000001-00',
                internal_number: 'FV 1/2026',
                issue_date: '2026-11-10',
                seller_data: { name: 'Dostawca sp. z o.o.', nip: '5260001246' },
                seller_nip: '5260001246',
                gross_total: 123,
                net_total: 100,
                vat_total: 23,
                currency: 'PLN',
                fa3_data: { _source: 'inbox-metadata', _pendingFullFetch: true },
                invoice_line_items: [],
              },
              error: null,
            };
          }
          return { data: inserted ? { id: '22222222-2222-4222-8222-222222222222' } : null, error: null };
        },
        maybeSingle: async () => {
          if (table === 'invoices') {
            if (patch) return { data: { id: '11111111-1111-4111-8111-111111111111' }, error: null };
            return {
              data: {
                id: '11111111-1111-4111-8111-111111111111',
                tenant_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                direction: 'incoming',
                origin: 'ksef_inbox',
                ksef_status: 'accepted',
                ksef_environment: 'test',
                fa3_data: { _source: 'inbox-metadata', _pendingFullFetch: true },
              },
              error: null,
            };
          }
          if (table === 'expenses') return { data: db.existingExpense, error: null };
          if (table === 'memberships') return { data: { user_id: 'u-1' }, error: null };
          return { data: null, error: null };
        },
      });
      return q;
    },
  }),
}));

import { runAutoCategorizeInbox } from '@/lib/jobs/runners/auto-categorize-inbox';

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const ctx: JobContext = {
  attempt: 0,
  logger: log,
  step: { run: async (_n, fn) => fn(), sleep: vi.fn(), sendEvent: vi.fn(), scheduleAfter: vi.fn() },
};
const DANE = {
  invoiceId: '11111111-1111-4111-8111-111111111111',
  tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  environment: 'test' as const,
};

const domkniecia = () => db.updates.filter((u) => u.table === 'invoices');

beforeEach(() => {
  vi.stubEnv('KSEF_ENV', 'test');
  db.updates = [];
  db.rpcCalls = [];
  db.rpcResult = { data: 1, error: null };
  db.rpcThrows = null;
  db.existingExpense = null;
  db.archive.mockReset();
  db.archive.mockResolvedValue({ archived: true });
  for (const fn of Object.values(log)) fn.mockClear();
});
afterEach(() => vi.unstubAllEnvs());

describe('skrzynka KSeF → dzwonek: nowa faktura zakupu', () => {
  it('nowy koszt: wpis w dzwonku z linkiem do kosztu, klucz = faktura', async () => {
    await expect(runAutoCategorizeInbox(DANE, ctx)).resolves.toEqual({ success: true });
    expect(db.rpcCalls).toEqual([
      {
        fn: 'app_notification_publish',
        args: {
          p_tenant_id: DANE.tenantId,
          p_kind: 'inbox_new',
          p_object_key: DANE.invoiceId,
          p_title: 'Nowa faktura zakupu',
          p_body: 'FV 1/2026 od Dostawca sp. z o.o., 123,00 zł',
          p_link: '/expenses/22222222-2222-4222-8222-222222222222',
        },
      },
    ]);
    expect(domkniecia()).toHaveLength(1);
  });

  it.each([
    ['błąd bazy', () => { db.rpcResult = { data: null, error: { message: 'relation "app_notifications" does not exist' } }; }],
    ['wyjątek klienta', () => { db.rpcThrows = new Error('fetch failed'); }],
  ])('%s przy zapisie powiadomienia nie przerywa joba: koszt i domknięcie skrzynki zostają', async (_nazwa, awaria) => {
    awaria();
    await expect(runAutoCategorizeInbox(DANE, ctx)).resolves.toEqual({ success: true });
    expect(db.rpcCalls).toHaveLength(1);
    expect(domkniecia()).toHaveLength(1);
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/dzwon|powiadomie/i), expect.anything());
  });

  it('koszt już istniał (równoległy przebieg albo ponowienie): bez drugiego wpisu', async () => {
    db.existingExpense = { id: '33333333-3333-4333-8333-333333333333' };
    await expect(runAutoCategorizeInbox(DANE, ctx)).resolves.toEqual({ success: true });
    expect(db.rpcCalls).toEqual([]);
  });
});

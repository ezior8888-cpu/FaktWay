import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';

/**
 * Sesja 17 planu skalowania: `singletonKey` na kolejce o polityce `standard`
 * niczego nie deduplikuje (pg-boss 12: unikalne indeksy po kluczu obejmują tylko
 * polityki short/singleton/stately/exclusive/key_strict_fifo albo `singletonSeconds`).
 * Cron uzupełniający co 15 min wysyłał więc to samo zadanie kategoryzacji od nowa,
 * a każde pobierało XML i pytało AI, zanim zauważyło, że koszt już istnieje.
 *
 * Teraz: drugie zadanie tej samej faktury kończy się jednym odczytem, bez pobrania
 * XML i bez AI, a cron pomija faktury, których zadanie jeszcze czeka.
 */

type Row = Record<string, unknown>;

const INVOICE = '11111111-1111-4111-8111-111111111111';
const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const db = vi.hoisted(() => ({
  archive: vi.fn(),
  categorize: vi.fn(),
  fa3: {} as Record<string, unknown>,
  expenses: [] as Array<{ id: string }>,
  reads: [] as string[],
  selects: [] as Array<{ table: string; columns: string }>,
  inserts: [] as Array<{ table: string; row: unknown }>,
  updates: [] as Array<{ table: string; patch: unknown }>,
  invoiceRow: null as Record<string, unknown> | null,
}));

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('@/lib/ksef/inbox-xml', () => ({ archiveInboxInvoiceXml: db.archive }));
vi.mock('@/lib/categorization', () => ({ categorizeExpense: db.categorize }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      let patch: unknown = null;
      let columns = '';
      const q: Record<string, unknown> = {};
      const answer = () => {
        db.reads.push(table);
        db.selects.push({ table, columns });
        if (table === 'invoices') {
          if (patch) return { data: { id: INVOICE }, error: null };
          return { data: db.invoiceRow, error: null };
        }
        if (table === 'expenses') return { data: db.expenses[0] ?? null, error: null };
        if (table === 'memberships') return { data: { user_id: 'u-1' }, error: null };
        return { data: null, error: null };
      };
      Object.assign(q, {
        select: (cols: string) => { columns = cols; return q; },
        eq: () => q,
        limit: () => q,
        insert: (row: unknown) => { db.inserts.push({ table, row }); return q; },
        update: (p: unknown) => { patch = p; db.updates.push({ table, patch: p }); return q; },
        single: async () => {
          if (table === 'expenses') return { data: { id: 'exp-nowy' }, error: null };
          return answer();
        },
        maybeSingle: async () => answer(),
      });
      return q;
    },
  }),
}));

import { runAutoCategorizeInbox } from '@/lib/jobs/runners/auto-categorize-inbox';

const DANE = { invoiceId: INVOICE, tenantId: TENANT, environment: 'test' as const };

function context(): JobContext {
  return {
    attempt: 0,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    step: { run: async (_n, fn) => fn(), sleep: vi.fn(), sendEvent: vi.fn(), scheduleAfter: vi.fn() },
  };
}

function row(fa3: Record<string, unknown>, expenses: Array<{ id: string }> = []): Row {
  return {
    id: INVOICE,
    tenant_id: TENANT,
    direction: 'incoming',
    origin: 'ksef_inbox',
    ksef_status: 'accepted',
    ksef_environment: 'test',
    ksef_number: '5260001246-20260925-000000000001-00',
    internal_number: 'FV 1/2026',
    issue_date: '2026-09-25',
    seller_data: { name: 'Dostawca', nip: '5260001246' },
    seller_nip: '5260001246',
    gross_total: 123,
    net_total: 100,
    vat_total: 23,
    currency: 'PLN',
    fa3_data: fa3,
    invoice_line_items: [],
    expenses,
  };
}

beforeEach(() => {
  vi.stubEnv('KSEF_ENV', 'test');
  db.archive.mockReset();
  db.categorize.mockReset();
  db.categorize.mockResolvedValue({ kpir_column: 'col_13', category_label: 'Usługi', method: 'ai', confidence: 0.95 });
  db.archive.mockResolvedValue({ archived: true });
  db.reads = [];
  db.selects = [];
  db.inserts = [];
  db.updates = [];
  db.expenses = [];
  db.invoiceRow = null;
});
afterEach(() => vi.unstubAllEnvs());

describe('kategoryzacja: drugie zadanie tej samej faktury', () => {
  it('faktura domknięta: jeden odczyt, bez XML, bez AI, bez zapisu', async () => {
    db.invoiceRow = row({ _pendingFullFetch: false, _processedAt: '2026-09-25T12:00:00Z' }, [{ id: 'exp-1' }]);
    const result = await runAutoCategorizeInbox(DANE, context());

    expect(result).toEqual({ success: true, skipped: 'already-processed' });
    expect(db.reads).toEqual(['invoices']);
    expect(db.archive).not.toHaveBeenCalled();
    expect(db.categorize).not.toHaveBeenCalled();
    expect(db.inserts).toEqual([]);
    expect(db.updates).toEqual([]);
  });

  it('koszt już jest, tylko XML nie doszedł: pobiera XML, bez AI i bez drugiego kosztu', async () => {
    db.invoiceRow = row({ _pendingFullFetch: true }, [{ id: 'exp-1' }]);
    const result = await runAutoCategorizeInbox(DANE, context());

    expect(result).toEqual({ success: true, skipped: 'expense-exists' });
    expect(db.archive).toHaveBeenCalledOnce();
    expect(db.categorize).not.toHaveBeenCalled();
    expect(db.inserts).toEqual([]);
    // XML jest, więc znacznik gaśnie i cron przestaje wracać do tej faktury.
    expect(db.updates).toHaveLength(1);
    expect((db.updates[0]!.patch as { fa3_data: Row }).fa3_data._pendingFullFetch).toBe(false);
  });

  it('koszt jest, a XML znowu nie doszedł: znacznik zostaje, cron spróbuje ponownie', async () => {
    db.invoiceRow = row({ _pendingFullFetch: true }, [{ id: 'exp-1' }]);
    db.archive.mockResolvedValue({ archived: false, reason: 'download-failed' });
    await expect(runAutoCategorizeInbox(DANE, context())).resolves.toEqual({ success: true, skipped: 'expense-exists' });
    expect(db.updates).toEqual([]);
    expect(db.categorize).not.toHaveBeenCalled();
  });

  it('pierwsze zadanie: pełny przebieg jak dawniej (XML, kategoryzacja, koszt, znacznik)', async () => {
    db.invoiceRow = row({ _pendingFullFetch: true });
    await expect(runAutoCategorizeInbox(DANE, context())).resolves.toEqual({ success: true });
    expect(db.archive).toHaveBeenCalledOnce();
    expect(db.categorize).toHaveBeenCalledOnce();
    expect(db.inserts.filter((i) => i.table === 'expenses')).toHaveLength(1);
  });

  it('wiersz bez znacznika (stare dane) przechodzi pełną drogą: brak znacznika to nie „gotowe”', async () => {
    db.invoiceRow = row({});
    await expect(runAutoCategorizeInbox(DANE, context())).resolves.toEqual({ success: true });
    expect(db.categorize).toHaveBeenCalledOnce();
  });

  it('odczyt stanu pyta o koszt tym samym zapytaniem (jeden odczyt, nie dwa)', async () => {
    db.invoiceRow = row({ _pendingFullFetch: false }, [{ id: 'exp-1' }]);
    await runAutoCategorizeInbox(DANE, context());
    expect(db.selects[0]!.columns).toContain('expenses');
  });
});

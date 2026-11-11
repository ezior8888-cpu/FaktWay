import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';

import { memoryClient, type MemoryTables, type Row } from './helpers/baza-w-pamieci';

/**
 * Krok 1.3 planu kompletnej aplikacji, część 2: faktura do paragonu (FP,
 * `Fa/FP = 1`) przychodzi do skrzynki KSeF, a klient wgrał już zdjęcie
 * paragonu z NIP. Jeden zakup, dwa dokumenty: koszt nie może wejść dwa razy
 * (RP-FP-01, RP-KSEF-01).
 *
 * Prawdziwa ścieżka: runner skrzynki `runAutoCategorizeInbox`, a po nim
 * odczyty KPiR (`getKpirData`) i JPK_V7M (`fetchInvoicesForExport`,
 * `summarizeJpkV7m`) na tych samych wierszach. Atrapy tylko dla HTTP
 * (KSeF, magazyn plików, AI kategoryzacji, NBP) i bazy (w pamięci, z RPC
 * `match_receipt_to_ksef_invoice` odwzorowanym z migracji 00175; samą
 * funkcję SQL sprawdza `tests/rls-faktura-do-paragonu.test.ts`).
 */

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FP_INVOICE = '11111111-1111-4111-8111-111111111111';
const SELLER_NIP = '5260001246';
const XML_PATH = `${TENANT}/ksef-import/5260001246-20270205-0000000000FP-01.xml`;

const FIXTURE = readFileSync(join(process.cwd(), 'tests/fixtures/import-wiersze/daty-pozycji-fp-gtu.xml'), 'utf8');
const XML_FP = FIXTURE;
// `replaceAll`: komentarz nagłówka fikstury też wspomina `<FP>1</FP>`.
const XML_BEZ_FP = FIXTURE.replaceAll('<FP>1</FP>', '');

const http = vi.hoisted(() => ({
  xml: new Map<string, string>(),
  downloads: [] as string[],
}));
const state = vi.hoisted(() => ({ tables: {} as Record<string, Array<Record<string, unknown>>>, rpcFailures: 0 }));

vi.mock('@/lib/ksef/inbox-xml', () => ({
  archiveInboxInvoiceXml: async () => ({ archived: false, reason: 'has-xml' }),
}));
vi.mock('@/lib/storage/r2', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/storage/r2')>()),
  downloadFromR2: async (key: string) => {
    http.downloads.push(key);
    const xml = http.xml.get(key);
    if (xml === undefined) throw new Error(`R2 object not found: ${key}`);
    return Buffer.from(xml, 'utf8');
  },
}));
vi.mock('@/lib/categorization', () => ({
  categorizeExpense: async () => ({ kpir_column: 'col_13', category_label: 'Usługi', method: 'rule', confidence: 0.95 }),
}));
vi.mock('@/lib/nbp/client', () => ({ nbpRateForCost: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => db() }));

const { runAutoCategorizeInbox } = await import('@/lib/jobs/runners/auto-categorize-inbox');
const { getKpirData } = await import('@/lib/reports/kpir-data');
const { fetchInvoicesForExport } = await import('@/lib/exports/data-fetcher');
const { summarizeJpkV7m } = await import('@/lib/exports/jpk-v7m-generator');
const { kpirCostAmount } = await import('@/lib/categorization/kpir-cost');

/** RPC z migracji 00175 w pamięci: te same warunki co funkcja SQL. */
function matchReceiptRpc(tables: MemoryTables, args: Row) {
  const tenant = args.p_tenant_id;
  const invoiceExpenseId = args.p_invoice_expense_id;
  const ids = args.p_receipt_expense_ids as string[];
  const matches = (tables.expense_receipt_matches ??= []);
  const expenses = tables.expenses ?? [];
  const fp = expenses.find((e) => e.id === invoiceExpenseId && e.tenant_id === tenant && e.source === 'ksef_inbox' && e.ksef_invoice_id);
  if (!fp) return { data: null, error: { code: '42501', message: 'Receipt match requires a KSeF inbox expense' } };
  if (matches.some((m) => m.tenant_id === tenant && m.invoice_expense_id === invoiceExpenseId)) {
    return { data: 'already_recorded', error: null };
  }
  const linkedElsewhere = (id: unknown) => matches.some((m) => m.receipt_expense_id === id && m.status === 'linked');
  const valid = ids
    .filter((id) => {
      const e = expenses.find((x) => x.id === id && x.tenant_id === tenant);
      return e && e.source !== 'ksef_inbox' && !e.ksef_invoice_id && !linkedElsewhere(id);
    })
    .sort();
  if (valid.length === 0) return { data: 'no_candidates', error: null };
  const audit = (tables.audit_logs ??= []);
  if (args.p_auto_link === true && valid.length === 1 && ids.length === 1
      && !matches.some((m) => m.receipt_expense_id === valid[0] && m.status === 'candidate')) {
    const receipt = expenses.find((e) => e.id === valid[0])!;
    matches.push({
      tenant_id: tenant, invoice_expense_id: invoiceExpenseId, receipt_expense_id: receipt.id,
      status: 'linked', receipt_was_deductible: receipt.is_deductible,
    });
    receipt.is_deductible = false;
    audit.push({ tenant_id: tenant, action: 'expense.receipt_invoice_linked', entity_id: invoiceExpenseId });
    return { data: 'linked', error: null };
  }
  for (const id of valid) {
    matches.push({ tenant_id: tenant, invoice_expense_id: invoiceExpenseId, receipt_expense_id: id, status: 'candidate', receipt_was_deductible: null });
  }
  fp.is_reviewed = false;
  audit.push({ tenant_id: tenant, action: 'expense.receipt_invoice_candidates', entity_id: invoiceExpenseId });
  return { data: 'candidates', error: null };
}

/**
 * Baza w pamięci z osadzeniem `expenses!expenses_ksef_invoice_id_fkey(id)`
 * (pierwszy krok runnera) i RPC 00175.
 */
function db() {
  const tables = state.tables as MemoryTables;
  const client = memoryClient(tables);
  return {
    from(table: string) {
      const q = client.from(table) as unknown as Record<string, unknown> & {
        select: (cols?: string, o?: unknown) => unknown;
        insert: (p: Row | Row[]) => unknown;
        then: (ok: (v: { data: unknown; error: unknown }) => unknown, fail?: (e: unknown) => unknown) => Promise<unknown>;
      };
      if (table === 'expenses') {
        // Wartości domyślne kolumn z 00034 (`is_deductible`, `is_reviewed`, `document_type`).
        const insert = q.insert;
        const withDefaults = (r: Row): Row => ({ is_deductible: true, is_reviewed: false, document_type: 'invoice', ...r });
        q.insert = (p: Row | Row[]) => insert(Array.isArray(p) ? p.map(withDefaults) : withDefaults(p));
      }
      if (table !== 'invoices') return q;
      const select = q.select;
      const then = q.then;
      let embed = false;
      q.select = (cols?: string, o?: unknown) => {
        embed = Boolean(cols?.includes('expenses!expenses_ksef_invoice_id_fkey'));
        return select(cols, o);
      };
      q.then = (ok, fail) => then((res) => {
        if (embed && res.data && !Array.isArray(res.data)) {
          const invoice = res.data as Row;
          const linked = (tables.expenses ?? []).filter((e) => e.ksef_invoice_id === invoice.id).map((e) => ({ id: e.id }));
          return ok({ ...res, data: { ...invoice, expenses: linked } });
        }
        return ok(res);
      }, fail);
      return q;
    },
    async rpc(name: string, args: Row) {
      if (name !== 'match_receipt_to_ksef_invoice') return { data: null, error: { message: `unknown rpc ${name}` } };
      if (state.rpcFailures > 0) {
        state.rpcFailures -= 1;
        return { data: null, error: { message: 'connection reset' } };
      }
      return matchReceiptRpc(tables, args);
    },
  };
}

const ctx: JobContext = {
  attempt: 0,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  step: { run: async (_n, fn) => fn(), sleep: vi.fn(), sendEvent: vi.fn(), scheduleAfter: vi.fn() },
};
const EVENT = { invoiceId: FP_INVOICE, tenantId: TENANT, environment: 'test' as const };

/** Faktura tak, jak zapisuje ją odbiór skrzynki (`inbox-polling.ts`), z XML w archiwum. */
function fakturaFp(o: Row = {}): Row {
  return {
    id: FP_INVOICE,
    tenant_id: TENANT,
    direction: 'incoming',
    origin: 'ksef_inbox',
    ksef_status: 'accepted',
    ksef_environment: 'test',
    ksef_number: '5260001246-20270205-0000000000FP-01',
    internal_number: 'FP/1/02/2027',
    issue_date: '2027-02-05',
    currency: 'PLN',
    seller_data: null,
    seller_nip: SELLER_NIP,
    gross_total: 123,
    net_total: 100,
    vat_total: 23,
    xml_storage_path: XML_PATH,
    fa3_data: { _source: 'inbox-metadata', _pendingFullFetch: true, seller: { name: 'Sklep Przykład', nip: SELLER_NIP } },
    ...o,
  };
}

/** Paragon z NIP tak, jak zapisuje go OCR zdjęcia (`process-ocr.ts`: rodzaj z odczytu w `ocr_extracted_data`). */
function paragonZNip(id: string, issueDate: string, o: Row = {}): Row {
  return {
    id, tenant_id: TENANT, created_by: 'u-1', source: 'ocr_photo', ksef_invoice_id: null,
    is_deductible: true, is_reviewed: true, issue_date: issueDate,
    document_number: 'PAR 4711', document_type: 'invoice',
    seller_name: 'Sklep Przykład', seller_nip: '526-000-12-46', seller_address: null,
    net_amount: 100, vat_amount: 23, gross_amount: 123, vat_deductible_amount: 0, vat_rate: '23',
    kpir_column: 'col_13', category_label: 'Materiały biurowe',
    ocr_extracted_data: { document_type: 'simplified_invoice', issue_date: issueDate, gross_amount: 123 },
    ...o,
  };
}

function baza(invoice: Row, receipts: Row[], xml: string | null = XML_FP) {
  state.tables = {
    tenants: [{ id: TENANT, nip: '1234567890', name: 'Moja Firma', address_json: null, vat_exemption_basis: null }],
    memberships: [{ organization_id: TENANT, user_id: 'u-1', role: 'owner', status: 'active' }],
    invoices: [invoice],
    invoice_line_items: [],
    expenses: receipts.map((r) => ({ ...r })),
    expense_receipt_matches: [],
    audit_logs: [],
  };
  http.xml.clear();
  if (xml !== null && typeof invoice.xml_storage_path === 'string') http.xml.set(invoice.xml_storage_path, xml);
}

const tables = () => state.tables as MemoryTables;
const fpExpense = () => tables().expenses!.find((e) => e.ksef_invoice_id === FP_INVOICE);
const expense = (id: string) => tables().expenses!.find((e) => e.id === id);
const matches = () => tables().expense_receipt_matches!.map((m) => ({ receipt: m.receipt_expense_id, status: m.status }));

beforeEach(() => {
  vi.stubEnv('KSEF_ENV', 'test');
  http.downloads = [];
  state.rpcFailures = 0;
});
afterEach(() => vi.unstubAllEnvs());

describe('FP ze skrzynki KSeF i paragon z NIP: jeden koszt', () => {
  it('jeden pewny kandydat: paragon wypada z KPiR i odliczenia, koszt idzie z faktury', async () => {
    baza(fakturaFp(), [paragonZNip('par-1', '2027-01-20')]);
    await runAutoCategorizeInbox(EVENT, ctx);

    expect(fpExpense()).toMatchObject({ source: 'ksef_inbox', gross_amount: 123, vat_deductible_amount: 23, is_deductible: true });
    expect(matches()).toEqual([{ receipt: 'par-1', status: 'linked' }]);
    expect(tables().expense_receipt_matches![0]).toMatchObject({ invoice_expense_id: fpExpense()!.id, receipt_was_deductible: true });
    expect(expense('par-1')).toMatchObject({ is_deductible: false });
    expect(tables().audit_logs!.map((a) => a.action)).toEqual(['expense.receipt_invoice_linked']);
  });

  it('dwa pasujące paragony: nic się nie łączy samo, oba dokumenty z ostrzeżeniem do decyzji klienta', async () => {
    baza(fakturaFp(), [paragonZNip('par-1', '2027-01-20'), paragonZNip('par-2', '2027-02-01', { document_number: 'PAR 4712' })]);
    await runAutoCategorizeInbox(EVENT, ctx);

    expect(matches()).toEqual([
      { receipt: 'par-1', status: 'candidate' },
      { receipt: 'par-2', status: 'candidate' },
    ]);
    expect(expense('par-1')).toMatchObject({ is_deductible: true });
    expect(expense('par-2')).toMatchObject({ is_deductible: true });
    // Faktura czeka na decyzję: w Skrzynce status „Nowa”.
    expect(fpExpense()).toMatchObject({ is_reviewed: false, is_deductible: true });
  });

  it.each([
    ['paragon z 2026 r. (faktura uproszczona, VAT już odliczony w zamkniętym miesiącu)', paragonZNip('par-1', '2026-12-30'), fakturaFp({ issue_date: '2027-01-05' })],
    ['paragon w czwartym miesiącu przed FP (żądanie w terminie, faktura po 15. dniu)', paragonZNip('par-1', '2027-01-31'), fakturaFp({ issue_date: '2027-05-10' })],
  ])('niepewne dopasowanie: %s, tylko ostrzeżenie', async (_name, receipt, invoice) => {
    baza(invoice, [receipt]);
    await runAutoCategorizeInbox(EVENT, ctx);
    expect(matches()).toEqual([{ receipt: 'par-1', status: 'candidate' }]);
    expect(expense('par-1')).toMatchObject({ is_deductible: true });
  });

  it('XML faktury niedostępny: nie wiadomo, czy to FP, więc bez łączenia, z ostrzeżeniem', async () => {
    baza(fakturaFp({ xml_storage_path: null }), [paragonZNip('par-1', '2027-01-20')], null);
    await runAutoCategorizeInbox(EVENT, ctx);
    expect(matches()).toEqual([{ receipt: 'par-1', status: 'candidate' }]);
    expect(expense('par-1')).toMatchObject({ is_deductible: true });
  });
});

describe('bez pasującego paragonu: jak dziś', () => {
  it('zwykła faktura (bez FP) z paragonem o tej samej kwocie: bez połączenia i bez ostrzeżenia', async () => {
    baza(fakturaFp({ internal_number: 'FV/1/02/2027' }), [paragonZNip('par-1', '2027-01-20')], XML_BEZ_FP);
    await runAutoCategorizeInbox(EVENT, ctx);
    expect(fpExpense()).toMatchObject({ gross_amount: 123, is_reviewed: true });
    expect(matches()).toEqual([]);
    expect(expense('par-1')).toMatchObject({ is_deductible: true });
  });

  it.each([
    ['inny NIP sprzedawcy', paragonZNip('par-1', '2027-01-20', { seller_nip: '1111111111' })],
    ['inna kwota brutto', paragonZNip('par-1', '2027-01-20', { gross_amount: 123.01 })],
    ['paragon starszy niż okno', paragonZNip('par-1', '2026-09-30')],
    ['paragon wystawiony po fakturze', paragonZNip('par-1', '2027-02-06')],
    ['paragon bez NIP nabywcy', paragonZNip('par-1', '2027-01-20', { document_type: 'receipt', ocr_extracted_data: { document_type: 'receipt' } })],
    ['koszt z innej faktury KSeF', paragonZNip('par-1', '2027-01-20', { source: 'ksef_inbox', ksef_invoice_id: '22222222-2222-4222-8222-222222222222', document_type: 'invoice', ocr_extracted_data: null })],
  ])('FP bez kandydata (%s): koszt jak dziś, bez pobierania XML', async (_name, receipt) => {
    baza(fakturaFp(), [receipt]);
    await runAutoCategorizeInbox(EVENT, ctx);
    expect(fpExpense()).toMatchObject({ gross_amount: 123, vat_deductible_amount: 23, is_reviewed: true });
    expect(matches()).toEqual([]);
    expect(expense('par-1')).toMatchObject({ is_deductible: true });
    // Po scaleniu z krokiem 3.4 jeden odczyt pliku zostaje: warunki płatności
    // (`read-payment-terms`). Odczytu pod kątem FP (drugiego) nie ma.
    expect(http.downloads).toHaveLength(1);
  });

  it('korekta FP (kwota ujemna): jak dziś, bez szukania paragonu', async () => {
    baza(fakturaFp({ gross_total: -123, net_total: -100, vat_total: -23 }), [paragonZNip('par-1', '2027-01-20', { gross_amount: -123 })]);
    await runAutoCategorizeInbox(EVENT, ctx);
    expect(fpExpense()).toMatchObject({ gross_amount: -123 });
    expect(matches()).toEqual([]);
  });
});

describe('ponowienie od zera', () => {
  it('awaria po zapisie kosztu, przed połączeniem: drugie wykonanie łączy raz, trzecie nic nie zmienia', async () => {
    baza(fakturaFp(), [paragonZNip('par-1', '2027-01-20')]);
    state.rpcFailures = 1;
    await expect(runAutoCategorizeInbox(EVENT, ctx)).rejects.toThrow();
    expect(fpExpense()).toBeDefined();
    expect(matches()).toEqual([]);

    // pg-boss wykonuje cały handler ponownie: koszt już jest (`expense-exists`).
    await runAutoCategorizeInbox(EVENT, ctx);
    expect(matches()).toEqual([{ receipt: 'par-1', status: 'linked' }]);

    // Cron uzupełniający wysyła zdarzenie jeszcze raz (znacznik zapalony ponownie).
    const invoice = tables().invoices![0]!;
    invoice.fa3_data = { ...(invoice.fa3_data as Row), _pendingFullFetch: true };
    const before = JSON.stringify(tables());
    await runAutoCategorizeInbox(EVENT, ctx);
    const after = JSON.parse(JSON.stringify(tables())) as MemoryTables;
    const strip = (t: MemoryTables) => ({ ...t, invoices: t.invoices!.map(({ fa3_data: _f, ...rest }) => rest) });
    expect(strip(after)).toEqual(strip(JSON.parse(before) as MemoryTables));
    expect(tables().expenses!.filter((e) => e.ksef_invoice_id === FP_INVOICE)).toHaveLength(1);
    expect(tables().audit_logs).toHaveLength(1);
  });
});

describe('KPiR i JPK_V7M liczą koszt raz', () => {
  const FEB = { month: '2', year: '2027' };

  it('paragon i FP z lutego 2027 r.: w KPiR i w zakupach JPK tylko faktura', async () => {
    baza(fakturaFp(), [paragonZNip('par-1', '2027-02-01')]);
    await runAutoCategorizeInbox(EVENT, ctx);
    const fpId = fpExpense()!.id;

    const kpir = await getKpirData(db() as never, TENANT, FEB, new Date('2027-02-20T12:00:00Z'));
    expect(kpir.expenses.map((e) => e.id)).toEqual([fpId]);
    expect(kpir.expenses.reduce((sum, e) => sum + kpirCostAmount(e), 0)).toBe(100);

    const dane = await fetchInvoicesForExport(
      { tenantId: TENANT, periodStart: '2027-02-01', periodEnd: '2027-02-28', direction: 'issued', includeCorrections: true, includeExpenses: true },
      db() as never,
    );
    expect(dane.expenses.map((e) => e.id)).toEqual([fpId]);
    const jpk = summarizeJpkV7m({ issuedInvoices: [], expenses: dane.expenses });
    expect(jpk).toMatchObject({ purchaseCount: 1, purchaseNet: 100, vatDeductible: 23 });
  });
});

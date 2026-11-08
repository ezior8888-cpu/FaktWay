import ExcelJS from 'exceljs';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ admin: vi.fn() }));
// Strona KPiR pyta o tryb danych (dane przykładowe przed weryfikacją KSeF) — tu firma zweryfikowana.
vi.mock('@/lib/demo/tryb-danych', () => ({ trybDanych: async () => ({ tryb: 'prawdziwe', stan: 'C', verifiedAt: null }) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: mocks.admin }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
// Strony: sesja = ta sama atrapa bazy; karty panelu spoza tematu — puste.
vi.mock('@/lib/supabase/page-context', () => ({
  getPageContext: async () => ({ supabase: mocks.admin(), tenantId: 'firma-a' }),
}));
vi.mock('@/lib/dashboard/monthly-figures', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/dashboard/monthly-figures')>()),
  getMonthlyFigures: async () => ({ monthName: '', totalNet: 0, totalVat: 0, totalGross: 0, vatDueLabel: '', daysToVatDue: 0 }),
  getSalesSeries: async () => ({ months: [], currentSeries: [], prevSeries: [], currentMonthKey: '' }),
}));

import type { SupabaseClient } from '@supabase/supabase-js';

import KpirPage from '@/app/(dashboard)/reports/kpir/page';
import { getKpirData, kpirTotals } from '@/lib/reports/kpir-data';
import { KpirView } from '@/components/expenses/kpir-view';
import { KpirFinanceCard } from '@/components/przeplywy/finora/chart-finance';
import { getCashFlowData, type CashFlowData } from '@/lib/dashboard/cash-flow';
import { kpirRevenueNet } from '@/lib/categorization/kpir-revenue';
import { fetchInvoicesForExport } from '@/lib/exports/data-fetcher';
import type { JpkInvoice } from '@/lib/exports/jpk-fa-generator';
import { generateKpirXlsx } from '@/lib/exports/kpir-generator';
import { formatPlMoney } from '@/lib/format/pl';
import { fetchSettledAdvancesNet } from '@/lib/invoices/settled-advances';

/**
 * Faktura rozliczeniowa (ROZ) zapisuje PEŁNĄ wartość zamówienia, a zaliczki,
 * które rozlicza, są w KPiR osobno. Do 28.09 KPiR, eksport i „Przepływy”
 * sumowały jedno i drugie: zaliczka 10 000 + ROZ na 35 000 = 45 000 przychodu
 * zamiast 35 000.
 */

type Row = Record<string, unknown>;
type Filter = [string, string, unknown];

let tables: Record<string, Row[]>;
let queries: Array<{ table: string; filters: Filter[] }>;
let failWhen: ((table: string, filters: Filter[]) => boolean) | null;
const zapytanieOZaliczki = (table: string, filters: Filter[]) =>
  table === 'invoices' && filters.some(([, k, v]) => k === 'invoice_kind' && v === 'advance');

function database() {
  return {
    from(table: string) {
      const filters: Filter[] = [];
      const predicates: Array<(row: Row) => boolean> = [];
      let singular = false;
      let window: [number, number] | null = null;
      let head = false;
      let sortKey: string | null = null;
      // Atrapa zwraca TYLKO wybrane kolumny — inaczej brak kolumny w zapytaniu
      // strony (np. `advance_invoice_ids`) byłby niewidoczny w teście.
      let columns: string[] | null = null;
      const project = (row: Row): Row =>
        columns ? Object.fromEntries(columns.map((c) => [c, row[c]])) : row;
      const query = {
        select(selection = '*', options?: { head?: boolean }) {
          const parts = selection.split(',').map((s) => s.trim()).filter(Boolean);
          columns = parts.some((p) => p === '*' || /[():]/.test(p)) ? null : parts;
          head = Boolean(options?.head);
          return query;
        },
        // Kontrola proweniencji (#63): przyjęte faktury bez środowiska KSeF.
        or(expr: string) {
          const m = /^ksef_environment\.is\.null,ksef_environment\.neq\.(test|demo|production)$/.exec(expr);
          if (!m) throw new Error(`Unexpected OR filter ${expr}`);
          predicates.push((r) => r.ksef_environment == null || r.ksef_environment !== m[1]);
          return query;
        },
        eq(key: string, value: unknown) { filters.push(['eq', key, value]); predicates.push((r) => r[key] === value); return query; },
        in(key: string, values: unknown[]) { filters.push(['in', key, values]); predicates.push((r) => values.includes(r[key])); return query; },
        gte(key: string, value: string) { predicates.push((r) => String(r[key]) >= value); return query; },
        lte(key: string, value: string) { predicates.push((r) => String(r[key]) <= value); return query; },
        gt(key: string, value: string) { predicates.push((r) => String(r[key]) > value); return query; },
        lt(key: string, value: string) { predicates.push((r) => String(r[key]) < value); return query; },
        is(key: string, value: unknown) { filters.push(['is', key, value]); predicates.push((r) => (r[key] ?? null) === value); return query; },
        order(key?: string) { sortKey = key ?? null; return query; },
        limit() { return query; },
        range(from: number, to: number) { window = [from, to]; return query; },
        single() { singular = true; return query; },
        maybeSingle() { singular = true; return query; },
        then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) {
          queries.push({ table, filters });
          if (failWhen?.(table, filters)) {
            return Promise.resolve({ data: null, error: { code: 'XX000', message: 'awaria odczytu' } }).then(resolve, reject);
          }
          const matching = (tables[table] ?? []).filter((r) => predicates.every((p) => p(r)));
          if (sortKey) { const k = sortKey; matching.sort((a, b) => String(a[k]).localeCompare(String(b[k]))); }
          const rows = (window ? matching.slice(window[0], window[1] + 1) : matching).map(project);
          return Promise.resolve({ data: head ? null : singular ? rows[0] ?? null : rows, count: matching.length, error: null }).then(resolve, reject);
        },
      };
      return query;
    },
  };
}

const client = () => database() as unknown as SupabaseClient;

/** Karta „Przychody i koszty / Ten miesiąc” z `/przeplywy` dla wyniku `getCashFlowData`. */
function przeplywyHtml(data: CashFlowData): string {
  return renderToStaticMarkup(
    <KpirFinanceCard
      months={data.months}
      revenue={data.revenue}
      costs={data.costs}
      profit={data.profit}
      report={data.report}
      revenueChangePct={data.revenueChangePct}
      costsHint="none"
    />,
  );
}

function faktura(o: Row): Row {
  return {
    tenant_id: 'firma-a', direction: 'outgoing', invoice_kind: 'regular', ksef_status: 'accepted', ksef_environment: 'test',
    issue_date: '2026-09-10', net_total: 0, vat_total: 0, gross_total: 0,
    currency: 'PLN',
    advance_invoice_ids: [], fa3_data: null, buyer_data: { name: 'Klient' },
    ...o,
  };
}

beforeEach(() => {
  tables = {
    tenants: [{ id: 'firma-a', nip: '1234567890', name: 'Firma A', address_json: null }],
    invoices: [],
    invoice_line_items: [],
    expenses: [],
  };
  queries = [];
  failWhen = null;
  mocks.admin.mockReset().mockImplementation(database);
});

describe('kpirRevenueNet — reguła', () => {
  it.each([
    ['zwykła faktura: netto', { kind: 'regular', net: 1000 }, 1000],
    ['zaliczka: swoja kwota (moment ujęcia — sprawa księgowej)', { kind: 'advance', net: 10000 }, 10000],
    ['ROZ: pełna wartość minus zaliczki już w KPiR', { kind: 'final', net: 35000, settledAdvancesNet: 10000 }, 25000],
    ['ROZ bez zaliczek w KPiR (np. odrzucona w KSeF): pełna wartość', { kind: 'final', net: 35000, settledAdvancesNet: null }, 35000],
    ['ROZ na 100% zaliczki: zero', { kind: 'final', net: 5000, settledAdvancesNet: 5000 }, 0],
    ['korekta: bez zmian (konwencja kwot — C-01)', { kind: 'correction', net: -300, settledAdvancesNet: 999 }, -300],
    ['kwoty z bazy jako tekst (NUMERIC)', { kind: 'final', net: '1000.10', settledAdvancesNet: 250.05 }, 750.05],
  ])('%s', (_opis, input, oczekiwane) => {
    expect(kpirRevenueNet(input)).toBe(oczekiwane);
  });
});

describe('fetchSettledAdvancesNet — tylko zaliczki, które KPiR już liczy', () => {
  it('sumuje zaliczki tej firmy, wystawione, przyjęte przez KSeF; każdą raz', async () => {
    tables.invoices.push(
      faktura({ id: 'zal-1', invoice_kind: 'advance', net_total: 10000 }),
      faktura({ id: 'zal-2', invoice_kind: 'advance', net_total: '2500.50' }),
      faktura({ id: 'zal-odrzucona', invoice_kind: 'advance', ksef_status: 'rejected', net_total: 700 }),
      faktura({ id: 'zal-cudza', tenant_id: 'firma-b', invoice_kind: 'advance', net_total: 800 }),
      faktura({ id: 'zwykla', invoice_kind: 'regular', net_total: 900 }),
      faktura({ id: 'zal-odebrana', direction: 'incoming', invoice_kind: 'advance', net_total: 600 }),
    );
    const wynik = await fetchSettledAdvancesNet(client(), 'firma-a', [
      { id: 'roz-1', invoice_kind: 'final', advance_invoice_ids: ['zal-1', 'zal-2', 'zal-1', 'zal-odrzucona', 'zal-cudza', 'zwykla', 'zal-odebrana'] },
      { id: 'roz-pusta', invoice_kind: 'final', advance_invoice_ids: [] },
      { id: 'zwykla-z-tablica', invoice_kind: 'regular', advance_invoice_ids: ['zal-1'] },
    ]);
    expect(wynik).toEqual(new Map([['roz-1', 12500.5]]));
  });

  it('bez ROZ nie pyta bazy', async () => {
    await fetchSettledAdvancesNet(client(), 'firma-a', [{ id: 'x', invoice_kind: 'regular', advance_invoice_ids: [] }]);
    expect(queries).toEqual([]);
  });

  it('długa lista zaliczek idzie porcjami (adres zapytania PostgREST)', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `zal-${i}`);
    tables.invoices.push(...ids.map((id) => faktura({ id, invoice_kind: 'advance', net_total: 1 })));
    const wynik = await fetchSettledAdvancesNet(client(), 'firma-a', [
      { id: 'roz', invoice_kind: 'final', advance_invoice_ids: ids },
    ]);
    expect(wynik.get('roz')).toBe(150);
    expect(queries).toHaveLength(2);
    const porcje = queries.map((q) => (q.filters.find((f) => f[0] === 'in')?.[2] as unknown[]).length);
    expect(porcje).toEqual([100, 50]);
  });

  it('błąd odczytu rzuca — „nie wiem” to nie „zero zaliczek”', async () => {
    failWhen = zapytanieOZaliczki;
    await expect(
      fetchSettledAdvancesNet(client(), 'firma-a', [{ id: 'roz', invoice_kind: 'final', advance_invoice_ids: ['zal-1'] }]),
    ).rejects.toThrow(/zaliczek/);
  });
});

describe('eksport KPiR', () => {
  const zaliczka = faktura({ id: 'zal-1', internal_number: 'ZAL/1', invoice_kind: 'advance', issue_date: '2026-08-20', net_total: 10000 });
  const roz = faktura({ id: 'roz-1', internal_number: 'ROZ/1', invoice_kind: 'final', net_total: 35000, advance_invoice_ids: ['zal-1'] });
  const zwykla = faktura({ id: 'fv-1', internal_number: 'FV/1', net_total: 1000 });

  it('dane eksportu niosą sumę zaliczek przy ROZ (zaliczka z poprzedniego miesiąca też)', async () => {
    tables.invoices.push(zaliczka, roz, zwykla);
    const data = await fetchInvoicesForExport({
      tenantId: 'firma-a', periodStart: '2026-09-01', periodEnd: '2026-09-30', direction: 'issued',
    });
    const byNumber = new Map(data.issuedInvoices.map((inv) => [inv.invoiceNumber, inv]));
    expect(byNumber.get('ROZ/1')?.settledAdvancesNet).toBe(10000);
    expect(byNumber.get('FV/1')?.settledAdvancesNet).toBeUndefined();
  });

  it('arkusz: ROZ w kol. 7 i 9 tylko resztą, z uwagą; suma okresu bez dubla', async () => {
    const sprzedaz = (o: Partial<JpkInvoice>): JpkInvoice => ({
      invoiceNumber: 'X', currency: 'PLN', invoiceType: 'regular', issueDate: '2026-09-10', buyerName: 'Klient',
      netTotal: 0, vatTotal: 0, grossTotal: 0, lines: [], ...o,
    });
    const buffer = await generateKpirXlsx({
      issuer: { nip: '1234567890', name: 'Firma A' },
      periodStart: '2026-09-01',
      periodEnd: '2026-09-30',
      issuedInvoices: [
        sprzedaz({ invoiceNumber: 'ZAL/2', invoiceType: 'advance', issueDate: '2026-09-02', netTotal: 4000 }),
        sprzedaz({ invoiceNumber: 'ROZ/1', invoiceType: 'final', issueDate: '2026-09-10', netTotal: 35000, settledAdvancesNet: 10000 }),
        sprzedaz({ invoiceNumber: 'FV/1', issueDate: '2026-09-20', netTotal: 1000 }),
      ],
      expenses: [],
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    const sheet = wb.getWorksheet('KPiR')!;
    const cell = (row: number, col: number) => sheet.getRow(row).getCell(col).value;

    expect(cell(3, 3)).toBe('ROZ/1');
    expect(cell(3, 7)).toBe(25000);
    expect(cell(3, 9)).toBe(25000);
    expect(String(cell(3, 17))).toContain('ROZ: wartość zamówienia 35000.00 zł, rozliczone zaliczki 10000.00 zł');
    expect(cell(2, 7)).toBe(4000); // zaliczka bez zmian
    expect(cell(sheet.rowCount, 7)).toBe(30000); // 4000 + 25000 + 1000, nie 40000
    expect(cell(sheet.rowCount, 9)).toBe(30000);
  });
});

describe('KPiR w aplikacji i „Przepływy”', () => {
  const now = new Date();
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const wiersze = [
    { id: 'roz', internal_number: 'ROZ/1', issue_date: `${ym}-10`, sale_date: null, net_total: 35000, gross_total: 43050, buyer_data: null, invoice_kind: 'final' as const, settled_advances_net: 10000 },
    { id: 'fv', internal_number: 'FV/1', issue_date: `${ym}-12`, sale_date: null, net_total: 1000, gross_total: 1230, buyer_data: null, invoice_kind: 'regular' as const, settled_advances_net: null },
  ];

  it('KPiR: przychód okresu 26 000 (25 000 reszty ROZ + 1 000), wiersz ROZ z rozbiciem', () => {
    const html = renderToStaticMarkup(
      <KpirView month={now.getMonth() + 1} year={now.getFullYear()} expenses={[]} invoices={wiersze} />,
    );
    expect(html).toContain(formatPlMoney(26000));
    expect(html).not.toContain(formatPlMoney(36000));
    expect(html).toContain(formatPlMoney(25000));
    expect(html).toContain(`zamówienie ${formatPlMoney(35000)}, minus zaliczki${' '}${formatPlMoney(10000)}`);
    // Ta sama reguła w funkcji sum, z której liczy widok (plan Finora E8).
    expect(kpirTotals([], wiersze)).toMatchObject({ col_7: 26000, totalRevenue: 26000, profit: 26000 });
  });

  it('Przepływy: przychód i dochód miesiąca bez dubla', async () => {
    // Te same faktury co `wiersze`, ale w bazie: od E5 przychód `/przeplywy`
    // liczy `getCashFlowData` (zaliczki ROZ czyta sama).
    tables.invoices.push(
      faktura({ id: 'zal', internal_number: 'ZAL/1', invoice_kind: 'advance', issue_date: '2020-01-10', net_total: 10000 }),
      faktura({ id: 'roz', internal_number: 'ROZ/1', invoice_kind: 'final', issue_date: `${ym}-10`, net_total: 35000, advance_invoice_ids: ['zal'] }),
      faktura({ id: 'fv', internal_number: 'FV/1', issue_date: `${ym}-12`, net_total: 1000 }),
    );
    const data = await getCashFlowData(client() as never, 'firma-a');
    expect(data.report.revenue).toBe(26000);
    expect(data.report.profit).toBe(26000);
    const html = przeplywyHtml(data);
    expect(html).toContain(formatPlMoney(26000));
    expect(html).not.toContain(formatPlMoney(36000));
  });
});

describe('strony — podpięcie odczytu zaliczek', () => {
  const now = new Date();
  const key = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  const ten = key(now);
  // Zaliczki poza oknem 6 miesięcy „Przepływów” — inaczej suma półrocza
  // (zaliczki + reszty) równałaby się miesiącowi z dublem i test nic by nie mówił.
  const dawno = key(new Date(now.getFullYear(), now.getMonth() - 8, 1));

  // Dwie ROZ z RÓŻNYMI zaliczkami: sumy muszą trafić do właściwej faktury
  // (po `id`), a nie „jakiejś” — przy jednej ROZ pomyłka klucza byłaby niewidoczna.
  // Miesiąc: 25 000 + 4 000 + 1 000 = 30 000; z dublem 35 000 + 7 000 + 1 000 = 43 000.
  beforeEach(() => {
    tables.invoices.push(
      faktura({ id: 'zal-1', internal_number: 'ZAL/1', invoice_kind: 'advance', issue_date: `${dawno}-20`, net_total: 10000 }),
      faktura({ id: 'zal-2', internal_number: 'ZAL/2', invoice_kind: 'advance', issue_date: `${dawno}-21`, net_total: 3000 }),
      faktura({ id: 'roz-1', internal_number: 'ROZ/1', invoice_kind: 'final', issue_date: `${ten}-10`, net_total: 35000, advance_invoice_ids: ['zal-1'] }),
      faktura({ id: 'roz-2', internal_number: 'ROZ/2', invoice_kind: 'final', issue_date: `${ten}-11`, net_total: 7000, advance_invoice_ids: ['zal-2'] }),
      faktura({ id: 'fv-1', internal_number: 'FV/1', issue_date: `${ten}-12`, net_total: 1000 }),
    );
  });

  const okres = () => ({ month: String(now.getMonth() + 1), year: String(now.getFullYear()) });

  it('KPiR (getKpirData): każda ROZ dostaje sumę SWOICH zaliczek, przychód okresu 30 000', async () => {
    const data = await getKpirData(client(), 'firma-a', okres());
    const zaliczki = new Map(data.invoices.map((inv) => [inv.internal_number, inv.settled_advances_net]));
    expect(zaliczki).toEqual(new Map([['ROZ/1', 10000], ['ROZ/2', 3000], ['FV/1', null]]));
    expect(data).toMatchObject({ currencyBlocked: null, settledError: null });
    const sumy = kpirTotals(data.expenses, data.invoices);
    expect(sumy.totalRevenue).toBe(30000);
    expect(sumy.totalRevenue).not.toBe(43000);
  });

  it('KPiR (getKpirData): błąd odczytu zaliczek → settledError, nie zero zaliczek', async () => {
    failWhen = zapytanieOZaliczki;
    const data = await getKpirData(client(), 'firma-a', okres());
    expect(data.settledError).toContain('Nie można odczytać zaliczek rozliczonych fakturą końcową');
    expect(data.currencyBlocked).toBeNull();
  });

  it('KPiR (getKpirData): sprzedaż w EUR wstrzymuje raport i nie czyta zaliczek', async () => {
    tables.invoices.find((row) => row.id === 'fv-1')!.currency = 'EUR';
    const data = await getKpirData(client(), 'firma-a', okres());
    expect(data.currencyBlocked).toContain('Raport wstrzymany');
    expect(queries.some((q) => zapytanieOZaliczki(q.table, q.filters))).toBe(false);
  });

  it('KPiR: strona odejmuje każdej ROZ jej własne zaliczki (także sprzed miesięcy)', async () => {
    const page = await KpirPage({
      searchParams: Promise.resolve({ month: String(now.getMonth() + 1), year: String(now.getFullYear()) }),
    });
    const html = renderToStaticMarkup(page);
    expect(html).toContain(formatPlMoney(30000));
    expect(html).toContain(formatPlMoney(25000));
    expect(html).toContain(formatPlMoney(4000));
    expect(html).not.toContain(formatPlMoney(43000));
  });

  it('KPiR: błąd odczytu zaliczek widać na banerze (strona nie udaje, że liczy dobrze)', async () => {
    failWhen = zapytanieOZaliczki;
    const page = await KpirPage({
      searchParams: Promise.resolve({ month: String(now.getMonth() + 1), year: String(now.getFullYear()) }),
    });
    expect(renderToStaticMarkup(page)).toContain('Nie można odczytać zaliczek rozliczonych fakturą końcową');
  });

  it('Przepływy: przychód miesiąca 30 000, nie 43 000; każda ROZ ze swoimi zaliczkami', async () => {
    const html = przeplywyHtml(await getCashFlowData(client() as never, 'firma-a'));
    expect(html).toContain(formatPlMoney(30000));
    expect(html).not.toContain(formatPlMoney(43000));
    expect(html).not.toContain(formatPlMoney(37000)); // obie ROZ z zaliczką 3 000
  });

  it('Przepływy: błąd odczytu zaliczek idzie do granicy błędu, nie do zera', async () => {
    failWhen = zapytanieOZaliczki;
    await expect(getCashFlowData(client() as never, 'firma-a')).rejects.toThrow(/zaliczek/);
  });

  it('KPiR: faktura sprzedaży EUR wstrzymuje raport z kwotami PLN', async () => {
    tables.invoices.find((row) => row.id === 'fv-1')!.currency = 'EUR';
    const page = await KpirPage({
      searchParams: Promise.resolve({ month: String(now.getMonth() + 1), year: String(now.getFullYear()) }),
    });
    const html = renderToStaticMarkup(page);
    expect(html).toContain('Raport wstrzymany');
    expect(html).not.toContain(formatPlMoney(30000));
  });

  it('Przepływy: faktura sprzedaży EUR zatrzymuje obliczenie przychodu', async () => {
    tables.invoices.find((row) => row.id === 'fv-1')!.currency = 'EUR';
    await expect(getCashFlowData(client() as never, 'firma-a')).rejects.toThrow(/potwierdzonej waluty PLN/);
  });
});

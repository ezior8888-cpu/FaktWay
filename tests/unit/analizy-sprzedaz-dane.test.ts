import { beforeEach, describe, expect, it } from 'vitest';

import { clientMovers, clientShares, clientTotals, saleBuyerName } from '@/lib/analytics-finance/clients';
import { analyticsDataRange, monthKeysEnding, monthRange } from '@/lib/analytics-finance/months';
import { productBreakdown } from '@/lib/analytics-finance/products';
import { recurringClients } from '@/lib/analytics-finance/recurring';
import {
  getSalesInvoices,
  recentSales,
  salesMonthStats,
  salesOfMonth,
  salesTrend,
  type SaleInvoice,
} from '@/lib/analytics-finance/sales';
import { fetchProductLines } from '@/lib/dashboard/rankings';
import { OutgoingInvoiceCurrencyNotSupportedError } from '@/lib/exports/currency-guard';

import { fakePostgrest, type Read, type Row } from '../helpers/fake-postgrest';

/**
 * Analiza sprzedaży `/analizy/sprzedaz` (plan Finora P11, N2, §2.4). Jeden
 * odczyt faktur z filtrami 1:1 jak `getTopClients`: tylko przyjęte w aktywnym
 * środowisku (KSEF_ENV = 'test' w vitest.config.ts), PLN, korekta jako
 * różnica, ROZ bez rozliczonych zaliczek, komplet stron ponad 1000 wierszy.
 */

const TENANT = 'firma-a';
const NOW = new Date('2026-10-17T10:00:00Z');
const RANGE = analyticsDataRange(NOW);

let seq = 0;
function invoice(fields: Row = {}): Row {
  seq += 1;
  return {
    id: `inv-${String(seq).padStart(5, '0')}`,
    tenant_id: TENANT,
    direction: 'outgoing',
    ksef_status: 'accepted',
    ksef_environment: 'test',
    invoice_kind: 'regular',
    advance_invoice_ids: [],
    currency: 'PLN',
    issue_date: '2026-09-10',
    internal_number: `FV/${seq}/2026`,
    net_total: 0,
    vat_total: 0,
    gross_total: 0,
    buyer_nip: '1234567890',
    buyer_data: { name: 'Nabywca spółka z ograniczoną odpowiedzialnością' },
    is_b2c: false,
    ...fields,
  };
}

let lineSeq = 0;
function line(invoiceRow: Row, name: string, net: number, unit: string | null = 'usł.'): Row {
  lineSeq += 1;
  return { id: `line-${String(lineSeq).padStart(6, '0')}`, invoice_id: invoiceRow.id, name, unit, net_amount: net };
}

beforeEach(() => {
  seq = 0;
  lineSeq = 0;
});

function read(invoices: Row[], reads: Read[] = []) {
  return getSalesInvoices(fakePostgrest({ invoices }, reads), TENANT, RANGE);
}

/** Faktura po odczycie — do testów czystych funkcji. */
function sale(fields: Partial<SaleInvoice> = {}): SaleInvoice {
  seq += 1;
  return {
    id: `s-${String(seq).padStart(5, '0')}`,
    issueDate: '2026-10-05',
    number: null,
    kind: 'regular',
    net: 100,
    documentGross: 123,
    buyer_nip: '1111111111',
    buyer_data: { name: 'Klient A' },
    is_b2c: false,
    ...fields,
  };
}

describe('getSalesInvoices — §2.4 pkt 2, 4, 5, 6, 7', () => {
  it('okno strony: od miesiąca przed najstarszym w wyborze do końca bieżącego', () => {
    expect(RANGE).toEqual({ from: '2026-04-01', toExclusive: '2026-11-01' });
  });

  it('szkic i faktura z innego środowiska nie wchodzą do sprzedaży', async () => {
    const rows = await read([
      invoice({ net_total: 100 }),
      invoice({ net_total: 5000, ksef_status: 'draft', ksef_environment: null }),
      invoice({ net_total: 7000, ksef_environment: 'production' }),
      invoice({ net_total: 900, direction: 'incoming' }),
    ]);
    expect(rows.map((r) => r.net)).toEqual([100]);
  });

  it('przyjęta faktura bez środowiska zatrzymuje odczyt polskim komunikatem', async () => {
    await expect(read([invoice({ net_total: 100 }), invoice({ ksef_environment: null })]))
      .rejects.toThrow('Przyjęte faktury wymagają uzgodnienia środowiska KSeF');
  });

  it('faktura w EUR zatrzymuje odczyt (nie sumujemy EUR z PLN)', async () => {
    await expect(read([invoice({ net_total: 100 }), invoice({ net_total: 50, currency: 'EUR' })]))
      .rejects.toBeInstanceOf(OutgoingInvoiceCurrencyNotSupportedError);
  });

  it('korekta in minus to różnica w swoim miesiącu', async () => {
    const original = invoice({ issue_date: '2026-09-10', net_total: 1000 });
    const rows = await read([
      original,
      invoice({ issue_date: '2026-10-02', invoice_kind: 'correction', net_total: -300, parent_invoice_id: original.id }),
    ]);
    expect(salesOfMonth(rows, '2026-09')).toBe(1000);
    expect(salesOfMonth(rows, '2026-10')).toBe(-300);
  });

  it('zaliczka 1 000 zł + ROZ 3 000 zł = 3 000 zł sprzedaży (ROZ bez zaliczki)', async () => {
    const zal = invoice({ invoice_kind: 'advance', issue_date: '2026-08-10', net_total: 1000, gross_total: 1230 });
    const roz = invoice({
      invoice_kind: 'final', advance_invoice_ids: [zal.id], issue_date: '2026-09-10', net_total: 3000, gross_total: 3690,
    });
    const rows = await read([zal, roz]);
    expect(salesOfMonth(rows, '2026-08')).toBe(1000);
    expect(salesOfMonth(rows, '2026-09')).toBe(2000);
    // „Ostatnie faktury” pokazują brutto dokumentu bez zmian.
    expect(rows.find((r) => r.id === roz.id)?.documentGross).toBe(3690);
  });

  it('ROZ z zaliczką sprzed okna liczy tylko resztę', async () => {
    const zal = invoice({ invoice_kind: 'advance', issue_date: '2026-01-10', net_total: 1000 });
    const roz = invoice({ invoice_kind: 'final', advance_invoice_ids: [zal.id], issue_date: '2026-09-10', net_total: 3000 });
    const rows = await read([zal, roz]);
    expect(rows.map((r) => r.id)).toEqual([roz.id]);
    expect(salesOfMonth(rows, '2026-09')).toBe(2000);
  });

  it('ponad 1000 faktur: suma pełna mimo ucinania stron po stronie serwera', async () => {
    const reads: Read[] = [];
    const invoices = Array.from({ length: 1503 }, () => invoice({ net_total: 10 }));
    const rows = await read(invoices, reads);
    expect(rows).toHaveLength(1503);
    expect(salesOfMonth(rows, '2026-09')).toBe(15030);
    expect(reads.filter((r) => r.table === 'invoices' && r.range !== null).length).toBeGreaterThan(1);
  });
});

describe('salesMonthStats — kafle P11', () => {
  it('Sprzedano, Średnio na fakturę (bez korekt w liczniku), vs poprzedni, Najlepszy klient', () => {
    const stats = salesMonthStats([
      sale({ issueDate: '2026-09-03', net: 500 }),
      sale({ net: 600, buyer_nip: '2222222222', buyer_data: { name: 'Klient B' } }),
      sale({ net: 300 }),
      sale({ net: -100, kind: 'correction' }),
    ], '2026-10', '2026-09');
    expect(stats.total).toBe(800);
    expect(stats.invoiceCount).toBe(2);
    expect(stats.avgPerInvoice).toBe(400);
    expect(stats.changePct).toBeCloseTo(60);
    expect(stats.bestClient).toBe('Klient B');
  });

  it('bez poprzedniego miesiąca procent nie istnieje; bez faktur — brak średniej i klienta', () => {
    expect(salesMonthStats([sale()], '2026-10', '2026-09').changePct).toBeNull();
    const empty = salesMonthStats([], '2026-10', '2026-09');
    expect(empty).toEqual({ total: 0, invoiceCount: 0, avgPerInvoice: null, changePct: null, bestClient: null });
  });
});

describe('salesTrend i recentSales', () => {
  it('6 miesięcy z zerem dla pustych, podpisy po polsku', () => {
    const trend = salesTrend([sale({ issueDate: '2026-10-01', net: 10.1 }), sale({ issueDate: '2026-10-31', net: 20.2 })],
      monthKeysEnding('2026-10', 6));
    expect(trend.map((p) => p.label)).toEqual(['Maj', 'Cze', 'Lip', 'Sie', 'Wrz', 'Paź']);
    expect(trend.map((p) => p.amount)).toEqual([0, 0, 0, 0, 0, 30.3]);
  });

  it('najnowsze faktury miesiąca, od najnowszej', () => {
    const rows = [
      sale({ id: 'a', issueDate: '2026-10-01' }),
      sale({ id: 'b', issueDate: '2026-10-09' }),
      sale({ id: 'c', issueDate: '2026-09-30' }),
    ];
    expect(recentSales(rows, '2026-10', saleBuyerName).map((r) => r.id)).toEqual(['b', 'a']);
  });
});

describe('productBreakdown — §2.4 pkt 13 przez fetchProductLines', () => {
  async function lines(invoices: Row[], items: Row[]) {
    return fetchProductLines(fakePostgrest({ invoices, invoice_line_items: items }), TENANT, monthRange('2026-09'));
  }

  it('zaliczka 1 000 zł + ROZ 3 000 zł na tę samą usługę daje 3 000 zł, nie 4 000 zł', async () => {
    const zal = invoice({ invoice_kind: 'advance', net_total: 1000 });
    const roz = invoice({ invoice_kind: 'final', advance_invoice_ids: [zal.id], net_total: 3000 });
    const slices = productBreakdown(await lines([zal, roz], [line(zal, 'Wdrożenie', 1000), line(roz, 'Wdrożenie', 3000)]));
    expect(slices.map((s) => [s.label, s.amount])).toEqual([['Wdrożenie (usł.)', 3000]]);
  });

  it('korekta before_after 10 → 9 szt. nie dodaje sprzedaży', async () => {
    const original = invoice({ net_total: 1000 });
    const korekta = invoice({ invoice_kind: 'correction', net_total: -100 });
    const slices = productBreakdown(await lines(
      [original, korekta],
      [line(original, 'Kubek', 1000, 'szt.'), line(korekta, 'Kubek', 900, 'szt.')],
    ));
    expect(slices.map((s) => s.amount)).toEqual([1000]);
  });

  it('top 5 + „Pozostałe” jako suma pozostałych pozycji, nie sprzedaż ogółem minus top 5', async () => {
    const inv = invoice({ net_total: 2100 });
    const items = [600, 500, 400, 300, 200, 70, 30].map((net, i) => line(inv, `Usługa ${i + 1}`, net));
    // Pozycja ujemna (np. rabat jako osobna pozycja) nie zmniejsza „Pozostałych”.
    items.push(line(inv, 'Rabat', -50));
    const slices = productBreakdown(await lines([inv], items));
    expect(slices.map((s) => [s.label, s.amount, s.other])).toEqual([
      ['Usługa 1 (usł.)', 600, false],
      ['Usługa 2 (usł.)', 500, false],
      ['Usługa 3 (usł.)', 400, false],
      ['Usługa 4 (usł.)', 300, false],
      ['Usługa 5 (usł.)', 200, false],
      ['Pozostałe', 100, true],
    ]);
    expect(slices.reduce((s, x) => s + x.percentage, 0)).toBeCloseTo(100);
  });
});

describe('klienci — Udział, rośnie / spada', () => {
  it('nabywcy B2C to jedna pozycja „Konsumenci”, klient bez NIP-u po nazwie', () => {
    const totals = clientTotals([
      sale({ is_b2c: true, buyer_nip: null, buyer_data: { name: 'Jan Kowalski' }, net: 50 }),
      sale({ is_b2c: true, buyer_nip: null, buyer_data: { name: 'Anna Nowak' }, net: 70 }),
      sale({ buyer_nip: null, buyer_data: { name: 'Sklep Bez NIP' }, net: 30 }),
    ]);
    expect(totals.map((c) => [c.name, c.net])).toEqual([['Konsumenci', 120], ['Sklep Bez NIP', 30]]);
  });

  it('udział: top 5 + „Pozostali”, ostrzeżenie gdy jeden klient > 50%', () => {
    const rows = [
      sale({ buyer_nip: '1', buyer_data: { name: 'A' }, net: 600 }),
      ...['2', '3', '4', '5', '6', '7'].map((nip) => sale({ buyer_nip: nip, buyer_data: { name: `K${nip}` }, net: 10 })),
    ];
    const shares = clientShares(rows);
    expect(shares.slices.map((s) => [s.label, s.amount])).toEqual([
      ['A', 600], ['K2', 10], ['K3', 10], ['K4', 10], ['K5', 10], ['Pozostali', 20],
    ]);
    expect(shares.concentrated).toBe(true);
    expect(clientShares(rows.slice(1)).concentrated).toBe(false);
  });

  it('klient, który przestał kupować, spada o 100%; nowy klient nie ma procentu', () => {
    const window = { prevFrom: '2026-02-01', currentFrom: '2026-08-01', toExclusive: '2026-11-01' };
    const movers = clientMovers([
      sale({ buyer_nip: '1', buyer_data: { name: 'Rośnie' }, issueDate: '2026-05-10', net: 100 }),
      sale({ buyer_nip: '1', buyer_data: { name: 'Rośnie' }, issueDate: '2026-09-10', net: 150 }),
      sale({ buyer_nip: '2', buyer_data: { name: 'Odszedł' }, issueDate: '2026-06-10', net: 400 }),
      sale({ buyer_nip: '3', buyer_data: { name: 'Spada' }, issueDate: '2026-06-10', net: 200 }),
      sale({ buyer_nip: '3', buyer_data: { name: 'Spada' }, issueDate: '2026-10-10', net: 150 }),
      sale({ buyer_nip: '4', buyer_data: { name: 'Nowy' }, issueDate: '2026-10-10', net: 900 }),
      // Korekta in minus obniża klienta w swoim miesiącu.
      sale({ buyer_nip: '1', buyer_data: { name: 'Rośnie' }, issueDate: '2026-10-11', net: -25, kind: 'correction' }),
    ], window);
    expect(movers.gainers.map((m) => [m.name, m.percent])).toEqual([['Rośnie', 25]]);
    expect(movers.losers.map((m) => [m.name, m.percent])).toEqual([['Odszedł', -100], ['Spada', -25]]);
    expect(movers.gainers[0]?.subtitle).toBe('NIP 1');
  });
});

describe('recurringClients — N3', () => {
  const months = monthKeysEnding('2026-10', 4);

  it('klient w ≥ 3 z 4 miesięcy jest stały; średnia z jego miesięcy i typowy dzień', () => {
    const rows = [
      sale({ buyer_nip: '1', buyer_data: { name: 'Stały spółka akcyjna' }, issueDate: '2026-07-05', net: 100 }),
      sale({ buyer_nip: '1', buyer_data: { name: 'Stały spółka akcyjna' }, issueDate: '2026-08-07', net: 200 }),
      sale({ buyer_nip: '1', buyer_data: { name: 'Stały spółka akcyjna' }, issueDate: '2026-10-06', net: 300 }),
      sale({ buyer_nip: '2', buyer_data: { name: 'Rzadki' }, issueDate: '2026-07-05', net: 100 }),
      sale({ buyer_nip: '2', buyer_data: { name: 'Rzadki' }, issueDate: '2026-10-05', net: 100 }),
      // Poza oknem 4 miesięcy — nie liczy się.
      sale({ buyer_nip: '2', buyer_data: { name: 'Rzadki' }, issueDate: '2026-06-05', net: 100 }),
    ];
    expect(recurringClients(rows, months)).toEqual([
      { key: 'nip:1', name: 'Stały S.A.', averageAmount: 200, typicalDay: 6, months: 3 },
    ]);
  });

  it('miesiąc wyzerowany korektą nie liczy się jako miesiąc sprzedaży', () => {
    const rows = [
      sale({ issueDate: '2026-07-05', net: 100 }),
      sale({ issueDate: '2026-08-05', net: 100 }),
      sale({ issueDate: '2026-08-20', net: -100, kind: 'correction' }),
      sale({ issueDate: '2026-09-05', net: 100 }),
    ];
    expect(recurringClients(rows, months)).toEqual([]);
  });
});

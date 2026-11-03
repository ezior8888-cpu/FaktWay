import { describe, expect, it } from 'vitest';

import {
  getTopClients,
  getTopProducts,
  PRODUCTS_NOTE,
  rankProducts,
  warsawMonthWindow,
} from '@/lib/dashboard/rankings';
import { OutgoingInvoiceCurrencyNotSupportedError } from '@/lib/exports/currency-guard';
import type { PageContext } from '@/lib/supabase/page-context';

/**
 * Rankingi Pulpitu (PLAN-FINORA §5 P1, §2.4 pkt 2, 4, 5, 13). Produkty:
 * tylko faktury `regular` i `final` — ROZ trzyma stan PEŁNEGO zamówienia,
 * więc zaliczka dodana do pozycji dublowałaby sprzedaż, a pozycje korekty
 * to stan PO. Klienci: wszystkie rodzaje, korekta jako różnica, ROZ jako
 * reszta po zaliczkach. KSEF_ENV = 'test' (vitest.config.ts).
 */

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

/** PostgREST oddaje najwyżej tyle wierszy w jednej odpowiedzi. */
const SERVER_CAP = 1000;

/**
 * Baza w pamięci: filtry, których używa moduł, `count: 'exact'`, `head`,
 * sortowanie (także malejące), `range` i limit 1000 wierszy serwera. Zwraca
 * TYLKO wybrane kolumny — brakująca kolumna w zapytaniu wyszłaby jako błąd.
 */
/** Zapytanie zapamiętane przez atrapę: tabela, `range` i rozmiar `.in()`. */
type Read = { table: string; range: [number, number] | null; inSize: number | null };

function database(tables: Tables, reads: Read[] = []) {
  return {
    from(table: string) {
      const read: Read = { table, range: null, inSize: null };
      reads.push(read);
      const predicates: Array<(row: Row) => boolean> = [];
      const ordering: Array<{ column: string; ascending: boolean }> = [];
      let columns: string[] | null = null;
      let head = false;
      let counted = false;
      let window: [number, number] | null = null;
      const builder = {
        select(selection = '*', options?: { count?: string; head?: boolean }) {
          const parts = selection.split(',').map((s) => s.trim()).filter(Boolean);
          columns = parts.includes('*') ? null : parts;
          head = options?.head === true;
          counted = options?.count === 'exact';
          return builder;
        },
        eq(c: string, v: unknown) { predicates.push((r) => r[c] === v); return builder; },
        neq(c: string, v: unknown) { predicates.push((r) => r[c] !== v); return builder; },
        gt(c: string, v: number) { predicates.push((r) => Number(r[c]) > v); return builder; },
        gte(c: string, v: string) { predicates.push((r) => r[c] != null && String(r[c]) >= v); return builder; },
        lt(c: string, v: string) { predicates.push((r) => r[c] != null && String(r[c]) < v); return builder; },
        in(c: string, v: unknown[]) { read.inSize = v.length; predicates.push((r) => v.includes(r[c])); return builder; },
        is(c: string, v: null) { predicates.push((r) => (v === null ? r[c] == null : r[c] === v)); return builder; },
        overlaps(c: string, v: string[]) {
          predicates.push((r) => Array.isArray(r[c]) && (r[c] as string[]).some((x) => v.includes(x)));
          return builder;
        },
        order(column: string, options?: { ascending?: boolean }) {
          ordering.push({ column, ascending: options?.ascending !== false });
          return builder;
        },
        range(from: number, to: number) { window = [from, to]; read.range = [from, to]; return builder; },
        then<T>(resolve: (value: { data: Row[] | null; count: number | null; error: null }) => T) {
          const matching = (tables[table] ?? []).filter((r) => predicates.every((p) => p(r)));
          matching.sort((a, b) => {
            for (const { column, ascending } of ordering) {
              const x = String(a[column] ?? '');
              const y = String(b[column] ?? '');
              if (x !== y) return (x < y ? -1 : 1) * (ascending ? 1 : -1);
            }
            return 0;
          });
          const start = window?.[0] ?? 0;
          const wanted = window ? window[1] - window[0] + 1 : matching.length;
          const page = matching.slice(start, start + Math.min(wanted, SERVER_CAP));
          const data = page.map((r) => (columns ? Object.fromEntries(columns.map((c) => [c, r[c]])) : r));
          return Promise.resolve({
            data: head ? null : data,
            count: counted ? matching.length : null,
            error: null,
          }).then(resolve);
        },
      };
      return builder;
    },
  } as unknown as PageContext['supabase'];
}

const TENANT = 'firma-a';
const NOW = new Date('2026-10-17T10:00:00Z'); // 17.10.2026 w Warszawie → okno 12 mies. od 01.11.2025

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
    net_total: 0,
    vat_total: 0,
    gross_total: 0,
    buyer_nip: '1234567890',
    buyer_data: { name: 'Nabywca' },
    is_b2c: false,
    ...fields,
  };
}

let lineSeq = 0;
function line(invoiceRow: Row, name: string | null, net: number, unit: string | null = 'szt.', fields: Row = {}): Row {
  lineSeq += 1;
  return {
    id: `line-${String(lineSeq).padStart(6, '0')}`,
    invoice_id: invoiceRow.id,
    name,
    unit,
    net_amount: net,
    quantity: 1,
    ...fields,
  };
}

function products(invoices: Row[], lines: Row[], now: Date = NOW, reads: Read[] = []) {
  return getTopProducts(database({ invoices, invoice_line_items: lines }, reads), TENANT, now);
}

function clients(invoices: Row[], now: Date = NOW, reads: Read[] = []) {
  return getTopClients(database({ invoices }, reads), TENANT, now);
}

/** Odczyty stronicowane (z `range`) danej tabeli. */
function pagedReads(reads: Read[], table: string): Read[] {
  return reads.filter((r) => r.table === table && r.range !== null);
}

describe('warsawMonthWindow', () => {
  it('12 miesięcy kończy się bieżącym polskim miesiącem', () => {
    expect(warsawMonthWindow(NOW, 12)).toEqual({ from: '2025-11-01', toExclusive: '2026-11-01' });
    expect(warsawMonthWindow(NOW, 24)).toEqual({ from: '2024-11-01', toExclusive: '2026-11-01' });
  });

  it('1. dnia miesiąca o 00:30 w Polsce to już nowy miesiąc (§2.4 pkt 10)', () => {
    // 31.10.2026 23:30 UTC = 01.11.2026 00:30 w Warszawie.
    expect(warsawMonthWindow(new Date('2026-10-31T23:30:00Z'), 12))
      .toEqual({ from: '2025-12-01', toExclusive: '2026-12-01' });
  });

  it('okno przez przełom roku', () => {
    expect(warsawMonthWindow(new Date('2026-01-15T12:00:00Z'), 12))
      .toEqual({ from: '2025-02-01', toExclusive: '2026-02-01' });
  });
});

describe('getTopProducts — najlepiej sprzedające się (§2.4 pkt 13)', () => {
  it('podpis karty', () => {
    expect(PRODUCTS_NOTE).toBe('Bez korekt i nierozliczonych zaliczek');
  });

  it('zaliczka 1 000 zł + ROZ 3 000 zł na tę samą usługę daje 3 000 zł, nie 4 000 zł', async () => {
    const zal = invoice({ invoice_kind: 'advance', issue_date: '2026-06-10', net_total: 1000 });
    const roz = invoice({ invoice_kind: 'final', advance_invoice_ids: [zal.id], issue_date: '2026-08-10', net_total: 3000 });
    const result = await products([zal, roz], [line(zal, 'Wdrożenie systemu', 1000, 'usł.'), line(roz, 'Wdrożenie systemu', 3000, 'usł.')]);
    expect(result).toEqual([{ key: JSON.stringify(['wdrożenie systemu', 'usł.']), name: 'Wdrożenie systemu', unit: 'usł.', net: 3000 }]);
  });

  it('korekta before_after 10 → 9 szt. nie dodaje sprzedaży produktu', async () => {
    const vat = invoice({ issue_date: '2026-07-01', net_total: 1000 });
    const kor = invoice({ invoice_kind: 'correction', parent_invoice_id: vat.id, issue_date: '2026-08-01', net_total: -100 });
    const result = await products([vat, kor], [
      line(vat, 'Licencja', 1000, 'szt.', { quantity: 10 }),
      line(kor, 'Licencja', 900, 'szt.', { quantity: 9 }),
    ]);
    expect(result.map((p) => [p.name, p.net])).toEqual([['Licencja', 1000]]);
  });

  it('„ Usługa IT ” i „usługa it” z tą samą j.m. to jedna pozycja, z inną j.m. osobna', async () => {
    const older = invoice({ issue_date: '2026-03-01' });
    const newer = invoice({ issue_date: '2026-09-01' });
    const result = await products([older, newer], [
      line(older, ' Usługa IT ', 100, 'h'),
      line(newer, 'usługa it', 200, 'h'),
      line(newer, 'Usługa IT', 50, 'szt.'),
      line(newer, 'Usługa IT', 30, null),
    ]);
    expect(result.map((p) => [p.name, p.unit, p.net])).toEqual([
      ['usługa it', 'h', 300], // nazwa z najnowszej pozycji grupy
      ['Usługa IT', 'szt.', 50],
      ['Usługa IT', null, 30],
    ]);
  });

  it('pomija inne środowisko KSeF, szkice, faktury innej firmy i spoza 12 miesięcy', async () => {
    const ok = invoice();
    const prod = invoice({ ksef_environment: 'production' });
    const draft = invoice({ ksef_status: 'draft', ksef_environment: null });
    const other = invoice({ tenant_id: 'firma-b' });
    const old = invoice({ issue_date: '2025-10-31' });
    const incoming = invoice({ direction: 'incoming' });
    const result = await products(
      [ok, prod, draft, other, old, incoming],
      [ok, prod, draft, other, old, incoming].map((inv) => line(inv, 'Towar', 100)),
    );
    expect(result).toEqual([expect.objectContaining({ name: 'Towar', net: 100 })]);
  });

  it('okno liczy „dziś” po polsku: 1.11 o 00:30 bierze fakturę z 1.11, a nie z listopada rok wcześniej', async () => {
    const nov = invoice({ issue_date: '2026-11-01' });
    const lastNov = invoice({ issue_date: '2025-11-20' });
    const result = await products([nov, lastNov], [line(nov, 'Nowa', 10), line(lastNov, 'Stara', 20)], new Date('2026-10-31T23:30:00Z'));
    expect(result.map((p) => p.name)).toEqual(['Nowa']);
  });

  it('faktura w EUR zatrzymuje kartę', async () => {
    const eur = invoice({ currency: 'EUR' });
    await expect(products([eur], [line(eur, 'Towar', 100)])).rejects.toBeInstanceOf(OutgoingInvoiceCurrencyNotSupportedError);
  });

  it('przyjęta faktura bez środowiska zatrzymuje kartę', async () => {
    const unknown = invoice({ ksef_environment: null });
    await expect(products([invoice(), unknown], [])).rejects.toThrow('Przyjęte faktury wymagają uzgodnienia środowiska KSeF');
  });

  it('czyta komplet pozycji: 150 faktur × 8 pozycji (2 paczki .in, pierwsza ma 800 pozycji na 2 stronach po 500)', async () => {
    const invs = Array.from({ length: 150 }, () => invoice());
    const lines = invs.flatMap((inv) => Array.from({ length: 8 }, () => line(inv, 'Abonament', 1.25, 'mies.')));
    const reads: Read[] = [];
    const result = await products(invs, lines, NOW, reads);
    expect(result).toEqual([expect.objectContaining({ name: 'Abonament', net: 1500 })]);
    // Paczka 100 faktur: strony 0–499 i 500–999; paczka 50 faktur: jedna strona.
    // Sesja 19 (QRY-05): paczki idą naraz, więc pierwsza strona drugiej paczki
    // wychodzi przed drugą stroną pierwszej; strony jednej paczki dalej po kolei.
    expect(pagedReads(reads, 'invoice_line_items').map((r) => [r.inSize, r.range]))
      .toEqual([[100, [0, 499]], [50, [0, 499]], [100, [500, 999]]]);
  });

  it('501 faktur: faktury na 2 stronach, pozycje w 6 paczkach .in, suma pełna', async () => {
    const invs = Array.from({ length: 501 }, () => invoice({ net_total: 2 }));
    const lines = invs.map((inv) => line(inv, 'Serwis', 2, 'usł.'));
    const reads: Read[] = [];
    const result = await products(invs, lines, NOW, reads);
    expect(result).toEqual([expect.objectContaining({ name: 'Serwis', net: 1002 })]);
    expect(pagedReads(reads, 'invoices').map((r) => r.range)).toEqual([[0, 499], [500, 999]]);
    expect(pagedReads(reads, 'invoice_line_items').map((r) => r.inSize))
      .toEqual([100, 100, 100, 100, 100, 1]);
  });

  it('bez faktur — pusta lista', async () => {
    expect(await products([], [])).toEqual([]);
  });
});

describe('rankProducts — kolejność i limit', () => {
  it('malejąco po netto, remis po kluczu, tylko netto > 0, top 5', () => {
    const lines = ['F', 'E', 'D', 'C', 'B', 'A'].map((name, i) => ({
      id: `l-${i}`, issue_date: '2026-09-01', name, unit: 'szt.', net_amount: 100,
    }));
    lines.push({ id: 'l-zero', issue_date: '2026-09-01', name: 'Zero', unit: 'szt.', net_amount: 0 });
    lines.push({ id: 'l-top', issue_date: '2026-09-01', name: 'Top', unit: 'szt.', net_amount: '250.50' as unknown as number });
    expect(rankProducts(lines).map((p) => [p.name, p.net])).toEqual([
      ['Top', 250.5], ['A', 100], ['B', 100], ['C', 100], ['D', 100],
    ]);
  });

  it('j.m. z odstępami to ta sama j.m., a pusta j.m. to brak j.m.', () => {
    const result = rankProducts([
      { id: 'a', issue_date: '2026-09-01', name: 'Usługa', unit: ' szt ', net_amount: 100 },
      { id: 'b', issue_date: '2026-09-02', name: 'Usługa', unit: 'szt', net_amount: 50 },
      { id: 'c', issue_date: '2026-09-03', name: 'Usługa', unit: '', net_amount: 30 },
      { id: 'd', issue_date: '2026-09-04', name: 'Usługa', unit: null, net_amount: 20 },
    ]);
    expect(result.map((p) => [p.unit, p.net])).toEqual([['szt', 150], [null, 50]]);
  });
});

describe('getTopClients — najwięksi klienci', () => {
  it('NIP z myślnikami to ten sam klient; nazwa z najnowszej faktury, forma prawna skrócona', async () => {
    const result = await clients([
      invoice({ buyer_nip: '123-456-78-90', buyer_data: { name: 'Stara Nazwa' }, issue_date: '2026-01-10', net_total: 1000 }),
      invoice({ buyer_nip: '1234567890', buyer_data: { name: 'Alfa spółka z ograniczoną odpowiedzialnością' }, issue_date: '2026-09-10', net_total: 500 }),
    ]);
    expect(result).toEqual([{
      key: 'nip:1234567890', name: 'Alfa sp. z o.o.', nip: '1234567890', consumers: false,
      net: 1500, prevNet: 0, changePct: null,
    }]);
  });

  it('nabywcy B2C to jedna pozycja „Konsumenci”', async () => {
    const result = await clients([
      invoice({ is_b2c: true, buyer_nip: null, buyer_data: { name: 'Jan Kowalski' }, net_total: 100 }),
      invoice({ is_b2c: true, buyer_nip: null, buyer_data: { name: 'Anna Nowak' }, net_total: 50 }),
    ]);
    expect(result).toEqual([expect.objectContaining({ key: 'b2c', name: 'Konsumenci', nip: null, consumers: true, net: 150 })]);
  });

  it('1203 faktury jednego NIP-u: odczyt na 3 stronach, netto pełne', async () => {
    const invs = Array.from({ length: 1203 }, () =>
      invoice({ buyer_nip: '1234567890', buyer_data: { name: 'Gamma' }, net_total: 10 }));
    const reads: Read[] = [];
    const result = await clients(invs, NOW, reads);
    expect(result).toEqual([expect.objectContaining({ key: 'nip:1234567890', net: 12030 })]);
    expect(pagedReads(reads, 'invoices').map((r) => r.range))
      .toEqual([[0, 499], [500, 999], [1000, 1499]]);
  });

  it('korekta in minus obniża klienta w swoim miesiącu', async () => {
    const vat = invoice({ net_total: 5000, issue_date: '2026-05-10' });
    const result = await clients([
      vat,
      invoice({ invoice_kind: 'correction', parent_invoice_id: vat.id, net_total: -1000, issue_date: '2026-06-10' }),
    ]);
    expect(result[0]!.net).toBe(4000);
  });

  it('ROZ z zaliczką sprzed okna liczy tylko resztę', async () => {
    const zal = invoice({ invoice_kind: 'advance', issue_date: '2024-09-10', net_total: 1000 });
    const roz = invoice({ invoice_kind: 'final', advance_invoice_ids: [zal.id], issue_date: '2026-05-10', net_total: 3000 });
    const result = await clients([zal, roz]);
    expect(result).toEqual([expect.objectContaining({ net: 2000, prevNet: 0 })]);
  });

  it('zmiana % względem poprzednich 12 miesięcy; nowy klient ma null', async () => {
    const result = await clients([
      invoice({ buyer_nip: '1111111111', buyer_data: { name: 'Stały' }, issue_date: '2025-03-10', net_total: 1000 }),
      invoice({ buyer_nip: '1111111111', buyer_data: { name: 'Stały' }, issue_date: '2026-03-10', net_total: 1500 }),
      invoice({ buyer_nip: '2222222222', buyer_data: { name: 'Nowy' }, issue_date: '2026-03-10', net_total: 800 }),
      invoice({ buyer_nip: '3333333333', buyer_data: { name: 'Odszedł' }, issue_date: '2025-03-10', net_total: 9000 }),
    ]);
    expect(result.map((c) => [c.name, c.net, c.prevNet, c.changePct])).toEqual([
      ['Stały', 1500, 1000, 50],
      ['Nowy', 800, 0, null],
    ]);
  });

  it('bez NIP-u klucz to nazwa; bez NIP-u i nazwy faktura odpada', async () => {
    const result = await clients([
      invoice({ buyer_nip: null, buyer_data: { name: ' Beta ' }, net_total: 100 }),
      invoice({ buyer_nip: '', buyer_data: { name: 'beta' }, net_total: 50 }),
      invoice({ buyer_nip: null, buyer_data: {}, net_total: 999 }),
    ]);
    expect(result).toEqual([expect.objectContaining({ key: 'name:beta', nip: null, net: 150 })]);
  });

  it('pomija inne środowisko i szkice; EUR i brak środowiska zatrzymują kartę', async () => {
    expect(await clients([
      invoice({ ksef_environment: 'production', net_total: 100 }),
      invoice({ ksef_status: 'draft', ksef_environment: null, net_total: 100 }),
    ])).toEqual([]);
    await expect(clients([invoice({ currency: 'EUR', net_total: 100 })]))
      .rejects.toBeInstanceOf(OutgoingInvoiceCurrencyNotSupportedError);
    await expect(clients([invoice({ ksef_environment: null, net_total: 100 })]))
      .rejects.toThrow('Przyjęte faktury wymagają uzgodnienia środowiska KSeF');
  });
});

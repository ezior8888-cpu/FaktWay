import { describe, expect, it } from 'vitest';

import { getRecentInvoices } from '@/lib/dashboard/recent-invoices';
import type { PageContext } from '@/lib/supabase/page-context';

/**
 * Karta „Ostatnie faktury” (PLAN-FINORA §5 P1): ten sam zbiór i kolejność co
 * domyślna lista `/invoices` (sprzedaż tej firmy, wszystkie statusy
 * i środowiska, `created_at` malejąco, potem `id` malejąco), płatność jak
 * w kolumnie listy (`loadInvoiceListRowFacts`). KSEF_ENV = 'test'.
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
function database(tables: Tables) {
  return {
    from(table: string) {
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
        in(c: string, v: unknown[]) { predicates.push((r) => v.includes(r[c])); return builder; },
        is(c: string, v: null) { predicates.push((r) => (v === null ? r[c] == null : r[c] === v)); return builder; },
        overlaps(c: string, v: string[]) {
          predicates.push((r) => Array.isArray(r[c]) && (r[c] as string[]).some((x) => v.includes(x)));
          return builder;
        },
        order(column: string, options?: { ascending?: boolean }) {
          ordering.push({ column, ascending: options?.ascending !== false });
          return builder;
        },
        range(from: number, to: number) { window = [from, to]; return builder; },
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
const NOW = new Date('2026-10-17T10:00:00Z');

function invoice(id: string, createdAt: string, fields: Row = {}): Row {
  return {
    id,
    tenant_id: TENANT,
    created_at: createdAt,
    internal_number: `FV/${id}`,
    buyer_data: { name: `Nabywca ${id}` },
    direction: 'outgoing',
    origin: 'app',
    ksef_status: 'accepted',
    ksef_environment: 'test',
    ksef_number: null,
    invoice_kind: 'regular',
    invoice_type: 'VAT',
    currency: 'PLN',
    gross_total: 1230,
    paid_amount: 0,
    payment_data: null,
    payment_due_date: '2026-10-30',
    payment_status: 'unpaid',
    parent_invoice_id: null,
    advance_invoice_ids: [],
    ...fields,
  };
}

describe('getRecentInvoices', () => {
  it('kolejność i limit 5 jak domyślna lista faktur', async () => {
    const rows = [
      invoice('a1', '2026-10-01T08:00:00Z'),
      invoice('a2', '2026-10-05T08:00:00Z'),
      invoice('a3', '2026-10-05T08:00:00Z'), // remis created_at → id malejąco
      invoice('a4', '2026-10-10T08:00:00Z', { ksef_environment: 'production' }), // inne środowisko też na liście
      invoice('a5', '2026-09-20T08:00:00Z'),
      invoice('a6', '2026-10-12T08:00:00Z'),
      invoice('a7', '2026-08-01T08:00:00Z'),
      invoice('in1', '2026-10-16T08:00:00Z', { direction: 'incoming' }),
      invoice('b1', '2026-10-16T08:00:00Z', { tenant_id: 'firma-b' }),
    ];
    const result = await getRecentInvoices(database({ invoices: rows }), TENANT, NOW);
    expect(result.map((r) => r.id)).toEqual(['a6', 'a4', 'a3', 'a2', 'a1']);
    // Faktura z innego środowiska jest na liście, ale płatności nie liczymy.
    expect(result.find((r) => r.id === 'a4')!.payment).toBeNull();
  });

  it('szkic ma płatność null, faktura po terminie „overdue”, opłacona „paid”', async () => {
    const rows = [
      invoice('d1', '2026-10-15T08:00:00Z', { ksef_status: 'draft', ksef_environment: null }),
      invoice('o1', '2026-10-14T08:00:00Z', { payment_due_date: '2026-10-16' }),
      invoice('p1', '2026-10-13T08:00:00Z', { payment_status: 'paid', paid_amount: 1230 }),
      invoice('u1', '2026-10-12T08:00:00Z', { payment_due_date: '2026-10-17' }),
    ];
    const result = await getRecentInvoices(database({ invoices: rows }), TENANT, NOW);
    expect(result.map((r) => [r.id, r.payment])).toEqual([
      ['d1', null],
      ['o1', 'overdue'],
      ['p1', 'paid'],
      ['u1', 'unpaid'], // termin dziś to jeszcze nie „po terminie”
    ]);
  });

  it('faktura z korektą nie jest należnością — płatność null, jak na liście', async () => {
    const rows = [
      invoice('k1', '2026-10-15T08:00:00Z', { invoice_kind: 'correction', invoice_type: 'KOR', parent_invoice_id: 'v1', gross_total: -100 }),
      invoice('v1', '2026-10-10T08:00:00Z', { payment_due_date: '2026-10-01' }),
    ];
    const result = await getRecentInvoices(database({ invoices: rows }), TENANT, NOW);
    expect(result.map((r) => [r.id, r.payment])).toEqual([['k1', null], ['v1', null]]);
  });

  it('pola wiersza: nazwa ze skróconą formą prawną, numer, brutto, termin, status KSeF', async () => {
    const rows = [invoice('x1', '2026-10-15T08:00:00Z', {
      buyer_data: { name: 'Gamma  spółka z ograniczoną odpowiedzialnością' },
      gross_total: '2460.50',
    })];
    const [row] = await getRecentInvoices(database({ invoices: rows }), TENANT, NOW);
    expect(row).toEqual({
      id: 'x1',
      internalNumber: 'FV/x1',
      buyerName: 'Gamma sp. z o.o.',
      gross: 2460.5,
      currency: 'PLN',
      paymentDueDate: '2026-10-30',
      payment: 'unpaid',
      ksefStatus: 'accepted',
    });
  });

  it('bez faktur — pusta lista', async () => {
    expect(await getRecentInvoices(database({ invoices: [] }), TENANT, NOW)).toEqual([]);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ admin: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: mocks.admin }));

import { fetchInvoicesForExport } from '@/lib/exports/data-fetcher';
import { amountsOf } from '@/lib/exports/jpk-fa-generator';

/**
 * S-01 (sygnał z rozpoznania żelaznego filtra, plan B7.1; WAGA KRYTYCZNA):
 * korekta „przed/po” zapisuje pozycje w stanie PO (`linesToStoredItems`
 * w components/invoices/correction-actions.ts), a JPK_V7M i JPK_FA liczą
 * kwoty z pozycji (`amountsOf`). Korekta faktury 1 000 zł netto do 800 zł
 * trafiłaby więc do ewidencji jako +800 zł netto i +184 zł VAT zamiast
 * różnicy -200 zł i -46 zł. Faktura korygująca w KSeF (FA(3) KOR) ma w P_13
 * i P_14 różnicę (`differenceSummaries` w lib/ksef/fa3-correction-generator.ts),
 * a JPK ma wykazać to samo, co jest w KSeF.
 */

type Row = Record<string, unknown>;
let tables: Record<string, Row[]>;
let failAdvances = false;

function database() {
  return {
    from(table: string) {
      const predicates: Array<(r: Row) => boolean> = [];
      const filters: Array<[string, unknown]> = [];
      let columns: string[] | null = null;
      let singular = false;
      let window: [number, number] | null = null;
      let head = false;
      let sortKey: string | null = null;
      const query = {
        // Tylko wybrane kolumny — brak kolumny w zapytaniu ma być widoczny.
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
        eq(k: string, v: unknown) { filters.push([k, v]); predicates.push((r) => r[k] === v); return query; },
        in(k: string, vs: unknown[]) { predicates.push((r) => vs.includes(r[k])); return query; },
        gte(k: string, v: string) { predicates.push((r) => String(r[k]) >= v); return query; },
        lte(k: string, v: string) { predicates.push((r) => String(r[k]) <= v); return query; },
        gt(k: string, v: string) { predicates.push((r) => String(r[k]) > v); return query; },
        order(key?: string) { sortKey = key ?? null; return query; },
        limit() { return query; },
        range(a: number, b: number) { window = [a, b]; return query; },
        single() { singular = true; return query; },
        maybeSingle() { singular = true; return query; },
        then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) {
          if (failAdvances && table === 'invoices' && filters.some(([k, v]) => k === 'invoice_kind' && v === 'advance')) {
            return Promise.resolve({ data: null, error: { message: 'awaria' } }).then(resolve, reject);
          }
          const project = (r: Row): Row => (columns ? Object.fromEntries(columns.map((c) => [c, r[c]])) : r);
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

function faktura(o: Row): Row {
  return {
    tenant_id: 'firma-a', direction: 'outgoing', invoice_kind: 'regular', ksef_status: 'accepted', ksef_environment: 'test',
    issue_date: '2026-09-10', net_total: 0, vat_total: 0, gross_total: 0, advance_invoice_ids: [],
    fa3_data: null, buyer_data: { name: 'Klient' }, seller_data: null, internal_number: null, ksef_number: null,
    ...o,
  };
}


const PRZED = { ordinal: 1, name: 'Usługa', unit: 'usł.', quantity: 1, unitPriceNet: 1000, vatRate: '23' };
const PO = { ...PRZED, unitPriceNet: 800 };

beforeEach(() => {
  tables = { tenants: [{ id: 'firma-a', nip: '5260001246', name: 'ACME', address_json: null }], invoices: [], invoice_line_items: [], expenses: [] };
  failAdvances = false;
  mocks.admin.mockReset().mockImplementation(database);
});

describe('S-01: korekta „przed/po” w JPK to różnica, nie stan po', () => {
  it('JPK_V7M i JPK_FA dostają różnicę stawki (-200 zł netto, -46 zł VAT), tak jak P_13 i P_14 faktury korygującej w KSeF', async () => {
    tables.invoices.push(
      faktura({
        id: 'fv-1', internal_number: 'FV/1/09/2026', issue_date: '2026-09-02', net_total: 1000, vat_total: 230, gross_total: 1230,
        fa3_data: { lines: [{ ...PRZED, netAmount: 1000, vatAmount: 230, grossAmount: 1230 }] },
      }),
      faktura({
        id: 'kor-1', internal_number: 'KOR/1/09/2026', invoice_kind: 'correction', correction_type: 'before_after', parent_invoice_id: 'fv-1',
        issue_date: '2026-09-20', net_total: -200, vat_total: -46, gross_total: -246,
        // Tak zapisuje dziś createCorrectionInvoiceAction: pozycje w stanie po, koperta z obu stanami w special_data.
        fa3_data: { lines: [{ ...PO, netAmount: 800, vatAmount: 184, grossAmount: 984 }] },
        special_data: { correctionData: { correctionType: 'before_after', linesBefore: [PRZED], linesAfter: [PO] } },
      }),
    );
    const dane = await fetchInvoicesForExport({ tenantId: 'firma-a', periodStart: '2026-09-01', periodEnd: '2026-09-30', direction: 'issued' });
    const korekta = dane.issuedInvoices.find((i) => i.invoiceNumber === 'KOR/1/09/2026');
    expect(korekta?.invoiceType).toBe('correction');
    expect(amountsOf(korekta!)).toEqual({ rates: [{ rate: '23', net: -200, vat: -46 }], p15: -246 });
  });

  it('korekta „przed/po” bez danych stanu przed: brak w JPK z nazwą dokumentu, nie cicha kwota po', async () => {
    tables.invoices.push(
      faktura({
        id: 'kor-2', internal_number: 'KOR/2/09/2026', invoice_kind: 'correction', correction_type: 'before_after',
        issue_date: '2026-09-21', net_total: -200, vat_total: -46, gross_total: -246,
        fa3_data: { lines: [{ ...PO, netAmount: 800, vatAmount: 184, grossAmount: 984 }] },
        special_data: null,
      }),
    );
    const dane = await fetchInvoicesForExport({ tenantId: 'firma-a', periodStart: '2026-09-01', periodEnd: '2026-09-30', direction: 'issued' });
    const korekta = dane.issuedInvoices.find((i) => i.invoiceNumber === 'KOR/2/09/2026');
    expect(() => amountsOf(korekta!)).toThrow(/KOR\/2\/09\/2026/);
  });
});

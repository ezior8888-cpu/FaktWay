import ExcelJS from 'exceljs';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/ksef/claim-environment', () => ({
  requireConfiguredKsefEnvironment: () => 'production',
}));

import { getCashFlowData } from '@/lib/dashboard/cash-flow';
import { estimateIncomeTaxThisYear } from '@/lib/dashboard/tax-estimate';
import { OutgoingInvoiceCurrencyNotSupportedError } from '@/lib/exports/currency-guard';
import type { JpkInvoice } from '@/lib/exports/jpk-fa-generator';
import { generateKpirXlsx } from '@/lib/exports/kpir-generator';
import { getKpirData } from '@/lib/reports/kpir-data';
import { blockingSaleInvoices } from '@/components/reports/kpir/kpir-model';
import type { PageContext } from '@/lib/supabase/page-context';

/**
 * Krok 1.2, ustalenie 1 z #509: KPiR w Raportach, plik Excel KPiR, szacunek
 * podatku i przepływy nie liczą FP jak zwykłej sprzedaży (sprzedaż z paragonu
 * weszła już raportem z kasy). W okresie z FP: brak sumy, komunikat z numerem
 * dokumentu i wyjściem (protokół napraw, pkt 4). FP rozpoznaje funkcja z #509.
 */

type Row = Record<string, unknown>;
const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WYJSCIE = /Przychód za ten (okres|miesiąc) ustal z raportów kasy/;

function faktura(o: Row): Row {
  return {
    tenant_id: TENANT, direction: 'outgoing', currency: 'PLN', ksef_status: 'accepted',
    ksef_environment: 'production', issue_date: '2026-09-10', net_total: 1000, gross_total: 1230,
    sale_date: '2026-09-10', invoice_kind: 'regular', advance_invoice_ids: [], buyer_data: null,
    ...o,
  };
}

/** Atrapa PostgREST: filtruje po wierszach, zwraca pełne wiersze (aliasy kolumn są w wierszu). */
function client(invoices: Row[]) {
  const rows = invoices.map((r, i) => ({ id: `inv-${String(i).padStart(4, '0')}`, ...r }));
  return {
    from(table: string) {
      const preds: Array<(r: Row) => boolean> = [];
      let head = false;
      let count = false;
      const q: Record<string, unknown> = {};
      Object.assign(q, {
        select: (_c: string, o?: { head?: boolean; count?: string }) => { head = o?.head === true; count = o?.count === 'exact'; return q; },
        eq: (c: string, v: unknown) => (preds.push((r) => r[c] === v), q),
        is: (c: string, v: unknown) => (preds.push((r) => (r[c] ?? null) === v), q),
        in: (c: string, vs: unknown[]) => (preds.push((r) => vs.includes(r[c])), q),
        gte: (c: string, v: string) => (preds.push((r) => String(r[c]) >= v), q),
        lte: (c: string, v: string) => (preds.push((r) => String(r[c]) <= v), q),
        lt: (c: string, v: string) => (preds.push((r) => String(r[c]) < v), q),
        or: () => q,
        order: () => q,
        range: () => q,
        then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => {
          const src = table === 'invoices' ? rows : [];
          const m = src.filter((r) => preds.every((p) => p(r)));
          return Promise.resolve({ data: head ? null : m, count: head ? 0 : count ? m.length : null, error: null }).then(ok, ko);
        },
      });
      return q;
    },
  } as unknown as PageContext['supabase'];
}

async function blad(p: Promise<unknown>): Promise<Error> {
  try { await p; } catch (e) { return e as Error; }
  throw new Error('Oczekiwano odmowy zamiast sumy');
}

const FP_Z_FAKTWAY = { internal_number: 'FV/9/2026', receipt: { receiptNumber: '000123', receiptDate: '2026-09-10', cashRegisterNumber: 'ABC1234567890' } };
const FP_Z_IMPORTU = { internal_number: 'FV/IMP/1', ksef_fp: 'true' };

describe('KPiR w Raportach (getKpirData)', () => {
  it.each([['z FaktWay', FP_Z_FAKTWAY], ['z importu KSeF', FP_Z_IMPORTU]])('FP %s: raport wstrzymany z numerem faktury i wyjściem', async (_n, fp) => {
    const data = await getKpirData(client([faktura({ internal_number: 'FV/1/2026' }), faktura(fp)]), TENANT, { month: '9', year: '2026' });
    expect(data.currencyBlocked).toContain(String(fp.internal_number));
    expect(data.currencyBlocked).toMatch(/faktura do paragonu/i);
    expect(data.currencyBlocked).toMatch(WYJSCIE);
    expect(data.currencyBlocked).toMatch(/dwa razy/);
    // Wyjście na ekranie: link do faktury FP w stanie „Raport wstrzymany”.
    expect(blockingSaleInvoices(data.invoices).map((i) => i.number)).toEqual([String(fp.internal_number)]);
  });

  it('straż regresji: miesiąc bez FP liczy się jak dotąd', async () => {
    const data = await getKpirData(client([faktura({ internal_number: 'FV/1/2026' })]), TENANT, { month: '9', year: '2026' });
    expect(data.currencyBlocked).toBeNull();
    expect(data.invoices).toHaveLength(1);
  });

  it('FP z innego miesiąca nie blokuje tego miesiąca', async () => {
    const data = await getKpirData(client([faktura({ ...FP_Z_FAKTWAY, issue_date: '2026-08-10' }), faktura({})]), TENANT, { month: '9', year: '2026' });
    expect(data.currencyBlocked).toBeNull();
  });
});

describe('Excel KPiR (generateKpirXlsx)', () => {
  const sprzedaz = (o: Partial<JpkInvoice>): JpkInvoice => ({
    invoiceNumber: 'FV/1', currency: 'PLN', invoiceType: 'regular', issueDate: '2026-09-03', buyerName: 'Klient',
    netTotal: 1000, vatTotal: 230, grossTotal: 1230, lines: [], ...o,
  });
  const dane = (issuedInvoices: JpkInvoice[]) => ({
    issuer: { nip: '1234567890', name: 'Firma' }, periodStart: '2026-09-01', periodEnd: '2026-09-30', issuedInvoices, expenses: [],
  });

  it('FP (znacznik FP z FaktWay albo z pliku KSeF): odmowa z numerem i wyjściem, bez pliku', async () => {
    const e = await blad(generateKpirXlsx(dane([sprzedaz({}), sprzedaz({ invoiceNumber: 'FV/FP/7', ksefMarkers: { fp: true } })])));
    expect(e).toBeInstanceOf(OutgoingInvoiceCurrencyNotSupportedError); // te same obsługi błędu co przy walucie (route, job, karty)
    expect(e.message).toContain('FV/FP/7');
    expect(e.message).toMatch(WYJSCIE);
  });

  it('straż regresji: bez FP plik powstaje i ma przychód', async () => {
    const buffer = await generateKpirXlsx(dane([sprzedaz({})]));
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    expect(wb.getWorksheet('KPiR')!.getRow(2).getCell(7).value).toBe(1000);
  });
});

describe('szacunek podatku i przepływy', () => {
  it('estimateIncomeTaxThisYear: FP w roku odmawia, nie liczy podatku od podwójnego przychodu', () => {
    const e = (() => {
      try {
        estimateIncomeTaxThisYear(
          [{ issue_date: '2026-09-10', net_total: 1000, invoice_kind: 'regular', ...FP_Z_FAKTWAY }],
          [], new Date('2026-10-01T10:00:00Z'), '2026-01-01',
        );
      } catch (err) { return err as Error; }
      return null;
    })();
    expect(e?.message).toContain('FV/9/2026');
    expect(e?.message).toMatch(WYJSCIE);
  });

  it('estimateIncomeTaxThisYear: bez FP liczy jak dotąd (19% z 1000 zł)', () => {
    const t = estimateIncomeTaxThisYear(
      [{ issue_date: '2026-09-10', net_total: 1000, invoice_kind: 'regular' }],
      [], new Date('2026-10-01T10:00:00Z'), '2026-01-01',
    );
    expect(t.amount).toBe(190);
  });

  it('getCashFlowData: FP w oknie odczytu odmawia z numerem faktury i wyjściem', async () => {
    const e = await blad(getCashFlowData(client([faktura({}), faktura(FP_Z_FAKTWAY)]), TENANT, new Date('2026-09-15T12:00:00Z')));
    expect(e).toBeInstanceOf(OutgoingInvoiceCurrencyNotSupportedError);
    expect(e.message).toContain('FV/9/2026');
    expect(e.message).toMatch(WYJSCIE);
  });

  it('getCashFlowData: straż regresji, bez FP przychód września to 1000', async () => {
    const data = await getCashFlowData(client([faktura({})]), TENANT, new Date('2026-09-15T12:00:00Z'));
    expect(data.revenue.at(-1)).toBe(1000);
  });
});

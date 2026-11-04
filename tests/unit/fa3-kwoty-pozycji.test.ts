import { describe, expect, it } from 'vitest';

import type { ParsedInvoice, ParsedLine } from '@/lib/import/fa3-parser';
import { fa3ImportLineAmounts, legacyLineAmounts } from '@/lib/import/fa3-line-amounts';

/**
 * C5c: czysty rozkład kwot pozycji (`lib/import/fa3-line-amounts.ts`) —
 * przypadki, których nie da się wygodnie zbudować z pliku generatora.
 */

function line(position: number, vatRate: string, ksef: ParsedLine['ksef']): ParsedLine {
  return { position, name: `Poz ${position}`, unit: 'szt.', quantity: 1, unitPriceNet: 0, vatRate, netAmount: 0, ksef };
}
function invoice(lines: ParsedLine[], ksefSums: ParsedInvoice['ksefSums'], o: Partial<ParsedInvoice> = {}): ParsedInvoice {
  return {
    invoiceNumber: 'FV/T/1', issueDate: '2026-09-10', invoiceType: 'regular',
    seller: { name: 'S' }, buyer: { name: 'N' }, lines,
    totals: { netTotal: 0, vatTotal: 0, grossTotal: 0 }, warnings: [], ksefSums, ...o,
  };
}

describe('fa3ImportLineAmounts', () => {
  it('plik spoza KSeF (bez ksefSums) → jak dotąd, bajt w bajt (VAT = netto × stawka)', () => {
    const l = { ...line(1, '23', undefined), netAmount: 0.1, unitPriceNet: 0.1 };
    const inv = invoice([l, { ...l, position: 2 }, { ...l, position: 3 }], undefined);
    const result = fa3ImportLineAmounts(inv);
    expect(result.rows).toEqual([1, 2, 3].map((n) => ({ ordinal: n, unitPriceNet: 0.1, netAmount: 0.1, vatAmount: 0.02, grossAmount: 0.12 })));
    expect(result.problems).toEqual([]);
    expect(result).not.toHaveProperty('ksefLineFields');
    expect(legacyLineAmounts({ ...l, vatRate: 'zw', netAmount: 50 })).toMatchObject({ vatAmount: 0, grossAmount: 50 });
  });

  it('kwota nieczytelna (przecinek, tekst) → problem, nigdy ciche 0', () => {
    const r = fa3ImportLineAmounts(invoice([line(1, '23', { P_11A: '12,30' })], { P_13_1: '10.00', P_14_1: '2.30', P_15: '12.30' }));
    expect(r.problems).toEqual(['pozycja 1: P_11A „12,30” nieczytelne']);
  });

  it('P_11Vat ≠ P_11A − P_11 → problem z kwotami', () => {
    const r = fa3ImportLineAmounts(invoice([line(1, '23', { P_11: '100.00', P_11A: '123.00', P_11Vat: '22.00' })], { P_13_1: '100.00', P_14_1: '23.00', P_15: '123.00' }));
    expect(r.problems).toEqual(['pozycja 1: P_11A − P_11 = 23.00 ≠ P_11Vat 22.00']);
  });

  it('stawka bez podatku z VAT pozycji → problem', () => {
    const r = fa3ImportLineAmounts(invoice([line(1, 'zw', { P_11A: '50.00', P_11Vat: '1.00' })], { P_13_7: '50.00', P_15: '50.00' }));
    expect(r.problems).toEqual(['pozycja 1: stawka zw bez podatku, a VAT 1.00']);
  });

  it('dwie ujemne pozycje brutto → podłoga w stronę −∞, VAT z nagłówka co do grosza', () => {
    // −10,00 i −1,00 brutto przy 23%: KP = round(−11,00 × 23 / 123) = −2,06.
    const r = fa3ImportLineAmounts(invoice(
      [line(1, '23', { P_11A: '-10.00' }), line(2, '23', { P_11A: '-1.00' })],
      { P_13_1: '-8.94', P_14_1: '-2.06', P_15: '-11.00' },
    ));
    expect(r.problems).toEqual([]);
    expect(r.rows.map((x) => x.vatAmount)).toEqual([-1.87, -0.19]);
    expect(r.rows.map((x) => x.netAmount)).toEqual([-8.13, -0.81]);
  });

  it('stawka 23% i 22% w jednej sumie P_13_1 → reszty porównane na krzyż (różne mianowniki), nie surowo', () => {
    // 1,00 brutto przy 23% (pozycja 1) i 1,37 przy 22% (pozycja 2): obie reszty = 86,
    // ale 86/122 > 86/123 — grosz dostaje 22%, mimo wyższego numeru pozycji.
    const r = fa3ImportLineAmounts(invoice(
      [line(1, '23', { P_11A: '1.00' }), line(2, '22', { P_11A: '1.37' })],
      { P_13_1: '1.94', P_14_1: '0.43', P_15: '2.37' },
    ));
    expect(r.problems).toEqual([]);
    expect(r.rows.map((x) => x.vatAmount)).toEqual([0.18, 0.25]);
  });

  it.each([
    ['stawka bez VAT: netto pozycji o grosz ≠ suma nagłówka', [line(1, 'zw', { P_11: '50.01' })], { P_13_7: '50.00', P_15: '50.00' }, /stawka zw: netto pozycji 50\.01 ≠ netto z nagłówka 50\.00/],
    ['pozycja bez P_11 i P_11A', [line(1, '23', {}), line(2, '23', { P_11: '100.00' })], { P_13_1: '100.00', P_14_1: '23.00', P_15: '123.00' }, /pozycja 1: brak wartości/],
    ['suma jednej stawki brakuje, druga jest, pozycje niezerowe', [line(1, '23', { P_11: '100.00' }), line(2, '8', { P_11: '50.00' })], { P_13_1: '100.00', P_14_1: '23.00', P_15: '177.00' }, /stawka 8: brak sum P_13_2\/P_14_2 w nagłówku, a pozycje mają 50\.00/],
    ['nieczytelna suma nagłówka', [line(1, '23', { P_11: '100.00' })], { P_13_1: '100,00', P_14_1: '23.00', P_15: '123.00' }, /nagłówek: P_13_1 „100,00” nieczytelne/],
    ['ceny brutto przy taksówkach (4%)', [line(1, '4', { P_11A: '104.00' })], { P_13_4: '100.00', P_14_4: '4.00', P_15: '104.00' }, /pozycja 1: ceny brutto przy stawce 4/],
  ])('%s → problem z nazwą', (_name, lines, sums, problem) => {
    const r = fa3ImportLineAmounts(invoice(lines as ParsedLine[], sums as ParsedInvoice['ksefSums']));
    expect(r.problems.join(' | ')).toMatch(problem);
  });

  it('brak wartości pozycji przy sumach nagłówka → bez „kwoty faktury nieznane” (KPiR liczy z nagłówka)', () => {
    const r = fa3ImportLineAmounts(invoice([line(1, '23', {}), line(2, '23', { P_11: '100.00' })], { P_13_1: '100.00', P_14_1: '23.00', P_15: '123.00' }));
    expect(r.totalsUnknown).toBeUndefined();
  });

  it('stawka bez sumy w nagłówku, pozycje sumują się do 0 → bez zatrzymania (brak sumy = 0)', () => {
    const r = fa3ImportLineAmounts(invoice(
      [line(1, '23', { P_11: '100.00' }), line(2, '8', { P_11: '10.00' }), line(3, '8', { P_11: '-10.00' })],
      { P_13_1: '100.00', P_14_1: '23.00', P_15: '123.00' },
    ));
    expect(r.problems).toEqual([]);
    expect(r.rows.map((x) => x.vatAmount)).toEqual([23, 0.8, -0.8]);
  });

  describe('faktura bez sum stawek (uproszczona) — kwoty faktury z pozycji, sprawdzone z P_15', () => {
    it('ceny brutto przy zw (P_11A 50 + 30, P_15 80) → netto faktury 80, VAT 0', () => {
      const r = fa3ImportLineAmounts(invoice([line(1, 'zw', { P_11A: '50.00' }), line(2, 'zw', { P_11A: '30.00' })], { P_15: '80.00' }));
      expect(r.problems).toEqual([]);
      expect(r.totals).toEqual({ netTotal: 80, vatTotal: 0 });
      expect(r.totalsUnknown).toBeUndefined();
    });

    it('VAT pozycji z pliku (P_11A − P_11) przy jednej stawce → z pliku, brutto = P_11A', () => {
      const r = fa3ImportLineAmounts(invoice(
        [line(1, '23', { P_11: '0.10', P_11A: '0.13' }), line(2, '23', { P_11: '0.10', P_11A: '0.12' }), line(3, '23', { P_11: '0.10', P_11A: '0.12' })],
        { P_15: '0.37' },
      ));
      expect(r.problems).toEqual([]);
      expect(r.rows.map((x) => x.vatAmount)).toEqual([0.03, 0.02, 0.02]);
      expect(r.rows.map((x) => x.grossAmount)).toEqual([0.13, 0.12, 0.12]);
      expect(r.totals).toEqual({ netTotal: 0.3, vatTotal: 0.07 });
    });

    it('dwie stawki netto (23% 3 × 0,10 i 8% 1,00, P_15 1,45) → VAT od sumy każdej stawki: 0,07 i 0,08', () => {
      const r = fa3ImportLineAmounts(invoice(
        [line(1, '23', { P_11: '0.10' }), line(2, '23', { P_11: '0.10' }), line(3, '23', { P_11: '0.10' }), line(4, '8', { P_11: '1.00' })],
        { P_15: '1.45' },
      ));
      expect(r.problems).toEqual([]);
      expect(r.rows.map((x) => x.vatAmount)).toEqual([0.03, 0.02, 0.02, 0.08]);
      expect(r.totals).toEqual({ netTotal: 1.3, vatTotal: 0.15 });
    });

    it('ceny brutto przy 23% bez sum (P_11A 123, P_15 123) → VAT ze wzoru ust. 7: 23,00, netto 100', () => {
      const r = fa3ImportLineAmounts(invoice([line(1, '23', { P_11A: '123.00' })], { P_15: '123.00' }));
      expect(r.problems).toEqual([]);
      expect(r.rows[0]).toMatchObject({ netAmount: 100, vatAmount: 23, grossAmount: 123 });
      expect(r.totals).toEqual({ netTotal: 100, vatTotal: 23 });
    });

    it('wystawca zsumował VAT pozycji (3 × 0,10, P_15 0,36) → VAT stawki z P_15: 0,06, mieści się w podziale', () => {
      const r = fa3ImportLineAmounts(invoice([line(1, '23', { P_11: '0.10' }), line(2, '23', { P_11: '0.10' }), line(3, '23', { P_11: '0.10' })], { P_15: '0.36' }));
      expect(r.problems).toEqual([]);
      expect(r.rows.map((x) => x.vatAmount)).toEqual([0.02, 0.02, 0.02]);
      expect(r.totals).toEqual({ netTotal: 0.3, vatTotal: 0.06 });
    });

    it('P_15 poza możliwym podziałem jedynej stawki netto (3 × 0,10, P_15 0,40) → zatrzymane', () => {
      const r = fa3ImportLineAmounts(invoice([line(1, '23', { P_11: '0.10' }), line(2, '23', { P_11: '0.10' }), line(3, '23', { P_11: '0.10' })], { P_15: '0.40' }));
      expect(r.problems).toEqual(['brutto pozycji 0.37 ≠ P_15 0.40']);
      expect(r.totalsUnknown).toBe(true);
      expect(r.totals).toBeUndefined();
    });

    it('dwie stawki netto i pozycje ≠ P_15 → bez zgadywania, której stawki dotyczy różnica', () => {
      const r = fa3ImportLineAmounts(invoice([line(1, '23', { P_11: '0.10' }), line(2, '23', { P_11: '0.10' }), line(3, '23', { P_11: '0.10' }), line(4, '8', { P_11: '1.00' })], { P_15: '1.44' }));
      expect(r.problems).toEqual(['brutto pozycji 1.45 ≠ P_15 1.44']);
      expect(r.totalsUnknown).toBe(true);
    });

    it('ujemna wartość netto bez sum (zwrot −0,50 przy 23% obok 1,00 przy 8%) → VAT −0,12 (od 0,5 grosza w górę, symetrycznie)', () => {
      // Dwie stawki: P_15 nie dopasuje VAT za żadną, więc liczy się tylko zaokrąglenie.
      const r = fa3ImportLineAmounts(invoice([line(1, '23', { P_11: '-0.50' }), line(2, '8', { P_11: '1.00' })], { P_15: '0.46' }));
      expect(r.problems).toEqual([]);
      expect(r.rows.map((x) => x.vatAmount)).toEqual([-0.12, 0.08]);
      expect(r.totals).toEqual({ netTotal: 0.5, vatTotal: -0.04 });
    });

    it('brak P_15 → kwoty faktury nieznane, z powodem', () => {
      const r = fa3ImportLineAmounts(invoice([line(1, 'zw', { P_11: '50.00' })], {}));
      expect(r.problems).toEqual(['nagłówek: brak P_15']);
      expect(r.totalsUnknown).toBe(true);
    });

    it('pozycja bez wartości → kwoty faktury nieznane (nie ma ich skąd wziąć)', () => {
      const r = fa3ImportLineAmounts(invoice([line(1, 'zw', {}), line(2, 'zw', { P_11: '50.00' })], { P_15: '50.00' }));
      expect(r.problems).toEqual(['pozycja 1: brak wartości (ani P_11, ani P_11A)']);
      expect(r.totalsUnknown).toBe(true);
      expect(r.totals).toBeUndefined();
    });

    it('taksówki (4%) netto bez sum → kwoty faktury z parsera jak dotąd (bez sum z pozycji, bez zatrzymania)', () => {
      const r = fa3ImportLineAmounts(invoice([line(1, '4', { P_11: '100.00' })], { P_15: '104.00' }));
      expect(r.problems).toEqual([]);
      expect(r.totals).toBeUndefined();
      expect(r.totalsUnknown).toBeUndefined();
    });

    it('„-0.00” → zero bez znaku (JSON i porównania)', () => {
      const r = fa3ImportLineAmounts(invoice([line(1, 'zw', { P_11: '-0.00' }), line(2, 'zw', { P_11: '10.00' })], { P_15: '10.00' }));
      expect(Object.is(r.rows[0]!.netAmount, 0)).toBe(true);
    });

    it('pozycje ≠ P_15 → zatrzymane, kwoty faktury nieznane', () => {
      const r = fa3ImportLineAmounts(invoice([line(1, 'zw', { P_11A: '50.00' })], { P_15: '60.00' }));
      expect(r.problems.join(' | ')).toMatch(/brutto pozycji 50\.00 ≠ P_15 60\.00/);
      expect(r.totalsUnknown).toBe(true);
    });
  });

  it('wynik przechodzi przez JSON (supabase-js) — bez BigInt, NaN, Infinity', () => {
    const r = fa3ImportLineAmounts(invoice([line(1, '23', { P_9B: '33.33', P_11A: '33.33', P_8B: '1.0000' })], { P_13_1: '27.10', P_14_1: '6.23', P_15: '33.33' }));
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
    expect(r.ksefLineFields).toEqual([{ ordinal: 1, P_8B: 1, P_9B: 33.33, P_11A: 33.33 }]);
  });
});

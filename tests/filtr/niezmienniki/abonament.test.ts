import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { MONTHLY_PRICE_GROSS_GROSZE, MONTHLY_PRICE_NET_GROSZE, MONTHLY_VAT_GROSZE, VAT_RATE_PERCENT } from '@/lib/billing/pricing';
import { paidDateInPoland } from '@/lib/billing/self-invoice';
import { roundToCents } from '@/lib/xml/invoice-calculator';

import { opcje } from '../generatory/ustawienia';

/**
 * Niezmienniki faktury FaktWay za abonament (żelazny filtr F10, część 5;
 * obszar `abonament`, R1). Cena jest brutto (Stripe pobiera brutto), więc
 * faktura liczy się od brutto:
 * - art. 106e ust. 7 ustawy o VAT: przy fakturze od wartości brutto podatek to
 *   iloczyn brutto i stawki 23/123 (dla 23 %), netto to różnica;
 * - art. 106e ust. 11: kwoty podatku zaokrągla się do pełnych groszy, końcówki
 *   poniżej 0,5 grosza pomija się, 0,5 grosza i więcej zaokrągla do 1 grosza.
 * Program liczy netto najpierw (`lib/billing/pricing.ts`, `lib/billing/self-invoice.ts`:
 * netto = round(brutto / 1,23), VAT = brutto − netto). Dla kwot w groszach to
 * ten sam VAT co wzór ustawowy, bo 100·g/123 nigdy nie ma części ułamkowej
 * równej dokładnie 0,5 (123 nie dzieli 200·g bez dzielenia g); test sprawdza
 * to na prymitywie programu (`roundToCents` na złotych zmiennoprzecinkowych),
 * czyli tak, jak liczy `buildSelfInvoiceDraft`.
 */

/** Wzór ustawowy w liczbach całkowitych: VAT = ⌊(brutto·23 + 61) / 123⌋ (połowa w górę), netto = brutto − VAT. */
function zUstawy(bruttoGr: number): { nettoGr: number; vatGr: number } {
  const vatGr = Math.floor((bruttoGr * VAT_RATE_PERCENT * 2 + (100 + VAT_RATE_PERCENT)) / ((100 + VAT_RATE_PERCENT) * 2));
  return { nettoGr: bruttoGr - vatGr, vatGr };
}

/** Rozbicie programu z `self-invoice.ts` (złote zmiennoprzecinkowe, `roundToCents`). */
function zProgramu(bruttoGr: number): { nettoGr: number; vatGr: number } {
  const brutto = roundToCents(bruttoGr / 100);
  const netto = roundToCents(brutto / (1 + VAT_RATE_PERCENT / 100));
  const vat = roundToCents(brutto - netto);
  return { nettoGr: Math.round(netto * 100), vatGr: Math.round(vat * 100) };
}

describe('Abonament: kwoty faktury od brutto zgodne z art. 106e ust. 7 i 11', () => {
  it('stawka 23 % i cena miesięczna rozbita według wzoru ustawowego', () => {
    expect(VAT_RATE_PERCENT).toBe(23);
    expect({ nettoGr: MONTHLY_PRICE_NET_GROSZE, vatGr: MONTHLY_VAT_GROSZE }).toEqual(zUstawy(MONTHLY_PRICE_GROSS_GROSZE));
    expect(MONTHLY_PRICE_NET_GROSZE + MONTHLY_VAT_GROSZE).toBe(MONTHLY_PRICE_GROSS_GROSZE);
  });

  it('każda kwota brutto od 0,01 do 10 000,00 zł: metoda programu = wzór ustawowy', () => {
    const rozne: number[] = [];
    for (let g = 1; g <= 1_000_000; g++) {
      const p = zProgramu(g);
      const u = zUstawy(g);
      if (p.vatGr !== u.vatGr || p.nettoGr !== u.nettoGr) rozne.push(g);
      if (rozne.length >= 10) break;
    }
    expect(rozne).toEqual([]);
  });
});

/** Dzień w Polsce dla chwili, niezależnie od strefy procesu. */
const dzienWPolsce = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit' });

describe('Abonament: data zapłaty na fakturze to dzień w Polsce', () => {
  it.each([
    '2026-03-28T22:59:59Z', '2026-03-28T23:00:00Z', '2026-03-29T00:30:00Z', '2026-03-29T21:59:59Z', '2026-03-29T22:00:00Z',
    '2026-10-24T21:59:59Z', '2026-10-24T22:00:00Z', '2026-10-25T00:30:00Z', '2026-10-25T22:59:59Z', '2026-10-25T23:00:00Z',
    '2026-12-31T22:59:59Z', '2026-12-31T23:00:00Z',
  ])('granica dnia i zmiany czasu: %s', (chwila) => {
    expect(paidDateInPoland(chwila)).toBe(dzienWPolsce.format(new Date(chwila)));
  });

  it('losowe chwile 2026-2060', () => {
    const od = Date.parse('2026-01-01T00:00:00Z');
    const doChwili = Date.parse('2060-12-31T23:59:59Z');
    fc.assert(
      fc.property(fc.integer({ min: od / 1000, max: doChwili / 1000 }), (s) => {
        const chwila = new Date(s * 1000).toISOString();
        expect(paidDateInPoland(chwila)).toBe(dzienWPolsce.format(new Date(chwila)));
      }),
      opcje(),
    );
  });
});

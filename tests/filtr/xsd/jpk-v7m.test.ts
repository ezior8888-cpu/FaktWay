import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { sprawdzJpkV7m, WZORY_JPK_V7M, type Wzor } from '@/lib/bezpieczniki/jpk-v7m';
import type { ExportExpense } from '@/lib/exports/data-fetcher';
import { amountsOf, type JpkInvoice } from '@/lib/exports/jpk-fa-generator';
import { generateJpkV7m, vatPurchases } from '@/lib/exports/jpk-v7m-generator';
import { validateJpkV7m } from '@/lib/exports/jpk-v7m-validator';

import { PRZYPADKI, ZIARNO } from '../generatory/ustawienia';

/**
 * JPK_V7M(3) na losowych danych (żelazny filtr F9, plan B4.6). Wzory sum
 * pochodzą z opisów pól w oficjalnym schemacie MF
 * (`lib/exports/schemas/jpk-v7m3/schemat.xsd`), nie z kodu aplikacji. Listy
 * pól są w strażniku pliku (`WZORY_JPK_V7M` w `lib/bezpieczniki/jpk-v7m.ts`,
 * F13), jedno źródło dla testu i aplikacji; test czyta plik własnymi
 * wzorcami, niezależnie od parsera strażnika, a strażnik nie może zgłosić
 * alarmu:
 *
 * - PodatekNalezny = Σ K_16, K_18, K_20, K_24, K_26, K_28, K_30, K_32, K_33,
 *   K_34 minus K_35, K_36, K_360;
 * - PodatekNaliczony = Σ K_41, K_43, K_44, K_45, K_46, K_47;
 * - P_38 = Σ P_16, P_18, P_20, P_24, P_26, P_28, P_30, P_32, P_33, P_34
 *   minus P_35, P_36, P_360; P_48 = Σ P_39, P_41, P_43, P_44, P_45, P_46, P_47;
 * - bez P_49 i P_50: P_51 minus P_53 = P_38 minus P_48, obie nieujemne;
 * - liczby wierszy w Ctrl równe liczbie wierszy.
 *
 * Do tego pola K_ stawek (23% K_19/K_20, 8% K_17/K_18, 5% K_15/K_16, 0% K_13,
 * zw K_10) sumują się do kwot faktur z `amountsOf`. Sprzedaż: faktury zwykłe
 * i korekty in minus, z NIP-em i bez (konsument), z numerem KSeF i bez (BFK).
 */
const ILE = PRZYPADKI > 1_000 ? 300 : 25;
const opcjeXsd = ZIARNO === undefined ? { numRuns: ILE } : { numRuns: ILE, seed: ZIARNO };

type Stawka = '23' | '8' | '5' | '0' | 'zw';
const STOPA: Record<Stawka, number> = { '23': 0.23, '8': 0.08, '5': 0.05, '0': 0, zw: 0 };
const POLA_K: Record<Stawka, [string, string | null]> = {
  '23': ['K_19', 'K_20'],
  '8': ['K_17', 'K_18'],
  '5': ['K_15', 'K_16'],
  '0': ['K_13', null],
  zw: ['K_10', null],
};

const KSEF_SPRZEDAZ = '1234567890-20260805-0100001AF629-AF';
const KSEF_ZAKUP = '1234567890-20260806-0100001AF629-B0';
const zlote = (g: number) => Math.round(g) / 100;

const linia = fc.record({
  netto: fc.integer({ min: 0, max: 50_000_000 }),
  stawka: fc.constantFrom<Stawka>('23', '8', '5', '0', 'zw'),
});

const faktura = fc
  .record({
    linie: fc.array(linia, { minLength: 1, maxLength: 4 }),
    korekta: fc.boolean(),
    konsument: fc.boolean(),
    ksef: fc.boolean(),
    dzien: fc.integer({ min: 1, max: 31 }),
  })
  .map(({ linie, korekta, konsument, ksef, dzien }): Omit<JpkInvoice, 'invoiceNumber'> => {
    const znak = korekta ? -1 : 1;
    const lines = linie.map((l, i) => {
      const netAmount = zlote(znak * l.netto);
      return { position: i + 1, name: 'Usługa', unit: 'szt.', quantity: 1, unitPriceNet: netAmount, netAmount, vatRate: l.stawka };
    });
    const netTotal = zlote(lines.reduce((a, l) => a + Math.round(l.netAmount * 100), 0));
    const vatTotal = zlote(lines.reduce((a, l) => a + Math.round(l.netAmount * STOPA[l.vatRate as Stawka] * 100), 0));
    return {
      currency: 'PLN',
      invoiceType: korekta ? 'correction' : 'regular',
      issueDate: `2026-08-${String(dzien).padStart(2, '0')}`,
      buyerName: konsument ? 'Jan Kowalski' : 'Klient Sp. z o.o.',
      buyerNip: konsument ? undefined : '1234567890',
      netTotal,
      vatTotal,
      grossTotal: zlote(Math.round(netTotal * 100) + Math.round(vatTotal * 100)),
      ksefNumber: ksef ? KSEF_SPRZEDAZ : undefined,
      ...(korekta ? { correctedInvoiceNumber: 'FS/1/07' } : {}),
      lines,
    } as Omit<JpkInvoice, 'invoiceNumber'>;
  });

const koszt = fc
  .record({
    netto: fc.integer({ min: -2_000_000, max: 20_000_000 }),
    stawka: fc.constantFrom(0.23, 0.08, 0.05),
    odliczenie: fc.constantFrom(1, 0.5, 0),
    paragon: fc.boolean(),
    ksef: fc.boolean(),
    dzien: fc.integer({ min: 1, max: 31 }),
  })
  .map(({ netto, stawka: s, odliczenie, paragon, ksef, dzien }): Omit<ExportExpense, 'id' | 'documentNumber'> => {
    const vat = Math.round(netto * s);
    return {
      issueDate: `2026-08-${String(dzien).padStart(2, '0')}`,
      documentType: paragon ? 'receipt' : 'invoice',
      sellerName: 'Dostawca Sp. z o.o.',
      sellerNip: '1234567890',
      sellerAddress: null,
      netAmount: zlote(netto),
      vatAmount: zlote(vat),
      grossAmount: zlote(netto + vat),
      vatDeductibleAmount: zlote(Math.round(vat * odliczenie)),
      kpirColumn: 'col_13',
      categoryLabel: 'Usługi',
      ksefNumber: ksef ? KSEF_ZAKUP : null,
    } as Omit<ExportExpense, 'id' | 'documentNumber'>;
  });

const dane = fc.record({
  sprzedaz: fc.array(faktura, { maxLength: 15 }),
  zakupy: fc.array(koszt, { maxLength: 10 }),
  nadwyzka: fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 50_000 })),
});

const kwota = (tekst: string) => Math.round(Number(tekst) * 100);
function pola(xml: string, nazwa: string): number[] {
  return [...xml.matchAll(new RegExp(`<(?:\\w+:)?${nazwa}>(-?[\\d.]+)</(?:\\w+:)?${nazwa}>`, 'g'))].map((m) => kwota(m[1]));
}
const suma = (xml: string, nazwy: readonly string[]) => nazwy.reduce((a, n) => a + pola(xml, n).reduce((x, y) => x + y, 0), 0);
const wzor = (xml: string, w: Wzor) => suma(xml, w.plus) - suma(xml, w.minus);
const bloki = (xml: string, nazwa: string) => [...xml.matchAll(new RegExp(`<(?:\\w+:)?${nazwa}>([\\s\\S]*?)</(?:\\w+:)?${nazwa}>`, 'g'))].map((m) => m[1]);
const jedno = (xml: string, nazwa: string) => {
  const w = pola(xml, nazwa);
  expect(w.length).toBeLessThanOrEqual(1);
  return w[0] ?? 0;
};

describe('JPK_V7M(3): losowe okresy', () => {
  it('przechodzą oficjalny XSD, a sumy kontrolne i deklaracja zgadzają się ze wzorami MF', async () => {
    await fc.assert(
      fc.asyncProperty(dane, async ({ sprzedaz, zakupy, nadwyzka }) => {
        const issuedInvoices = sprzedaz.map((f, i) => ({ ...f, invoiceNumber: `FS/${i + 1}/08` }) as JpkInvoice);
        const expenses = zakupy.map((k, i) => ({ ...k, id: `exp-${i + 1}`, documentNumber: `FZ/${i + 1}/08` }) as ExportExpense);
        const xml = generateJpkV7m({
          issuer: { nip: '1234567890', name: 'Moja Firma Sp. z o.o.', email: 'biuro@example.test', taxOfficeCode: '1433' },
          periodStart: '2026-08-01',
          periodEnd: '2026-08-31',
          generatedAt: new Date('2026-09-10T10:00:00Z'),
          issuedInvoices,
          expenses,
          previousSurplus: nadwyzka,
        });
        const wynik = await validateJpkV7m(xml);
        expect(wynik.errors).toEqual([]);
        expect(sprawdzJpkV7m(xml, '2026-08')).toEqual([]);
        // Generator nie oznacza faktur FP, więc PodatekNalezny liczy wszystkie wiersze.
        expect(xml).not.toContain('<TypDokumentu>');

        // Bez tego sumy mogłyby przechodzić pusto (0 = 0), gdyby wzorce nic nie znalazły.
        expect(bloki(xml, 'SprzedazWiersz')).toHaveLength(issuedInvoices.length);
        expect(bloki(xml, 'ZakupWiersz')).toHaveLength(vatPurchases(expenses).length);
        for (const n of ['PodatekNalezny', 'PodatekNaliczony', 'LiczbaWierszySprzedazy', 'LiczbaWierszyZakupow', 'P_38', 'P_51']) {
          expect(pola(xml, n), n).toHaveLength(1);
        }

        const sprzedazWiersze = bloki(xml, 'SprzedazWiersz').join('\n');
        const zakupWiersze = bloki(xml, 'ZakupWiersz').join('\n');
        expect(jedno(xml, 'PodatekNalezny')).toBe(wzor(sprzedazWiersze, WZORY_JPK_V7M.podatekNalezny));
        expect(jedno(xml, 'PodatekNaliczony')).toBe(wzor(zakupWiersze, WZORY_JPK_V7M.podatekNaliczony));
        expect(jedno(xml, 'LiczbaWierszySprzedazy')).toBe(bloki(xml, 'SprzedazWiersz').length * 100);
        expect(jedno(xml, 'LiczbaWierszyZakupow')).toBe(bloki(xml, 'ZakupWiersz').length * 100);

        const p38 = jedno(xml, 'P_38');
        expect(p38).toBe(wzor(xml, WZORY_JPK_V7M.P_38));
        const p48 = jedno(xml, 'P_48');
        expect(p48).toBe(wzor(xml, WZORY_JPK_V7M.P_48));
        expect(pola(xml, 'P_49').concat(pola(xml, 'P_50')).every((v) => v === 0)).toBe(true);
        const p51 = jedno(xml, 'P_51');
        const p53 = jedno(xml, 'P_53');
        expect(p51).toBeGreaterThanOrEqual(0);
        expect(p53).toBeGreaterThanOrEqual(0);
        expect(p51 - p53).toBe(p38 - p48);

        for (const [stawka, [poleNetto, poleVat]] of Object.entries(POLA_K) as Array<[Stawka, [string, string | null]]>) {
          const zFaktur = issuedInvoices.flatMap((f) => amountsOf(f).rates).filter((r) => r.rate === stawka);
          expect(suma(sprzedazWiersze, [poleNetto])).toBe(Math.round(zFaktur.reduce((a, r) => a + r.net, 0) * 100));
          if (poleVat) expect(suma(sprzedazWiersze, [poleVat])).toBe(Math.round(zFaktur.reduce((a, r) => a + r.vat, 0) * 100));
        }
      }),
      opcjeXsd,
    );
  }, 600_000);
});

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { ExportExpense } from '@/lib/exports/data-fetcher';
import { amountsOf, type JpkInvoice } from '@/lib/exports/jpk-fa-generator';
import { generateJpkV7m, summarizeJpkV7m, vatPurchases } from '@/lib/exports/jpk-v7m-generator';

import { opcje } from '../generatory/ustawienia';
import * as wyrocznia from '../wyrocznia/vat';

/**
 * Test różnicowy części deklaracyjnej JPK_V7M (żelazny filtr F6, plan B4.7).
 * Wyrocznia `tests/filtr/wyrocznia/vat.ts` powstała w czystym pokoju: osobny
 * podagent (model Claude Sonnet) w katalogu bez repozytorium, tylko
 * z `SPEC-vat.md` (art. 63 § 1 Ordynacji podatkowej, art. 87 ust. 1 i art. 103
 * ust. 1 ustawy o VAT, opisy pól P_37, P_38, P_48 w schemacie MF).
 *
 * Wejście wyroczni to ewidencja aplikacji (kwoty stawek z `amountsOf`, zakupy
 * z `vatPurchases`), więc test sprawdza zaokrąglenie pól do pełnych złotych,
 * sumy i rozliczenie (do wpłaty, nadwyżka, przeniesienie) w pliku i w module
 * VAT (`summarizeJpkV7m`, z którego korzysta `lib/ksiegowosc/vat.ts`).
 */
const POLA = ['P_10', 'P_11', 'P_12', 'P_13', 'P_15', 'P_16', 'P_17', 'P_18', 'P_19', 'P_20', 'P_37', 'P_38', 'P_39', 'P_42', 'P_43', 'P_48', 'P_51', 'P_53', 'P_62'] as const;

type Stawka = wyrocznia.Stawka;
const STOPA: Record<Stawka, number> = { '23': 0.23, '8': 0.08, '5': 0.05, '0': 0, zw: 0, np: 0, np_ii: 0 };
const KSEF = '1234567890-20260805-0100001AF629-AF';
const zlote = (g: number) => g / 100;

const faktura = fc
  .record({
    linie: fc.array(fc.record({ netto: fc.integer({ min: 0, max: 50_000_000 }), stawka: fc.constantFrom<Stawka>('23', '8', '5', '0', 'zw', 'np', 'np_ii') }), { minLength: 1, maxLength: 4 }),
    korekta: fc.boolean(),
    dzien: fc.integer({ min: 1, max: 31 }),
  })
  .map(({ linie, korekta, dzien }) => {
    const znak = korekta ? -1 : 1;
    const lines = linie.map((l, i) => {
      const netAmount = zlote(znak * l.netto);
      return { position: i + 1, name: 'Usługa', unit: 'szt.', quantity: 1, unitPriceNet: netAmount, netAmount, vatRate: l.stawka };
    });
    const netto = lines.reduce((a, l) => a + Math.round(l.netAmount * 100), 0);
    const vat = lines.reduce((a, l) => a + Math.round(l.netAmount * STOPA[l.vatRate] * 100), 0);
    return {
      currency: 'PLN',
      invoiceType: korekta ? 'correction' : 'regular',
      issueDate: `2026-08-${String(dzien).padStart(2, '0')}`,
      buyerName: 'Klient Sp. z o.o.',
      buyerNip: '1234567890',
      netTotal: zlote(netto),
      vatTotal: zlote(vat),
      grossTotal: zlote(netto + vat),
      ksefNumber: KSEF,
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
  })
  .map(({ netto, stawka, odliczenie, paragon }) => {
    const vat = Math.round(netto * stawka);
    return {
      issueDate: '2026-08-10',
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
      ksefNumber: KSEF,
    } as Omit<ExportExpense, 'id' | 'documentNumber'>;
  });

const okres = fc.record({
  sprzedaz: fc.array(faktura, { maxLength: 15 }),
  zakupy: fc.array(koszt, { maxLength: 10 }),
  nadwyzka: fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 50_000 })),
});

const pole = (xml: string, nazwa: string): number[] =>
  [...xml.matchAll(new RegExp(`<(?:\\w+:)?${nazwa}>(-?\\d+)</(?:\\w+:)?${nazwa}>`, 'g'))].map((m) => Number(m[1]));

describe('Deklaracja JPK_V7M: aplikacja = wyrocznia z przepisów (F6)', () => {
  it('pola P_10-P_62 w pliku i rozliczenie w module VAT na losowych okresach', () => {
    fc.assert(
      fc.property(okres, ({ sprzedaz, zakupy, nadwyzka }) => {
        const issuedInvoices = sprzedaz.map((f, i) => ({ ...f, invoiceNumber: `FS/${i + 1}/08` }) as JpkInvoice);
        const expenses = zakupy.map((k, i) => ({ ...k, id: `exp-${i + 1}`, documentNumber: `FZ/${i + 1}/08` }) as ExportExpense);
        const dane = {
          issuer: { nip: '1234567890', name: 'Moja Firma Sp. z o.o.', email: 'biuro@example.test', taxOfficeCode: '1433' },
          periodStart: '2026-08-01',
          periodEnd: '2026-08-31',
          generatedAt: new Date('2026-09-10T10:00:00Z'),
          issuedInvoices,
          expenses,
          previousSurplus: nadwyzka,
        };
        const wzorzec = wyrocznia.deklaracja({
          sprzedaz: issuedInvoices.map((f) =>
            amountsOf(f).rates.map((r) => ({ stawka: r.rate as Stawka, netto: Math.round(r.net * 100), vat: Math.round(r.vat * 100) })),
          ),
          zakupy: vatPurchases(expenses).map((e) => ({ netto: Math.round(e.netAmount * 100), vatDoOdliczenia: Math.round(e.vatDeductibleAmount * 100) })),
          nadwyzkaPoprzednia: nadwyzka,
        });

        const xml = generateJpkV7m(dane);
        for (const nazwa of POLA) {
          const wPliku = pole(xml, nazwa);
          expect(wPliku.length, nazwa).toBeLessThanOrEqual(1);
          expect(wPliku[0] ?? 0, nazwa).toBe(wzorzec[nazwa]);
        }
        // P_38 i P_51 są w deklaracji zawsze, więc porównanie nie przechodzi pusto.
        expect(pole(xml, 'P_38')).toHaveLength(1);
        expect(pole(xml, 'P_51')).toHaveLength(1);

        // `+ 0` zamienia ujemne zero na zero: `wholeZloty` daje -0 dla kwoty
        // ujemnej poniżej 50 gr (FZ-002); klient go nie widzi, kwota się zgadza.
        const modul = summarizeJpkV7m(dane);
        expect(modul.vatDue + 0).toBe(wzorzec.P_38);
        expect(modul.vatDeductible + 0).toBe(wzorzec.P_48);
        expect(modul.purchaseNet + 0).toBe(wzorzec.P_42);
        expect(modul.toPay + 0).toBe(wzorzec.P_51);
        expect(modul.carryForward + 0).toBe(wzorzec.P_62);
      }),
      opcje(),
    );
  }, 600_000);
});

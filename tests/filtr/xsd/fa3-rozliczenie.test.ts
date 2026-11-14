import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { sprawdzFa3 } from '@/lib/bezpieczniki/fa3';
import { generateFinalInvoiceXml, type AdvanceInvoiceSettlementRow } from '@/lib/ksef/fa3-advance-generator';
import { calculateLineItem, summarizeVatPerRate } from '@/lib/xml/invoice-calculator';
import { validateInvoiceXml } from '@/lib/xml/validator';
import type { FinalInvoiceData, InvoiceLine } from '@/types/invoice-types';
import type { InvoiceLineItem } from '@/types/invoice';

import { PRZYPADKI, ZIARNO } from '../generatory/ustawienia';

/**
 * Faktura rozliczająca FA(3) ROZ na losowych danych (żelazny filtr F9, plan
 * B4.6; art. 106f ust. 3 ustawy o VAT: pozycje pełne, P_13_x i P_14_x po
 * odjęciu zaliczek):
 *
 * - NZ-FA-10: XSD FA(3);
 * - NZ-FA-01: P_15 = Σ P_13_x + Σ P_14_x;
 * - NZ-FA-05: P_15 = brutto zamówienia minus brutto zaliczek; w każdej
 *   stawce P_13 + netto zaliczek = netto zamówienia i P_14 + VAT zaliczek =
 *   VAT zamówienia; Σ P_11 (pozycje) = netto całego zamówienia.
 *
 * VAT zaliczki bez rozbicia liczy test sam, wzorem z art. 106f ust. 1 pkt 3
 * (KP = ZB × SP / (100 + SP), do grosza); rozbicie z faktury zaliczkowej ma
 * pierwszeństwo, także gdy różni się od wzoru o grosz. Kwoty zamówienia
 * według stawek z `summarizeVatPerRate` (ta sama metoda co faktura zwykła).
 */
const ILE = PRZYPADKI > 1_000 ? 300 : 25;
const opcjeXsd = ZIARNO === undefined ? { numRuns: ILE } : { numRuns: ILE, seed: ZIARNO };

type Stawka = '23' | '8' | '5';
const SP: Record<Stawka, number> = { '23': 23, '8': 8, '5': 5 };
const POLA: Record<Stawka, [string, string]> = { '23': ['P_13_1', 'P_14_1'], '8': ['P_13_2', 'P_14_2'], '5': ['P_13_3', 'P_14_3'] };

const pozycja = fc.record({
  name: fc.constantFrom('Projekt', 'Wdrożenie', 'Szkolenie', 'Licencja & wsparcie'),
  unit: fc.constantFrom('usł.', 'szt.'),
  quantity: fc.integer({ min: 1, max: 20 }),
  unitPriceNet: fc.integer({ min: 100, max: 10_000_000 }).map((g) => g / 100),
  vatRate: fc.constantFrom<Stawka>('23', '8', '5'),
});

/** Zaliczka jako ułamek brutto stawki zamówienia; rozbicie z ZAL: brak, zgodne ze wzorem albo o grosz inne. */
const zaliczkaWStawce = fc.record({
  promile: fc.integer({ min: 10, max: 490 }),
  rozbicie: fc.constantFrom<'brak' | 'wzor' | 'plus' | 'minus'>('brak', 'wzor', 'plus', 'minus'),
  ksef: fc.boolean(),
});

const przypadek = fc
  .array(pozycja, { minLength: 1, maxLength: 6 })
  .chain((linie) => {
    const stawki = [...new Set(linie.map((l) => l.vatRate))];
    return fc.tuple(
      fc.constant(linie),
      fc.tuple(...stawki.map((s) => fc.tuple(fc.constant(s), fc.array(zaliczkaWStawce, { maxLength: 2 })))),
    );
  })
  .filter(([, zaliczki]) => zaliczki.some(([, z]) => z.length > 0));

const kwota = (tekst: string) => Math.round(Number(tekst) * 100);
const pola = (xml: string, nazwa: string) =>
  [...xml.matchAll(new RegExp(`<${nazwa}>(-?[\\d.]+)</${nazwa}>`, 'g'))].map((m) => kwota(m[1]));
const suma = (l: number[]) => l.reduce((a, b) => a + b, 0);
const grosze = (zl: number) => Math.round(zl * 100);

function roz(lines: InvoiceLine[], totalAdvances: number): FinalInvoiceData {
  const adres = (linia1: string) => ({ countryCode: 'PL', addressLine1: linia1, addressLine2: '00-001 Warszawa' });
  return {
    invoiceType: 'final',
    internalNumber: 'FR/2026/09/1',
    issueDate: '2026-09-20',
    paymentMethod: 'transfer',
    paymentDueDate: '2026-10-04',
    bankAccount: 'PL61109010140000071219812874',
    seller: { nip: '1234567890', name: 'ACME Software sp. z o.o.', address: adres('ul. Przykładowa 1/2'), email: 'biuro@acme.test' },
    buyer: { type: 'b2b', idType: 'nip', nip: '1234567890', name: 'Klient sp. z o.o.', address: adres('ul. Klienta 10') },
    taxAnnotations: { cashMethod: 2, splitPayment: 2 },
    advanceInvoiceIds: ['00000000-0000-4000-8000-000000000001'],
    totalAdvances,
    lines,
  } as unknown as FinalInvoiceData;
}

describe('FA(3) ROZ: losowe zamówienia i zaliczki', () => {
  it('XSD, P_15 = zamówienie minus zaliczki, P_13 i P_14 każdej stawki po odjęciu zaliczek (NZ-FA-10, NZ-FA-01, NZ-FA-05)', async () => {
    await fc.assert(
      fc.asyncProperty(przypadek, async ([linie, zaliczkiWgStawek]) => {
        const items: InvoiceLineItem[] = linie.map((l, i) => ({ ordinal: i + 1, ...l, ...calculateLineItem(l) }));
        const zamowienie = new Map(summarizeVatPerRate(items).map((s) => [s.rate as Stawka, { net: grosze(s.netSum), vat: grosze(s.vatSum) }]));

        const wiersze: AdvanceInvoiceSettlementRow[] = [];
        const odjete = new Map<Stawka, { net: number; vat: number; brutto: number }>();
        for (const [s, zaliczki] of zaliczkiWgStawek) {
          const z = zamowienie.get(s)!;
          for (const [i, { promile, rozbicie, ksef }] of zaliczki.entries()) {
            const brutto = Math.floor(((z.net + z.vat) * promile) / 1000);
            if (brutto <= 0) continue;
            const wzor = Math.round((brutto * SP[s]) / (100 + SP[s]));
            const vat = rozbicie === 'plus' ? wzor + 1 : rozbicie === 'minus' ? wzor - 1 : wzor;
            wiersze.push({
              internal_number: `ZAL/${s}/${i + 1}`,
              ksef_number: ksef ? '1234567890-20260801-0100001AF629-AF' : null,
              advance_amount: brutto / 100,
              issue_date: '2026-08-01',
              vat_rate: s,
              ...(rozbicie === 'brak' ? {} : { net_amount: (brutto - vat) / 100, vat_amount: vat / 100 }),
            } as AdvanceInvoiceSettlementRow);
            const o = odjete.get(s) ?? { net: 0, vat: 0, brutto: 0 };
            odjete.set(s, { net: o.net + brutto - vat, vat: o.vat + vat, brutto: o.brutto + brutto });
          }
        }
        fc.pre(wiersze.length > 0);
        const zaliczkiBrutto = suma([...odjete.values()].map((o) => o.brutto));

        const xml = generateFinalInvoiceXml(roz(linie as InvoiceLine[], zaliczkiBrutto / 100), wiersze, {
          generatedAt: new Date('2026-09-20T10:00:00Z'),
        });
        const wynik = await validateInvoiceXml(xml);
        expect(wynik.errors).toEqual([]);
        // Strażnik FA(3) (F13 część 4) nie zgłasza alarmu dla pliku z prawdziwego generatora.
        expect(sprawdzFa3(xml)).toEqual([]);

        const p13 = suma(Object.values(POLA).flatMap(([n]) => pola(xml, n)));
        const p14 = suma(Object.values(POLA).flatMap(([, v]) => pola(xml, v)));
        const [p15] = pola(xml, 'P_15');
        expect(p15).toBe(p13 + p14);
        const zamowienieBrutto = suma([...zamowienie.values()].map((z) => z.net + z.vat));
        expect(p15).toBe(zamowienieBrutto - zaliczkiBrutto);

        for (const [s, z] of zamowienie) {
          const o = odjete.get(s) ?? { net: 0, vat: 0, brutto: 0 };
          const [poleNetto, poleVat] = POLA[s];
          expect(pola(xml, poleNetto), `${poleNetto}`).toEqual([z.net - o.net]);
          expect(pola(xml, poleVat), `${poleVat}`).toEqual([z.vat - o.vat]);
        }
        expect(suma(pola(xml, 'P_11'))).toBe(suma([...zamowienie.values()].map((z) => z.net)));
      }),
      opcjeXsd,
    );
  }, 600_000);
});

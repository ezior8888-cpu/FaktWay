import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { generateJpkFa, type JpkFaInputData, type JpkInvoice } from '@/lib/exports/jpk-fa-generator';
import { validateJpkFa } from '@/lib/exports/jpk-fa-validator';

import { PRZYPADKI, ZIARNO } from '../generatory/ustawienia';

/**
 * JPK_FA(4) na losowych danych (żelazny filtr F9, plan B4.6). Wzory sum
 * kontrolnych z opisów pól w oficjalnym schemacie MF
 * (`lib/exports/schemas/jpk-fa4/schemat.xsd`), nie z kodu aplikacji:
 *
 * - LiczbaFaktur = liczba faktur; WartoscFaktur = łączna wartość P_15;
 * - LiczbaWierszyFaktur = liczba wierszy; WartoscWierszyFaktur = łączna
 *   wartość P_11 wierszy;
 * - NZ-FA-01 w pliku: P_15 każdej faktury = Σ P_13_x + Σ P_14_x.
 *
 * Faktury zwykłe (JPK_FA odmawia korekt), stawki 23, 8, 5, 0, zw (z podstawą
 * zwolnienia), np i oo, nabywca z NIP-em i konsument, adnotacje kasowa i MPP.
 */
const ILE = PRZYPADKI > 1_000 ? 300 : 25;
const opcjeXsd = ZIARNO === undefined ? { numRuns: ILE } : { numRuns: ILE, seed: ZIARNO };

type Stawka = '23' | '8' | '5' | '0' | 'zw' | 'np' | 'oo';
const STOPA: Record<Stawka, number> = { '23': 0.23, '8': 0.08, '5': 0.05, '0': 0, zw: 0, np: 0, oo: 0 };

const ADRES = {
  voivodeship: 'MAZOWIECKIE', county: 'Warszawa', commune: 'Mokotów', street: 'ul. Puławska',
  buildingNumber: '12', apartmentNumber: '3', city: 'Warszawa', postCode: '02-566',
};

const nazwa = fc.stringMatching(/^[A-Za-z0-9ĄĆĘŁŃÓŚŹŻąćęłńóśźż &<>"'/.,()+-]{1,60}$/).filter((s) => s.trim().length > 0);
const linia = fc.record({
  name: nazwa,
  ilosc: fc.integer({ min: 1, max: 50 }),
  cena: fc.integer({ min: 1, max: 2_000_000 }),
  stawka: fc.constantFrom<Stawka>('23', '8', '5', '0', 'zw', 'np', 'oo'),
});

const faktura = fc.record({
  linie: fc.array(linia, { minLength: 1, maxLength: 4 }),
  konsument: fc.boolean(),
  kasowa: fc.boolean(),
  mpp: fc.boolean(),
  dzien: fc.integer({ min: 1, max: 30 }),
});

type FakturaLosowa = { linie: Array<{ name: string; ilosc: number; cena: number; stawka: Stawka }>; konsument: boolean; kasowa: boolean; mpp: boolean; dzien: number };

function zbuduj(f: FakturaLosowa, i: number): JpkInvoice {
  const lines = f.linie.map((l, n) => {
    const netGr = l.ilosc * l.cena;
    const vatGr = Math.round(netGr * STOPA[l.stawka]);
    return { position: n + 1, name: l.name, unit: 'szt.', quantity: l.ilosc, unitPriceNet: l.cena / 100, netAmount: netGr / 100, vatRate: l.stawka, vatAmount: vatGr / 100 };
  });
  const netGr = lines.reduce((a, l) => a + Math.round(l.netAmount * 100), 0);
  const vatGr = lines.reduce((a, l) => a + Math.round(l.vatAmount * 100), 0);
  const zw = f.linie.some((l) => l.stawka === 'zw');
  return {
    invoiceNumber: `FV/${i + 1}/09/2026`,
    currency: 'PLN',
    invoiceType: 'regular',
    issueDate: `2026-09-${String(f.dzien).padStart(2, '0')}`,
    buyerName: f.konsument ? 'Jan Kowalski' : 'Klient Sp. z o.o.',
    buyerNip: f.konsument ? undefined : '1234567890',
    buyerAddress: 'ul. Klienta 10, 02-001 Warszawa',
    netTotal: netGr / 100,
    vatTotal: vatGr / 100,
    grossTotal: (netGr + vatGr) / 100,
    lines,
    annotations: {
      ...(f.kasowa ? { cashMethod: true } : {}),
      ...(f.mpp ? { splitPayment: true } : {}),
      ...(zw ? { vatExemptionBasis: 'art. 113 ust. 1 ustawy o VAT' } : {}),
    },
  } as JpkInvoice;
}

const kwota = (tekst: string) => Math.round(Number(tekst) * 100);
const pola = (xml: string, nazwaPola: string) =>
  [...xml.matchAll(new RegExp(`<(?:\\w+:)?${nazwaPola}>(-?[\\d.]+)</(?:\\w+:)?${nazwaPola}>`, 'g'))].map((m) => kwota(m[1]));
const bloki = (xml: string, nazwaBloku: string) =>
  [...xml.matchAll(new RegExp(`<(?:\\w+:)?${nazwaBloku}>([\\s\\S]*?)</(?:\\w+:)?${nazwaBloku}>`, 'g'))].map((m) => m[1]);
const suma = (l: number[]) => l.reduce((a, b) => a + b, 0);

describe('JPK_FA(4): losowe okresy', () => {
  it('przechodzą oficjalny XSD, a sumy kontrolne zgadzają się z opisami pól MF (NZ-FA-01 w pliku)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(faktura, { minLength: 1, maxLength: 15 }), async (faktury) => {
        const issuedInvoices = faktury.map((f, i) => zbuduj(f, i));
        const dane: JpkFaInputData = {
          issuer: { nip: '1234567890', name: 'ACME sp. z o.o.', taxOfficeCode: '1433', registeredAddress: ADRES },
          periodStart: '2026-09-01',
          periodEnd: '2026-09-30',
          issuedInvoices,
          generatedAt: new Date('2026-10-01T08:00:00Z'),
        };
        const xml = generateJpkFa(dane);
        const wynik = await validateJpkFa(xml);
        expect(wynik.errors).toEqual([]);

        const fakturyXml = bloki(xml, 'Faktura');
        const wierszeXml = bloki(xml, 'FakturaWiersz');
        // Bez tego sumy mogłyby przechodzić pusto, gdyby wzorce nic nie znalazły.
        expect(fakturyXml).toHaveLength(issuedInvoices.length);
        expect(wierszeXml).toHaveLength(suma(issuedInvoices.map((f) => f.lines.length)));

        expect(pola(xml, 'LiczbaFaktur')).toEqual([fakturyXml.length * 100]);
        expect(pola(xml, 'WartoscFaktur')).toEqual([suma(fakturyXml.flatMap((b) => pola(b, 'P_15')))]);
        expect(pola(xml, 'LiczbaWierszyFaktur')).toEqual([wierszeXml.length * 100]);
        expect(pola(xml, 'WartoscWierszyFaktur')).toEqual([suma(wierszeXml.flatMap((b) => pola(b, 'P_11')))]);

        for (const b of fakturyXml) {
          const p13 = suma([...b.matchAll(/<(?:\w+:)?P_13_[0-9_]+>(-?[\d.]+)<\/(?:\w+:)?P_13_[0-9_]+>/g)].map((m) => kwota(m[1])));
          const p14 = suma([...b.matchAll(/<(?:\w+:)?P_14_\d+>(-?[\d.]+)<\/(?:\w+:)?P_14_\d+>/g)].map((m) => kwota(m[1])));
          expect(pola(b, 'P_15')).toEqual([p13 + p14]);
        }
      }),
      opcjeXsd,
    );
  }, 600_000);
});

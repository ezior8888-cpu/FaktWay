import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { generateAdvanceInvoiceXml } from '@/lib/ksef/fa3-advance-generator';
import { validateInvoiceXml } from '@/lib/xml/validator';
import type { AdvanceInvoiceData } from '@/types/invoice-types';

import { PRZYPADKI, ZIARNO } from '../generatory/ustawienia';

/**
 * Faktura zaliczkowa FA(3) ZAL na losowych danych (żelazny filtr F9, plan
 * B4.6). Kwotę podatku zaliczki określa art. 106f ust. 1 pkt 4 ustawy o VAT:
 * KP = (ZB × SP) / (100 + SP). Test liczy ten wzór sam, w groszach na
 * liczbach całkowitych (zaokrąglenie do grosza, połowa w górę), bez kodu
 * aplikacji:
 *
 * - NZ-FA-10: XSD FA(3);
 * - NZ-FA-01: P_15 = P_13_x + P_14_x = kwota zaliczki;
 * - P_14_x = KP, P_13_x = ZB minus KP, tylko w polu stawki zaliczki;
 * - `Zamowienie`: WartoscZamowienia = wartość zamówienia brutto,
 *   P_11NettoZ + P_11VatZ = ta wartość, P_11VatZ ze wzoru dla całego zamówienia.
 */
const ILE = PRZYPADKI > 1_000 ? 300 : 25;
const opcjeXsd = ZIARNO === undefined ? { numRuns: ILE } : { numRuns: ILE, seed: ZIARNO };

type Stawka = '23' | '8' | '5' | '0';
const SP: Record<Stawka, number> = { '23': 23, '8': 8, '5': 5, '0': 0 };
const POLA: Record<Stawka, [string, string | null]> = {
  '23': ['P_13_1', 'P_14_1'],
  '8': ['P_13_2', 'P_14_2'],
  '5': ['P_13_3', 'P_14_3'],
  '0': ['P_13_6_1', null],
};

/** KP = ZB × SP / (100 + SP) w groszach, do grosza, połowa w górę (kwoty dodatnie). */
const kp = (zbGrosze: number, stawka: Stawka) => Math.floor((zbGrosze * SP[stawka] * 2 + (100 + SP[stawka])) / (2 * (100 + SP[stawka])));

const przypadek = fc.record({
  stawka: fc.constantFrom<Stawka>('23', '8', '5', '0'),
  zamowienie: fc.integer({ min: 100, max: 1_000_000_000 }),
  promile: fc.integer({ min: 1, max: 1000 }),
  opis: fc.stringMatching(/^[A-Za-z0-9ĄĆĘŁŃÓŚŹŻąćęłńóśźż &<>"'/.,()+-]{1,80}$/).filter((s) => s.trim().length > 0),
});

const kwota = (tekst: string) => Math.round(Number(tekst) * 100);
const pola = (xml: string, nazwa: string) =>
  [...xml.matchAll(new RegExp(`<${nazwa}>(-?[\\d.]+)</${nazwa}>`, 'g'))].map((m) => kwota(m[1]));

function zal(stawka: Stawka, zaliczka: number, zamowienie: number, opis: string): AdvanceInvoiceData {
  const address = { countryCode: 'PL', addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa' };
  return {
    invoiceType: 'advance',
    internalNumber: 'ZAL/2026/11/1',
    issueDate: '2026-11-09',
    paymentMethod: 'transfer',
    paymentDueDate: '2026-11-23',
    bankAccount: 'PL61109010140000071219812874',
    seller: { nip: '1234567890', name: 'Sprzedawca testowy', address },
    buyer: { type: 'b2b', idType: 'nip', nip: '1234567890', name: 'Nabywca testowy', address },
    taxAnnotations: { cashMethod: 2, splitPayment: 2 },
    advanceAmount: zaliczka / 100,
    totalContractAmount: zamowienie / 100,
    vatRate: stawka,
    description: opis,
  } as AdvanceInvoiceData;
}

describe('FA(3) ZAL: losowe zaliczki', () => {
  it('XSD, P_15 = kwota zaliczki, VAT wzorem z art. 106f ust. 1 pkt 4, zamówienie w `Zamowienie` (NZ-FA-10, NZ-FA-01)', async () => {
    await fc.assert(
      fc.asyncProperty(przypadek, async ({ stawka, zamowienie, promile, opis }) => {
        const zaliczka = Math.max(1, Math.floor((zamowienie * promile) / 1000));
        const xml = generateAdvanceInvoiceXml(zal(stawka, zaliczka, zamowienie, opis), {
          generatedAt: new Date('2026-11-09T10:00:00Z'),
        });
        const wynik = await validateInvoiceXml(xml);
        expect(wynik.errors).toEqual([]);

        const podatek = kp(zaliczka, stawka);
        for (const [s, [netto, vat]] of Object.entries(POLA) as Array<[Stawka, [string, string | null]]>) {
          expect(pola(xml, netto), netto).toEqual(s === stawka ? [zaliczka - podatek] : []);
          if (vat) expect(pola(xml, vat), vat).toEqual(s === stawka ? [podatek] : []);
        }
        expect(pola(xml, 'P_15')).toEqual([zaliczka]);

        expect(pola(xml, 'WartoscZamowienia')).toEqual([zamowienie]);
        const [nettoZ] = pola(xml, 'P_11NettoZ');
        const [vatZ] = pola(xml, 'P_11VatZ');
        expect(vatZ).toBe(kp(zamowienie, stawka));
        expect(nettoZ + vatZ).toBe(zamowienie);
      }),
      opcjeXsd,
    );
  }, 600_000);
});

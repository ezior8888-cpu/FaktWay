import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { sprawdzFa3 } from '@/lib/bezpieczniki/fa3';
import { generateCorrectionInvoiceXml } from '@/lib/ksef/fa3-correction-generator';
import { calculateLineItem, roundToCents } from '@/lib/xml/invoice-calculator';
import { validateFA3 } from '@/lib/xml/validator';
import type { CorrectionInvoiceData } from '@/types/invoice-types';

import { PRZYPADKI, ZIARNO } from '../generatory/ustawienia';

/**
 * Faktury korygujące FA(3) KOR na losowych danych (żelazny filtr F9, plan
 * B4.6): typy „przed/po”, anulowanie i korekta kwotowa.
 *
 * - NZ-FA-10: każdy XML przechodzi oficjalny XSD FA(3).
 * - NZ-FA-01: P_15 = Σ P_13_x + Σ P_14_x także dla KOR.
 * - NZ-FA-04 i NZ-FA-02: P_13_x każdej stawki to netto pozycji stanu po minus
 *   netto pozycji stanu przed w tej stawce (art. 106j ust. 2 pkt 5 ustawy
 *   o VAT); stawka bez różnicy nie jest wykazywana.
 *
 * Stawka „zw” poza zakresem: generator korekt jej odmawia (fail-closed,
 * „MVP nieobsługiwane”, `buildAdnotacjeMinimal`). Korekta kwotowa
 * (`amount_change`) nie ma pozycji: stawkę wyznaczają kwoty
 * (`resolveAmountChangeVatRate`), więc losujemy |netto| od 1 zł, gdzie
 * stawki dają różny VAT; mniejsze kwoty bywają niejednoznaczne i generator
 * wtedy odmawia, co jest zamierzone.
 */
const ILE = PRZYPADKI > 1_000 ? 300 : 25;
const opcjeXsd = ZIARNO === undefined ? { numRuns: ILE } : { numRuns: ILE, seed: ZIARNO };

type Stawka = '23' | '8' | '5' | '0';
type Linia = { name: string; unit: string; quantity: number; unitPriceNet: number; vatRate: Stawka };

const POLE_NETTO: Record<Stawka, string> = { '23': 'P_13_1', '8': 'P_13_2', '5': 'P_13_3', '0': 'P_13_6_1' };
const POLE_VAT: Partial<Record<Stawka, string>> = { '23': 'P_14_1', '8': 'P_14_2', '5': 'P_14_3' };
const STOPA: Record<Stawka, number> = { '23': 0.23, '8': 0.08, '5': 0.05, '0': 0 };

const stawka = fc.constantFrom<Stawka>('23', '8', '5', '0');
const cena = fc.integer({ min: 1, max: 5_000_000 }).map((g) => g / 100);
const ilosc = fc.oneof(fc.integer({ min: 1, max: 500 }), fc.integer({ min: 1, max: 99_999 }).map((n) => n / 1000));
const nazwa = fc.stringMatching(/^[A-Za-z0-9ĄĆĘŁŃÓŚŹŻąćęłńóśźż &<>"'/.,()+-]{1,60}$/).filter((s) => s.trim().length > 0);
const pozycja: fc.Arbitrary<Linia> = fc.record({
  name: nazwa,
  unit: fc.constantFrom('szt.', 'usł.', 'godz.'),
  quantity: ilosc,
  unitPriceNet: cena,
  vatRate: stawka,
});

/** Stan po: pozycja zostaje, zmienia ilość, cenę albo stawkę, albo znika. */
const zmiana = (l: Linia): fc.Arbitrary<Linia | null> =>
  fc.oneof(
    fc.constant(l),
    ilosc.map((quantity) => ({ ...l, quantity })),
    cena.map((unitPriceNet) => ({ ...l, unitPriceNet })),
    stawka.map((vatRate) => ({ ...l, vatRate })),
    fc.constant(null),
  );

const przedPo = fc
  .array(pozycja, { minLength: 1, maxLength: 8 })
  .chain((przed) => fc.tuple(fc.constant(przed), fc.tuple(...przed.map(zmiana)), fc.array(pozycja, { maxLength: 3 })))
  .map(([przed, zmienione, nowe]) => ({ przed, po: [...zmienione.filter((l): l is Linia => l !== null), ...nowe] }))
  .filter(({ przed, po }) => po.length > 0 && JSON.stringify(przed) !== JSON.stringify(po));

function korekta(typ: 'before_after' | 'cancellation' | 'amount_change', przed: Linia[], po: Linia[]): CorrectionInvoiceData {
  const adres = (linia1: string) => ({ countryCode: 'PL', addressLine1: linia1, addressLine2: '00-001 Warszawa' });
  return {
    invoiceType: 'correction',
    internalNumber: 'KOR 2026/11/001',
    issueDate: '2026-11-09',
    paymentMethod: 'transfer',
    paymentDueDate: '2026-11-23',
    parentInvoiceId: '00000000-0000-4000-8000-000000000001',
    parentInvoiceNumber: 'FV 2026/09/001',
    parentInvoiceIssueDate: '2026-09-30',
    parentKsefNumber: '1234567890-20260930-0100001AF629-AF',
    correctionType: typ,
    correctionReason: 'Zmiana warunków po reklamacji',
    typKorekty: '2',
    seller: { nip: '1234567890', name: 'ACME Software sp. z o.o.', address: adres('ul. Przykładowa 1/2') },
    buyer: { type: 'b2b', idType: 'nip', nip: '1234567890', name: 'Klient sp. z o.o.', address: adres('ul. Klienta 10') },
    ...(typ === 'amount_change' ? {} : { linesBefore: przed }),
    ...(typ === 'before_after' ? { linesAfter: po } : {}),
  } as unknown as CorrectionInvoiceData;
}

const grosze = (tekst: string) => Math.round(Number(tekst) * 100);
const pole = (nazwaPola: string) => new RegExp(`<${nazwaPola}>(-?[\\d.]+)</${nazwaPola}>`, 'g');
const pola = (xml: string, wzorzec: RegExp) => [...xml.matchAll(wzorzec)].map((d) => grosze(d[1]));
const suma = (liczby: number[]) => liczby.reduce((a, b) => a + b, 0);

/** Netto pozycji w groszach według stawek, kwotami z kalkulatora faktury. */
function nettoWgStawek(linie: Linia[]): Map<Stawka, number> {
  const wynik = new Map<Stawka, number>();
  for (const l of linie) wynik.set(l.vatRate, (wynik.get(l.vatRate) ?? 0) + Math.round(calculateLineItem(l).netAmount * 100));
  return wynik;
}

/**
 * `bezZerowych`: „przed/po” liczy różnicę `differenceSummaries`, która pomija
 * stawki bez różnicy. Anulowanie wykazuje każdą stawkę faktury pierwotnej,
 * także pozycję za 0,00 zł (np. 0,001 × 0,01 zł), co XSD przyjmuje.
 */
async function sprawdz(data: CorrectionInvoiceData, przed: Linia[], po: Linia[], bezZerowych: boolean) {
  const xml = generateCorrectionInvoiceXml(data, { generatedAt: new Date('2026-11-09T10:00:00Z') });
  const wynik = await validateFA3(xml);
  expect(wynik.errors.map((b) => b.message)).toEqual([]);
  // Strażnik FA(3) (F13 część 4) nie zgłasza alarmu dla pliku z prawdziwego generatora.
  expect(sprawdzFa3(xml)).toEqual([]);

  const p13 = suma(pola(xml, /<P_13_[0-9_]+>(-?[\d.]+)<\/P_13_[0-9_]+>/g));
  const p14 = suma(pola(xml, /<P_14_\d+>(-?[\d.]+)<\/P_14_\d+>/g));
  const [p15] = pola(xml, /<P_15>(-?[\d.]+)<\/P_15>/g);
  expect(p15).toBe(p13 + p14);

  const nettoPrzed = nettoWgStawek(przed);
  const nettoPo = nettoWgStawek(po);
  for (const s of Object.keys(POLE_NETTO) as Stawka[]) {
    const roznica = (nettoPo.get(s) ?? 0) - (nettoPrzed.get(s) ?? 0);
    const wXml = pola(xml, pole(POLE_NETTO[s]));
    if (bezZerowych) expect(wXml).toEqual(roznica === 0 ? [] : [roznica]);
    else {
      expect(wXml.length).toBeLessThanOrEqual(1);
      expect(suma(wXml)).toBe(roznica);
    }
  }
}

describe('FA(3) KOR: losowe korekty', () => {
  it('„przed/po”: XSD, P_15 = Σ P_13 + Σ P_14, P_13 każdej stawki = netto po minus netto przed (NZ-FA-10, NZ-FA-01, NZ-FA-04)', async () => {
    await fc.assert(
      fc.asyncProperty(przedPo, async ({ przed, po }) => {
        await sprawdz(korekta('before_after', przed, po), przed, po, true);
      }),
      opcjeXsd,
    );
  }, 600_000);

  it('anulowanie: XSD, P_13 każdej stawki = minus netto faktury pierwotnej (NZ-FA-10, NZ-FA-01, NZ-FA-04)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(pozycja, { minLength: 1, maxLength: 8 }), async (przed) => {
        await sprawdz(korekta('cancellation', przed, []), przed, [], false);
      }),
      opcjeXsd,
    );
  }, 600_000);

  it('kwotowa: XSD, kwoty różnicy tylko w polach swojej stawki, P_15 = brutto różnicy (NZ-FA-10, NZ-FA-01)', async () => {
    const kwotowa = fc.record({
      stawka,
      netto: fc.tuple(fc.integer({ min: 100, max: 100_000_000 }), fc.boolean()).map(([g, minus]) => (minus ? -g : g) / 100),
    });
    await fc.assert(
      fc.asyncProperty(kwotowa, async ({ stawka: s, netto }) => {
        const vat = roundToCents(netto * STOPA[s]);
        const brutto = roundToCents(netto + vat);
        const data = {
          ...korekta('amount_change', [], []),
          amountChange: { netDelta: netto, vatDelta: vat, grossDelta: brutto, description: 'Rabat posprzedażowy' },
        } as CorrectionInvoiceData;
        const xml = generateCorrectionInvoiceXml(data, { generatedAt: new Date('2026-11-09T10:00:00Z') });
        const wynik = await validateFA3(xml);
        expect(wynik.errors.map((b) => b.message)).toEqual([]);
        // Strażnik FA(3) (F13 część 4) nie zgłasza alarmu dla pliku z prawdziwego generatora.
        expect(sprawdzFa3(xml)).toEqual([]);

        for (const r of Object.keys(POLE_NETTO) as Stawka[]) {
          expect(pola(xml, pole(POLE_NETTO[r]))).toEqual(r === s ? [Math.round(netto * 100)] : []);
        }
        const poleVat = POLE_VAT[s];
        if (poleVat) expect(pola(xml, pole(poleVat))).toEqual([Math.round(vat * 100)]);
        expect(pola(xml, /<P_15>(-?[\d.]+)<\/P_15>/g)).toEqual([Math.round(brutto * 100)]);
      }),
      opcjeXsd,
    );
  }, 600_000);
});

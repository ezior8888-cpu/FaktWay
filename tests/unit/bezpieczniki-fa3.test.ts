import { beforeEach, describe, expect, it, vi } from 'vitest';

import { alarmujFa3, KODY_FA3, sprawdzFa3 } from '@/lib/bezpieczniki/fa3';
import { generateAdvanceInvoiceXml } from '@/lib/ksef/fa3-advance-generator';
import { generateFA3Xml } from '@/lib/xml/fa3-generator';
import { finalizeInvoice, type InvoiceInput } from '@/lib/xml/invoice-calculator';
import { validateFA3 } from '@/lib/xml/validator';
import type { Invoice, VatRate } from '@/types/invoice';
import type { AdvanceInvoiceData } from '@/types/invoice-types';

/**
 * Strażnik FA(3) (żelazny filtr F13 część 4, `lib/bezpieczniki/fa3.ts`).
 * Plik z prawdziwego generatora nie daje alarmu; plik zepsuty tak, jak
 * zrobiłby to błąd generatora (i dalej zgodny z XSD), daje alarm właściwej
 * kontroli. Losowe faktury wszystkich rodzajów bez alarmu sprawdzają testy
 * filtra w `tests/filtr/xsd/fa3*.test.ts`.
 */

const sentry = vi.hoisted(() => ({ captureMessage: vi.fn() }));
vi.mock('@sentry/nextjs', () => sentry);

function faktura(linie: Array<{ vatRate: VatRate; quantity: number; unitPriceNet: number }>): InvoiceInput {
  return {
    internalNumber: 'FV 2026/11/001',
    type: 'VAT',
    issueDate: '2026-11-09',
    saleDate: '2026-11-09',
    seller: { nip: '1234563218', name: 'Firma', address: { countryCode: 'PL', addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa' } },
    buyer: { nip: '1111111111', name: 'Klient', address: { countryCode: 'PL', addressLine1: 'ul. Klienta 2', addressLine2: '02-001 Warszawa' } },
    lines: linie.map((l, i) => ({ ordinal: i + 1, name: `Pozycja ${i + 1}`, unit: 'szt.', ...l })),
    payment: { currency: 'PLN', dueDate: '2026-11-23', method: 'transfer', bankAccount: 'PL61109010140000071219812874' },
  };
}

function xmlZ(linie: Parameters<typeof faktura>[0], podstawa?: string): string {
  const invoice: Invoice = finalizeInvoice(faktura(linie));
  const zAdnotacjami = podstawa ? { ...invoice, annotations: { vatExemptionBasis: podstawa } } : invoice;
  return generateFA3Xml(zAdnotacjami, { generatedAt: new Date('2026-11-09T10:00:00Z') });
}

const MIESZANA = [
  { vatRate: '23' as const, quantity: 3, unitPriceNet: 33.33 },
  { vatRate: '23' as const, quantity: 1, unitPriceNet: 0.07 },
  { vatRate: '8' as const, quantity: 2.5, unitPriceNet: 19.99 },
  { vatRate: '5' as const, quantity: 7, unitPriceNet: 1.13 },
  { vatRate: '0' as const, quantity: 1, unitPriceNet: 250 },
  { vatRate: 'zw' as const, quantity: 1, unitPriceNet: 120 },
];

/** Zamienia pierwsze wystąpienie pola na nową wartość (jak błąd generatora w jednym polu). */
function zmien(xml: string, pole: string, nowa: (stara: string) => string): string {
  const wzorzec = new RegExp(`<${pole}>([^<]*)</${pole}>`);
  expect(wzorzec.test(xml), pole).toBe(true);
  return xml.replace(wzorzec, (_c, stara: string) => `<${pole}>${nowa(stara)}</${pole}>`);
}
const plusGrosz = (s: string) => (Math.round(Number(s) * 100) + 1) / 100 + '';
const kody = (xml: string) => [...new Set(sprawdzFa3(xml).map((a) => a.kod))].sort();

beforeEach(() => {
  sentry.captureMessage.mockReset();
});

describe('strażnik FA(3): pliki z generatora', () => {
  it('faktura z sześcioma pozycjami w pięciu stawkach i zwolnieniem: bez alarmu, plik zgodny z XSD', async () => {
    const xml = xmlZ(MIESZANA, 'art. 43 ust. 1 pkt 37 ustawy o VAT');
    expect((await validateFA3(xml)).errors).toEqual([]);
    expect(sprawdzFa3(xml)).toEqual([]);
  });

  it.each(['oo', 'np'] as const)('pozycja %s: bez alarmu', (stawka) => {
    expect(sprawdzFa3(xmlZ([{ vatRate: stawka, quantity: 1, unitPriceNet: 99.99 }, { vatRate: '23', quantity: 1, unitPriceNet: 10 }]))).toEqual([]);
  });
});

describe('strażnik FA(3): plik zepsuty jak przez błąd generatora', () => {
  const dobry = () => xmlZ(MIESZANA, 'art. 43 ust. 1 pkt 37 ustawy o VAT');

  it('P_15 o grosz za dużo: FILTR-RT-FA3-01', () => {
    expect(kody(zmien(dobry(), 'P_15', plusGrosz))).toEqual([KODY_FA3.suma]);
  });

  it('P_11 pozycji o grosz inne: FILTR-RT-FA3-02', () => {
    expect(kody(zmien(dobry(), 'P_11', plusGrosz))).toEqual([KODY_FA3.pozycje]);
  });

  it('P_13_1 i P_15 przesunięte razem: sumy się zgadzają, pozycje nie (FILTR-RT-FA3-02)', () => {
    const xml = zmien(zmien(dobry(), 'P_13_1', plusGrosz), 'P_15', plusGrosz);
    expect(kody(xml)).toEqual([KODY_FA3.pozycje]);
  });

  it('VAT 23 % o złotówkę za dużo razem z P_15: FILTR-RT-FA3-03', () => {
    const plusZloty = (s: string) => (Math.round(Number(s) * 100) + 100) / 100 + '';
    const xml = zmien(zmien(dobry(), 'P_14_1', plusZloty), 'P_15', plusZloty);
    expect(kody(xml)).toEqual([KODY_FA3.podatek]);
  });

  it('VAT 8 % liczony stawką 23 %: FILTR-RT-FA3-03 i FILTR-RT-FA3-01', () => {
    const xml = zmien(dobry(), 'P_14_2', (s) => String(Math.round(Number(s) / 0.08 * 0.23 * 100) / 100));
    expect(kody(xml)).toEqual([KODY_FA3.suma, KODY_FA3.podatek]);
  });

  it('pozycja „zw” bez P_19: FILTR-RT-FA3-04', () => {
    const xml = dobry().replace(/<Zwolnienie>[\s\S]*?<\/Zwolnienie>/, '<Zwolnienie><P_19N>1</P_19N></Zwolnienie>');
    expect(kody(xml)).toEqual([KODY_FA3.oznaczenia]);
  });

  it('P_19 bez pozycji „zw” w fakturze VAT: FILTR-RT-FA3-04', () => {
    const xml = xmlZ([{ vatRate: '23', quantity: 1, unitPriceNet: 10 }])
      .replace(/<Zwolnienie>[\s\S]*?<\/Zwolnienie>/, '<Zwolnienie><P_19>1</P_19><P_19A>art. 43 ust. 1 pkt 37 ustawy o VAT</P_19A></Zwolnienie>');
    expect(kody(xml)).toEqual([KODY_FA3.oznaczenia]);
  });

  it('pozycja „oo” albo „np II” z P_18 = 2: FILTR-RT-FA3-04', () => {
    const oo = xmlZ([{ vatRate: 'oo', quantity: 1, unitPriceNet: 10 }]);
    expect(kody(zmien(oo, 'P_18', () => '2'))).toEqual([KODY_FA3.oznaczenia]);
    // „np II” wymaga nabywcy z VAT-UE w generatorze, więc ta sama faktura z pozycją przepisaną na np II (P_13_9).
    const npII = oo.replace('<P_12>oo</P_12>', '<P_12>np II</P_12>').replace(/<P_13_10>([^<]*)<\/P_13_10>/, '<P_13_9>$1</P_13_9>');
    expect(sprawdzFa3(npII)).toEqual([]);
    expect(kody(zmien(npII, 'P_18', () => '2'))).toEqual([KODY_FA3.oznaczenia]);
  });

  it('kwota z przecinkiem albo powtórzone pole: alarm kontroli, która go potrzebuje', () => {
    expect(kody(zmien(dobry(), 'P_15', (s) => s.replace('.', ',')))).toEqual([KODY_FA3.suma]);
    expect(kody(dobry().replace(/<P_15>/, '<P_15>1.00</P_15><P_15>'))).toEqual([KODY_FA3.suma]);
  });

  it('tekst, który nie jest fakturą: FILTR-RT-FA3-01', () => {
    expect(kody('<Faktura/>')).toEqual([KODY_FA3.suma]);
    expect(kody('nie xml')).toEqual([KODY_FA3.suma]);
  });

  it('alarm bez kwot i danych osobowych: rodzaj, miesiąc z P_1, opis z nazwami pól', () => {
    const [alarm] = sprawdzFa3(zmien(dobry(), 'P_15', plusGrosz));
    expect(alarm).toMatchObject({ kod: KODY_FA3.suma, rodzaj: 'vat', miesiac: '2026-11' });
    expect(alarm?.opis).not.toMatch(/\d+[.,]\d{2}|1234563218|1111111111|Klient|Firma/);
  });
});

describe('tryb „tylko alarm” (D-F7)', () => {
  it('alarm idzie do Sentry z kodem i firmą, faktura nie jest zatrzymywana', () => {
    const alarmy = alarmujFa3(zmien(xmlZ(MIESZANA, 'art. 43 ust. 1 pkt 37 ustawy o VAT'), 'P_15', plusGrosz), 'ten-1', 'fv-1');
    expect(alarmy.map((a) => a.kod)).toEqual([KODY_FA3.suma]);
    expect(sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(sentry.captureMessage.mock.calls[0]![1]).toMatchObject({
      tags: { kod: KODY_FA3.suma, tenantId: 'ten-1', straznik: 'fa3' },
      extra: { dokumentId: 'fv-1' },
      fingerprint: [KODY_FA3.suma, 'vat', '2026-11'],
    });
  });

  it('plik bez błędów: nic nie idzie do Sentry', () => {
    expect(alarmujFa3(xmlZ(MIESZANA, 'art. 43 ust. 1 pkt 37 ustawy o VAT'), 'ten-1', 'fv-1')).toEqual([]);
    expect(sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('błąd Sentry nie wychodzi poza strażnika', () => {
    const xml = zmien(xmlZ(MIESZANA, 'art. 43 ust. 1 pkt 37 ustawy o VAT'), 'P_15', plusGrosz);
    sentry.captureMessage.mockImplementation(() => { throw new Error('sentry padł'); });
    expect(() => alarmujFa3(xml, 'ten-1', 'fv-1')).not.toThrow();
  });
});

describe('strażnik FA(3): podatek od brutto i faktura zaliczkowa (FA3-03)', () => {
  /** Jedna pozycja 23 % policzona od brutto (art. 106e ust. 7), jak faktura za abonament: netto = brutto / 1,23, VAT = brutto − netto. */
  const odBrutto = (netto: string, vat: string, brutto: string) =>
    xmlZ([{ vatRate: '23', quantity: 1, unitPriceNet: 10 }])
      .replace(/<P_11>[^<]*<\/P_11>/, `<P_11>${netto}</P_11>`)
      .replace(/<P_13_1>[^<]*<\/P_13_1>/, `<P_13_1>${netto}</P_13_1>`)
      .replace(/<P_14_1>[^<]*<\/P_14_1>/, `<P_14_1>${vat}</P_14_1>`)
      .replace(/<P_15>[^<]*<\/P_15>/, `<P_15>${brutto}</P_15>`);

  it('abonament 22,49 zł od brutto (netto 18,28 zł, VAT 4,21 zł): bez alarmu', () => {
    expect(sprawdzFa3(odBrutto('18.28', '4.21', '22.49'))).toEqual([]);
  });

  it('ta sama pozycja z VAT policzonym stawką 8 %: FILTR-RT-FA3-03', () => {
    expect(kody(odBrutto('18.28', '1.46', '19.74'))).toEqual([KODY_FA3.podatek]);
  });

  const zaliczka = (stawka: '23' | '8', zaliczkaGr: number): string =>
    generateAdvanceInvoiceXml({
      invoiceType: 'advance',
      internalNumber: 'ZAL/2026/11/1',
      issueDate: '2026-11-09',
      paymentMethod: 'transfer',
      paymentDueDate: '2026-11-23',
      bankAccount: 'PL61109010140000071219812874',
      seller: { nip: '1234563218', name: 'Firma', address: { countryCode: 'PL', addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa' } },
      buyer: { type: 'b2b', idType: 'nip', nip: '1111111111', name: 'Klient', address: { countryCode: 'PL', addressLine1: 'ul. Klienta 2', addressLine2: '02-001 Warszawa' } },
      taxAnnotations: { cashMethod: 2, splitPayment: 2 },
      advanceAmount: zaliczkaGr / 100,
      totalContractAmount: 10_000,
      vatRate: stawka,
      description: 'Zaliczka na usługę',
    } as AdvanceInvoiceData, { generatedAt: new Date('2026-11-09T10:00:00Z') });

  it.each([['23', 123_000], ['23', 1_999], ['8', 54_321]] as const)('zaliczka %s %% z generatora (%i gr): bez alarmu', (stawka, gr) => {
    expect(sprawdzFa3(zaliczka(stawka, gr))).toEqual([]);
  });

  it('zaliczka z podatkiem o złotówkę wyższym i netto o złotówkę niższym (P_15 bez zmian): FILTR-RT-FA3-03', () => {
    const xml = zaliczka('23', 123_000);
    const zle = zmien(zmien(xml, 'P_14_1', (v) => (Math.round(Number(v) * 100) + 100) / 100 + ''), 'P_13_1', (v) => (Math.round(Number(v) * 100) - 100) / 100 + '');
    expect(kody(zle)).toEqual([KODY_FA3.podatek]);
  });
});

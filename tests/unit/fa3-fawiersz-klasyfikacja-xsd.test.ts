import { describe, expect, it } from 'vitest';

import { generateFinalInvoiceXml } from '@/lib/ksef/fa3-advance-generator';
import { generateCorrectionInvoiceXml } from '@/lib/ksef/fa3-correction-generator';
import { generateFA3Xml } from '@/lib/xml/fa3-generator';
import { finalizeInvoice } from '@/lib/xml/invoice-calculator';
import { validateInvoiceXml } from '@/lib/xml/validator';
import type { BuyerData, CorrectionInvoiceData, FinalInvoiceData, InvoiceLine, SellerData } from '@/types/invoice-types';

/**
 * Kolejność elementów `FaWiersz` w FA(3) z klasyfikacją pozycji (GTIN, PKWiU,
 * CN). Schemat (`lib/xml/schemas/fa3/schemat.xsd`, typ FaWiersz, sekwencja):
 * NrWierszaFa, UU_ID, P_6A, P_7, Indeks, GTIN, PKWiU, CN, PKOB, P_8A, P_8B…
 * Klasyfikacja stoi więc PO nazwie (P_7), a przed jednostką (P_8A). Trzy
 * generatory (zwykła, rozliczająca, korekta) pisały ją przed P_7, więc plik
 * z klasyfikacją nie przechodził walidacji XSD, a lokalna walidacja
 * zatrzymywała wystawienie.
 */

/** Nazwy elementów pierwszego `FaWiersz` w kolejności z pliku. */
function elementyPierwszegoWiersza(xml: string): string[] {
  const wiersz = /<FaWiersz>([\s\S]*?)<\/FaWiersz>/.exec(xml)?.[1] ?? '';
  return [...wiersz.matchAll(/<([A-Za-z_0-9]+)>/g)].map((m) => m[1]!);
}

function przedPoNazwie(elementy: string[], klasyfikacja: string): void {
  const p7 = elementy.indexOf('P_7');
  const kod = elementy.indexOf(klasyfikacja);
  const p8a = elementy.indexOf('P_8A');
  expect(p7).toBeGreaterThan(-1);
  expect(kod).toBeGreaterThan(p7);
  expect(p8a).toBeGreaterThan(kod);
}

const SPRZEDAWCA = {
  nip: '5260001246',
  name: 'ACME Software sp. z o.o.',
  address: { countryCode: 'PL', addressLine1: 'ul. Przykładowa 1/2', addressLine2: '00-001 Warszawa' },
};

function zwykla(classificationCode: string) {
  return finalizeInvoice({
    internalNumber: 'FV 1/11/2026',
    type: 'VAT',
    issueDate: '2026-11-16',
    saleDate: '2026-11-16',
    seller: SPRZEDAWCA,
    buyer: {
      nip: '5252241585',
      name: 'Klient sp. z o.o.',
      address: { countryCode: 'PL', addressLine1: 'ul. B 2', addressLine2: '00-002 Warszawa' },
    },
    lines: [{ ordinal: 1, name: 'Produkt', classificationCode, unit: 'szt.', quantity: 2, unitPriceNet: 50, vatRate: '23' }],
    payment: { currency: 'PLN', dueDate: '2026-11-30', method: 'transfer', bankAccount: 'PL61109010140000071219812874' },
  });
}

describe('FaWiersz z klasyfikacją: faktura zwykła', () => {
  it.each([
    ['GTIN', '5901234123457'],
    ['PKWiU', '62.01.11.0'],
    ['CN', '8471'],
  ])('%s stoi po P_7 i przed P_8A, plik zgodny z XSD', async (element, kod) => {
    const xml = generateFA3Xml(zwykla(kod));
    expect((await validateInvoiceXml(xml)).errors).toEqual([]);
    przedPoNazwie(elementyPierwszegoWiersza(xml), element);
  });
});

const SELLER: SellerData = {
  nip: '1234567890',
  name: 'Sprzedawca testowy',
  address: { countryCode: 'PL', addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa' },
};
const BUYER: BuyerData = {
  type: 'b2b',
  idType: 'nip',
  nip: '1234567890',
  name: 'Nabywca testowy',
  address: { countryCode: 'PL', addressLine1: 'ul. Testowa 2', addressLine2: '00-002 Warszawa' },
};
const pozycja = (unitPriceNet: number, pkwiuCode?: string): InvoiceLine => ({
  name: 'Usługa',
  unit: 'usł.',
  quantity: 1,
  unitPriceNet,
  vatRate: '23',
  ...(pkwiuCode ? { pkwiuCode } : {}),
});

describe('FaWiersz z klasyfikacją: faktura rozliczająca (ROZ)', () => {
  it('kod z pozycji (GTIN) stoi po P_7 i przed P_8A, plik zgodny z XSD', async () => {
    const data: FinalInvoiceData = {
      invoiceType: 'final',
      taxAnnotations: { cashMethod: 2, splitPayment: 2 },
      internalNumber: 'FR 1/11/2026',
      issueDate: '2026-11-16',
      paymentMethod: 'transfer',
      paymentDueDate: '2026-11-30',
      bankAccount: 'PL61109010140000071219812874',
      seller: SELLER,
      buyer: BUYER,
      advanceInvoiceIds: ['00000000-0000-4000-8000-000000000001'],
      totalAdvances: 1230,
      lines: [pozycja(5000, '5901234123457')],
    };
    const zaliczki = [{ internal_number: 'FZ 1/11/2026', ksef_number: null, advance_amount: 1230, issue_date: '2026-11-02', vat_rate: '23' }];
    const xml = generateFinalInvoiceXml(data, zaliczki);
    expect((await validateInvoiceXml(xml)).errors).toEqual([]);
    przedPoNazwie(elementyPierwszegoWiersza(xml), 'GTIN');
  });
});

describe('FaWiersz z klasyfikacją: korekta przed/po (KOR)', () => {
  it('kod z pozycji (GTIN) stoi po P_7 i przed P_8A w obu stanach, plik zgodny z XSD', async () => {
    const data: CorrectionInvoiceData = {
      invoiceType: 'correction',
      internalNumber: 'FK 1/11/2026',
      issueDate: '2026-11-16',
      paymentMethod: 'transfer',
      paymentDueDate: '2026-11-30',
      parentInvoiceId: '00000000-0000-4000-8000-000000000001',
      parentInvoiceNumber: 'FV 1/11/2026',
      parentInvoiceIssueDate: '2026-11-02',
      correctionType: 'before_after',
      correctionReason: 'Zmiana ceny',
      typKorekty: '2',
      seller: SELLER,
      buyer: BUYER,
      linesBefore: [pozycja(1000, '5901234123457')],
      linesAfter: [pozycja(900, '5901234123457')],
    };
    const xml = generateCorrectionInvoiceXml(data);
    expect((await validateInvoiceXml(xml)).errors).toEqual([]);
    for (const wiersz of xml.match(/<FaWiersz>[\s\S]*?<\/FaWiersz>/g) ?? []) {
      przedPoNazwie(elementyPierwszegoWiersza(wiersz), 'GTIN');
    }
    expect((xml.match(/<FaWiersz>/g) ?? []).length).toBeGreaterThan(0);
  });
});

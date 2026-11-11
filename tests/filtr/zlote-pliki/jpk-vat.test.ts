import { describe, expect, it } from 'vitest';

import type { ExportExpense } from '@/lib/exports/data-fetcher';
import { generateJpkFa, type JpkInvoice } from '@/lib/exports/jpk-fa-generator';
import { validateJpkFa } from '@/lib/exports/jpk-fa-validator';
import { generateJpkV7m } from '@/lib/exports/jpk-v7m-generator';
import { validateJpkV7m } from '@/lib/exports/jpk-v7m-validator';

/**
 * Złote pliki JPK_V7M(3) i JPK_FA(4) (żelazny filtr F8, plan B4.3): pełny
 * wynik generatora dla stałych danych. Każda zmiana pliku, nawet jednego
 * znaku, jest widoczna w PR i wymaga `zgoda:wiedza-prawna` (straż chroni
 * `tests/filtr/zlote-pliki/`). Nowy plik zapisuje
 * `pnpm exec vitest run -c vitest.filtr.config.ts tests/filtr/zlote-pliki -u`
 * (tylko świadomie, z opisem zmiany w karcie PR). Oba pliki muszą też
 * przechodzić oficjalny XSD.
 *
 * Sumy JPK_V7M policzone ręcznie (zł): P_10 1500, P_13 700, P_15 300, P_16 15,
 * P_17 500, P_18 40, P_19 900, P_20 207 (1000 + 100 - 200 netto; 230 + 23 - 46
 * VAT), P_37 3900, P_38 262, P_39 100, P_42 1250, P_43 173 (46 + 23 - 11,50 +
 * 115 = 172,50, w górę), P_48 273, P_51 0, P_53 11, P_62 11.
 * JPK_FA: WartoscFaktur 8 073,01 zł (1 338,01 + 500 + 700 + 1 230 + 4 305;
 * ROZ: 6 150 minus zaliczki 1 230 i 615).
 */
const KSEF_SPRZEDAZ = '1234567890-20260805-0100001AF629-AF';
const KSEF_ZAKUP = '1234567890-20260806-0100001AF629-B0';

const linia = (netAmount: number, vatRate: string, name = 'Usługa') =>
  ({ position: 1, name, unit: 'szt.', quantity: 1, unitPriceNet: netAmount, netAmount, vatRate });

function sprzedaz(o: Partial<JpkInvoice>): JpkInvoice {
  return {
    invoiceNumber: 'FS/1/08/2026',
    currency: 'PLN',
    invoiceType: 'regular',
    issueDate: '2026-08-05',
    buyerName: 'Klient Sp. z o.o.',
    buyerNip: '1234567890',
    netTotal: 1000,
    vatTotal: 230,
    grossTotal: 1230,
    ksefNumber: KSEF_SPRZEDAZ,
    lines: [linia(1000, '23')],
    ...o,
  } as JpkInvoice;
}

function zakup(o: Partial<ExportExpense>): ExportExpense {
  return {
    id: 'exp-1',
    issueDate: '2026-08-06',
    documentNumber: 'FZ/7/08/2026',
    documentType: 'invoice',
    sellerName: 'Dostawca Sp. z o.o.',
    sellerNip: '1234567890',
    sellerAddress: null,
    netAmount: 200,
    vatAmount: 46,
    grossAmount: 246,
    vatDeductibleAmount: 46,
    kpirColumn: 'col_13',
    categoryLabel: 'Usługi',
    ksefNumber: KSEF_ZAKUP,
    ...o,
  } as ExportExpense;
}

describe('złote pliki: JPK w VAT', () => {
  it('JPK_V7M(3): osoba fizyczna, wszystkie stawki, konsument bez KSeF, korekty in minus, odliczenie 50%, nadwyżka', async () => {
    const xml = generateJpkV7m({
      issuer: {
        nip: '1234567890',
        name: 'Jan Kowalski-Nowak Usługi & <Projekty>',
        email: 'biuro@example.test',
        taxOfficeCode: '1433',
        naturalPerson: { firstName: 'Jan', lastName: 'Kowalski-Nowak', birthDate: '1985-04-12' },
      },
      periodStart: '2026-08-01',
      periodEnd: '2026-08-31',
      generatedAt: new Date('2026-09-10T10:00:00Z'),
      previousSurplus: 100,
      issuedInvoices: [
        sprzedaz({}),
        sprzedaz({ invoiceNumber: 'FS/2/08/2026', saleDate: '2026-07-31', netTotal: 500, vatTotal: 40, grossTotal: 540, lines: [linia(500, '8', 'Książka')] }),
        sprzedaz({ invoiceNumber: 'FS/3/08/2026', netTotal: 300, vatTotal: 15, grossTotal: 315, lines: [linia(300, '5')] }),
        sprzedaz({ invoiceNumber: 'FS/4/08/2026', netTotal: 700, vatTotal: 0, grossTotal: 700, lines: [linia(700, '0', 'Eksport')] }),
        sprzedaz({ invoiceNumber: 'FS/5/08/2026', netTotal: 1500, vatTotal: 0, grossTotal: 1500, lines: [linia(1500, 'zw', 'Szkolenie')] }),
        sprzedaz({ invoiceNumber: 'FS/6/08/2026', buyerNip: undefined, buyerName: 'Jan Nowak', ksefNumber: undefined, netTotal: 100, vatTotal: 23, grossTotal: 123, lines: [linia(100, '23')] }),
        sprzedaz({ invoiceNumber: 'KOR/1/08/2026', invoiceType: 'correction', correctedInvoiceNumber: 'FS/9/07/2026', netTotal: -200, vatTotal: -46, grossTotal: -246, lines: [linia(-200, '23')] }),
      ],
      expenses: [
        zakup({}),
        zakup({ id: 'exp-2', documentNumber: 'PAP/1', ksefNumber: null, netAmount: 100, vatAmount: 23, grossAmount: 123, vatDeductibleAmount: 23 }),
        zakup({ id: 'exp-3', documentNumber: 'KOR/7/08', netAmount: -50, vatAmount: -11.5, grossAmount: -61.5, vatDeductibleAmount: -11.5 }),
        zakup({ id: 'exp-4', documentType: 'receipt', ksefNumber: null }),
        zakup({ id: 'exp-5', documentNumber: 'FZ/8/08/2026', netAmount: 1000, vatAmount: 230, grossAmount: 1230, vatDeductibleAmount: 115, categoryLabel: 'Samochód (50% VAT)' }),
      ],
    });
    expect((await validateJpkV7m(xml)).errors).toEqual([]);
    await expect(xml).toMatchFileSnapshot('./jpk-v7m3.xml');
  });

  it('JPK_FA(4): wiele stawek, zwolnienie, odwrotne obciążenie, poza krajem, 0%, zaliczka i rozliczenie', async () => {
    const pozycja = (name: string, net: number, vatRate: string, vatAmount: number, quantity = 1) =>
      ({ position: 1, name, unit: 'szt.', quantity, unitPriceNet: net / quantity, netAmount: net, vatRate, vatAmount });
    const fa = (o: Partial<JpkInvoice>): JpkInvoice =>
      ({
        invoiceNumber: 'FV/1', currency: 'PLN', invoiceType: 'regular', issueDate: '2026-09-10', buyerName: 'Klient Sp. z o.o.',
        buyerNip: '1234567890', buyerAddress: 'ul. Klienta 10, 02-001 Warszawa', netTotal: 1000, vatTotal: 230, grossTotal: 1230,
        lines: [pozycja('Usługa', 1000, '23', 230)], ...o,
      }) as JpkInvoice;
    const xml = generateJpkFa({
      issuer: {
        nip: '1234567890',
        name: 'ACME sp. z o.o.',
        taxOfficeCode: '1433',
        registeredAddress: {
          voivodeship: 'MAZOWIECKIE', county: 'Warszawa', commune: 'Mokotów', street: 'ul. Puławska',
          buildingNumber: '12', apartmentNumber: '3', city: 'Warszawa', postCode: '02-566',
        },
      },
      periodStart: '2026-09-01',
      periodEnd: '2026-09-30',
      generatedAt: new Date('2026-10-01T08:00:00Z'),
      issuedInvoices: [
        fa({
          invoiceNumber: 'FV/1', netTotal: 1100, vatTotal: 238.01, grossTotal: 1338.01,
          lines: [pozycja('Projekt', 1000, '23', 230.01), pozycja('Książka', 100, '8', 8)],
          annotations: { cashMethod: true, splitPayment: true },
        }),
        fa({ invoiceNumber: 'FV/2', netTotal: 500, vatTotal: 0, grossTotal: 500, lines: [pozycja('Szkolenie', 500, 'zw', 0, 2.5)], annotations: { vatExemptionBasis: 'art. 113 ust. 1 ustawy o VAT' } }),
        fa({
          invoiceNumber: 'FV/3', buyerNip: undefined, buyerName: '', buyerAddress: '', netTotal: 700, vatTotal: 0, grossTotal: 700,
          lines: [pozycja('Złom', 400, 'oo', 0), pozycja('Usługa w DE', 200, 'np', 0), pozycja('Eksport', 100, '0', 0)],
        }),
        fa({ invoiceNumber: 'ZAL/1', invoiceType: 'advance', netTotal: 1000, vatTotal: 230, grossTotal: 1230, lines: [pozycja('Zaliczka: strona WWW', 1000, '23', 230)] }),
        fa({
          invoiceNumber: 'ROZ/1', invoiceType: 'final', netTotal: 5000, vatTotal: 1150, grossTotal: 6150,
          lines: [pozycja('Strona WWW', 5000, '23', 1150)],
          advanceSettlement: [
            { internal_number: 'ZAL/1', advance_amount: 1230, issue_date: '2026-08-01', vat_rate: '23', net_amount: 1000, vat_amount: 230 },
            { internal_number: 'ZAL/2', advance_amount: 615, issue_date: '2026-08-15', vat_rate: '23' },
          ],
        }),
      ],
    });
    expect((await validateJpkFa(xml)).errors).toEqual([]);
    await expect(xml).toMatchFileSnapshot('./jpk-fa4.xml');
  });
});

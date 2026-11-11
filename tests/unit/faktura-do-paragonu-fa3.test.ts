import { describe, expect, it } from 'vitest';

import { storedSendPayload } from '@/lib/invoices/ksef-requeue-event';
import { generateFA3Xml, InvoiceValidationError } from '@/lib/xml/fa3-generator';
import { finalizeInvoice, validateInvoice, type InvoiceInput } from '@/lib/xml/invoice-calculator';
import { validateInvoiceXml } from '@/lib/xml/validator';
import type { BuyerParty, Invoice, ReceiptInvoiceData } from '@/types/invoice';

/**
 * Faktura do paragonu (FP), plan kompletnej aplikacji, krok 1.2.
 *
 * Prawdziwa ścieżka: `finalizeInvoice` -> `validateInvoice` -> `generateFA3Xml`
 * -> oficjalny XSD FA(3) (`validateInvoiceXml`). Przepisy (ustawa o VAT,
 * Dz.U. 2026 poz. 1263): art. 106b ust. 3 i 5, art. 106h ust. 1, art. 109
 * ust. 3d, art. 145n ust. 1 pkt 2; FA(3): `Fa/FP` = „Faktura, o której mowa
 * w art. 109 ust. 3d ustawy”, wartość „1” (broszura MF FA(3), sierpień 2026).
 *
 * Niezmienniki: FP zawsze z NIP nabywcy, gdy nabywca jest firmą; FP nie
 * zmienia kwot faktury; XML z FP zawsze przechodzi XSD.
 */

const NOW = new Date('2026-11-09T10:00:00Z');

// Generator zwykłej faktury sprawdza sumę kontrolną NIP, więc fixture'y jak
// w `fa3-generator.test.ts` (fikcyjny `1234567890` jej nie ma).
const SPRZEDAWCA = {
  nip: '5260001246',
  name: 'Sklep Testowy',
  address: { countryCode: 'PL', addressLine1: 'ul. Przykładowa 1', addressLine2: '00-001 Warszawa' },
};

const FIRMA: BuyerParty = {
  nip: '5252241585',
  name: 'Klient Sp. z o.o.',
  address: { countryCode: 'PL', addressLine1: 'ul. Klienta 10', addressLine2: '02-001 Warszawa' },
};

const KONSUMENT: BuyerParty = {
  noIdMarker: true,
  name: 'Jan Kowalski',
  address: { countryCode: 'PL', addressLine1: 'ul. Domowa 5', addressLine2: '00-002 Warszawa' },
};

const FIRMA_UE: BuyerParty = {
  vatUeNumber: 'DE123456789',
  name: 'Kunde GmbH',
  address: { countryCode: 'DE', addressLine1: 'Hauptstrasse 1', addressLine2: '10115 Berlin' },
};

const PARAGON: ReceiptInvoiceData = {
  receiptNumber: '000123',
  receiptDate: '2026-10-15',
  cashRegisterNumber: 'ABC1234567890',
  buyerNipOnReceipt: true,
};

function wejscie(o: Partial<InvoiceInput> = {}): InvoiceInput {
  return {
    internalNumber: 'FV 5/11/2026',
    type: 'VAT',
    issueDate: '2026-11-09',
    saleDate: '2026-10-15',
    seller: SPRZEDAWCA,
    buyer: FIRMA,
    lines: [{ ordinal: 1, name: 'Rower miejski', unit: 'szt.', quantity: 1, unitPriceNet: 1000, vatRate: '23' }],
    payment: { currency: 'PLN', dueDate: '2026-11-09', method: 'cash' },
    ...o,
  };
}

function fakturaDoParagonu(o: Partial<InvoiceInput> = {}, receipt: ReceiptInvoiceData = PARAGON): Invoice {
  return { ...finalizeInvoice(wejscie(o)), receipt };
}

const GENERATED_AT = new Date('2026-11-09T09:00:00Z');

describe('FA(3) faktury do paragonu', () => {
  it('XML ma FP = 1 zaraz po RodzajFaktury, dane paragonu w DodatkowyOpis i datę sprzedaży z paragonu; zgodny z XSD', async () => {
    const invoice = fakturaDoParagonu();
    expect(validateInvoice(invoice, NOW)).toEqual([]);

    const xml = generateFA3Xml(invoice, { generatedAt: GENERATED_AT });
    expect(xml).toContain('<P_6>2026-10-15</P_6>');
    expect(xml).toContain(
      '<RodzajFaktury>VAT</RodzajFaktury><FP>1</FP>' +
        '<DodatkowyOpis><Klucz>Numer paragonu</Klucz><Wartosc>000123</Wartosc></DodatkowyOpis>' +
        '<DodatkowyOpis><Klucz>Data paragonu</Klucz><Wartosc>2026-10-15</Wartosc></DodatkowyOpis>' +
        '<DodatkowyOpis><Klucz>Numer unikatowy kasy</Klucz><Wartosc>ABC1234567890</Wartosc></DodatkowyOpis>' +
        '<FaWiersz>',
    );

    const wynik = await validateInvoiceXml(xml);
    expect(wynik.errors).toEqual([]);
    expect(wynik.valid).toBe(true);
  });

  it('niezmiennik: FP nie zmienia kwot (poza FP i DodatkowyOpis XML jest bajt w bajt taki jak bez paragonu)', () => {
    // Ponad 450 zł brutto (inaczej paragon z NIP z 2026 r. jest fakturą uproszczoną), z zaokrągleniami w każdej stawce.
    const lines: InvoiceInput['lines'] = [
      { ordinal: 1, name: 'Usługa', unit: 'usł.', quantity: 3, unitPriceNet: 333.33, vatRate: '23' },
      { ordinal: 2, name: 'Książka', unit: 'szt.', quantity: 2, unitPriceNet: 25, vatRate: '5' },
      { ordinal: 3, name: 'Kanapka', unit: 'szt.', quantity: 7, unitPriceNet: 0.1, vatRate: '8' },
    ];
    const zParagonem = generateFA3Xml(fakturaDoParagonu({ lines }), { generatedAt: GENERATED_AT });
    const bezParagonu = generateFA3Xml(finalizeInvoice(wejscie({ lines })), { generatedAt: GENERATED_AT });
    expect(zParagonem).not.toBe(bezParagonu);
    const bezOznaczen = zParagonem.replace('<FP>1</FP>', '').replace(/<DodatkowyOpis>.*?<\/DodatkowyOpis>/g, '');
    expect(bezOznaczen).toBe(bezParagonu);
  });

  it.each<[string, Partial<InvoiceInput>, ReceiptInvoiceData]>([
    ['firma z NIP', {}, PARAGON],
    ['osoba prywatna bez identyfikatora', { buyer: KONSUMENT }, { ...PARAGON, buyerNipOnReceipt: undefined }],
    [
      'osoba prywatna z PESEL',
      { buyer: { ...KONSUMENT, noIdMarker: undefined, pesel: '44051401359' } },
      { ...PARAGON, buyerNipOnReceipt: undefined },
    ],
    ['żądanie zgłoszone wcześniej niż wystawienie', {}, { ...PARAGON, requestDate: '2026-10-20' }],
    ['numer paragonu ze znakami do ucieczki w XML', {}, { ...PARAGON, receiptNumber: 'P&R <12>/"34"' }],
    ['stary numer kasy: 3 litery i 8 cyfr', {}, { ...PARAGON, cashRegisterNumber: 'BEA12345678' }],
    ['paragon z dnia wystawienia (bez P_6)', { saleDate: undefined }, { ...PARAGON, receiptDate: '2026-11-09' }],
  ])('niezmiennik: XML z FP zawsze przechodzi XSD (%s)', async (_opis, o, receipt) => {
    const invoice = fakturaDoParagonu(o, receipt);
    expect(validateInvoice(invoice, NOW)).toEqual([]);
    const xml = generateFA3Xml(invoice, { generatedAt: GENERATED_AT });
    expect(xml).toContain('<FP>1</FP>');
    const wynik = await validateInvoiceXml(xml);
    expect(wynik.errors).toEqual([]);
  });

  it('zwykła faktura bez paragonu nie dostaje FP ani DodatkowyOpis', () => {
    const xml = generateFA3Xml(finalizeInvoice(wejscie()), { generatedAt: GENERATED_AT });
    expect(xml).not.toContain('<FP>');
    expect(xml).not.toContain('<DodatkowyOpis>');
  });
});

describe('FP: odmowy przed wysyłką (validateInvoice, ta sama walidacja co job i szkic)', () => {
  const bledy = (o: Partial<InvoiceInput>, receipt: ReceiptInvoiceData, now = NOW) =>
    validateInvoice(fakturaDoParagonu(o, receipt), now);

  it('niezmiennik: firma bez potwierdzenia NIP na paragonie: odmowa (art. 106b ust. 5)', () => {
    expect(bledy({}, { ...PARAGON, buyerNipOnReceipt: undefined }).join(' ')).toMatch(
      /paragon ma NIP nabywcy.*art\. 106b ust\. 5/,
    );
  });

  it('firma z UE: odmowa, FP tylko dla firmy z NIP albo osoby prywatnej', () => {
    expect(bledy({ buyer: FIRMA_UE }, PARAGON).join(' ')).toMatch(/firmy z UE/);
  });

  it('osoba prywatna: bez NIP i bez potwierdzenia, bez błędów', () => {
    expect(bledy({ buyer: KONSUMENT }, { ...PARAGON, buyerNipOnReceipt: undefined })).toEqual([]);
  });

  it('po terminie 3 miesięcy od końca miesiąca sprzedaży: odmowa z datą końca terminu', () => {
    const e = bledy({ saleDate: '2026-07-31' }, { ...PARAGON, receiptDate: '2026-07-31' }).join(' ');
    expect(e).toMatch(/3 miesięcy od końca miesiąca sprzedaży \(art\. 106b ust\. 3/);
    expect(e).toContain('31.10.2026');
  });

  it('ostatni dzień terminu: bez błędów', () => {
    expect(
      bledy(
        { saleDate: '2026-08-01', issueDate: '2026-11-30', payment: { currency: 'PLN', dueDate: '2026-11-30', method: 'cash' } },
        { ...PARAGON, receiptDate: '2026-08-01' },
        new Date('2026-11-30T10:00:00Z'),
      ),
    ).toEqual([]);
  });

  it('żądanie w terminie, wystawienie po terminie: dozwolone z datą żądania', () => {
    expect(
      bledy({ saleDate: '2026-07-31' }, { ...PARAGON, receiptDate: '2026-07-31', requestDate: '2026-10-30' }),
    ).toEqual([]);
  });

  it('data żądania przed paragonem albo po wystawieniu: odmowa', () => {
    expect(bledy({}, { ...PARAGON, requestDate: '2026-10-14' }).join(' ')).toMatch(/Data żądania faktury/);
    expect(bledy({}, { ...PARAGON, requestDate: '2026-11-10' }).join(' ')).toMatch(/Data żądania faktury/);
  });

  it('data sprzedaży inna niż data paragonu: odmowa', () => {
    expect(bledy({ saleDate: '2026-10-16' }, PARAGON).join(' ')).toMatch(/data sprzedaży to data z paragonu \(15\.10\.2026\)/);
  });

  it('paragon późniejszy niż wystawienie: odmowa', () => {
    expect(bledy({ saleDate: undefined }, { ...PARAGON, receiptDate: '2026-11-10' }).join(' ')).toMatch(
      /Data paragonu nie może być późniejsza niż data wystawienia/,
    );
  });

  it('firma, paragon z 2026 r. do 450 zł brutto: odmowa, paragon z NIP jest fakturą uproszczoną (art. 145n)', () => {
    const lines: InvoiceInput['lines'] = [{ ordinal: 1, name: 'Drobiazg', unit: 'szt.', quantity: 1, unitPriceNet: 365.85, vatRate: '23' }];
    // 365,85 netto + 84,15 VAT = 450,00 brutto: „nie przekracza 450 zł”.
    expect(bledy({ lines }, PARAGON).join(' ')).toMatch(/do 450 zł brutto.*art\. 145n ust\. 1 pkt 2/);
  });

  it('firma, paragon z 2026 r. ponad 450 zł brutto: bez błędów', () => {
    const lines: InvoiceInput['lines'] = [{ ordinal: 1, name: 'Drobiazg', unit: 'szt.', quantity: 1, unitPriceNet: 365.86, vatRate: '23' }];
    expect(bledy({ lines }, PARAGON)).toEqual([]);
  });

  it('osoba prywatna, paragon do 450 zł: bez błędów (paragon bez NIP nie jest fakturą)', () => {
    const lines: InvoiceInput['lines'] = [{ ordinal: 1, name: 'Drobiazg', unit: 'szt.', quantity: 1, unitPriceNet: 100, vatRate: '23' }];
    expect(bledy({ lines, buyer: KONSUMENT }, { ...PARAGON, buyerNipOnReceipt: undefined })).toEqual([]);
  });

  it('firma, paragon z 2027 r. do 450 zł: bez błędów (art. 145n obowiązuje do 31.12.2026)', () => {
    const lines: InvoiceInput['lines'] = [{ ordinal: 1, name: 'Drobiazg', unit: 'szt.', quantity: 1, unitPriceNet: 100, vatRate: '23' }];
    expect(
      bledy(
        { lines, issueDate: '2027-01-05', saleDate: '2027-01-04', payment: { currency: 'PLN', dueDate: '2027-01-05', method: 'cash' } },
        { ...PARAGON, receiptDate: '2027-01-04' },
        new Date('2027-01-05T10:00:00Z'),
      ),
    ).toEqual([]);
  });

  it.each(['12345678', 'ABCD1234567890', 'AB123456789', ''])('numer kasy „%s”: odmowa', (cashRegisterNumber) => {
    expect(bledy({}, { ...PARAGON, cashRegisterNumber }).join(' ')).toMatch(/Numer unikatowy kasy/);
  });

  it.each(['ABC1234567890', 'BEA12345678', 'AB12345678'])('numer kasy „%s”: bez błędów', (cashRegisterNumber) => {
    expect(bledy({}, { ...PARAGON, cashRegisterNumber })).toEqual([]);
  });

  it('pusty numer paragonu: odmowa', () => {
    expect(bledy({}, { ...PARAGON, receiptNumber: '  ' }).join(' ')).toMatch(/numer paragonu/i);
  });

  it('paragon przy korekcie: odmowa (FP tylko przy zwykłej fakturze VAT)', () => {
    expect(bledy({ type: 'KOR' }, PARAGON).join(' ')).toMatch(/zwykłą fakturę VAT/);
  });

  it('generator nie pisze XML z błędnym FP (InvoiceValidationError)', () => {
    expect(() => generateFA3Xml(fakturaDoParagonu({ buyer: FIRMA_UE }))).toThrow(InvoiceValidationError);
  });
});

describe('FP przy ponowieniu z kopii (fa3_data, `storedSendPayload`)', () => {
  it('kopia zwykłej faktury niesie paragon, więc ponowiony XML ma FP', () => {
    const invoice = fakturaDoParagonu();
    const payload = storedSendPayload({
      invoice_kind: 'regular',
      issue_date: invoice.issueDate,
      fa3_data: JSON.parse(JSON.stringify(invoice)),
      special_data: null,
    });
    expect(payload?.invoice.receipt).toEqual(PARAGON);
    expect(generateFA3Xml(payload!.invoice, { generatedAt: GENERATED_AT })).toContain('<FP>1</FP>');
  });
});

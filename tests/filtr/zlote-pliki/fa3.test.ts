import { describe, expect, it } from 'vitest';

import { generateFA3Xml } from '@/lib/xml/fa3-generator';
import { finalizeInvoice } from '@/lib/xml/invoice-calculator';
import { validateFA3 } from '@/lib/xml/validator';

/**
 * Złoty plik FA(3), faktura zwykła (żelazny filtr F8, plan B4.3): pełny XML
 * dla stałych danych. Zmiana generatora, która zmienia choć jeden znak
 * faktury dla wszystkich firm, jest widoczna w PR (zgoda:wiedza-prawna).
 * Pozycje w czterech stawkach, ilość z częścią dziesiętną, znaki specjalne
 * XML w nazwie, kwota z groszami na granicy zaokrąglenia.
 */
describe('złote pliki: FA(3)', () => {
  it('faktura zwykła w PLN: stawki 23, 8, 5 i 0 %', async () => {
    const invoice = finalizeInvoice({
      internalNumber: 'FV 2026/11/001',
      type: 'VAT',
      issueDate: '2026-11-09',
      saleDate: '2026-11-06',
      seller: {
        nip: '5260001246',
        name: 'ACME Software sp. z o.o.',
        address: { countryCode: 'PL', addressLine1: 'ul. Przykładowa 1/2', addressLine2: '00-001 Warszawa' },
        email: 'biuro@acme.test',
      },
      buyer: {
        nip: '5252241585',
        name: 'Klient „Nowak & Syn” sp. z o.o.',
        address: { countryCode: 'PL', addressLine1: 'ul. Klienta 10', addressLine2: '02-001 Warszawa' },
        email: 'kontakt@klient.test',
      },
      lines: [
        { ordinal: 1, name: 'Licencja SaaS <Pro>', unit: 'usł.', quantity: 1, unitPriceNet: 199, vatRate: '23' },
        { ordinal: 2, name: 'Wdrożenie (godziny)', unit: 'godz.', quantity: 2.5, unitPriceNet: 150.33, vatRate: '23' },
        { ordinal: 3, name: 'Książka', unit: 'szt.', quantity: 3, unitPriceNet: 33.33, vatRate: '5' },
        { ordinal: 4, name: 'Usługa gastronomiczna', unit: 'usł.', quantity: 1, unitPriceNet: 12.35, vatRate: '8' },
        { ordinal: 5, name: 'Dostawa krajowa 0 %', unit: 'szt.', quantity: 1, unitPriceNet: 10, vatRate: '0' },
      ],
      payment: {
        currency: 'PLN',
        dueDate: '2026-11-23',
        method: 'transfer',
        bankAccount: 'PL61109010140000071219812874',
        bankName: 'Santander Bank Polska',
      },
    });
    const xml = generateFA3Xml(invoice, { generatedAt: new Date('2026-11-09T10:00:00Z'), prettyPrint: true });
    expect((await validateFA3(xml)).errors).toEqual([]);
    await expect(xml).toMatchFileSnapshot('./fa3-zwykla.xml');
  });
});

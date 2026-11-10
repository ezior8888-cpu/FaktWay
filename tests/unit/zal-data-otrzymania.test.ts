import { describe, expect, it, vi } from 'vitest';

// Fikcyjny NIP 1234567890 nie ma poprawnej sumy kontrolnej, jak w innych testach formularzy.
vi.mock('@/lib/xml/invoice-calculator', async (orig) => ({
  ...(await orig<typeof import('@/lib/xml/invoice-calculator')>()),
  validateNipChecksum: () => true,
}));

import { generateAdvanceInvoiceXml } from '@/lib/ksef/fa3-advance-generator';
import { advanceInvoiceSchema } from '@/lib/validators/invoice-validators';
import { validateInvoiceXml } from '@/lib/xml/validator';
import type { AdvanceInvoiceData } from '@/types/invoice-types';

/**
 * F12-D1 (przegląd wsteczny wystawiania ZAL, waga wysoka, dotyczy produkcji):
 * faktura zaliczkowa nie miała daty otrzymania zaliczki. Art. 106f ust. 1
 * pkt 1 w zw. z art. 106e ust. 1 pkt 6 ustawy o VAT i opis P_6 w schemacie
 * FA(3): „data otrzymania zapłaty, o której mowa w art. 106b ust. 1 pkt 4,
 * o ile taka data jest określona i różni się od daty wystawienia faktury”.
 * Zaliczka z 28.10 na ZAL z 03.11 szła bez P_6, a obowiązek podatkowy
 * powstaje z otrzymaniem zaliczki (art. 19a ust. 8).
 */
const address = { countryCode: 'PL', addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa' };

function zal(o: Partial<AdvanceInvoiceData> = {}): AdvanceInvoiceData {
  return {
    invoiceType: 'advance',
    internalNumber: 'ZAL/2026/11/1',
    issueDate: '2026-11-03',
    paymentMethod: 'transfer',
    paymentDueDate: '2026-11-03',
    bankAccount: 'PL61109010140000071219812874',
    seller: { nip: '1234567890', name: 'Sprzedawca testowy', address },
    buyer: { type: 'b2b', idType: 'nip', nip: '1234567890', name: 'Nabywca testowy', address },
    taxAnnotations: { cashMethod: 2, splitPayment: 2 },
    advanceAmount: 1230,
    totalContractAmount: 12300,
    vatRate: '23',
    description: 'Projekt strony internetowej',
    ...o,
  } as AdvanceInvoiceData;
}

const formularz = (o: Record<string, unknown> = {}) => ({
  invoiceType: 'advance',
  internalNumber: 'ZAL/2026/11/1',
  issueDate: '2026-11-03',
  paymentMethod: 'transfer',
  paymentDueDate: '2026-11-10',
  bankAccount: '61109010140000071219812874',
  splitPayment: false,
  seller: { nip: '1234567890', name: 'Sprzedawca testowy', address },
  buyer: { type: 'b2b', idType: 'nip', nip: '1234567890', name: 'Nabywca testowy', address },
  advanceAmount: 1230,
  totalContractAmount: 12300,
  vatRate: '23',
  description: 'Projekt strony internetowej',
  ...o,
});

describe('F12-D1: data otrzymania zaliczki (P_6) na ZAL', () => {
  it('schemat formularza przyjmuje datę otrzymania zaliczki i nie gubi jej', () => {
    const wynik = advanceInvoiceSchema.safeParse(formularz({ advanceReceivedDate: '2026-10-28' }));
    expect(wynik.success, JSON.stringify(wynik.error?.issues)).toBe(true);
    expect(wynik.success && (wynik.data as { advanceReceivedDate?: string }).advanceReceivedDate).toBe('2026-10-28');
  });

  it('data otrzymania ponad 60 dni po wystawieniu: błąd z przepisem (art. 106i ust. 7)', () => {
    const wynik = advanceInvoiceSchema.safeParse(formularz({ advanceReceivedDate: '2027-01-15' }));
    expect(wynik.success).toBe(false);
    expect(JSON.stringify(wynik.error?.issues)).toContain('106i');
  });

  it('XML: P_6 z datą otrzymania zaliczki, gdy różni się od daty wystawienia, i plik przechodzi XSD FA(3)', async () => {
    const xml = generateAdvanceInvoiceXml(zal({ advanceReceivedDate: '2026-10-28' }), { generatedAt: new Date('2026-11-03T10:00:00Z') });
    expect(xml).toContain('<P_6>2026-10-28</P_6>');
    expect((await validateInvoiceXml(xml)).errors).toEqual([]);
  });

  it('XML: bez P_6, gdy daty nie ma albo jest taka sama jak data wystawienia', () => {
    const opcje = { generatedAt: new Date('2026-11-03T10:00:00Z') };
    expect(generateAdvanceInvoiceXml(zal(), opcje)).not.toContain('<P_6>');
    expect(generateAdvanceInvoiceXml(zal({ advanceReceivedDate: '2026-11-03' }), opcje)).not.toContain('<P_6>');
  });
});

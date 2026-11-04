import { describe, expect, it } from 'vitest';

import { generateFA3Xml, InvoiceValidationError } from '@/lib/xml/fa3-generator';
import { finalizeInvoice } from '@/lib/xml/invoice-calculator';
import { validateInvoiceXml } from '@/lib/xml/validator';
import type { Invoice, InvoiceAnnotations } from '@/types/invoice';

/**
 * C5b: adnotacje z importu mają nowe klucze (`vatExemptionBasisKind`,
 * `newMeansOfTransport`, `marginScheme`). Generator FA(3) jest ich
 * konsumentem — nie może ich po cichu zgubić: podstawa z dyrektywy idzie jako
 * P_19B (nie P_19A), a procedur, których FaktWay nie wystawia, nie emituje
 * jako „nie dotyczy”. Dziś żaden wiersz z importu nie trafia do generatora
 * (brak `fa3_data.lines`); to bezpiecznik przed D-A4-1b-3 PR C.
 */

function faktura(annotations: InvoiceAnnotations, rate: 'zw' | '23' = 'zw'): Invoice {
  const inv = finalizeInvoice({
    internalNumber: 'FV/GEN/1', type: 'VAT', issueDate: '2026-09-10', saleDate: '2026-09-10',
    seller: { nip: '1234567890', name: 'Firma testowa', address: { countryCode: 'PL', addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa' } },
    buyer: { nip: '1234567890', name: 'Nabywca testowy', address: { countryCode: 'PL', addressLine1: 'ul. Testowa 2', addressLine2: '00-002 Warszawa' } },
    lines: [{ ordinal: 1, name: 'Usługa', unit: 'usł.', quantity: 1, unitPriceNet: 500, vatRate: rate }],
    payment: { currency: 'PLN', dueDate: '2026-09-24', method: 'transfer', bankAccount: '61109010140000071219812874' },
  } as Invoice);
  return { ...inv, annotations };
}
const gen = (inv: Invoice) => generateFA3Xml(inv, { validate: false, generatedAt: new Date('2026-09-10T08:00:00Z') });

describe('FA(3) — rodzaj podstawy zwolnienia i procedury z importu', () => {
  it('vatExemptionBasisKind P_19B → <P_19B>, bez P_19A; XSD MF', async () => {
    const xml = gen(faktura({ vatExemptionBasis: 'art. 132 dyrektywy 2006/112/WE', vatExemptionBasisKind: 'P_19B' }));
    expect(xml).toContain('<P_19B>art. 132 dyrektywy 2006/112/WE</P_19B>');
    expect(xml).not.toContain('<P_19A>');
    expect((await validateInvoiceXml(xml)).errors).toEqual([]);
  });

  it('bez rodzaju → P_19A jak dotąd (faktury FaktWay)', () => {
    expect(gen(faktura({ vatExemptionBasis: 'art. 113 ust. 1 ustawy o VAT' }))).toContain('<P_19A>art. 113 ust. 1 ustawy o VAT</P_19A>');
  });

  it.each([
    ['nowe środki transportu (P_22)', { newMeansOfTransport: 1 } as InvoiceAnnotations],
    ['procedura marży', { marginScheme: 'P_PMarzy_3_1' } as InvoiceAnnotations],
  ])('%s → odmowa (FaktWay tego nie wystawia), nie „nie dotyczy”', (_n, annotations) => {
    expect(() => gen(faktura(annotations, '23'))).toThrow(InvoiceValidationError);
  });

  it('newMeansOfTransport = 2 (z importu, „nie dotyczy”) → bez zmian, P_22N', () => {
    expect(gen(faktura({ newMeansOfTransport: 2 }, '23'))).toContain('<P_22N>1</P_22N>');
  });
});

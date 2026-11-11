import { describe, expect, it } from 'vitest';

import {
  canWriteQuotes,
  formatQuoteNumber,
  QUOTE_KIND_LABELS,
  quoteItems,
  quoteTotals,
  quoteVatSummary,
  type QuoteItemInput,
  type SalesQuote,
} from '@/lib/proformy/model';
import { quoteDraftSchema, quoteIssueDateError, quoteToDraftInput, type QuoteDraftInput } from '@/lib/proformy/schemat';
import { calculateInvoiceTotals, calculateLineItem } from '@/lib/xml/invoice-calculator';

/**
 * Proforma i oferta (plan kompletnej aplikacji, krok 2.4): kwoty jak na
 * fakturze, czyli te same funkcje (`calculateLineItem`,
 * `calculateInvoiceTotals`, zaokrąglenie tylko `roundToCents`), numer w kształcie
 * z bazy, role jak przy fakturach i jeden schemat Zod dla formularza i akcji.
 */

const KONTRAHENT = '0b8a3f4e-2c1d-4e5f-8a9b-0c1d2e3f4a5b';

const POZYCJE: QuoteItemInput[] = [
  { name: 'Usługa A', unit: 'godz.', quantity: 3, unitPriceNet: 0.1, vatRate: '23' },
  { name: 'Towar B', unit: 'szt', quantity: 1.005, unitPriceNet: 1, vatRate: '8' },
  { name: 'Szkolenie zwolnione', unit: 'szt', quantity: 2, unitPriceNet: 50, vatRate: 'zw' },
];

function dane(zmiany: Partial<QuoteDraftInput> = {}): QuoteDraftInput {
  return {
    kind: 'proforma',
    contractorId: KONTRAHENT,
    issueDate: '2026-11-11',
    validUntil: '',
    items: [{ name: 'Wdrożenie systemu', unit: 'szt', quantity: 1, unitPriceNet: 1000, vatRate: '23' }],
    currency: 'PLN',
    paymentMethod: 'transfer',
    paymentDueDate: '2026-11-25',
    bankAccount: 'PL61 1090 1014 0000 0712 1981 2874',
    notes: '',
    ...zmiany,
  };
}

function pierwszyBlad(input: unknown): { path: string; message: string } | null {
  const r = quoteDraftSchema.safeParse(input);
  if (r.success) return null;
  const issue = r.error.issues[0]!;
  return { path: issue.path.join('.'), message: issue.message };
}

describe('kwoty jak na fakturze', () => {
  it('pozycja: netto, VAT i brutto z calculateLineItem (zaokrąglenie roundToCents)', () => {
    const items = quoteItems(POZYCJE);
    items.forEach((item, i) => expect(item).toEqual({ ...POZYCJE[i], ...calculateLineItem(POZYCJE[i]!) }));
    // 3 × 0,10 w liczbach binarnych to 0,30000000000000004; 1,005 to odrobinę mniej niż 1,005.
    expect(items[0]).toMatchObject({ netAmount: 0.3, vatAmount: 0.07, grossAmount: 0.37 });
    expect(items[1]).toMatchObject({ netAmount: 1.01, vatAmount: 0.08, grossAmount: 1.09 });
    expect(items[2]).toMatchObject({ netAmount: 100, vatAmount: 0, grossAmount: 100 });
  });

  it('sumy: calculateInvoiceTotals, tak jak na fakturze z tymi pozycjami', () => {
    const items = quoteItems(POZYCJE);
    const totals = quoteTotals(items);
    expect(totals).toEqual(calculateInvoiceTotals(items.map((item, i) => ({ ordinal: i + 1, ...item }))));
    expect(totals).toEqual({ netTotal: 101.31, vatTotal: 0.15, grossTotal: 101.46 });
  });

  it('podsumowanie według stawek: kolejność pierwszego wystąpienia, brutto = netto + VAT', () => {
    expect(quoteVatSummary(quoteItems(POZYCJE))).toEqual([
      { rate: '23', net: 0.3, vat: 0.07, gross: 0.37 },
      { rate: '8', net: 1.01, vat: 0.08, gross: 1.09 },
      { rate: 'zw', net: 100, vat: 0, gross: 100 },
    ]);
  });
});

describe('numer, rola i nazwy', () => {
  it('numer w kształcie z bazy: PRO/<kolejny>/<rok> i OF/<kolejny>/<rok>', () => {
    expect(formatQuoteNumber('proforma', 1, 2026)).toBe('PRO/1/2026');
    expect(formatQuoteNumber('offer', 12, 2027)).toBe('OF/12/2027');
  });

  it('rola jak przy fakturach: właściciel, administrator, członek, księgowy', () => {
    for (const role of ['owner', 'admin', 'member', 'accountant']) expect(canWriteQuotes(role), role).toBe(true);
    for (const role of ['viewer', '', null, undefined]) expect(canWriteQuotes(role), String(role)).toBe(false);
  });

  it('nazwy rodzajów nie mówią „faktura”', () => {
    expect(QUOTE_KIND_LABELS).toEqual({ proforma: 'Proforma', offer: 'Oferta' });
  });
});

describe('schemat szkicu: formularz i akcja', () => {
  it('proforma: przelew z rachunkiem (zapis bez spacji), termin; puste pola jako null', () => {
    const r = quoteDraftSchema.parse(dane());
    expect(r).toMatchObject({
      kind: 'proforma',
      contractorId: KONTRAHENT,
      issueDate: '2026-11-11',
      validUntil: null,
      currency: 'PLN',
      paymentMethod: 'transfer',
      paymentDueDate: '2026-11-25',
      bankAccount: 'PL61109010140000071219812874',
      notes: null,
    });
    expect(r.items).toEqual([{ name: 'Wdrożenie systemu', unit: 'szt', quantity: 1, unitPriceNet: 1000, vatRate: '23' }]);
  });

  it('proforma przelewem bez rachunku: błąd przy numerze rachunku', () => {
    expect(pierwszyBlad(dane({ bankAccount: '' }))).toMatchObject({ path: 'bankAccount', message: expect.stringMatching(/rachunk/) });
  });

  it('proforma gotówką: bez rachunku przechodzi', () => {
    expect(quoteDraftSchema.parse(dane({ paymentMethod: 'cash', bankAccount: '' }))).toMatchObject({ bankAccount: null });
  });

  it('termin zapłaty przed datą wystawienia: błąd przy terminie', () => {
    expect(pierwszyBlad(dane({ paymentDueDate: '2026-11-10' }))).toMatchObject({ path: 'paymentDueDate' });
  });

  it('oferta: wymaga daty ważności nie wcześniejszej niż wystawienie; płatności nie zapisuje', () => {
    expect(pierwszyBlad(dane({ kind: 'offer', validUntil: '' }))).toMatchObject({ path: 'validUntil', message: expect.stringMatching(/ważn/i) });
    expect(pierwszyBlad(dane({ kind: 'offer', validUntil: '2026-11-10' }))).toMatchObject({ path: 'validUntil' });
    expect(quoteDraftSchema.parse(dane({ kind: 'offer', validUntil: '2026-12-11' }))).toMatchObject({
      kind: 'offer',
      validUntil: '2026-12-11',
      paymentMethod: null,
      paymentDueDate: null,
      bankAccount: null,
    });
  });

  it('pola drugiego rodzaju (ukryte w formularzu) nie blokują zapisu i nie trafiają do dokumentu', () => {
    expect(quoteDraftSchema.parse(dane({ kind: 'offer', validUntil: '2026-12-11', bankAccount: 'zły numer', paymentDueDate: 'x' }))).toMatchObject({
      bankAccount: null,
      paymentDueDate: null,
      paymentMethod: null,
    });
    expect(quoteDraftSchema.parse(dane({ validUntil: 'zła data' }))).toMatchObject({ validUntil: null });
    expect(pierwszyBlad(dane({ bankAccount: 'PL00 1234' }))).toMatchObject({ path: 'bankAccount', message: expect.stringMatching(/niepoprawny/) });
  });

  it('inna waluta niż PLN: odmowa z komunikatem', () => {
    expect(pierwszyBlad(dane({ currency: 'EUR' }))?.message).toMatch(/PLN/);
  });

  it('stawka np. II: odmowa (kontrahent z bazy to firma z NIP, nie firma z UE)', () => {
    const r = pierwszyBlad(dane({ items: [{ name: 'Usługa', unit: 'szt', quantity: 1, unitPriceNet: 10, vatRate: 'np_ii' }] }));
    expect(r).toMatchObject({ path: 'items.0.vatRate', message: expect.stringMatching(/np\. II/) });
  });

  it('pozycje jak na fakturze: bez pozycji, ilość zero, cena ujemna, pięć miejsc po przecinku', () => {
    expect(pierwszyBlad(dane({ items: [] }))).toMatchObject({ path: 'items' });
    const pozycja = { name: 'X', unit: 'szt', quantity: 1, unitPriceNet: 1, vatRate: '23' as const };
    expect(pierwszyBlad(dane({ items: [{ ...pozycja, quantity: 0 }] }))).toMatchObject({ path: 'items.0.quantity' });
    expect(pierwszyBlad(dane({ items: [{ ...pozycja, unitPriceNet: -1 }] }))).toMatchObject({ path: 'items.0.unitPriceNet' });
    expect(pierwszyBlad(dane({ items: [{ ...pozycja, unitPriceNet: 1.00001 }] }))).toMatchObject({ path: 'items.0.unitPriceNet' });
    expect(pierwszyBlad(dane({ items: [{ ...pozycja, name: '' }] }))).toMatchObject({ path: 'items.0.name' });
  });

  it('najwyżej 200 pozycji', () => {
    const pozycja = { name: 'X', unit: 'szt', quantity: 1, unitPriceNet: 1, vatRate: '23' as const };
    expect(quoteDraftSchema.safeParse(dane({ items: Array.from({ length: 200 }, () => pozycja) })).success).toBe(true);
    expect(pierwszyBlad(dane({ items: Array.from({ length: 201 }, () => pozycja) }))).toMatchObject({ path: 'items' });
  });

  it('kwota ponad 10 mld zł: odmowa (granica kwot faktury)', () => {
    const r = pierwszyBlad(dane({ items: [{ name: 'X', unit: 'szt', quantity: 1, unitPriceNet: 9_000_000_000, vatRate: '23' }] }));
    expect(r?.message).toMatch(/10 mld/);
  });

  it('wynik schematu przechodzi schemat drugi raz bez zmian (formularz oddaje akcji wynik walidacji)', () => {
    for (const input of [dane(), dane({ kind: 'offer', validUntil: '2026-12-11' }), dane({ paymentMethod: 'cash', bankAccount: '' })]) {
      const raz = quoteDraftSchema.parse(input);
      expect(quoteDraftSchema.parse(raz)).toEqual(raz);
    }
  });

  it('data wystawienia z przyszłości: odmowa (ten sam warunek sprawdza RPC wystawienia)', () => {
    expect(quoteIssueDateError('2026-11-12', '2026-11-11')).toMatch(/przyszłości/);
    expect(quoteIssueDateError('2026-11-11', '2026-11-11')).toBeNull();
  });

  it('szkic z bazy wraca do formularza tymi samymi wartościami', () => {
    const items = quoteItems([{ name: 'Wdrożenie systemu', unit: 'szt', quantity: 1, unitPriceNet: 1000, vatRate: '23' }]);
    const quote: SalesQuote = {
      id: '5d0e8a8c-7a3b-4f61-9d2e-1c4b5a6f7e80',
      tenantId: 'ten-1',
      kind: 'proforma',
      status: 'draft',
      number: null,
      issueDate: '2026-11-11',
      validUntil: null,
      items,
      ...quoteTotals(items),
      currency: 'PLN',
      contractorId: KONTRAHENT,
      counterparty: { name: 'Kontrahent', nip: '1234567890', countryCode: 'PL', addressLine1: 'ul. A 1', addressLine2: '00-001 Warszawa' },
      issuer: null,
      paymentMethod: 'transfer',
      paymentDueDate: '2026-11-25',
      bankAccount: 'PL61109010140000071219812874',
      notes: 'Płatne z góry',
      issuedAt: null,
      createdAt: '2026-11-11T09:00:00.000Z',
    };
    expect(quoteDraftSchema.parse(quoteToDraftInput(quote))).toMatchObject({
      kind: 'proforma',
      contractorId: KONTRAHENT,
      paymentMethod: 'transfer',
      paymentDueDate: '2026-11-25',
      bankAccount: 'PL61109010140000071219812874',
      notes: 'Płatne z góry',
      items: [{ name: 'Wdrożenie systemu', unit: 'szt', quantity: 1, unitPriceNet: 1000, vatRate: '23' }],
    });
  });
});

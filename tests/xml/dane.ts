/**
 * Dane testowe C1 (granice tekstu FA(3)): fikcyjne firmy z poprawną sumą
 * kontrolną NIP (te same numery co w innych testach) i budowniczowie
 * faktur KOR, ZAL, ROZ i zwykłej. Wspólne dla `fa3-granice.test.ts`
 * i `fa3-limits.test.ts`.
 */
import type { AdvanceInvoiceSettlementRow } from '@/lib/ksef/fa3-advance-generator';
import { finalizeInvoice, type InvoiceInput } from '@/lib/xml/invoice-calculator';
import type {
  AdvanceInvoiceData,
  BuyerB2B,
  CorrectionInvoiceData,
  FinalInvoiceData,
  InvoiceLine,
  SellerData,
} from '@/types/invoice-types';

export const OPCJE = { generatedAt: new Date('2026-11-14T10:00:00Z'), prettyPrint: true };

/** Dokładnie `n` znaków: polskie litery i pojedyncze spacje, bez spacji na brzegach. */
export function tekst(n: number): string {
  const wzor = 'Zażółć gęślą jaźń ';
  const s = wzor.repeat(Math.ceil(n / wzor.length) + 1).slice(0, n);
  return s.endsWith(' ') ? `${s.slice(0, -1)}x` : s;
}

export const adres = (linia1 = 'ul. Przykładowa 1/2', linia2 = '00-001 Warszawa') => ({
  countryCode: 'PL',
  addressLine1: linia1,
  addressLine2: linia2,
});

const RACHUNEK = 'PL61109010140000071219812874';

export const SPRZEDAWCA: SellerData = { nip: '1234563218', name: 'ACME Software sp. z o.o.', address: adres() };

export const NABYWCA: BuyerB2B = {
  type: 'b2b',
  idType: 'nip',
  nip: '9876543210',
  name: 'Klient sp. z o.o.',
  address: adres('ul. Klienta 10', '02-001 Warszawa'),
};

export const POZYCJA: InvoiceLine = { name: 'Usługa wdrożeniowa', unit: 'szt.', quantity: 1, unitPriceNet: 100, vatRate: '23' };

export function korekta(o: Partial<CorrectionInvoiceData> = {}): CorrectionInvoiceData {
  return {
    invoiceType: 'correction',
    internalNumber: 'KOR/2026/11/1',
    issueDate: '2026-11-14',
    paymentMethod: 'transfer',
    paymentDueDate: '2026-11-28',
    parentInvoiceId: '00000000-0000-4000-8000-000000000001',
    parentInvoiceNumber: 'FV/2026/09/1',
    parentInvoiceIssueDate: '2026-09-30',
    parentKsefNumber: '1234567890-20260930-0100001AF629-AF',
    correctionType: 'before_after',
    correctionReason: 'Zmiana ilości po reklamacji',
    typKorekty: '2',
    seller: SPRZEDAWCA,
    buyer: NABYWCA,
    linesBefore: [POZYCJA],
    linesAfter: [{ ...POZYCJA, quantity: 2 }],
    ...o,
  };
}

export function zaliczka(o: Partial<AdvanceInvoiceData> = {}): AdvanceInvoiceData {
  return {
    invoiceType: 'advance',
    internalNumber: 'ZAL/2026/11/1',
    issueDate: '2026-11-14',
    paymentMethod: 'transfer',
    paymentDueDate: '2026-11-28',
    bankAccount: RACHUNEK,
    seller: SPRZEDAWCA,
    buyer: NABYWCA,
    taxAnnotations: { cashMethod: 2, splitPayment: 2 },
    advanceAmount: 1230,
    totalContractAmount: 12300,
    vatRate: '23',
    description: 'Projekt strony internetowej',
    ...o,
  };
}

export function zaliczkaDoRozliczenia(o: Partial<AdvanceInvoiceSettlementRow> = {}): AdvanceInvoiceSettlementRow {
  return {
    internal_number: 'ZAL/2026/08/1',
    ksef_number: '1234567890-20260801-0100001AF629-AF',
    advance_amount: 123,
    issue_date: '2026-08-01',
    vat_rate: '23',
    ...o,
  };
}

export function rozliczenie(o: Partial<FinalInvoiceData> = {}): FinalInvoiceData {
  return {
    invoiceType: 'final',
    internalNumber: 'FR/2026/11/1',
    issueDate: '2026-11-14',
    paymentMethod: 'transfer',
    paymentDueDate: '2026-11-28',
    bankAccount: RACHUNEK,
    seller: SPRZEDAWCA,
    buyer: NABYWCA,
    taxAnnotations: { cashMethod: 2, splitPayment: 2 },
    advanceInvoiceIds: ['00000000-0000-4000-8000-000000000002'],
    totalAdvances: 123,
    lines: [{ ...POZYCJA, unitPriceNet: 1000 }],
    ...o,
  };
}

/** Nabywca i płatność faktury zwykłej (typy z `types/invoice.ts`). */
export const KUPUJACY = { nip: NABYWCA.nip, name: NABYWCA.name, address: NABYWCA.address };
export const PLATNOSC: InvoiceInput['payment'] = {
  currency: 'PLN',
  dueDate: '2026-11-28',
  method: 'transfer',
  bankAccount: RACHUNEK,
};

export function zwykla(o: Partial<InvoiceInput> = {}, pozycja: Partial<InvoiceInput['lines'][number]> = {}) {
  return finalizeInvoice({
    internalNumber: 'FV/2026/11/1',
    type: 'VAT',
    issueDate: '2026-11-14',
    seller: { nip: SPRZEDAWCA.nip, name: SPRZEDAWCA.name, address: SPRZEDAWCA.address },
    buyer: KUPUJACY,
    lines: [{ ordinal: 1, name: POZYCJA.name, unit: POZYCJA.unit, quantity: 1, unitPriceNet: 100, vatRate: '23', ...pozycja }],
    payment: PLATNOSC,
    ...o,
  });
}

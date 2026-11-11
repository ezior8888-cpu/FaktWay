import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { KsefAuth } from '@/lib/ksef/auth';
import type { Invoice } from '@/types/invoice';
import type { AdvanceInvoiceData, CorrectionInvoiceData } from '@/types/invoice-types';

/**
 * Faktura do paragonu (krok 1.2) a dokumenty specjalne: generatory korekty,
 * zaliczki i rozliczenia nie piszą `FP`. Zdarzenie wysyłki z paragonem i danymi
 * specjalnymi (np. stare albo ręcznie zbudowane) nie może dać XML bez FP po
 * cichu. Prawdziwy `submitInvoiceFullFlow`; atrapy tylko dla zegara pliku,
 * archiwum i HTTP KSeF (żadna nie może zostać wywołana).
 */

const T = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID = '11111111-1111-4111-8111-111111111111';
const AUTH = { type: 'token', nip: '1234567890', token: 't' } as unknown as KsefAuth;

const mocks = vi.hoisted(() => ({ claim: vi.fn(), upload: vi.fn(), submit: vi.fn() }));

vi.mock('@/lib/auth/ksef-verification-guard', () => ({
  requireKsefVerificationForBackgroundJob: vi.fn(async () => undefined),
}));
vi.mock('@/lib/ksef/xml-generated-at', () => ({ claimXmlGeneratedAt: mocks.claim }));
vi.mock('@/lib/storage/r2', () => ({ uploadInvoiceXml: mocks.upload }));
vi.mock('@/lib/ksef/submit', () => ({ submitInvoice: mocks.submit }));

import { RECEIPT_ONLY_REGULAR_MESSAGE } from '@/lib/invoices/receipt-invoice';
import { submitInvoiceFullFlow } from '@/lib/ksef/submit-invoice-full';
import { InvoiceValidationError } from '@/lib/xml/fa3-generator';

const PARAGON = { receiptNumber: '000123', receiptDate: '2026-11-09', cashRegisterNumber: 'ABC1234567890' };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('KSEF_ENV', 'test');
});

describe('wysyłka: paragon tylko przy zwykłej fakturze', () => {
  it.each<[string, { correctionData?: CorrectionInvoiceData; advanceData?: AdvanceInvoiceData }]>([
    ['zaliczka', { advanceData: { invoiceType: 'advance' } as unknown as AdvanceInvoiceData }],
    ['korekta', { correctionData: { invoiceType: 'correction' } as unknown as CorrectionInvoiceData }],
  ])('%s z paragonem w zdarzeniu: odmowa przed plikiem i przed KSeF', async (_opis, special) => {
    const invoice = { type: 'VAT', internalNumber: 'FV/1', issueDate: '2026-11-09', receipt: PARAGON } as unknown as Invoice;
    const proba = submitInvoiceFullFlow(T, ID, invoice, AUTH, 'test', special.correctionData ?? null, special.advanceData ?? null);
    await expect(proba).rejects.toBeInstanceOf(InvoiceValidationError);
    await expect(proba).rejects.toThrow(RECEIPT_ONLY_REGULAR_MESSAGE);
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });
});

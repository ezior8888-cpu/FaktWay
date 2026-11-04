import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Invoice } from '@/types/invoice';
import type { AdvanceInvoiceData } from '@/types/invoice-types';
import type { KsefAuth } from '@/lib/ksef/auth';

/**
 * Decyzja Bartosza 06.10.2026 (00147), ustalenie z recenzji: bezpiecznik
 * w runnerze działa PRZED uwierzytelnieniem, archiwum i otwarciem sesji
 * KSeF — to kilkadziesiąt sekund (XAdES, `pollAuthStatus`, limity 30 s).
 * Zaliczka przepuszczona o 23:59:50 dochodziła do POST pliku po północy
 * z wczorajszą datą. Drugie sprawdzenie jest w haku otwarcia sesji, tuż
 * przed plikiem i przed zapisem zamiaru wysyłki (A2).
 *
 * Prawdziwy `submitInvoiceFullFlow`; atrapy: generator XML, walidator, R2,
 * dziennik wysyłek i HTTP KSeF (`submitInvoice` woła hak jak prawdziwy).
 */

const T = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID = '11111111-1111-4111-8111-111111111111';
const AUTH = { type: 'token', nip: '1234567890', token: 't' } as unknown as KsefAuth;

const mocks = vi.hoisted(() => ({
  intent: vi.fn(),
  posted: false,
  /** Chwila, w której KSeF otwiera sesję (po uwierzytelnieniu). */
  sessionOpenedAt: null as Date | null,
}));

vi.mock('@/lib/auth/ksef-verification-guard', () => ({
  requireKsefVerificationForBackgroundJob: vi.fn(async () => undefined),
}));
vi.mock('@/lib/ksef/xml-generated-at', () => ({ claimXmlGeneratedAt: vi.fn(async () => new Date()) }));
vi.mock('@/lib/ksef/fa3-advance-generator', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/ksef/fa3-advance-generator')>(),
  generateAdvanceInvoiceXml: vi.fn(() => '<Faktura/>'),
}));
vi.mock('@/lib/xml/fa3-generator', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/xml/fa3-generator')>(),
  generateFA3Xml: vi.fn(() => '<Faktura/>'),
}));
vi.mock('@/lib/xml/validator', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/xml/validator')>(),
  validateInvoiceXml: vi.fn(async () => ({ valid: true, errors: [] })),
}));
vi.mock('@/lib/storage/r2', () => ({
  invoiceXmlExistsForId: vi.fn(async () => false),
  uploadInvoiceXml: vi.fn(async () => ({ storagePath: 'x.xml', sha256Hash: 'h', sizeBytes: 1 })),
}));
vi.mock('@/lib/ksef/submission-log', () => ({
  recordKsefSubmissionIntent: mocks.intent,
  abandonKsefSubmissionIntent: vi.fn(),
  recordKsefSubmissionSent: vi.fn(),
}));
vi.mock('@/lib/ksef/submit', () => ({
  submitInvoice: vi.fn(async (_xml: string, _auth: unknown, _env: unknown, _audit: unknown, hooks?: {
    onSessionOpened?: (s: { sessionReferenceNumber: string }) => Promise<void>;
  }) => {
    if (mocks.sessionOpenedAt) vi.setSystemTime(mocks.sessionOpenedAt);
    await hooks?.onSessionOpened?.({ sessionReferenceNumber: 'S-1' });
    mocks.posted = true;
    return { ksefNumber: 'K', sessionReferenceNumber: 'S-1', invoiceReferenceNumber: 'R-1' };
  }),
}));

import { submitInvoiceFullFlow } from '@/lib/ksef/submit-invoice-full';

function zaliczka(issueDate: string) {
  return {
    invoice: { type: 'ZAL', internalNumber: 'ZAL/1', issueDate } as Invoice,
    advanceData: { invoiceType: 'advance', internalNumber: 'ZAL/1', issueDate } as unknown as AdvanceInvoiceData,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.posted = false;
  mocks.sessionOpenedAt = null;
  vi.stubEnv('KSEF_ENV', 'test');
  vi.useFakeTimers({ toFake: ['Date'] });
  // 23:59:50 w Polsce (CEST, UTC+2) — bezpiecznik runnera przepuszcza datę 06.10.
  vi.setSystemTime(new Date('2026-10-06T21:59:50Z'));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('ISSUE_DATE_PASSED: drugie sprawdzenie daty tuż przed plikiem (hak otwarcia sesji)', () => {
  it('zaliczka z 06.10, sesja KSeF otwarta po północy → bez POST pliku i bez zamiaru wysyłki', async () => {
    mocks.sessionOpenedAt = new Date('2026-10-06T22:00:10Z'); // 00:00:10, 07.10
    const { invoice, advanceData } = zaliczka('2026-10-06');
    const run = submitInvoiceFullFlow(T, ID, invoice, AUTH, 'test', null, advanceData, null, 'a-1');
    await expect(run).rejects.toThrow(/\[ISSUE_DATE_PASSED\].*2026-10-06.*2026-10-07/);
    expect(mocks.posted).toBe(false);
    expect(mocks.intent).not.toHaveBeenCalled();
  });

  it('zaliczka z 06.10, sesja otwarta przed północą → wysyłka jak dotąd (zamiar zapisany)', async () => {
    mocks.sessionOpenedAt = new Date('2026-10-06T21:59:58Z');
    const { invoice, advanceData } = zaliczka('2026-10-06');
    await expect(submitInvoiceFullFlow(T, ID, invoice, AUTH, 'test', null, advanceData, null, 'a-1'))
      .resolves.toMatchObject({ ksefNumber: 'K' });
    expect(mocks.posted).toBe(true);
    expect(mocks.intent).toHaveBeenCalledTimes(1);
  });

  it('zwykła faktura po północy → wysyłka jak dotąd (B1/B2 bez zmian)', async () => {
    mocks.sessionOpenedAt = new Date('2026-10-06T22:00:10Z');
    const invoice = { type: 'VAT', internalNumber: 'FV/1', issueDate: '2026-10-06' } as Invoice;
    await expect(submitInvoiceFullFlow(T, ID, invoice, AUTH, 'test', null, null, null, 'a-1'))
      .resolves.toMatchObject({ ksefNumber: 'K' });
    expect(mocks.posted).toBe(true);
  });
});

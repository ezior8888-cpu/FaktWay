import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { KsefAuth } from '@/lib/ksef/auth';
import type { Invoice } from '@/types/invoice';

/**
 * Żelazny filtr F13, część 4: strażnik FA(3) (`alarmujFa3`) w prawdziwym
 * `submitInvoiceFullFlow`, po kontroli XSD i przed archiwum i wysyłką.
 * D-F7: przez pierwsze dwa tygodnie tylko alarm, więc plik z błędem
 * generatora (zgodny z XSD) daje alarm `FILTR-RT-FA3-*` w Sentry, a faktura
 * idzie do KSeF jak dotąd.
 *
 * Atrapy: weryfikacja KSeF, data wytworzenia, walidator XSD (plik jest
 * zgodny), R2, dziennik wysyłek, HTTP KSeF i Sentry. Generator FA(3)
 * prawdziwy; atrapa tylko psuje P_15 w jego wyniku, jak zrobiłby to błąd sum.
 */

const T = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID = '11111111-1111-4111-8111-111111111111';
const AUTH = { type: 'token', nip: '1234567890', token: 't' } as unknown as KsefAuth;

const m = vi.hoisted(() => ({ psuj: false, posted: false, captureMessage: vi.fn() }));

vi.mock('@sentry/nextjs', () => ({ captureMessage: m.captureMessage, captureException: vi.fn() }));
vi.mock('@/lib/auth/ksef-verification-guard', () => ({
  requireKsefVerificationForBackgroundJob: vi.fn(async () => undefined),
}));
vi.mock('@/lib/ksef/xml-generated-at', () => ({ claimXmlGeneratedAt: vi.fn(async () => new Date('2026-11-09T10:00:00Z')) }));
vi.mock('@/lib/xml/fa3-generator', async (importOriginal) => {
  const prawdziwy = await importOriginal<typeof import('@/lib/xml/fa3-generator')>();
  return {
    ...prawdziwy,
    generateFA3Xml: vi.fn((...args: Parameters<typeof prawdziwy.generateFA3Xml>) => {
      const xml = prawdziwy.generateFA3Xml(...args);
      return m.psuj ? xml.replace(/<P_15>([^<]*)<\/P_15>/, (_c, s: string) => `<P_15>${(Math.round(Number(s) * 100) + 1) / 100}</P_15>`) : xml;
    }),
  };
});
vi.mock('@/lib/xml/validator', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/xml/validator')>(),
  validateInvoiceXml: vi.fn(async () => ({ valid: true, errors: [] })),
}));
vi.mock('@/lib/storage/r2', () => ({
  uploadInvoiceXml: vi.fn(async () => ({ storagePath: 'x.xml', sha256Hash: 'h', sizeBytes: 1 })),
}));
vi.mock('@/lib/ksef/submission-log', () => ({
  recordKsefSubmissionIntent: vi.fn(),
  abandonKsefSubmissionIntent: vi.fn(),
  recordKsefSubmissionSent: vi.fn(),
}));
vi.mock('@/lib/ksef/submit', () => ({
  submitInvoice: vi.fn(async (_xml: string, _auth: unknown, _env: unknown, _audit: unknown, hooks?: {
    onSessionOpened?: (s: { sessionReferenceNumber: string }) => Promise<void>;
  }) => {
    await hooks?.onSessionOpened?.({ sessionReferenceNumber: 'S-1' });
    m.posted = true;
    return { ksefNumber: 'K', sessionReferenceNumber: 'S-1', invoiceReferenceNumber: 'R-1' };
  }),
}));

import { KODY_FA3 } from '@/lib/bezpieczniki/fa3';
import { submitInvoiceFullFlow } from '@/lib/ksef/submit-invoice-full';
import { finalizeInvoice } from '@/lib/xml/invoice-calculator';

function faktura(): Invoice {
  return finalizeInvoice({
    internalNumber: 'FV 2026/11/001',
    type: 'VAT',
    issueDate: '2026-11-09',
    saleDate: '2026-11-09',
    seller: { nip: '1234563218', name: 'Firma', address: { countryCode: 'PL', addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa' } },
    buyer: { nip: '1111111111', name: 'Klient', address: { countryCode: 'PL', addressLine1: 'ul. Klienta 2', addressLine2: '02-001 Warszawa' } },
    lines: [
      { ordinal: 1, name: 'Usługa', unit: 'usł.', quantity: 1, unitPriceNet: 1000, vatRate: '23' },
      { ordinal: 2, name: 'Książka', unit: 'szt.', quantity: 3, unitPriceNet: 39.9, vatRate: '5' },
    ],
    payment: { currency: 'PLN', dueDate: '2026-11-23', method: 'transfer', bankAccount: 'PL61109010140000071219812874' },
  });
}

const alarmyFa3 = () => m.captureMessage.mock.calls.filter((c) => String(c[0]).startsWith('FILTR-RT-FA3'));

beforeEach(() => {
  vi.clearAllMocks();
  m.psuj = false;
  m.posted = false;
  vi.stubEnv('KSEF_ENV', 'test');
});

describe('strażnik FA(3) w wysyłce do KSeF: tylko alarm (D-F7)', () => {
  it('P_15 o grosz różne od sum: alarm FILTR-RT-FA3-01 z firmą, a faktura idzie do KSeF', async () => {
    m.psuj = true;
    await expect(submitInvoiceFullFlow(T, ID, faktura(), AUTH, 'test', null, null, null, 'a-1')).resolves.toMatchObject({ ksefNumber: 'K' });
    expect(m.posted).toBe(true);
    expect(alarmyFa3()).toHaveLength(1);
    expect(alarmyFa3()[0]![1]).toMatchObject({
      tags: { kod: KODY_FA3.suma, straznik: 'fa3', tenantId: T, rodzaj: 'vat', miesiac: '2026-11' },
      extra: { dokumentId: ID },
    });
  });

  it('plik z prawdziwego generatora: bez alarmu', async () => {
    await expect(submitInvoiceFullFlow(T, ID, faktura(), AUTH, 'test', null, null, null, 'a-1')).resolves.toMatchObject({ ksefNumber: 'K' });
    expect(m.posted).toBe(true);
    expect(alarmyFa3()).toEqual([]);
  });
});

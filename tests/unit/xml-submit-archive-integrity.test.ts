import { createHash } from 'node:crypto';

import { GetObjectCommand, PutObjectCommand, S3ServiceException } from '@aws-sdk/client-s3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * C-12 na pełnym przepływie wysyłki z prawdziwym `r2.ts`: atrapa tylko dla
 * klienta S3 i KSeF. Do tej naprawy ponowienie robiło HEAD, a gdy plik już
 * był, wyłączało `IfNoneMatch` i nadpisywało go kolejnym PUT.
 * Część testów ze szkicu #190.
 */

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  submit: vi.fn(),
  recordIntent: vi.fn(),
  recordSent: vi.fn(),
}));

vi.mock('@/lib/storage/r2-client', () => ({
  getR2Client: () => ({ send: mocks.send }),
  getR2Config: () => ({ bucketName: 'private-documents' }),
}));
vi.mock('@/lib/auth/ksef-verification-guard', () => ({
  requireKsefVerificationForBackgroundJob: vi.fn(async () => undefined),
}));
vi.mock('@/lib/ksef/xml-generated-at', () => ({
  claimXmlGeneratedAt: vi.fn(async () => new Date('2026-10-03T08:00:00Z')),
}));
vi.mock('@/lib/xml/fa3-generator', async (original) => ({
  ...(await original<typeof import('@/lib/xml/fa3-generator')>()),
  generateFA3Xml: () => '<Faktura>oryginał</Faktura>',
}));
vi.mock('@/lib/xml/validator', async (original) => ({
  ...(await original<typeof import('@/lib/xml/validator')>()),
  validateInvoiceXml: async () => ({ valid: true, errors: [] }),
}));
vi.mock('@/lib/ksef/submit', () => ({ submitInvoice: mocks.submit }));
vi.mock('@/lib/ksef/submission-log', () => ({
  recordKsefSubmissionIntent: mocks.recordIntent,
  recordKsefSubmissionSent: mocks.recordSent,
  abandonKsefSubmissionIntent: vi.fn(),
}));

import type { KsefAuth } from '@/lib/ksef/auth';
import { submitInvoiceFullFlow } from '@/lib/ksef/submit-invoice-full';
import { XmlArchiveConflictError } from '@/lib/storage/xml-archive-conflict';
import type { Invoice } from '@/types/invoice';

const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const invoiceId = '11111111-1111-4111-8111-111111111111';
const attemptId = '22222222-2222-4222-8222-222222222222';
const invoice = { type: 'VAT', issueDate: '2026-10-03' } as Invoice;
const xml = '<Faktura>oryginał</Faktura>';
const key = `${tenantId}/2026/10/${invoiceId}/${attemptId}.xml`;

function alreadyExists(): S3ServiceException {
  return new S3ServiceException({
    name: 'PreconditionFailed',
    $fault: 'client',
    $metadata: { httpStatusCode: 412 },
  });
}

function submit(): ReturnType<typeof submitInvoiceFullFlow> {
  return submitInvoiceFullFlow(tenantId, invoiceId, invoice, {} as KsefAuth, 'test', null, null, null, attemptId);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.send.mockReset();
  mocks.submit.mockResolvedValue({ ksefNumber: 'TEST-NUMBER' });
});

describe('archiwum XML przed wysyłką do KSeF', () => {
  it('pierwsza próba: jedno żądanie do magazynu, PUT z IfNoneMatch, bez HEAD, przed wysyłką', async () => {
    mocks.send.mockResolvedValueOnce({ ETag: 'etag' });

    const result = await submit();

    expect(mocks.send).toHaveBeenCalledTimes(1);
    const put = mocks.send.mock.calls[0]![0] as PutObjectCommand;
    expect(put).toBeInstanceOf(PutObjectCommand);
    expect(put.input).toMatchObject({ Key: key, IfNoneMatch: '*' });
    expect(mocks.send.mock.invocationCallOrder[0]).toBeLessThan(mocks.submit.mock.invocationCallOrder[0]!);
    expect(result).toMatchObject({
      ksefNumber: 'TEST-NUMBER',
      xmlStoragePath: key,
      xmlSha256Hash: createHash('sha256').update(xml).digest('hex'),
      xmlSizeBytes: Buffer.byteLength(xml),
    });
  });

  it('ponowienie tej samej próby: PUT nadal z IfNoneMatch, identyczne bajty odczytane przed wysyłką', async () => {
    mocks.send.mockRejectedValueOnce(alreadyExists()).mockResolvedValueOnce({
      Body: { transformToByteArray: async () => Buffer.from(xml) },
    });

    await submit();

    expect(mocks.send).toHaveBeenCalledTimes(2);
    expect((mocks.send.mock.calls[0]![0] as PutObjectCommand).input.IfNoneMatch).toBe('*');
    expect(mocks.send.mock.calls[1]![0]).toBeInstanceOf(GetObjectCommand);
    expect(mocks.send.mock.invocationCallOrder[1]).toBeLessThan(mocks.submit.mock.invocationCallOrder[0]!);
    expect(mocks.submit).toHaveBeenCalledWith(xml, expect.anything(), 'test', { tenantId, invoiceId }, expect.anything());
  });

  it('inny plik pod tym kluczem: zero kontaktu z KSeF i zero wpisów historii', async () => {
    mocks.send.mockRejectedValueOnce(alreadyExists()).mockResolvedValueOnce({
      Body: { transformToByteArray: async () => Buffer.from('<Faktura>inna treść</Faktura>') },
    });

    await expect(submit()).rejects.toBeInstanceOf(XmlArchiveConflictError);

    expect(mocks.submit).not.toHaveBeenCalled();
    expect(mocks.recordIntent).not.toHaveBeenCalled();
    expect(mocks.recordSent).not.toHaveBeenCalled();
    expect(mocks.send).toHaveBeenCalledTimes(2);
  });

  it('nie da się odczytać istniejącego pliku: bez wysyłki, błąd zwykły (ponawialny)', async () => {
    mocks.send.mockRejectedValueOnce(alreadyExists()).mockRejectedValueOnce(new Error('storage unavailable'));

    await expect(submit()).rejects.toThrow('storage unavailable');

    expect(mocks.submit).not.toHaveBeenCalled();
    expect(mocks.recordIntent).not.toHaveBeenCalled();
    expect(mocks.recordSent).not.toHaveBeenCalled();
  });
});

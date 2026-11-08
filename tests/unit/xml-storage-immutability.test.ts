import { createHash } from 'node:crypto';

import { GetObjectCommand, PutObjectCommand, S3ServiceException } from '@aws-sdk/client-s3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * C-12: odpowiedź 412 z magazynu mówi tylko, że klucz jest zajęty, a nie, że leży
 * pod nim ten sam plik. Do tej naprawy gałąź 412 zwracała sukces ze skrótem
 * NOWEGO pliku, bez odczytu istniejącego. Część testów ze szkicu #190.
 */

const mocks = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock('@/lib/storage/r2-client', () => ({
  getR2Client: () => ({ send: mocks.send }),
  getR2Config: () => ({ bucketName: 'private-documents' }),
}));

import { uploadInvoiceXml } from '@/lib/storage/r2';
import { XmlArchiveConflictError } from '@/lib/storage/xml-archive-conflict';

const tenantId = 'tenant-test';
const invoiceId = 'invoice-test';
const xml = '<Faktura>oryginał</Faktura>';
const key = `${tenantId}/2026/10/${invoiceId}.xml`;

function preconditionFailed(): S3ServiceException {
  return new S3ServiceException({
    name: 'PreconditionFailed',
    $fault: 'client',
    $metadata: { httpStatusCode: 412 },
  });
}

const stored = (content: string) => ({
  Body: { transformToByteArray: async () => new TextEncoder().encode(content) },
});

beforeEach(() => mocks.send.mockReset());

describe('niezmienne archiwum XML faktury', () => {
  it('plik powstaje tylko wtedy, gdy klucz jest wolny', async () => {
    mocks.send.mockResolvedValueOnce({ ETag: 'etag' });

    const result = await uploadInvoiceXml(tenantId, invoiceId, '2026-10-01', xml);

    expect(result).toEqual({
      storagePath: key,
      sha256Hash: createHash('sha256').update(xml).digest('hex'),
      sizeBytes: Buffer.byteLength(xml),
      etag: 'etag',
    });
    expect(mocks.send).toHaveBeenCalledTimes(1);
    const put = mocks.send.mock.calls[0]?.[0] as PutObjectCommand;
    expect(put).toBeInstanceOf(PutObjectCommand);
    expect(put.input.IfNoneMatch).toBe('*');
  });

  it('412 z tymi samymi bajtami to udane ponowienie, ale dopiero po odczycie pliku', async () => {
    mocks.send.mockRejectedValueOnce(preconditionFailed()).mockResolvedValueOnce(stored(xml));

    const result = await uploadInvoiceXml(tenantId, invoiceId, '2026-10-01', xml);

    expect(result.sha256Hash).toBe(createHash('sha256').update(xml).digest('hex'));
    expect(result.sizeBytes).toBe(Buffer.byteLength(xml));
    const get = mocks.send.mock.calls[1]?.[0] as GetObjectCommand;
    expect(get).toBeInstanceOf(GetObjectCommand);
    expect(get.input.Key).toBe(key);
  });

  it('412 z innymi bajtami to konflikt z kluczem pliku, bez nadpisania i bez treści w komunikacie', async () => {
    mocks.send.mockRejectedValueOnce(preconditionFailed()).mockResolvedValueOnce(stored('<Faktura>inna</Faktura>'));

    const error = await uploadInvoiceXml(tenantId, invoiceId, '2026-10-01', xml).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(XmlArchiveConflictError);
    expect((error as XmlArchiveConflictError).storagePath).toBe(key);
    expect((error as Error).message).not.toContain('Faktura');
    expect(mocks.send).toHaveBeenCalledTimes(2);
    expect((mocks.send.mock.calls[0]?.[0] as PutObjectCommand).input.IfNoneMatch).toBe('*');
  });

  it('błąd odczytu po 412 nie jest konfliktem: zostaje zwykłym, ponawialnym błędem', async () => {
    mocks.send.mockRejectedValueOnce(preconditionFailed()).mockRejectedValueOnce(new Error('storage unavailable'));

    const error = await uploadInvoiceXml(tenantId, invoiceId, '2026-10-01', xml).catch((e: unknown) => e);

    expect(error).not.toBeInstanceOf(XmlArchiveConflictError);
    expect((error as Error).message).toBe('storage unavailable');
  });

  it('inny błąd zapisu nie uruchamia odczytu', async () => {
    mocks.send.mockRejectedValueOnce(new Error('network down'));

    await expect(uploadInvoiceXml(tenantId, invoiceId, '2026-10-01', xml)).rejects.toThrow('network down');
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });
});

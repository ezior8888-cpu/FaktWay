import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * C-12: wiersz `xml_documents` to dowód pliku faktury (KOD I na PDF, „Pobierz
 * XML”, portal księgowej) z 10-letnią retencją. Do tej naprawy ponowienie
 * nadpisywało wiersz danymi kolejnej próby, a równoległe joby mogły zapisać
 * dwa. UNIQUE z 00164 sprawdza `tests/rls-xml-dowod-jeden-wiersz.test.ts`
 * na prawdziwej bazie — tu tylko decyzje kodu.
 */

const mocks = vi.hoisted(() => ({
  admin: vi.fn(),
  download: vi.fn(),
  tables: [] as string[],
  metadataRead: vi.fn(),
  metadataInsert: vi.fn(),
  metadataUpdate: vi.fn(),
}));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: mocks.admin }));
vi.mock('@/lib/storage/r2', () => ({
  downloadFromR2: mocks.download,
  downloadInvoiceXmlUnchecked: mocks.download,
}));

import { recordXmlDocument, XmlDocumentConflictError } from '@/lib/storage/xml-documents';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_TENANT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const INVOICE = '11111111-1111-4111-8111-111111111111';
const PATH = `${TENANT}/2026/10/${INVOICE}/22222222-2222-4222-8222-222222222222.xml`;
// UTF-16 z BOM: bajty, które po dekodowaniu do tekstu i z powrotem dają inny skrót.
const XML = Buffer.from([0xff, 0xfe, 0x3c, 0x00, 0x46, 0x00, 0x2f, 0x00, 0x3e, 0x00]);
const HASH = createHash('sha256').update(XML).digest('hex');
const RECORD = { tenantId: TENANT, invoiceId: INVOICE, storagePath: PATH, sha256Hash: HASH };
const ROW = { id: 'row-1', storage_path: PATH, sha256_hash: HASH, file_size_bytes: XML.length };

function database() {
  return {
    from(table: string) {
      mocks.tables.push(table);
      const q = {
        select: () => q,
        eq: () => q,
        limit: () => q,
        maybeSingle: async () => mocks.metadataRead(),
        insert: async (row: Record<string, unknown>) => mocks.metadataInsert(row),
        update: (row: Record<string, unknown>) => {
          mocks.metadataUpdate(row);
          return { eq: async () => ({ error: null }) };
        },
      };
      return q;
    },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.tables.length = 0;
  mocks.admin.mockReturnValue(database());
  mocks.download.mockResolvedValue(XML);
  mocks.metadataRead.mockResolvedValue({ data: null, error: null });
  mocks.metadataInsert.mockResolvedValue({ error: null });
});

describe('nowy wiersz: import i skrzynka (archiwum porównało już bajty)', () => {
  it('zapisuje skrót i rozmiar z archiwum bez GET z magazynu i bez odczytu faktury', async () => {
    await recordXmlDocument({ ...RECORD, sizeBytes: XML.length });

    expect(mocks.download).not.toHaveBeenCalled();
    expect(new Set(mocks.tables)).toEqual(new Set(['xml_documents']));
    expect(mocks.metadataInsert).toHaveBeenCalledWith({
      invoice_id: INVOICE,
      tenant_id: TENANT,
      storage_provider: 'r2',
      storage_path: PATH,
      sha256_hash: HASH,
      file_size_bytes: XML.length,
    });
  });
});

describe('nowy wiersz: wysyłka bez świeżego zapisu pliku (verifyStoredBytes)', () => {
  const verified = { ...RECORD, verifyStoredBytes: true };

  it('skrót porównuje z dokładnymi bajtami magazynu, a rozmiar bierze z nich, gdy wołający go nie zna', async () => {
    await recordXmlDocument(verified);

    expect(mocks.download).toHaveBeenCalledWith(PATH, TENANT);
    expect(mocks.metadataInsert).toHaveBeenCalledWith(expect.objectContaining({
      sha256_hash: HASH,
      file_size_bytes: XML.length,
    }));
  });

  it('skrót wielkimi literami z historii to ten sam skrót', async () => {
    await recordXmlDocument({ ...verified, sha256Hash: HASH.toUpperCase() });
    expect(mocks.metadataInsert).toHaveBeenCalledWith(expect.objectContaining({ sha256_hash: HASH }));
  });

  it.each([
    ['inny skrót', { sha256Hash: 'a'.repeat(64) }],
    ['pusty skrót', { sha256Hash: '' }],
    ['inny rozmiar', { sizeBytes: XML.length + 1 }],
  ])('%s: plik w magazynie nie jest dowodem tej próby — bez zapisu', async (_label, patch) => {
    await expect(recordXmlDocument({ ...verified, ...patch })).rejects.toBeInstanceOf(XmlDocumentConflictError);
    expect(mocks.metadataInsert).not.toHaveBeenCalled();
  });

  it('błąd magazynu zatrzymuje zapis wiersza', async () => {
    mocks.download.mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(recordXmlDocument(verified)).rejects.toThrow('storage unavailable');
    expect(mocks.metadataInsert).not.toHaveBeenCalled();
  });
});

describe('wiersz raz zapisany się nie zmienia', () => {
  it('ponowienie tego samego pliku jest no-op: bez UPDATE, INSERT i GET', async () => {
    mocks.metadataRead.mockResolvedValue({ data: ROW, error: null });

    await recordXmlDocument({ ...RECORD, sizeBytes: XML.length, verifyStoredBytes: true });

    expect(mocks.metadataUpdate).not.toHaveBeenCalled();
    expect(mocks.metadataInsert).not.toHaveBeenCalled();
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it('NULL w `file_size_bytes` nie jest konfliktem i nie jest uzupełniany', async () => {
    mocks.metadataRead.mockResolvedValue({ data: { ...ROW, file_size_bytes: null }, error: null });

    await recordXmlDocument({ ...RECORD, sizeBytes: XML.length });

    expect(mocks.metadataUpdate).not.toHaveBeenCalled();
    expect(mocks.metadataInsert).not.toHaveBeenCalled();
  });

  it('ścieżka przyjęcia z duplikatu nie zna rozmiaru — to też nie konflikt', async () => {
    mocks.metadataRead.mockResolvedValue({ data: ROW, error: null });
    await expect(recordXmlDocument(RECORD)).resolves.toBeUndefined();
    expect(mocks.metadataUpdate).not.toHaveBeenCalled();
  });

  it.each([
    ['inna ścieżka', { storage_path: `${TENANT}/2026/09/${INVOICE}.xml` }],
    ['inny skrót', { sha256_hash: 'a'.repeat(64) }],
    ['inny rozmiar', { file_size_bytes: XML.length + 1 }],
  ])('%s w istniejącym wierszu: błąd bez zastąpienia dowodu', async (_label, patch) => {
    mocks.metadataRead.mockResolvedValue({ data: { ...ROW, ...patch }, error: null });

    await expect(recordXmlDocument({ ...RECORD, sizeBytes: XML.length })).rejects.toBeInstanceOf(XmlDocumentConflictError);

    expect(mocks.metadataUpdate).not.toHaveBeenCalled();
    expect(mocks.metadataInsert).not.toHaveBeenCalled();
  });

  it('komunikat konfliktu mówi klientowi, co zrobić, i nie ujawnia ścieżki pliku', async () => {
    mocks.metadataRead.mockResolvedValue({ data: { ...ROW, sha256_hash: 'a'.repeat(64) }, error: null });

    const error = await recordXmlDocument(RECORD).catch((e: unknown) => e as Error);

    expect((error as Error).message).toContain('napisz do pomocy FaktWay');
    expect((error as Error).message).not.toContain(PATH);
    expect((error as Error).message).not.toContain(TENANT);
  });
});

describe('wyścig dwóch zapisów: rozstrzyga UNIQUE z 00164', () => {
  const duplicate = { error: { code: '23505', message: 'duplicate key' } };

  it('przegrany z tym samym plikiem kończy się sukcesem po sprawdzeniu wiersza zwycięzcy', async () => {
    mocks.metadataRead
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: ROW, error: null });
    mocks.metadataInsert.mockResolvedValueOnce(duplicate);

    await expect(recordXmlDocument({ ...RECORD, sizeBytes: XML.length })).resolves.toBeUndefined();
    expect(mocks.metadataUpdate).not.toHaveBeenCalled();
  });

  it('wiersz zwycięzcy bez rozmiaru nie jest konfliktem', async () => {
    mocks.metadataRead
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: { ...ROW, file_size_bytes: null }, error: null });
    mocks.metadataInsert.mockResolvedValueOnce(duplicate);

    await expect(recordXmlDocument({ ...RECORD, verifyStoredBytes: true })).resolves.toBeUndefined();
  });

  it('sam 23505 nie jest sukcesem: inny plik zwycięzcy to konflikt', async () => {
    mocks.metadataRead
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: { ...ROW, sha256_hash: 'a'.repeat(64) }, error: null });
    mocks.metadataInsert.mockResolvedValueOnce(duplicate);

    await expect(recordXmlDocument(RECORD)).rejects.toBeInstanceOf(XmlDocumentConflictError);
  });

  it('23505 bez wiersza zwycięzcy nie udaje sukcesu', async () => {
    mocks.metadataInsert.mockResolvedValueOnce(duplicate);
    await expect(recordXmlDocument(RECORD)).rejects.toThrow('xml_documents');
  });

  it('błąd ponownego odczytu po 23505 jest błędem zapisu dowodu', async () => {
    mocks.metadataRead
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: null, error: { message: 'read unavailable' } });
    mocks.metadataInsert.mockResolvedValueOnce(duplicate);

    await expect(recordXmlDocument(RECORD)).rejects.toThrow('read unavailable');
  });
});

describe('błędy i granica firmy', () => {
  it('błąd odczytu wiersza: bez GET i bez INSERT', async () => {
    mocks.metadataRead.mockResolvedValueOnce({ data: null, error: { message: 'read unavailable' } });

    await expect(recordXmlDocument({ ...RECORD, verifyStoredBytes: true })).rejects.toThrow('read unavailable');

    expect(mocks.download).not.toHaveBeenCalled();
    expect(mocks.metadataInsert).not.toHaveBeenCalled();
  });

  it('inny błąd INSERT nie jest traktowany jak ponowienie', async () => {
    mocks.metadataInsert.mockResolvedValueOnce({ error: { code: '42501', message: 'permission denied' } });

    await expect(recordXmlDocument(RECORD)).rejects.toThrow('permission denied');
    expect(mocks.metadataRead).toHaveBeenCalledOnce();
  });

  it.each([
    `${OTHER_TENANT}/2026/10/${INVOICE}.xml`,
    `${TENANT}/../${OTHER_TENANT}/x.xml`,
  ])('ścieżka spoza folderu firmy (%s): bez admina i bez magazynu', async (storagePath) => {
    await expect(recordXmlDocument({ ...RECORD, storagePath, verifyStoredBytes: true })).rejects.toThrow('organization');
    expect(mocks.admin).not.toHaveBeenCalled();
    expect(mocks.download).not.toHaveBeenCalled();
  });
});

describe('migracja 00164', () => {
  const dir = join(process.cwd(), 'supabase/migrations');
  const file = readdirSync(dir).find((name) => name.startsWith('00164_'));
  const source = file ? readFileSync(join(dir, file), 'utf8').replace(/\r\n/g, '\n') : '';
  const sql = source.split('\n').filter((line) => !line.startsWith('--')).join('\n');

  it('nagłówek: przed wdrożeniem, a duble rozstrzyga człowiek', () => {
    expect(file).toBe('00164_xml_documents_one_per_invoice.sql');
    expect(source).toMatch(/^-- WGRANIE: PRZED wdrożeniem/m);
    expect(source).toContain('GROUP BY tenant_id, invoice_id');
  });

  it('kontrola dubli pod blokadą zapisów, potem unikalny indeks; żadnych zmian danych', () => {
    const lock = sql.indexOf('LOCK TABLE public.xml_documents IN SHARE MODE');
    const preflight = sql.indexOf('RAISE EXCEPTION');
    const index = sql.indexOf('CREATE UNIQUE INDEX uq_xml_documents_tenant_invoice');
    expect(lock).toBeGreaterThan(-1);
    expect(preflight).toBeGreaterThan(lock);
    expect(index).toBeGreaterThan(preflight);
    expect(sql).toContain('ON public.xml_documents (tenant_id, invoice_id)');
    expect(sql).not.toMatch(/\b(DROP|TRUNCATE|DELETE|UPDATE|INSERT)\b/i);
  });

  it('rejestr numerów: wiersz 00164, a następny wolny nie wskazuje już tego numeru', () => {
    const registry = readFileSync(join(process.cwd(), 'docs/koordynacja/CLAUDE-DO-CODEXA.md'), 'utf8');
    expect(registry).toMatch(/^\| 00164 \|.*xml_documents_one_per_invoice/m);
    expect(registry).not.toMatch(/^\| \*\*00164\*\* \| — \| następny wolny/m);
  });
});

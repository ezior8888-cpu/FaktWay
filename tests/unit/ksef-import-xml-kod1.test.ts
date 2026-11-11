import { createHash } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ParsedInvoice } from '@/lib/import/fa3-parser';

/**
 * #122 część B (R6, C-12): faktura z importu historii KSeF musi mieć trwały
 * oryginał XML i jego SHA-256 — z dokładnych bajtów z KSeF, nie z tekstu
 * po dekodowaniu — inaczej PDF nie dostanie KODU I.
 */

const mocks = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
  uploadIfAbsent: vi.fn(),
  download: vi.fn(),
  recordXml: vi.fn(),
}));
vi.mock('@/lib/supabase/server', () => ({ createAdminClient: mocks.createAdminClient }));
vi.mock('@/lib/storage/r2', () => ({
  uploadToR2IfAbsent: mocks.uploadIfAbsent,
  downloadFromR2: mocks.download,
}));
vi.mock('@/lib/storage/xml-documents', () => ({ recordXmlDocument: mocks.recordXml }));

import { ksefFetch } from '@/lib/ksef/client';
import {
  archiveImportedKsefXml,
  decodeKsefXml,
  importedKsefXmlKey,
} from '@/lib/import/ksef-xml-archive';
import { processImportedInvoices } from '@/lib/import/import-engine';

const TENANT = '11111111-1111-4111-8111-111111111111';
const KSEF = '1234567890-20260925-ABCDEF123456-01';
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const XML = Buffer.concat([BOM, Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Faktura>ż</Faktura>', 'utf8')]);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

afterEach(() => vi.unstubAllGlobals());
beforeEach(() => {
  vi.clearAllMocks();
  mocks.uploadIfAbsent.mockResolvedValue(true);
  mocks.recordXml.mockResolvedValue(undefined);
});

describe('klient KSeF: XML jako dokładne bajty', () => {
  it('responseType bytes zwraca bufor z BOM bez dekodowania', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(XML, {
      status: 200, headers: { 'content-type': 'application/xml' },
    })));
    const body = await ksefFetch<Buffer>('/invoices/ksef/x', { responseType: 'bytes', env: 'test' });
    expect(Buffer.isBuffer(body)).toBe(true);
    expect(sha(body)).toBe(sha(XML));
  });
});

describe('archiwum XML z importu historii', () => {
  it('klucz w folderze firmy, bezpieczny znakowo', () => {
    expect(importedKsefXmlKey(TENANT, KSEF)).toBe(`${TENANT}/ksef-import/${KSEF}.xml`);
    expect(() => importedKsefXmlKey(TENANT, '../x')).toThrow();
  });

  it('skrót z bajtów KSeF (z BOM), zapis tylko gdy brak obiektu', async () => {
    const archive = await archiveImportedKsefXml(TENANT, KSEF, XML);
    expect(archive).toEqual({
      storagePath: `${TENANT}/ksef-import/${KSEF}.xml`, sha256Hash: sha(XML), sizeBytes: XML.length,
    });
    expect(mocks.uploadIfAbsent).toHaveBeenCalledWith(archive.storagePath, XML, 'application/xml');
  });

  it('istniejący obiekt: ten sam plik przechodzi, inny przerywa', async () => {
    mocks.uploadIfAbsent.mockResolvedValue(false);
    mocks.download.mockResolvedValueOnce(XML);
    await expect(archiveImportedKsefXml(TENANT, KSEF, XML)).resolves.toMatchObject({ sha256Hash: sha(XML) });
    mocks.download.mockResolvedValueOnce(Buffer.from('<Faktura>inna</Faktura>'));
    await expect(archiveImportedKsefXml(TENANT, KSEF, XML)).rejects.toThrow('inny plik');
  });

  it('dekodowanie do parsera zdejmuje BOM', () => {
    expect(decodeKsefXml(XML).startsWith('<?xml')).toBe(true);
  });
});

const archive = { storagePath: `${TENANT}/ksef-import/${KSEF}.xml`, sha256Hash: sha(XML), sizeBytes: XML.length };
const invoice: ParsedInvoice = {
  ksefNumber: KSEF,
  invoiceNumber: 'FV/1/2026',
  issueDate: '2026-09-25',
  invoiceType: 'regular',
  seller: { name: 'Sprzedawca', nip: '1234567890' },
  buyer: { name: 'Nabywca', nip: '1234567890' },
  lines: [],
  totals: { netTotal: 100, vatTotal: 23, grossTotal: 123 },
  warnings: [],
  xmlArchive: archive,
};

type Row = Record<string, unknown>;
function database(stored: Row | null = null) {
  const inserts: Row[] = [];
  const updates: Array<{ patch: Row; filters: Array<[string, unknown]> }> = [];
  const client = {
    from(table: string) {
      let op: 'select' | 'insert' | 'update' = 'select';
      let columns = '';
      const filters: Array<[string, unknown]> = [];
      let patch: Row = {};
      // Odczyty duplikatów idą stronami po `id` (sesja 32 planu skalowania): strona po `gt('id')` jest pusta.
      let afterId: unknown = null;
      const result = () => {
        if (table === 'invoices' && op === 'insert') return { data: { id: 'new-invoice' }, error: null };
        if (table === 'invoices' && op === 'update') return { data: { id: stored?.id }, error: null };
        if (table === 'invoices' && columns.includes('ksef_number') && stored) {
          return { data: afterId !== null && String(stored.id) <= String(afterId) ? [] : [stored], error: null };
        }
        if (table === 'invoice_line_items' && op === 'select') return { data: null, count: 0, error: null };
        return { data: [], error: null };
      };
      const query = {
        select: (c = '') => { columns = c; return query; },
        eq: (k: string, v: unknown) => { filters.push([k, v]); return query; },
        is: (k: string, v: unknown) => { filters.push([`${k} IS`, v]); return query; },
        in: () => query,
        gt: (_k: string, v: unknown) => { afterId = v; return query; },
        order: () => query,
        limit: () => query,
        insert: (row: Row) => { op = 'insert'; if (table === 'invoices') inserts.push(row); return query; },
        update: (row: Row) => { op = 'update'; patch = row; updates.push({ patch, filters }); return query; },
        single: async () => result(),
        maybeSingle: async () => result(),
        then: <T>(resolve: (v: ReturnType<typeof result>) => T) => Promise.resolve(result()).then(resolve),
      };
      return query;
    },
  };
  return { client, inserts, updates };
}

const run = () => processImportedInvoices({
  tenantId: TENANT, importJobId: 'job', invoices: [invoice],
  source: 'ksef_history', invoiceDirection: 'outgoing', invoiceKsefStatus: 'accepted', ksefEnvironment: 'test',
});

describe('import historii: oryginał XML przy fakturze (KOD I)', () => {
  it('nowa faktura dostaje ścieżkę XML i wiersz xml_documents ze skrótem', async () => {
    const db = database();
    mocks.createAdminClient.mockReturnValue(db.client);
    const result = await run();
    expect(result).toMatchObject({ invoicesImported: 1, invoicesFailed: 0 });
    expect(db.inserts[0]).toMatchObject({ xml_storage_path: archive.storagePath });
    expect(mocks.recordXml).toHaveBeenCalledWith({ tenantId: TENANT, invoiceId: 'new-invoice', ...archive });
  });

  it('błąd zapisu xml_documents: import niekompletny, nie cichy sukces', async () => {
    const db = database();
    mocks.createAdminClient.mockReturnValue(db.client);
    mocks.recordXml.mockRejectedValueOnce(new Error('db down'));
    const result = await run();
    expect(result.invoicesFailed).toBe(1);
    expect(result.warnings.join(' ')).toContain('XML');
  });

  it('archiwum spoza folderu firmy jest odrzucone przed zapisem faktury', async () => {
    const db = database();
    mocks.createAdminClient.mockReturnValue(db.client);
    const result = await processImportedInvoices({
      tenantId: TENANT, importJobId: 'job',
      invoices: [{ ...invoice, xmlArchive: { ...archive, storagePath: 'inna-firma/ksef-import/x.xml' } }],
      source: 'ksef_history', invoiceDirection: 'outgoing', invoiceKsefStatus: 'accepted', ksefEnvironment: 'test',
    });
    expect(result.invoicesFailed).toBe(1);
    expect(db.inserts).toHaveLength(0);
  });

  it('ponowienie: duplikat bez ścieżki XML zostaje uzupełniony', async () => {
    const db = database({
      id: 'stored', ksef_number: KSEF, internal_number: 'FV/1/2026', ksef_status: 'accepted',
      ksef_environment: 'test', xml_storage_path: null,
    });
    mocks.createAdminClient.mockReturnValue(db.client);
    const result = await run();
    expect(result.invoicesFailed).toBe(0);
    expect(db.updates[0]?.patch).toEqual({ xml_storage_path: archive.storagePath });
    expect(db.updates[0]?.filters).toContainEqual(['xml_storage_path IS', null]);
    expect(mocks.recordXml).toHaveBeenCalledWith({ tenantId: TENANT, invoiceId: 'stored', ...archive });
  });

  it('duplikat wysłany z aplikacji (własny XML) zostaje bez zmian', async () => {
    const db = database({
      id: 'stored', ksef_number: KSEF, internal_number: 'FV/1/2026', ksef_status: 'accepted',
      ksef_environment: 'test', xml_storage_path: `${TENANT}/2026/09/stored.xml`,
    });
    mocks.createAdminClient.mockReturnValue(db.client);
    const result = await run();
    expect(result.invoicesFailed).toBe(0);
    expect(db.updates).toHaveLength(0);
    expect(mocks.recordXml).not.toHaveBeenCalled();
  });
});

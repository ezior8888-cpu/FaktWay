import { inflateRawSync } from 'node:zlib';

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Krok 6.4 planu kompletnej aplikacji, część 1: składanie paczki ZIP
 * (archiwum dokumentów i paczka na kontrolę) na prawdziwej ścieżce
 * `buildArchivePackage`, z atrapą bazy i magazynu. Brak pliku nie przerywa
 * paczki, tylko trafia do spisu z powodem; JPK_FA, którego generator nie
 * obsłuży, też trafia do spisu jako brak, a nie do paczki.
 */

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  xml: vi.fn(),
  r2: vi.fn(),
  photo: vi.fn(),
  pdf: vi.fn(),
  fetchJpk: vi.fn(),
  office: vi.fn(),
  address: vi.fn(),
  jpk: vi.fn(),
  xsd: vi.fn(),
}));

/** Atrapa klienta PostgREST: filtry eq/in/gte/lte na wierszach tabeli, `range` tnie stronę. */
class Query implements PromiseLike<{ data: Row[]; error: null }> {
  private rows: Row[];
  constructor(rows: Row[]) {
    this.rows = [...rows];
  }
  select() {
    return this;
  }
  order() {
    return this;
  }
  eq(column: string, value: unknown) {
    this.rows = this.rows.filter((r) => r[column] === value);
    return this;
  }
  in(column: string, values: readonly unknown[]) {
    this.rows = this.rows.filter((r) => values.includes(r[column]));
    return this;
  }
  gte(column: string, value: string) {
    this.rows = this.rows.filter((r) => String(r[column]) >= value);
    return this;
  }
  lte(column: string, value: string) {
    this.rows = this.rows.filter((r) => String(r[column]) <= value);
    return this;
  }
  range(from: number, to: number) {
    this.rows = this.rows.slice(from, to + 1);
    return this;
  }
  maybeSingle() {
    return Promise.resolve({ data: this.rows[0] ?? null, error: null });
  }
  then<A, B>(ok?: ((v: { data: Row[]; error: null }) => A | PromiseLike<A>) | null, bad?: ((e: unknown) => B | PromiseLike<B>) | null) {
    return Promise.resolve({ data: this.rows, error: null as null }).then(ok, bad);
  }
}

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({ from: (table: string) => new Query(h.tables[table] ?? []) }),
}));
vi.mock('@/lib/storage/r2', () => ({ downloadInvoiceXml: h.xml, downloadFromR2: h.r2 }));
vi.mock('@/lib/storage/expenses', () => ({ downloadExpensePhoto: h.photo }));
vi.mock('@/lib/pdf/invoice-pdf', () => ({ generateInvoicePdf: h.pdf }));
vi.mock('@/lib/exports/data-fetcher', () => ({ fetchInvoicesForExport: h.fetchJpk }));
vi.mock('@/lib/exports/tax-office', async (orig) => ({ ...(await orig<object>()), readTenantTaxOffice: h.office }));
vi.mock('@/lib/exports/issuer-address', async (orig) => ({ ...(await orig<object>()), readIssuerRegisteredAddress: h.address }));
vi.mock('@/lib/exports/jpk-fa-generator', async (orig) => ({ ...(await orig<object>()), generateJpkFa: h.jpk }));
vi.mock('@/lib/exports/jpk-schema-check', async (orig) => ({ ...(await orig<object>()), assertJpkMatchesSchema: h.xsd }));

import { JpkDocumentNotSupportedError } from '@/lib/exports/jpk-fa-generator';
import { ArchiveTooLargeError, buildArchivePackage } from '@/lib/archiwum/paczka';

const T = '0178aaaa-0000-4000-8000-000000000001';
const ORDER = { id: '0178bbbb-0000-4000-8000-000000000001', tenantId: T, periodStart: '2026-03-01', periodEnd: '2026-03-31' };
const NOW = new Date('2026-11-09T13:35:00Z');

/** Wpisy ZIP z katalogu centralnego, rozpakowane (jak program do archiwów). */
function rozpakuj(zip: Buffer): Map<string, Buffer> {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(eocd + 10);
  let cd = zip.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    const method = zip.readUInt16LE(cd + 10);
    const size = zip.readUInt32LE(cd + 20);
    const nameLen = zip.readUInt16LE(cd + 28);
    const extraLen = zip.readUInt16LE(cd + 30);
    const commentLen = zip.readUInt16LE(cd + 32);
    const name = zip.subarray(cd + 46, cd + 46 + nameLen).toString('utf8');
    const lh = zip.readUInt32LE(cd + 42);
    const start = lh + 30 + zip.readUInt16LE(lh + 26) + zip.readUInt16LE(lh + 28);
    const raw = zip.subarray(start, start + size);
    out.set(name, method === 8 ? inflateRawSync(raw) : Buffer.from(raw));
    cd += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function missingObject(): Error {
  return Object.assign(new Error('The specified key does not exist.'), { name: 'NoSuchKey' });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.tables = {
    tenants: [{ id: T, nip: '1234567890', name: 'Firma Testowa' }],
    invoices: [
      {
        id: 's1', tenant_id: T, direction: 'outgoing', internal_number: 'FV/1/2026', ksef_number: '1234567890-20260305-0100A1-AB',
        ksef_status: 'accepted', ksef_environment: 'test', origin: 'manual', issue_date: '2026-03-05', sale_date: '2026-03-05',
        payment_due_date: '2026-03-19', net_total: 1000, vat_total: 230, gross_total: 1230, currency: 'PLN',
        buyer_data: { name: 'Nabywca; Sp. z o.o.', nip: '5260001246' }, buyer_nip: '5260001246', seller_nip: '1234567890',
        seller_data: { name: 'Firma Testowa' }, xml_storage_path: `${T}/2026/03/s1.xml`,
      },
      {
        id: 'z1', tenant_id: T, direction: 'incoming', internal_number: 'ZK/7', ksef_number: '5260001246-20260307-0200B2-CD',
        ksef_status: 'accepted', ksef_environment: 'test', origin: 'ksef_inbox', issue_date: '2026-03-07', sale_date: null,
        payment_due_date: null, net_total: 100, vat_total: 23, gross_total: 123, currency: 'PLN',
        seller_data: { name: 'Hurtownia' }, seller_nip: '5260001246', buyer_data: null, buyer_nip: '1234567890',
        xml_storage_path: `${T}/ksef-import/z1.xml`,
      },
      // Szkic nie jest dokumentem: ani w paczce, ani na liście braków.
      { id: 'd1', tenant_id: T, direction: 'outgoing', internal_number: null, ksef_status: 'draft', issue_date: '2026-03-10' },
    ],
    xml_documents: [
      { tenant_id: T, invoice_id: 's1', storage_path: `${T}/2026/03/s1.xml`, sha256_hash: 'h-s1' },
      { tenant_id: T, invoice_id: 'z1', storage_path: `${T}/ksef-import/z1.xml`, sha256_hash: 'h-z1' },
    ],
    upo_receipts: [
      { tenant_id: T, invoice_id: 's1', status: 'downloaded', upo_xml_path: `upo/${T}/s1.xml`, created_at: '2026-03-05T10:00:00Z' },
    ],
    expenses: [
      {
        id: 'e1', tenant_id: T, issue_date: '2026-03-09', document_number: 'PAR/12', document_type: 'receipt', seller_name: 'Sklep',
        seller_nip: null, net_amount: 10, vat_amount: 2.3, gross_amount: 12.3, source: 'ocr_photo',
        source_file_path: `tenants/${T}/expenses/2026/03/e1.jpg`, source_file_mime: 'image/jpeg', ksef_invoice_id: null,
      },
    ],
  };
  h.xml.mockImplementation(async (path: string) => `<Faktura>${path}</Faktura>`);
  h.r2.mockImplementation(async (key: string) => Buffer.from(`<UPO>${key}</UPO>`));
  h.photo.mockImplementation(async () => ({ buffer: Buffer.from('JPEG'), mimeType: 'image/jpeg' }));
  h.pdf.mockImplementation(async (id: string) => ({ success: true, pdf: Buffer.from(`%PDF ${id}`), filename: 'x.pdf', qrStateKey: 'k', missingKodI: false }));
  h.office.mockResolvedValue('1471');
  h.address.mockResolvedValue({ wojewodztwo: 'mazowieckie' });
  h.xsd.mockResolvedValue(undefined);
});

describe('archiwum dokumentów: składanie paczki', () => {
  it('komplet: XML z KSeF, PDF i UPO sprzedaży, XML i PDF zakupu, zdjęcie kosztu, listy CSV i spis', async () => {
    const built = await buildArchivePackage({ ...ORDER, kind: 'archive' }, { now: NOW });
    const files = rozpakuj(built.zip);

    expect([...files.keys()].sort()).toEqual([
      'CO-JEST-W-PACZCE.txt',
      'faktury-sprzedazy/2026-03-05_FV_1_2026.pdf',
      'faktury-sprzedazy/2026-03-05_FV_1_2026.upo.xml',
      'faktury-sprzedazy/2026-03-05_FV_1_2026.xml',
      'faktury-zakupu/2026-03-07_5260001246_ZK_7.pdf',
      'faktury-zakupu/2026-03-07_5260001246_ZK_7.xml',
      'faktury.csv',
      'koszty.csv',
      'koszty/2026-03-09_PAR_12.jpg',
    ]);
    expect(built.fileName).toBe('Archiwum_1234567890_2026-03-01_2026-03-31.zip');
    expect(built.filesCount).toBe(6);
    expect(built.missing).toEqual([]);
    // XML czytany z weryfikacją skrótu zapisanego przy wysyłce.
    expect(h.xml).toHaveBeenCalledWith(`${T}/2026/03/s1.xml`, 'h-s1', T);
    expect(files.get('faktury-sprzedazy/2026-03-05_FV_1_2026.xml')?.toString()).toBe(`<Faktura>${T}/2026/03/s1.xml</Faktura>`);

    const spis = files.get('CO-JEST-W-PACZCE.txt')!.toString('utf8');
    expect(spis).toContain('Okres: od 01.03.2026 do 31.03.2026');
    expect(spis).toContain('Utworzono: 09.11.2026, 14:35');
    expect(spis).toContain('Plików dokumentów w paczce: 6');
    expect(spis).toContain('Braki: nie ma');
    expect(spis).not.toMatch(/[—–]/);

    const csv = files.get('faktury.csv')!.toString('utf8');
    expect(csv.startsWith('﻿Rodzaj;Numer;Numer KSeF;Data wystawienia')).toBe(true);
    // Średnik w nazwie kontrahenta nie rozbija kolumn.
    expect(csv).toContain('sprzedaż;FV/1/2026;1234567890-20260305-0100A1-AB;2026-03-05;2026-03-05;2026-03-19;"Nabywca; Sp. z o.o.";5260001246;1000,00;230,00;1230,00;PLN;przyjęta w KSeF');
    expect(csv).toContain('zakup;ZK/7;5260001246-20260307-0200B2-CD;2026-03-07;;;Hurtownia;5260001246;100,00;23,00;123,00;PLN;przyjęta w KSeF');
    expect(csv).not.toContain('d1');
    expect(files.get('koszty.csv')!.toString('utf8')).toContain('2026-03-09;PAR/12;paragon;Sklep;;10,00;2,30;12,30;koszty/2026-03-09_PAR_12.jpg');
  });

  it('brak pliku w magazynie nie przerywa paczki: trafia do spisu z powodem i wyjściem', async () => {
    h.xml.mockRejectedValueOnce(missingObject());
    h.photo.mockRejectedValueOnce(missingObject());
    h.tables.upo_receipts = [];

    const built = await buildArchivePackage({ ...ORDER, kind: 'archive' }, { now: NOW });
    const files = rozpakuj(built.zip);

    expect(files.has('faktury-sprzedazy/2026-03-05_FV_1_2026.xml')).toBe(false);
    expect(files.has('faktury-sprzedazy/2026-03-05_FV_1_2026.pdf')).toBe(true);
    expect(files.has('koszty/2026-03-09_PAR_12.jpg')).toBe(false);
    expect(built.missing.map((m) => `${m.dokument} | ${m.plik}`)).toEqual([
      'Faktura sprzedaży FV/1/2026 | XML z KSeF',
      'Faktura sprzedaży FV/1/2026 | UPO',
      'Koszt PAR/12 z 09.03.2026 (Sklep) | zdjęcie dokumentu',
    ]);
    const spis = files.get('CO-JEST-W-PACZCE.txt')!.toString('utf8');
    expect(spis).toContain('Braki (3)');
    expect(spis).toContain('Aplikacji Podatnika KSeF');
    expect(spis).not.toMatch(/[—–]/);
    expect(built.filesCount).toBe(3);
  });

  it('inny błąd magazynu niż brak obiektu przerywa próbę (ponowienie), a nie udaje braku', async () => {
    h.xml.mockRejectedValueOnce(Object.assign(new Error('socket hang up'), { name: 'TimeoutError' }));
    await expect(buildArchivePackage({ ...ORDER, kind: 'archive' }, { now: NOW })).rejects.toThrow('socket hang up');
  });

  it('paczka na kontrolę: JPK_FA, którego generator nie obsłuży, idzie do spisu jako brak z komunikatem generatora', async () => {
    h.fetchJpk.mockResolvedValue({ issuer: { nip: '1234567890', name: 'Firma Testowa', address: {} }, issuedInvoices: [{ invoiceNumber: 'FV/1/2026' }], receivedInvoices: [], expenses: [] });
    h.jpk.mockImplementation(() => {
      throw new JpkDocumentNotSupportedError('FV/1/2026', '1234567890-20260305-0100A1-AB', 'ma stawkę VAT „0 WDT”, której FaktWay jeszcze nie wykazuje w JPK.');
    });

    const built = await buildArchivePackage({ ...ORDER, kind: 'audit' }, { now: NOW });
    const files = rozpakuj(built.zip);

    expect(built.fileName).toBe('Kontrola_1234567890_2026-03-01_2026-03-31.zip');
    expect([...files.keys()].some((n) => n.startsWith('JPK_FA'))).toBe(false);
    expect(built.missing).toEqual([
      expect.objectContaining({ dokument: 'JPK_FA za okres', plik: 'JPK_FA', powod: expect.stringContaining('faktura FV/1/2026') }),
    ]);
    const spis = files.get('CO-JEST-W-PACZCE.txt')!.toString('utf8');
    expect(spis).toContain('paczka na kontrolę');
    expect(spis).toContain('JPK_PKPIR, JPK_EWP i JPK_ST');
    // Komunikat generatora ma długi myślnik; spis go nie powtarza.
    expect(spis).not.toMatch(/[—–]/);
  });

  it('paczka na kontrolę: JPK_FA z generatora eksportu, sprawdzony XSD, trafia do paczki', async () => {
    h.fetchJpk.mockResolvedValue({ issuer: { nip: '1234567890', name: 'Firma Testowa', address: {} }, issuedInvoices: [{ invoiceNumber: 'FV/1/2026' }], receivedInvoices: [], expenses: [] });
    h.jpk.mockReturnValue('<JPK/>');

    const built = await buildArchivePackage({ ...ORDER, kind: 'audit' }, { now: NOW });
    const files = rozpakuj(built.zip);

    expect(files.get('JPK_FA_1234567890_2026-03-01_2026-03-31.xml')?.toString()).toBe('<JPK/>');
    expect(h.xsd).toHaveBeenCalledWith('JPK_FA', '<JPK/>');
    expect(h.fetchJpk).toHaveBeenCalledWith(expect.objectContaining({ tenantId: T, periodStart: '2026-03-01', periodEnd: '2026-03-31', direction: 'issued', includeExpenses: false }));
    expect(h.jpk).toHaveBeenCalledWith(expect.objectContaining({ issuer: expect.objectContaining({ taxOfficeCode: '1471' }) }));
    expect(built.filesCount).toBe(7);
  });

  it('za duża paczka kończy się odmową z wyjściem (krótszy okres), zanim zapełni pamięć workera', async () => {
    await expect(buildArchivePackage({ ...ORDER, kind: 'archive' }, { now: NOW, maxSourceBytes: 10 })).rejects.toBeInstanceOf(ArchiveTooLargeError);
  });
});

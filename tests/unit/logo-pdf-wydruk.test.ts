import { readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeSupabase, memoryDb, type MemoryDb } from '../helpers/fake-supabase-memory';
import { KONFIGURACJA_MAGAZYNU, bladMagazynu, klientMagazynu, nowyMagazyn, type Magazyn } from '../helpers/magazyn-atrapa';
import { kanonPdf, skrotKanonuPdf } from '../helpers/pdf-kanon';

/**
 * Logo z ustawień firmy na wydruku faktury (krok 2.2, część 1) na prawdziwej
 * ścieżce `generateInvoicePdf`: klucz logo z `tenants` (atrapa bazy), plik
 * z magazynu (atrapa poleceń S3), prawdziwy renderer i klucz PDF w pamięci
 * podręcznej. Brak pliku, błąd odczytu i uszkodzony plik dają PDF bez logo
 * i wpis w logu, nie odmowę wydruku. Proforma i oferta: trasa PDF.
 */

const TENANT = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const INNA_FIRMA = '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e';
const KLUCZ_LOGO = `tenants/${TENANT}/logo/5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e8f.png`;

const m = vi.hoisted(() => ({
  db: null as unknown as MemoryDb,
  magazyn: null as unknown as Magazyn,
  load: vi.fn(),
  save: vi.fn(),
  offline: vi.fn(),
  pdfExists: vi.fn(),
  pdfDownload: vi.fn(),
  pdfUpload: vi.fn(),
  ctx: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: () => fakeSupabase(m.db),
  createClient: async () => fakeSupabase(m.db),
}));
vi.mock('@/lib/supabase/auth-context', () => ({ resolveApiUserAndActiveOrg: m.ctx }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('@/lib/storage/r2-client', () => ({
  getR2Client: () => klientMagazynu(m.magazyn),
  getR2Config: () => KONFIGURACJA_MAGAZYNU,
}));
// Warstwa bazy faktury i magazyn PDF faktur: atrapy jak w invoice-pdf-storage-isolation.test.ts.
vi.mock('@/lib/pdf/invoice-data', () => ({
  loadInvoiceForPdf: m.load,
  saveInvoicePdfPath: m.save,
  invoiceHasOfflineQueueEntry: m.offline,
}));
vi.mock('@/lib/pdf/pdf-storage', async (orig) => ({
  ...(await orig<typeof import('@/lib/pdf/pdf-storage')>()),
  invoicePdfExists: m.pdfExists,
  downloadInvoicePdf: m.pdfDownload,
  uploadInvoicePdf: m.pdfUpload,
}));

import { GET as pdfDokumentu } from '@/app/api/proformy/[id]/pdf/route';
import { generateInvoicePdf } from '@/lib/pdf/invoice-pdf';
import { renderInvoicePdf } from '@/lib/pdf/invoice-renderer';
import { prepareLogoUpload } from '@/lib/pdf/logo-obraz';
import { buildInvoicePdfKey } from '@/lib/pdf/pdf-storage';
import { quoteEmailIdempotencyKey } from '@/lib/proformy/mail';
import { finalizeInvoice, type InvoiceInput } from '@/lib/xml/invoice-calculator';

const LOGO = (() => {
  const wynik = prepareLogoUpload(readFileSync('docs/brand/logo/zestaw/png/faktway-logo-1200.png'));
  if (!wynik.ok) throw new Error(wynik.error);
  return wynik.logo;
})();

function faktura() {
  const input: InvoiceInput = {
    internalNumber: 'FV 7/11/2026',
    type: 'VAT',
    issueDate: '2026-11-05',
    seller: { nip: '1234567890', name: 'Moja Firma', address: { countryCode: 'PL', addressLine1: 'ul. A 1', addressLine2: '00-001 Warszawa' } },
    buyer: { nip: '1234567890', name: 'Klient', address: { countryCode: 'PL', addressLine1: 'ul. B 2', addressLine2: '00-002 Warszawa' } },
    lines: [{ ordinal: 1, name: 'Usługa', unit: 'usł.', quantity: 1, unitPriceNet: 100, vatRate: '23' }],
    payment: { currency: 'PLN', dueDate: '2026-11-19', method: 'transfer' },
  };
  return finalizeInvoice(input);
}

function dane(zmiany: Record<string, unknown> = {}) {
  return {
    invoice: faktura(), tenantId: TENANT, invoiceId: 'inv-1', issueDate: '2026-11-05',
    ksefNumber: null, ksefStatus: 'draft', internalNumberMissing: false, offlineIdempotencyKey: null,
    sellerNip: '1234567890', xmlSha256Hex: null, correctedInvoice: null, receiptInvoiceMarker: false,
    updatedAt: '2026-11-05T10:00:00Z', pdfStoragePath: null, pdfGeneratedAt: null,
    ...zmiany,
  };
}

const KLUCZ_BEZ_LOGO = buildInvoicePdfKey(TENANT, 'inv-1', '2026-11-05');
const KLUCZ_Z_LOGO = buildInvoicePdfKey(TENANT, 'inv-1', '2026-11-05', null, null, KLUCZ_LOGO);

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-13T10:00:00.000Z') });
  vi.clearAllMocks();
  m.db = memoryDb({ tenants: [{ id: TENANT, name: 'Moja Firma', logo_storage_key: KLUCZ_LOGO }] });
  m.magazyn = nowyMagazyn();
  m.magazyn.obiekty.set(KLUCZ_LOGO, { body: LOGO.data, contentType: 'image/png', lastModified: new Date() });
  m.load.mockResolvedValue(dane());
  m.offline.mockResolvedValue(false);
  m.pdfExists.mockResolvedValue(true);
  m.pdfUpload.mockResolvedValue(undefined);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  warn.mockRestore();
});

async function bezLogo(): Promise<string> {
  return skrotKanonuPdf(await renderInvoicePdf(faktura(), { qrLabel: 'OFFLINE', testWatermark: true }));
}

describe('generateInvoicePdf: logo firmy', () => {
  it('firma z logo: logo na PDF, osobny klucz w pamięci podręcznej, stan przed wydaniem zgodny', async () => {
    const wynik = await generateInvoicePdf('inv-1', TENANT);
    expect(wynik).toMatchObject({ success: true, qrStateKey: KLUCZ_Z_LOGO });
    if (!wynik.success) throw new Error(wynik.error);
    expect(kanonPdf(wynik.pdf)).toMatch(/\/Subtype \/Image/);
    expect(m.pdfUpload).toHaveBeenCalledWith(KLUCZ_Z_LOGO, wynik.pdf);
    expect(m.save).toHaveBeenCalledWith('inv-1', KLUCZ_Z_LOGO);
    expect(m.magazyn.wywolania).toEqual([`GET ${KLUCZ_LOGO}`]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('firma bez logo: klucz i wydruk jak przed zmianą, bez odczytu magazynu', async () => {
    m.db.tables.tenants![0]!.logo_storage_key = null;
    const wynik = await generateInvoicePdf('inv-1', TENANT);
    expect(wynik).toMatchObject({ success: true, qrStateKey: KLUCZ_BEZ_LOGO });
    if (!wynik.success) throw new Error(wynik.error);
    expect(skrotKanonuPdf(wynik.pdf)).toBe(await bezLogo());
    expect(m.magazyn.wywolania).toEqual([]);
  });

  it.each([
    ['brak pliku w magazynie', () => m.magazyn.obiekty.clear()],
    ['błąd odczytu magazynu', () => m.magazyn.awarie.set('GET', bladMagazynu())],
    ['uszkodzony plik', () => m.magazyn.obiekty.set(KLUCZ_LOGO, { body: Buffer.from('\x89PNG\r\n\x1a\nśmieci'), lastModified: new Date() })],
  ])('%s: PDF bez logo i wpis w logu, nie odmowa wydruku', async (_opis, awaria) => {
    awaria();
    const wynik = await generateInvoicePdf('inv-1', TENANT);
    expect(wynik).toMatchObject({ success: true, qrStateKey: KLUCZ_BEZ_LOGO });
    if (!wynik.success) throw new Error(wynik.error);
    expect(skrotKanonuPdf(wynik.pdf)).toBe(await bezLogo());
    // Bez logo PDF ląduje pod kluczem bez logo: następne pobranie spróbuje logo jeszcze raz.
    expect(m.pdfUpload).toHaveBeenCalledWith(KLUCZ_BEZ_LOGO, wynik.pdf);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[pdf-logo]'), expect.anything());
  });

  it('klucz logo spoza firmy (wiersz bazy to dane): bez odczytu magazynu i bez logo', async () => {
    m.db.tables.tenants![0]!.logo_storage_key = `tenants/${INNA_FIRMA}/logo/5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e8f.png`;
    const wynik = await generateInvoicePdf('inv-1', TENANT);
    expect(wynik).toMatchObject({ success: true, qrStateKey: KLUCZ_BEZ_LOGO });
    expect(m.magazyn.wywolania).toEqual([]);
  });

  it('przed migracją 00202 (brak kolumny): PDF bez logo, bez wpisu w logu', async () => {
    m.db.failures['tenants:select'] = { code: '42703', message: 'column tenants.logo_storage_key does not exist' };
    const wynik = await generateInvoicePdf('inv-1', TENANT);
    expect(wynik).toMatchObject({ success: true, qrStateKey: KLUCZ_BEZ_LOGO });
    expect(warn).not.toHaveBeenCalled();
  });

  it('PDF w pamięci podręcznej sprzed logo: po dodaniu logo powstaje nowy, z logo', async () => {
    m.load.mockResolvedValue(dane({ pdfStoragePath: KLUCZ_BEZ_LOGO, pdfGeneratedAt: '2026-11-06T10:00:00Z' }));
    const wynik = await generateInvoicePdf('inv-1', TENANT);
    expect(wynik).toMatchObject({ success: true, qrStateKey: KLUCZ_Z_LOGO });
    expect(m.pdfDownload).not.toHaveBeenCalled();
    expect(m.pdfUpload).toHaveBeenCalledWith(KLUCZ_Z_LOGO, expect.any(Buffer));
  });

  it('PDF z logo w pamięci podręcznej: bez renderowania i bez odczytu logo', async () => {
    m.load.mockResolvedValue(dane({ pdfStoragePath: KLUCZ_Z_LOGO, pdfGeneratedAt: '2026-11-06T10:00:00Z' }));
    m.pdfDownload.mockResolvedValue(Buffer.from('zapisany-pdf'));
    const wynik = await generateInvoicePdf('inv-1', TENANT);
    expect(wynik).toMatchObject({ success: true, pdf: Buffer.from('zapisany-pdf'), qrStateKey: KLUCZ_Z_LOGO });
    expect(m.magazyn.wywolania).toEqual([]);
    expect(m.pdfUpload).not.toHaveBeenCalled();
  });
});

describe('proforma i oferta: trasa PDF z logo firmy', () => {
  const DOKUMENT = '5d0e8a8c-7a3b-4f61-9d2e-1c4b5a6f7e80';
  const strona = { name: 'Firma', nip: '1234567890', countryCode: 'PL', addressLine1: 'ul. A 1', addressLine2: '00-001 Warszawa' };

  beforeEach(() => {
    m.db.tables.sales_quotes = [{
      id: DOKUMENT, tenant_id: TENANT, kind: 'offer', status: 'issued', number: 'OF/3/2026', issue_date: '2026-11-11',
      valid_until: '2026-12-11',
      items: [{ name: 'Usługa', unit: 'szt', quantity: 1, unitPriceNet: 100, vatRate: '23', netAmount: 100, vatAmount: 23, grossAmount: 123 }],
      net_total: 100, vat_total: 23, gross_total: 123, currency: 'PLN', contractor_id: null, counterparty: strona, issuer: strona,
      payment_method: null, payment_due_date: null, bank_account: null, notes: null,
      issued_at: '2026-11-11T09:30:00.000Z', created_at: '2026-11-11T09:00:00.000Z',
    }];
    m.ctx.mockResolvedValue({ ok: true, userId: 'u-1', tenantId: TENANT, role: 'member' });
  });

  const pobierz = async () => {
    const res = await pdfDokumentu(new Request(`http://localhost/api/proformy/${DOKUMENT}/pdf`), { params: Promise.resolve({ id: DOKUMENT }) });
    expect(res.status).toBe(200);
    return Buffer.from(await res.arrayBuffer());
  };

  it('logo z ustawień firmy w nagłówku PDF', async () => {
    expect(kanonPdf(await pobierz())).toMatch(/\/Subtype \/Image/);
    expect(m.magazyn.wywolania).toEqual([`GET ${KLUCZ_LOGO}`]);
  });

  it('bez pliku logo: PDF bez logo i wpis w logu, nie odmowa', async () => {
    m.magazyn.obiekty.clear();
    expect(kanonPdf(await pobierz())).not.toMatch(/\/Subtype \/Image/);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[pdf-logo]'), expect.anything());
  });
});

describe('mail z proformą: klucz idempotencji a logo w załączniku', () => {
  const ID = '5d0e8a8c-7a3b-4f61-9d2e-1c4b5a6f7e80';

  it('bez logo klucz jak przed zmianą; inne logo w PDF to inny klucz z tym samym przedrostkiem dokumentu', () => {
    const bez = quoteEmailIdempotencyKey(ID, 'jan@firma.pl', 0);
    expect(quoteEmailIdempotencyKey(ID, 'jan@firma.pl', 0, null)).toBe(bez);
    const zLogo = quoteEmailIdempotencyKey(ID, 'jan@firma.pl', 0, KLUCZ_LOGO);
    expect(zLogo.startsWith(`${bez}/`)).toBe(true);
    expect(quoteEmailIdempotencyKey(ID, 'jan@firma.pl', 0, `tenants/${TENANT}/logo/6c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e8f.png`)).not.toBe(zLogo);
    expect(zLogo.length).toBeLessThanOrEqual(200);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Krok 2.10: pliki ze strony nabywcy (`/faktura/<token>/pdf` i `/xml`).
 * Plik idzie z magazynu przez krótki podpisany adres (przekierowanie 303),
 * a trasa sama nie oddaje bajtów faktury. Każde żądanie przechodzi przez ten
 * sam odczyt co strona (limit prób, skrót tokenu, funkcja bazy), bez
 * liczenia otwarcia. Atrapy: odczyt (sprawdza go test strony), magazyn,
 * generator PDF.
 */

const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde';
const TENANT = '00179179-0000-4000-8000-0000000000aa';
const INVOICE = '00179179-1111-4000-8000-0000000000bb';
const XML_PATH = `${TENANT}/2026/10/${INVOICE}.xml`;
const PDF_KEY = `${TENANT}/2026/10/${INVOICE}.v6.abc.pdf`;
const SIGNED = 'https://pliki.example.test/podpisany?X-Amz-Signature=fixture';

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  sign: vi.fn(),
  pdf: vi.fn(),
  exists: vi.fn(),
}));

vi.mock('@/lib/invoice-share/buyer-invoice', () => ({ loadBuyerInvoice: mocks.load }));
vi.mock('@/lib/storage/r2', () => ({ getSignedInvoiceUrl: mocks.sign }));
vi.mock('@/lib/pdf/invoice-pdf', () => ({ generateInvoicePdf: mocks.pdf }));
vi.mock('@/lib/pdf/pdf-storage', () => ({ invoicePdfExists: mocks.exists }));

const { GET: getXml } = await import('@/app/faktura/[token]/xml/route');
const { GET: getPdf } = await import('@/app/faktura/[token]/pdf/route');

const context = { params: Promise.resolve({ token: TOKEN }) };
const req = () => new Request(`https://faktway.pl/faktura/${TOKEN}/xml`);

function ok(xmlStoragePath: string = XML_PATH) {
  return {
    status: 'ok',
    view: { number: 'FV/1/11/2026' },
    access: { tenantId: TENANT, invoiceId: INVOICE, linkId: 'l1', xmlStoragePath },
  };
}

function expectPrivateHeaders(response: Response) {
  expect(response.headers.get('cache-control')).toMatch(/no-store/);
  expect(response.headers.get('x-robots-tag')).toMatch(/noindex/);
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.sign.mockResolvedValue(SIGNED);
  mocks.exists.mockResolvedValue(true);
});

describe.each([
  ['xml', () => getXml(req(), context)],
  ['pdf', () => getPdf(req(), context)],
] as const)('/faktura/<token>/%s: odmowy', (_name, call) => {
  it('limit prób: 429 z Retry-After, bez podpisu', async () => {
    mocks.load.mockResolvedValue({ status: 'limited', retryAfter: 120 });
    const response = await call();
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('120');
    expectPrivateHeaders(response);
    expect(mocks.sign).not.toHaveBeenCalled();
  });

  it('bez Redisa albo przy błędzie bazy: 503, bez podpisu', async () => {
    mocks.load.mockResolvedValue({ status: 'unavailable' });
    const response = await call();
    expect(response.status).toBe(503);
    expectPrivateHeaders(response);
    expect(mocks.sign).not.toHaveBeenCalled();
  });

  it('nieznany, wygasły albo cofnięty link: 404, bez podpisu', async () => {
    mocks.load.mockResolvedValue({ status: 'not_found' });
    const response = await call();
    expect(response.status).toBe(404);
    expectPrivateHeaders(response);
    expect(mocks.sign).not.toHaveBeenCalled();
    expect(mocks.pdf).not.toHaveBeenCalled();
  });

  it('pobranie pliku nie liczy się jako otwarcie linku', async () => {
    mocks.load.mockResolvedValue({ status: 'not_found' });
    await call();
    expect(mocks.load).toHaveBeenCalledWith(TOKEN, { countOpen: false });
  });
});

describe('/faktura/<token>/xml', () => {
  it('przekierowuje (303) na krótki podpisany adres pliku XML z KSeF tej faktury', async () => {
    mocks.load.mockResolvedValue(ok());
    const response = await getXml(req(), context);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(SIGNED);
    expectPrivateHeaders(response);
    expect(mocks.sign).toHaveBeenCalledTimes(1);
    const [path, tenant, ttl, options] = mocks.sign.mock.calls[0]!;
    expect([path, tenant]).toEqual([XML_PATH, TENANT]);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(120);
    expect(options).toEqual({ downloadFilename: 'FV-1-11-2026.xml', contentType: 'application/xml' });
  });

  it('ścieżka pliku spoza katalogu firmy: 404 bez podpisu', async () => {
    mocks.load.mockResolvedValue(ok(`inna-firma/2026/10/${INVOICE}.xml`));
    const response = await getXml(req(), context);
    expect(response.status).toBe(404);
    expect(mocks.sign).not.toHaveBeenCalled();
  });

  it('błąd podpisu: 503 bez adresu magazynu', async () => {
    mocks.load.mockResolvedValue(ok());
    mocks.sign.mockRejectedValue(new Error('storage down'));
    const response = await getXml(req(), context);
    expect(response.status).toBe(503);
    expect(response.headers.get('location')).toBeNull();
  });
});

describe('/faktura/<token>/pdf', () => {
  const pdfOk = { success: true, pdf: Buffer.from('%PDF-'), filename: 'Faktura_FV_1_11_2026.pdf', qrStateKey: PDF_KEY, missingKodI: false };

  it('generuje PDF tej faktury i przekierowuje (303) na krótki podpisany adres z magazynu', async () => {
    mocks.load.mockResolvedValue(ok());
    mocks.pdf.mockResolvedValue(pdfOk);
    const response = await getPdf(req(), context);
    expect(mocks.pdf).toHaveBeenCalledWith(INVOICE, TENANT);
    expect(mocks.exists).toHaveBeenCalledWith(PDF_KEY);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(SIGNED);
    expectPrivateHeaders(response);
    const [key, tenant, ttl, options] = mocks.sign.mock.calls[0]!;
    expect([key, tenant]).toEqual([PDF_KEY, TENANT]);
    expect(ttl).toBeLessThanOrEqual(120);
    expect(options).toEqual({ downloadFilename: 'Faktura_FV_1_11_2026.pdf', contentType: 'application/pdf' });
    // Trasa nie oddaje bajtów faktury sama.
    expect(await response.text()).not.toContain('%PDF');
  });

  it('PDF bez kodu QR KSeF nie idzie do nabywcy (ta sama reguła co e-mail): 409', async () => {
    mocks.load.mockResolvedValue(ok());
    mocks.pdf.mockResolvedValue({ ...pdfOk, missingKodI: true });
    const response = await getPdf(req(), context);
    expect(response.status).toBe(409);
    expect(mocks.sign).not.toHaveBeenCalled();
  });

  it('odmowa generatora: bez podpisu', async () => {
    mocks.load.mockResolvedValue(ok());
    mocks.pdf.mockResolvedValue({ success: false, code: 'PDF_STATE_CHANGED', error: 'Stan faktury zmienił się.' });
    const response = await getPdf(req(), context);
    expect(response.status).toBe(409);
    expect(mocks.sign).not.toHaveBeenCalled();
  });

  it('PDF nie trafił do magazynu: 503 z prośbą o ponowienie, bez podpisu', async () => {
    mocks.load.mockResolvedValue(ok());
    mocks.pdf.mockResolvedValue(pdfOk);
    mocks.exists.mockResolvedValue(false);
    const response = await getPdf(req(), context);
    expect(response.status).toBe(503);
    expect(mocks.sign).not.toHaveBeenCalled();
  });
});

import { readFileSync } from 'node:fs';

import PDFDocument from 'pdfkit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderInvoicePdf } from '@/lib/pdf/invoice-renderer';
import { LOGO_PDF_GAP, LOGO_PDF_HEIGHT, LOGO_PDF_MAX_WIDTH, logoPdfSize } from '@/lib/pdf/logo';
import { prepareLogoUpload, type PreparedLogo } from '@/lib/pdf/logo-obraz';
import { buildInvoicePdfKey, invoicePdfQrStateKey } from '@/lib/pdf/pdf-storage';
import { quoteItems, quoteTotals, type QuoteItemInput } from '@/lib/proformy/model';
import { renderQuotePdf, type QuotePdfInput } from '@/lib/proformy/pdf';
import { finalizeInvoice, type InvoiceInput } from '@/lib/xml/invoice-calculator';

import { kanonPdf, skrotKanonuPdf } from '../helpers/pdf-kanon';
import { kodujPng } from '../helpers/png-proby';

/**
 * Logo firmy w nagłówku PDF (plan kompletnej aplikacji, krok 2.2, część 1):
 * faktury wszystkich rodzajów (`lib/pdf/invoice-renderer.ts`), proformy
 * i oferty (`lib/proformy/pdf.ts`).
 *
 * „Bez logo wydruk taki sam jak dziś”: skróty kanonu PDF (treść każdego
 * obiektu po rozpakowaniu, `tests/helpers/pdf-kanon.ts`) policzone na
 * `origin/main` @ 6d0ffd4f, przed tą zmianą, przy stałej dacie utworzenia
 * pliku. Inny skrót = inny wydruk. Zmiana pdfkit albo czcionek zmienia
 * skróty: wtedy porównaj wydruki i wpisz nowe w osobnym PR.
 */

const PRZED_ZMIANA = {
  faktura: '5ed29f633a03eee5faaf1fe00d99b0b39240f31d95ce0d545b23a15ae51efad0',
  fakturaZKodemQr: 'e7712683a02aa6b66520981757613f512ae899ec0414027b8cc6aae2e1a6c858',
  korekta: '3e96d33497beb10fe690b6b1d8a39616e647f9c4abfb745cbb2c0d18c910ac70',
  proforma: '39b0d62ecb9404a39e0bf8d8c8148a44ba46b5b14841a1d70b9f584285295048',
  oferta: '48d617f0ae15409230edd1812421e82ce761329d447e32283819595a1e2fb168',
};

const WZOR_QR = 'https://qr-test.ksef.mf.gov.pl/invoice/1111111111/01-02-2026/UtQp9Gpc51y-u3xApZjIjgkpZ01js-J8KflSPW8WzIE';
const NUMER_KSEF = '1234567890-20261102-ABCDEF123456-01';
const MARGINES = 42;
const QR = 72;

function faktura() {
  const input: InvoiceInput = {
    internalNumber: 'FV 1/11/2026',
    type: 'VAT',
    issueDate: '2026-11-02',
    saleDate: '2026-11-03',
    seller: {
      nip: '1234567890',
      name: 'Moja Firma',
      address: { countryCode: 'PL', addressLine1: 'ul. Przykładowa 1', addressLine2: '00-001 Warszawa' },
    },
    buyer: {
      nip: '1234567890',
      name: 'Klient',
      address: { countryCode: 'PL', addressLine1: 'ul. Klienta 10', addressLine2: '02-001 Warszawa' },
    },
    lines: [
      { ordinal: 1, name: 'Usługa', unit: 'usł.', quantity: 1, unitPriceNet: 100, vatRate: '23' },
      { ordinal: 2, name: 'Towar', unit: 'szt', quantity: 3, unitPriceNet: 19.99, vatRate: '8' },
    ],
    payment: { currency: 'PLN', dueDate: '2026-11-16', method: 'transfer', bankAccount: 'PL61109010140000071219812874' },
  };
  return finalizeInvoice(input);
}

const Z_KODEM_QR = { qrPayload: WZOR_QR, qrLabel: NUMER_KSEF, ksefNumber: NUMER_KSEF, testWatermark: true };
const KOREKTA = {
  correctedInvoice: { number: 'FV 9/10/2026', issueDate: '2026-10-09', ksefNumber: null, reason: 'Błędna cena' },
  previewNotice: 'Podgląd bez kodu QR KSeF.',
};

// Kwoty poniżej 10 000 zł: bez separatora tysięcy z ICU, który mógłby się różnić między wersjami Node.
const POZYCJE: QuoteItemInput[] = [
  { name: 'Wdrożenie systemu (etap 1)', unit: 'szt', quantity: 1, unitPriceNet: 1_200, vatRate: '23' },
  { name: 'Szkolenie zespołu', unit: 'godz.', quantity: 4, unitPriceNet: 150, vatRate: '8' },
];

function dokument(zmiany: Partial<QuotePdfInput> = {}): QuotePdfInput {
  const items = quoteItems(POZYCJE);
  return {
    kind: 'proforma',
    number: 'PRO/1/2026',
    issueDate: '2026-11-11',
    validUntil: null,
    items,
    ...quoteTotals(items),
    issuer: { name: 'Moja Firma', nip: '1234567890', countryCode: 'PL', addressLine1: 'ul. Przykładowa 1', addressLine2: '00-001 Warszawa' },
    counterparty: { name: 'Kontrahent', nip: '1234567890', countryCode: 'PL', addressLine1: 'ul. Klienta 10', addressLine2: '02-001 Warszawa' },
    paymentMethod: 'transfer',
    paymentDueDate: '2026-11-25',
    bankAccount: 'PL61109010140000071219812874',
    notes: 'Realizacja po wpłacie.',
    issuedAt: '2026-11-11T09:30:00.000Z',
    ...zmiany,
  };
}

const OFERTA: Partial<QuotePdfInput> = {
  kind: 'offer',
  number: 'OF/4/2026',
  validUntil: '2026-12-11',
  paymentMethod: null,
  paymentDueDate: null,
  bankAccount: null,
};

function logo(bajty: Uint8Array): PreparedLogo {
  const wynik = prepareLogoUpload(bajty);
  if (!wynik.ok) throw new Error(wynik.error);
  return wynik.logo;
}

const LOGO_PNG = logo(readFileSync('docs/brand/logo/zestaw/png/faktway-logo-1200.png')); // 1200 × 266, RGBA
const LOGO_JPEG = logo(readFileSync('public/marketing/hero.jpg')); // 1400 × 803
const LOGO_SZEROKIE = logo(kodujPng({ width: 2000, height: 100, colorType: 2, bitDepth: 8, probki: () => [0, 90, 200] }));
const LOGO_WYSOKIE = logo(kodujPng({ width: 100, height: 400, colorType: 2, bitDepth: 8, probki: () => [0, 90, 200] }));

beforeEach(() => {
  // Data utworzenia pliku (Info, ID) bez zmiany zegarów: zapis PNG i strumieni idzie przez zlib.
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-13T10:00:00.000Z') });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Wywołania `doc.image` i `doc.text` podczas renderowania. */
function nagrywaj() {
  const image = vi.spyOn(PDFDocument.prototype, 'image');
  const text = vi.spyOn(PDFDocument.prototype, 'text');
  const moveTo = vi.spyOn(PDFDocument.prototype, 'moveTo');
  return {
    obrazy: () => image.mock.calls.map((c) => ({ x: c[1], y: c[2], opcje: c[3] as { width?: number; height?: number } })),
    teksty: () => text.mock.calls.map((c) => String(c[0])),
    polozenie: (napis: string) => {
      const call = text.mock.calls.find((c) => String(c[0]) === napis);
      return call ? { x: call[1] as number, y: call[2] as number } : null;
    },
    pierwszaLinia: () => moveTo.mock.calls[0]?.[1],
  };
}

describe('bez logo: wydruk taki sam jak przed zmianą', () => {
  it.each([
    ['faktura zwykła', () => renderInvoicePdf(faktura()), PRZED_ZMIANA.faktura],
    ['faktura zwykła, logo: null', () => renderInvoicePdf(faktura(), { logo: null }), PRZED_ZMIANA.faktura],
    ['faktura z kodem QR, numerem KSeF i znakiem wersji testowej', () => renderInvoicePdf(faktura(), Z_KODEM_QR), PRZED_ZMIANA.fakturaZKodemQr],
    ['ta sama, logo: null', () => renderInvoicePdf(faktura(), { ...Z_KODEM_QR, logo: null }), PRZED_ZMIANA.fakturaZKodemQr],
    ['korekta z fakturą korygowaną i dopiskiem podglądu', () => renderInvoicePdf({ ...faktura(), type: 'KOR' }, KOREKTA), PRZED_ZMIANA.korekta],
    ['proforma', () => renderQuotePdf(dokument()), PRZED_ZMIANA.proforma],
    ['proforma, logo: null', () => renderQuotePdf(dokument(), { logo: null }), PRZED_ZMIANA.proforma],
    ['oferta z datą ważności', () => renderQuotePdf(dokument(OFERTA)), PRZED_ZMIANA.oferta],
  ])('%s', async (_opis, wydruk, skrot) => {
    expect(skrotKanonuPdf(await wydruk())).toBe(skrot);
  });
});

describe('rozmiar logo: stała wysokość, proporcje bez zmian', () => {
  it('logo poziome: 40 pt wysokości, szerokość z proporcji', () => {
    expect(logoPdfSize(LOGO_PNG)).toEqual({ width: (LOGO_PDF_HEIGHT * 1200) / 266, height: LOGO_PDF_HEIGHT });
    expect(logoPdfSize(LOGO_WYSOKIE)).toEqual({ width: LOGO_PDF_HEIGHT / 4, height: LOGO_PDF_HEIGHT });
  });

  it('bardzo szerokie logo zmniejsza się do szerokości 200 pt, też z proporcjami', () => {
    expect(logoPdfSize(LOGO_SZEROKIE)).toEqual({ width: LOGO_PDF_MAX_WIDTH, height: LOGO_PDF_MAX_WIDTH / 20 });
  });
});

describe('faktura z logo', () => {
  it('logo w lewym górnym rogu, kod QR na swoim miejscu, nagłówek niżej o logo i odstęp', async () => {
    const zapis = nagrywaj();
    const pdf = await renderInvoicePdf(faktura(), { ...Z_KODEM_QR, logo: LOGO_PNG });
    const [obrazLogo, obrazQr] = zapis.obrazy();
    const { width, height } = logoPdfSize(LOGO_PNG);
    expect(obrazLogo).toEqual({ x: MARGINES, y: MARGINES, opcje: { width, height } });
    expect(obrazQr).toMatchObject({ y: MARGINES, opcje: { width: QR } });
    const gora = MARGINES + height + LOGO_PDF_GAP;
    expect(zapis.polozenie('Faktura VAT')).toEqual({ x: MARGINES, y: gora });
    expect(zapis.polozenie('Nr FV 1/11/2026')).toEqual({ x: MARGINES, y: gora + 26 });
    // Linia pod nagłówkiem pod niższym z bloków: tekst nagłówka (78 pt) albo kod QR (72 + 16 pt).
    expect(zapis.pierwszaLinia()).toBe(Math.max(gora + 78, MARGINES + QR + 16));
    expect(kanonPdf(pdf)).toMatch(/\/Subtype \/Image[\s\S]*\/SMask/);
  });

  it('elementy faktury (art. 106e ust. 1) bez zmian: te same napisy z logo i bez logo', async () => {
    const bez = nagrywaj();
    await renderInvoicePdf(faktura(), Z_KODEM_QR);
    const napisyBez = bez.teksty();
    vi.restoreAllMocks();
    const z = nagrywaj();
    await renderInvoicePdf(faktura(), { ...Z_KODEM_QR, logo: LOGO_JPEG });
    expect(z.teksty()).toEqual(napisyBez);
  });

  it('korekta i faktura bez kodu QR też mają logo; JPEG osadzony bez zmian', async () => {
    const zapis = nagrywaj();
    const pdf = await renderInvoicePdf({ ...faktura(), type: 'KOR' }, { ...KOREKTA, logo: LOGO_JPEG });
    const { width, height } = logoPdfSize(LOGO_JPEG);
    expect(zapis.obrazy()).toEqual([{ x: MARGINES, y: MARGINES, opcje: { width, height } }]);
    expect(zapis.polozenie('Faktura korygująca')).toEqual({ x: MARGINES, y: MARGINES + height + LOGO_PDF_GAP });
    expect(zapis.pierwszaLinia()).toBe(MARGINES + height + LOGO_PDF_GAP + 78);
    expect(kanonPdf(pdf)).toMatch(/\/Filter \/DCTDecode/);
  });

  it('szerokie logo: nagłówek niżej tylko o wysokość logo po zmniejszeniu', async () => {
    const zapis = nagrywaj();
    await renderInvoicePdf(faktura(), { logo: LOGO_SZEROKIE });
    expect(zapis.obrazy()[0]?.opcje).toEqual({ width: LOGO_PDF_MAX_WIDTH, height: 10 });
    expect(zapis.polozenie('Faktura VAT')?.y).toBe(MARGINES + 10 + LOGO_PDF_GAP);
  });
});

describe('proforma i oferta z logo', () => {
  it('logo w lewym górnym rogu, tytuł i data ważności niżej o logo i odstęp', async () => {
    const zapis = nagrywaj();
    const pdf = await renderQuotePdf(dokument(OFERTA), { logo: LOGO_PNG });
    const { width, height } = logoPdfSize(LOGO_PNG);
    expect(zapis.obrazy()).toEqual([{ x: MARGINES, y: MARGINES, opcje: { width, height } }]);
    const gora = MARGINES + height + LOGO_PDF_GAP;
    expect(zapis.polozenie('Oferta')?.y).toBe(gora);
    expect(zapis.polozenie('Oferta ważna do: 11.12.2026')?.y).toBe(gora + 56);
    expect(zapis.pierwszaLinia()).toBe(gora + 76);
    expect(kanonPdf(pdf)).toMatch(/\/Subtype \/Image/);
  });

  it('ten sam dokument z tym samym logo daje ten sam plik (ponowienie maila z kluczem idempotencji)', async () => {
    vi.useRealTimers();
    const a = await renderQuotePdf(dokument(), { logo: LOGO_PNG });
    const b = await renderQuotePdf(dokument(), { logo: LOGO_PNG });
    expect(a.equals(b)).toBe(true);
  });
});

describe('klucz PDF w pamięci podręcznej', () => {
  it('bez logo taki sam jak przed zmianą; z logo osobny klucz, a stan kodu QR ten sam', () => {
    const bez = buildInvoicePdfKey('ten-1', 'inv-1', '2026-11-02', WZOR_QR, NUMER_KSEF);
    expect(buildInvoicePdfKey('ten-1', 'inv-1', '2026-11-02', WZOR_QR, NUMER_KSEF, null)).toBe(bez);
    const z = buildInvoicePdfKey('ten-1', 'inv-1', '2026-11-02', WZOR_QR, NUMER_KSEF, 'tenants/ten-1/logo/a.png');
    expect(z).toMatch(/^ten-1\/2026\/11\/inv-1\.v7\.[0-9a-f]{32}\.l[0-9a-f]{16}\.pdf$/);
    expect(z).not.toBe(bez);
    expect(buildInvoicePdfKey('ten-1', 'inv-1', '2026-11-02', WZOR_QR, NUMER_KSEF, 'tenants/ten-1/logo/b.png')).not.toBe(z);
    expect(invoicePdfQrStateKey(z)).toBe(bez);
    expect(invoicePdfQrStateKey(bez)).toBe(bez);
  });
});

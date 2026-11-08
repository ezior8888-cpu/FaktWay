import PDFDocument from 'pdfkit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const s = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('resend', () => ({ Resend: class { emails = { send: s.send }; } }));
vi.mock('@/lib/email/preferences', () => ({ canSendTo: async () => ({ ok: true }) }));

import { renderInvoicePdf, transferTitleOnPdf } from '@/lib/pdf/invoice-renderer';
import { buildInvoicePdfKey } from '@/lib/pdf/pdf-storage';
import { finalizeInvoice, type InvoiceInput } from '@/lib/xml/invoice-calculator';
import type { Invoice } from '@/types/invoice';

/**
 * Krok 1.4 planu kompletnej aplikacji (RP-PLAT-01, RP-PLAT-03): faktura, którą
 * FaktWay daje nabywcy (PDF i mail z PDF w załączniku), podsuwa gotowy tytuł
 * przelewu: numer KSeF, potem numer faktury. Do tej zmiany numer KSeF był
 * tylko w stopce PDF, a sekcja „Płatność” miała sposób, termin i rachunek.
 * Bez numeru KSeF (szkic, wysyłka w toku, odrzucona, poza KSeF) dokument
 * wygląda jak dotąd. NIP fikcyjny z AGENTS.md.
 */

const KSEF = '1234567890-20270105-0A1B2C3D4E5F-7A';
const NUMER = 'FV 1/01/2027';

function faktura(payment: Partial<InvoiceInput['payment']> = {}): Invoice {
  return finalizeInvoice({
    internalNumber: NUMER,
    type: 'VAT',
    issueDate: '2027-01-05',
    saleDate: '2027-01-05',
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
    lines: [{ ordinal: 1, name: 'Usługa', unit: 'usł.', quantity: 1, unitPriceNet: 100, vatRate: '23' }],
    payment: { currency: 'PLN', dueDate: '2027-01-19', method: 'transfer', bankAccount: '61109010140000071219812874', ...payment },
  });
}

/** Wszystkie napisy, które renderer kładzie na stronie, w kolejności. */
async function napisyPdf(invoice: Invoice, ksefNumber: string | null): Promise<string[]> {
  const text = vi.spyOn(PDFDocument.prototype, 'text');
  try {
    await renderInvoicePdf(invoice, { ksefNumber });
    return text.mock.calls.map((call) => String(call[0]));
  } finally {
    text.mockRestore();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('PDF faktury: tytuł przelewu w sekcji „Płatność”', () => {
  it('z numerem KSeF: wiersz pod numerem rachunku, numer KSeF pierwszy, potem numer faktury', async () => {
    const napisy = await napisyPdf(faktura(), KSEF);
    const tytul = napisy.indexOf(`Tytuł przelewu: ${KSEF} ${NUMER}`);
    expect(tytul).toBeGreaterThan(-1);
    expect(napisy.findIndex((n) => n.startsWith('Nr rachunku:'))).toBe(tytul - 1);
    // Stopka z numerem KSeF zostaje, jak była.
    expect(napisy.indexOf(`Numer KSeF: ${KSEF}`)).toBeGreaterThan(tytul);
  });

  it('bez numeru KSeF (szkic, wysyłka w toku, odrzucona): sekcja płatności jak dotąd', async () => {
    const napisy = await napisyPdf(faktura(), null);
    expect(napisy.some((n) => n.includes('Tytuł przelewu'))).toBe(false);
  });

  it('numer KSeF spoza wzorca: bez wiersza z tytułem', async () => {
    const napisy = await napisyPdf(faktura(), 'KSEF-1');
    expect(napisy.some((n) => n.includes('Tytuł przelewu'))).toBe(false);
  });

  it.each(['cash', 'card'] as const)('zapłata inna niż przelew (%s): bez wiersza z tytułem', async (method) => {
    const napisy = await napisyPdf(faktura({ method }), KSEF);
    expect(napisy.some((n) => n.includes('Tytuł przelewu'))).toBe(false);
  });

  it('tytuł dla maila to ten sam tytuł, który stoi na PDF', async () => {
    const invoice = faktura();
    expect(transferTitleOnPdf(invoice, KSEF)).toBe(`${KSEF} ${NUMER}`);
    expect(await napisyPdf(invoice, KSEF)).toContain(`Tytuł przelewu: ${transferTitleOnPdf(invoice, KSEF)}`);
    expect(transferTitleOnPdf(invoice, null)).toBeNull();
    expect(transferTitleOnPdf(faktura({ method: 'cash' }), KSEF)).toBeNull();
  });

  it('nowy wiersz unieważnia PDF-y zapisane w pamięci podręcznej (nowa wersja w ścieżce)', () => {
    expect(buildInvoicePdfKey('tenant', 'invoice', '2027-01-05', 'qr', KSEF)).toContain('.v7.');
  });
});

describe('mail z fakturą do nabywcy: tytuł przelewu', () => {
  const payload = {
    to: 'nabywca@example.test',
    invoiceNumber: NUMER,
    sellerName: 'Moja Firma',
    amountCaption: 'Kwota brutto',
    amountLabel: '123,00 PLN',
    dueDate: '2027-01-19',
    pdf: Buffer.from('%PDF-1.4'),
    pdfFilename: 'Faktura.pdf',
  };

  beforeEach(() => {
    s.send.mockReset().mockResolvedValue({ data: { id: 'm' }, error: null });
    vi.stubEnv('RESEND_API_KEY', 're_test_klucz');
    vi.stubEnv('RESEND_DEV_TO_OVERRIDE', '');
  });

  async function html(extra: Record<string, unknown>): Promise<string> {
    const { sendInvoiceEmail } = await import('@/lib/email/send');
    await sendInvoiceEmail({ ...payload, ...extra } as Parameters<typeof sendInvoiceEmail>[0]);
    return String(s.send.mock.calls[0]![0].html);
  }

  it('z tytułem: trzeci wiersz tabeli obok kwoty i terminu', async () => {
    const tresc = await html({ transferTitle: `${KSEF} ${NUMER}` });
    expect(tresc).toContain(`Tytuł przelewu</td><td>${KSEF} ${NUMER}</td>`);
    expect(tresc.indexOf('Tytuł przelewu')).toBeGreaterThan(tresc.indexOf('Termin płatności'));
  });

  it.each([null, undefined])('bez tytułu (%s): tabela jak dotąd', async (transferTitle) => {
    const tresc = await html({ transferTitle });
    expect(tresc).not.toContain('Tytuł przelewu');
    expect(tresc).toContain('Termin płatności');
  });

  it('tytuł idzie do HTML z ucieczką znaków', async () => {
    const tresc = await html({ transferTitle: `${KSEF} FV<b>&1` });
    expect(tresc).toContain(`${KSEF} FV&lt;b&gt;&amp;1`);
    expect(tresc).not.toContain('FV<b>');
  });
});

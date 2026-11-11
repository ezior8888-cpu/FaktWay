import PDFDocument from 'pdfkit';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { quoteItems, quoteTotals, type QuoteItemInput } from '@/lib/proformy/model';
import { quotePdfFilename, renderQuotePdf, type QuotePdfInput } from '@/lib/proformy/pdf';
import { quoteNotInvoiceNotice } from '@/lib/proformy/teksty';

/**
 * PDF proformy i oferty (plan kompletnej aplikacji, krok 2.4). Dokument dla
 * kontrahenta z pozycjami i kwotami jak na fakturze (netto, VAT, brutto,
 * podsumowanie stawek), ale nie nazywa się fakturą: słowo „faktura” pada
 * tylko w adnotacji, że dokument nie jest fakturą VAT i nie trafia do KSeF
 * (MF: „Do KSeF nie przesyła się faktur proforma”, ksef.podatki.gov.pl,
 * „Zakres obowiązkowego KSeF”).
 */

const POZYCJE: QuoteItemInput[] = [
  { name: 'Wdrożenie systemu (etap 1)', unit: 'szt', quantity: 1, unitPriceNet: 12_000, vatRate: '23' },
  { name: 'Szkolenie zespołu', unit: 'godz.', quantity: 4, unitPriceNet: 150, vatRate: '8' },
];

function dokument(zmiany: Partial<QuotePdfInput> = {}): QuotePdfInput {
  const items = zmiany.items ?? quoteItems(POZYCJE);
  return {
    kind: 'proforma',
    number: 'PRO/1/2026',
    issueDate: '2026-11-11',
    validUntil: null,
    items,
    ...quoteTotals(items),
    issuer: {
      name: 'Moja Firma',
      nip: '1234567890',
      countryCode: 'PL',
      addressLine1: 'ul. Przykładowa 1',
      addressLine2: '00-001 Warszawa',
    },
    counterparty: {
      name: 'Kontrahent Testowy',
      nip: '1234567890',
      countryCode: 'PL',
      addressLine1: 'ul. Klienta 10',
      addressLine2: '02-001 Warszawa',
    },
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

/** Wszystkie napisy na stronach, z twardą spacją (separator tysięcy pl-PL) jako zwykłą. */
async function wydruk(input: QuotePdfInput): Promise<string[]> {
  const text = vi.spyOn(PDFDocument.prototype, 'text');
  await renderQuotePdf(input);
  const napisy = text.mock.calls.map((c) => String(c[0]).replace(/[  ]/g, ' '));
  text.mockRestore();
  return napisy;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PDF proformy i oferty: elementy dokumentu', () => {
  it('nagłówek: rodzaj, numer i data; oferta z datą ważności', async () => {
    const napisy = await wydruk(dokument());
    expect(napisy).toContain('Proforma');
    expect(napisy).toContain('Nr PRO/1/2026');
    expect(napisy).toContain('Data wystawienia: 11.11.2026');
    const oferta = await wydruk(dokument(OFERTA));
    expect(oferta).toContain('Oferta');
    expect(oferta).toContain('Nr OF/4/2026');
    expect(oferta).toContain('Oferta ważna do: 11.12.2026');
  });

  it('strony: sprzedawca i nabywca z NIP i adresem', async () => {
    const napisy = await wydruk(dokument());
    for (const oczekiwany of ['Sprzedawca', 'Nabywca', 'Moja Firma', 'Kontrahent Testowy', 'NIP: 1234567890', 'ul. Klienta 10', '02-001 Warszawa']) {
      expect(napisy, oczekiwany).toContain(oczekiwany);
    }
  });

  it('pozycje i kwoty jak na fakturze: netto, stawka, VAT, brutto, podsumowanie stawek', async () => {
    const napisy = await wydruk(dokument());
    for (const oczekiwany of [
      'Wdrożenie systemu (etap 1)',
      'Szkolenie zespołu',
      'godz.',
      'Cena netto',
      'Wartość netto',
      'Kwota VAT',
      'Wartość brutto',
      '12 000,00',
      // pl-PL nie grupuje liczb czterocyfrowych (lib/format/pl.ts): 2760, ale 12 000.
      '2760,00',
      '14 760,00',
      '600,00',
      '48,00',
      '648,00',
      '23%',
      '8%',
      'Razem netto: 12 600,00 PLN',
      'Razem VAT: 2808,00 PLN',
      'Razem brutto: 15 408,00 PLN',
    ]) {
      expect(napisy, oczekiwany).toContain(oczekiwany);
    }
  });

  it('proforma: do zapłaty, sposób i termin zapłaty, rachunek; oferta bez nich', async () => {
    const napisy = await wydruk(dokument());
    expect(napisy).toContain('Do zapłaty: 15 408,00 PLN');
    expect(napisy).toContain('Sposób zapłaty: Przelew');
    expect(napisy).toContain('Termin zapłaty: 25.11.2026');
    expect(napisy).toContain('Numer rachunku: PL61 1090 1014 0000 0712 1981 2874');
    expect((await wydruk(dokument(OFERTA))).join('\n')).not.toMatch(/Do zapłaty|Termin zapłaty|Numer rachunku|Sposób zapłaty/);
  });

  it('uwagi tylko, gdy są', async () => {
    expect(await wydruk(dokument())).toContain('Uwagi: Realizacja po wpłacie.');
    expect((await wydruk(dokument({ notes: null }))).join('\n')).not.toMatch(/Uwagi/);
  });
});

describe('PDF proformy i oferty: to nie jest faktura', () => {
  it('adnotacja proformy: nie jest fakturą VAT, nie trafia do KSeF, źródło MF', async () => {
    const notice = quoteNotInvoiceNotice('proforma');
    expect(notice).toMatch(/Proforma nie jest fakturą VAT/);
    expect(notice).toMatch(/Do KSeF nie przesyła się faktur proforma/);
    expect(notice).toMatch(/Ministerstw/);
    expect(notice).toMatch(/ksef\.podatki\.gov\.pl/);
    expect(notice).toMatch(/Zakres obowiązkowego KSeF/);
    expect(await wydruk(dokument())).toContain(notice);
  });

  it('adnotacja oferty: nie jest fakturą VAT i nie trafia do KSeF', async () => {
    const notice = quoteNotInvoiceNotice('offer');
    expect(notice).toMatch(/Oferta nie jest fakturą VAT/);
    expect(notice).toMatch(/KSeF/);
    expect(await wydruk(dokument(OFERTA))).toContain(notice);
  });

  it('słowo „faktura” tylko w adnotacji', async () => {
    for (const input of [dokument(), dokument(OFERTA)]) {
      const napisy = await wydruk(input);
      expect(napisy.filter((t) => /faktur/i.test(t))).toEqual([quoteNotInvoiceNotice(input.kind)]);
    }
  });

  it('bez długich myślników', async () => {
    expect((await wydruk(dokument())).filter((t) => /[—–]/.test(t))).toEqual([]);
    expect((await wydruk(dokument(OFERTA))).filter((t) => /[—–]/.test(t))).toEqual([]);
  });
});

describe('PDF proformy i oferty: plik', () => {
  it('ten sam dokument daje ten sam plik (ponowienie maila z tym samym kluczem idempotencji)', async () => {
    const a = await renderQuotePdf(dokument());
    const b = await renderQuotePdf(dokument());
    expect(a.subarray(0, 5).toString()).toBe('%PDF-');
    expect(Buffer.compare(a, b)).toBe(0);
  });

  it('długa lista pozycji przechodzi na kolejne strony bez utraty pozycji', async () => {
    const items = quoteItems(
      Array.from({ length: 60 }, (_, i) => ({
        name: `Pozycja ${i + 1} ${'opis '.repeat(12)}`,
        unit: 'szt',
        quantity: 1,
        unitPriceNet: 1,
        vatRate: '23' as const,
      })),
    );
    const napisy = await wydruk(dokument({ items, ...quoteTotals(items) }));
    expect(napisy.filter((t) => /^Pozycja \d+ /.test(t))).toHaveLength(60);
    expect(napisy).toContain('Razem brutto: 73,80 PLN');
  });

  it('nazwa pliku z rodzajem i numerem', () => {
    expect(quotePdfFilename('proforma', 'PRO/1/2026')).toBe('proforma-PRO-1-2026.pdf');
    expect(quotePdfFilename('offer', 'OF/12/2027')).toBe('oferta-OF-12-2027.pdf');
  });
});

import PDFDocument from 'pdfkit';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { notePdfFilename, renderNotePdf, type NotePdfInput } from '@/lib/noty/pdf';
import { NOTE_NOT_INVOICE_NOTICE } from '@/lib/noty/teksty';

/**
 * PDF noty (plan kompletnej aplikacji, krok 2.9, część 1). Dokument dla
 * kontrahenta: rodzaj i numer, data, strony, tytuł, pozycje, suma, przy nocie
 * obciążeniowej termin i rachunek. Nie nazywa się fakturą i nie ma pól VAT,
 * a adnotacja mówi wprost, że nota nie jest fakturą VAT i nie trafia do KSeF
 * (ksef.podatki.gov.pl, „Wystawianie i otrzymywanie faktur”, pytania 18 i 27).
 */

function nota(zmiany: Partial<NotePdfInput> = {}): NotePdfInput {
  return {
    kind: 'debit',
    number: 'NO/1/2026',
    issueDate: '2026-11-11',
    title: 'Kara umowna',
    items: [
      { description: 'Kara za opóźnienie dostawy (umowa 7/2026)', amount: 12_000 },
      { description: 'Zwrot kosztów transportu', amount: 99.99 },
    ],
    total: 12_099.99,
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
    relatedDocument: 'FV/2026/11/3',
    dueDate: '2026-11-25',
    bankAccount: 'PL61109010140000071219812874',
    issuedAt: '2026-11-11T09:30:00.000Z',
    ...zmiany,
  };
}

/** Wszystkie napisy na stronach, z twardą spacją (separator tysięcy pl-PL) jako zwykłą. */
async function wydruk(note: NotePdfInput): Promise<string[]> {
  const text = vi.spyOn(PDFDocument.prototype, 'text');
  await renderNotePdf(note);
  const napisy = text.mock.calls.map((c) => String(c[0]).replace(/ /g, ' '));
  text.mockRestore();
  return napisy;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PDF noty: elementy dokumentu', () => {
  it('nagłówek: rodzaj noty, numer i data wystawienia', async () => {
    const napisy = await wydruk(nota());
    expect(napisy).toContain('Nota obciążeniowa');
    expect(napisy).toContain('Nr NO/1/2026');
    expect(napisy).toContain('Data wystawienia: 11.11.2026');
    expect(await wydruk(nota({ kind: 'credit', number: 'NU/4/2026', dueDate: null, bankAccount: null }))).toContain('Nota uznaniowa');
  });

  it('strony, tytuł, odniesienie, pozycje i suma', async () => {
    const napisy = await wydruk(nota());
    for (const oczekiwany of [
      'Wystawca',
      'Odbiorca',
      'Moja Firma',
      'Kontrahent Testowy',
      'NIP: 1234567890',
      'ul. Klienta 10',
      'Tytuł: Kara umowna',
      'Dotyczy: FV/2026/11/3',
      'Kara za opóźnienie dostawy (umowa 7/2026)',
      '12 000,00',
      '99,99',
      'Razem: 12 099,99 PLN',
    ]) {
      expect(napisy, oczekiwany).toContain(oczekiwany);
    }
  });

  it('nota obciążeniowa: „obciążamy”, termin zapłaty i rachunek', async () => {
    const napisy = await wydruk(nota());
    expect(napisy.join('\n')).toMatch(/Obciążamy Państwa kwotą 12 099,99 PLN/);
    expect(napisy).toContain('Termin zapłaty: 25.11.2026');
    expect(napisy).toContain('Numer rachunku: PL61 1090 1014 0000 0712 1981 2874');
  });

  it('nota uznaniowa: „uznajemy”, bez terminu i rachunku', async () => {
    const napisy = await wydruk(nota({ kind: 'credit', number: 'NU/4/2026', dueDate: null, bankAccount: null }));
    expect(napisy.join('\n')).toMatch(/Uznajemy Państwa kwotą 12 099,99 PLN/);
    expect(napisy.join('\n')).not.toMatch(/Termin zapłaty|Numer rachunku/);
  });

  it('bez odniesienia: bez wiersza „Dotyczy”', async () => {
    expect((await wydruk(nota({ relatedDocument: null }))).join('\n')).not.toMatch(/Dotyczy/);
  });
});

describe('PDF noty: to nie jest faktura', () => {
  it('adnotacja: nota nie jest fakturą VAT i nie trafia do KSeF', async () => {
    expect(NOTE_NOT_INVOICE_NOTICE).toMatch(/nie jest fakturą VAT/);
    expect(NOTE_NOT_INVOICE_NOTICE).toMatch(/KSeF/);
    expect(await wydruk(nota())).toContain(NOTE_NOT_INVOICE_NOTICE);
    expect(await wydruk(nota({ kind: 'credit', dueDate: null, bankAccount: null }))).toContain(NOTE_NOT_INVOICE_NOTICE);
  });

  it('słowo „faktura” tylko w adnotacji, bez pól VAT (netto, brutto, stawka)', async () => {
    const napisy = await wydruk(nota({ relatedDocument: 'FV/2026/11/3 z 3.11.2026' }));
    expect(napisy.filter((t) => /faktur/i.test(t))).toEqual([NOTE_NOT_INVOICE_NOTICE]);
    expect(napisy.join('\n')).not.toMatch(/\b(netto|brutto|stawka|PTU)\b|kwota VAT|podatek VAT/i);
  });

  it('bez długich myślników', async () => {
    expect((await wydruk(nota())).filter((t) => /[—–]/.test(t))).toEqual([]);
  });
});

describe('PDF noty: plik', () => {
  it('ta sama nota daje ten sam plik (ponowienie maila z tym samym kluczem idempotencji)', async () => {
    const a = await renderNotePdf(nota());
    const b = await renderNotePdf(nota());
    expect(a.subarray(0, 5).toString()).toBe('%PDF-');
    expect(Buffer.compare(a, b)).toBe(0);
  });

  it('długa lista pozycji przechodzi na kolejne strony bez utraty pozycji', async () => {
    const items = Array.from({ length: 50 }, (_, i) => ({ description: `Pozycja ${i + 1} ${'opis '.repeat(20)}`, amount: 1 }));
    const napisy = await wydruk(nota({ items, total: 50 }));
    expect(napisy.filter((t) => /^Pozycja \d+ /.test(t))).toHaveLength(50);
    expect(napisy).toContain('Razem: 50,00 PLN');
  });

  it('nazwa pliku z numerem noty', () => {
    expect(notePdfFilename('NO/1/2026')).toBe('nota-NO-1-2026.pdf');
    expect(notePdfFilename('NU/12/2027')).toBe('nota-NU-12-2027.pdf');
  });
});

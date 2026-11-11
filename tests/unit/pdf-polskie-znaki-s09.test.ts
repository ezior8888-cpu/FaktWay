import { describe, expect, it } from 'vitest';

import { generateUpoPdf } from '@/lib/ksef/upo-pdf-generator';
import { generateDemandLetterPdf } from '@/lib/reminders/pdf-demand-letter';

/**
 * S-09: wbudowane fonty pdfkit (Helvetica) mają tylko kodowanie WinAnsi, bez
 * „ą”, „ę”, „ł”, „ś”, „ż”, „ź”, „ć”, „ń”. PDF UPO („Urzędowe Poświadczenie
 * Odbioru”) i wezwanie do zapłaty drukowały je jako złe znaki. Faktura
 * (`lib/pdf/invoice-renderer.ts`) od początku osadza Roboto z `lib/pdf/fonts/`.
 *
 * Słowniki fontów w pliku z pdfkit nie są kompresowane, więc nazwa fontu
 * (`/BaseFont`) jest czytelna w bajtach PDF.
 */

function fonty(pdf: Buffer): string[] {
  return [...pdf.toString('latin1').matchAll(/\/BaseFont \/([A-Za-z0-9+-]+)/g)].map((m) => m[1]);
}

describe('PDF z polskimi znakami (S-09)', () => {
  it('UPO: tylko osadzone fonty Roboto, bez Helvetiki', async () => {
    const pdf = await generateUpoPdf({
      ksefNumber: '1234567890-20260920-0A1B2C3D4E5F-AB',
      invoiceNumber: 'FV 1/09/2026',
      issueDate: '2026-09-20',
      sellerName: 'Żółta Łódź Sp. z o.o.',
      sellerNip: '1234567890',
      buyerName: 'Ślęża Spółka Jawna',
      buyerNip: '5260001246',
      grossAmount: 1230,
      acceptanceTimestamp: '2026-09-20T10:00:00Z',
      upoXmlHash: 'a'.repeat(64),
    });
    const uzyte = fonty(pdf);
    expect(uzyte.length).toBeGreaterThan(0);
    expect(uzyte.filter((f) => !/Roboto/.test(f))).toEqual([]);
  });

  it('wezwanie do zapłaty: tylko osadzone fonty Roboto, bez Helvetiki', async () => {
    const pdf = await generateDemandLetterPdf({
      sellerName: 'Żółta Łódź Sp. z o.o.',
      sellerNip: '1234567890',
      sellerAddress: 'ul. Źródlana 1, 00-001 Warszawa',
      buyerName: 'Ślęża Spółka Jawna',
      buyerNip: '5260001246',
      buyerAddress: 'ul. Kościuszki 2, 50-001 Wrocław',
      invoiceNumber: 'FV 1/09/2026',
      // Krok 1.4: tytuł przelewu bez numeru KSeF to sam numer faktury.
      transferTitle: 'FV 1/09/2026',
      issueDate: '2026-09-01',
      dueDate: '2026-09-15',
      grossAmount: 1230,
      paidAmount: 0,
      amountDue: 1230,
      bankAccount: 'PL61109010140000071219812874',
      daysOverdue: 30,
      senderName: 'Jan Kowalski',
      senderEmail: 'jan@example.com',
      placeOfIssue: 'Warszawa',
      letterDate: '2026-10-15',
    });
    // Numer rachunku zostaje czcionką o stałej szerokości (same cyfry, bez polskich znaków).
    const uzyte = fonty(pdf).filter((f) => f !== 'Courier-Bold');
    expect(uzyte.length).toBeGreaterThan(0);
    expect(uzyte.filter((f) => !/Roboto/.test(f))).toEqual([]);
  });
});

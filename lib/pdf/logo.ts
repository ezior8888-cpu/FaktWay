import type PDFDocument from 'pdfkit';

import type { PreparedLogo } from '@/lib/pdf/logo-obraz';

/**
 * Logo firmy w nagłówku PDF (plan kompletnej aplikacji, krok 2.2, część 1):
 * faktury wszystkich rodzajów (`invoice-renderer.ts`), proformy i oferty
 * (`lib/proformy/pdf.ts`). Odczyt logo firmy z bazy i magazynu:
 * `logo-odczyt.ts`.
 *
 * Logo stoi w lewym górnym rogu w stałej wysokości 40 pt z zachowaniem
 * proporcji (bardzo szerokie zmniejsza się do 200 pt szerokości), a nagłówek
 * dokumentu przesuwa się w dół o wysokość logo i odstęp. Kod QR (KOD I)
 * zostaje w prawym górnym rogu. Logo nie jest elementem faktury z art. 106e
 * ustawy o VAT ani częścią pliku w KSeF: zmienia się tylko wygląd wydruku,
 * a bez logo wydruk jest taki sam jak przed tym krokiem.
 */

type Doc = InstanceType<typeof PDFDocument>;

export type PdfLogo = PreparedLogo;

/** Wysokość logo na wydruku (ok. 14 mm). */
export const LOGO_PDF_HEIGHT = 40;
/** Najszersze logo na wydruku; szersze zmniejsza się z zachowaniem proporcji. */
export const LOGO_PDF_MAX_WIDTH = 200;
/** Odstęp między logo a tytułem dokumentu. */
export const LOGO_PDF_GAP = 12;

/** Wymiary logo na wydruku w punktach. */
export function logoPdfSize(logo: Pick<PreparedLogo, 'width' | 'height'>): { width: number; height: number } {
  const width = (LOGO_PDF_HEIGHT * logo.width) / logo.height;
  if (width <= LOGO_PDF_MAX_WIDTH) return { width, height: LOGO_PDF_HEIGHT };
  return { width: LOGO_PDF_MAX_WIDTH, height: (LOGO_PDF_MAX_WIDTH * logo.height) / logo.width };
}

/**
 * Rysuje logo z lewym górnym rogiem w (x, y). Zwraca, o ile nagłówek ma zejść
 * w dół: wysokość logo i odstęp, a bez logo 0 (żadnego wywołania pdfkit, więc
 * wydruk bez logo jest bajt w bajt taki jak dotąd).
 */
export function drawPdfLogo(doc: Doc, logo: PdfLogo | null | undefined, x: number, y: number): number {
  if (!logo) return 0;
  const { width, height } = logoPdfSize(logo);
  try {
    doc.image(logo.data, x, y, { width, height });
  } catch (error) {
    console.warn('[pdf-logo] nie udało się narysować logo, PDF bez logo', { reason: error instanceof Error ? error.message : 'unknown' });
    return 0;
  }
  return height + LOGO_PDF_GAP;
}

import path from 'node:path';
import type PDFDocument from 'pdfkit';

/**
 * Fonty z polskimi znakami dla PDF z pdfkit: Roboto Regular i Bold
 * z `lib/pdf/fonts/`. Wbudowane fonty pdfkit (Helvetica, Times) mają tylko
 * kodowanie WinAnsi, więc „ą”, „ę”, „ł”, „ś”, „ż”, „ź”, „ć”, „ń” wychodzą jako
 * złe znaki (S-09). Aplikacja ma te pliki w `outputFileTracingIncludes`
 * (next.config.ts), a worker cały katalog (`COPY . .` w etapie `worker`
 * Dockerfile).
 */
const FONT_DIR = path.join(process.cwd(), 'lib/pdf/fonts');

/** Rejestruje w dokumencie fonty `body` (Roboto Regular) i `bold` (Roboto Bold). */
export function registerPdfFonts(doc: InstanceType<typeof PDFDocument>): void {
  doc.registerFont('body', path.join(FONT_DIR, 'Roboto-Regular.ttf'));
  doc.registerFont('bold', path.join(FONT_DIR, 'Roboto-Bold.ttf'));
}

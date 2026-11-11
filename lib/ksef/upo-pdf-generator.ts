/** Generator PDF dla Urzędowych Poświadczeń Odbioru */

import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';

import { registerPdfFonts } from '@/lib/pdf/fonts';
import { PUBLIC_SITE_DOMAIN } from '@/lib/site';

export interface UpoPdfData {
  ksefNumber: string;
  /** Może być puste, jeśli faktura nie ma jeszcze numeru wewnętrznego. */
  invoiceNumber: string | null | undefined;
  issueDate: string;
  sellerName: string;
  sellerNip: string;
  buyerName: string;
  buyerNip: string;
  grossAmount: number;
  acceptanceTimestamp: string;
  upoId?: string;
  upoXmlHash: string;
}

type PdfKitDoc = InstanceType<typeof PDFDocument>;

export async function generateUpoPdf(data: UpoPdfData): Promise<Buffer> {
  const qrUrl = `https://ksef.mf.gov.pl/web/verify/${encodeURIComponent(data.ksefNumber)}`;
  const qrDataUrl = await QRCode.toDataURL(qrUrl, {
    errorCorrectionLevel: 'M',
    width: 200,
  });
  const qrBuffer = Buffer.from(qrDataUrl.split(',')[1], 'base64');

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 50,
      info: {
        Title: `UPO ${data.ksefNumber}`,
        Author: 'FaktWay',
        Subject: 'Urzędowe Poświadczenie Odbioru',
      },
    });

    const chunks: Buffer[] = [];
    // S-09: wbudowane fonty pdfkit nie mają polskich znaków; fonty jak na fakturze.
    registerPdfFonts(doc);
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    try {
      // ============== HEADER ==============
      doc
        .fontSize(20)
        .font('bold')
        .text('Urzędowe Poświadczenie Odbioru', { align: 'center' });

      doc
        .moveDown(0.3)
        .fontSize(12)
        .font('body')
        .fillColor('#666')
        .text('Krajowy System e-Faktur (KSeF)', { align: 'center' });

      doc.moveDown(1.5);

      // Linia separująca
      doc
        .strokeColor('#cccccc')
        .lineWidth(1)
        .moveTo(50, doc.y)
        .lineTo(545, doc.y)
        .stroke();

      doc.moveDown(1);

      // ============== NUMER KSEF (najważniejszy element) ==============
      doc.fillColor('#000');

      doc
        .fontSize(10)
        .font('body')
        .fillColor('#666')
        .text('NUMER KSEF', 50, doc.y);

      doc
        .moveDown(0.2)
        .fontSize(16)
        .font('bold')
        .fillColor('#000')
        .text(data.ksefNumber);

      doc.moveDown(1);

      const tableTop = doc.y;
      const col1X = 50;
      const col2X = 280;

      const invoiceNr =
        typeof data.invoiceNumber === 'string' && data.invoiceNumber.trim() !== ''
          ? data.invoiceNumber
          : '—';

      drawTableRow(
        doc,
        col1X,
        col2X,
        doc.y,
        'Numer faktury wystawcy:',
        invoiceNr,
      );
      drawTableRow(
        doc,
        col1X,
        col2X,
        doc.y,
        'Data wystawienia:',
        formatDate(data.issueDate),
      );

      doc.moveDown(0.5);
      drawSeparator(doc);
      doc.moveDown(0.5);

      doc
        .fontSize(10)
        .font('bold')
        .fillColor('#666')
        .text('SPRZEDAWCA', col1X, doc.y);

      doc.moveDown(0.3);
      doc.font('body').fillColor('#000');
      drawTableRow(doc, col1X, col2X, doc.y, 'Nazwa:', data.sellerName || '—');
      drawTableRow(doc, col1X, col2X, doc.y, 'NIP:', data.sellerNip || '—');

      doc.moveDown(0.5);

      doc
        .fontSize(10)
        .font('bold')
        .fillColor('#666')
        .text('NABYWCA', col1X, doc.y);

      doc.moveDown(0.3);
      doc.font('body').fillColor('#000');
      drawTableRow(doc, col1X, col2X, doc.y, 'Nazwa:', data.buyerName || '—');
      if (data.buyerNip) {
        drawTableRow(doc, col1X, col2X, doc.y, 'NIP:', data.buyerNip);
      }

      doc.moveDown(0.5);
      drawSeparator(doc);
      doc.moveDown(0.5);

      const gross = Number.isFinite(data.grossAmount) ? data.grossAmount : 0;
      drawTableRow(
        doc,
        col1X,
        col2X,
        doc.y,
        'Kwota brutto:',
        `${gross.toFixed(2)} PLN`,
      );

      doc.moveDown(1);
      drawSeparator(doc);
      doc.moveDown(0.5);

      doc
        .fontSize(10)
        .font('bold')
        .fillColor('#0a7d3f')
        .text('FAKTURA ZOSTAŁA PRZYJĘTA DO KSEF', col1X);

      doc.moveDown(0.3);
      doc.font('body').fillColor('#000').fontSize(9);

      drawTableRow(
        doc,
        col1X,
        col2X,
        doc.y,
        'Data i czas akceptacji:',
        formatTimestamp(data.acceptanceTimestamp),
      );

      if (data.upoId) {
        drawTableRow(doc, col1X, col2X, doc.y, 'ID UPO:', data.upoId);
      }

      drawTableRow(
        doc,
        col1X,
        col2X,
        doc.y,
        'Hash SHA-256:',
        truncate(data.upoXmlHash, 40),
      );

      const qrY = tableTop + 20;
      doc.image(qrBuffer, 410, qrY, { width: 130 });

      doc
        .fontSize(8)
        .fillColor('#666')
        .text('Zeskanuj kod QR aby zweryfikować', 410, qrY + 140, {
          width: 130,
          align: 'center',
        });

      doc
        .fontSize(8)
        .fillColor('#999')
        .text(
          'Dokument wygenerowany elektronicznie. Zachowaj ten plik jako dowód akceptacji faktury w KSeF.',
          50,
          760,
          { width: 495, align: 'center' },
        );

      doc
        .fontSize(7)
        .text(
          `Wygenerowano: ${new Date().toLocaleString('pl-PL')} | FaktWay, ${PUBLIC_SITE_DOMAIN} | https://ksef.mf.gov.pl`,
          50,
          775,
          { width: 495, align: 'center' },
        );

      doc.end();
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

// ============================================================================
// PDF helpers
// ============================================================================

function drawTableRow(
  doc: PdfKitDoc,
  col1X: number,
  col2X: number,
  y: number,
  label: string,
  value: string,
) {
  doc
    .fontSize(9)
    .fillColor('#666')
    .text(label, col1X, y, { width: 200 });

  doc
    .fontSize(10)
    .font('bold')
    .fillColor('#000')
    .text(value, col2X, y, { width: 150 });

  doc.font('body').moveDown(0.3);
}

function drawSeparator(doc: PdfKitDoc) {
  doc
    .strokeColor('#eeeeee')
    .lineWidth(0.5)
    .moveTo(50, doc.y)
    .lineTo(545, doc.y)
    .stroke();
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('pl-PL');
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('pl-PL', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}...`;
}

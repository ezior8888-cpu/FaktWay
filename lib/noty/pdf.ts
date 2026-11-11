import path from 'node:path';
import PDFDocument from 'pdfkit';

import { formatIsoDatePl } from '@/lib/format/iso-date';
import { formatPlMoney } from '@/lib/format/pl';
import {
  formatIbanForPrint,
  NOTE_KIND_LABELS,
  noteAmountSentence,
  type AccountingNote,
  type NoteItem,
  type NoteKind,
  type NoteParty,
} from '@/lib/noty/model';
import { NOTE_NOT_INVOICE_NOTICE } from '@/lib/noty/teksty';
import { PUBLIC_SITE_DOMAIN, PUBLIC_SITE_URL } from '@/lib/site';

/**
 * PDF noty obciążeniowej i uznaniowej (krok 2.9, część 1). Silnik i fonty
 * jak przy fakturze (`lib/pdf/invoice-renderer.ts`: pdfkit, Roboto z polskimi
 * znakami). Dokument nie nazywa się fakturą i nie ma pól VAT; adnotacja mówi,
 * że nota nie jest fakturą VAT i nie trafia do KSeF.
 *
 * Plik jest powtarzalny: data utworzenia PDF to chwila wystawienia noty, więc
 * ta sama nota daje bajt w bajt ten sam plik. Na tym stoi ponowienie maila:
 * Resend przy tym samym kluczu idempotencji porównuje treść żądania.
 */

const FONT_DIR = path.join(process.cwd(), 'lib/pdf/fonts');
const MARGIN = 42;

export interface NotePdfInput {
  kind: NoteKind;
  number: string;
  issueDate: string;
  title: string;
  items: readonly NoteItem[];
  total: number;
  issuer: NoteParty;
  counterparty: NoteParty;
  relatedDocument: string | null;
  dueDate: string | null;
  bankAccount: string | null;
  /** Chwila wystawienia (z bazy): data utworzenia pliku. */
  issuedAt: string;
}

type Doc = InstanceType<typeof PDFDocument>;

/** Dane do PDF z wystawionej noty; szkic (bez numeru, wystawcy i chwili wystawienia) to null. */
export function notePdfInput(note: AccountingNote): NotePdfInput | null {
  if (note.status !== 'issued' || !note.number || !note.issuer || !note.issuedAt) return null;
  return {
    kind: note.kind,
    number: note.number,
    issueDate: note.issueDate,
    title: note.title,
    items: note.items,
    total: note.total,
    issuer: note.issuer,
    counterparty: note.counterparty,
    relatedDocument: note.relatedDocument,
    dueDate: note.dueDate,
    bankAccount: note.bankAccount,
    issuedAt: note.issuedAt,
  };
}

/** „NO/1/2026” → „nota-NO-1-2026.pdf”. */
export function notePdfFilename(number: string): string {
  return `nota-${number.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '')}.pdf`;
}

export async function renderNotePdf(note: NotePdfInput): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: MARGIN,
      info: {
        Title: `${NOTE_KIND_LABELS[note.kind]} ${note.number}`,
        Author: note.issuer.name,
        CreationDate: new Date(note.issuedAt),
      },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    try {
      doc.registerFont('body', path.join(FONT_DIR, 'Roboto-Regular.ttf'));
      doc.registerFont('bold', path.join(FONT_DIR, 'Roboto-Bold.ttf'));
      const left = MARGIN;
      const width = doc.page.width - MARGIN * 2;

      drawHeader(doc, note, left, width);
      drawParties(doc, note, left, width);
      drawSubject(doc, note, left, width);
      drawItems(doc, note, left, width);
      drawSummary(doc, note, left, width);
      drawFooter(doc, left, width);
      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

/** Dolna granica treści: niżej jest tylko stopka strony. */
function contentBottom(doc: Doc): number {
  return doc.page.height - MARGIN - 24;
}

function ensureSpace(doc: Doc, height: number): void {
  if (doc.y + height > contentBottom(doc)) doc.addPage();
}

function drawHeader(doc: Doc, note: NotePdfInput, left: number, width: number): void {
  doc.font('bold').fontSize(20).fillColor('#111111');
  doc.text(NOTE_KIND_LABELS[note.kind], left, MARGIN, { width });
  doc.font('body').fontSize(11).fillColor('#444444');
  doc.text(`Nr ${note.number}`, left, MARGIN + 26, { width });
  doc.fontSize(9).fillColor('#666666');
  doc.text(`Data wystawienia: ${formatIsoDatePl(note.issueDate)}`, left, MARGIN + 44, { width });

  const ruleY = MARGIN + 64;
  doc.moveTo(left, ruleY).lineTo(left + width, ruleY).strokeColor('#dddddd').stroke();
  doc.y = ruleY + 14;
}

function drawParties(doc: Doc, note: NotePdfInput, left: number, width: number): void {
  const colWidth = (width - 20) / 2;
  const top = doc.y;
  const block = (x: number, heading: string, party: NoteParty) => {
    doc.font('bold').fontSize(8).fillColor('#888888');
    doc.text(heading, x, top, { width: colWidth });
    doc.font('bold').fontSize(11).fillColor('#111111');
    doc.text(party.name, x, top + 12, { width: colWidth });
    doc.font('body').fontSize(9).fillColor('#444444');
    doc.text(`NIP: ${party.nip}`, x, doc.y + 1, { width: colWidth });
    if (party.addressLine1) doc.text(party.addressLine1, x, doc.y, { width: colWidth });
    if (party.addressLine2) doc.text(party.addressLine2, x, doc.y, { width: colWidth });
    return doc.y;
  };
  const issuerBottom = block(left, 'Wystawca', note.issuer);
  const counterpartyBottom = block(left + colWidth + 20, 'Odbiorca', note.counterparty);
  doc.y = Math.max(issuerBottom, counterpartyBottom) + 18;
}

function drawSubject(doc: Doc, note: NotePdfInput, left: number, width: number): void {
  ensureSpace(doc, 40);
  doc.font('bold').fontSize(10).fillColor('#222222');
  doc.text(`Tytuł: ${note.title}`, left, doc.y, { width });
  if (note.relatedDocument) {
    doc.font('body').fontSize(9).fillColor('#444444');
    doc.text(`Dotyczy: ${note.relatedDocument}`, left, doc.y + 2, { width });
  }
  doc.y += 14;
}

/** Kolumny tabeli pozycji (części szerokości). */
const COLUMNS = [
  { label: 'Lp', share: 0.07, align: 'left' as const },
  { label: 'Opis', share: 0.7, align: 'left' as const },
  { label: 'Kwota (PLN)', share: 0.23, align: 'right' as const },
];

function drawItems(doc: Doc, note: NotePdfInput, left: number, width: number): void {
  const pad = 4;
  const minRow = 20;
  const textTop = 6;
  const xs: number[] = [];
  let acc = left;
  for (const column of COLUMNS) {
    xs.push(acc);
    acc += column.share * width;
  }
  const cellWidth = (i: number) => COLUMNS[i]!.share * width - pad * 2;

  // Wszystkie etykiety od jednej współrzędnej (jak w PDF faktury).
  const headerRow = () => {
    const top = doc.y;
    doc.rect(left, top, width, minRow).fill('#f3f3f3');
    doc.font('bold').fontSize(8).fillColor('#333333');
    COLUMNS.forEach((column, i) => {
      doc.text(column.label, xs[i]! + pad, top + textTop, { width: cellWidth(i), align: column.align, lineBreak: false });
    });
    doc.y = top + minRow;
    doc.font('body').fontSize(9).fillColor('#222222');
  };

  ensureSpace(doc, minRow * 2);
  headerRow();

  note.items.forEach((item, index) => {
    const values = [String(index + 1), item.description, formatPlMoney(item.amount)];
    const textHeight = Math.max(
      ...values.map((value, i) => doc.heightOfString(value, { width: cellWidth(i), align: COLUMNS[i]!.align })),
    );
    const rowHeight = Math.max(minRow, Math.ceil(textHeight) + textTop * 2);
    if (doc.y + rowHeight > contentBottom(doc)) {
      doc.addPage();
      headerRow();
    }
    const top = doc.y;
    if (index % 2 === 1) {
      doc.rect(left, top, width, rowHeight).fill('#fafafa');
      doc.fillColor('#222222');
    }
    values.forEach((value, i) => {
      doc.text(value, xs[i]! + pad, top + textTop, { width: cellWidth(i), align: COLUMNS[i]!.align });
    });
    doc.y = top + rowHeight;
  });

  doc.moveTo(left, doc.y).lineTo(left + width, doc.y).strokeColor('#dddddd').stroke();
  doc.y += 10;
}

function drawSummary(doc: Doc, note: NotePdfInput, left: number, width: number): void {
  ensureSpace(doc, 110);
  doc.font('bold').fontSize(11).fillColor('#111111');
  doc.text(`Razem: ${formatPlMoney(note.total)} PLN`, left, doc.y, { width, align: 'right' });
  doc.y += 12;

  doc.font('body').fontSize(10).fillColor('#222222');
  doc.text(noteAmountSentence(note.kind, note.total), left, doc.y, { width });

  if (note.kind === 'debit' && (note.dueDate || note.bankAccount)) {
    doc.y += 6;
    doc.font('body').fontSize(9).fillColor('#444444');
    if (note.dueDate) doc.text(`Termin zapłaty: ${formatIsoDatePl(note.dueDate)}`, left, doc.y, { width });
    if (note.bankAccount) doc.text(`Numer rachunku: ${formatIbanForPrint(note.bankAccount)}`, left, doc.y, { width });
  }

  doc.y += 16;
  doc.font('bold').fontSize(9).fillColor('#222222');
  doc.text(NOTE_NOT_INVOICE_NOTICE, left, doc.y, { width });
}

function drawFooter(doc: Doc, left: number, width: number): void {
  const footY = doc.page.height - MARGIN - 14;
  doc.moveTo(left, footY).lineTo(left + width, footY).strokeColor('#eeeeee').stroke();
  doc.font('body').fontSize(7).fillColor('#aaaaaa');
  doc.text(`Dokument wygenerowany w FaktWay: ${PUBLIC_SITE_DOMAIN}`, left, footY + 4, {
    width,
    align: 'center',
    link: PUBLIC_SITE_URL,
    lineBreak: false,
  });
}

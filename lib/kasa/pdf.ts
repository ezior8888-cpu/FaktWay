import path from 'node:path';
import PDFDocument from 'pdfkit';

import { formatPlMoney } from '@/lib/format/pl';
import { formatWarsawDateTime } from '@/lib/format/warsaw-date';
import {
  CASH_PARTY_LABELS,
  cashKindTitle,
  dayPl,
  formatCashMoney,
  type CashDocument,
  type CashParty,
  type CashReport,
} from '@/lib/kasa/model';
import { cashBelowZeroText } from '@/lib/kasa/teksty';
import { PUBLIC_SITE_DOMAIN, PUBLIC_SITE_URL } from '@/lib/site';

/**
 * PDF dowodu kasowego (KP, KW) i raportu kasowego (krok 3.7). Silnik i fonty
 * jak przy fakturze i nocie (pdfkit, Roboto z polskimi znakami).
 *
 * Urzędowego wzoru KP i KW nie ma, więc dowód ma elementy z § 6 ust. 3 pkt 3
 * rozporządzenia o PKPiR (Dz.U. 2025 poz. 1299): rodzaj i numer, wystawca
 * i strona operacji (nazwy, adresy), data wystawienia i data operacji,
 * przedmiot (tytuł) i wartość w złotych, kto wystawił i miejsca na podpisy.
 * Treść po polsku (§ 6 ust. 4). Korekta mówi, który dowód znosi i dlaczego.
 *
 * Plik dowodu jest powtarzalny: data utworzenia PDF to chwila wystawienia, więc
 * ten sam dowód daje bajt w bajt ten sam plik (pobranie drugi raz, archiwum).
 */

const FONT_DIR = path.join(process.cwd(), 'lib/pdf/fonts');
const MARGIN = 42;

type Doc = InstanceType<typeof PDFDocument>;

/** „KP/3/2026” → „KP-3-2026.pdf”. */
export function cashDocumentPdfFilename(number: string): string {
  return `${number.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '')}.pdf`;
}

export function cashReportPdfFilename(from: string, to: string): string {
  return `raport-kasowy-${from}-${to}.pdf`;
}

function newDocument(title: string, author: string, createdAt: string): Doc {
  // Strony w buforze: stopka trafia na każdą stronę po złożeniu treści.
  const doc = new PDFDocument({
    size: 'A4',
    margin: MARGIN,
    bufferPages: true,
    info: { Title: title, Author: author, CreationDate: new Date(createdAt) },
  });
  doc.registerFont('body', path.join(FONT_DIR, 'Roboto-Regular.ttf'));
  doc.registerFont('bold', path.join(FONT_DIR, 'Roboto-Bold.ttf'));
  return doc;
}

function render(build: () => Doc): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    let doc: Doc;
    try {
      doc = build();
    } catch (error) {
      reject(error);
      return;
    }
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

/** Dolna granica treści: niżej jest tylko stopka strony. */
function contentBottom(doc: Doc): number {
  return doc.page.height - MARGIN - 24;
}

function ensureSpace(doc: Doc, height: number): void {
  if (doc.y + height > contentBottom(doc)) doc.addPage();
}

function drawFooter(doc: Doc, left: number, width: number): void {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
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
}

function partyBlock(doc: Doc, x: number, top: number, width: number, heading: string, party: CashParty): number {
  doc.font('bold').fontSize(8).fillColor('#888888');
  doc.text(heading, x, top, { width });
  doc.font('bold').fontSize(11).fillColor('#111111');
  doc.text(party.name, x, top + 12, { width });
  doc.font('body').fontSize(9).fillColor('#444444');
  if (party.nip) doc.text(`NIP: ${party.nip}`, x, doc.y + 1, { width });
  if (party.addressLine1) doc.text(party.addressLine1, x, doc.y, { width });
  if (party.addressLine2) doc.text(party.addressLine2, x, doc.y, { width });
  return doc.y;
}

// ─── dowód KP albo KW ───────────────────────────────────────────

export async function renderCashDocumentPdf(cash: CashDocument): Promise<Buffer> {
  const isCorrection = cash.correctsId !== null || cash.amount < 0;
  const title = `${cashKindTitle(cash.kind)}${isCorrection ? ', korekta' : ''}`;
  return render(() => {
    const doc = newDocument(`${title} ${cash.number}`, cash.issuer.name, cash.issuedAt);
    const left = MARGIN;
    const width = doc.page.width - MARGIN * 2;

    // Nagłówek: rodzaj, numer i obie daty.
    doc.font('bold').fontSize(20).fillColor('#111111');
    doc.text(title, left, MARGIN, { width });
    doc.font('body').fontSize(11).fillColor('#444444');
    doc.text(`Nr ${cash.number}`, left, MARGIN + 26, { width });
    doc.fontSize(9).fillColor('#666666');
    doc.text(`Data wystawienia: ${dayPl(cash.issueDate)}`, left, MARGIN + 44, { width });
    doc.text(`Data operacji: ${dayPl(cash.operationDate)}`, left, doc.y, { width });
    const ruleY = doc.y + 8;
    doc.moveTo(left, ruleY).lineTo(left + width, ruleY).strokeColor('#dddddd').stroke();

    // Strony: wystawca (firma) i strona operacji.
    const colWidth = (width - 20) / 2;
    const top = ruleY + 14;
    const issuerBottom = partyBlock(doc, left, top, colWidth, 'Wystawca', cash.issuer);
    const partyBottom = partyBlock(doc, left + colWidth + 20, top, colWidth, CASH_PARTY_LABELS[cash.kind], cash.counterparty);
    doc.y = Math.max(issuerBottom, partyBottom) + 18;

    // Przedmiot operacji.
    ensureSpace(doc, 60);
    doc.font('bold').fontSize(10).fillColor('#222222');
    doc.text(`Tytułem: ${cash.title}`, left, doc.y, { width });
    doc.font('body').fontSize(9).fillColor('#444444');
    if (cash.invoiceNumber) doc.text(`Dotyczy faktury: ${cash.invoiceNumber}`, left, doc.y + 2, { width });
    if (cash.relatedDocument) doc.text(`Dotyczy: ${cash.relatedDocument}`, left, doc.y + 2, { width });
    if (isCorrection) {
      doc.y += 6;
      doc.font('bold').fontSize(9).fillColor('#222222');
      doc.text(
        `Korekta dowodu ${cash.correctsNumber ?? ''} z dnia operacji ${dayPl(cash.operationDate)}. Ta korekta znosi tamten dowód w całości.`,
        left,
        doc.y,
        { width },
      );
      if (cash.correctionReason) {
        doc.font('body').fontSize(9).fillColor('#444444');
        doc.text(`Przyczyna korekty: ${cash.correctionReason}`, left, doc.y + 2, { width });
      }
    }

    // Wartość w złotych.
    doc.y += 16;
    ensureSpace(doc, 120);
    doc.font('bold').fontSize(14).fillColor('#111111');
    doc.text(`Kwota: ${formatCashMoney(cash.amount)}`, left, doc.y, { width });
    doc.y += 10;
    doc.font('body').fontSize(9).fillColor('#444444');
    doc.text(`Wystawił: ${cash.issuedByName}`, left, doc.y, { width });

    // Miejsca na podpisy osób uprawnionych (§ 6 ust. 3 pkt 3 lit. d).
    const signY = doc.y + 48;
    const signWidth = (width - 40) / 2;
    const signatures = ['Podpis wystawiającego', cash.kind === 'KP' ? 'Wpłacił (podpis)' : 'Otrzymał (podpis)'];
    signatures.forEach((label, i) => {
      const x = left + i * (signWidth + 40);
      doc.moveTo(x, signY).lineTo(x + signWidth, signY).dash(2, { space: 2 }).strokeColor('#999999').stroke().undash();
      doc.font('body').fontSize(8).fillColor('#666666');
      doc.text(label, x, signY + 4, { width: signWidth, align: 'center' });
    });

    drawFooter(doc, left, width);
    return doc;
  });
}

// ─── raport kasowy ──────────────────────────────────────────────

export interface CashReportPdfInput {
  report: CashReport;
  /** Firma z ustawień (nazwa i NIP do nagłówka). */
  company: CashParty;
  /** Chwila wygenerowania (data utworzenia pliku i podpis pod nagłówkiem). */
  generatedAt: string;
}

const COLUMNS = [
  { label: 'Lp', share: 0.05, align: 'left' as const },
  { label: 'Data', share: 0.11, align: 'left' as const },
  { label: 'Numer', share: 0.13, align: 'left' as const },
  { label: 'Strona i tytuł', share: 0.33, align: 'left' as const },
  { label: 'Wpłata', share: 0.12, align: 'right' as const },
  { label: 'Wypłata', share: 0.12, align: 'right' as const },
  { label: 'Stan', share: 0.14, align: 'right' as const },
];

export async function renderCashReportPdf({ report, company, generatedAt }: CashReportPdfInput): Promise<Buffer> {
  return render(() => {
    const doc = newDocument(`Raport kasowy ${report.from} ${report.to}`, company.name, generatedAt);
    const left = MARGIN;
    const width = doc.page.width - MARGIN * 2;

    doc.font('bold').fontSize(18).fillColor('#111111');
    doc.text('Raport kasowy', left, MARGIN, { width });
    doc.font('body').fontSize(10).fillColor('#444444');
    doc.text(`Okres: od ${dayPl(report.from)} do ${dayPl(report.to)}`, left, doc.y + 2, { width });
    doc.text(company.nip ? `${company.name}, NIP: ${company.nip}` : company.name, left, doc.y, { width });
    const address = [company.addressLine1, company.addressLine2].filter(Boolean).join(', ');
    if (address) doc.text(address, left, doc.y, { width });
    doc.fontSize(8).fillColor('#888888');
    doc.text(`Wygenerowano: ${formatWarsawDateTime(generatedAt)}`, left, doc.y + 2, { width });

    doc.y += 12;
    doc.font('body').fontSize(10).fillColor('#222222');
    doc.text(`Stan na początek okresu: ${formatCashMoney(report.balanceStart)}`, left, doc.y, { width });
    doc.text(`Wpłaty (KP): ${formatCashMoney(report.receipts)}`, left, doc.y, { width });
    doc.text(`Wypłaty (KW): ${formatCashMoney(report.payouts)}`, left, doc.y, { width });
    doc.font('bold');
    doc.text(`Stan na koniec okresu: ${formatCashMoney(report.balanceEnd)}`, left, doc.y, { width });
    if (report.belowZero && report.lowest) {
      doc.y += 6;
      doc.font('bold').fontSize(9).fillColor('#b00020');
      doc.text(cashBelowZeroText(report.lowest.day, report.lowest.balance), left, doc.y, { width });
    }
    doc.y += 14;

    if (report.rows.length === 0) {
      doc.font('body').fontSize(10).fillColor('#444444');
      doc.text('W tym okresie nie ma dowodów kasowych.', left, doc.y, { width });
    } else {
      drawReportTable(doc, report, left, width);
    }

    doc.y += 14;
    ensureSpace(doc, 60);
    doc.font('body').fontSize(8).fillColor('#666666');
    doc.text('Kwoty w złotych. Stan kasy liczony na koniec dnia: w obrębie dnia najpierw wpłaty, potem wypłaty. Korekta ma kwotę ujemną i znosi dowód, który koryguje.', left, doc.y, { width });
    const signY = doc.y + 40;
    const signWidth = (width - 40) / 2;
    doc.moveTo(left, signY).lineTo(left + signWidth, signY).dash(2, { space: 2 }).strokeColor('#999999').stroke().undash();
    doc.text('Podpis sporządzającego', left, signY + 4, { width: signWidth, align: 'center' });

    drawFooter(doc, left, width);
    return doc;
  });
}

function drawReportTable(doc: Doc, report: CashReport, left: number, width: number): void {
  const pad = 3;
  const textTop = 5;
  const xs: number[] = [];
  let acc = left;
  for (const column of COLUMNS) {
    xs.push(acc);
    acc += column.share * width;
  }
  const cellWidth = (i: number) => COLUMNS[i]!.share * width - pad * 2;

  const headerRow = () => {
    const top = doc.y;
    doc.rect(left, top, width, 18).fill('#f3f3f3');
    doc.font('bold').fontSize(8).fillColor('#333333');
    COLUMNS.forEach((column, i) => {
      doc.text(column.label, xs[i]! + pad, top + textTop, { width: cellWidth(i), align: column.align, lineBreak: false });
    });
    doc.y = top + 18;
  };

  ensureSpace(doc, 40);
  headerRow();

  report.rows.forEach((row, index) => {
    const note = row.correctsNumber
      ? `Korekta dowodu ${row.correctsNumber}`
      : row.correctedByNumber
        ? `Skorygowany dowodem ${row.correctedByNumber}`
        : null;
    const subtitle = [row.title, note].filter(Boolean).join('. ');
    doc.font('body').fontSize(8);
    const nameHeight = doc.heightOfString(row.counterpartyName || ' ', { width: cellWidth(3) });
    const titleHeight = doc.heightOfString(subtitle, { width: cellWidth(3) });
    const rowHeight = Math.max(20, Math.ceil(nameHeight + titleHeight) + textTop * 2);
    if (doc.y + rowHeight > contentBottom(doc)) {
      doc.addPage();
      headerRow();
    }
    const top = doc.y;
    if (index % 2 === 1) doc.rect(left, top, width, rowHeight).fill('#fafafa');
    doc.font('body').fontSize(8).fillColor('#222222');
    const cells: Array<[number, string]> = [
      [0, String(index + 1)],
      [1, dayPl(row.operationDate)],
      [2, row.number],
      [4, row.receipt === null ? '' : formatPlMoney(row.receipt)],
      [5, row.payout === null ? '' : formatPlMoney(row.payout)],
      [6, formatPlMoney(row.balance)],
    ];
    for (const [i, value] of cells) {
      if (value) doc.text(value, xs[i]! + pad, top + textTop, { width: cellWidth(i), align: COLUMNS[i]!.align });
    }
    doc.font('bold').fontSize(8).fillColor('#222222');
    doc.text(row.counterpartyName || ' ', xs[3]! + pad, top + textTop, { width: cellWidth(3) });
    doc.font('body').fontSize(8).fillColor('#555555');
    doc.text(subtitle, xs[3]! + pad, top + textTop + nameHeight, { width: cellWidth(3) });
    doc.y = top + rowHeight;
  });

  doc.moveTo(left, doc.y).lineTo(left + width, doc.y).strokeColor('#dddddd').stroke();
  ensureSpace(doc, 24);
  const totalsY = doc.y + 6;
  doc.font('bold').fontSize(8).fillColor('#222222');
  doc.text('Razem', xs[3]! + pad, totalsY, { width: cellWidth(3), lineBreak: false });
  doc.text(formatPlMoney(report.receipts), xs[4]! + pad, totalsY, { width: cellWidth(4), align: 'right', lineBreak: false });
  doc.text(formatPlMoney(report.payouts), xs[5]! + pad, totalsY, { width: cellWidth(5), align: 'right', lineBreak: false });
  doc.text(formatPlMoney(report.balanceEnd), xs[6]! + pad, totalsY, { width: cellWidth(6), align: 'right', lineBreak: false });
  doc.y = totalsY + 14;
}

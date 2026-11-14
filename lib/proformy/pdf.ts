import path from 'node:path';
import PDFDocument from 'pdfkit';

import { formatIsoDatePl } from '@/lib/format/iso-date';
import { formatPlMoney } from '@/lib/format/pl';
import { formatIbanForPrint } from '@/lib/noty/model';
import { drawPdfLogo, type PdfLogo } from '@/lib/pdf/logo';
import {
  QUOTE_KIND_LABELS,
  QUOTE_PAYMENT_METHOD_LABELS,
  quoteVatRateLabel,
  quoteVatSummary,
  type QuoteItem,
  type QuoteKind,
  type QuoteParty,
  type QuotePaymentMethod,
  type SalesQuote,
} from '@/lib/proformy/model';
import { quoteNotInvoiceNotice } from '@/lib/proformy/teksty';
import { PUBLIC_SITE_DOMAIN, PUBLIC_SITE_URL } from '@/lib/site';

/**
 * PDF proformy i oferty (krok 2.4). Silnik i fonty jak przy fakturze
 * (`lib/pdf/invoice-renderer.ts`: pdfkit, Roboto z polskimi znakami), pozycje
 * i kwoty jak na fakturze (netto, stawka, VAT, brutto, podsumowanie stawek).
 * Dokument nie nazywa się fakturą: tytuł to „Proforma” albo „Oferta”, a słowo
 * „faktura” pada tylko w adnotacji, że dokument nie jest fakturą VAT i nie
 * trafia do KSeF (ze źródłem MF).
 *
 * Plik jest powtarzalny: data utworzenia PDF to chwila wystawienia, więc ten
 * sam dokument daje bajt w bajt ten sam plik. Na tym stoi ponowienie maila:
 * Resend przy tym samym kluczu idempotencji porównuje treść żądania.
 */

const FONT_DIR = path.join(process.cwd(), 'lib/pdf/fonts');
const MARGIN = 42;

export interface QuotePdfInput {
  kind: QuoteKind;
  number: string;
  issueDate: string;
  validUntil: string | null;
  items: readonly QuoteItem[];
  netTotal: number;
  vatTotal: number;
  grossTotal: number;
  issuer: QuoteParty;
  counterparty: QuoteParty;
  paymentMethod: QuotePaymentMethod | null;
  paymentDueDate: string | null;
  bankAccount: string | null;
  notes: string | null;
  /** Chwila wystawienia (z bazy): data utworzenia pliku. */
  issuedAt: string;
}

type Doc = InstanceType<typeof PDFDocument>;

/** Dane do PDF z wystawionego dokumentu; szkic (bez numeru, wystawcy i chwili wystawienia) to null. */
export function quotePdfInput(quote: SalesQuote): QuotePdfInput | null {
  if (quote.status !== 'issued' || !quote.number || !quote.issuer || !quote.issuedAt) return null;
  return {
    kind: quote.kind,
    number: quote.number,
    issueDate: quote.issueDate,
    validUntil: quote.validUntil,
    items: quote.items,
    netTotal: quote.netTotal,
    vatTotal: quote.vatTotal,
    grossTotal: quote.grossTotal,
    issuer: quote.issuer,
    counterparty: quote.counterparty,
    paymentMethod: quote.paymentMethod,
    paymentDueDate: quote.paymentDueDate,
    bankAccount: quote.bankAccount,
    notes: quote.notes,
    issuedAt: quote.issuedAt,
  };
}

/** „PRO/1/2026” → „proforma-PRO-1-2026.pdf”, „OF/2/2026” → „oferta-OF-2-2026.pdf”. */
export function quotePdfFilename(kind: QuoteKind, number: string): string {
  const prefix = kind === 'proforma' ? 'proforma' : 'oferta';
  return `${prefix}-${number.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '')}.pdf`;
}

/** Ilość i cena jak na PDF faktury: od 2 do 4 miejsc po przecinku. */
function decimal4(n: number): string {
  return n.toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

export interface QuotePdfOptions {
  /**
   * Logo firmy z ustawień (krok 2.2), sprawdzone przy odczycie
   * (`lib/pdf/logo-odczyt.ts`). Brak = nagłówek jak dotąd. To samo logo daje
   * ten sam plik, więc ponowienie maila z kluczem idempotencji działa dalej.
   */
  logo?: PdfLogo | null;
}

export async function renderQuotePdf(quote: QuotePdfInput, options: QuotePdfOptions = {}): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: MARGIN,
      info: {
        Title: `${QUOTE_KIND_LABELS[quote.kind]} ${quote.number}`,
        Author: quote.issuer.name,
        CreationDate: new Date(quote.issuedAt),
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

      drawHeader(doc, quote, options.logo ?? null, left, width);
      drawParties(doc, quote, left, width);
      drawItems(doc, quote, left, width);
      drawVatSummary(doc, quote, left, width);
      drawTotals(doc, quote, left, width);
      drawPayment(doc, quote, left, width);
      drawNotes(doc, quote, left, width);
      drawNotice(doc, quote, left, width);
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

function drawHeader(doc: Doc, quote: QuotePdfInput, logo: PdfLogo | null, left: number, width: number): void {
  // Logo firmy (krok 2.2) w lewym górnym rogu, nagłówek pod nim; bez logo `top` = MARGIN jak dotąd.
  const top = MARGIN + drawPdfLogo(doc, logo, left, MARGIN);
  doc.font('bold').fontSize(20).fillColor('#111111');
  doc.text(QUOTE_KIND_LABELS[quote.kind], left, top, { width });
  doc.font('body').fontSize(11).fillColor('#444444');
  doc.text(`Nr ${quote.number}`, left, top + 26, { width });
  doc.fontSize(9).fillColor('#666666');
  doc.text(`Data wystawienia: ${formatIsoDatePl(quote.issueDate)}`, left, top + 44, { width });
  let ruleY = top + 64;
  if (quote.kind === 'offer' && quote.validUntil) {
    doc.text(`Oferta ważna do: ${formatIsoDatePl(quote.validUntil)}`, left, top + 56, { width });
    ruleY = top + 76;
  }
  doc.moveTo(left, ruleY).lineTo(left + width, ruleY).strokeColor('#dddddd').stroke();
  doc.y = ruleY + 14;
}

function drawParties(doc: Doc, quote: QuotePdfInput, left: number, width: number): void {
  const colWidth = (width - 20) / 2;
  const top = doc.y;
  const block = (x: number, heading: string, party: QuoteParty) => {
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
  const issuerBottom = block(left, 'Sprzedawca', quote.issuer);
  const counterpartyBottom = block(left + colWidth + 20, 'Nabywca', quote.counterparty);
  doc.y = Math.max(issuerBottom, counterpartyBottom) + 18;
}

interface Column {
  label: string;
  share: number;
  align: 'left' | 'right';
}

/** Kolumny tabeli pozycji (części szerokości), jak na PDF faktury. */
const ITEM_COLUMNS: Column[] = [
  { label: 'Lp', share: 0.04, align: 'left' },
  { label: 'Nazwa', share: 0.25, align: 'left' },
  { label: 'Ilość', share: 0.08, align: 'right' },
  { label: 'J.m.', share: 0.06, align: 'left' },
  { label: 'Cena netto', share: 0.11, align: 'right' },
  { label: 'Wartość netto', share: 0.12, align: 'right' },
  { label: 'VAT', share: 0.06, align: 'right' },
  { label: 'Kwota VAT', share: 0.12, align: 'right' },
  { label: 'Wartość brutto', share: 0.16, align: 'right' },
];

/** Tabela z nagłówkiem powtarzanym na każdej stronie; wiersz rośnie z treścią. */
function drawTable(doc: Doc, columns: Column[], rows: string[][], left: number, width: number): void {
  const pad = 3;
  const textTop = 5;
  const minRow = 18;
  const xs: number[] = [];
  let acc = left;
  for (const column of columns) {
    xs.push(acc);
    acc += column.share * width;
  }
  const cellWidth = (i: number) => columns[i]!.share * width - pad * 2;
  const rowHeight = (values: string[]) =>
    Math.max(
      minRow,
      Math.ceil(Math.max(...values.map((value, i) => doc.heightOfString(value, { width: cellWidth(i), align: columns[i]!.align })))) +
        textTop * 2,
    );

  const headerRow = () => {
    doc.font('bold').fontSize(7.5);
    const height = rowHeight(columns.map((column) => column.label));
    const top = doc.y;
    doc.rect(left, top, width, height).fill('#f3f3f3');
    doc.fillColor('#333333');
    columns.forEach((column, i) => {
      doc.text(column.label, xs[i]! + pad, top + textTop, { width: cellWidth(i), align: column.align });
    });
    doc.y = top + height;
    doc.font('body').fontSize(8).fillColor('#222222');
  };

  ensureSpace(doc, minRow * 3);
  headerRow();

  rows.forEach((values, index) => {
    doc.font('body').fontSize(8);
    const height = rowHeight(values);
    if (doc.y + height > contentBottom(doc)) {
      doc.addPage();
      headerRow();
    }
    const top = doc.y;
    if (index % 2 === 1) {
      doc.rect(left, top, width, height).fill('#fafafa');
    }
    doc.fillColor('#222222');
    values.forEach((value, i) => {
      doc.text(value, xs[i]! + pad, top + textTop, { width: cellWidth(i), align: columns[i]!.align });
    });
    doc.y = top + height;
  });

  doc.moveTo(left, doc.y).lineTo(left + width, doc.y).strokeColor('#dddddd').stroke();
  doc.y += 10;
}

function drawItems(doc: Doc, quote: QuotePdfInput, left: number, width: number): void {
  drawTable(
    doc,
    ITEM_COLUMNS,
    quote.items.map((item, index) => [
      String(index + 1),
      item.name,
      decimal4(item.quantity),
      item.unit,
      decimal4(item.unitPriceNet),
      formatPlMoney(item.netAmount),
      quoteVatRateLabel(item.vatRate),
      formatPlMoney(item.vatAmount),
      formatPlMoney(item.grossAmount),
    ]),
    left,
    width,
  );
}

const SUMMARY_COLUMNS: Column[] = [
  { label: 'Stawka VAT', share: 0.22, align: 'left' },
  { label: 'Wartość netto', share: 0.26, align: 'right' },
  { label: 'Kwota VAT', share: 0.26, align: 'right' },
  { label: 'Wartość brutto', share: 0.26, align: 'right' },
];

/** Podsumowanie według stawek po prawej, jak na fakturze. */
function drawVatSummary(doc: Doc, quote: QuotePdfInput, left: number, width: number): void {
  const summaryWidth = width * 0.6;
  drawTable(
    doc,
    SUMMARY_COLUMNS,
    quoteVatSummary(quote.items).map((row) => [
      quoteVatRateLabel(row.rate),
      formatPlMoney(row.net),
      formatPlMoney(row.vat),
      formatPlMoney(row.gross),
    ]),
    left + width - summaryWidth,
    summaryWidth,
  );
}

function drawTotals(doc: Doc, quote: QuotePdfInput, left: number, width: number): void {
  ensureSpace(doc, 50);
  doc.font('body').fontSize(10).fillColor('#222222');
  doc.text(`Razem netto: ${formatPlMoney(quote.netTotal)} PLN`, left, doc.y, { width, align: 'right' });
  doc.text(`Razem VAT: ${formatPlMoney(quote.vatTotal)} PLN`, left, doc.y + 2, { width, align: 'right' });
  doc.font('bold').fontSize(11).fillColor('#111111');
  doc.text(`Razem brutto: ${formatPlMoney(quote.grossTotal)} PLN`, left, doc.y + 2, { width, align: 'right' });
  doc.y += 12;
}

/** Proforma: do zapłaty, sposób, termin i rachunek. Oferta nie wzywa do zapłaty. */
function drawPayment(doc: Doc, quote: QuotePdfInput, left: number, width: number): void {
  if (quote.kind !== 'proforma') return;
  ensureSpace(doc, 70);
  doc.font('bold').fontSize(11).fillColor('#111111');
  doc.text(`Do zapłaty: ${formatPlMoney(quote.grossTotal)} PLN`, left, doc.y, { width });
  doc.font('body').fontSize(9).fillColor('#444444');
  if (quote.paymentMethod) {
    doc.text(`Sposób zapłaty: ${QUOTE_PAYMENT_METHOD_LABELS[quote.paymentMethod]}`, left, doc.y + 2, { width });
  }
  if (quote.paymentDueDate) doc.text(`Termin zapłaty: ${formatIsoDatePl(quote.paymentDueDate)}`, left, doc.y, { width });
  if (quote.bankAccount) doc.text(`Numer rachunku: ${formatIbanForPrint(quote.bankAccount)}`, left, doc.y, { width });
  doc.y += 12;
}

function drawNotes(doc: Doc, quote: QuotePdfInput, left: number, width: number): void {
  if (!quote.notes) return;
  ensureSpace(doc, 40);
  doc.font('body').fontSize(9).fillColor('#444444');
  doc.text(`Uwagi: ${quote.notes}`, left, doc.y, { width });
  doc.y += 12;
}

function drawNotice(doc: Doc, quote: QuotePdfInput, left: number, width: number): void {
  ensureSpace(doc, 40);
  doc.font('bold').fontSize(9).fillColor('#222222');
  doc.text(quoteNotInvoiceNotice(quote.kind), left, doc.y, { width });
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

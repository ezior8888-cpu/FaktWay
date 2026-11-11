import path from 'node:path';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';

import type { Invoice, InvoiceLineItem, VatRate } from '@/types/invoice';
import { MARK } from '@/lib/brand/faktway-logo-paths';
import {
  CASH_METHOD_LABEL,
  hasReverseChargeLine,
  REVERSE_CHARGE_LABEL,
  SPLIT_PAYMENT_LABEL,
} from '@/lib/invoices/annotations';
import { tytulPrzelewuNaDokumencie } from '@/lib/invoices/tytul-przelewu';
import { RECEIPT_INVOICE_LABEL, receiptDetailsLine } from '@/lib/invoices/receipt-invoice';
import { PUBLIC_SITE_DOMAIN, PUBLIC_SITE_URL } from '@/lib/site';
import { roundToCents } from '@/lib/xml/invoice-calculator';

/**
 * Renderer PDF faktury FA(3) (Faza 33 Krok 1-2).
 *
 * Silnik: `pdfkit` (w deps od Fazy 9; stack niezmienny — nie wprowadzamy
 * react-pdf). Czysta funkcja: `Invoice` → `Buffer`. Mapowanie z DB do
 * `Invoice` robi warstwa wyżej (Krok 4).
 *
 * Fonty: Roboto Regular + Bold z `lib/pdf/fonts/` — standardowe fonty
 * pdfkit (Helvetica/Times) nie mają polskich znaków. Vercel: ścieżki
 * fontów muszą być w `outputFileTracingIncludes` (next.config.ts).
 */

const FONT_DIR = path.join(process.cwd(), 'lib/pdf/fonts');
const PAGE_MARGIN = 42;

export interface RenderInvoiceOptions {
  /**
   * Numer KSeF: drukowany w stopce, gdy faktura zaakceptowana; poprawny
   * numer trafia też do tytułu przelewu w sekcji płatności (krok 1.4).
   */
  ksefNumber?: string | null;
  /**
   * Link KOD I do zakodowania w QR (`lib/ksef/qr-verification.ts`) — nie sam
   * numer KSeF. Brak = bez QR.
   */
  qrPayload?: string | null;
  /** Napis pod kodem QR: numer KSeF albo „OFFLINE” (specyfikacja MF). */
  qrLabel?: string | null;
  /** Nadrukuj watermark „WERSJA TESTOWA" (środowisko KSeF test). */
  testWatermark?: boolean;
  /**
   * Dopisek pod nagłówkiem, gdy faktura ma numer KSeF, a brak skrótu XML do
   * KODU I (B14): wydruk jest podglądem, nie wizualizacją dla nabywcy.
   */
  previewNotice?: string | null;
  /** Faktura korygowana — tylko dla korekt (`lib/pdf/invoice-data.ts`). */
  correctedInvoice?: CorrectedInvoiceRef | null;
  /**
   * Faktura do paragonu bez czytelnych danych paragonu (FP z importu KSeF):
   * samo oznaczenie. FP z danymi niesie `invoice.receipt`.
   */
  receiptInvoiceMarker?: boolean;
}

/**
 * Oznaczenie faktury do paragonu (krok 1.2) i dane paragonu z art. 106h ust. 1
 * ustawy o VAT (numer dokumentu, numer unikatowy kasy) z datą paragonu.
 * W XML to `Fa/FP` = 1 i `Fa/DodatkowyOpis`; nabywca spoza KSeF ma tylko PDF.
 */
export function receiptInvoiceLines(invoice: Invoice, marker = false): string[] {
  if (invoice.receipt) return [RECEIPT_INVOICE_LABEL, receiptDetailsLine(invoice.receipt, fmtDate)];
  return marker ? [RECEIPT_INVOICE_LABEL] : [];
}

/** Dane faktury, której dotyczy korekta (w XML: `DaneFaKorygowanej`). */
export interface CorrectedInvoiceRef {
  number: string;
  issueDate: string;
  ksefNumber: string | null;
  reason: string | null;
}

/**
 * Wiersze „której faktury dotyczy korekta” — art. 106j ust. 2 ustawy o VAT
 * (numer i data faktury korygowanej, w KSeF jej numer KSeF). XML ma to
 * w `DaneFaKorygowanej`; do 01.10.2026 PDF korekty miał sam tytuł.
 */
export function correctedInvoiceLines(ref: CorrectedInvoiceRef | null | undefined): string[] {
  if (!ref) return [];
  const lines = [`Korekta faktury nr ${ref.number} z dnia ${fmtDate(ref.issueDate)}`];
  if (ref.ksefNumber) lines.push(`Numer KSeF faktury korygowanej: ${ref.ksefNumber}`);
  if (ref.reason) lines.push(`Przyczyna korekty: ${ref.reason}`);
  return lines;
}

const INVOICE_TYPE_LABEL: Record<string, string> = {
  VAT: 'Faktura VAT',
  KOR: 'Faktura korygująca',
  ZAL: 'Faktura zaliczkowa',
  ROZ: 'Faktura rozliczeniowa',
  UPR: 'Faktura uproszczona',
  KOR_ZAL: 'Korekta faktury zaliczkowej',
  KOR_ROZ: 'Korekta faktury rozliczeniowej',
};

const PAYMENT_METHOD_LABEL: Record<string, string> = {
  transfer: 'Przelew',
  cash: 'Gotówka',
  card: 'Karta',
  mobile: 'Płatność mobilna',
  other: 'Inna',
};

const VAT_RATE_LABEL: Record<VatRate, string> = {
  '23': '23%',
  '8': '8%',
  '5': '5%',
  '0': '0%',
  zw: 'zw.',
  oo: 'o.o.',
  np: 'np.',
  // AUD-70: usługa z art. 100 ust. 1 pkt 4 (FA(3) „np II”) — odróżniona od „np” (np I).
  np_ii: 'np. II',
};

/**
 * Etykieta stawki. Faktury z importu historii KSeF mają surowe kody FA(3)
 * („0 KR”, „np I”, „0 WDT”), których mapa nie zna — drukujemy sam kod
 * zamiast pustej komórki i „undefined” w podsumowaniu (F-067).
 */
function vatRateLabel(rate: string): string {
  return VAT_RATE_LABEL[rate as VatRate] ?? rate;
}

/** Format kwoty w konwencji PL: `1 234,56`. */
function money(n: number): string {
  return n.toLocaleString('pl-PL', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Ilość i cena jednostkowa: do 4 miejsc, jak w bazie (NUMERIC(14,4)) i w XML
 * (P_8B, P_9A) — inaczej cena 100,1234 drukowała się jako 100,12 obok
 * wartości 150,19 (F-069). Co najmniej 2 miejsca, jak przy kwotach.
 */
function decimal4(n: number): string {
  return n.toLocaleString('pl-PL', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
}

function fmtDate(iso: string): string {
  return iso; // już ISO YYYY-MM-DD — czytelne i jednoznaczne
}

/**
 * Renderuje fakturę do bufora PDF. Asynchroniczna z powodu QR (qrcode)
 * i strumieniowego API pdfkit.
 */
export async function renderInvoicePdf(
  invoice: Invoice,
  opts: RenderInvoiceOptions = {},
): Promise<Buffer> {
  // QR generujemy PRZED otwarciem dokumentu — `doc.image` jest synchroniczne.
  let qrBuffer: Buffer | null = null;
  if (opts.qrPayload) {
    qrBuffer = await QRCode.toBuffer(opts.qrPayload, {
      type: 'png',
      margin: 0,
      width: 110,
    });
  }

  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: PAGE_MARGIN });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.registerFont('body', path.join(FONT_DIR, 'Roboto-Regular.ttf'));
    doc.registerFont('bold', path.join(FONT_DIR, 'Roboto-Bold.ttf'));

    const pageWidth =
      doc.page.width - PAGE_MARGIN * 2;
    const left = PAGE_MARGIN;

    // Napis rysuje się tylko razem z kodem (warunek w `drawHeader`).
    drawHeader(doc, invoice, qrBuffer, opts.qrLabel ?? null, left, pageWidth);
    drawPreviewNotice(doc, opts.previewNotice, left, pageWidth);
    drawCorrectedInvoice(doc, opts.correctedInvoice, left, pageWidth);
    drawReceiptInvoice(doc, receiptInvoiceLines(invoice, opts.receiptInvoiceMarker === true), left, pageWidth);
    drawParties(doc, invoice, left, pageWidth);
    drawLineItems(doc, invoice, left, pageWidth);
    drawVatSummary(doc, invoice, left, pageWidth);
    drawPayment(doc, invoice, transferTitleOnPdf(invoice, opts.ksefNumber), left, pageWidth);
    drawFooter(doc, invoice, opts, left, pageWidth);

    if (opts.testWatermark) {
      drawWatermark(doc);
    }

    doc.end();
  });
}

type Doc = InstanceType<typeof PDFDocument>;

/**
 * Podstawa zwolnienia z VAT na fakturze z pozycją „zw” — obowiązkowy element
 * faktury (art. 106e ust. 1 pkt 19 ustawy o VAT). W XML to P_19A; PDF to
 * kopia, którą nabywca spoza KSeF dostaje mailem.
 */
export function exemptionBasisLine(invoice: Invoice): string | null {
  if (!invoice.lines.some((l) => l.vatRate === 'zw')) return null;
  const basis = invoice.annotations?.vatExemptionBasis?.trim();
  return basis ? `Zwolnienie z VAT — podstawa prawna: ${basis}` : null;
}

/**
 * Kwota „Do zapłaty” na PDF. Faktura rozliczająca (ROZ) ma w `grossTotal`
 * pełną wartość zamówienia — do zapłaty jest reszta po zaliczkach
 * (`payment.amountDue`, liczona przy wystawieniu; w XML to P_15). Do 28.09
 * PDF pokazywał nabywcy pełną kwotę, jakby zaliczek nie było.
 */
export function amountDueOnPdf(invoice: Invoice): number {
  if (invoice.type === 'ROZ') {
    const due = Number(invoice.payment?.amountDue);
    if (Number.isFinite(due) && due >= 0 && due <= invoice.grossTotal + 0.005) return due;
  }
  return invoice.grossTotal;
}

/**
 * Tytuł przelewu w sekcji płatności (krok 1.4, RP-PLAT-01): numer KSeF, potem
 * numer faktury; przy MPP sam numer KSeF. Tylko przy przelewie, z kwotą „Do
 * zapłaty” i poprawnym numerem KSeF; inaczej `null` i sekcja jak dotąd. Mail
 * z fakturą bierze ten sam tytuł (`emailInvoiceAction`), więc mail i PDF
 * w załączniku się zgadzają.
 */
export function transferTitleOnPdf(invoice: Invoice, ksefNumber: string | null | undefined): string | null {
  return tytulPrzelewuNaDokumencie(invoice.internalNumber, ksefNumber, {
    metoda: invoice.payment?.method,
    doZaplaty: amountDueOnPdf(invoice),
    mpp: invoice.annotations?.splitPayment === 1,
  });
}

/**
 * Dopisek na ROZ: skąd różnica między wartością zamówienia a „Do zapłaty”.
 * Na innych fakturach `amountDueOnPdf` = brutto, więc dopisku nie ma.
 */
export function settledAdvancesLine(invoice: Invoice): string | null {
  const advances = roundToCents(invoice.grossTotal - amountDueOnPdf(invoice));
  if (advances <= 0) return null;
  return `Wartość zamówienia ${money(invoice.grossTotal)} PLN, rozliczone zaliczki ${money(advances)} PLN`;
}

function drawHeader(
  doc: Doc,
  invoice: Invoice,
  qr: Buffer | null,
  qrCaption: string | null,
  left: number,
  width: number,
): void {
  const title = INVOICE_TYPE_LABEL[invoice.type] ?? 'Faktura';
  doc.font('bold').fontSize(20).fillColor('#111111');
  doc.text(title, left, PAGE_MARGIN);
  doc.font('body').fontSize(11).fillColor('#444444');
  doc.text(`Nr ${invoice.internalNumber}`, left, PAGE_MARGIN + 26);

  doc.fontSize(9).fillColor('#666666');
  doc.text(
    `Data wystawienia: ${fmtDate(invoice.issueDate)}`,
    left,
    PAGE_MARGIN + 44,
  );
  if (invoice.saleDate && invoice.saleDate !== invoice.issueDate) {
    doc.text(
      `Data sprzedaży: ${fmtDate(invoice.saleDate)}`,
      left,
      PAGE_MARGIN + 56,
    );
  }

  // KOD I w prawym górnym rogu, pod nim numer KSeF albo „OFFLINE”.
  const QR_SIZE = 72;
  if (qr) {
    doc.image(qr, left + width - QR_SIZE, PAGE_MARGIN, { width: QR_SIZE });
    if (qrCaption) {
      doc.font('body').fontSize(6.5).fillColor('#444444');
      doc.text(qrCaption, left + width - 200, PAGE_MARGIN + QR_SIZE + 3, { width: 200, align: 'right' });
    }
  }

  const ruleY = PAGE_MARGIN + (qr ? QR_SIZE + 16 : 78);
  doc
    .moveTo(left, ruleY)
    .lineTo(left + width, ruleY)
    .strokeColor('#dddddd')
    .stroke();
  doc.y = ruleY + 14;
}

function drawPreviewNotice(
  doc: Doc,
  notice: string | null | undefined,
  left: number,
  width: number,
): void {
  if (!notice?.trim()) return;
  doc.font('bold').fontSize(9).fillColor('#b00020');
  doc.text(notice.trim(), left, doc.y, { width });
  doc.fillColor('#222222');
  doc.y += 10;
}

function drawCorrectedInvoice(
  doc: Doc,
  ref: CorrectedInvoiceRef | null | undefined,
  left: number,
  width: number,
): void {
  const lines = correctedInvoiceLines(ref);
  if (lines.length === 0) return;
  doc.font('bold').fontSize(9).fillColor('#222222');
  doc.text(lines[0]!, left, doc.y, { width });
  doc.font('body').fontSize(8.5).fillColor('#444444');
  for (const line of lines.slice(1)) {
    doc.text(line, left, doc.y + 2, { width });
  }
  doc.y += 12;
}

/** Blok „Faktura do paragonu” pod nagłówkiem, jak blok faktury korygowanej. */
function drawReceiptInvoice(doc: Doc, lines: string[], left: number, width: number): void {
  if (lines.length === 0) return;
  doc.font('bold').fontSize(10).fillColor('#111111');
  doc.text(lines[0]!, left, doc.y, { width });
  doc.font('body').fontSize(8.5).fillColor('#444444');
  for (const line of lines.slice(1)) {
    doc.text(line, left, doc.y + 2, { width });
  }
  doc.fillColor('#222222');
  doc.y += 12;
}

function drawParties(
  doc: Doc,
  invoice: Invoice,
  left: number,
  width: number,
): void {
  const colWidth = (width - 20) / 2;
  const top = doc.y;

  const block = (
    x: number,
    heading: string,
    name: string,
    taxId: string | null,
    addr1: string,
    addr2: string,
    taxIdLabel = 'NIP',
  ) => {
    doc.font('bold').fontSize(8).fillColor('#888888');
    doc.text(heading.toUpperCase(), x, top, { width: colWidth });
    doc.font('bold').fontSize(11).fillColor('#111111');
    doc.text(name, x, top + 12, { width: colWidth });
    doc.font('body').fontSize(9).fillColor('#444444');
    let y = doc.y + 1;
    if (taxId) {
      doc.text(`${taxIdLabel}: ${taxId}`, x, y, { width: colWidth });
      y = doc.y;
    }
    doc.text(addr1, x, y, { width: colWidth });
    doc.text(addr2, x, doc.y, { width: colWidth });
  };

  block(
    left,
    'Sprzedawca',
    invoice.seller.name,
    invoice.seller.nip,
    invoice.seller.address.addressLine1,
    invoice.seller.address.addressLine2,
  );
  const sellerBottom = doc.y;

  // Nabywca z UE ma numer VAT UE, nie NIP (F-069).
  const buyerVatUe = !invoice.buyer.nip && invoice.buyer.vatUeNumber ? invoice.buyer.vatUeNumber : null;
  block(
    left + colWidth + 20,
    'Nabywca',
    invoice.buyer.name,
    invoice.buyer.nip ?? buyerVatUe,
    invoice.buyer.address.addressLine1,
    invoice.buyer.address.addressLine2,
    buyerVatUe ? 'VAT UE' : 'NIP',
  );

  doc.y = Math.max(sellerBottom, doc.y) + 18;
}

// Kolumny tabeli pozycji — proporcje sumują się do 1.
const COLS = [
  { key: 'lp', label: 'Lp', w: 0.05, align: 'left' as const },
  { key: 'name', label: 'Nazwa towaru / usługi', w: 0.34, align: 'left' as const },
  { key: 'qty', label: 'Ilość', w: 0.09, align: 'right' as const },
  { key: 'unit', label: 'j.m.', w: 0.07, align: 'left' as const },
  { key: 'price', label: 'Cena netto', w: 0.12, align: 'right' as const },
  { key: 'net', label: 'Wartość netto', w: 0.12, align: 'right' as const },
  { key: 'vat', label: 'VAT', w: 0.07, align: 'right' as const },
  { key: 'gross', label: 'Brutto', w: 0.14, align: 'right' as const },
];

/** Dolna granica treści — poniżej jest tylko stopka strony. */
function contentBottom(doc: Doc): number {
  return doc.page.height - PAGE_MARGIN - 24;
}

/** Nowa strona, gdy blok o wysokości `height` nie zmieści się na bieżącej. */
function ensureSpace(doc: Doc, height: number): void {
  if (doc.y + height > contentBottom(doc)) {
    doc.addPage();
  }
}

function drawLineItems(
  doc: Doc,
  invoice: Invoice,
  left: number,
  width: number,
): void {
  const cellPad = 4;
  const minRowHeight = 20;
  const textTop = 6;

  const colX: number[] = [];
  let acc = left;
  for (const c of COLS) {
    colX.push(acc);
    acc += c.w * width;
  }
  const cellWidth = (i: number) => COLS[i]!.w * width - cellPad * 2;

  // Nagłówek tabeli. Wszystkie etykiety od jednej współrzędnej — `doc.text`
  // przesuwa `doc.y`, więc liczenie od `doc.y` w pętli schodkowało kolumny.
  const drawHeaderRow = (): void => {
    const top = doc.y;
    doc.rect(left, top, width, minRowHeight).fill('#f3f3f3');
    doc.font('bold').fontSize(8).fillColor('#333333');
    COLS.forEach((c, i) => {
      doc.text(c.label, colX[i]! + cellPad, top + textTop, {
        width: cellWidth(i),
        align: c.align,
        lineBreak: false,
      });
    });
    doc.y = top + minRowHeight;
    doc.font('body').fontSize(8).fillColor('#222222');
  };

  ensureSpace(doc, minRowHeight * 2);
  drawHeaderRow();

  // Wiersze pozycji. Wysokość wiersza z najwyższej komórki (długa nazwa się
  // zawija), a wiersz, który się nie mieści, idzie na nową stronę razem
  // z powtórzonym nagłówkiem — bez tego pdfkit dokładał stronę na komórkę.
  invoice.lines.forEach((line: InvoiceLineItem, idx: number) => {
    const values: Record<string, string> = {
      lp: String(line.ordinal),
      name: line.name,
      qty: decimal4(line.quantity),
      unit: line.unit,
      price: decimal4(line.unitPriceNet),
      net: money(line.netAmount),
      vat: vatRateLabel(line.vatRate),
      gross: money(line.grossAmount),
    };
    const textHeight = Math.max(
      ...COLS.map((c, i) =>
        doc.heightOfString(values[c.key] ?? '', { width: cellWidth(i), align: c.align }),
      ),
    );
    const rowHeight = Math.max(minRowHeight, Math.ceil(textHeight) + textTop * 2);

    if (doc.y + rowHeight > contentBottom(doc)) {
      doc.addPage();
      drawHeaderRow();
    }

    const rowTop = doc.y;
    // Zebra dla czytelności.
    if (idx % 2 === 1) {
      doc.rect(left, rowTop, width, rowHeight).fill('#fafafa');
      doc.fillColor('#222222');
    }
    COLS.forEach((c, i) => {
      doc.text(values[c.key] ?? '', colX[i]! + cellPad, rowTop + textTop, {
        width: cellWidth(i),
        align: c.align,
      });
    });
    doc.y = rowTop + rowHeight;
  });

  doc
    .moveTo(left, doc.y)
    .lineTo(left + width, doc.y)
    .strokeColor('#dddddd')
    .stroke();
  doc.y += 14;
}

function drawVatSummary(
  doc: Doc,
  invoice: Invoice,
  left: number,
  width: number,
): void {
  // Grupowanie pozycji po stawce VAT.
  const byRate = new Map<
    VatRate,
    { net: number; vat: number; gross: number }
  >();
  for (const line of invoice.lines) {
    const cur = byRate.get(line.vatRate) ?? { net: 0, vat: 0, gross: 0 };
    cur.net += line.netAmount;
    cur.vat += line.vatAmount;
    cur.gross += line.grossAmount;
    byRate.set(line.vatRate, cur);
  }

  const boxW = 250;
  const boxX = left + width - boxW;
  // Nagłówek + stawki + zaliczki + „Do zapłaty” — całość na jednej stronie.
  ensureSpace(doc, 13 + byRate.size * 12 + 16 + 22);
  let y = doc.y;

  doc.font('bold').fontSize(8).fillColor('#888888');
  // ROZ: pozycje i to podsumowanie pokazują całe zamówienie (tak każe FA(3)
  // dla FaWiersz); podatek po odjęciu zaliczek jest w XML (P_13_x/P_14_x).
  doc.text(invoice.type === 'ROZ' ? 'PODSUMOWANIE VAT ZAMÓWIENIA' : 'PODSUMOWANIE VAT', boxX, y);
  y += 13;

  doc.font('body').fontSize(8).fillColor('#333333');
  for (const [rate, sums] of byRate) {
    doc.text(
      `${vatRateLabel(rate)}  netto ${money(sums.net)}  VAT ${money(sums.vat)}`,
      boxX,
      y,
      { width: boxW, align: 'right' },
    );
    y += 12;
  }

  y += 4;
  const advancesLine = settledAdvancesLine(invoice);
  if (advancesLine) {
    doc.text(advancesLine, boxX, y, { width: boxW, align: 'right' });
    y += 12;
  }
  doc.font('bold').fontSize(11).fillColor('#111111');
  doc.text(`Do zapłaty: ${money(amountDueOnPdf(invoice))} PLN`, boxX, y, {
    width: boxW,
    align: 'right',
  });
  doc.y = y + 22;
}

function drawPayment(
  doc: Doc,
  invoice: Invoice,
  transferTitle: string | null,
  left: number,
  width: number,
): void {
  const p = invoice.payment;
  // Wiersz z tytułem przelewu to jeszcze jedna linia w tym samym bloku.
  ensureSpace(doc, transferTitle ? 62 : 50);
  doc.font('bold').fontSize(8).fillColor('#888888');
  doc.text('PŁATNOŚĆ', left, doc.y);
  doc.font('body').fontSize(9).fillColor('#444444');
  doc.text(
    `Sposób: ${PAYMENT_METHOD_LABEL[p.method] ?? p.method}   ·   Termin: ${fmtDate(p.dueDate)}`,
    left,
    doc.y + 2,
    { width },
  );
  if (p.bankAccount) {
    doc.text(
      `Nr rachunku: ${p.bankAccount}${p.bankName ? `  (${p.bankName})` : ''}`,
      left,
      doc.y,
      { width },
    );
  }
  if (transferTitle) {
    doc.text(`Tytuł przelewu: ${transferTitle}`, left, doc.y, { width });
  }
  doc.y += 14;
}

function drawFooter(
  doc: Doc,
  invoice: Invoice,
  opts: RenderInvoiceOptions,
  left: number,
  width: number,
): void {
  // Adnotacje, uwagi i numer KSeF nie mogą wejść na stopkę strony.
  ensureSpace(doc, 70);
  // Art. 106e ust. 1 pkt 16 — obowiązkowe wyrazy przy metodzie kasowej.
  if (invoice.annotations?.cashMethod === 1) {
    doc.font('bold').fontSize(9).fillColor('#222222');
    doc.text(CASH_METHOD_LABEL, left, doc.y, { width });
    doc.y += 4;
  }
  // Art. 106e ust. 1 pkt 18 — podatek rozlicza nabywca. Jak w XML (P_18=1):
  // każda pozycja „oo” albo „np_ii” (usługa z art. 100 ust. 1 pkt 4 dla firmy
  // z UE, AUD-70). W kolumnie stawki jest tylko skrót, a nabywca spoza KSeF
  // (np. zagraniczny) dostaje wyłącznie ten PDF.
  if (hasReverseChargeLine(invoice.lines)) {
    doc.font('bold').fontSize(9).fillColor('#222222');
    doc.text(REVERSE_CHARGE_LABEL, left, doc.y, { width });
    doc.y += 4;
  }
  // Art. 106e ust. 1 pkt 18a — obowiązkowe wyrazy przy MPP.
  if (invoice.annotations?.splitPayment === 1) {
    doc.font('bold').fontSize(9).fillColor('#222222');
    doc.text(SPLIT_PAYMENT_LABEL, left, doc.y, { width });
    doc.y += 4;
  }
  const exemption = exemptionBasisLine(invoice);
  if (exemption) {
    doc.font('body').fontSize(8).fillColor('#444444');
    doc.text(exemption, left, doc.y, { width });
    doc.y += 4;
  }
  if (invoice.notes) {
    doc.font('body').fontSize(8).fillColor('#666666');
    doc.text(`Uwagi: ${invoice.notes}`, left, doc.y, { width });
    doc.y += 4;
  }
  if (opts.ksefNumber) {
    doc.font('body').fontSize(8).fillColor('#888888');
    doc.text(`Numer KSeF: ${opts.ksefNumber}`, left, doc.y, { width });
  }

  // Linia + stopka u dołu strony.
  const footY = doc.page.height - PAGE_MARGIN - 14;
  doc
    .moveTo(left, footY)
    .lineTo(left + width, footY)
    .strokeColor('#eeeeee')
    .stroke();
  const footer = `Wygenerowano w FaktWay, faktury KSeF dla mikrofirm: ${PUBLIC_SITE_DOMAIN}`;
  doc.font('body').fontSize(7);
  // Znak FaktWay tylko w stopce: nagłówek faktury należy do sprzedawcy.
  drawFaktWayMark(doc, left + (width - doc.widthOfString(footer)) / 2 - 9, footY + 4.6, 5.4);
  doc.font('body').fontSize(7).fillColor('#aaaaaa');
  doc.text(footer, left, footY + 4, { width, align: 'center', link: PUBLIC_SITE_URL });
}

/** Znak FaktWay (wektor) o wysokości `h` z lewym górnym rogiem w (x, y). */
function drawFaktWayMark(doc: Doc, x: number, y: number, h: number): void {
  const [, , , markHeight] = MARK.viewBox.split(' ').map(Number);
  doc.save();
  doc.translate(x, y).scale(h / markHeight!);
  doc.path(MARK.brand).fill('#2463EF');
  doc.restore();
}

/** Półprzezroczysty napis po przekątnej — dla środowiska testowego KSeF. */
function drawWatermark(doc: Doc): void {
  doc.save();
  doc.rotate(-45, { origin: [doc.page.width / 2, doc.page.height / 2] });
  doc
    .font('bold')
    .fontSize(64)
    .fillColor('#ff0000')
    .opacity(0.12)
    .text('WERSJA TESTOWA', 0, doc.page.height / 2 - 40, {
      width: doc.page.width,
      align: 'center',
    });
  doc.opacity(1).restore();
}

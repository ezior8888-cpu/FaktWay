// lib/exports/kpir-generator.ts
// Generator KPiR Excel zgodny z rozporządzeniem MF (17 kolumn)

import ExcelJS from 'exceljs';
import { kpirCostAmount, nonDeductedVat } from '@/lib/categorization/kpir-cost';
import { earlierSaleRemark, kpirRevenueNet, kpirSaleEventDate } from '@/lib/categorization/kpir-revenue';
import { assertOutgoingInvoicesInPln } from '@/lib/exports/currency-guard';

import type { ExportExpense } from './data-fetcher';
import type { JpkInvoice } from './jpk-fa-generator';
import { roundToCents } from '@/lib/xml/invoice-calculator';

export interface KpirInputData {
  issuer: { nip: string; name: string };
  periodStart: string;
  periodEnd: string;
  /** Faktury wystawione (przychód) */
  issuedInvoices: JpkInvoice[];
  /**
   * Koszty z `expenses` (`is_deductible`) — to samo źródło co KPiR
   * w aplikacji. Do 26.09 koszty szły z faktur otrzymanych: bez paragonów,
   * wszystko w kol. 13, z NASZĄ firmą jako kontrahentem.
   */
  expenses: ExportExpense[];
}

/**
 * Kolumna kosztu w KPiR (rozporządzenie MF, 17 kolumn) z kategorii kosztu.
 *
 * W aplikacji `col_15` nazywa się „Koszty B+R”, a we wzorze urzędowym B+R to
 * kolumna 16 (15 jest wolna) — przenosimy po ZNACZENIU, nie po numerze.
 * Koszt bez kategorii aplikacja pomija w sumach, ale księgowa musi go
 * zobaczyć: trafia do 13 z uwagą. Kolumna przychodu (7/8) na dokumencie
 * kosztowym → `null`: wiersz widoczny, bez kwot (w aplikacji też się nie liczy).
 */
export function kpirCostColumn(kpirColumn: string | null): 10 | 11 | 12 | 13 | 16 | null {
  switch (kpirColumn) {
    case 'col_10':
      return 10;
    case 'col_11':
      return 11;
    case 'col_12':
      return 12;
    case 'col_13':
    case null:
      return 13;
    case 'col_15':
    case 'col_16':
      return 16;
    default:
      return null;
  }
}

// ============================================================================
// MAIN: generuje plik XLSX
// ============================================================================

export async function generateKpirXlsx(data: KpirInputData): Promise<Buffer> {
  assertOutgoingInvoicesInPln(data.issuedInvoices);
  const workbook = new ExcelJS.Workbook();

  workbook.creator = 'FaktWay';
  workbook.created = new Date();
  workbook.modified = new Date();

  buildInfoSheet(workbook, data);
  buildKpirSheet(workbook, data);

  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

// ============================================================================
// ARKUSZ: Informacje
// ============================================================================

function buildInfoSheet(workbook: ExcelJS.Workbook, data: KpirInputData): void {
  const sheet = workbook.addWorksheet('Informacje', {
    properties: { defaultColWidth: 25 },
  });

  sheet.getCell('A1').value = 'Książka Przychodów i Rozchodów';
  sheet.getCell('A1').font = { size: 16, bold: true };
  sheet.mergeCells('A1:E1');

  sheet.getCell('A3').value = 'Podatnik:';
  sheet.getCell('B3').value = data.issuer.name;
  sheet.getCell('A4').value = 'NIP:';
  sheet.getCell('B4').value = data.issuer.nip;
  sheet.getCell('A5').value = 'Okres:';
  sheet.getCell('B5').value = `${formatPlDate(data.periodStart)} — ${formatPlDate(data.periodEnd)}`;

  const total = data.issuedInvoices.length + data.expenses.length;
  sheet.getCell('A7').value = 'Liczba operacji:';
  sheet.getCell('B7').value = total;

  sheet.getCell('A8').value = 'Przychody (faktury wystawione):';
  sheet.getCell('B8').value = data.issuedInvoices.length;
  sheet.getCell('A9').value = 'Wydatki (uznane za koszt):';
  sheet.getCell('B9').value = data.expenses.length;

  sheet.getCell('A11').value =
    'Koszty pochodzą z listy wydatków (faktury kosztowe i paragony) — w kolumnach wg kategorii, tak jak KPiR w aplikacji.';
}

// ============================================================================
// ARKUSZ: KPiR (17 kolumn)
// ============================================================================

type KpirEntry =
  | { kind: 'sale'; date: string; invoice: JpkInvoice }
  | { kind: 'cost'; date: string; expense: ExportExpense };

const SUM_COLS = [7, 9, 10, 11, 12, 13, 14, 16] as const;
const AMOUNT_COLS = [7, 8, 9, 10, 11, 12, 13, 14, 15, 16];

function buildKpirSheet(workbook: ExcelJS.Workbook, data: KpirInputData): void {
  const sheet = workbook.addWorksheet('KPiR', {
    views: [{ state: 'frozen', xSplit: 0, ySplit: 1 }],
  });

  // Układ wzoru MF: 15 — kolumna wolna, 16 — koszty B+R, 17 — uwagi.
  // Numer KSeF faktury sprzedaży idzie do uwag (wzór nie ma na niego kolumny).
  const headers = [
    'L.p.',                                        // 1
    'Data zdarzenia',                              // 2
    'Numer dowodu',                                // 3
    'Kontrahent',                                  // 4
    'Adres kontrahenta',                           // 5
    'Opis zdarzenia',                              // 6
    'Wartość sprzedanych towarów i usług (7)',     // 7
    'Pozostałe przychody (8)',                     // 8
    'Razem przychód (9)',                          // 9
    'Zakup towarów handlowych i materiałów (10)',  // 10
    'Koszty uboczne zakupu (11)',                  // 11
    'Wynagrodzenia (12)',                          // 12
    'Pozostałe wydatki (13)',                      // 13
    'Razem wydatki 12+13 (14)',                    // 14
    '(15)',                                        // 15
    'Koszty działalności B+R (16)',                // 16
    'Uwagi (17)',                                  // 17
  ];

  const headerRow = sheet.addRow(headers);
  headerRow.font = { bold: true, size: 10 };
  headerRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFE0E0E0' },
  };
  headerRow.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  headerRow.height = 40;
  applyBorderToRow(headerRow, 'thin');

  const widths = [5, 12, 18, 35, 35, 30, 16, 16, 16, 16, 16, 16, 16, 16, 10, 16, 30];
  widths.forEach((w, i) => { sheet.getColumn(i + 1).width = w; });

  const entries: KpirEntry[] = [
    // Kol. 2 — data zdarzenia gospodarczego: dla sprzedaży dzień sprzedaży (P_6).
    ...data.issuedInvoices.map((invoice) => ({ kind: 'sale' as const, date: kpirSaleEventDate(invoice), invoice })),
    ...data.expenses.map((expense) => ({ kind: 'cost' as const, date: expense.issueDate, expense })),
  ].sort((a, b) => a.date.localeCompare(b.date));

  const sums = new Map<number, number>(SUM_COLS.map((c) => [c, 0]));
  const add = (col: number, value: number) => sums.set(col, (sums.get(col) ?? 0) + value);
  let lp = 1;

  for (const entry of entries) {
    // Indeks tablicy = numer kolumny − 1.
    const cells: Array<string | number | null> = new Array<string | number | null>(17).fill(null);
    cells[0] = lp;
    cells[1] = formatPlDate(entry.date);

    if (entry.kind === 'sale') {
      const inv = entry.invoice;
      // ROZ: tylko reszta ponad zaliczki, które są już w KPiR (ta sama reguła
      // co KPiR w aplikacji — `kpirRevenueNet`).
      const net = kpirRevenueNet({
        kind: inv.invoiceType,
        net: inv.netTotal,
        settledAdvancesNet: inv.settledAdvancesNet,
      });
      cells[2] = inv.invoiceNumber;
      cells[3] = inv.buyerName;
      cells[4] = inv.buyerAddress ?? '';
      cells[5] = describeInvoice(inv);
      cells[6] = net; // 7
      cells[8] = net; // 9
      add(7, net);
      add(9, net);
      cells[16] = [
        earlierSaleRemark(inv, data.periodStart) ?? '',
        inv.invoiceType === 'correction' ? `Korekta do ${inv.correctedInvoiceNumber ?? '—'}` : '',
        inv.invoiceType === 'final'
          ? `ROZ: wartość zamówienia ${inv.netTotal.toFixed(2)} zł, rozliczone zaliczki ${(inv.settledAdvancesNet ?? 0).toFixed(2)} zł — w przychodzie reszta`
          : '',
        inv.ksefNumber ? `KSeF: ${inv.ksefNumber}` : '',
      ].filter(Boolean).join('; ');
    } else {
      const exp = entry.expense;
      // Koszt jak w KPiR w aplikacji (#65): netto + VAT bez prawa do odliczenia
      // (paragon, firma zwolniona, samochód 50%) — ta sama funkcja, żeby plik
      // dla księgowej i ekran klienta się nie rozjechały.
      const costInput = {
        net_amount: exp.netAmount,
        vat_amount: exp.vatAmount,
        vat_deductible_amount: exp.vatDeductibleAmount,
        document_type: exp.documentType,
      };
      const net = kpirCostAmount(costInput);
      const vatInCost = nonDeductedVat(costInput);
      const col = kpirCostColumn(exp.kpirColumn);
      cells[2] = exp.documentNumber;
      // Kontrahent kosztu to SPRZEDAWCA — dawniej trafiała tu nasza firma.
      cells[3] = exp.sellerNip ? `${exp.sellerName} (NIP ${exp.sellerNip})` : exp.sellerName;
      cells[4] = exp.sellerAddress ?? '';
      cells[5] = exp.categoryLabel ?? 'Wydatek';

      const uwagi: string[] = [];
      if (exp.documentType === 'receipt') uwagi.push('paragon');
      if (vatInCost !== 0) uwagi.push(`w tym VAT bez odliczenia ${vatInCost.toFixed(2)} zł`);
      if (exp.kpirColumn === null) uwagi.push('bez kategorii — sprawdź');
      if (col === null) {
        uwagi.push(`oznaczony kolumną przychodu (${exp.kpirColumn}) — nie liczony, sprawdź kategorię`);
      } else {
        cells[col - 1] = net;
        add(col, net);
        if (col === 12 || col === 13) {
          cells[13] = net; // 14 = 12 + 13
          add(14, net);
        }
      }
      cells[16] = uwagi.join('; ');
    }

    const dataRow = sheet.addRow(cells);

    AMOUNT_COLS.forEach((col) => {
      const cell = dataRow.getCell(col);
      if (cell.value !== null) {
        cell.numFmt = '#,##0.00 "zł"';
      }
    });

    applyBorderToRow(dataRow, 'hair', 'FFCCCCCC');
    lp++;
  }

  const total = (col: number) => roundToCents(sums.get(col) ?? 0);
  const summaryRow = sheet.addRow([
    null, null, null, null, null,
    'PODSUMOWANIE OKRESU',
    total(7),    // 7
    null,        // 8
    total(9),    // 9
    total(10),   // 10
    total(11),   // 11
    total(12),   // 12
    total(13),   // 13
    total(14),   // 14
    null,        // 15
    total(16),   // 16
    null,        // 17
  ]);

  summaryRow.font = { bold: true };
  summaryRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFFFF0E0' },
  };

  SUM_COLS.forEach((col) => {
    summaryRow.getCell(col).numFmt = '#,##0.00 "zł"';
  });

  applyBorderToRow(summaryRow, 'thin');
}

// ============================================================================
// HELPERS
// ============================================================================

function applyBorderToRow(
  row: ExcelJS.Row,
  style: ExcelJS.BorderStyle,
  argb = 'FF000000',
): void {
  const border: Partial<ExcelJS.Border> = { style, color: { argb } };
  row.eachCell({ includeEmpty: true }, (cell) => {
    cell.border = { top: border, bottom: border, left: border, right: border };
  });
}

function formatPlDate(iso: string): string {
  if (!iso) return '';
  const day = iso.trim().slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return iso;
  return `${m[3]}.${m[2]}.${m[1]}`;
}

function describeInvoice(inv: JpkInvoice): string {
  switch (inv.invoiceType) {
    case 'correction':
      return 'Korekta faktury';
    case 'advance':
      return 'Faktura zaliczkowa';
    case 'final':
      return 'Faktura rozliczająca';
    default: {
      const first = inv.lines[0];
      if (first?.name) {
        return first.name.length > 40
          ? first.name.slice(0, 37) + '...'
          : first.name;
      }
      return 'Faktura VAT';
    }
  }
}

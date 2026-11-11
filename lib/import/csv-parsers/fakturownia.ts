/**
 * Eksport CSV Fakturowni (średnik, nagłówki PL).
 * Oczekiwane kolumny m.in.: Numer;Data wystawienia;Sprzedawca;NIP sprzedawcy;…;Pozycje (JSON).
 */

import Papa from 'papaparse';
import type { ParsedInvoice, ParsedLine } from '../fa3-parser';
import { parseAmount, parseDate, cleanNip } from './csv-helpers';
import type { CsvParseResult } from './types';
import { roundToCents } from '@/lib/xml/invoice-calculator';

interface FakturowniaRow extends Record<string, string | undefined> {
  Numer?: string;
  'Data wystawienia'?: string;
  Sprzedawca?: string;
  'NIP sprzedawcy'?: string;
  Nabywca?: string;
  'NIP nabywcy'?: string;
  'Adres nabywcy'?: string;
  Netto?: string;
  VAT?: string;
  Brutto?: string;
  'Stawka VAT'?: string;
  'Termin płatności'?: string;
  Pozycje?: string;
}

export function parseFakturowniaCsv(content: string): CsvParseResult {
  const warnings: string[] = [];
  const invoices: ParsedInvoice[] = [];

  const result = Papa.parse<FakturowniaRow>(content, {
    header: true,
    delimiter: ';',
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });

  for (const err of result.errors) {
    if (err.row !== undefined) {
      warnings.push(`CSV wiersz ${err.row}: ${err.message}`);
    } else if (err.message) {
      warnings.push(`CSV: ${err.message}`);
    }
  }

  for (let i = 0; i < result.data.length; i++) {
    const row = result.data[i];
    const recordNo = i + 1;
    if (!row || typeof row !== 'object') continue;

    const label = row.Numer?.trim() ? row.Numer : `#${recordNo}`;

    try {
      const invoice = parseFakturowniaRow(row, recordNo, warnings);
      if (invoice) invoices.push(invoice);
    } catch (e) {
      warnings.push(
        `Pominięto ${label}: ${e instanceof Error ? e.message : 'unknown'}`,
      );
    }
  }

  return { invoices, warnings, detectedFormat: 'fakturownia' };
}

function parseFakturowniaRow(
  row: FakturowniaRow,
  /** 1-based numer rekordu danych (bez wiersza nagłówka). */
  recordNo: number,
  globalWarnings: string[],
): ParsedInvoice | null {
  const warnings: string[] = [];
  const numer = row.Numer?.trim();
  const dataWystawienia = row['Data wystawienia']?.trim();

  if (!numer || !dataWystawienia) {
    if (numer || dataWystawienia || hasMeaningfulValues(row)) {
      globalWarnings.push(
        `Rekord ${recordNo}: brakuje Numer lub Data wystawienia — pominięto`,
      );
    }
    return null;
  }

  const pozycjeRaw = pickPozycjeCell(row);

  let lines: ParsedLine[] = [];
  if (pozycjeRaw?.trim()) {
    lines = linesFromPositionsJson(pozycjeRaw.trim(), warnings);
  }

  const netTotal = parseAmount(row.Netto, { warnings, fieldLabel: 'Fakturownia: kwota netto' });
  const vatTotal = parseAmount(row.VAT, { warnings, fieldLabel: 'Fakturownia: kwota VAT' });
  const grossTotal = parseAmount(row.Brutto, { warnings, fieldLabel: 'Fakturownia: kwota brutto' });
  const defaultVat = normalizeCsvVat(row['Stawka VAT']);

  if (lines.length === 0) {
    lines = [
      {
        position: 1,
        name: 'Pozycja zbiorcza (z importu)',
        unit: 'szt.',
        quantity: 1,
        unitPriceNet: netTotal,
        vatRate: defaultVat,
        netAmount: netTotal,
      },
    ];
  }

  const issueDate = parseDate(dataWystawienia, {
    warnings,
    fieldLabel: `Faktura ${numer}: data wystawienia`,
  });

  const paymentDueRaw = row['Termin płatności']?.trim();
  let paymentDueDate: string | undefined;
  if (paymentDueRaw) {
    paymentDueDate = parseDate(paymentDueRaw, {
      warnings,
      fieldLabel: `Faktura ${numer}: termin płatności`,
    });
  }

  const sellerNip = row['NIP sprzedawcy']
    ? cleanNip(row['NIP sprzedawcy'])
    : undefined;
  const buyerNip = row['NIP nabywcy'] ? cleanNip(row['NIP nabywcy']) : undefined;

  reconcileTotals(lines, netTotal, vatTotal, grossTotal, warnings);

  return {
    invoiceNumber: numer,
    issueDate,
    invoiceType: 'regular',
    seller: {
      name: String(row.Sprzedawca ?? '').trim() || 'Nieznany',
      nip: sellerNip,
    },
    buyer: {
      name: String(row.Nabywca ?? '').trim() || 'Nieznany',
      nip: buyerNip,
      addressLine1: row['Adres nabywcy']?.trim()
        ? String(row['Adres nabywcy']).trim()
        : undefined,
    },
    lines,
    totals: {
      netTotal,
      vatTotal,
      grossTotal,
    },
    paymentDueDate,
    warnings,
  };
}

/** Użytkownik mógł dostać CSV z nazwą kolumny „Pozycje (JSON)” itd. */
function pickPozycjeCell(row: FakturowniaRow): string | undefined {
  return (
    row.Pozycje ??
    row['Pozycje (JSON)'] ??
    row['Pozycje JSON'] ??
    row['Linie pozycji']
  );
}

function hasMeaningfulValues(row: FakturowniaRow): boolean {
  return Object.values(row).some(
    (v) => v !== undefined && v !== null && String(v).trim() !== '',
  );
}

function linesFromPositionsJson(
  raw: string,
  invoiceWarnings: string[],
): ParsedLine[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    invoiceWarnings.push('Pozycje: nieprawidłowy JSON — użyto pozycji zbiorczej');
    return [];
  }

  if (!Array.isArray(parsed)) {
    invoiceWarnings.push('Pozycje: oczekiwano tablicy JSON — użyto pozycji zbiorczej');
    return [];
  }

  const lines: ParsedLine[] = [];
  let fallbackPos = 0;

  for (const item of parsed) {
    fallbackPos++;
    if (!item || typeof item !== 'object') continue;

    const p = item as Record<string, unknown>;
    const name = pickStr(p.nazwa, p.name);
    const unit = pickStr(p.jm, p.unit) || 'szt.';
    const quantity = parseNumLike(p.ilosc, p.quantity) || 1;
    const unitPriceNet =
      parseNumLike(p.cena_netto, p.unit_price, p.price_net) || 0;
    let netAmount = parseNumLike(
      p.wartosc_netto,
      p.net_amount,
      p.netto,
      p.amount_net,
    );

    if (!netAmount) {
      netAmount = roundToCents(quantity * unitPriceNet);
    }

    const vatRaw = pickStr(p.vat, p.vat_rate, p.stawka, p.tax_rate);

    lines.push({
      position: parseNumLike(p.nr, p.lp, p.position) || fallbackPos,
      name,
      unit,
      quantity,
      unitPriceNet,
      vatRate: vatRaw ? normalizeCsvVat(vatRaw) : '23',
      netAmount,
    });
  }

  return lines;
}

function parseNumLike(...vals: unknown[]): number {
  for (const v of vals) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    // Ilość i cena z pozycji: kropka to część dziesiętna (S-10).
    const n = parseAmount(String(v), { kropkaTysiecy: false });
    if (n !== 0 || String(v).trim() === '0') return n;
  }
  return 0;
}

function pickStr(...vals: unknown[]): string {
  for (const v of vals) {
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return '';
}

function normalizeCsvVat(raw: string | undefined): string {
  let s = String(raw ?? '23').replace('%', '').trim();
  const lower = s.toLowerCase();

  if (lower === '0.23' || lower === '23.00') s = '23';
  else if (lower === '0.08' || lower === '8.00') s = '8';
  else if (lower === '0.05' || lower === '5.00') s = '5';

  return s || '23';
}

function reconcileTotals(
  lines: ParsedLine[],
  headerNet: number,
  headerVat: number,
  headerGross: number,
  warnings: string[],
): void {
  const sumNet =
    roundToCents(lines.reduce((a, l) => a + l.netAmount, 0));

  if (headerNet > 0 && Math.abs(sumNet - headerNet) > 0.02) {
    warnings.push(
      `Suma netto z pozycji (${sumNet.toFixed(2)}) ≠ kolumna Netto (${headerNet.toFixed(2)})`,
    );
  }

  if (headerNet > 0 && headerVat >= 0 && headerGross > 0) {
    const calcGross = roundToCents(headerNet + headerVat);
    if (Math.abs(calcGross - headerGross) > 0.02) {
      warnings.push(
        `Niezgodność: Netto+VAT (${calcGross.toFixed(2)}) ≠ Brutto (${headerGross.toFixed(2)})`,
      );
    }
  }
}

export { parseAmount, parseDate, cleanNip } from './csv-helpers';

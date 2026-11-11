/**
 * Eksport CSV iFirma — typowe nagłówki PL, separator średnik.
 * Przykład: Lp.;Numer dokumentu;Data;Nabywca;NIP nabywcy;Wartość netto;VAT;Wartość brutto
 */

import Papa from 'papaparse';
import type { ParsedInvoice } from '../fa3-parser';
import { parseAmount, parseDate, cleanNip } from './csv-helpers';
import { warnTotalsConsistency } from './csv-reconcile';
import type { CsvParseResult } from './types';

type IfirmaRow = Record<string, string | undefined>;

function cell(row: IfirmaRow, keys: readonly string[]): string | undefined {
  for (const k of keys) {
    const v = row[k];
    if (v !== undefined && v !== null && String(v).trim() !== '')
      return String(v).trim();
  }
  return undefined;
}

export function parseIfirmaCsv(content: string): CsvParseResult {
  const warnings: string[] = [];
  const invoices: ParsedInvoice[] = [];

  const result = Papa.parse<IfirmaRow>(content, {
    header: true,
    delimiter: ';',
    skipEmptyLines: true,
    transformHeader: (h) => h.trim().replace(/^\uFEFF/, ''),
  });

  for (const err of result.errors) {
    if (err.message) warnings.push(`CSV${err.row != null ? ` wiersz ${err.row}` : ''}: ${err.message}`);
  }

  let recordNo = 0;
  for (const row of result.data) {
    recordNo++;
    if (!row || typeof row !== 'object') continue;

    const invoiceNumber = cell(row, ['Numer dokumentu', 'Numer faktury', 'Nr dokumentu']);

    if (!invoiceNumber) {
      const hasCells = Object.values(row).some(
        (v) => v !== undefined && v !== null && String(v).trim() !== '',
      );
      if (hasCells) {
        warnings.push(`Rekord iFirma ${recordNo}: brak Numer dokumentu — pominięto`);
      }
      continue;
    }

    const invWarnings: string[] = [];

    const issueDate = parseDate(cell(row, ['Data', 'Data wystawienia', 'Data dokumentu']), {
      warnings: invWarnings,
      fieldLabel: `iFirma ${invoiceNumber}: data`,
    });

    const netTotal = parseAmount(cell(row, ['Wartość netto', 'Kwota netto', 'Netto', 'Suma netto']), { warnings: invWarnings, fieldLabel: 'iFirma: kwota netto' });
    const vatTotal = parseAmount(cell(row, ['VAT', 'Kwota VAT', 'Suma VAT', 'Razem VAT']), { warnings: invWarnings, fieldLabel: 'iFirma: kwota VAT' });
    const grossTotal = parseAmount(cell(row, ['Wartość brutto', 'Kwota brutto', 'Brutto', 'Suma brutto']), { warnings: invWarnings, fieldLabel: 'iFirma: kwota brutto' });

    const vatRate = warnTotalsConsistency(
      netTotal,
      vatTotal,
      grossTotal,
      invWarnings,
      invoiceNumber,
    );

    const nabywca = cell(row, ['Nabywca', 'Kontrahent', 'Nazwa nabywcy']);
    const nipRaw = cell(row, ['NIP nabywcy', 'NIP', 'Nabywcy NIP']);
    const adres = cell(row, ['Adres', 'Adres nabywcy']);

    const terminPlatnosci = cell(row, ['Termin płatności', 'Termin zapłaty']);

    invoices.push({
      invoiceNumber,
      issueDate,
      invoiceType: 'regular',
      seller: {
        name:
          cell(row, ['Sprzedawca', 'Wystawca']) ??
          'Wystawca (CSV iFirma bez danych sprzedawcy w tym eksporcie)',
      },
      buyer: {
        name: nabywca ?? 'Nieznany',
        nip: nipRaw ? cleanNip(nipRaw) : undefined,
        addressLine1: adres,
      },
      lines: [
        {
          position: 1,
          name: 'Pozycja zbiorcza (import iFirma)',
          unit: 'szt.',
          quantity: 1,
          unitPriceNet: netTotal,
          vatRate: vatRate ?? '23',
          netAmount: netTotal,
        },
      ],
      totals: {
        netTotal,
        vatTotal,
        grossTotal,
      },
      paymentDueDate: terminPlatnosci
        ? parseDate(terminPlatnosci, {
            warnings: invWarnings,
            fieldLabel: `iFirma ${invoiceNumber}: termin płatności`,
          })
        : undefined,
      warnings: invWarnings,
    });
  }

  return { invoices, warnings, detectedFormat: 'ifirma' };
}

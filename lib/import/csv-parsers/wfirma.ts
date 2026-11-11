/**
 * Eksport CSV wFirma — typowe nagłówki PL, separator średnik.
 * Przykład: Numer faktury;Data wystawienia;Kontrahent;NIP;Razem netto;Razem VAT;Razem brutto
 */

import Papa from 'papaparse';
import type { ParsedInvoice } from '../fa3-parser';
import { parseAmount, parseDate, cleanNip } from './csv-helpers';
import { warnTotalsConsistency } from './csv-reconcile';
import type { CsvParseResult } from './types';

type WfirmaRow = Record<string, string | undefined>;

function cell(
  row: WfirmaRow,
  keys: readonly string[],
): string | undefined {
  for (const k of keys) {
    const v = row[k];
    if (v !== undefined && v !== null && String(v).trim() !== '')
      return String(v).trim();
  }
  return undefined;
}

export function parseWfirmaCsv(content: string): CsvParseResult {
  const warnings: string[] = [];
  const invoices: ParsedInvoice[] = [];

  const result = Papa.parse<WfirmaRow>(content, {
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

    const invoiceNumber = cell(row, [
      'Numer faktury',
      'Nr faktury',
      'Numer dokumentu',
      'NumerFV',
      'Numer',
    ]);

    if (!invoiceNumber) {
      const hasCells = Object.values(row).some(
        (v) => v !== undefined && v !== null && String(v).trim() !== '',
      );
      if (hasCells) {
        warnings.push(`Rekord wFirma ${recordNo}: brak numeru faktury — pominięto`);
      }
      continue;
    }

    const invWarnings: string[] = [];

    const issueRaw = cell(row, [
      'Data wystawienia',
      'Data sprzedaży',
      'Data',
      'Data dokumentu',
    ]);

    const issueDate = parseDate(issueRaw, {
      warnings: invWarnings,
      fieldLabel: `wFirma ${invoiceNumber}: data`,
    });

    const netTotal = parseAmount(cell(row, ['Razem netto', 'Suma netto', 'Netto', 'Kwota netto']), { warnings: invWarnings, fieldLabel: 'wFirma: kwota netto' });
    const vatTotal = parseAmount(cell(row, ['Razem VAT', 'Suma VAT', 'VAT', 'Podatek VAT']), { warnings: invWarnings, fieldLabel: 'wFirma: kwota VAT' });
    const grossTotal = parseAmount(cell(row, ['Razem brutto', 'Suma brutto', 'Brutto', 'Kwota brutto']), { warnings: invWarnings, fieldLabel: 'wFirma: kwota brutto' });

    const vatRate = warnTotalsConsistency(
      netTotal,
      vatTotal,
      grossTotal,
      invWarnings,
      invoiceNumber,
    );

    const kontrahent = cell(row, ['Kontrahent', 'Klient', 'Nabywca', 'Kontrahent - nazwa']);
    const nipRaw = cell(row, ['NIP', 'NIP nabywcy', 'Nabywcy NIP']);
    const ulica = cell(row, ['Ulica', 'Adres']);
    const miasto = cell(row, ['Miasto', 'Miejscowość']);

    const address =
      [ulica, miasto].filter(Boolean).join(', ').trim() ||
      cell(row, ['Adres kontrahenta', 'Pełny adres']);

    const payRaw = cell(row, ['Termin płatności', 'Termin']);

    invoices.push({
      invoiceNumber,
      issueDate,
      invoiceType: 'regular',
      seller: {
        name:
          cell(row, ['Sprzedawca', 'Firma']) ??
          'Wystawca (CSV wFirma bez danych sprzedawcy w tym eksportcie)',
      },
      buyer: {
        name: kontrahent ?? 'Nieznany',
        nip: nipRaw ? cleanNip(nipRaw) : undefined,
        addressLine1: address || undefined,
      },
      lines: [
        {
          position: 1,
          name: 'Pozycja zbiorcza (import wFirma)',
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
      paymentDueDate: payRaw
        ? parseDate(payRaw, {
            warnings: invWarnings,
            fieldLabel: `wFirma ${invoiceNumber}: termin płatności`,
          })
        : undefined,
      warnings: invWarnings,
    });
  }

  return { invoices, warnings, detectedFormat: 'wfirma' };
}

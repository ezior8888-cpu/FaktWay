/**
 * Eksport CSV inFakt (nagłówki typowo po angielsku, separator przecinek).
 */

import Papa from 'papaparse';
import type { ParsedInvoice } from '../fa3-parser';
import { parseAmount, parseDate, cleanNip } from './csv-helpers';
import { warnTotalsConsistency } from './csv-reconcile';
import type { CsvParseResult } from './types';

interface InfaktRow extends Record<string, string | undefined> {
  invoice_number?: string;
  issue_date?: string;
  client_name?: string;
  client_tax_id?: string;
  client_street?: string;
  client_city?: string;
  net_total?: string;
  vat_total?: string;
  gross_total?: string;
  payment_due_date?: string;
  status?: string;
}

export function parseInfaktCsv(content: string): CsvParseResult {
  const warnings: string[] = [];
  const invoices: ParsedInvoice[] = [];

  const result = Papa.parse<InfaktRow>(content, {
    header: true,
    delimiter: ',',
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

    const invoiceNumber =
      row.invoice_number?.trim() ??
      row['Invoice number']?.trim() ??
      row.Numer?.trim();

    if (!invoiceNumber) {
      const hasCells = Object.values(row).some(
        (v) => v !== undefined && v !== null && String(v).trim() !== '',
      );
      if (hasCells) {
        warnings.push(`Rekord inFakt ${recordNo}: brak invoice_number — pominięto`);
      }
      continue;
    }

    const invWarnings: string[] = [];

    const issueDate = parseDate(
      row.issue_date?.trim() ?? row['Issue date']?.trim() ?? row['Data']?.trim(),
      {
        warnings: invWarnings,
        fieldLabel: `inFakt ${invoiceNumber}: data wystawienia`,
      },
    );

    const netTotal = parseAmount(row.net_total ?? row['Net total'], { warnings: invWarnings, fieldLabel: 'inFakt: kwota netto' });
    const vatTotal = parseAmount(row.vat_total ?? row['VAT total'], { warnings: invWarnings, fieldLabel: 'inFakt: kwota VAT' });
    const grossTotal = parseAmount(row.gross_total ?? row['Gross total'], { warnings: invWarnings, fieldLabel: 'inFakt: kwota brutto' });

    const vatRate = warnTotalsConsistency(
      netTotal,
      vatTotal,
      grossTotal,
      invWarnings,
      invoiceNumber,
    );

    const payRaw =
      row.payment_due_date?.trim() ??
      row['Payment due date']?.trim() ??
      row['Due date']?.trim();

    const paymentDueDate = payRaw
      ? parseDate(payRaw, {
          warnings: invWarnings,
          fieldLabel: `inFakt ${invoiceNumber}: termin płatności`,
        })
      : undefined;

    const clientName =
      row.client_name?.trim() ??
      row['Client name']?.trim() ??
      row['Customer']?.trim() ??
      '';

    const taxRaw =
      row.client_tax_id?.trim() ??
      row['Client tax ID']?.trim() ??
      row.NIP?.trim();

    const addrStreetCity = [row.client_street?.trim(), row.client_city?.trim()]
      .filter(Boolean)
      .join(', ')
      .trim();

    invoices.push({
      invoiceNumber,
      issueDate,
      invoiceType: 'regular',
      seller: {
        name:
          row.seller_name?.trim() ??
          'Wystawca (CSV inFakt zwykle bez danych sprzedawcy)',
      },
      buyer: {
        name: clientName || 'Nieznany',
        nip: taxRaw ? cleanNip(taxRaw) : undefined,
        addressLine1: addrStreetCity || row['Client address']?.trim(),
      },
      lines: [
        {
          position: 1,
          name: 'Pozycja zbiorcza (import inFakt)',
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
      paymentDueDate,
      warnings: invWarnings,
    });
  }

  return { invoices, warnings, detectedFormat: 'infakt' };
}

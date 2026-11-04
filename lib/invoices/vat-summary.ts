import { roundToCents } from '@/lib/xml/invoice-calculator';

/**
 * Podsumowanie VAT per stawka dla podglądu faktury (P4, PLAN-FINORA §5).
 *
 * Czysta funkcja z kwot pozycji (`invoice_line_items.net_amount`,
 * `vat_amount`, `gross_amount`): grupuje po stawce w kolejności pierwszego
 * wystąpienia i sumuje — tak jak `drawVatSummary` w
 * `lib/pdf/invoice-renderer.ts` (PDF i ekran pokazują te same grupy). Sumy
 * zaokrąglamy do groszy, żeby 0,1 + 0,2 nie dało 0,30000000000000004.
 *
 * KOREKTY. Nagłówek korekty (`net_total`, `vat_total`, `gross_total`) to
 * RÓŻNICA (00200), a pozycje korekty zachowują zapisane kwoty — ujemne
 * zostają ujemne, nie bierzemy wartości bezwzględnej. Przy korekcie
 * `before_after` pozycje to stan PO, więc ich suma nie zgadza się z różnicą
 * z nagłówka: `vatSummaryAgreesWithGross` pozwala wtedy nie pokazywać
 * wierszy stawek zamiast złych liczb.
 *
 * Plik nie importuje niczego poza `roundToCents`, więc nadaje się i na
 * serwer, i do komponentu klienckiego.
 */

export interface VatSummaryLine {
  vat_rate: string | null;
  net_amount?: string | number | null;
  vat_amount?: string | number | null;
  gross_amount?: string | number | null;
}

export interface VatSummaryRow {
  /** Kod stawki jak w `invoice_line_items.vat_rate` ('23', '8', 'zw', 'np_ii'…). */
  rate: string;
  net: number;
  vat: number;
  gross: number;
}

/** Tolerancja zgodności z nagłówkiem: zaokrąglenia per stawka vs per pozycja. */
const GROSS_TOLERANCE = 0.05;

function toAmount(value: string | number | null | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Wiersze podsumowania albo `null`, gdy którakolwiek pozycja nie ma stawki
 * lub którejś z kwot (stare rekordy) — nie zgadujemy brakujących liczb.
 * Brak pozycji → pusta lista.
 */
export function vatSummaryByRate(lines: readonly VatSummaryLine[]): VatSummaryRow[] | null {
  const byRate = new Map<string, VatSummaryRow>();
  for (const line of lines) {
    const rate = line.vat_rate?.trim();
    const net = toAmount(line.net_amount);
    const vat = toAmount(line.vat_amount);
    const gross = toAmount(line.gross_amount);
    if (!rate || net === null || vat === null || gross === null) return null;
    const current = byRate.get(rate) ?? { rate, net: 0, vat: 0, gross: 0 };
    current.net += net;
    current.vat += vat;
    current.gross += gross;
    byRate.set(rate, current);
  }
  return [...byRate.values()].map((row) => ({
    rate: row.rate,
    net: roundToCents(row.net),
    vat: roundToCents(row.vat),
    gross: roundToCents(row.gross),
  }));
}

/** Czy suma brutto stawek zgadza się z `gross_total` faktury (do kilku groszy). */
export function vatSummaryAgreesWithGross(
  rows: readonly VatSummaryRow[],
  grossTotal: string | number | null | undefined,
): boolean {
  const gross = toAmount(grossTotal);
  if (gross === null) return false;
  const sum = rows.reduce((acc, row) => acc + row.gross, 0);
  return Math.abs(roundToCents(sum) - gross) <= GROSS_TOLERANCE;
}

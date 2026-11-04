/**
 * A4b (00137): dane zdarzenia wysyłki dokumentu specjalnego zapisywane na
 * wierszu faktury (`invoices.special_data`) w tym samym INSERT co wiersz.
 *
 * - KOR: `{ correctionData }` — dokładnie koperta, którą „Zapisz i wyślij”
 *   wkłada do zlecenia (po doklejeniu adnotacji faktury pierwotnej);
 * - ROZ: `{ finalData, finalAdvanceSettlementRows }` — wynik
 *   `resolveFinalPayload`; dziś tylko szkice (wysyłka ROZ wstrzymana do C4);
 * - ZAL nie ma kopii tutaj: jej koperta to `fa3_data.advanceEnvelope`.
 *
 * Baza pilnuje kształtu (CHECK `invoices_special_data_shape`) i zapisu
 * jednorazowego (`guard_invoice_special_data`); worker porównuje kopię ze
 * zdarzeniem (`lib/ksef/submit-reference-boundary.ts`).
 */

import type { AdvanceInvoiceSettlementRow } from '@/lib/ksef/fa3-advance-generator';
import type { CorrectionInvoiceData, FinalInvoiceData } from '@/types/invoice-types';

export interface CorrectionSpecialData {
  correctionData: CorrectionInvoiceData;
}

export interface FinalSpecialData {
  finalData: FinalInvoiceData;
  finalAdvanceSettlementRows: AdvanceInvoiceSettlementRow[];
}

/** Ten sam obiekt idzie do INSERT i do zdarzenia — bez kopii, bez przeróbek. */
export function correctionSpecialData(correctionData: CorrectionInvoiceData): CorrectionSpecialData {
  if (!correctionData || typeof correctionData !== 'object') {
    throw new Error('Brak danych korekty do zapisania na wierszu faktury.');
  }
  return { correctionData };
}

export function finalSpecialData(
  finalData: FinalInvoiceData,
  finalAdvanceSettlementRows: AdvanceInvoiceSettlementRow[],
): FinalSpecialData {
  // JSON.stringify zgubiłby `undefined` i baza odbiłaby niepełny kształt —
  // tu błąd programisty, zanim cokolwiek trafi do bazy.
  if (!finalData || typeof finalData !== 'object' ||
      !Array.isArray(finalAdvanceSettlementRows) || finalAdvanceSettlementRows.length === 0) {
    throw new Error('Brak danych faktury rozliczającej albo rozliczanych zaliczek do zapisania na wierszu faktury.');
  }
  return { finalData, finalAdvanceSettlementRows };
}

const SHAPE_CONSTRAINT = 'invoices_special_data_shape';

/**
 * Odmowa bazy na kształcie danych specjalnych to błąd programu, nie klienta —
 * komunikat z nazwą dokumentu i tym, co zrobić, zamiast treści Postgresa.
 * `null`, gdy błąd dotyczy czegoś innego (wołający zostawia swój komunikat).
 */
export function specialDataInsertError(
  error: { code?: string | null; message?: string | null } | null | undefined,
  /** Dopełniacz z numerem, np. „korekty FK/1/10/2026”. */
  documentLabel: string,
): string | null {
  if (!error || error.code !== '23514' || !error.message?.includes(SHAPE_CONSTRAINT)) return null;
  return `Nie zapisaliśmy ${documentLabel}: dane potrzebne do wysyłki do KSeF są niepełne. ` +
    'Nic nie zostało wysłane. Spróbuj zapisać jeszcze raz; jeśli błąd wróci, napisz do pomocy FaktWay.';
}

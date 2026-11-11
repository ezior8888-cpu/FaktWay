/**
 * „Oznacz jako zapłacone” przy koszcie (krok 3.4, część 1; migracja 00177):
 * role, wyniki RPC i teksty w module bez importów serwerowych. Biorą je akcja
 * serwerowa i komponenty klienckie. Wzór: `lib/invoices/manual-payment.ts`
 * (faktury sprzedaży, 00158).
 */

import { INVOICE_PAYMENT_ROLES } from '@/lib/invoices/manual-payment';

/** Te same role co przy fakturach sprzedaży i w RPC 00177: księgowa ma wgląd. */
export const EXPENSE_PAYMENT_ROLES = INVOICE_PAYMENT_ROLES;

export function canChangeExpensePayment(role: string | null | undefined): boolean {
  return typeof role === 'string' && (EXPENSE_PAYMENT_ROLES as readonly string[]).includes(role);
}

/** Powód odmowy `mark_expense_paid` (00177). */
export type ExpensePaidRefusal = 'not_found' | 'future_date' | 'invalid_date' | 'nothing_to_pay';

export type MarkExpensePaidResult =
  | { success: true; status: 'marked'; paidOn: string }
  | { success: true; status: 'already_paid'; paidOn: string | null }
  | { success: false; error: string };

export type UndoExpensePaidResult =
  | { success: true; status: 'undone' | 'nothing_to_undo' }
  | { success: false; error: string };

const dokument = (number: string | null | undefined) => (number ? `Koszt ${number}` : 'Ten koszt');

/** Odmowa nazywa dokument i mówi, co zrobić (protokół napraw, pkt 4). */
export function expensePaidRefusalText(code: ExpensePaidRefusal, number?: string | null): string {
  switch (code) {
    case 'not_found':
      return 'Nie znaleziono tego kosztu w aktywnej firmie. Odśwież stronę albo przełącz firmę.';
    case 'future_date':
      return 'Data zapłaty nie może być z przyszłości. Wybierz dzisiaj albo wcześniejszy dzień.';
    case 'invalid_date':
      return 'Sprawdź datę zapłaty: ta data wygląda na literówkę.';
    case 'nothing_to_pay':
      return `${dokument(number)} to korekta na minus, więc nie ma czego płacić ani oznaczać.`;
  }
}

export const EXPENSE_ROLE_REFUSAL =
  'Zapłatę oznacza właściciel, administrator albo członek firmy. Księgowa ma tu wgląd.';
export const MARK_EXPENSE_PAID_FAILED = 'Nie udało się oznaczyć zapłaty. Sprawdź połączenie i spróbuj ponownie.';
export const UNDO_EXPENSE_PAID_FAILED = 'Nie udało się cofnąć zapłaty. Sprawdź połączenie i spróbuj ponownie.';

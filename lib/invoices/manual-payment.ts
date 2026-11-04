/**
 * „Zapłacone” jednym dotknięciem (FaktWay 1.0 §3 pkt 3, migracja 00158): role,
 * wyniki RPC i teksty w module bez importów — biorą je akcje serwerowe
 * i komponenty klienckie (przycisk, toast).
 *
 * Decyzję D-W z 23.10.2026 („klient nic nie oznacza”) odwołano 02.11.2026 na
 * polecenie Bartosza: wpływ to wyłącznie prawdziwe pieniądze, a klient oznacza
 * je sam (`lib/dashboard/inflows.ts`).
 */

/**
 * Kto oznacza zapłatę. Jak `EDITOR_ROLES` w `app/actions/contractors.ts`:
 * księgowa ma wgląd, zmieniać dane firmy mogą pozostali członkowie. Oznaczenie
 * nic nie wysyła na zewnątrz, więc nie wymaga właściciela ani administratora
 * (te role trzymają ponowną wysyłkę do KSeF). Ta sama lista stoi w RPC.
 */
export const INVOICE_PAYMENT_ROLES = ['owner', 'admin', 'member'] as const;

export function canChangeInvoicePayment(role: string | null | undefined): boolean {
  return typeof role === 'string' && (INVOICE_PAYMENT_ROLES as readonly string[]).includes(role);
}

/** Powód odmowy `mark_invoice_paid` (00158). */
export type MarkPaidRefusal =
  | 'not_found'
  | 'not_sales'
  | 'not_accepted'
  | 'future_date'
  | 'invalid_date'
  | 'nothing_to_pay'
  | 'corrected_to_zero';

export type MarkInvoicePaidResult =
  | { success: true; status: 'marked'; amount: number; paidOn: string; number: string | null }
  | { success: true; status: 'already_paid'; number: string | null }
  | { success: false; error: string };

export type UndoInvoicePaidResult =
  | { success: true; status: 'undone' | 'nothing_to_undo' }
  | { success: false; error: string };

const dokument = (number: string | null | undefined) => (number ? `Faktura ${number}` : 'Ta faktura');

/** Odmowa nazywa dokument i mówi, co zrobić (protokół napraw, pkt 4). */
export function markPaidRefusalText(code: MarkPaidRefusal, number?: string | null): string {
  switch (code) {
    case 'not_found':
      return 'Nie znaleziono tej faktury w aktywnej firmie. Odśwież stronę albo przełącz firmę.';
    case 'not_sales':
      return `${dokument(number)} to faktura zakupu. Zapłatę oznaczamy tylko przy fakturach sprzedaży.`;
    case 'not_accepted':
      return `${dokument(number)} nie jest jeszcze przyjęta w KSeF. Zapłatę oznaczysz po jej przyjęciu.`;
    case 'future_date':
      return 'Data zapłaty nie może być z przyszłości. Wybierz dzisiaj albo wcześniejszy dzień.';
    case 'invalid_date':
      return 'Sprawdź datę zapłaty: ten rok wygląda na literówkę.';
    case 'nothing_to_pay':
      return `${dokument(number)} nie ma kwoty do zapłaty, więc nie ma czego oznaczać.`;
    case 'corrected_to_zero':
      return `${dokument(number)} jest skorygowana do zera. Nabywca nic nie jest winien, więc nie ma czego oznaczać.`;
  }
}

export const MARK_PAID_FAILED = 'Nie udało się oznaczyć zapłaty. Sprawdź połączenie i spróbuj ponownie.';
export const UNDO_PAID_FAILED = 'Nie udało się cofnąć zapłaty. Sprawdź połączenie i spróbuj ponownie.';

/** Toast po dotknięciu: pokazuje się od razu, jeszcze zanim odpowie serwer. */
export function markedPaidToast(number: string | null | undefined): string {
  return number ? `Faktura ${number}: zapłacona` : 'Faktura zapłacona';
}

export function alreadyPaidToast(number: string | null | undefined): string {
  return `${dokument(number)} jest już zapłacona.`;
}

export function undonePaidToast(number: string | null | undefined): string {
  return number ? `Faktura ${number}: cofnięto zapłatę` : 'Cofnięto zapłatę';
}

export function nothingToUndoToast(number: string | null | undefined): string {
  return `${dokument(number)} nie ma zapłaty oznaczonej ręcznie, więc nie ma czego cofnąć.`;
}

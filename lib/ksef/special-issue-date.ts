/**
 * Decyzja Bartosza 06.10.2026 (00147): dokument specjalny (KOR, ZAL, ROZ)
 * wychodzi do KSeF tylko w dniu swojej daty wystawienia (Europe/Warsaw).
 * W KSeF dokument wystawia się w dniu wysyłki (art. 106na ust. 1; F-092) —
 * z wcześniejszą datą byłby fakturą offline bez oznaczeń.
 *
 * Dwa sprawdzenia: runner przed całą wysyłką (ponowienie, przejęcie) i hak
 * otwarcia sesji tuż przed plikiem — uwierzytelnienie, archiwum i sesja
 * KSeF trwają do kilkudziesięciu sekund i potrafią przeskoczyć północ.
 * Zostaje okno samego żądania z plikiem (poniżej sekundy).
 */

import { todayInWarsaw } from '@/lib/format/warsaw-date';

import { SEND_ERROR_CODES } from './send-error-classes';

/** Treść błędu ze znacznikiem kodu — klasyfikator czyta znacznik, klient dostaje resztę. */
export function issueDatePassedMessage(issueDate: string, today: string): string {
  return (
    `[${SEND_ERROR_CODES.ISSUE_DATE_PASSED}] Tego dokumentu nie wysłaliśmy do KSeF: ma datę wystawienia ` +
    `${issueDate || 'brak'}, a dziś jest ${today} — w KSeF dokument wystawia się w dniu wysyłki. ` +
    'Wróć do szkicu, usuń go i wystaw dokument od nowa z dzisiejszą datą.'
  );
}

/** Odmowa z haka sesji (`submitInvoiceFullFlow`) — runner zamienia ją na `NonRetriableError`. */
export class IssueDatePassedError extends Error {
  readonly name = 'IssueDatePassedError';

  constructor(readonly issueDate: string, readonly today: string) {
    super(issueDatePassedMessage(issueDate, today));
  }
}

/** Rzuca `IssueDatePassedError`, gdy data wystawienia dokumentu specjalnego nie jest dzisiejsza. */
export function assertSpecialIssueDateToday(issueDate: string): void {
  const today = todayInWarsaw();
  if (issueDate !== today) throw new IssueDatePassedError(issueDate, today);
}

/** Reguła 00147 jako predykat (zlecenie z kopii, A4b PR2a): data wystawienia dokumentu specjalnego = dziś w Polsce. */
export function specialIssueDateIsToday(issueDate: unknown, now: Date = new Date()): boolean {
  return typeof issueDate === 'string' && issueDate === todayInWarsaw(now);
}

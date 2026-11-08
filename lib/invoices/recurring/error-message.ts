/**
 * Komunikat błędu odczytu faktur cyklicznych dla klienta (wzór:
 * `pulpitErrorMessage` na Pulpicie). Warstwa danych (`queries.ts`) rzuca
 * polskie komunikaty zaczynające się od „Nie udało się wczytać faktur” —
 * te klient może przeczytać. Wszystko inne (konfiguracja serwera, błąd
 * programu, tekst PostgREST-a po angielsku) to ogólny komunikat, a pełny
 * wyjątek idzie do logu. Next.js w produkcji i tak ukrywa treść wyjątków
 * serwerowych, więc strona łapie błąd sama i filtruje go tą funkcją.
 */

export const RECURRING_GENERIC_ERROR = 'Nie udało się wczytać strony faktur cyklicznych. Odśwież ją za chwilę.';

const CUSTOMER_PREFIX = 'Nie udało się wczytać faktur';

export function recurringErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  return message.startsWith(CUSTOMER_PREFIX) ? message : RECURRING_GENERIC_ERROR;
}

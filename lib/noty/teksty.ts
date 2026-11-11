/**
 * Teksty not dla klienta (krok 2.9, część 1) w jednym miejscu: PDF, mail,
 * ekrany i komunikaty akcji. Bez długich myślników (strażnik tekstów) i bez
 * trybu rozkazującego przy podatkach.
 *
 * Źródło adnotacji: ksef.podatki.gov.pl, „Wystawianie i otrzymywanie faktur”
 * (27.04.2026), pytanie 27: „Nie są natomiast wystawiane w KSeF ani
 * przesyłane do KSeF noty obciążeniowe ani noty uznaniowe”; „Zakres
 * obowiązkowego KSeF” (zmiana 06.02.2026): do KSeF nie przesyła się not
 * uznaniowych ani not obciążeniowych.
 */

/** Adnotacja na PDF, w mailu i w podglądzie. */
export const NOTE_NOT_INVOICE_NOTICE =
  'Nota nie jest fakturą VAT. Noty obciążeniowe i uznaniowe nie są wystawiane w KSeF ani do niego przesyłane.';

/** Nota nie trafia sama do ksiąg (pytanie dla księgowej w PR kroku 2.9). */
export const NOTE_BOOKS_NOTICE =
  'FaktWay nie ujmuje not w KPiR, w ewidencji ani w raportach. Jak ująć notę w księgach, ustala księgowa.';

/**
 * Kiedy nota, a kiedy faktura. Podręcznik KSeF 2.0 podaje karę umowną jako
 * przykład noty obciążeniowej; interpelacja nr 13642 (2025) wskazuje
 * interpretacje, w których „kara” bywa wynagrodzeniem za usługę. Program
 * tego nie rozstrzyga, więc ekran mówi to wprost.
 */
export const NOTE_VAT_WARNING =
  'Notą dokumentuje się obciążenie, które nie jest sprzedażą towaru ani usługi, na przykład karę umowną albo odszkodowanie. ' +
  'Obciążenie za towar albo usługę (także refakturę kosztów) dokumentuje się fakturą, nie notą. ' +
  'W razie wątpliwości warto zapytać księgową.';

export const NOTE_TEXTS = {
  notFound: 'Nie znaleziono noty. Mogła zostać usunięta albo należy do innej firmy.',
  role: 'Twoja rola w tej firmie nie pozwala zapisywać ani wysyłać not.',
  readFailed: 'Nie udało się wczytać noty. Spróbuj ponownie za chwilę.',
  saveFailed: 'Nie udało się zapisać szkicu noty. Spróbuj ponownie za chwilę.',
  contractorMissing:
    'Nie znaleziono tego kontrahenta w bazie kontrahentów firmy. Wybierz kontrahenta z listy i zapisz szkic ponownie.',
  contractorIncomplete:
    'Kontrahent nie ma nazwy albo NIP. Uzupełnij jego dane w Kontrahentach i zapisz szkic ponownie.',
  contractorAddFailed: 'Nie udało się dodać kontrahenta do bazy. Spróbuj ponownie za chwilę.',
  issueFailed: 'Nie udało się wystawić noty. Spróbuj ponownie za chwilę.',
  issueRole: 'Nie możesz wystawić noty w tej firmie: sprawdź, czy masz aktywny dostęp do firmy, i zaloguj się ponownie.',
  futureDate: 'Data wystawienia noty nie może być z przyszłości. Popraw datę w szkicu i wystaw notę.',
  contractorRemoved:
    'Kontrahent tej noty został usunięty z bazy kontrahentów. Otwórz szkic, wybierz kontrahenta ponownie i zapisz.',
  issuerIncomplete:
    'Uzupełnij dane firmy w Ustawieniach (nazwa, NIP i adres), a potem wystaw notę. Te dane trafiają na notę jako dane wystawcy.',
  deleteFailed: 'Nie udało się usunąć szkicu noty. Spróbuj ponownie za chwilę.',
  emailInvalid: 'Podaj poprawny adres e-mail odbiorcy.',
  emailDraft: 'Najpierw wystaw notę. Szkic nie ma numeru i nie wychodzi do kontrahenta.',
  emailNotConfigured: 'Wysyłka e-mail nie jest skonfigurowana.',
  emailBlocked:
    'Nie wysłaliśmy noty: ten adres wcześniej odrzucał pocztę albo zgłosił ją jako niechcianą. Sprawdź adres albo przekaż PDF inną drogą.',
  emailInProgress: 'Ta nota właśnie wychodzi na ten adres. Odśwież stronę za chwilę i sprawdź historię wysyłek.',
  emailFailed: 'Nie udało się wysłać noty. Spróbuj ponownie za chwilę.',
  emailNotRecorded:
    'Nota została wysłana, ale nie udało się zapisać tego w historii wysyłek. Kliknij Wyślij jeszcze raz na ten sam adres: drugi mail nie wyjdzie, a historia się uzupełni.',
} as const;

/** Wystawionej noty nie zmienia się: poprawka to nowa nota. */
export function noteIssuedLockedMessage(number: string | null): string {
  const nazwa = number ? `Nota ${number}` : 'Ta nota';
  return `${nazwa} jest wystawiona i nie można jej zmienić ani usunąć. Aby ją poprawić, wystaw nową notę.`;
}

/** Limit wysyłek not mailem (jak przy fakturach, AUD-102). */
export function noteEmailLimitMessage(limit: number): string {
  return `Osiągnięto limit ${limit} wysyłek not mailem na godzinę. Spróbuj później.`;
}

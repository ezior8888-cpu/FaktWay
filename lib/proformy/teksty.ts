/**
 * Teksty proformy i oferty dla klienta (krok 2.4) w jednym miejscu: PDF,
 * mail, ekrany, komunikaty akcji i zamiany w fakturę. Bez długich myślników
 * (strażnik tekstów) i bez trybu rozkazującego przy podatkach.
 *
 * Źródło adnotacji: ksef.podatki.gov.pl, „Zakres obowiązkowego KSeF”
 * (opublikowano 30.06.2025, zmiana 06.02.2026): „Do KSeF nie przesyła się
 * faktur proforma, faktur wewnętrznych, dowodów wewnętrznych, not uznaniowych
 * ani not obciążeniowych.” Strona czytana 11.11.2026.
 */
import { QUOTE_KIND_ACCUSATIVE, QUOTE_KIND_GENITIVE, QUOTE_KIND_LABELS, type QuoteKind } from '@/lib/proformy/model';

/** Źródło informacji MF o proformie i KSeF (do PDF, maila i podglądu). */
export const QUOTE_MF_SOURCE = 'Ministerstwo Finansów, ksef.podatki.gov.pl, „Zakres obowiązkowego KSeF”';

/**
 * Adnotacja na PDF, w mailu i w podglądzie: dokument nie jest fakturą VAT
 * i nie trafia do KSeF. Jedyne miejsce na dokumencie ze słowem „faktura”.
 */
export function quoteNotInvoiceNotice(kind: QuoteKind): string {
  if (kind === 'proforma') {
    return `Proforma nie jest fakturą VAT. Do KSeF nie przesyła się faktur proforma (${QUOTE_MF_SOURCE}).`;
  }
  return 'Oferta nie jest fakturą VAT i nie trafia do KSeF.';
}

/** Dokument nie jest przychodem (ryzyko R2: dokument z kwotami, który nie jest fakturą). */
export const QUOTE_BOOKS_NOTICE =
  'FaktWay nie ujmuje proform ani ofert w KPiR, w ewidencji, w JPK, w raportach ani w przypomnieniach o płatności. ' +
  'Przychód pokazuje dopiero faktura wystawiona z dokumentu.';

export const QUOTE_TEXTS = {
  notFound: 'Nie znaleziono proformy ani oferty. Mogła zostać usunięta albo należy do innej firmy.',
  role: 'Twoja rola w tej firmie nie pozwala zapisywać ani wysyłać proform i ofert.',
  readFailed: 'Nie udało się wczytać dokumentu. Spróbuj ponownie za chwilę.',
  saveFailed: 'Nie udało się zapisać szkicu. Spróbuj ponownie za chwilę.',
  contractorMissing:
    'Nie znaleziono tego kontrahenta w bazie kontrahentów firmy. Wybierz kontrahenta z listy i zapisz szkic ponownie.',
  contractorIncomplete:
    'Kontrahent nie ma nazwy albo NIP. Uzupełnij jego dane w Kontrahentach i zapisz szkic ponownie.',
  contractorAddFailed: 'Nie udało się dodać kontrahenta do bazy. Spróbuj ponownie za chwilę.',
  issueFailed: 'Nie udało się wystawić dokumentu. Spróbuj ponownie za chwilę.',
  issueRole: 'Nie możesz wystawić dokumentu w tej firmie: sprawdź, czy masz aktywny dostęp do firmy, i zaloguj się ponownie.',
  futureDate: 'Data wystawienia nie może być z przyszłości. Popraw datę w szkicu i wystaw dokument.',
  validUntilPast:
    'Termin ważności oferty już minął. Otwórz szkic, popraw datę ważności i wystaw ofertę.',
  contractorRemoved:
    'Kontrahent tego dokumentu został usunięty z bazy kontrahentów. Otwórz szkic, wybierz kontrahenta ponownie i zapisz.',
  issuerIncomplete:
    'Uzupełnij dane firmy w Ustawieniach (nazwa, NIP i adres), a potem wystaw dokument. Te dane trafiają na dokument jako dane sprzedawcy.',
  deleteFailed: 'Nie udało się usunąć szkicu. Spróbuj ponownie za chwilę.',
  emailInvalid: 'Podaj poprawny adres e-mail odbiorcy.',
  emailDraft: 'Najpierw wystaw dokument. Szkic nie ma numeru i nie wychodzi do kontrahenta.',
  emailNotConfigured: 'Wysyłka e-mail nie jest skonfigurowana.',
  emailBlocked:
    'Nie wysłaliśmy dokumentu: ten adres wcześniej odrzucał pocztę albo zgłosił ją jako niechcianą. Sprawdź adres albo przekaż PDF inną drogą.',
  emailInProgress: 'Ten dokument właśnie wychodzi na ten adres. Odśwież stronę za chwilę i sprawdź historię wysyłek.',
  emailFailed: 'Nie udało się wysłać dokumentu. Spróbuj ponownie za chwilę.',
  emailNotRecorded:
    'Dokument został wysłany, ale nie udało się zapisać tego w historii wysyłek. Kliknij Wyślij jeszcze raz na ten sam adres: drugi mail nie wyjdzie, a historia się uzupełni.',
} as const;

/** Wystawionego dokumentu nie zmienia się: poprawka to nowy dokument. */
export function quoteIssuedLockedMessage(kind: QuoteKind, number: string | null): string {
  // Proforma i oferta: rodzaj żeński w obu przypadkach.
  const nazwa = number ? `${QUOTE_KIND_LABELS[kind]} ${number}` : `Ta ${QUOTE_KIND_LABELS[kind].toLowerCase()}`;
  return `${nazwa} jest wystawiona i nie można jej zmienić ani usunąć. Aby ją poprawić, wystaw nową ${QUOTE_KIND_ACCUSATIVE[kind]}.`;
}

/** Limit wysyłek mailem (jak przy fakturach i notach, AUD-102). */
export function quoteEmailLimitMessage(limit: number): string {
  return `Osiągnięto limit ${limit} wysyłek proform i ofert mailem na godzinę. Spróbuj później.`;
}

// ─── zamiana w fakturę ──────────────────────────────────────────

/** „proformy PRO/1/2026”, „oferty OF/2/2026”. */
export function quoteGenitiveName(kind: QuoteKind, number: string | null): string {
  return number ? `${QUOTE_KIND_GENITIVE[kind]} ${number}` : QUOTE_KIND_GENITIVE[kind];
}

/** Numery faktur z dokumentu do zdań: „FV/1/11/2026 (szkic), ZAL/2/11/2026”. */
export function invoiceNumbersSentence(invoices: ReadonlyArray<{ internalNumber: string | null; ksefStatus: string | null }>): string {
  return invoices
    .map((invoice) => `${invoice.internalNumber ?? 'bez numeru'}${invoice.ksefStatus === 'draft' ? ' (szkic)' : ''}`)
    .join(', ');
}

export const CONVERSION_TEXTS = {
  notFoundTitle: 'Nie znaleziono proformy ani oferty',
  notFoundText: 'Mogła zostać usunięta albo należy do innej firmy. Formularz jest pusty: można wystawić zwykłą fakturę.',
  readFailedTitle: 'Nie udało się wczytać proformy ani oferty',
  readFailedText: 'Formularz jest pusty. Odśwież stronę za chwilę; jeśli błąd wróci, napisz do pomocy FaktWay.',
  listLink: 'Przejdź do proform i ofert',
  /** Zapis faktury z dokumentu, którego nie ma w bazie (usunięty albo obcy). */
  linkMissing:
    'Nie znaleziono proformy ani oferty, z której otwarto formularz. Faktura nie została zapisana. Otwórz dokument z listy proform i ofert i wybierz zamianę jeszcze raz.',
  linkDraft:
    'Formularz otwarto ze szkicu dokumentu bez numeru. Faktura nie została zapisana. Wystaw dokument i wybierz zamianę jeszcze raz.',
  linkReadFailed: 'Nie udało się sprawdzić dokumentu, z którego otwarto formularz. Faktura nie została zapisana. Spróbuj ponownie za chwilę.',
} as const;

export function conversionDraftTitle(kind: QuoteKind): string {
  return `Najpierw wystaw ${QUOTE_KIND_ACCUSATIVE[kind]}`;
}

export function conversionDraftText(kind: QuoteKind): string {
  return `Fakturę tworzy się z wystawionego dokumentu z numerem, a ten jest szkicem. Wystaw go na ekranie ${QUOTE_KIND_GENITIVE[kind]} i wybierz zamianę jeszcze raz. Formularz jest pusty.`;
}

/** Tytuł komunikatu: z dokumentu jest już faktura, a zamiana bez potwierdzenia. */
export function conversionTakenTitle(kind: QuoteKind, number: string | null): string {
  return `Z ${quoteGenitiveName(kind, number)} jest już faktura`;
}

export function conversionTakenText(invoicesSentence: string): string {
  return (
    `Faktury z tego dokumentu: ${invoicesSentence}. Kolejną fakturę z tego samego dokumentu ` +
    'można wystawić po potwierdzeniu na ekranie dokumentu. Formularz jest pusty i niczego nie połączy z dokumentem.'
  );
}

export function conversionQuoteLinkLabel(kind: QuoteKind, number: string | null): string {
  return `Przejdź do ${quoteGenitiveName(kind, number)}`;
}

export function conversionRegularTitle(kind: QuoteKind, number: string | null): string {
  return `Faktura z ${quoteGenitiveName(kind, number)}`;
}

export function conversionAdvanceTitle(kind: QuoteKind, number: string | null): string {
  return `Faktura zaliczkowa z ${quoteGenitiveName(kind, number)}`;
}

/** Wspólne zdanie o zapisie: zamiana nic nie wystawia i nie wysyła sama. */
const CONVERSION_SAVE_SENTENCE =
  'Faktura powstanie dopiero po kliknięciu Zapisz szkic albo Wystaw i wyślij; wtedy połączymy ją z dokumentem. Sprawdź dane przed wystawieniem.';

export function conversionRegularText(previous: string | null): string {
  const base = `Wypełniliśmy formularz danymi z dokumentu: nabywca, pozycje i sposób zapłaty. Numer i daty są nowe. ${CONVERSION_SAVE_SENTENCE}`;
  return previous ? `${base} To kolejna faktura z tego dokumentu (już są: ${previous}).` : base;
}

export function conversionAdvanceText(previous: string | null): string {
  const base =
    'Wypełniliśmy formularz danymi z dokumentu: nabywca, wartość umowy (kwota brutto dokumentu), stawka VAT i sposób zapłaty. ' +
    'Kwota zaliczki jest na razie równa wartości umowy; jeśli wpłata była mniejsza, wpisz kwotę wpłaty. Numer i daty są nowe. ' +
    CONVERSION_SAVE_SENTENCE;
  return previous ? `${base} To kolejna faktura z tego dokumentu (już są: ${previous}).` : base;
}

export const CONVERSION_ADVANCE_REFUSED_TITLE = 'Faktury zaliczkowej nie wypełnimy z tego dokumentu';

/** Kilka stawek VAT: zaliczka w FaktWay ma jedną stawkę (fail-closed z wyjściem). */
export function conversionAdvanceMixedRatesText(rates: string): string {
  return (
    `Dokument ma pozycje w kilku stawkach VAT (${rates}), a faktura zaliczkowa w FaktWay ma na razie jedną stawkę. ` +
    'Można wystawić z niego zwykłą fakturę albo wpisać fakturę zaliczkową ręcznie; przy kilku stawkach warto zapytać księgową, jak podzielić zaliczkę.'
  );
}

/** Stawka zw, oo albo np: zaliczki z taką stawką FaktWay nie wystawia (jak formularz zaliczki). */
export function conversionAdvanceUnsupportedRateText(rates: string): string {
  return (
    `Dokument ma pozycje ze stawką ${rates}, a faktury zaliczkowej z taką stawką FaktWay jeszcze nie wystawia. ` +
    'Można wystawić z niego zwykłą fakturę albo napisać do nas przez Pomoc.'
  );
}

/** Indeks numeru zamiany odrzucił zapis, ale tamtej faktury nie widać (np. usunięta między zapisem a odczytem). */
export function conversionSeqTakenUnknownMessage(kind: QuoteKind, number: string | null): string {
  return (
    `Z ${quoteGenitiveName(kind, number)} powstała w tym czasie inna faktura. Faktura nie została zapisana. ` +
    `Otwórz ${QUOTE_KIND_ACCUSATIVE[kind]}, sprawdź faktury z tego dokumentu i wybierz zamianę jeszcze raz.`
  );
}

/** Zapis faktury, gdy numer zamiany zajęła w międzyczasie inna faktura. */
export function conversionSeqTakenMessage(kind: QuoteKind, number: string | null, invoicesSentence: string): string {
  return (
    `Z ${quoteGenitiveName(kind, number)} jest już faktura ${invoicesSentence}, zapisana po otwarciu tego formularza. ` +
    `Faktura nie została zapisana. Aby wystawić z tego dokumentu kolejną fakturę, otwórz ${QUOTE_KIND_ACCUSATIVE[kind]} i wybierz zamianę jeszcze raz.`
  );
}

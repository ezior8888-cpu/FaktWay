/**
 * Kontrakt API aplikacji na telefon (`/api/mobile/v1`, plan aplikacji
 * mobilnej 4.1 i 4.3, decyzja M6): nagłówki, kody błędów i kształty odpowiedzi
 * w jednym miejscu dla serwera i aplikacji.
 *
 * BEZ IMPORTÓW: ten plik czyta też aplikacja w `mobile/` (od M7, przez Metro),
 * więc nie może ciągnąć kodu serwera, Supabase ani Nexta. Pilnuje tego
 * `tests/unit/mobile-api-kontrakt.test.ts`. Schematy Zod treści żądań leżą
 * obok, w `lib/api/mobile/schematy.ts` (import `zod`), i do aplikacji nie
 * trafiają (rozstrzygnięcie M8): telefon dostaje stąd typy treści, a serwer
 * sprawdza każde żądanie tym samym schematem formularza co strona i odsyła
 * błąd z polem (`invoice_invalid`). Zgodność typów tu ze schematem pilnuje
 * `tests/unit/mobile-api-faktury.test.ts`.
 */

/** Firma, w której telefon działa, przy trasach z danymi firmy (jak ciasteczko aktywnej firmy na stronie, `ACTIVE_ORG_COOKIE`). */
export const MOBILE_ACTIVE_ORG_HEADER = 'X-Active-Org';

/**
 * Zapis z telefonu (M8, `POST /faktury`): UUID wylosowany raz na wypełnienie
 * formularza. Ponowienie z tym samym kluczem i tą samą treścią oddaje fakturę
 * z pierwszego zapisu (bez drugiej faktury i drugiej wysyłki).
 */
export const MOBILE_IDEMPOTENCY_HEADER = 'Idempotency-Key';

export const MOBILE_API_ERROR_CODES = [
  /** 401: brak nagłówka `Authorization: Bearer`. */
  'missing_token',
  /**
   * 401: token w złym kształcie albo taki, którego GoTrue nie uznaje (wygasły, wylogowany, podrobiony).
   * Telefon odświeża sesję (`refreshSession`) i ponawia raz; sesję kończy dopiero, gdy odświeżenie się nie uda.
   * Wygasły token dostępu (co godzinę) to zwykły przypadek, nie powód do wylogowania.
   */
  'invalid_token',
  /** 403: konto z 2FA w sesji bez kodu (AAL1). Telefon prosi o kod. */
  'mfa_required',
  /** 400: trasa z danymi firmy bez nagłówka `X-Active-Org` (albo nie UUID). */
  'missing_org',
  /** 403: `X-Active-Org` wskazuje firmę bez aktywnego członkostwa. Telefon odświeża listę firm. */
  'no_active_org',
  /** 400: zapis bez nagłówka `Idempotency-Key` albo klucz nie jest UUID (M8). */
  'missing_idempotency_key',
  /** 409: ten klucz idempotencji był już użyty z inną treścią. Telefon losuje nowy klucz dopiero dla nowej faktury. */
  'idempotency_conflict',
  /** 422: dane faktury nie przeszły schematu formularza strony albo zasad wystawienia; `message` mówi co poprawić, `field` które pole. */
  'invoice_invalid',
  /** 404: faktury nie ma w tej firmie (albo nie należy do niej). */
  'not_found',
  /** 409: wysłać można tylko szkic; faktura jest w innym stanie (np. odrzucona: popraw ją na faktway.pl). */
  'not_draft',
  /** 422: kolejka KSeF odmówiła wysyłki szkicu (brak certyfikatu, pauza, 2FA); szkic zostaje, `message` mówi co zrobić. */
  'ksef_send_refused',
  /** 429, z nagłówkiem `Retry-After`. */
  'rate_limited',
  /** 503, z nagłówkiem `Retry-After`. */
  'maintenance',
  /** 503: GoTrue nie odpowiedział albo odpowiedział błędem serwera. Ponów, nie wylogowuj. */
  'session_verification_failed',
  /** 503: baza albo GoTrue niedostępne. Ponów. */
  'service_unavailable',
  /** 400: treść żądania w złym kształcie (np. logowanie bez e-maila albo hasła). */
  'invalid_request',
  /** 400: `POST /logowanie`: zły e-mail albo hasło (także niepotwierdzony e-mail, jak na stronie). */
  'invalid_credentials',
  /**
   * 503, z nagłówkiem `Retry-After`: `POST /logowanie` nie może teraz bezpiecznie zalogować
   * (bez Redisa nie ma limitów prób, a trasa nie ma captchy; albo GoTrue odrzucił klucz serwera).
   * Klient loguje się na faktway.pl albo próbuje za kilka minut.
   */
  'login_unavailable',
  /** 400: `POST /kod` (M6c): zły kod 2FA albo nie sześć cyfr. Próba z limitu konta zużyta tylko przy sześciu cyfrach. */
  'invalid_code',
  /**
   * 409: `POST /kod` (M6c) z sesją, która nie czeka na kod (konto bez 2FA albo sesja już po kodzie).
   * Telefon zostaje na obecnej sesji.
   */
  'mfa_not_required',
  // Należności, przypomnienia, PDF (M10a): zdanie z serwera mówi, co zrobić.
  /** 403: rola w firmie nie pozwala na tę zmianę (np. księgowa ma wgląd w zapłaty, przypomnienie zatwierdza właściciel albo administrator). */
  'forbidden',
  /** 422: zapłaty nie zapisano (faktura skorygowana, z innego źródła, data z przyszłości); `message` mówi dlaczego. */
  'payment_refused',
  /** 422: przypomnienia nie przygotowano albo nie zlecono (podgląd wygasł, etap już zlecony, wyłączone); `message` mówi, co zrobić. */
  'reminder_refused',
  /** 409: PDF tej faktury nie powstanie w tym stanie (offline bez kodu QR, szkic wycofany); `message` mówi dlaczego. */
  'pdf_unavailable',
  // Konto i księgowość (M10b): zdanie z serwera mówi, co zrobić.
  /** 403: usunięcie konta bez hasła wymaga świeżego logowania w tej sesji (konto tylko z Google). Telefon prowadzi do ponownego logowania. */
  'reauth_required',
  /** 409: konta nie usuniemy, bo firma ma aktywny abonament; `message` nazywa firmę i mówi, co zrobić. */
  'deletion_blocked',
  /** 409: usuwanie konta już trwa i nie da się go anulować. */
  'deletion_in_progress',
  /** 500, opis z identyfikatorem żądania. */
  'internal_error',
] as const;

export type MobileApiErrorCode = (typeof MOBILE_API_ERROR_CODES)[number];

/** Każda odmowa: stały kod po angielsku, po którym telefon wybiera swój tekst, i opis po polsku. */
export interface MobileApiError {
  /** `field` tylko przy `invoice_invalid`: ścieżka pola formularza, np. `buyerName`, `lines.0.name`. */
  error: { code: MobileApiErrorCode; message: string; field?: string };
}

// ─── Faktury (M8): wystawienie i wysyłka do KSeF ─────────────────────

/** Stawki zwykłej faktury z telefonu (jak `vatRateEnum` strony, bez „np II”, które wymaga nabywcy z UE). */
export type StawkaVatTelefonu = '23' | '8' | '5' | '0' | 'zw' | 'oo' | 'np';

/** Pozycja jak w formularzu strony (`lineItemSchema`): ilość i cena netto w złotych, do 4 miejsc po przecinku. */
export interface PozycjaFakturyTelefonu {
  name: string;
  unit: string;
  quantity: number;
  unitPriceNet: number;
  vatRate: StawkaVatTelefonu;
}

/**
 * Zwykła faktura VAT w złotych z telefonu: te same pola co formularz strony
 * (`InvoiceFormValues`), bez faktury cyklicznej, proformy, paragonu i nabywcy
 * z UE (te wystawia się na faktway.pl). Osoba prywatna: `buyerIsConsumer`
 * i pusty `buyerNip`; serwer wpisuje „bez numeru identyfikacyjnego”.
 */
export interface FakturaTelefonu {
  internalNumber: string;
  /** RRRR-MM-DD; przy wysyłce do KSeF tylko dziś (czas polski). */
  issueDate: string;
  /** RRRR-MM-DD albo pusty tekst (= data wystawienia). */
  saleDate: string;
  buyerNip: string;
  buyerName: string;
  buyerAddressLine1: string;
  buyerAddressLine2: string;
  buyerEmail: string;
  buyerIsConsumer: boolean;
  lines: PozycjaFakturyTelefonu[];
  paymentMethod: 'transfer' | 'cash' | 'card' | 'other';
  paymentDueDate: string;
  bankAccount: string;
  notes: string;
  splitPayment: boolean;
  /**
   * Seria numeracji z podpowiedzi (`PodpowiedzFakturyOdpowiedz.seria`, krok 2.5)
   * albo pusty tekst. Gdy `internalNumber` równa się `numberPreview`, numer
   * nadaje licznik serii przy zapisie (jak formularz strony); inny numer
   * zapisze się jak wpisany ręcznie.
   */
  numberSeriesId: string;
  numberPreview: string;
}

/** `POST /api/mobile/v1/faktury` (z nagłówkiem `Idempotency-Key`): `wyslij` to „Wyślij do KSeF”, inaczej szkic. */
export interface WystawienieZadanie {
  wyslij: boolean;
  faktura: FakturaTelefonu;
}

/** Faktura po zapisie: `ksefStatus` jak kolumna `invoices.ksef_status` (`draft`, `queued`, `accepted` …). */
export interface FakturaZapisana {
  id: string;
  numer: string;
  ksefStatus: string;
}

/**
 * `POST /api/mobile/v1/faktury`: 201 nowa faktura, 200 powtórzenie (`powtorzenie: true`,
 * ten sam klucz i ta sama treść). `wysylka` tylko przy `wyslij: true`: `zlecona` to
 * faktura w kolejce KSeF; odmowa kolejki zostawia szkic i daje `blad` (co zrobić).
 */
export interface WystawienieOdpowiedz {
  faktura: FakturaZapisana;
  powtorzenie: boolean;
  wysylka: { zlecona: boolean; blad: string | null } | null;
}

/**
 * `POST /api/mobile/v1/faktury/{id}/wysylka`: szkic do KSeF. 200 także wtedy, gdy
 * faktura jest już w kolejce albo przyjęta (`juzZlecona: true`): ponowienie po
 * zerwanym połączeniu niczego nie wysyła drugi raz.
 */
export interface WysylkaSzkicuOdpowiedz {
  faktura: FakturaZapisana;
  juzZlecona: boolean;
}

/** `GET /api/mobile/v1/faktury/podpowiedz`: to, czym strona wypełnia pusty formularz. */
export interface PodpowiedzFakturyOdpowiedz {
  /** Kolejny numer jak w pustym formularzu strony (seria domyślna albo po ostatniej fakturze); `null`: brak podpowiedzi. */
  numer: string | null;
  /** Seria numeracji domyślna dla zwykłej faktury (krok 2.5), z której pochodzi `numer`; `null`: numeracja jak dotąd. */
  seria: string | null;
  /** Dziś w Polsce, RRRR-MM-DD: data wystawienia faktury wysyłanej do KSeF. */
  dzis: string;
  /** Firma zwolniona z VAT (art. 113): nowa pozycja startuje ze stawką „zw”. */
  zwolnienieVat: boolean;
}

/** Jak `UserRole` strony (`lib/supabase/auth-context.ts`); zgodność sprawdza test kontraktu. */
export type RolaWFirmie = 'owner' | 'admin' | 'member' | 'accountant';

export interface FirmaKonta {
  id: string;
  nazwa: string;
  nip: string;
  rola: RolaWFirmie;
}

/** `GET /api/mobile/v1/konto`, 200. */
export interface KontoOdpowiedz {
  konto: { id: string; email: string | null };
  /** `wlaczone`: konto ma zweryfikowany TOTP. `poziom`: poziom tej sesji. */
  dwaEtapy: { wlaczone: boolean; poziom: 'aal1' | 'aal2' };
  /** Najpierw firmy, do których konto dołączyło najpóźniej. */
  firmy: FirmaKonta[];
  /** `false`, gdy firm jest więcej niż mieści lista (biuro z setkami klientów wybiera resztę na stronie). */
  wszystkie: boolean;
  /** Ostatnio używana na stronie, gdy nadal jest dostęp; inaczej pierwsza z listy; `null` bez firm. */
  aktywnaFirma: string | null;
}

/**
 * `POST /api/mobile/v1/logowanie` (M6b, decyzja D16): treść żądania. Telefon loguje się hasłem
 * przez API, a nie wprost do GoTrue, bo GoTrue z captchą odrzuca logowanie bez tokenu Turnstile.
 */
export interface LogowanieZadanie {
  email: string;
  haslo: string;
}

/**
 * `POST /api/mobile/v1/logowanie`, 200: sesja GoTrue dla `supabase.auth.setSession`. Kod 2FA idzie
 * od M6c przez `POST /kod`; odświeżanie i wylogowanie telefon robi dalej sam w GoTrue (bez captchy).
 * `wymagaKodu`: konto ma zweryfikowany TOTP, a sesja jest jeszcze na poziomie `aal1` (reguła strony).
 */
export interface LogowanieOdpowiedz {
  sesja: { accessToken: string; refreshToken: string };
  wymagaKodu: boolean;
}

/**
 * `POST /api/mobile/v1/kod` (M6c): kod 2FA z aplikacji TOTP. Token sesji AAL1 w `Authorization: Bearer`
 * (tej z `POST /logowanie` albo z Google). Limit prób jak na stronie: 5 na 5 minut na konto, wspólny ze stroną.
 */
export interface KodZadanie {
  kod: string;
}

/**
 * `POST /api/mobile/v1/kod`, 200: nowa sesja GoTrue na poziomie `aal2` (ta sama sesja, nowy token
 * i refresh token) dla `supabase.auth.setSession`.
 */
export interface KodOdpowiedz {
  sesja: { accessToken: string; refreshToken: string };
}

/** `POST /api/mobile/v1/sesja`: 201 `{ zapisane: true }` przy pierwszym wywołaniu dla sesji, potem 200 `{ zapisane: false }`. */
export interface SesjaOdpowiedz {
  zapisane: boolean;
}

// ─── Należności, zapłata, przypomnienia, PDF, skrzynka KSeF (M10a) ─────

/** Wpis przypomnienia o zapłacie (`payment_reminders.status`). */
export type StatusPrzypomnienia = 'pending' | 'sent' | 'failed' | 'cancelled';

/**
 * Faktura po terminie, jak wiersz strony „Po terminie” (`/payments/overdue`):
 * te same faktury (te same zasady: środowisko KSeF, korekty, zaliczki, kwoty),
 * ten sam limit 100 i ten sam stan przypomnień. Kwoty w złotych.
 */
export interface NaleznoscTelefonu {
  id: string;
  numer: string;
  kontrahent: string;
  nip: string | null;
  email: string | null;
  /** Termin płatności, RRRR-MM-DD. */
  termin: string;
  brutto: number;
  doZaplaty: number;
  dniPoTerminie: number;
  wstrzymane: boolean;
  /** Wysłane przypomnienia tej faktury. */
  wyslane: number;
  /**
   * Przypomnienie w kolejce: `brak`, `zaplanowane`, `do_sprawdzenia` (czeka dłużej niż 30 minut)
   * albo `nieznany` (odczyt się nie udał, przygotowanie nowego jest wtedy zablokowane jak na stronie).
   */
  kolejka: 'brak' | 'zaplanowane' | 'do_sprawdzenia' | 'nieznany';
  /** Ostatni wpis przypomnienia (etap 1 do 4, czas UTC); `null` bez przypomnień, `nieznany` bez odczytu. */
  ostatnie: { status: StatusPrzypomnienia; etap: number; kiedy: string } | null | 'nieznany';
}

/** `GET /api/mobile/v1/naleznosci`, 200. `blad`: listy nie da się potwierdzić (to samo zdanie co na stronie), lista jest wtedy pusta. */
export interface NaleznosciOdpowiedz {
  faktury: NaleznoscTelefonu[];
  blad: string | null;
  /** Lista mogła się nie zmieścić w limicie 100: reszta na faktway.pl. */
  limit: boolean;
  /** Przypomnień wysłanych w tym miesiącu; `null`, gdy odczyt się nie udał. */
  wyslaneWMiesiacu: number | null;
  /** Rola pozwala oznaczać zapłatę (księgowa ma wgląd). */
  mozeOznaczac: boolean;
  /** Przypomnienie zatwierdza do wysyłki właściciel albo administrator. */
  mozeZatwierdzac: boolean;
}

/** `POST /api/mobile/v1/faktury/{id}/zaplata`: opcjonalny dzień zapłaty RRRR-MM-DD (domyślnie dziś w Polsce). */
export interface ZaplataZadanie {
  dzien?: string;
}

/**
 * `POST /faktury/{id}/zaplata` (oznacz) i `POST /faktury/{id}/zaplata/cofnij`, 200.
 * `juzBylo`: stan był już taki (ponowienie po zerwanym połączeniu), nic się nie zmieniło.
 */
export interface ZaplataOdpowiedz {
  zaplacona: boolean;
  juzBylo: boolean;
  numer: string | null;
}

/** `POST /api/mobile/v1/faktury/{id}/przypomnienie`: podgląd przypomnienia; pusty `email` to adres z faktury. Nic jeszcze nie wychodzi. */
export interface PodgladPrzypomnieniaZadanie {
  email?: string;
}

/** Podgląd do sprawdzenia i zatwierdzenia (jak okno „Przygotuj przypomnienie” na stronie). */
export interface PodgladPrzypomnieniaOdpowiedz {
  propozycja: string;
  /** Wersja podglądu: zatwierdzenie z inną wersją odmawia (podgląd zmienił się w międzyczasie). */
  wersja: string;
  /** Do kiedy podgląd jest ważny (ISO). */
  wazneDo: string;
  od: string;
  do: string;
  odpowiedzNa: string | null;
  temat: string;
  tresc: string;
  /** Załącznik PDF do obejrzenia przed zgodą; `null` bez załącznika. */
  zalacznik: { nazwa: string; pdfBase64: string } | null;
}

/** `POST /api/mobile/v1/przypomnienia/{propozycja}/zatwierdz`: zgoda na tę wersję i tę treść (klient może ją poprawić). */
export interface ZatwierdzeniePrzypomnieniaZadanie {
  wersja: string;
  tresc: string;
}

/** 200: przypomnienie zlecone do wysyłki (wychodzi w oknie wysyłki z ustawień przypomnień). */
export interface ZatwierdzeniePrzypomnieniaOdpowiedz {
  zlecone: true;
}

/** `POST /api/mobile/v1/faktury/{id}/wstrzymanie`: wstrzymuje albo wznawia przypomnienia faktury. */
export interface WstrzymanieZadanie {
  wstrzymane: boolean;
}

export interface WstrzymanieOdpowiedz {
  wstrzymane: boolean;
}

/** `GET /api/mobile/v1/faktury/{id}/pdf`, 200: ten sam PDF co na stronie (`/api/invoices/{id}/pdf`), w Base64. */
export interface PdfFakturyOdpowiedz {
  nazwa: string;
  pdfBase64: string;
}

/**
 * `POST /api/mobile/v1/skrzynka/sprawdz`, 200: „Sprawdź teraz” w skrzynce KSeF (najwyżej raz na 5 minut).
 * Faktury pobiera serwer w tle; `komunikat` to zdanie strony.
 */
export interface SprawdzenieSkrzynkiOdpowiedz {
  stan: 'zlecone' | 'w_toku' | 'za_wczesnie' | 'bez_ksef' | 'blad';
  komunikat: string;
  ponowZaSekund: number | null;
}

// ─── Firma i usunięcie konta (M10b) ───────────────────────────────────

/** `POST /api/mobile/v1/firma` (z `X-Active-Org`): firma zapisana jako ostatnio używana, wspólna ze stroną. `zapisane: false`: zapis się nie udał, wybór zostaje na telefonie. */
export interface FirmaZapisanaOdpowiedz {
  aktywnaFirma: string;
  zapisane: boolean;
}

/**
 * `GET /api/mobile/v1/konto/usuniecie`: stan usunięcia konta i to, jak je potwierdzić.
 * `potwierdzenie` z serwera: `haslo` (konto z hasłem) albo `swieze_logowanie` (konto
 * tylko z Google: logowanie w tej sesji nie starsze niż 10 minut, do `swiezeDo`).
 */
export interface UsuniecieKontaOdpowiedz {
  /** Kiedy konto zostanie usunięte (ISO); `null` bez żądania. */
  zaplanowane: string | null;
  potwierdzenie: 'haslo' | 'swieze_logowanie';
  /** Do kiedy świeże logowanie wystarcza (ISO); `null`, gdy nie wystarcza albo konto ma hasło. */
  swiezeDo: string | null;
}

/** `POST /konto/usuniecie` i `POST /konto/usuniecie/anuluj`: hasło tylko przy koncie z hasłem. */
export interface PotwierdzenieKontaZadanie {
  haslo?: string;
}

/** `POST /konto/usuniecie`, 200. `juzBylo`: żądanie już istniało (ponowienie), bez nowego maila. */
export interface UsuniecieZaplanowaneOdpowiedz {
  zaplanowane: string;
  juzBylo: boolean;
  /** Mail z linkiem do anulowania wyszedł. */
  mailWyslany: boolean;
}

/** `POST /konto/usuniecie/anuluj`, 200. `juzBylo`: nie było czego anulować (ponowienie). */
export interface AnulowanieUsunieciaOdpowiedz {
  anulowane: true;
  juzBylo: boolean;
}

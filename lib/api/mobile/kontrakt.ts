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
 * Zapis z telefonu (M8 `POST /faktury`, M9 `POST /wydatki/zdjecie`): UUID
 * wylosowany raz na wypełnienie formularza albo jedno zdjęcie. Ponowienie
 * z tym samym kluczem i tą samą treścią oddaje wynik pierwszego zapisu (bez
 * drugiej faktury, drugiej wysyłki, drugiego odczytu i drugiego kosztu).
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
  /**
   * 400, 413, 415: `POST /wydatki/zdjecie` (M9): brak pliku, plik nie jest zdjęciem ani PDF albo jest za duży.
   * `message` mówi, co zrobić; ponowienie tego samego pliku nic nie zmieni.
   */
  'file_invalid',
  /** 400, 408: `POST /wydatki/zdjecie` (M9): nie dotarł cały plik albo wysyłka trwała za długo. Ponów z tym samym kluczem. */
  'upload_incomplete',
  /** 422: `POST /wydatki/{id}/zatwierdzenie` (M9): zasada zapisu kosztu (waluta, KPiR, koszt z KSeF); `message` mówi co zrobić. */
  'expense_invalid',
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
  /** Kolejny numer po ostatniej fakturze (jak `suggestNextInvoiceNumberForTenant`); `null`: firma bez faktur. */
  numer: string | null;
  /** Dziś w Polsce, RRRR-MM-DD: data wystawienia faktury wysyłanej do KSeF. */
  dzis: string;
  /** Firma zwolniona z VAT (art. 113): nowa pozycja startuje ze stawką „zw”. */
  zwolnienieVat: boolean;
}

// ─── Wydatki (M9): wydatek ze zdjęcia ─────────────────────────────────

/** `POST /api/mobile/v1/wydatki/zdjecie`: pole formularza `multipart/form-data` z plikiem (JPG, PNG, WEBP, GIF albo PDF). */
export const MOBILE_EXPENSE_FILE_FIELD = 'plik';

/**
 * `POST /api/mobile/v1/wydatki/zdjecie` (z nagłówkiem `Idempotency-Key`): 201 nowe wgranie,
 * 200 powtórzenie (ten sam klucz i ten sam plik). `odczyt.id` to zadanie odczytu (OCR) do
 * `GET /wydatki/odczyt/{id}`; wydatek z odczytu zapisuje serwer.
 */
export interface WgranieWydatkuOdpowiedz {
  odczyt: { id: string };
  powtorzenie: boolean;
}

/** Stan zadania odczytu jak kolumna `ocr_jobs.status`. */
export type StanOdczytu = 'pending' | 'processing' | 'completed' | 'failed';

/**
 * `GET /api/mobile/v1/wydatki/odczyt/{id}`: 200 ze stanem. `wydatekId` przy `completed`;
 * `blad` przy `failed` (zdanie z odczytu). 404 `not_found`: zadania nie ma (koniec czekania);
 * 503: stan nieznany, pytaj dalej (nie wgrywaj zdjęcia drugi raz).
 */
export interface OdczytWydatkuOdpowiedz {
  odczyt: { id: string; stan: StanOdczytu; wydatekId: string | null; blad: string | null };
}

/** Kolumna KPiR jak enum `kpir_column` (ta sama lista co formularz kosztu na stronie). */
export type KolumnaKpirTelefonu = 'col_7' | 'col_8' | 'col_10' | 'col_11' | 'col_12' | 'col_13' | 'col_15' | 'col_16';

/**
 * Zmiany kosztu jak formularz kosztu strony (`ExpenseEditForm`, `ExpenseReviewUpdates`):
 * kwoty w złotych do 2 miejsc, data RRRR-MM-DD, NIP same cyfry albo `null`.
 * `confirmPlnAmounts` tylko przy dokumencie w walucie bez kursu NBP: klient wpisał złote.
 */
export interface ZmianyWydatkuTelefonu {
  seller_name: string;
  seller_nip: string | null;
  document_number?: string;
  issue_date: string;
  net_amount: number;
  vat_amount: number;
  gross_amount: number;
  kpir_column: KolumnaKpirTelefonu;
  category_label: string;
  is_deductible: boolean;
  notes?: string;
  confirmPlnAmounts?: boolean;
}

/** `POST /api/mobile/v1/wydatki/{id}/zatwierdzenie`: opis i akceptacja kosztu ze zdjęcia (nie z KSeF). */
export interface ZatwierdzenieWydatkuZadanie {
  zmiany: ZmianyWydatkuTelefonu;
}

/**
 * `POST /api/mobile/v1/wydatki/{id}/zatwierdzenie`, 200. `opisany: false`, gdy koszt został
 * poza KPiR do wyjaśnienia (kwoty w walucie bez potwierdzenia złotych). Ponowienie zapisuje
 * to samo drugi raz (bez drugiego kosztu), więc nie potrzebuje klucza.
 */
export interface ZatwierdzenieWydatkuOdpowiedz {
  wydatek: { id: string; opisany: boolean; wKpir: boolean };
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

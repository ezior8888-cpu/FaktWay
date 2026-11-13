/**
 * Kontrakt API aplikacji na telefon (`/api/mobile/v1`, plan aplikacji
 * mobilnej 4.1 i 4.3, decyzja M6): nagłówki, kody błędów i kształty odpowiedzi
 * w jednym miejscu dla serwera i aplikacji.
 *
 * BEZ IMPORTÓW: ten plik czyta też aplikacja w `mobile/` (od M7, przez Metro),
 * więc nie może ciągnąć kodu serwera, Supabase ani Nexta. Pilnuje tego
 * `tests/unit/mobile-api-kontrakt.test.ts`. Schematy Zod treści żądań (od M8)
 * potrzebują importu `zod`, więc dostaną osobny plik obok; jak trafi do
 * aplikacji, rozstrzyga M8.
 */

/** Firma, w której telefon działa, przy trasach z danymi firmy (jak ciasteczko aktywnej firmy na stronie, `ACTIVE_ORG_COOKIE`). */
export const MOBILE_ACTIVE_ORG_HEADER = 'X-Active-Org';

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
  /** 500, opis z identyfikatorem żądania. */
  'internal_error',
] as const;

export type MobileApiErrorCode = (typeof MOBILE_API_ERROR_CODES)[number];

/** Każda odmowa: stały kod po angielsku, po którym telefon wybiera swój tekst, i opis po polsku. */
export interface MobileApiError {
  error: { code: MobileApiErrorCode; message: string };
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
 * `POST /api/mobile/v1/logowanie`, 200: sesja GoTrue dla `supabase.auth.setSession`. Odświeżanie,
 * kod 2FA i wylogowanie telefon robi dalej sam w GoTrue (bez captchy). `wymagaKodu`: konto ma
 * zweryfikowany TOTP, a sesja jest jeszcze na poziomie `aal1` (ta sama reguła co strona).
 */
export interface LogowanieOdpowiedz {
  sesja: { accessToken: string; refreshToken: string };
  wymagaKodu: boolean;
}

/** `POST /api/mobile/v1/sesja`: 201 `{ zapisane: true }` przy pierwszym wywołaniu dla sesji, potem 200 `{ zapisane: false }`. */
export interface SesjaOdpowiedz {
  zapisane: boolean;
}

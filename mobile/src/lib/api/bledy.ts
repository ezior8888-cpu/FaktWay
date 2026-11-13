/**
 * Odmowa API aplikacji na to, co telefon robi dalej (plan aplikacji 4.3,
 * „Stan po M6”). Bez React Native: testy w `tests/unit/mobile-api-klient.test.ts`.
 *
 * - `sesja` (401 `missing_token`, `invalid_token`): odświeżenie sesji i jedno
 *   ponowienie; koniec sesji w telefonie dopiero po nieudanym odświeżeniu.
 * - `kod` (403 `mfa_required`): konto ma 2FA, a ta sesja nie ma kodu.
 * - `firma` (400 `missing_org`, 403 `no_active_org`): wybór firmy od nowa.
 * - `ponow` (429, 503): spróbować później. Nigdy wylogowanie: awaria GoTrue
 *   to 503, nie 401.
 * - `polaczenie`: brak internetu albo serwer nie odpowiedział.
 * - `serwer`: 500 albo odpowiedź spoza kontraktu.
 */
import { MOBILE_API_ERROR_CODES, type MobileApiErrorCode } from './kontrakt';

export type RodzajBledu = 'sesja' | 'kod' | 'firma' | 'ponow' | 'polaczenie' | 'serwer';

export type BladApi = {
  rodzaj: RodzajBledu;
  /** Kod z kontraktu, gdy serwer go podał. */
  kod?: MobileApiErrorCode;
  /** Status HTTP; 0 bez odpowiedzi. */
  status: number;
  /** Z nagłówka `Retry-After` (429, 503). */
  ponowZaSekund?: number;
  /** Zdanie dla klienta: co się stało i co zrobić. */
  komunikat: string;
};

export const KOMUNIKATY: Record<RodzajBledu, string> = {
  sesja: 'Sesja wygasła. Zaloguj się ponownie.',
  kod: 'Wpisz kod z aplikacji do 2FA, żeby dalej korzystać z konta.',
  firma: 'Nie masz już dostępu do tej firmy. Wybierz firmę jeszcze raz.',
  ponow: 'FaktWay jest chwilowo niedostępny. Spróbuj ponownie za chwilę.',
  polaczenie: 'Nie możemy się połączyć. Sprawdź internet i spróbuj ponownie.',
  serwer: 'Coś poszło nie tak po stronie FaktWay. Spróbuj ponownie za chwilę.',
};

/** Dokładniejsze teksty dla kodów, które klient rozpozna. */
const KOMUNIKATY_KODOW: Partial<Record<MobileApiErrorCode, string>> = {
  maintenance: 'Trwa przerwa techniczna FaktWay. Spróbuj ponownie za kilka minut.',
  rate_limited: 'Za dużo zapytań w krótkim czasie. Spróbuj ponownie za chwilę.',
};

const RODZAJ_KODU: Record<MobileApiErrorCode, RodzajBledu> = {
  missing_token: 'sesja',
  invalid_token: 'sesja',
  mfa_required: 'kod',
  missing_org: 'firma',
  no_active_org: 'firma',
  rate_limited: 'ponow',
  maintenance: 'ponow',
  session_verification_failed: 'ponow',
  service_unavailable: 'ponow',
  internal_error: 'serwer',
};

/** Kod błędu z ciała `{ error: { code } }`, gdy jest w kontrakcie. */
export function kodBledu(cialo: unknown): MobileApiErrorCode | undefined {
  if (typeof cialo !== 'object' || cialo === null) return undefined;
  const blad = (cialo as { error?: unknown }).error;
  if (typeof blad !== 'object' || blad === null) return undefined;
  const kod = (blad as { code?: unknown }).code;
  return (MOBILE_API_ERROR_CODES as readonly unknown[]).includes(kod) ? (kod as MobileApiErrorCode) : undefined;
}

/** Bez kodu z kontraktu (np. odpowiedź bramki przed aplikacją) decyduje sam status. */
export function rodzajBledu(status: number, kod?: MobileApiErrorCode): RodzajBledu {
  if (kod) return RODZAJ_KODU[kod];
  if (status === 0) return 'polaczenie';
  if (status === 401) return 'sesja';
  if (status === 429 || status === 502 || status === 503 || status === 504) return 'ponow';
  return 'serwer';
}

/** `Retry-After` w sekundach (liczba albo data HTTP); `undefined`, gdy brak albo nieczytelny. */
export function sekundyPonowienia(naglowek: string | null | undefined, teraz = Date.now()): number | undefined {
  if (!naglowek) return undefined;
  const liczba = Number(naglowek);
  if (Number.isFinite(liczba) && liczba >= 0) return Math.ceil(liczba);
  const data = Date.parse(naglowek);
  return Number.isNaN(data) ? undefined : Math.max(0, Math.ceil((data - teraz) / 1000));
}

export function bladApi(status: number, cialo: unknown, retryAfter?: string | null): BladApi {
  const kod = kodBledu(cialo);
  const rodzaj = rodzajBledu(status, kod);
  return {
    rodzaj,
    kod,
    status,
    ponowZaSekund: sekundyPonowienia(retryAfter),
    komunikat: (kod && KOMUNIKATY_KODOW[kod]) || KOMUNIKATY[rodzaj],
  };
}

/** Błąd bez odpowiedzi serwera (sieć) albo z własnej decyzji telefonu. */
export function bladTelefonu(rodzaj: RodzajBledu, komunikat = KOMUNIKATY[rodzaj]): BladApi {
  return { rodzaj, status: 0, komunikat };
}

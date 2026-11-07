/**
 * Komunikaty biometrii po polsku. Końcówki zwracają stałe kody, a błąd okna
 * systemowego przychodzi jako `WebAuthnError` albo `DOMException`. Bez `server-only`:
 * czytają to komponenty klienckie.
 */

export type PasskeyCeremony = 'login' | 'registration';

const SERVER_MESSAGES: Record<string, string> = {
  passkey_login_failed: 'Nie udało się zalogować biometrią. Jeśli to urządzenie nie jest już dodane do konta, zaloguj się hasłem.',
  session_unavailable: 'Nie możemy teraz dokończyć logowania. Spróbuj ponownie za chwilę.',
  passkey_unavailable: 'Logowanie biometrią jest chwilowo niedostępne. Spróbuj ponownie później albo zaloguj się hasłem.',
  origin_not_allowed: 'Otwórz FaktWay pod właściwym adresem i spróbuj ponownie.',
  rate_limited: 'Zbyt wiele prób. Poczekaj chwilę i spróbuj ponownie.',
  invalid_request: 'Nie udało się odczytać odpowiedzi urządzenia. Spróbuj ponownie.',
  not_authenticated: 'Sesja wygasła. Zaloguj się ponownie.',
  session_verification_failed: 'Nie udało się zweryfikować sesji. Spróbuj ponownie za chwilę.',
  mfa_required: 'Ta operacja wymaga kodu z aplikacji uwierzytelniającej.',
  passkey_registration_failed: 'Nie udało się dodać urządzenia. Spróbuj ponownie.',
  already_registered: 'To urządzenie jest już dodane do Twojego konta.',
  too_many_passkeys: 'Masz już 10 urządzeń. Usuń któreś, żeby dodać nowe.',
  not_found: 'Tego urządzenia nie ma już na liście. Odśwież stronę.',
};

const FALLBACK: Record<PasskeyCeremony, string> = {
  login: 'Nie udało się użyć biometrii. Spróbuj ponownie albo zaloguj się hasłem.',
  registration: 'Nie udało się dodać urządzenia. Spróbuj ponownie.',
};

const CANCELLED: Record<PasskeyCeremony, string> = {
  login: 'Logowanie biometrią zostało anulowane albo czas minął. Spróbuj ponownie albo zaloguj się hasłem.',
  registration: 'Dodawanie urządzenia zostało anulowane albo czas minął. Spróbuj ponownie.',
};

const UNSUPPORTED = 'To urządzenie nie obsługuje logowania biometrią.';
const WRONG_ADDRESS = 'Biometria działa tylko pod głównym adresem FaktWay. Otwórz właściwy adres albo zaloguj się hasłem.';

export const PASSKEY_NETWORK_ERROR = 'Brak połączenia. Sprawdź internet i spróbuj ponownie.';

/** Telefon bez zapamiętanego klucza: przycisk logowania prowadzi do podpowiedzi przy klawiaturze. */
export const PASSKEY_SUGGESTION_HINT =
  'Wybierz swój klucz w podpowiedzi przy klawiaturze. Jeśli jej nie ma, zaloguj się hasłem.';

/** Telefon ma już klucz konta (system odmówił dodania drugiego albo serwer już go zna). */
export const PASSKEY_ALREADY_ON_DEVICE_MESSAGE =
  'To urządzenie ma już klucz do Twojego konta. Przy następnym logowaniu dotknij „Zaloguj biometrią”.';

export function passkeyServerMessage(code: string, ceremony: PasskeyCeremony): string {
  return SERVER_MESSAGES[code] ?? FALLBACK[ceremony];
}

/** `null`: przerwane przez nas (nowa próba, zmiana strony), klient nie ma czego czytać. */
export function passkeyBrowserErrorMessage(error: unknown, ceremony: PasskeyCeremony): string | null {
  const { name, code } = (error ?? {}) as { name?: string; code?: string };
  if (name === 'AbortError' || code === 'ERROR_CEREMONY_ABORTED') return null;
  if (code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED') return SERVER_MESSAGES.already_registered!;
  if (name === 'SecurityError' || code === 'ERROR_INVALID_RP_ID' || code === 'ERROR_INVALID_DOMAIN') return WRONG_ADDRESS;
  if (
    name === 'NotSupportedError' || name === 'ConstraintError'
    || code === 'ERROR_AUTHENTICATOR_MISSING_DISCOVERABLE_CREDENTIAL_SUPPORT'
    || code === 'ERROR_AUTHENTICATOR_MISSING_USER_VERIFICATION_SUPPORT'
  ) return UNSUPPORTED;
  if (name === 'NotAllowedError') return CANCELLED[ceremony];
  return FALLBACK[ceremony];
}

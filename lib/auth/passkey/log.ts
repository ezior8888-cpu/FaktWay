import 'server-only';

/**
 * Ślad po błędzie logowania i rejestracji biometrią. Do logu idą WYŁĄCZNIE etap
 * i nazwa klasy błędu: nie treść wyjątku (biblioteka WebAuthn cytuje w niej origin
 * i fragmenty asercji), nie e-mail, identyfikator konta ani poświadczenia, nie klucz
 * i nie wyzwanie. Odpowiedź dla klienta zostaje jednym kodem, bez ujawniania,
 * czy konto istnieje.
 *
 * Zwykła odmowa (nieznany klucz, wyzwanie po terminie, zablokowane konto, urządzenie
 * już dodane) NIE jest błędem i tu nie trafia. Wpis znaczy: wyjątek biblioteki albo
 * awaria po naszej stronie (baza, GoTrue), czyli np. zła konfiguracja RP ID po zmianie
 * domeny, która inaczej wyglądałaby jak „użytkownicy mylą palec”.
 */

export type PasskeyFlow = 'login' | 'registration';

/** Nazwa klasy błędu ma wyglądać jak identyfikator; nic innego nie trafi do logu. */
const CLASS_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

function errorName(error: unknown): string {
  if (error === undefined || error === null) return 'none';
  const name = typeof error === 'object' && 'name' in error ? (error as { name: unknown }).name : undefined;
  return typeof name === 'string' && CLASS_NAME.test(name) ? name : 'unknown';
}

/** `error` pomijamy, gdy odrzucenie nie ma wyjątku (np. biblioteka zwróciła `verified: false`). */
export function logPasskeyFailure(flow: PasskeyFlow, stage: string, error?: unknown): void {
  console.error(`[passkey] ${flow}_failed`, { stage, errorName: errorName(error) });
}

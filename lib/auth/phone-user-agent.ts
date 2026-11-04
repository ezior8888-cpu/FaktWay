/**
 * Telefon, nie tablet: `Android` bez `Mobile` w UA to tablet, podobnie iPad.
 * Czyta to ekran logowania („Zapamiętaj mnie”, propozycja biometrii). Dawna
 * bramka telefonów w proxy zniknęła z FaktWay 1.0: panel działa na każdym
 * urządzeniu, a ta funkcja zostaje tylko do doboru domyślnych ustawień
 * logowania.
 */
const PHONE_UA_RE = /iPhone|iPod|Windows Phone|Android(?=.*\bMobile\b)/i;

export function isPhoneUserAgent(userAgent: string | null | undefined): boolean {
  return typeof userAgent === 'string' && PHONE_UA_RE.test(userAgent);
}

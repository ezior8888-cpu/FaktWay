/**
 * Zapisy w przeglądarce związane z logowaniem na tym urządzeniu. Bez `server-only`:
 * stałe czyta też propozycja biometrii w przeglądarce i polityka cookies. Nowy zapis
 * to nowy wiersz w `lib/legal/documents/polityka-cookies.ts`.
 *
 * `ksef.passkey_session`: znacznik logowania biometrią (podpis: `lib/auth/passkey/session-marker.ts`).
 *
 * `ksef.remember_me`: „Zapamiętaj mnie” na 90 dni. Działa wyłącznie po stronie
 * panelu: przy nim `IdleWatcher` nie wylogowuje po godzinie bezczynności. Sesję
 * i tak trzyma GoTrue (refresh token) i ciasteczko Supabase; samo to ciasteczko
 * niczego nie otwiera, więc nie musi mieć podpisu.
 *
 * `ksef.passkey_offer`: jednorazowa propozycja „Włącz logowanie biometrią” po
 * logowaniu hasłem na telefonie. Bez httpOnly, bo kasuje je komponent po pokazaniu.
 */

export const PASSKEY_SESSION_COOKIE = 'ksef.passkey_session';

export const REMEMBER_ME_COOKIE = 'ksef.remember_me';
export const REMEMBER_ME_VALUE = '1';
export const REMEMBER_ME_MAX_AGE_SECONDS = 90 * 24 * 60 * 60;

export const PASSKEY_OFFER_COOKIE = 'ksef.passkey_offer';
export const PASSKEY_OFFER_MAX_AGE_SECONDS = 60 * 60;
export const PASSKEY_OFFER_DISMISSED_KEY = 'faktway.passkey_offer_dismissed';
/** Identyfikatory kluczy biometrii z tego telefonu (`lib/auth/passkey/client.ts`). */
export const PASSKEY_DEVICE_KEYS_KEY = 'faktway.passkey_device_keys';

function baseOptions() {
  return {
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
  };
}

export function rememberMeCookieOptions() {
  return { ...baseOptions(), httpOnly: true, maxAge: REMEMBER_ME_MAX_AGE_SECONDS };
}

export function passkeyOfferCookieOptions() {
  return { ...baseOptions(), httpOnly: false, maxAge: PASSKEY_OFFER_MAX_AGE_SECONDS };
}

/** Czyści wybór sprzed tego logowania: odznaczone pole ma działać od razu. */
export function clearedCookieOptions() {
  return { ...baseOptions(), httpOnly: true, maxAge: 0 };
}

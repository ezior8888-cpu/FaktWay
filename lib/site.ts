/**
 * Adres strony i jedyny adres kontaktowy FaktWay (krok 10 planu automatyzacji).
 *
 * Dawniej w kodzie było siedem adresów w dwóch domenach. `ksef-saas.pl` nie
 * jest już zarejestrowana (NASK, 1.10.2026) — każdy mógł ją kupić i odbierać
 * zgłoszenia, żądania RODO i prośby o zwrot. Teraz wszystko idzie na jedną
 * skrzynkę, a test `jeden-adres-kontaktowy` pilnuje, żeby stara domena nie
 * wróciła. Poczta przychodząca: docs/runbooks/skrzynka-pomoc.md.
 *
 * Zmiana domeny na faktway.pl (10.2026): `pomoc@faktflow.pl` przyjmuje
 * pocztę dalej (Cloudflare Email Routing na obu domenach), ale w kodzie jest
 * już tylko nowy adres. Stara domena: `lib/legacy-host-redirect.ts`.
 */

export const SUPPORT_EMAIL = 'pomoc@faktway.pl';

/** Adres strony na dokumentach, które wychodzą poza aplikację (PDF): stały, niezależny od środowiska. */
export const PUBLIC_SITE_DOMAIN = 'faktway.pl';
export const PUBLIC_SITE_URL = `https://${PUBLIC_SITE_DOMAIN}`;

/** Adres strony bez końcowego ukośnika (NEXT_PUBLIC_APP_URL albo faktway.pl). */
export function siteUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL?.trim() || PUBLIC_SITE_URL).replace(/\/+$/, '');
}

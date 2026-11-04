/**
 * Przekierowanie ze starej domeny `faktflow.pl` na `faktway.pl` (zmiana marki,
 * 10.2026). Wyłączone, dopóki `LEGACY_HOST_REDIRECT=1` nie trafi do zmiennych
 * aplikacji w Coolify — włącza się je dopiero po teście odbiorczym nowej
 * domeny (etap E8 planu w `docs/rebrand/FAKTWAY.md`).
 *
 * Tylko GET i HEAD, kod 308, ta sama ścieżka i parametry. Poza
 * przekierowaniem zostają ścieżki, które na starej domenie muszą dokończyć
 * to, co już się zaczęło:
 *  - `/auth/*`, `/reset-password` — kod PKCE i sesja leżą w ciasteczkach
 *    starego hosta; przekierowanie w połowie logowania albo resetu hasła
 *    zgubiłoby je i klient zostałby wylogowany bez wyjaśnienia;
 *  - `/api/*` — webhooki i wywołania z otwartych kart (POST i tak omijamy);
 *  - `/sw.js`, `/manifest.webmanifest` — przeglądarka nie aktualizuje
 *    service workera przez przekierowanie, stary zostałby na zawsze;
 *  - `/ingest`, `/monitoring` — tunele PostHog i Sentry.
 */

const LEGACY_HOSTS = new Set(['faktflow.pl', 'www.faktflow.pl']);

const EXEMPT_PREFIXES = ['/auth', '/reset-password', '/api', '/ingest', '/monitoring'] as const;
const EXEMPT_EXACT = new Set(['/sw.js', '/manifest.webmanifest']);

export function isLegacyHostRedirectEnabled(): boolean {
  return process.env.LEGACY_HOST_REDIRECT?.trim() === '1';
}

function isExempt(pathname: string): boolean {
  if (EXEMPT_EXACT.has(pathname)) return true;
  return EXEMPT_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/** Host żądania bez portu, małymi literami (za Traefikiem: `x-forwarded-host`). */
export function requestHost(headers: Headers): string {
  const raw = headers.get('x-forwarded-host') ?? headers.get('host') ?? '';
  return raw.split(',')[0].trim().toLowerCase().replace(/:\d+$/, '');
}

/**
 * Adres docelowy albo `null`, gdy żądanie zostaje na miejscu. `target` to adres
 * strony (`siteUrl()`); gdy wskazuje starą domenę, nic nie przekierowujemy —
 * inaczej powstałaby pętla.
 */
export function legacyHostRedirectTarget(input: {
  method: string;
  host: string;
  pathname: string;
  search: string;
  target: string;
}): string | null {
  const method = input.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return null;
  if (!LEGACY_HOSTS.has(input.host)) return null;
  if (isExempt(input.pathname)) return null;

  let target: URL;
  try {
    target = new URL(input.target);
  } catch {
    return null;
  }
  if (LEGACY_HOSTS.has(target.hostname.toLowerCase())) return null;

  return `${target.origin}${input.pathname}${input.search}`;
}

import { BlockList, isIP } from 'node:net';

/**
 * Ochrona SSRF webhooków (krok 7.1, część 3).
 *
 * Worker wysyła żądania pod adres podany przez klienta, więc adres nie może
 * prowadzić do sieci wewnętrznej (baza, Redis, panel Coolify, metadane chmury
 * 169.254.169.254, usługi na localhost). Trzy warstwy:
 *
 * 1. `checkWebhookUrl` (przy dodaniu i przy każdej wysyłce): tylko `https://`,
 *    port 443, nazwa domeny (bez adresu IP), bez danych logowania i fragmentu,
 *    bez nazw lokalnych i zastrzeżonych (`localhost`, `.local`, `.internal`, …).
 * 2. `resolvePublicTarget` (przy dodaniu i przy KAŻDEJ wysyłce): DNS, potem
 *    sprawdzenie WSZYSTKICH adresów; jeden prywatny albo zastrzeżony blokuje całość.
 * 3. Połączenie przypięte do sprawdzonego adresu (`lib/webhooks/transport.ts`):
 *    druga odpowiedź DNS (rebinding) nie zmieni celu, a przekierowań nie śledzimy.
 *
 * Tylko serwer (`node:net`). Opis dla klienta: `/api/docs`, sekcja „Webhooki”.
 */

export type UrlProblem =
  | 'invalid'
  | 'too_long'
  | 'not_https'
  | 'credentials'
  | 'port'
  | 'fragment'
  | 'ip_literal'
  | 'hostname';

export type UrlCheck =
  | { ok: true; href: string; hostname: string }
  | { ok: false; problem: UrlProblem; message: string };

const MAX_URL_LENGTH = 2048;

const PROBLEM_MESSAGES: Record<UrlProblem, string> = {
  invalid: 'To nie jest poprawny adres. Wpisz pełny adres, np. https://twoj-serwer.pl/faktway.',
  too_long: 'Adres może mieć najwyżej 2048 znaków.',
  not_https: 'Adres musi zaczynać się od https://. FaktWay nie wysyła zdarzeń bez szyfrowania.',
  credentials: 'Adres nie może zawierać nazwy użytkownika ani hasła. Do sprawdzenia nadawcy służy podpis FaktWay-Signature.',
  port: 'Adres musi używać standardowego portu HTTPS 443. Usuń z adresu numer portu.',
  fragment: 'Adres nie może zawierać części po znaku #.',
  ip_literal: 'Podaj adres z nazwą domeny, nie adres IP.',
  hostname: 'Adres musi mieć publiczną nazwę domeny. Nazwy lokalne i wewnętrzne (np. localhost, .local, .internal) nie są dozwolone.',
};

/** Domeny zastrzeżone do użytku lokalnego albo wewnętrznego (RFC 6761, 6762, 7686, 8375; .internal, ICANN 2024). */
const BLOCKED_SUFFIXES = ['localhost', 'local', 'internal', 'test', 'invalid', 'example', 'onion', 'home.arpa', 'arpa', 'lan', 'intranet', 'corp'];

function bad(problem: UrlProblem): UrlCheck {
  return { ok: false, problem, message: PROBLEM_MESSAGES[problem] };
}

export function checkWebhookUrl(raw: string): UrlCheck {
  const input = raw.trim();
  if (input.length > MAX_URL_LENGTH) return bad('too_long');
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return bad('invalid');
  }
  if (url.protocol !== 'https:') return bad('not_https');
  if (url.username || url.password) return bad('credentials');
  if (url.port !== '') return bad('port');
  if (url.hash !== '' || input.includes('#')) return bad('fragment');

  // Parser WHATWG zamienia już 2130706433 i 0x7f.1 na 127.0.0.1, a IPv6 zostawia w nawiasach.
  const hostname = url.hostname;
  if (isIP(hostname) !== 0 || hostname.startsWith('[')) return bad('ip_literal');
  // Etykiety ASCII (po punycode), co najmniej dwie, bez kropki na końcu.
  const labels = hostname.split('.');
  const validLabels = labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
  if (!validLabels || labels.length < 2 || /^\d+$/.test(labels.at(-1)!)) return bad('hostname');
  if (BLOCKED_SUFFIXES.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`))) return bad('hostname');

  const href = url.href;
  if (href.length > MAX_URL_LENGTH) return bad('too_long');
  return { ok: true, href, hostname };
}

// ─── Adresy ──────────────────────────────────────────────────────

/** IPv4 spoza internetu publicznego (rejestr IANA adresów specjalnych). */
const BLOCKED_V4: Array<[string, number]> = [
  ['0.0.0.0', 8], // „ta sieć”
  ['10.0.0.0', 8], // prywatne
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // pętla zwrotna
  ['169.254.0.0', 16], // link-local, metadane chmury
  ['172.16.0.0', 12], // prywatne
  ['192.0.0.0', 24], // protokoły IETF
  ['192.0.2.0', 24], // dokumentacja
  ['192.88.99.0', 24], // dawny 6to4
  ['192.168.0.0', 16], // prywatne
  ['198.18.0.0', 15], // testy wydajności
  ['198.51.100.0', 24], // dokumentacja
  ['203.0.113.0', 24], // dokumentacja
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // zarezerwowane, broadcast
];

/**
 * IPv6: przepuszczamy tylko globalny unicast 2000::/3 (wszystko poza nim, w tym
 * ::1, fc00::/7, fe80::/10, ff00::/8, ::ffff:0:0/96 i 64:ff9b::/96, odpada),
 * a w nim blokujemy zakresy specjalne.
 */
const GLOBAL_V6: Array<[string, number]> = [['2000::', 3]];
const BLOCKED_V6: Array<[string, number]> = [
  ['2001::', 23], // protokoły IETF (Teredo, testy, ORCHID)
  ['2001:db8::', 32], // dokumentacja
  ['2002::', 16], // 6to4 (zawiera adres IPv4)
  ['3fff::', 20], // dokumentacja
];

function blockList(entries: Array<[string, number]>, family: 'ipv4' | 'ipv6'): BlockList {
  const list = new BlockList();
  for (const [network, prefix] of entries) list.addSubnet(network, prefix, family);
  return list;
}

const BLOCKED_V4_LIST = blockList(BLOCKED_V4, 'ipv4');
const GLOBAL_V6_LIST = blockList(GLOBAL_V6, 'ipv6');
const BLOCKED_V6_LIST = blockList(BLOCKED_V6, 'ipv6');

/** Czy adres jest publiczny (wolno się z nim połączyć). Wszystko niepewne = nie. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !BLOCKED_V4_LIST.check(address, 'ipv4');
  if (family === 6) {
    // `fe80::1%eth0`: adres ze strefą to zawsze sieć lokalna.
    if (address.includes('%')) return false;
    return GLOBAL_V6_LIST.check(address, 'ipv6') && !BLOCKED_V6_LIST.check(address, 'ipv6');
  }
  return false;
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

export type ResolvedTarget =
  | { ok: true; address: string; family: 4 | 6 }
  | { ok: false; reason: 'dns' | 'blocked_address' };

/** DNS i sprawdzenie wszystkich adresów. Wynik: pierwszy adres, z którym łączy się transport. */
export async function resolvePublicTarget(hostname: string, resolve: Resolver): Promise<ResolvedTarget> {
  let addresses: ResolvedAddress[];
  try {
    addresses = await resolve(hostname);
  } catch {
    return { ok: false, reason: 'dns' };
  }
  if (addresses.length === 0) return { ok: false, reason: 'dns' };
  if (!addresses.every((entry) => isPublicAddress(entry.address))) return { ok: false, reason: 'blocked_address' };
  const [first] = addresses;
  return { ok: true, address: first!.address, family: first!.family };
}

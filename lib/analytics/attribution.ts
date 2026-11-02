import { siteUrl } from '@/lib/site';

import {
  ANALYTICS_CONSENT_EVENT,
  CONSENT_KEY,
  getAnalyticsConsent,
  isAnalyticsConfigured,
  markAnalyticsConsentDelivered,
  readAnalyticsConsentRecord,
} from './consent';
import {
  isPublicEntryPath,
  sanitizeFirstTouch,
  sanitizeLandingPath,
  sanitizeReferrerHost,
  sanitizeUtmValue,
  type AttributionChannel,
  type FirstTouch,
} from './privacy';

/**
 * Źródło wejścia (FAKTWAY-1-0, sekcja 3 pkt 7): pierwszy dotyk zapisany dopiero
 * po zgodzie. Przed zgodą adres z chwili wejścia siedzi wyłącznie w pamięci karty,
 * bo art. 399 PKE dotyczy zapisu w urządzeniu, a klik „Akceptuję” często pada
 * dopiero po przejściu na inną podstronę. Ciasteczko czyta serwer przy rejestracji
 * (hasłem i przez Google) i dla anonimowego gościa jest też dowodem zgody, więc
 * dowodzi tylko wyboru, który nie dotarł jeszcze na konto: powstaje z kliknięcia,
 * rejestracja je zużywa, a dostarczenie wyboru na konto albo odwołanie kasuje.
 * Inaczej kolejna osoba przy wspólnym komputerze dostałaby cudze „tak”.
 * Lista pól: lib/analytics/privacy.ts.
 */
export const ATTRIBUTION_COOKIE = 'ff_first_touch';
export const ATTRIBUTION_COOKIE_MAX_AGE_SECONDS = 90 * 24 * 60 * 60;
/**
 * Wartość ciasteczka po rejestracji: sam znacznik, że wybór trafił na konto, bez
 * danych. Serwer nie zmieni localStorage, więc tak mówi przeglądarce, że ma uznać
 * wybór za dostarczony. Nie jest JSON-em, więc `decodeFirstTouch` nie widzi w nim dowodu.
 */
export const ATTRIBUTION_COOKIE_DELIVERED = 'delivered';

// Dawna domena też jest „nasza”: stare linki przekierowują na nową (lib/legacy-host-redirect.ts).
const OWN_DOMAINS = ['faktway.pl', 'faktflow.pl'];
// Powroty z logowania i płatności to nie źródło wejścia.
const FLOW_DOMAINS = ['accounts.google.com', 'checkout.stripe.com', 'billing.stripe.com', 'challenges.cloudflare.com'];

const SEARCH_DOMAINS = [
  'bing.com', 'duckduckgo.com', 'yahoo.com', 'ecosia.org', 'search.brave.com', 'startpage.com', 'qwant.com',
  'szukaj.wp.pl', 'szukaj.onet.pl',
];
const YOUTUBE_DOMAINS = ['youtube.com', 'youtu.be'];
const TIKTOK_DOMAINS = ['tiktok.com'];
const SOCIAL_DOMAINS = [
  'facebook.com', 'fb.com', 'messenger.com', 'instagram.com', 'linkedin.com', 'lnkd.in', 'x.com', 't.co', 'twitter.com',
  'wykop.pl', 'reddit.com', 'threads.net', 'pinterest.com', 'whatsapp.com', 't.me',
];
const SOCIAL_SOURCES = new Set([
  'facebook', 'fb', 'meta', 'messenger', 'instagram', 'ig', 'linkedin', 'twitter', 'x',
  'wykop', 'reddit', 'threads', 'pinterest', 'whatsapp', 'telegram',
]);
const SEARCH_SOURCES = new Set(['google', 'bing', 'duckduckgo', 'yahoo', 'ecosia', 'brave']);
const PAID_MEDIUMS = new Set(['cpc', 'ppc', 'paid', 'paidsearch', 'paid_search', 'paid-search', 'sem', 'display']);
const REFERRAL_MEDIUMS = new Set(['referral', 'ref', 'affiliate', 'partner']);
const SOCIAL_MEDIUMS = new Set(['social', 'social-media', 'social_media', 'sm']);

function hostIn(host: string, domains: readonly string[]): boolean {
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

/** google.pl, www.google.com, google.co.uk, bez usług Google, które nie są wyszukiwarką. */
function isGoogleSearch(host: string): boolean {
  return /^(?:www\.)?google\.[a-z]{2,3}(?:\.[a-z]{2})?$/.test(host);
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Host odsyłacza do zapisu albo null: brak, nie http(s), własna domena, powrót z logowania lub płatności. */
function externalReferrerHost(referrer: string | null | undefined, ownHosts: readonly string[]): string | null {
  if (!referrer) return null;
  let url: URL;
  try {
    url = new URL(referrer);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = sanitizeReferrerHost(url.hostname);
  if (!host || hostIn(host, ownHosts) || hostIn(host, FLOW_DOMAINS)) return null;
  return host;
}

function channelFromCampaign(source: string, medium: string): AttributionChannel {
  if (PAID_MEDIUMS.has(medium) && (source === 'google' || source.startsWith('adwords') || source === 'gads')) {
    return 'google_ads';
  }
  if (source === 'youtube' || source === 'yt') return 'youtube';
  if (source === 'tiktok' || source === 'tt') return 'tiktok';
  if (PAID_MEDIUMS.has(medium)) return SOCIAL_SOURCES.has(source) ? 'social' : 'other';
  if (SOCIAL_SOURCES.has(source) || SOCIAL_MEDIUMS.has(medium)) return 'social';
  if (medium === 'organic' || SEARCH_SOURCES.has(source)) return 'organic_search';
  if (REFERRAL_MEDIUMS.has(medium)) return 'referral';
  return 'other';
}

function channelFromReferrer(host: string | null): AttributionChannel {
  if (!host) return 'direct';
  if (isGoogleSearch(host) || hostIn(host, SEARCH_DOMAINS)) return 'organic_search';
  if (hostIn(host, YOUTUBE_DOMAINS)) return 'youtube';
  if (hostIn(host, TIKTOK_DOMAINS)) return 'tiktok';
  if (hostIn(host, SOCIAL_DOMAINS)) return 'social';
  return 'referral';
}

/**
 * Pierwszy dotyk z adresu i odsyłacza. Obecność identyfikatora kliknięcia wskazuje
 * kanał (autotagowanie Google Ads nie dodaje utm), ale sama wartość nigdzie nie trafia.
 */
export function parseFirstTouch(input: {
  url: string;
  referrer?: string | null;
  now?: Date;
  ownHosts?: readonly string[];
}): FirstTouch {
  const url = new URL(input.url);
  const params = url.searchParams;
  const ownHosts = [...OWN_DOMAINS, hostOf(siteUrl()), ...(input.ownHosts ?? [])]
    .filter((host): host is string => Boolean(host));

  const utm = {
    utm_source: sanitizeUtmValue(params.get('utm_source')),
    utm_medium: sanitizeUtmValue(params.get('utm_medium')),
    utm_campaign: sanitizeUtmValue(params.get('utm_campaign')),
    utm_term: sanitizeUtmValue(params.get('utm_term')),
    utm_content: sanitizeUtmValue(params.get('utm_content')),
  };
  const referrerHost = externalReferrerHost(input.referrer, ownHosts);

  let channel: AttributionChannel;
  if (params.has('gclid') || params.has('gbraid') || params.has('wbraid')) channel = 'google_ads';
  else if (params.has('ttclid')) channel = 'tiktok';
  else if (utm.utm_source || utm.utm_medium) {
    channel = channelFromCampaign((utm.utm_source ?? '').toLowerCase(), (utm.utm_medium ?? '').toLowerCase());
  } else if (params.has('fbclid')) channel = 'social';
  else if (params.has('msclkid')) channel = 'other';
  else channel = channelFromReferrer(referrerHost);

  const touch: FirstTouch = { channel, at: (input.now ?? new Date()).toISOString().slice(0, 10) };
  for (const [field, value] of Object.entries(utm) as Array<[keyof typeof utm, string | null]>) {
    if (value) touch[field] = value;
  }
  if (referrerHost) touch.referrer_host = referrerHost;
  const landing = sanitizeLandingPath(url.pathname);
  if (landing) touch.landing_path = landing;
  return touch;
}

export function encodeFirstTouch(touch: FirstTouch): string {
  return encodeURIComponent(JSON.stringify(touch));
}

/** Ciasteczko da się podrobić: zwraca tylko pola z listy, a wadliwy zapis to brak zapisu. */
export function decodeFirstTouch(value: string | undefined | null): FirstTouch | null {
  if (!value) return null;
  try {
    return sanitizeFirstTouch(JSON.parse(decodeURIComponent(value)));
  } catch {
    return null;
  }
}

// ─── Przeglądarka ────────────────────────────────────────────────────────

/** Dotyk z chwili wejścia, tylko w pamięci karty, do czasu zgody. */
let pendingTouch: FirstTouch | null = null;

function captureFromLocation(): FirstTouch | null {
  try {
    return parseFirstTouch({
      url: window.location.href,
      referrer: document.referrer,
      ownHosts: [window.location.hostname],
    });
  } catch {
    return null;
  }
}

function storedTouch(): string | null {
  const prefix = `${ATTRIBUTION_COOKIE}=`;
  const part = document.cookie.split(';').map((p) => p.trim()).find((p) => p.startsWith(prefix));
  return part === undefined ? null : part.slice(prefix.length);
}

function persistTouch(): void {
  if (storedTouch() !== null || !isAnalyticsConfigured() || !isPublicEntryPath(window.location.pathname)) return;
  pendingTouch ??= captureFromLocation();
  if (!pendingTouch) return;
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${ATTRIBUTION_COOKIE}=${encodeFirstTouch(pendingTouch)}; Max-Age=${ATTRIBUTION_COOKIE_MAX_AGE_SECONDS}; Path=/; SameSite=Lax${secure}`;
}

function eraseTouch(): void {
  if (storedTouch() === null) return;
  document.cookie = `${ATTRIBUTION_COOKIE}=; Max-Age=0; Path=/; SameSite=Lax`;
}

function isUndeliveredGrant(): boolean {
  const record = readAnalyticsConsentRecord();
  return record.consent === 'granted' && !record.synced;
}

/** Zmiana decyzji: kliknięcie w tej albo innej karcie, odpowiedź z konta. */
function syncTouchWithConsent(): void {
  if (isUndeliveredGrant()) {
    persistTouch();
    return;
  }
  eraseTouch();
  // Po odmowie nawet pamięć karty nie trzyma danych wejścia. Bez decyzji czeka na zgodę.
  if (getAnalyticsConsent() === 'denied') pendingTouch = null;
}

function onStorage(event: StorageEvent): void {
  if (event.key === CONSENT_KEY || event.key === null) syncTouchWithConsent();
}

/**
 * Znacznik po rejestracji: wybór trafił na konto, więc nie przejdzie już na kolejne.
 * Woła to też synchronizacja, bo po rejestracji Next przechodzi na następną stronę bez
 * przeładowania, a konto kolejnej osoby nie może przejąć wyboru, który już dostarczono.
 */
export function settleDeliveredTouch(): void {
  if (typeof document === 'undefined' || storedTouch() !== ATTRIBUTION_COOKIE_DELIVERED) return;
  markAnalyticsConsentDelivered();
  eraseTouch();
}

/**
 * Start w `instrumentation-client.ts`, obok PostHoga. Przy starcie ciasteczka nie
 * tworzymy: powstaje z kliknięcia, więc jego 90 dni jest prawdziwym limitem tego dowodu.
 */
export function initAttribution(): void {
  if (typeof window === 'undefined') return;
  if (getAnalyticsConsent() !== 'denied') pendingTouch = captureFromLocation();
  window.addEventListener(ANALYTICS_CONSENT_EVENT, syncTouchWithConsent);
  window.addEventListener('storage', onStorage);
  settleDeliveredTouch();
  if (!isUndeliveredGrant()) eraseTouch();
}

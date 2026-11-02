import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ATTRIBUTION_COOKIE,
  ATTRIBUTION_COOKIE_MAX_AGE_SECONDS,
  decodeFirstTouch,
  encodeFirstTouch,
  parseFirstTouch,
} from '@/lib/analytics/attribution';
import { ATTRIBUTION_CHANNELS, isPublicEntryPath } from '@/lib/analytics/privacy';
import { MARKETING_PATHS } from '@/lib/supabase/middleware';

/**
 * Źródło wejścia (FAKTWAY-1-0, sekcja 3 pkt 7). Pierwszy dotyk trafia do
 * ciasteczka dopiero po zgodzie, a do bazy i PostHoga idą tylko pola z listy:
 * bez identyfikatorów kliknięć, bez ścieżki strony odsyłającej, bez tokenów
 * z adresu wejścia.
 */

const NOW = new Date('2026-11-02T10:30:00Z');
const parse = (url: string, referrer: string | null = null) =>
  parseFirstTouch({ url: 'https://faktway.pl' + url, referrer, now: NOW });

describe('parser źródła: dozwolone pola', () => {
  it('zapisuje tylko utm, host odsyłacza, ścieżkę wejścia i datę', () => {
    expect(parse(
      '/pricing?utm_source=google&utm_medium=cpc&utm_campaign=ksef-2026&utm_term=faktura&utm_content=a1&gclid=SEKRET&fbclid=SEKRET2&utm_id=x&email=jan@example.test',
      'https://www.google.com/search?q=jan+kowalski',
    )).toEqual({
      channel: 'google_ads',
      utm_source: 'google',
      utm_medium: 'cpc',
      utm_campaign: 'ksef-2026',
      utm_term: 'faktura',
      utm_content: 'a1',
      referrer_host: 'www.google.com',
      landing_path: '/pricing',
      at: '2026-11-02',
    });
  });

  it('z odsyłacza zostaje sam host: bez ścieżki i parametrów', () => {
    const touch = parse('/', 'https://blog.example.test/artykul/tajny?token=abc#x');
    expect(touch.referrer_host).toBe('blog.example.test');
    expect(JSON.stringify(touch)).not.toMatch(/artykul|tajny|token|abc/);
  });

  it.each(['gclid', 'gbraid', 'wbraid', 'fbclid', 'ttclid', 'msclkid'])('identyfikator kliknięcia %s nie ma pola w zapisie', (param) => {
    const touch = parse(`/?${param}=SEKRET`);
    expect(JSON.stringify(touch)).not.toContain('SEKRET');
    expect(Object.keys(touch)).not.toContain(param);
  });

  it.each([
    ['e-mail', 'jan.kowalski@example.test'],
    ['telefon', '500600700'],
    ['NIP', 'nip-1234567890'],
    ['za długi', 'x'.repeat(101)],
    ['znaki spoza listy', '<script>alert(1)</script>'],
  ])('wartość utm z daną osobową albo śmieciem odpada: %s', (_name, value) => {
    const touch = parse('/?utm_source=google&utm_term=' + encodeURIComponent(value));
    expect(touch).not.toHaveProperty('utm_term');
    expect(touch.utm_source).toBe('google');
  });

  it.each([
    ['/accountant/portal-secret-token', undefined],
    ['/invite/tajny-token', undefined],
    ['/invoices/1234', undefined],
    ['/reset-password?token=abc', undefined],
    ['/blog/jak-wystawic-fakture', '/blog/jak-wystawic-fakture'],
    ['/vs/infakt', '/vs/infakt'],
    ['/pomoc/pierwsza-faktura?x=1', '/pomoc/pierwsza-faktura'],
    ['/blog/Tajny_Token.123', undefined],
    ['/', '/'],
    ['/register', '/register'],
    ['/pricing/', '/pricing'],
  ])('ścieżka wejścia %s → %s', (path, expected) => {
    expect(parse(path).landing_path).toBe(expected);
  });

  it('każda ścieżka marketingowa z bramki auth jest też ścieżką wejścia', () => {
    for (const path of MARKETING_PATHS) expect(isPublicEntryPath(path), path).toBe(true);
    expect(isPublicEntryPath('/login')).toBe(true);
    expect(isPublicEntryPath('/register')).toBe(true);
  });
});

describe('parser źródła: kanał', () => {
  it.each([
    // Reklamy Google: po utm albo po samym identyfikatorze kliknięcia (nie zapisujemy go).
    ['/?utm_source=google&utm_medium=cpc', null, 'google_ads'],
    ['/?utm_source=Google&utm_medium=PPC', null, 'google_ads'],
    ['/?utm_source=adwords&utm_medium=paid', null, 'google_ads'],
    ['/?gclid=abc', 'https://www.google.com/', 'google_ads'],
    ['/?gbraid=abc', null, 'google_ads'],
    // Wyszukiwarki: po odsyłaczu albo oznaczone utm.
    ['/', 'https://www.google.pl/', 'organic_search'],
    ['/', 'https://www.bing.com/search?q=x', 'organic_search'],
    ['/', 'https://duckduckgo.com/', 'organic_search'],
    ['/?utm_source=google&utm_medium=organic', null, 'organic_search'],
    // YouTube i TikTok osobno, bo tam idą filmy.
    ['/?utm_source=youtube&utm_medium=video', null, 'youtube'],
    ['/', 'https://www.youtube.com/watch?v=abc', 'youtube'],
    ['/', 'https://youtu.be/abc', 'youtube'],
    ['/?utm_source=tiktok', null, 'tiktok'],
    ['/', 'https://www.tiktok.com/@konto', 'tiktok'],
    ['/?ttclid=abc', null, 'tiktok'],
    // Społecznościowe.
    ['/?utm_source=facebook', null, 'social'],
    ['/?utm_source=newsletter&utm_medium=social', null, 'social'],
    ['/?fbclid=abc', 'https://l.facebook.com/', 'social'],
    ['/', 'https://l.instagram.com/', 'social'],
    ['/', 'https://www.linkedin.com/feed', 'social'],
    ['/', 'https://www.wykop.pl/link/1', 'social'],
    ['/', 'https://t.co/abc', 'social'],
    // Inne strony.
    ['/', 'https://forum.example.test/watek', 'referral'],
    ['/?utm_source=partner&utm_medium=referral', null, 'referral'],
    // Bez śladu i własna domena.
    ['/', null, 'direct'],
    ['/', '', 'direct'],
    ['/', 'nie-adres', 'direct'],
    ['/', 'android-app://com.google.android.gm/', 'direct'],
    // Oznaczone, ale nieznane.
    ['/?utm_source=ulotka&utm_medium=print', null, 'other'],
    ['/?utm_source=bing&utm_medium=cpc', null, 'other'],
    ['/?msclkid=abc', null, 'other'],
  ])('%s z odsyłacza %s → %s', (url, referrer, channel) => {
    expect(parse(url, referrer).channel).toBe(channel);
  });

  it.each([
    'https://faktway.pl/pricing',
    'https://www.faktway.pl/',
    'https://faktflow.pl/',
    'https://checkout.stripe.com/c/pay/cs_test',
    'https://accounts.google.com/o/oauth2',
  ])('własna domena i powroty z logowania albo płatności to direct, bez hosta: %s', (referrer) => {
    const touch = parse('/', referrer);
    expect(touch.channel).toBe('direct');
    expect(touch).not.toHaveProperty('referrer_host');
  });

  it('host własnej strony z konfiguracji też liczy się jako własny', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://panel.example.test');
    expect(parse('/', 'https://panel.example.test/invoices').channel).toBe('direct');
    vi.unstubAllEnvs();
  });

  it('wszystkie kanały z decyzji są na liście dozwolonych', () => {
    expect([...ATTRIBUTION_CHANNELS].sort()).toEqual(
      ['direct', 'google_ads', 'organic_search', 'other', 'referral', 'social', 'tiktok', 'youtube'],
    );
  });
});

describe('zapis i odczyt ciasteczka', () => {
  const touch = parse('/pricing?utm_source=google&utm_medium=cpc', 'https://www.google.com/');

  it('odczyt zwraca to, co zapisano', () => {
    expect(decodeFirstTouch(encodeFirstTouch(touch))).toEqual(touch);
  });

  it('wartość mieści się w ciasteczku nawet przy najdłuższych polach', () => {
    const long = parse('/?' + ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content']
      .map((k) => `${k}=${'ż'.repeat(100)}`).join('&'), 'https://' + 'a'.repeat(200) + '.example.test/');
    expect(encodeFirstTouch(long).length).toBeLessThan(4000);
  });

  it.each([
    [undefined],
    [''],
    ['nie-json'],
    ['%7B%22channel%22%3A%22kanal-spoza-listy%22%2C%22at%22%3A%222026-11-02%22%7D'],
    ['%7B%22channel%22%3A%22direct%22%7D'],
    ['%5B1%2C2%5D'],
    ['%E0%A4%A'],
  ])('odrzuca podrobione albo uszkodzone ciasteczko: %s', (value) => {
    expect(decodeFirstTouch(value)).toBeNull();
  });

  it('przy odczycie odcina obce pola i dane osobowe z podrobionego ciasteczka', () => {
    const forged = encodeURIComponent(JSON.stringify({
      channel: 'direct', at: '2026-11-02', gclid: 'SEKRET', email: 'jan@example.test',
      utm_term: 'jan@example.test', referrer_host: 'https://zly.example.test/sciezka', landing_path: '/accountant/token',
    }));
    expect(decodeFirstTouch(forged)).toEqual({ channel: 'direct', at: '2026-11-02' });
  });
});

/** Przeglądarka: `window`, `document.cookie` i localStorage na atrapach. */
function browser(url: string, referrer = '') {
  const jar = new Map<string, string>();
  const writes: string[] = [];
  const storage = new Map<string, string>();
  const win = Object.assign(new EventTarget(), {
    location: new URL(url),
    localStorage: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => { storage.set(k, v); },
      removeItem: (k: string) => { storage.delete(k); },
    },
  });
  const doc = {
    referrer,
    get cookie() {
      return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    },
    set cookie(raw: string) {
      writes.push(raw);
      const [pair = ''] = raw.split(';');
      const [name = '', ...rest] = pair.split('=');
      if (/max-age=0(;|$)/i.test(raw)) jar.delete(name.trim());
      else jar.set(name.trim(), rest.join('='));
    },
  };
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', doc);
  return { win, doc, jar, writes, storage };
}

async function load() {
  vi.resetModules();
  const attribution = await import('@/lib/analytics/attribution');
  const consent = await import('@/lib/analytics/consent');
  return { ...attribution, ...consent };
}

describe('ciasteczko pierwszego dotyku w przeglądarce', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'phc_unit_test');
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('przed zgodą niczego nie zapisuje, także przy odmowie', async () => {
    const b = browser('https://faktway.pl/pricing?utm_source=google&utm_medium=cpc', 'https://www.google.com/');
    const { initAttribution, setAnalyticsConsent } = await load();
    initAttribution();
    expect(b.writes).toEqual([]);
    setAnalyticsConsent(false);
    expect([...b.jar.keys()]).toEqual([]);
  });

  it('po zgodzie zapisuje dotyk z wejścia: 90 dni, SameSite=Lax, ścieżka główna', async () => {
    const b = browser('https://faktway.pl/pricing?utm_source=google&utm_medium=cpc&gclid=SEKRET', 'https://www.google.com/q');
    const { initAttribution, setAnalyticsConsent } = await load();
    initAttribution();
    setAnalyticsConsent(true);

    expect(b.writes).toHaveLength(1);
    const raw = b.writes[0]!;
    expect(ATTRIBUTION_COOKIE_MAX_AGE_SECONDS).toBe(90 * 24 * 60 * 60);
    expect(raw).toContain(`${ATTRIBUTION_COOKIE}=`);
    expect(raw).toContain(`Max-Age=${90 * 24 * 60 * 60}`);
    expect(raw).toContain('Path=/');
    expect(raw).toContain('SameSite=Lax');
    expect(raw).toContain('Secure');
    expect(raw).not.toContain('SEKRET');
    expect(decodeFirstTouch(b.jar.get(ATTRIBUTION_COOKIE))).toEqual({
      channel: 'google_ads', utm_source: 'google', utm_medium: 'cpc',
      referrer_host: 'www.google.com', landing_path: '/pricing', at: '2026-11-02',
    });
  });

  it('adres z chwili wejścia przeżywa nawigację w karcie: zgoda później nie gubi utm', async () => {
    const b = browser('https://faktway.pl/pricing?utm_source=tiktok');
    const { initAttribution, setAnalyticsConsent } = await load();
    initAttribution();
    b.win.location = new URL('https://faktway.pl/register');
    setAnalyticsConsent(true);
    expect(decodeFirstTouch(b.jar.get(ATTRIBUTION_COOKIE))).toMatchObject({ channel: 'tiktok', landing_path: '/pricing' });
  });

  it('wcześniejsza zgoda: zapis od razu przy starcie strony, ale pierwszy dotyk się nie nadpisuje', async () => {
    const first = browser('https://faktway.pl/?utm_source=youtube');
    first.storage.set('ff_analytics_consent', 'granted');
    const a = await load();
    a.initAttribution();
    expect(decodeFirstTouch(first.jar.get(ATTRIBUTION_COOKIE))?.channel).toBe('youtube');

    // Kolejna wizyta z innego źródła, to samo ciasteczko w przeglądarce.
    const stored = first.jar.get(ATTRIBUTION_COOKIE)!;
    const second = browser('https://faktway.pl/?utm_source=tiktok');
    second.storage.set('ff_analytics_consent', 'granted');
    second.jar.set(ATTRIBUTION_COOKIE, stored);
    const b = await load();
    b.initAttribution();
    expect(second.writes).toEqual([]);
    expect(decodeFirstTouch(second.jar.get(ATTRIBUTION_COOKIE))?.channel).toBe('youtube');
  });

  it('odwołanie zgody usuwa ciasteczko od razu', async () => {
    const b = browser('https://faktway.pl/?utm_source=youtube');
    const { initAttribution, setAnalyticsConsent } = await load();
    initAttribution();
    setAnalyticsConsent(true);
    expect(b.jar.has(ATTRIBUTION_COOKIE)).toBe(true);
    setAnalyticsConsent(false);
    expect(b.jar.has(ATTRIBUTION_COOKIE)).toBe(false);
    expect(b.writes.at(-1)).toMatch(/Max-Age=0/);
  });

  it('odwołanie w innej karcie też usuwa ciasteczko', async () => {
    const b = browser('https://faktway.pl/?utm_source=youtube');
    b.storage.set('ff_analytics_consent', 'granted');
    const { initAttribution } = await load();
    initAttribution();
    expect(b.jar.has(ATTRIBUTION_COOKIE)).toBe(true);
    b.storage.set('ff_analytics_consent', 'denied');
    b.win.dispatchEvent(Object.assign(new Event('storage'), { key: 'ff_analytics_consent' }));
    expect(b.jar.has(ATTRIBUTION_COOKIE)).toBe(false);
  });

  it('strona panelu albo token w adresie: bez ciasteczka mimo zgody', async () => {
    for (const url of ['https://faktway.pl/dashboard', 'https://faktway.pl/accountant/portal-secret']) {
      const b = browser(url);
      b.storage.set('ff_analytics_consent', 'granted');
      const { initAttribution } = await load();
      initAttribution();
      expect(b.writes, url).toEqual([]);
    }
  });

  it('bez skonfigurowanego PostHoga nie ma zgody do zebrania, więc nie ma ciasteczka', async () => {
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', '');
    const b = browser('https://faktway.pl/');
    b.storage.set('ff_analytics_consent', 'granted');
    const { initAttribution } = await load();
    initAttribution();
    expect(b.writes).toEqual([]);
  });

  it('http na lokalnym dev: bez atrybutu Secure, bo przeglądarka odrzuciłaby ciasteczko', async () => {
    const b = browser('http://localhost:3103/');
    b.storage.set('ff_analytics_consent', 'granted');
    const { initAttribution } = await load();
    initAttribution();
    expect(b.writes[0]).not.toContain('Secure');
  });

  it('niedostępne localStorage: zgoda z pamięci strony działa, odwołanie usuwa ciasteczko', async () => {
    const b = browser('https://faktway.pl/?utm_source=youtube');
    b.win.localStorage.getItem = () => { throw new Error('blocked'); };
    b.win.localStorage.setItem = () => { throw new Error('blocked'); };
    const { initAttribution, setAnalyticsConsent } = await load();
    initAttribution();
    expect(b.writes).toEqual([]);
    setAnalyticsConsent(true);
    expect(b.jar.has(ATTRIBUTION_COOKIE)).toBe(true);
    setAnalyticsConsent(false);
    expect(b.jar.has(ATTRIBUTION_COOKIE)).toBe(false);
  });
});

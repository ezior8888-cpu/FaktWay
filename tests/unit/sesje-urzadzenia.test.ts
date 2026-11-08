import { describe, expect, it } from 'vitest';

import { loginMethodFromAmr, readAccessTokenFacts } from '@/lib/auth/sessions/access-token';
import { formatIpPrefix } from '@/lib/auth/sessions/ip-prefix';
import { describeUserAgent } from '@/lib/auth/sessions/user-agent';
import { toAccountLoginView, toAccountSessionView } from '@/lib/auth/sessions/view';

/**
 * Krok 8.5 planu kompletnej aplikacji: zalogowane urządzenia i historia logowań.
 * Tu logika bez bazy: opis urządzenia z nagłówka User-Agent, skrócony adres IP,
 * identyfikator sesji z tokenu GoTrue i widok wiersza z funkcji 00174.
 * Bazę (RLS, uprawnienia, wylogowanie w GoTrue) sprawdza `tests/rls-sesje-konta.test.ts`.
 */

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const IPAD = 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const ANDROID_PHONE = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';
const ANDROID_TABLET = 'Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const SAMSUNG = 'Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0 Mobile Safari/537.36';
const MAC_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MAC_SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const WINDOWS_EDGE = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0';
const LINUX_FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0';
const CHROMEBOOK = 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function token(payload: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return [part({ alg: 'HS256', typ: 'JWT' }), part(payload), 'podpis'].join('.');
}

describe('urządzenie z nagłówka User-Agent', () => {
  it.each([
    [IPHONE, 'phone', 'iPhone (Safari)'],
    [IPAD, 'tablet', 'iPad (Safari)'],
    [ANDROID_PHONE, 'phone', 'Android (Chrome)'],
    [ANDROID_TABLET, 'tablet', 'Android (Chrome)'],
    [SAMSUNG, 'phone', 'Android (Samsung Internet)'],
    [MAC_CHROME, 'computer', 'Mac (Chrome)'],
    [MAC_SAFARI, 'computer', 'Mac (Safari)'],
    [WINDOWS_EDGE, 'computer', 'Windows (Edge)'],
    [LINUX_FIREFOX, 'computer', 'Linux (Firefox)'],
    [CHROMEBOOK, 'computer', 'Chromebook (Chrome)'],
  ])('%s', (userAgent, kind, label) => {
    expect(describeUserAgent(userAgent)).toEqual({ kind, label, fromServer: false });
  });

  it('nazwy jak przy urządzeniach biometrii: ta sama lista systemów i przeglądarek', () => {
    // `deviceLabelFromUserAgent` (lib/auth/passkey/device-label.ts) daje dla Maca z Chrome
    // „Mac (Chrome)”; lista urządzeń na tej samej stronie mówi tak samo.
    expect(describeUserAgent(MAC_CHROME).label).toBe('Mac (Chrome)');
  });

  it.each(['node', 'undici', 'node/24.15.0', 'NODE'])('%s: zapytanie serwera aplikacji, nie urządzenie klienta', (userAgent) => {
    // Node (fetch z undici) wysyła „node”. Tak GoTrue zapisuje sesje, które
    // FaktWay loguje i odświeża z serwera: to nie jest przeglądarka klienta.
    expect(describeUserAgent(userAgent)).toEqual({ kind: 'unknown', label: null, fromServer: true });
  });

  it.each([null, undefined, '', '   '])('brak nagłówka (%s): nieznane urządzenie', (userAgent) => {
    expect(describeUserAgent(userAgent)).toEqual({ kind: 'unknown', label: null, fromServer: false });
  });

  it('narzędzie spoza przeglądarki pokazuje swoją nazwę', () => {
    expect(describeUserAgent('curl/8.4.0')).toEqual({ kind: 'unknown', label: 'curl', fromServer: false });
    expect(describeUserAgent('python-requests/2.31.0')).toEqual({ kind: 'unknown', label: 'python-requests', fromServer: false });
  });

  it('nazwa z nagłówka bez znaków sterujących i nie dłuższa niż 40 znaków', () => {
    expect(describeUserAgent('\u0007\u0000zly\u0001klient/1.0').label).toBe('zlyklient');
    expect(Array.from(describeUserAgent(`${'a'.repeat(300)}/1.0`).label ?? '')).toHaveLength(40);
    expect(describeUserAgent('////').label).toBeNull();
  });
});

describe('skrócony adres IP', () => {
  it.each([
    ['83.21.104.0/24', '83.21.104.x'],
    ['83.21.104.77', '83.21.104.x'],
    ['83.21.104.77/32', '83.21.104.x'],
    ['2a02:a311:4a3f::/48', '2a02:a311:4a3f:…'],
    ['2a02:a311:4a3f:1:2:3:4:5', '2a02:a311:4a3f:…'],
    ['2A02:0A31:004A::1', '2a02:a31:4a:…'],
    ['2a02:a311::/48', '2a02:a311:0:…'],
    ['::ffff:83.21.104.0/120', '83.21.104.x'],
    ['::ffff:83.21.104.77', '83.21.104.x'],
  ])('%s → %s', (value, expected) => {
    expect(formatIpPrefix(value)).toBe(expected);
  });

  it.each([null, undefined, '', 'unknown', '999.1.1.1', '1.2.3', '1.2.3.4.5', '83.21.104.077', 'gggg::1', '1::2::3', '2a02:a311:4a3f:1:2:3:4:5:6'])(
    'niepoprawna wartość (%s): brak adresu zamiast zgadywania',
    (value) => {
      expect(formatIpPrefix(value)).toBeNull();
    },
  );

  it('nigdy nie pokazuje pełnego adresu, nawet gdy baza oddała pełny', () => {
    expect(formatIpPrefix('83.21.104.77')).not.toContain('77');
    expect(formatIpPrefix('2a02:a311:4a3f:aaaa:bbbb:cccc:dddd:eeee')).not.toMatch(/aaaa|eeee/);
  });
});

describe('sesja z tokenu GoTrue', () => {
  const SESSION = '5b7e2d1c-3f4a-4b6c-8d9e-0f1a2b3c4d5e';

  it('identyfikator sesji i metody logowania z claimów', () => {
    expect(readAccessTokenFacts(token({ sub: 'u', session_id: SESSION, amr: [{ method: 'oauth', timestamp: 1 }] })))
      .toEqual({ sessionId: SESSION, amrMethods: ['oauth'] });
  });

  it.each([
    ['brak tokenu', undefined],
    ['pusty', ''],
    ['nie JWT', 'abc'],
    ['zły JSON', 'a.!!!.c'],
    ['session_id nie jest UUID', token({ session_id: 'x' })],
    ['session_id nie jest tekstem', token({ session_id: 12 })],
  ])('%s: bez identyfikatora', (_name, value) => {
    expect(readAccessTokenFacts(value as string | undefined).sessionId).toBeNull();
  });

  it('metoda logowania z /auth/callback: Google albo link z e-maila, bez zgadywania', () => {
    expect(loginMethodFromAmr(['oauth'])).toBe('google');
    expect(loginMethodFromAmr(['recovery'])).toBe('email_link');
    expect(loginMethodFromAmr(['email/signup'])).toBe('email_link');
    expect(loginMethodFromAmr([])).toBeNull();
  });
});

describe('wiersz listy urządzeń (list_account_sessions)', () => {
  const base = {
    session_id: '5b7e2d1c-3f4a-4b6c-8d9e-0f1a2b3c4d5e',
    is_current: false,
    // 13:05 UTC to 14:05 w Polsce (CET).
    signed_in_at: '2026-11-08T13:05:00+00:00',
    last_active_at: '2026-11-08T15:40:00+00:00',
    login_method: 'password',
    user_agent: IPHONE,
    ip_prefix: '83.21.104.0/24',
    device_source: 'login' as const,
  };

  it('wpis logowania z aplikacji: urządzenie, skrócony IP, sposób i daty po polsku', () => {
    expect(toAccountSessionView(base)).toEqual({
      id: base.session_id,
      isCurrent: false,
      kind: 'phone',
      device: 'iPhone (Safari)',
      ip: '83.21.104.x',
      method: 'hasło',
      signedInAt: '08.11.2026, 14:05',
      lastActiveAt: '08.11.2026, 16:40',
    });
  });

  it('sesja bez wpisu logowania, zapisana przez serwer aplikacji: bez urządzenia i bez adresu serwera', () => {
    const view = toAccountSessionView({
      ...base, device_source: 'session', login_method: null, user_agent: 'node', ip_prefix: '10.0.1.0/24',
    });
    expect(view).toMatchObject({ device: 'Nieznane urządzenie', kind: 'unknown', ip: null, method: null });
  });

  it('sesja bez wpisu logowania, odświeżona wprost z przeglądarki: pokazuje to, co widział GoTrue', () => {
    const view = toAccountSessionView({ ...base, device_source: 'session', login_method: null, user_agent: WINDOWS_EDGE });
    expect(view).toMatchObject({ device: 'Windows (Edge)', ip: '83.21.104.x', method: null });
  });

  it('nieznana metoda logowania nie trafia na ekran', () => {
    expect(toAccountSessionView({ ...base, login_method: 'cokolwiek' }).method).toBeNull();
  });

  it('bieżące urządzenie', () => {
    expect(toAccountSessionView({ ...base, is_current: true }).isCurrent).toBe(true);
  });

  describe('bieżąca sesja zalogowana przed krokiem 8.5 (bez wpisu logowania)', () => {
    const legacy = { ...base, is_current: true, device_source: 'session' as const, login_method: null, user_agent: 'node', ip_prefix: '10.0.1.0/24' };
    const request = { userAgent: MAC_CHROME, ip: '83.21.104.77' };

    it('urządzenie i skrócony adres z bieżącego żądania, bo to na pewno to urządzenie', () => {
      expect(toAccountSessionView(legacy, request)).toMatchObject({ device: 'Mac (Chrome)', kind: 'computer', ip: '83.21.104.x' });
    });

    it('inna sesja bez wpisu logowania nie bierze nagłówków tego żądania', () => {
      expect(toAccountSessionView({ ...legacy, is_current: false }, request)).toMatchObject({ device: 'Nieznane urządzenie', ip: null });
    });

    it('wpis logowania wygrywa z nagłówkami żądania', () => {
      expect(toAccountSessionView({ ...base, is_current: true }, request)).toMatchObject({ device: 'iPhone (Safari)', ip: '83.21.104.x' });
    });

    it('bez nagłówków żądania: nieznane urządzenie zamiast zgadywania', () => {
      expect(toAccountSessionView(legacy)).toMatchObject({ device: 'Nieznane urządzenie', ip: null });
    });
  });
});

describe('wiersz historii logowań (list_account_logins)', () => {
  const base = {
    signed_in_at: '2026-07-01T08:00:00+00:00',
    action: 'auth.login',
    login_method: 'passkey',
    user_agent: ANDROID_PHONE,
    ip_prefix: '2a02:a311:4a3f::/48',
    session_id: '5b7e2d1c-3f4a-4b6c-8d9e-0f1a2b3c4d5e',
    is_current: false,
    is_active: false,
  };

  it('data w czasie polskim (lato: UTC+2), urządzenie, skrócony IP, sposób i stan', () => {
    expect(toAccountLoginView(base, 0)).toEqual({
      key: '0:2026-07-01T08:00:00+00:00',
      when: '01.07.2026, 10:00',
      kind: 'phone',
      device: 'Android (Chrome)',
      ip: '2a02:a311:4a3f:…',
      method: 'biometria',
      status: 'ended',
    });
  });

  it('stan: ta sesja, nadal zalogowane, zakończone, a wpis bez sesji (sprzed kroku 8.5) bez zgadywania', () => {
    expect(toAccountLoginView({ ...base, is_current: true, is_active: true }, 1).status).toBe('current');
    expect(toAccountLoginView({ ...base, is_active: true }, 1).status).toBe('active');
    expect(toAccountLoginView(base, 1).status).toBe('ended');
    expect(toAccountLoginView({ ...base, session_id: null }, 1).status).toBe('unknown');
  });

  it('rejestracja z od razu otwartą sesją', () => {
    expect(toAccountLoginView({ ...base, action: 'auth.signup', login_method: 'signup' }, 2).method).toBe('rejestracja');
  });
});

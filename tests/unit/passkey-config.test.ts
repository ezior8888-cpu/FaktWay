import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getPasskeyConfig, isRequestOriginAllowed } from '@/lib/auth/passkey/config';

/**
 * RP ID i lista originów w jednym module. RP ID jest na zawsze wpisany
 * w poświadczenia, więc nie może zależeć od nagłówków żądania.
 */

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_APP_ENV', 'production');
});
afterEach(() => vi.unstubAllEnvs());

describe('getPasskeyConfig', () => {
  it.each(['https://faktway.pl', 'https://faktway.pl/', 'https://www.faktway.pl'])(
    'produkcja %s: RP ID to domena główna, dozwolone apex i www', (url) => {
      vi.stubEnv('NEXT_PUBLIC_APP_URL', url);
      expect(getPasskeyConfig()).toEqual({
        rpId: 'faktway.pl',
        rpName: 'FaktWay',
        origins: ['https://faktway.pl', 'https://www.faktway.pl'],
      });
    },
  );

  it('lokalnie RP ID to localhost, a origin ma port', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_ENV', 'development');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:3106');
    expect(getPasskeyConfig()).toEqual({ rpId: 'localhost', rpName: 'FaktWay', origins: ['http://localhost:3106'] });
  });

  it.each([
    ['brak adresu', undefined],
    ['http poza środowiskiem lokalnym', 'http://faktway.pl'],
    ['adres ze ścieżką', 'https://faktway.pl/app'],
    ['adres z danymi logowania', 'https://user:pass@faktway.pl'],
  ])('%s: brak konfiguracji zamiast zgadywania', (_name, url) => {
    if (url) vi.stubEnv('NEXT_PUBLIC_APP_URL', url);
    else vi.stubEnv('NEXT_PUBLIC_APP_URL', '');
    expect(getPasskeyConfig()).toBeNull();
  });

  it('adres IP nie może być RP ID', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_ENV', 'development');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://127.0.0.1:3000');
    expect(getPasskeyConfig()).toBeNull();
  });
});

describe('isRequestOriginAllowed', () => {
  const config = { rpId: 'faktway.pl', rpName: 'FaktWay', origins: ['https://faktway.pl', 'https://www.faktway.pl'] };
  const request = (origin?: string) => new Request('https://faktway.pl/api/auth/passkey/login/options', {
    method: 'POST', headers: origin ? { origin } : {},
  });

  it.each(['https://faktway.pl', 'https://www.faktway.pl'])('przepuszcza %s', (origin) => {
    expect(isRequestOriginAllowed(request(origin), config)).toBe(true);
  });

  it.each(['https://zly.example', 'https://faktway.pl.zly.example', 'http://faktway.pl', 'null', 'https://sub.faktway.pl'])(
    'odrzuca %s', (origin) => {
      expect(isRequestOriginAllowed(request(origin), config)).toBe(false);
    },
  );

  it('klient bez nagłówka (aplikacja natywna) przechodzi: przeglądarka zawsze go wysyła przy POST', () => {
    expect(isRequestOriginAllowed(request(), config)).toBe(true);
  });
});

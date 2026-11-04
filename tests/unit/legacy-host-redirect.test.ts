import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  isLegacyHostRedirectEnabled,
  legacyHostRedirectTarget,
  requestHost,
} from '@/lib/legacy-host-redirect';

/**
 * Zmiana marki FaktFlow → FaktWay: stara domena przekierowuje 308 z tą samą
 * ścieżką, ale nie w połowie logowania, resetu hasła, webhooka ani aktualizacji
 * service workera.
 */

const base = {
  method: 'GET',
  host: 'faktflow.pl',
  pathname: '/pomoc/czym-jest-ksef',
  search: '?jezyk=pl',
  target: 'https://faktway.pl',
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('przekierowanie starej domeny', () => {
  it('domyślnie wyłączone, włącza je dopiero LEGACY_HOST_REDIRECT=1', () => {
    vi.stubEnv('LEGACY_HOST_REDIRECT', '');
    expect(isLegacyHostRedirectEnabled()).toBe(false);
    vi.stubEnv('LEGACY_HOST_REDIRECT', 'true');
    expect(isLegacyHostRedirectEnabled()).toBe(false);
    vi.stubEnv('LEGACY_HOST_REDIRECT', '1');
    expect(isLegacyHostRedirectEnabled()).toBe(true);
  });

  it('zachowuje ścieżkę i parametry, apex i www', () => {
    expect(legacyHostRedirectTarget(base)).toBe('https://faktway.pl/pomoc/czym-jest-ksef?jezyk=pl');
    expect(legacyHostRedirectTarget({ ...base, host: 'www.faktflow.pl', search: '' })).toBe(
      'https://faktway.pl/pomoc/czym-jest-ksef',
    );
    expect(legacyHostRedirectTarget({ ...base, method: 'head' })).not.toBeNull();
  });

  it.each(['POST', 'PUT', 'DELETE'])('%s zostaje na starej domenie', (method) => {
    expect(legacyHostRedirectTarget({ ...base, method })).toBeNull();
  });

  it.each([
    '/auth/callback',
    '/auth/confirm',
    '/reset-password',
    '/api/stripe/webhook',
    '/api/email/unsubscribe',
    '/sw.js',
    '/manifest.webmanifest',
    '/ingest/decide',
    '/monitoring',
  ])('%s zostaje na starej domenie', (pathname) => {
    expect(legacyHostRedirectTarget({ ...base, pathname })).toBeNull();
  });

  it('ścieżki tylko podobne do wyjątków przekierowuje', () => {
    expect(legacyHostRedirectTarget({ ...base, pathname: '/authors' })).not.toBeNull();
    expect(legacyHostRedirectTarget({ ...base, pathname: '/apiary' })).not.toBeNull();
  });

  it('nowa domena i obce hosty bez przekierowania', () => {
    expect(legacyHostRedirectTarget({ ...base, host: 'faktway.pl' })).toBeNull();
    expect(legacyHostRedirectTarget({ ...base, host: 'localhost' })).toBeNull();
  });

  it('bez pętli, gdy adres strony nadal wskazuje starą domenę', () => {
    expect(legacyHostRedirectTarget({ ...base, target: 'https://faktflow.pl' })).toBeNull();
    expect(legacyHostRedirectTarget({ ...base, target: 'nie-url' })).toBeNull();
  });

  it('host z x-forwarded-host, bez portu i małymi literami', () => {
    expect(requestHost(new Headers({ host: 'FaktFlow.pl:443' }))).toBe('faktflow.pl');
    expect(requestHost(new Headers({ host: 'app:3000', 'x-forwarded-host': 'www.faktflow.pl' }))).toBe(
      'www.faktflow.pl',
    );
  });
});

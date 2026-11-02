import { describe, expect, it } from 'vitest';

import { deviceLabelFromUserAgent, MAX_DEVICE_LABEL_LENGTH, sanitizeDeviceLabel } from '@/lib/auth/passkey/device-label';
import { passkeyBrowserErrorMessage, passkeyServerMessage } from '@/lib/auth/passkey/messages';

const domError = (name: string) => Object.assign(new Error('x'), { name });

describe('komunikaty okna systemowego', () => {
  it.each(['login', 'registration'] as const)('anulowanie (%s) mówi, co się stało i co dalej', (ceremony) => {
    expect(passkeyBrowserErrorMessage(domError('NotAllowedError'), ceremony)).toMatch(/anulowane albo czas minął/);
  });

  it('przerwanie przez nas (nowa próba, zmiana strony) nic nie pokazuje', () => {
    expect(passkeyBrowserErrorMessage(domError('AbortError'), 'login')).toBeNull();
    expect(passkeyBrowserErrorMessage(Object.assign(domError('AbortError'), { code: 'ERROR_CEREMONY_ABORTED' }), 'login')).toBeNull();
  });

  it('urządzenie już dodane, zły adres, brak wsparcia: każdy po swojemu', () => {
    expect(passkeyBrowserErrorMessage({ name: 'InvalidStateError', code: 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED' }, 'registration')).toMatch(/już dodane/);
    expect(passkeyBrowserErrorMessage(domError('SecurityError'), 'login')).toMatch(/głównym adresem FaktWay/);
    expect(passkeyBrowserErrorMessage({ name: 'ConstraintError', code: 'ERROR_AUTHENTICATOR_MISSING_USER_VERIFICATION_SUPPORT' }, 'registration')).toMatch(/nie obsługuje/);
  });

  it('nieznany błąd ma polski komunikat zapasowy, także bez obiektu błędu', () => {
    expect(passkeyBrowserErrorMessage(new TypeError('Failed to fetch'), 'login')).toMatch(/Nie udało się użyć biometrii/);
    expect(passkeyBrowserErrorMessage(undefined, 'registration')).toMatch(/Nie udało się dodać urządzenia/);
  });

  it('kody serwera mają komunikaty bez długich myślników, nieznany kod ma zapasowy', () => {
    const codes = [
      'passkey_login_failed', 'session_unavailable', 'passkey_unavailable', 'origin_not_allowed', 'rate_limited',
      'invalid_request', 'not_authenticated', 'session_verification_failed', 'mfa_required',
      'passkey_registration_failed', 'already_registered', 'too_many_passkeys', 'not_found', 'cos_nowego',
    ];
    for (const code of codes) {
      const message = passkeyServerMessage(code, 'login');
      expect(message.length).toBeGreaterThan(10);
      expect(message).not.toMatch(/[—–]/);
    }
  });
});

describe('nazwa urządzenia', () => {
  it.each([
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1', 'iPhone (Safari)'],
    ['Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36', 'Android (Chrome)'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15', 'Mac (Safari)'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36 Edg/130.0', 'Windows (Edge)'],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0', 'Linux (Firefox)'],
  ])('%s', (userAgent, label) => {
    expect(deviceLabelFromUserAgent(userAgent)).toBe(label);
  });

  it('bez nagłówka albo z czymś nieznanym: zwykłe „Urządzenie”', () => {
    expect(deviceLabelFromUserAgent(null)).toBe('Urządzenie');
    expect(deviceLabelFromUserAgent('curl/8.0')).toBe('Urządzenie');
  });

  it('nazwa od klienta: bez znaków sterujących, zbędnych spacji i nadmiaru', () => {
    expect(sanitizeDeviceLabel('  Telefon\u0007  Ani\n')).toBe('Telefon Ani');
    expect(Array.from(sanitizeDeviceLabel('ż'.repeat(500))!)).toHaveLength(MAX_DEVICE_LABEL_LENGTH);
    expect(sanitizeDeviceLabel('   ')).toBeNull();
    expect(sanitizeDeviceLabel(undefined)).toBeNull();
  });
});

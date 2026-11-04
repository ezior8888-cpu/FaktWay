import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';

import {
  isHandheldDevice,
  loginOptionsForThisDevice,
  registrationOptionsForThisDevice,
} from '@/lib/auth/passkey/client';

// Telefon: klucz tylko z tego urządzenia, bez kodu QR (poprawka z 03.11.2026).

const LOGIN: PublicKeyCredentialRequestOptionsJSON = {
  challenge: 'wyzwanie',
  rpId: 'faktflow.pl',
  userVerification: 'required',
  allowCredentials: [],
  timeout: 120_000,
};

const REGISTRATION: PublicKeyCredentialCreationOptionsJSON = {
  challenge: 'wyzwanie',
  rp: { id: 'faktflow.pl', name: 'FaktWay' },
  user: { id: 'dXNlcg', name: 'jan@example.com', displayName: 'jan@example.com' },
  pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
  excludeCredentials: [{ id: 'stary', type: 'public-key', transports: ['internal', 'hybrid'] }],
  authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
};

function stubNavigator(userAgent: string, maxTouchPoints = 0) {
  vi.stubGlobal('navigator', { userAgent, maxTouchPoints });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isHandheldDevice', () => {
  it('rozpoznaje iPhone’a, Androida i iPada udającego Maca', () => {
    stubNavigator('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15');
    expect(isHandheldDevice()).toBe(true);
    stubNavigator('Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/130 Mobile');
    expect(isHandheldDevice()).toBe(true);
    stubNavigator('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', 5);
    expect(isHandheldDevice()).toBe(true);
  });

  it('Mac i Windows to komputer, tam zostaje kod QR dla telefonu', () => {
    stubNavigator('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', 0);
    expect(isHandheldDevice()).toBe(false);
    stubNavigator('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130');
    expect(isHandheldDevice()).toBe(false);
  });
});

describe('loginOptionsForThisDevice', () => {
  it('ogranicza logowanie do kluczy tego telefonu, bez innych urządzeń', () => {
    const options = loginOptionsForThisDevice(LOGIN, ['klucz-a', 'klucz-b']);
    expect(options.hints).toEqual(['client-device']);
    expect(options.allowCredentials).toEqual([
      { id: 'klucz-a', type: 'public-key', transports: ['internal'] },
      { id: 'klucz-b', type: 'public-key', transports: ['internal'] },
    ]);
    // Wyzwanie i reszta opcji serwera bez zmian, bo weryfikacja liczy się po wyzwaniu.
    expect(options.challenge).toBe(LOGIN.challenge);
    expect(options.userVerification).toBe('required');
  });

  it('bez znanych kluczy zostawia listę serwera i dokłada tylko wskazówkę', () => {
    const options = loginOptionsForThisDevice(LOGIN, []);
    expect(options.allowCredentials).toEqual([]);
    expect(options.hints).toEqual(['client-device']);
  });
});

describe('registrationOptionsForThisDevice', () => {
  it('tworzy klucz w tym telefonie i zostawia wymagania serwera', () => {
    const options = registrationOptionsForThisDevice(REGISTRATION);
    expect(options.authenticatorSelection).toEqual({
      residentKey: 'required',
      userVerification: 'required',
      authenticatorAttachment: 'platform',
    });
    expect(options.hints).toEqual(['client-device']);
    expect(options.excludeCredentials).toBe(REGISTRATION.excludeCredentials);
    expect(REGISTRATION.authenticatorSelection).not.toHaveProperty('authenticatorAttachment');
  });
});

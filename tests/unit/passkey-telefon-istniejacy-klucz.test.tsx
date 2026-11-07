// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { addPasskeyDevice, passkeyButtonAvailable, readDeviceKeys, signInWithPasskey } from '@/lib/auth/passkey/client';
import { PASSKEY_ALREADY_ON_DEVICE_MESSAGE, PASSKEY_SUGGESTION_HINT } from '@/lib/auth/passkey/messages';

/**
 * Telefon z kluczem konta, którego nie ma na liście tego telefonu (sprawdzenie
 * produkcji po wdrożeniu 05.11.2026). Lista `faktway.passkey_device_keys` jest pusta
 * przy kluczu dodanym przed 05.11, zsynchronizowanym z komputera albo po wyczyszczeniu
 * danych strony (Safari czyści je sam po 7 dniach bez wizyty). Wtedy przycisk
 * „Zaloguj biometrią” znikał, a „Włącz” w propozycji i „Dodaj urządzenie”
 * w ustawieniach kończyły się czerwonym „To urządzenie jest już dodane”.
 *
 * Prawdziwy kod klienta i prawdziwe `@simplewebauthn/browser`. Podmienione są tylko
 * API przeglądarki (`navigator.credentials`, `PublicKeyCredential`) i `fetch`.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const DEVICE_KEYS = 'faktway.passkey_device_keys';

const buffer = (text: string) => new TextEncoder().encode(text).buffer;
// Identyfikatory jak z serwera: base64url bez dopełnienia.
const b64url = (text: string) => btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const REGISTRATION_OPTIONS = {
  challenge: b64url('wyzwanie'),
  rp: { id: 'localhost', name: 'FaktWay' },
  user: { id: b64url('uzytkownik'), name: 'jan@example.com', displayName: 'jan@example.com' },
  pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
  excludeCredentials: [{ id: b64url('klucz-z-komputera'), type: 'public-key', transports: ['internal', 'hybrid'] }],
  authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
};

const LOGIN_OPTIONS = {
  challenge: b64url('wyzwanie'),
  rpId: 'localhost',
  userVerification: 'required',
  allowCredentials: [],
  timeout: 120_000,
};

type Reply = { status?: number; body: unknown };
let replies: Record<string, Reply>;
const calls: string[] = [];
const credentials = { create: vi.fn(), get: vi.fn() };

function setDevice(userAgent: string, maxTouchPoints: number) {
  Object.defineProperty(window.navigator, 'userAgent', { value: userAgent, configurable: true });
  Object.defineProperty(window.navigator, 'maxTouchPoints', { value: maxTouchPoints, configurable: true });
}

/** Telefon ma już klucz konta: system odmawia drugiego (iOS 18+, Chrome na Androidzie). */
function phoneAlreadyHoldsAKey() {
  credentials.create.mockRejectedValue(new DOMException('', 'InvalidStateError'));
}

function attestation(id: string, attachment: 'platform' | 'cross-platform') {
  return {
    id: b64url(id),
    rawId: buffer(id),
    type: 'public-key',
    authenticatorAttachment: attachment,
    response: {
      clientDataJSON: buffer('{}'),
      attestationObject: buffer('att'),
      getTransports: () => ['internal'],
      getPublicKeyAlgorithm: () => -7,
      getPublicKey: () => null,
      getAuthenticatorData: () => buffer('auth'),
    },
    getClientExtensionResults: () => ({}),
  };
}

function assertion(id: string, attachment: 'platform' | 'cross-platform') {
  return {
    id: b64url(id),
    rawId: buffer(id),
    type: 'public-key',
    authenticatorAttachment: attachment,
    response: {
      authenticatorData: buffer('auth'),
      clientDataJSON: buffer('{}'),
      signature: buffer('sig'),
      userHandle: buffer('u'),
    },
    getClientExtensionResults: () => ({}),
  };
}

let root: Root | null = null;
let host: HTMLElement | null = null;

async function render(element: ReactElement): Promise<HTMLElement> {
  host = document.createElement('div');
  document.body.append(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(element);
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  return host;
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent?.includes(label));
  if (!found) throw new Error(`Brak przycisku „${label}”`);
  return found;
}

beforeEach(() => {
  window.localStorage.clear();
  calls.length = 0;
  credentials.create.mockReset();
  credentials.get.mockReset();
  Object.defineProperty(window.navigator, 'credentials', { value: credentials, configurable: true });
  (window as unknown as { PublicKeyCredential: unknown }).PublicKeyCredential = class {
    static isConditionalMediationAvailable = async () => true;
    static isUserVerifyingPlatformAuthenticatorAvailable = async () => true;
  };
  replies = {
    '/api/auth/passkey/register/options': { body: { options: REGISTRATION_OPTIONS } },
    '/api/auth/passkey/login/options': { body: { options: LOGIN_OPTIONS } },
    '/api/auth/passkey/login/verify': { body: { redirectTo: '/dashboard' } },
    '/api/auth/passkey': { body: { devices: [{ id: 'urzadzenie-z-komputera' }], canManage: true } },
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      calls.push(path);
      const reply = replies[path];
      if (!reply) throw new Error(`Nieoczekiwane zapytanie: ${path}`);
      return new Response(JSON.stringify(reply.body), {
        status: reply.status ?? 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  setDevice(IPHONE, 5);
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
});

describe('dodawanie klucza na telefonie, który już ma klucz konta', () => {
  it('to sukces „już jest na tym urządzeniu”, bez weryfikacji i bez zgadywania klucza', async () => {
    phoneAlreadyHoldsAKey();

    const result = await addPasskeyDevice();

    expect(result).toEqual({ ok: true, device: null, alreadyOnDevice: true });
    expect(calls).not.toContain('/api/auth/passkey/register/verify');
    // Nie wiadomo, który klucz konta jest na telefonie, więc lista zostaje pusta:
    // pierwsze logowanie pójdzie przez podpowiedź w polu e-mail i zapisze dokładny klucz.
    expect(readDeviceKeys()).toEqual([]);
  });

  it('serwer zna już zwrócony klucz (409): to klucz tego telefonu, zapamiętany', async () => {
    credentials.create.mockResolvedValue(attestation('klucz-telefonu', 'platform'));
    replies['/api/auth/passkey/register/verify'] = { status: 409, body: { error: 'already_registered' } };

    const result = await addPasskeyDevice();

    expect(result).toEqual({ ok: true, device: null, alreadyOnDevice: true });
    expect(readDeviceKeys()).toEqual([b64url('klucz-telefonu')]);
    expect(passkeyButtonAvailable()).toBe(true);
  });

  it('na komputerze bez zmian: zwykły komunikat i nic nie zapisane', async () => {
    setDevice(MAC, 0);
    phoneAlreadyHoldsAKey();

    const result = await addPasskeyDevice();

    expect(result).toMatchObject({
      ok: false,
      code: 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED',
      message: 'To urządzenie jest już dodane do Twojego konta.',
    });
    expect(readDeviceKeys()).toEqual([]);
  });
});

describe('lista kluczy telefonu', () => {
  it('nie zapamiętuje klucza z innego urządzenia (kod QR z telefonu obok)', async () => {
    window.localStorage.setItem(DEVICE_KEYS, JSON.stringify([b64url('klucz-telefonu')]));
    credentials.get.mockResolvedValue(assertion('klucz-z-tabletu', 'cross-platform'));

    const result = await signInWithPasskey();

    expect(result.ok).toBe(true);
    expect(readDeviceKeys()).toEqual([b64url('klucz-telefonu')]);
  });
});

describe('logowanie na telefonie bez zapamiętanego klucza', () => {
  it('przycisk „Zaloguj biometrią” jest i prowadzi do podpowiedzi w polu e-mail, bez okna z kodem QR', async () => {
    // Podpowiedź (mediation: 'conditional') czeka, aż klient wybierze klucz.
    credentials.get.mockImplementation(() => new Promise(() => {}));
    const { PasskeyLogin } = await import('@/components/auth/passkey-login');

    const container = await render(
      <form>
        <input id="email" autoComplete="username webauthn" />
        <PasskeyLogin withSeparator={false} />
      </form>,
    );
    await act(async () => {
      button(container, 'Zaloguj biometrią').click();
    });

    expect(document.activeElement?.id).toBe('email');
    expect(container.textContent).toContain(PASSKEY_SUGGESTION_HINT);
    // Jedyne wywołanie WebAuthn to podpowiedź w polu e-mail.
    expect(credentials.get).toHaveBeenCalledTimes(1);
    expect(credentials.get.mock.calls[0]![0]).toMatchObject({ mediation: 'conditional' });
  });
});

describe('propozycja „Włącz logowanie biometrią” po logowaniu hasłem', () => {
  it('telefon z kluczem konta: „Włącz” kończy się potwierdzeniem, nie czerwonym błędem', async () => {
    phoneAlreadyHoldsAKey();
    const { PasskeyEnrollOffer } = await import('@/components/auth/passkey-enroll-offer');

    const container = await render(<PasskeyEnrollOffer />);
    await act(async () => {
      button(container, 'Włącz').click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toBe(PASSKEY_ALREADY_ON_DEVICE_MESSAGE);
  });
});

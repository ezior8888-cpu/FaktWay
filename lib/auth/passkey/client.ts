import {
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';

import {
  PASSKEY_NETWORK_ERROR,
  passkeyBrowserErrorMessage,
  passkeyServerMessage,
  type PasskeyCeremony,
} from '@/lib/auth/passkey/messages';
import type { PasskeyDevice } from '@/lib/auth/passkey/types';
import { PASSKEY_DEVICE_KEYS_KEY } from '@/lib/auth/device-cookies';

/**
 * Strona przeglądarkowa końcówek `app/api/auth/passkey/*`. Aplikacja natywna woła
 * te same końcówki przez swoją wtyczkę, więc logika serwera nie zależy od tego pliku.
 * Wszystko zwraca wynik zamiast rzucać: komponenty pokazują `message` albo nic (`null`).
 */

/*
 * Telefon i tablet: tylko klucz zapisany na tym urządzeniu (poprawka Bartosza
 * 03.11.2026). Okno systemowe proponowało też „inne urządzenie”, czyli kod QR,
 * a kodu z ekranu telefonu nie zeskanuje się tym samym telefonem.
 *
 * - Dodawanie: `authenticatorAttachment: 'platform'`, klucz powstaje w tym
 *   telefonie (twarz albo odcisk palca), bez propozycji innego urządzenia.
 * - Logowanie przyciskiem: tylko klucze, które ten telefon już dodał albo
 *   którymi się logował (lista w `localStorage`), z transportem `internal`,
 *   czyli bez kodu QR. Telefon bez takiego klucza nie pokazuje przycisku
 *   (`passkeyButtonAvailable`), zostaje podpowiedź w polu e-mail, która QR
 *   nie pokazuje, i propozycja dodania klucza po logowaniu hasłem.
 *
 * Serwer się nie zmienia: lista kluczy i wskazówki w oknie systemowym nie są
 * sprawdzane przy weryfikacji (liczy się wyzwanie i klucz z bazy), a aplikacja
 * natywna ma własną wtyczkę. Na komputerze wszystko zostaje jak było, tam
 * kod QR dla telefonu ma sens.
 */

const MAX_DEVICE_KEYS = 10;

/** Telefon albo tablet. iPadOS przedstawia się jak Mac, ale ma ekran dotykowy. */
export function isHandheldDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  const { userAgent, maxTouchPoints } = navigator;
  const uaData = (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData;
  return (
    uaData?.mobile === true
    || /Android|iPhone|iPad|iPod/i.test(userAgent)
    || (/Macintosh/.test(userAgent) && maxTouchPoints > 1)
  );
}

export function readDeviceKeys(): string[] {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(PASSKEY_DEVICE_KEYS_KEY) ?? '[]');
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function writeDeviceKeys(keys: string[]): void {
  try {
    window.localStorage.setItem(PASSKEY_DEVICE_KEYS_KEY, JSON.stringify(keys.slice(0, MAX_DEVICE_KEYS)));
  } catch {
    // Tryb prywatny: telefon nie zapamięta klucza, zostaje logowanie hasłem i podpowiedź w polu e-mail.
  }
}

function rememberDeviceKey(id: string): void {
  writeDeviceKeys([id, ...readDeviceKeys().filter((known) => known !== id)]);
}

function forgetDeviceKey(id: string): void {
  writeDeviceKeys(readDeviceKeys().filter((known) => known !== id));
}

/** Przycisk „Zaloguj biometrią”: na telefonie tylko wtedy, gdy ten telefon ma już swój klucz. */
export function passkeyButtonAvailable(): boolean {
  return !isHandheldDevice() || readDeviceKeys().length > 0;
}

/** Logowanie na telefonie: znane klucze tego urządzenia, bez innych urządzeń. */
export function loginOptionsForThisDevice(
  options: PublicKeyCredentialRequestOptionsJSON,
  deviceKeys: readonly string[],
): PublicKeyCredentialRequestOptionsJSON {
  return {
    ...options,
    hints: ['client-device'],
    ...(deviceKeys.length > 0
      ? { allowCredentials: deviceKeys.map((id) => ({ id, type: 'public-key' as const, transports: ['internal' as const] })) }
      : {}),
  };
}

/** Dodawanie na telefonie: klucz w tym urządzeniu, bez propozycji innego. */
export function registrationOptionsForThisDevice(
  options: PublicKeyCredentialCreationOptionsJSON,
): PublicKeyCredentialCreationOptionsJSON {
  return {
    ...options,
    hints: ['client-device'],
    authenticatorSelection: { ...options.authenticatorSelection, authenticatorAttachment: 'platform' },
  };
}

type FailureStage = 'options' | 'ceremony' | 'verify';

export type PasskeyFailure = {
  ok: false;
  code: string;
  message: string | null;
  /** Na którym etapie padło: podpowiedź w tle milczy, dopóki klient niczego nie wybrał. */
  stage: FailureStage;
};

async function callApi<T>(
  path: string,
  ceremony: PasskeyCeremony,
  stage: FailureStage,
  init: RequestInit,
): Promise<({ ok: true } & T) | PasskeyFailure> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    });
  } catch {
    return { ok: false, code: 'network', message: PASSKEY_NETWORK_ERROR, stage };
  }
  const json = (await response.json().catch(() => null)) as ({ error?: string } & T) | null;
  if (!response.ok || !json) {
    const code = json?.error ?? 'unknown';
    return { ok: false, code, message: passkeyServerMessage(code, ceremony), stage };
  }
  return { ...json, ok: true };
}

const post = <T>(path: string, ceremony: PasskeyCeremony, stage: FailureStage, body: unknown) =>
  callApi<T>(path, ceremony, stage, { method: 'POST', body: JSON.stringify(body) });

function ceremonyFailure(error: unknown, ceremony: PasskeyCeremony): PasskeyFailure {
  const { name, code } = (error ?? {}) as { name?: string; code?: string };
  return {
    ok: false,
    code: code ?? name ?? 'unknown',
    message: passkeyBrowserErrorMessage(error, ceremony),
    stage: 'ceremony',
  };
}

/**
 * `conditional`: podpowiedź w polu e-mail (autofill). Czeka w tle, aż klient wybierze
 * passkey z listy; kliknięcie przycisku przerywa ją samo (`WebAuthnAbortService`).
 */
export async function signInWithPasskey(
  options: { redirectTo?: string; conditional?: boolean; isCancelled?: () => boolean } = {},
) {
  const begin = await post<{ options: PublicKeyCredentialRequestOptionsJSON }>(
    '/api/auth/passkey/login/options', 'login', 'options', {},
  );
  if (!begin.ok) return begin;
  if (options.isCancelled?.()) {
    return { ok: false, code: 'cancelled', message: null, stage: 'ceremony' } satisfies PasskeyFailure;
  }
  // Podpowiedź w polu e-mail i tak pomija listę kluczy (`useBrowserAutofill`).
  const handheld = isHandheldDevice();
  const optionsJSON = handheld ? loginOptionsForThisDevice(begin.options, readDeviceKeys()) : begin.options;
  let response;
  try {
    response = await startAuthentication({ optionsJSON, useBrowserAutofill: options.conditional === true });
  } catch (error) {
    return ceremonyFailure(error, 'login');
  }
  const result = await post<{ redirectTo: string }>('/api/auth/passkey/login/verify', 'login', 'verify', {
    response,
    redirectTo: options.redirectTo,
  });
  if (handheld) {
    // Klucz usunięty z konta nie może dalej blokować przycisku na tym telefonie.
    if (result.ok) rememberDeviceKey(response.id);
    else if (result.code === 'passkey_login_failed') forgetDeviceKey(response.id);
  }
  return result;
}

export async function addPasskeyDevice() {
  const begin = await post<{ options: PublicKeyCredentialCreationOptionsJSON }>(
    '/api/auth/passkey/register/options', 'registration', 'options', {},
  );
  if (!begin.ok) return begin;
  const handheld = isHandheldDevice();
  let response;
  try {
    response = await startRegistration({
      optionsJSON: handheld ? registrationOptionsForThisDevice(begin.options) : begin.options,
    });
  } catch (error) {
    return ceremonyFailure(error, 'registration');
  }
  const result = await post<{ device: PasskeyDevice }>(
    '/api/auth/passkey/register/verify', 'registration', 'verify', { response },
  );
  if (handheld && result.ok) rememberDeviceKey(response.id);
  return result;
}

export function removePasskeyDevice(id: string) {
  return callApi<{ othersSignedOut: boolean }>(
    `/api/auth/passkey/${encodeURIComponent(id)}`, 'registration', 'verify', { method: 'DELETE' },
  );
}

export function fetchPasskeyDevices() {
  return callApi<{ devices: PasskeyDevice[]; canManage: boolean }>(
    '/api/auth/passkey', 'registration', 'options', { method: 'GET' },
  );
}

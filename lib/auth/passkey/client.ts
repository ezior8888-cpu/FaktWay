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
 *   czyli bez kodu QR. Telefon bez takiego klucza (`passkeyButtonAvailable`)
 *   dostaje przycisk, który prowadzi do podpowiedzi w polu e-mail: ona też
 *   nie pokazuje kodu QR, a wybrany klucz trafia na listę.
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

/** Klucz z innego urządzenia (telefon obok, przez kod QR) nie jest kluczem tego telefonu. */
function usedOnThisDevice(response: { authenticatorAttachment?: string | null }): boolean {
  return response.authenticatorAttachment !== 'cross-platform';
}

/**
 * Czy telefon zna swój klucz. Bez tego przycisk „Zaloguj biometrią” nie otwiera okna
 * systemowego (pokazałoby kod QR), tylko prowadzi do podpowiedzi w polu e-mail
 * (`components/auth/passkey-login.tsx`). Lista bywa pusta także przy kluczu na telefonie:
 * klucz sprzed 05.11.2026, zsynchronizowany z komputera, wyczyszczone dane strony.
 */
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
    if (result.ok && usedOnThisDevice(response)) rememberDeviceKey(response.id);
    // Klucz usunięty z konta nie może dalej blokować przycisku na tym telefonie.
    else if (!result.ok && result.code === 'passkey_login_failed') forgetDeviceKey(response.id);
  }
  return result;
}

/** Nowe urządzenie albo potwierdzenie, że telefon ma już klucz tego konta. */
export type AddPasskeyResult =
  | { ok: true; device: PasskeyDevice; alreadyOnDevice: false }
  | { ok: true; device: null; alreadyOnDevice: true }
  | PasskeyFailure;

export async function addPasskeyDevice(): Promise<AddPasskeyResult> {
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
    const failure = ceremonyFailure(error, 'registration');
    // Telefon trzyma już jeden z kluczy konta (`excludeCredentials`), np. dodany przed
    // 05.11.2026 albo zsynchronizowany z komputera: po Face ID albo blokadzie ekranu system
    // odmawia drugiego (iOS 18+, Chrome na Androidzie). Dla klienta to sukces. Którego klucza
    // to dotyczy, nie wiemy, więc nic nie zapamiętujemy: pierwsze logowanie pójdzie przez
    // podpowiedź w polu e-mail, a ona zapisze dokładny klucz.
    if (
      handheld
      && failure.code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED'
      && (begin.options.excludeCredentials?.length ?? 0) > 0
    ) {
      return { ok: true, device: null, alreadyOnDevice: true };
    }
    return failure;
  }
  const result = await post<{ device: PasskeyDevice }>(
    '/api/auth/passkey/register/verify', 'registration', 'verify', { response },
  );
  if (!result.ok) {
    // Ten klucz jest już w bazie, a telefon właśnie go zwrócił, więc to na pewno jego klucz.
    if (handheld && result.code === 'already_registered' && usedOnThisDevice(response)) {
      rememberDeviceKey(response.id);
      return { ok: true, device: null, alreadyOnDevice: true };
    }
    return result;
  }
  if (handheld && usedOnThisDevice(response)) rememberDeviceKey(response.id);
  return { ok: true, device: result.device, alreadyOnDevice: false };
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

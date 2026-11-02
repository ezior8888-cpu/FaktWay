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

/**
 * Strona przeglądarkowa końcówek `app/api/auth/passkey/*`. Aplikacja natywna woła
 * te same końcówki przez swoją wtyczkę, więc logika serwera nie zależy od tego pliku.
 * Wszystko zwraca wynik zamiast rzucać: komponenty pokazują `message` albo nic (`null`).
 */

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
  let response;
  try {
    response = await startAuthentication({ optionsJSON: begin.options, useBrowserAutofill: options.conditional === true });
  } catch (error) {
    return ceremonyFailure(error, 'login');
  }
  return post<{ redirectTo: string }>('/api/auth/passkey/login/verify', 'login', 'verify', {
    response,
    redirectTo: options.redirectTo,
  });
}

export async function addPasskeyDevice() {
  const begin = await post<{ options: PublicKeyCredentialCreationOptionsJSON }>(
    '/api/auth/passkey/register/options', 'registration', 'options', {},
  );
  if (!begin.ok) return begin;
  let response;
  try {
    response = await startRegistration({ optionsJSON: begin.options });
  } catch (error) {
    return ceremonyFailure(error, 'registration');
  }
  return post<{ device: PasskeyDevice }>('/api/auth/passkey/register/verify', 'registration', 'verify', { response });
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

import type { KsefEnvironment } from '@/types/ksef';

import type { KsefAuthSession } from './auth';
import { KsefApiError, ksefFetch } from './client';

/**
 * Odświeżenie tokenu dostępu refresh tokenem, bez pełnego logowania XAdES
 * (sesja 14 planu skalowania, KSEF-08).
 *
 * Kontrakt (OpenAPI KSeF 2.0, `POST /auth/token/refresh`): `Authorization: Bearer
 * {refreshToken}`, odpowiedź `{ accessToken: { token, validUntil } }`. Refresh
 * tokenu w odpowiedzi nie ma, a dokumentacja mówi, że można go używać wielokrotnie
 * (do 7 dni), więc zostaje dotychczasowy z dotychczasową ważnością.
 */
export async function refreshKsefSession(
  session: KsefAuthSession,
  env?: KsefEnvironment,
): Promise<KsefAuthSession> {
  const response = await ksefFetch<{ accessToken: { token: string; validUntil: string } }>('/auth/token/refresh', {
    method: 'POST',
    accessToken: session.refreshToken,
    env,
  });
  return {
    ...session,
    accessToken: response.accessToken.token,
    accessTokenExpiresAt: new Date(response.accessToken.validUntil).getTime(),
  };
}

/**
 * KSeF odrzucił refresh token (400 21301/21304/21308, 401, 403): sesja jest
 * martwa i pomoże dopiero pełne logowanie. 429, 5xx, timeout i sieć to nie
 * odrzucenie: logowanie też by nie przeszło, a kosztuje dużo więcej.
 */
export function isRefreshRejected(error: unknown): boolean {
  if (!(error instanceof KsefApiError)) return false;
  return error.status >= 400 && error.status < 500 && error.status !== 429 && error.status !== 408;
}

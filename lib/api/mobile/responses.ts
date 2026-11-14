import 'server-only';

import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';

import type { MobileApiError, MobileApiErrorCode } from '@/lib/api/mobile/kontrakt';

/**
 * Odpowiedzi API aplikacji na telefon (`/api/mobile/v1`, plan aplikacji
 * mobilnej 4.3): zawsze JSON i `Cache-Control: no-store` (dane konta i firmy).
 * Błąd ma stały kod po angielsku (lista w `lib/api/mobile/kontrakt.ts`), po
 * którym aplikacja wybiera swój tekst, i opis po polsku; nigdy treść błędu
 * bazy ani GoTrue.
 *
 * Osobna lista od publicznego API (`lib/api/v1/responses.ts`): tamtą wiąże
 * dokumentacja OpenAPI dla klientów zewnętrznych.
 */

const BASE_HEADERS = { 'Cache-Control': 'no-store' } as const;

export const MOBILE_UNAVAILABLE = 'FaktWay jest chwilowo niedostępny. Spróbuj ponownie za chwilę.';

export function mobileError(
  status: number,
  code: MobileApiErrorCode,
  message: string,
  headers: Record<string, string> = {},
  field?: string,
): NextResponse {
  const body: MobileApiError = { error: { code, message, ...(field ? { field } : {}) } };
  return NextResponse.json(body, { status, headers: { ...BASE_HEADERS, ...headers } });
}

export function mobileJson(body: unknown, status: 200 | 201, headers: Record<string, string> = {}): NextResponse {
  return NextResponse.json(body, { status, headers: { ...BASE_HEADERS, ...headers } });
}

/** Błąd bazy albo sieci: zgłoszenie do nas, a telefon dostaje 503 bez szczegółów i ponawia. */
export class MobileUpstreamError extends Error {
  constructor(context: string) {
    super(`api_mobile_upstream: ${context}`);
    this.name = 'MobileUpstreamError';
  }
}

/**
 * Wspólne zakończenie trasy: błąd bazy daje 503, każdy inny wyjątek 500
 * z identyfikatorem żądania. Szczegóły idą do Sentry.
 */
export function mobileFailure(error: unknown, requestId: string, headers: Record<string, string>): NextResponse {
  if (error instanceof MobileUpstreamError) {
    Sentry.captureMessage(error.message, { level: 'error', tags: { area: 'api.mobile' }, extra: { requestId } });
    return mobileError(503, 'service_unavailable', MOBILE_UNAVAILABLE, headers);
  }
  Sentry.captureException(error, { tags: { area: 'api.mobile' }, extra: { requestId } });
  return mobileError(500, 'internal_error', `Nieoczekiwany błąd. Podaj nam identyfikator ${requestId}.`, headers);
}

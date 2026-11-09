import { NextResponse } from 'next/server';

/**
 * Odpowiedzi publicznego API: zawsze JSON i `Cache-Control: no-store`
 * (dane firmy). Błąd ma stały kod po angielsku i opis po polsku, nigdy
 * treść błędu bazy.
 */

export type ApiErrorCode =
  | 'missing_api_key'
  | 'invalid_api_key'
  | 'insufficient_scope'
  | 'invalid_parameter'
  | 'not_found'
  | 'rate_limited'
  | 'api_disabled'
  | 'maintenance'
  | 'service_unavailable'
  | 'internal_error';

const BASE_HEADERS = { 'Cache-Control': 'no-store' } as const;

export function apiError(
  status: number,
  code: ApiErrorCode,
  message: string,
  headers: Record<string, string> = {},
): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status, headers: { ...BASE_HEADERS, ...headers } });
}

export function apiOk(body: unknown, headers: Record<string, string> = {}): NextResponse {
  return NextResponse.json(body, { status: 200, headers: { ...BASE_HEADERS, ...headers } });
}

/** Błąd bazy albo sieci: zgłoszenie do nas, a klient dostaje 503 bez szczegółów. */
export class ApiUpstreamError extends Error {
  constructor(context: string) {
    super(`api_v1_upstream: ${context}`);
    this.name = 'ApiUpstreamError';
  }
}

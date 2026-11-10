import { NextResponse } from 'next/server';

/**
 * Odpowiedzi publicznego API: zawsze JSON i `Cache-Control: no-store`
 * (dane firmy). Błąd ma stały kod po angielsku i opis po polsku, nigdy
 * treść błędu bazy.
 */

/** Wszystkie kody błędów API; opis OpenAPI (`Error.code`) ma dokładnie tę listę (test dokumentacji). */
export const API_ERROR_CODES = [
  'missing_api_key',
  'invalid_api_key',
  'insufficient_scope',
  'invalid_parameter',
  'not_found',
  'rate_limited',
  'api_disabled',
  'maintenance',
  'service_unavailable',
  'internal_error',
  // POST /api/v1/invoices (krok 7.1, część 2).
  'missing_idempotency_key',
  'invalid_idempotency_key',
  'idempotency_conflict',
  'invalid_json',
  'unsupported_media_type',
  'payload_too_large',
  'validation_failed',
  'unsupported_invoice_kind',
  'unsupported_currency',
  'unsupported_buyer',
  'number_required',
  'number_taken',
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/** Pole treści żądania z błędem: ścieżka jak w JSON (`buyer.nip`, `items[0].quantity`) i opis po polsku. */
export interface ApiFieldError {
  field: string;
  message: string;
}

const BASE_HEADERS = { 'Cache-Control': 'no-store' } as const;

export function apiError(
  status: number,
  code: ApiErrorCode,
  message: string,
  headers: Record<string, string> = {},
  fields?: ApiFieldError[],
): NextResponse {
  const error = fields && fields.length > 0 ? { code, message, fields } : { code, message };
  return NextResponse.json({ error }, { status, headers: { ...BASE_HEADERS, ...headers } });
}

export function apiOk(body: unknown, headers: Record<string, string> = {}): NextResponse {
  return NextResponse.json(body, { status: 200, headers: { ...BASE_HEADERS, ...headers } });
}

export function apiCreated(body: unknown, headers: Record<string, string> = {}): NextResponse {
  return NextResponse.json(body, { status: 201, headers: { ...BASE_HEADERS, ...headers } });
}

/** Błąd bazy albo sieci: zgłoszenie do nas, a klient dostaje 503 bez szczegółów. */
export class ApiUpstreamError extends Error {
  constructor(context: string) {
    super(`api_v1_upstream: ${context}`);
    this.name = 'ApiUpstreamError';
  }
}

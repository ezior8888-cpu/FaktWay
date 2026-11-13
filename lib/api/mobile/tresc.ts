import 'server-only';

import type { NextResponse } from 'next/server';

import { mobileError } from '@/lib/api/mobile/responses';

/**
 * Treść JSON żądania z telefonu (`/api/mobile/v1`): typ treści, rozmiar
 * i składnia, zanim trasa dotknie bazy. Wspólne dla zapisów M8 i M10.
 */

export type JsonBody = { ok: true; value: unknown } | { ok: false; response: NextResponse };

export async function readJsonBody(
  request: Request,
  headers: Record<string, string>,
  options: { maxBytes: number; tooLarge: string; optional?: boolean },
): Promise<JsonBody> {
  const type = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  // Treść opcjonalna (np. zapłata bez dnia): brak treści to pusty obiekt.
  if (options.optional && !type && !request.body) return { ok: true, value: {} };
  if (type !== 'application/json') {
    return { ok: false, response: mobileError(400, 'invalid_request', 'Treść żądania to JSON (Content-Type: application/json).', headers) };
  }
  const declared = Number(request.headers.get('content-length') ?? '0');
  const text = Number.isFinite(declared) && declared > options.maxBytes ? null : await request.text();
  if (text === null || Buffer.byteLength(text, 'utf8') > options.maxBytes) {
    return { ok: false, response: mobileError(400, 'invalid_request', options.tooLarge, headers) };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, response: mobileError(400, 'invalid_request', 'Treść żądania nie jest poprawnym JSON.', headers) };
  }
}

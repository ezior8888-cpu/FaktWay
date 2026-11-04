import 'server-only';

import { NextResponse } from 'next/server';

/** Odpowiedzi końcówek `app/api/auth/passkey/*`: stałe kody, zero szczegółów z SDK. */

const PRIVATE_HEADERS = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
/** Odpowiedź WebAuthn ma kilka kilobajtów; więcej to nie jest uwierzytelniacz. */
const MAX_BODY_BYTES = 64 * 1024;

export function passkeyJson(body: Record<string, unknown>, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: PRIVATE_HEADERS });
}

export function passkeyError(error: string, status: number): NextResponse {
  return passkeyJson({ error }, status);
}

export function passkeyRateLimited(retryAfter: number): NextResponse {
  return NextResponse.json({ error: 'rate_limited' }, {
    status: 429,
    headers: { ...PRIVATE_HEADERS, 'Retry-After': String(Math.max(1, retryAfter)) },
  });
}

/**
 * `undefined`, gdy ciało jest za duże albo nie jest JSON-em. Czytamy strumień z limitem,
 * bo logowanie jest publiczne, a przy `Transfer-Encoding: chunked` nie ma `Content-Length`.
 */
export async function readJsonBody(request: Request): Promise<unknown> {
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return undefined;
  const reader = request.body?.getReader();
  if (!reader) return undefined;
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return undefined;
  }
}

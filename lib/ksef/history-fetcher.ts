/**
 * Pobranie XML pojedynczej faktury z KSeF 2.x (`GET /invoices/ksef/{numer}`)
 * dla ścieżek z identyfikatorem firmy (archiwum XML Skrzynki KSeF —
 * `inbox-xml.ts`).
 *
 * Historię metadanych (`fetchInvoicesMetadata` Magicznego importu) usunięto
 * 22.10.2026 (decyzja Bartosza): historię pobiera automatycznie
 * `lib/ksef/history-sync/` — jedno zapytanie na wywołanie, z własnym budżetem.
 */

import type { KsefEnvironment } from '@/types/ksef';

import { ksefFetch } from './client';
import { requireMatchingKsefEnvironment } from './claim-environment';
import { ksefRateLimiter } from './rate-limiter';
import { getValidSession, ksefSessionCache } from './session-cache';

function resolveEnv(env?: KsefEnvironment): KsefEnvironment {
  return requireMatchingKsefEnvironment(env);
}

/**
 * XML faktury jako dokładne bajty z KSeF — do archiwum i skrótu SHA-256
 * (KOD I, #122 część B). `fetchInvoiceXml` dekoduje tekst i gubi np. BOM.
 */
export async function fetchInvoiceXmlBytes(
  tenantId: string,
  ksefNumber: string,
  env?: KsefEnvironment,
): Promise<Buffer> {
  const conn = await getValidSession(tenantId, resolveEnv(env));
  if (!conn) {
    throw new Error('Brak aktywnej sesji KSeF');
  }

  const resolved = resolveEnv(env);

  return ksefRateLimiter.enqueue(conn.auth.nip, async () => {
    const session = await ksefSessionCache.getSession(conn.auth, resolved);

    const body = await ksefFetch<Buffer>(`/invoices/ksef/${encodeURIComponent(ksefNumber)}`, {
      accessToken: session.accessToken,
      headers: { Accept: 'application/xml' },
      env: resolved,
      responseType: 'bytes',
    });
    if (!Buffer.isBuffer(body) || body.length === 0) {
      throw new Error('KSeF zwrócił pusty XML faktury');
    }
    return body;
  });
}

/** Pełny XML FA pojedynczej faktury (numer KSeF). */
export async function fetchInvoiceXml(
  tenantId: string,
  ksefNumber: string,
  env?: KsefEnvironment,
): Promise<string> {
  const conn = await getValidSession(tenantId, resolveEnv(env));
  if (!conn) {
    throw new Error('Brak aktywnej sesji KSeF');
  }

  const resolved = resolveEnv(env);

  return ksefRateLimiter.enqueue(conn.auth.nip, async () => {
    const session = await ksefSessionCache.getSession(conn.auth, resolved);

    return ksefFetch<string>(`/invoices/ksef/${encodeURIComponent(ksefNumber)}`, {
      accessToken: session.accessToken,
      headers: { Accept: 'application/xml' },
      env: resolved,
    });
  });
}

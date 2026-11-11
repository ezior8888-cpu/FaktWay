/**
 * Pobranie XML pojedynczej faktury z KSeF 2.x (`GET /invoices/ksef/{numer}`)
 * dla ścieżek z identyfikatorem firmy (archiwum XML Skrzynki KSeF —
 * `inbox-xml.ts`).
 *
 * Historię metadanych (`fetchInvoicesMetadata` Magicznego importu) usunięto
 * 22.10.2026 (decyzja Bartosza): historię pobiera automatycznie
 * `lib/ksef/history-sync/` — jedno zapytanie na wywołanie, z własnym budżetem.
 *
 * Sesja (logowanie, odświeżenie) tylko wewnątrz kolejki firmy (L1a): błędy
 * KSeF wychodzą z rodzajem, więc 429 i lokalna pauza firmy po 429
 * (`KsefRateLimitPausedError`) docierają do wołającego jako `KsefApiError` 429.
 * Dawne `getValidSession` przed kolejką zamieniało każdy błąd (także 429)
 * w „Brak aktywnej sesji KSeF”.
 */

import type { KsefEnvironment } from '@/types/ksef';
import { getTenantKsefCredentials } from '@/lib/supabase/admin-queries';

import type { KsefAuth } from './auth';
import { ksefFetch } from './client';
import { requireMatchingKsefEnvironment } from './claim-environment';
import { ksefRateLimiter } from './rate-limiter';
import { ksefSessionCache } from './session-cache';

function resolveEnv(env?: KsefEnvironment): KsefEnvironment {
  return requireMatchingKsefEnvironment(env);
}

/**
 * Poświadczenia firmy. Brak albo błąd odczytu (brak certyfikatu, NIP
 * niezweryfikowany, odszyfrowanie) daje jak dotąd „Brak aktywnej sesji KSeF”,
 * z przyczyną w `cause`.
 */
async function tenantAuth(tenantId: string): Promise<KsefAuth> {
  try {
    return await getTenantKsefCredentials(tenantId);
  } catch (e) {
    throw new Error('Brak aktywnej sesji KSeF', { cause: e });
  }
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
  const resolved = resolveEnv(env);
  const auth = await tenantAuth(tenantId);

  return ksefRateLimiter.enqueue(auth.nip, async () => {
    const session = await ksefSessionCache.getSession(auth, resolved);

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
  const resolved = resolveEnv(env);
  const auth = await tenantAuth(tenantId);

  return ksefRateLimiter.enqueue(auth.nip, async () => {
    const session = await ksefSessionCache.getSession(auth, resolved);

    return ksefFetch<string>(`/invoices/ksef/${encodeURIComponent(ksefNumber)}`, {
      accessToken: session.accessToken,
      headers: { Accept: 'application/xml' },
      env: resolved,
    });
  });
}

import { checkStoredLogo } from '@/lib/pdf/logo-obraz';
import type { PdfLogo } from '@/lib/pdf/logo';
import { getTenantLogo, isTenantLogoKey } from '@/lib/storage/logo';
import { createAdminClient } from '@/lib/supabase/server';

/**
 * Logo firmy do wydruku (plan kompletnej aplikacji, krok 2.2, część 1):
 * klucz z `tenants.logo_storage_key` (00203) i plik z magazynu.
 *
 * Wydruk nigdy nie odmawia z powodu logo: brak klucza, brak pliku, błąd bazy
 * albo magazynu i plik, który nie przeszedł sprawdzenia (`checkStoredLogo`),
 * dają PDF bez logo i wpis `[pdf-logo]` w logu procesu (bez treści pliku).
 * Brak kolumny przed wgraniem 00203 to zwykły brak logo, bez wpisu.
 */

function isMissingColumn(code: string | undefined): boolean {
  return code === '42703' || code === 'PGRST204';
}

/**
 * Klucz logo z `tenants` kluczem serwisowym (wydruk działa też w workerze
 * i na stronie faktury dla nabywcy, bez sesji; firmę sprawdza wywołujący).
 * Klucz spoza katalogu logo tej firmy (wiersz bazy to dane) to `null`, bez
 * odczytu magazynu.
 */
export async function readTenantLogoKey(tenantId: string): Promise<string | null> {
  try {
    const { data, error } = await createAdminClient()
      .from('tenants')
      .select('logo_storage_key')
      .eq('id', tenantId)
      .maybeSingle();
    if (error) {
      if (!isMissingColumn(error.code)) {
        console.warn('[pdf-logo] nie udało się odczytać klucza logo, PDF bez logo', { tenantId, code: error.code ?? null });
      }
      return null;
    }
    const key = (data as { logo_storage_key?: unknown } | null)?.logo_storage_key;
    if (key === null || key === undefined || key === '') return null;
    if (!isTenantLogoKey(key, tenantId)) {
      console.warn('[pdf-logo] klucz logo spoza katalogu firmy, PDF bez logo', { tenantId });
      return null;
    }
    return key;
  } catch (error) {
    console.warn('[pdf-logo] nie udało się odczytać klucza logo, PDF bez logo', {
      tenantId,
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return null;
  }
}

/** Plik logo po sprawdzeniu albo `null` z wpisem w logu. */
export async function loadPdfLogo(key: string, tenantId: string): Promise<PdfLogo | null> {
  if (!isTenantLogoKey(key, tenantId)) {
    console.warn('[pdf-logo] klucz logo spoza katalogu firmy, PDF bez logo', { tenantId });
    return null;
  }
  let bytes: Buffer | null;
  try {
    bytes = await getTenantLogo(key, tenantId);
  } catch (error) {
    console.warn('[pdf-logo] błąd odczytu logo z magazynu, PDF bez logo', {
      tenantId,
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return null;
  }
  if (!bytes) {
    console.warn('[pdf-logo] brak pliku logo w magazynie, PDF bez logo', { tenantId });
    return null;
  }
  const logo = checkStoredLogo(bytes);
  if (!logo) console.warn('[pdf-logo] plik logo nie przeszedł sprawdzenia, PDF bez logo', { tenantId });
  return logo;
}

/**
 * Logo firmy do wydruku proformy i oferty: klucz (do klucza idempotencji
 * maila) i plik. Klucz bez pliku (`logo: null`) znaczy wydruk bez logo.
 */
export async function loadCompanyPdfLogo(tenantId: string): Promise<{ key: string | null; logo: PdfLogo | null }> {
  const key = await readTenantLogoKey(tenantId);
  return { key, logo: key ? await loadPdfLogo(key, tenantId) : null };
}

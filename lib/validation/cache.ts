// Cache wrapper dla walidacji NIP — ogranicza zapytania do Białej Listy / VIES.
//
// Faza 22: dorzucamy warstwę Redis (`lib/cache`) przed DB validation_cache, żeby
// powtórne sprawdzenia tego samego NIP-a (typowe przy bulk import 100+ faktur
// z tym samym kontrahentem) nie hammer-owały Postgres. Hierarchia:
//
//   1. Redis (TTL 24h, in-memory)
//   2. validation_cache (DB, TTL 24h, durable + hit_count audit)
//   3. Live API (Whitelist / VIES)
//
// Gdy Redis nieskonfigurowany lub padnie — automatic fallback do DB cache
// (`lib/cache/index.ts` ma fail-soft semantykę).

import type { Database } from '@/types/database';
import { createAdminClient } from '@/lib/supabase/admin';
import { cached, cacheDel, cacheKeys, cacheSet, TTL_SECONDS } from '@/lib/cache';
import {
  checkNipInWhitelist,
  type WhitelistResponse,
} from './whitelist-client';
import {
  checkVatInVies,
  type ViesResponse,
} from './vies-client';

export type CachedVatStatus =
  | 'active'
  | 'exempt'
  | 'inactive'
  | 'unknown';

export interface CachedValidationResult {
  nip: string;
  countryCode: string;
  isValid: boolean;
  vatStatus: CachedVatStatus;
  legalName?: string;
  registeredAddress?: string;
  bankAccounts: string[];
  registrationDate?: string;
  terminationDate?: string;
  fromCache: boolean;
  cachedAt?: string;
  source: 'whitelist' | 'vies';
  warning?: string;
  /**
   * API chwilowo niedostępne (timeout, limit zapytań, błąd serwera). Taki
   * wynik to „nie wiemy”, nie „nieaktywny bez rachunków”: nie trafia do
   * cache, a zapis do kontrahenta go pomija (`contractorValidationPatch`).
   * Do 01.10.2026 jedna awaria API kasowała status VAT i zweryfikowane
   * rachunki kontrahenta na 7 dni (nocna re-walidacja) i truła cache na 24 h.
   */
  unavailable?: boolean;
}

const TRANSIENT_WHITELIST_ERRORS = new Set(['RATE_LIMIT', 'API_ERROR', 'TIMEOUT']);
const TRANSIENT_VIES_ERRORS = new Set(['API_ERROR', 'TIMEOUT', 'SERVICE_DOWN']);

type DbVatStatus = Database['public']['Enums']['vat_status_enum'];
type ValidationCacheRow = Database['public']['Tables']['validation_cache']['Row'];

function normalizeCountry(code: string): string {
  return code.trim().toUpperCase() || 'PL';
}

function vatStatusFromDb(
  value: DbVatStatus | null,
): CachedValidationResult['vatStatus'] {
  if (
    value === 'active' ||
    value === 'exempt' ||
    value === 'inactive' ||
    value === 'unknown'
  ) {
    return value;
  }
  return 'unknown';
}

function toDbVatStatus(
  value: CachedValidationResult['vatStatus'],
): DbVatStatus {
  return value;
}

// ============================================================================
// MAIN: validate NIP z cache
// ============================================================================

export async function validateNipCached(
  nip: string,
  countryCode: string = 'PL',
  options: { forceRefresh?: boolean } = {},
): Promise<CachedValidationResult> {
  const supabase = createAdminClient();
  const normalizedCountry = normalizeCountry(countryCode);
  const cleanNip = nip.replace(/[\s\-]/g, '').toUpperCase();

  const source: 'whitelist' | 'vies' =
    normalizedCountry === 'PL' ? 'whitelist' : 'vies';
  const redisKey = cacheKeys.nipValidation(cleanNip, normalizedCountry);

  if (!options.forceRefresh) {
    // Warstwa 1: Redis (TTL 24h) — najszybsza.
    const redisHit = await cached<CachedValidationResult>(
      redisKey,
      TTL_SECONDS.nipValidation,
      async () => {
        // Warstwa 2: DB validation_cache.
        const { data: dbCached } = await supabase
          .from('validation_cache')
          .select('*')
          .eq('nip', cleanNip)
          .eq('country_code', normalizedCountry)
          .eq('source', source)
          .gt('expires_at', new Date().toISOString())
          .maybeSingle();

        // „unknown” w cache to ślad dawnej awarii API (przed 01.10.2026) —
        // pytamy API jeszcze raz zamiast oddawać „nie wiemy” przez 24 h.
        if (!dbCached || dbCached.vat_status === 'unknown') return null;

        // Inkrement hit_count tylko gdy Redis miss (Redis hit = już policzone
        // pośrednio). Zapisuje "ostatnio rzeczywiście użyto" semantykę.
        await supabase
          .from('validation_cache')
          .update({ hit_count: (dbCached.hit_count ?? 0) + 1 })
          .eq('id', dbCached.id);

        return mapRowToCached(dbCached, source);
      },
    );

    if (redisHit && redisHit.vatStatus !== 'unknown') return redisHit;
  } else {
    // forceRefresh: czyścimy Redis, żeby kolejne calls nie dostały starego.
    await cacheDel(redisKey);
  }

  let result: CachedValidationResult;

  if (source === 'whitelist') {
    const apiResult = await checkNipInWhitelist(cleanNip);
    result = mapWhitelistToCacheResult(apiResult, cleanNip);
  } else {
    const apiResult = await checkVatInVies(normalizedCountry, cleanNip);
    result = mapViesToCacheResult(apiResult, normalizedCountry, cleanNip);
  }

  if (result.unavailable) return result;

  const insertRow: Database['public']['Tables']['validation_cache']['Insert'] =
    {
      nip: cleanNip,
      country_code: normalizedCountry,
      source,
      is_valid: result.isValid,
      vat_status: toDbVatStatus(result.vatStatus),
      legal_name: result.legalName ?? null,
      registered_address: result.registeredAddress ?? null,
      registration_date: result.registrationDate ?? null,
      termination_date: result.terminationDate ?? null,
      bank_accounts: result.bankAccounts,
      cached_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      hit_count: 0,
    };

  const { error } = await supabase
    .from('validation_cache')
    .upsert(insertRow, {
      onConflict: 'nip,country_code,source',
    });

  if (error) {
    throw new Error(
      `validation_cache upsert failed: ${error.code} ${error.message}`,
    );
  }

  // Warstwa 1: świeży wynik trafia do Redisa na 24h. Robimy to po DB upsert,
  // żeby DB i Redis były spójne — jeśli DB upsert padnie, Redis się nie zapisuje.
  await cacheSet(redisKey, result, TTL_SECONDS.nipValidation);

  return result;
}

function mapRowToCached(
  cached: ValidationCacheRow,
  source: 'whitelist' | 'vies',
): CachedValidationResult {
  return {
    nip: cached.nip,
    countryCode: cached.country_code,
    isValid: cached.is_valid ?? false,
    vatStatus: vatStatusFromDb(cached.vat_status),
    legalName: cached.legal_name ?? undefined,
    registeredAddress: cached.registered_address ?? undefined,
    bankAccounts: cached.bank_accounts ?? [],
    registrationDate: cached.registration_date ?? undefined,
    terminationDate: cached.termination_date ?? undefined,
    fromCache: true,
    cachedAt: cached.cached_at,
    source,
  };
}

// ============================================================================
// Mapowanie: Whitelist → CachedValidationResult
// ============================================================================

function mapWhitelistToCacheResult(
  apiResult: WhitelistResponse,
  nip: string,
): CachedValidationResult {
  if (!apiResult.success) {
    return {
      nip,
      countryCode: 'PL',
      isValid: false,
      vatStatus: 'unknown',
      bankAccounts: [],
      fromCache: false,
      source: 'whitelist',
      warning: apiResult.error,
      unavailable: TRANSIENT_WHITELIST_ERRORS.has(apiResult.errorCode),
    };
  }

  let warning: string | undefined;
  const today = new Date().toISOString().slice(0, 10);

  if (apiResult.removalDate && apiResult.removalDate <= today) {
    warning = `Wykreślony z VAT od ${apiResult.removalDate}`;
  } else if (apiResult.registrationLegalDate) {
    const regDate = new Date(apiResult.registrationLegalDate);
    const daysSinceReg = (Date.now() - regDate.getTime()) / 86400000;
    if (daysSinceReg < 7) {
      warning = `Świeżo zarejestrowany (${apiResult.registrationLegalDate})`;
    }
  }

  const vatStatus: CachedVatStatus = apiResult.vatStatus;

  return {
    nip: apiResult.nip,
    countryCode: 'PL',
    isValid:
      apiResult.vatStatus === 'active' || apiResult.vatStatus === 'exempt',
    vatStatus,
    legalName: apiResult.legalName,
    registeredAddress: apiResult.registeredAddress,
    bankAccounts: apiResult.bankAccounts,
    registrationDate: apiResult.registrationLegalDate,
    terminationDate: apiResult.removalDate,
    fromCache: false,
    source: 'whitelist',
    warning,
  };
}

// ============================================================================
// Mapowanie: VIES → CachedValidationResult
// ============================================================================

function mapViesToCacheResult(
  apiResult: ViesResponse,
  countryCode: string,
  vatNumber: string,
): CachedValidationResult {
  if (!apiResult.success) {
    return {
      nip: vatNumber,
      countryCode,
      isValid: false,
      vatStatus: 'unknown',
      bankAccounts: [],
      fromCache: false,
      source: 'vies',
      warning: apiResult.error,
      unavailable: TRANSIENT_VIES_ERRORS.has(apiResult.errorCode),
    };
  }

  return {
    nip: apiResult.vatNumber,
    countryCode,
    isValid: apiResult.isValid,
    vatStatus: apiResult.isValid ? 'active' : 'inactive',
    legalName: apiResult.legalName,
    registeredAddress: apiResult.registeredAddress,
    bankAccounts: [],
    fromCache: false,
    source: 'vies',
  };
}

// ============================================================================
// Bulk validate (dla batch processing)
// ============================================================================

export async function validateMultipleNips(
  nips: Array<{ nip: string; countryCode?: string }>,
  options: { forceRefresh?: boolean; concurrency?: number } = {},
): Promise<CachedValidationResult[]> {
  const concurrency = options.concurrency ?? 3;
  const results: CachedValidationResult[] = [];

  for (let i = 0; i < nips.length; i += concurrency) {
    const batch = nips.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map((item) =>
        validateNipCached(item.nip, item.countryCode ?? 'PL', options),
      ),
    );
    results.push(...batchResults);

    if (i + concurrency < nips.length) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  return results;
}

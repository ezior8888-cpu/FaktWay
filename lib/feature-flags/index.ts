/**
 * Feature flags — per-tenant (DB-backed) + global (Vercel Edge Config).
 *
 * Per-tenant (`tenant_feature_flags`):
 *   Granularny kill-switch / roll-out. Tabela `tenant_feature_flags` (RLS:
 *   SELECT only z client-side, INSERT/UPDATE wyłącznie service_role).
 *   Cache: Redis 10min TTL (`TTL_SECONDS.featureFlags`), invalidacja przy
 *   admin update przez `invalidateAllTenantCaches`.
 *
 * Global (`lib/feature-flags/global-flags.ts` — tabela `global_feature_flags`):
 *   Runtime kill-switch dla całej apki — `killAllKsefSubmissions`,
 *   `maintenanceMode`, etc. Odczyt przez Redis (TTL 60 s), zapis z panelu
 *   admina czyści cache. Do Etapu 8 migracji Hetzner siedziało to w Vercel
 *   Edge Config.
 *
 * Reguła kciuka:
 *   - Coś dla pojedynczych klientów → per-tenant (DB)
 *   - Coś dla wszystkich naraz (np. "wyłączamy Magic Import bo KSeF API padło")
 *     → globalna flaga (`global_feature_flags`)
 */

import { cached, cacheKeys, TTL_SECONDS } from '@/lib/cache';
import { createAdminClient } from '@/lib/supabase/admin';

import { getGlobalFlag } from './global-flags';

export type PerTenantFlag =
  | 'co_pilot_enabled'
  | 'magic_import_enabled'
  | 'exports_enabled'
  /** Pilotaż modułu księgowości JDG (00165, plan księgowości K8); obszary rozstrzyga `lib/ksiegowosc/wylacznik.ts`. */
  | 'ksiegowosc_enabled';

export type GlobalFlag =
  | 'killAllKsefSubmissions'
  | 'maintenanceMode'
  | 'disableSignups'
  | 'killFloAgent';

interface TenantFlagsRow {
  tenant_id: string;
  co_pilot_enabled: boolean;
  magic_import_enabled: boolean;
  exports_enabled: boolean;
  ksiegowosc_enabled: boolean;
}

/**
 * Sprawdza czy globalny flag jest włączony. Flaga globalna jest pierwszą
 * warstwą — gdy `killAllKsefSubmissions=true`, ignorujemy per-tenant
 * `co_pilot_enabled` i tak zwracamy "wyłączone".
 */
export async function isGlobalFlagEnabled(flag: GlobalFlag): Promise<boolean> {
  return getGlobalFlag(flag);
}

/**
 * Per-tenant feature flag z 10min Redis cache. Domyślnie false (opt-in roll-out).
 *
 * `tenantId` powinien pochodzić z zwalidowanej sesji (np. `getPageContext()`) —
 * funkcja NIE waliduje że user ma dostęp do tenantu, bo uprawnienia musi sprawdzić wywołujący.
 * Klient administracyjny omija RLS; sam format identyfikatora nie daje dostępu.
 */
export async function getTenantFlag(
  tenantId: string,
  flag: PerTenantFlag,
): Promise<boolean> {
  const flags = await getTenantFlags(tenantId);
  return flags[flag] === true;
}

export async function getTenantFlags(
  tenantId: string,
): Promise<Record<PerTenantFlag, boolean>> {
  const cachedFlags = await cached<Record<PerTenantFlag, boolean>>(
    cacheKeys.featureFlags(tenantId),
    TTL_SECONDS.featureFlags,
    async () => {
      const supabase = createAdminClient();
      const { data, error } = await supabase
        .from('tenant_feature_flags')
        .select('co_pilot_enabled, magic_import_enabled, exports_enabled, ksiegowosc_enabled')
        .eq('tenant_id', tenantId)
        .maybeSingle();

      if (error) {
        throw new Error(`tenant_feature_flags lookup failed: ${error.message}`);
      }

      // Brak wiersza = wszystkie flagi false (default opt-in).
      const row = (data ?? null) as Omit<TenantFlagsRow, 'tenant_id'> | null;
      return {
        co_pilot_enabled: row?.co_pilot_enabled ?? false,
        magic_import_enabled: row?.magic_import_enabled ?? false,
        exports_enabled: row?.exports_enabled ?? false,
        ksiegowosc_enabled: row?.ksiegowosc_enabled ?? false,
      };
    },
  );

  // Cache miss + RPC error = przerywamy 'na wszelki wypadek' i zwracamy false.
  // Bezpieczniej dla pojedynczego usera nie widzieć modułu niż żeby globalny
  // outage Redisa odsłonił feature który nie jest jeszcze gotowy.
  return (
    cachedFlags ?? {
      co_pilot_enabled: false,
      magic_import_enabled: false,
      exports_enabled: false,
      ksiegowosc_enabled: false,
    }
  );
}

/**
 * Kompozycja: zwraca true jeśli i global i per-tenant są ON. Używaj w
 * gating logic („pokaż UI tylko jeśli można").
 */
export async function isModuleEnabled(
  tenantId: string,
  perTenant: PerTenantFlag,
  globalKill?: GlobalFlag,
): Promise<boolean> {
  if (globalKill) {
    const killed = await isGlobalFlagEnabled(globalKill);
    if (killed) return false;
  }
  return getTenantFlag(tenantId, perTenant);
}

/**
 * Feature flags admin queries (Faza 24 Krok 5).
 *
 * Łączy `tenants` z `tenant_feature_flags` (LEFT JOIN — brak wiersza =
 * domyślnie wszystkie flagi false zgodnie z spec'em Fazy 22).
 *
 * Service-role only (admin client). Po zmianie flagi wołamy
 * `invalidateAllTenantCaches` z Fazy 22 żeby user natychmiast zobaczył
 * nowy stan (bez 10min Redis TTL).
 */

import 'server-only';

import { requireAdmin } from '@/lib/auth/admin-guard';
import { createAdminClient } from '@/lib/supabase/admin';
import type { PerTenantFlag } from '@/lib/feature-flags';
import { hasConfiguredKsefProof } from '@/lib/ksef/claim-environment';

export interface TenantWithFlags {
  tenantId: string;
  tenantName: string;
  tenantNip: string;
  isActive: boolean;
  ksefVerified: boolean;
  createdAt: string | null;
  flags: Record<PerTenantFlag, boolean>;
}

export interface ListFlagsOptions {
  /** Search po nazwie / NIP. */
  q?: string;
  /** Filtr po wartości konkretnej flagi (pokaż tylko gdzie włączona). */
  enabledOnly?: PerTenantFlag;
  page?: number;
  pageSize?: number;
}

const DEFAULT_PAGE_SIZE = 50;

export async function listTenantsWithFlags(
  opts: ListFlagsOptions = {},
): Promise<{
  items: TenantWithFlags[];
  total: number;
  page: number;
  pageSize: number;
}> {
  await requireAdmin();
  const supabase = createAdminClient();
  const page = opts.page ?? 0;
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;

  let tenantsQuery = supabase
    .from('tenants')
    .select(
      'id, name, nip, is_active, ksef_verified_at, ksef_verified_environment, created_at',
      { count: 'exact' },
    )
    .is('deleted_at', null);

  if (opts.q) {
    const q = opts.q.trim();
    tenantsQuery = tenantsQuery.or(`name.ilike.%${q}%,nip.ilike.%${q}%`);
  }

  // Pull all matching tenants then JOIN flags in-memory. Dla < 5k tenantów
  // szybsze niż dwa zapytania PostgREST (RPC z JOIN by było optymalne ale
  // wymaga typed gen po regeneracji).
  const { data: tenants, count, error } = await tenantsQuery
    .order('created_at', { ascending: false })
    .range(page * pageSize, page * pageSize + pageSize - 1);

  if (error) {
    throw new Error(`tenants list failed: ${error.message}`);
  }

  const tenantIds = (tenants ?? []).map((t) => t.id);
  let flagsByTenant = new Map<string, Record<PerTenantFlag, boolean>>();

  if (tenantIds.length > 0) {
    const { data: flagsData, error: flagsErr } = await supabase
      .from('tenant_feature_flags')
      .select('tenant_id, co_pilot_enabled, magic_import_enabled, exports_enabled, ksiegowosc_enabled')
      .in('tenant_id', tenantIds);

    if (flagsErr) {
      throw new Error(`flags lookup failed: ${flagsErr.message}`);
    }

    flagsByTenant = new Map(
      (flagsData ?? []).map((f) => [
        f.tenant_id,
        {
          co_pilot_enabled: Boolean(f.co_pilot_enabled),
          magic_import_enabled: Boolean(f.magic_import_enabled),
          exports_enabled: Boolean(f.exports_enabled),
          ksiegowosc_enabled: Boolean(f.ksiegowosc_enabled),
        },
      ]),
    );
  }

  let items: TenantWithFlags[] = (tenants ?? []).map((t) => ({
    tenantId: t.id,
    tenantName: t.name,
    tenantNip: t.nip,
    isActive: t.is_active,
    ksefVerified: hasConfiguredKsefProof(t.ksef_verified_at, t.ksef_verified_environment),
    createdAt: t.created_at,
    flags: flagsByTenant.get(t.id) ?? {
      co_pilot_enabled: false,
      magic_import_enabled: false,
      exports_enabled: false,
      ksiegowosc_enabled: false,
    },
  }));

  if (opts.enabledOnly) {
    items = items.filter((t) => t.flags[opts.enabledOnly!]);
  }

  return { items, total: count ?? 0, page, pageSize };
}

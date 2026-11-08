'use server';

import { revalidatePath } from 'next/cache';

import { invalidateAllTenantCaches } from '@/lib/cache/invalidation';
import { logAuditSystem } from '@/lib/audit/log-system';
import { requireAdmin } from '@/lib/auth/admin-guard';
import { createAdminClient } from '@/lib/supabase/admin';
import type { PerTenantFlag } from '@/lib/feature-flags';

export type FlagToggleResult =
  | { success: true; message?: string }
  | { success: false; error: string };

const ALLOWED_FLAGS: PerTenantFlag[] = [
  'co_pilot_enabled',
  'magic_import_enabled',
  'exports_enabled',
  // Pilotaż księgowości JDG (K8): włączenie modułu dla firmy z audytem zamiast UPDATE kluczem serwisowym.
  'ksiegowosc_enabled',
];

/**
 * Włącza/wyłącza flagę dla konkretnego tenanta. Upsert do `tenant_feature_flags`
 * (PK po `tenant_id`), invalidacja Redis cache (Faza 22), audit log.
 */
export async function toggleTenantFlagAction(
  tenantId: string,
  flag: PerTenantFlag,
  enabled: boolean,
): Promise<FlagToggleResult> {
  const admin = await requireAdmin();

  if (!ALLOWED_FLAGS.includes(flag)) {
    return { success: false, error: `Nieznana flaga: ${flag}` };
  }

  const supabase = createAdminClient();

  // Upsert — gdy wiersz nie istnieje, default'y w schema (false) wypełnią
  // pozostałe kolumny. Następnie OVERRIDE tej jednej.
  const { error } = await supabase
    .from('tenant_feature_flags')
    .upsert(
      {
        tenant_id: tenantId,
        [flag]: enabled,
      },
      { onConflict: 'tenant_id' },
    );

  if (error) {
    return { success: false, error: error.message };
  }

  // Invalidacja cache — user widzi nowy stan przy następnym request bez
  // czekania na 10min TTL.
  await invalidateAllTenantCaches(tenantId);

  await logAuditSystem({
    action: 'admin.flag.toggled',
    tenantId,
    userId: admin.userId,
    entityType: 'tenant_feature_flags',
    entityId: tenantId,
    metadata: {
      adminEmail: admin.email,
      flag,
      enabled,
    },
  });

  revalidatePath('/admin/flags');

  return {
    success: true,
    message: `${flag}: ${enabled ? 'WŁ' : 'WYŁ'}`,
  };
}

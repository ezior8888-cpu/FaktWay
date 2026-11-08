import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Pilotaż księgowości JDG (plan, K8): moduł włącza się firmie przełącznikiem
 * w `/admin/flags` (flaga `tenant_feature_flags.ksiegowosc_enabled`, 00165),
 * z audytem i czyszczeniem cache, zamiast UPDATE kluczem serwisowym. Atrapy
 * dla bazy, cache, audytu i sprawdzenia admina; reguły akcji są prawdziwe.
 */

const mocks = vi.hoisted(() => ({
  upserty: [] as Record<string, unknown>[],
  audyt: vi.fn(),
  cache: vi.fn(),
  flagi: [] as Record<string, unknown>[],
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/auth/admin-guard', () => ({ requireAdmin: async () => ({ userId: 'admin-1', email: 'admin@faktway.test' }) }));
vi.mock('@/lib/cache/invalidation', () => ({ invalidateAllTenantCaches: mocks.cache }));
vi.mock('@/lib/audit/log-system', () => ({ logAuditSystem: mocks.audyt }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      if (tabela === 'tenant_feature_flags') {
        return {
          upsert: async (w: Record<string, unknown>) => {
            mocks.upserty.push(w);
            return { error: null };
          },
          select: () => ({ in: async () => ({ data: mocks.flagi, error: null }) }),
        };
      }
      const l: Record<string, unknown> = {};
      for (const m of ['select', 'order', 'range', 'or', 'eq', 'is']) l[m] = () => l;
      l.then = (ok: (v: unknown) => unknown) =>
        Promise.resolve({
          data: [{ id: 't1', name: 'Firma pilotażowa', nip: '1234567890', is_active: true, created_at: '2026-01-01', ksef_verified_at: null, ksef_verified_environment: null }],
          count: 1,
          error: null,
        }).then(ok);
      return l;
    },
  }),
}));

const { toggleTenantFlagAction } = await import('@/app/admin/flags/actions');
const { listTenantsWithFlags } = await import('@/lib/admin/flags');

beforeEach(() => {
  mocks.upserty = [];
  mocks.audyt.mockReset();
  mocks.cache.mockReset();
  mocks.flagi = [];
});

describe('pilotaż księgowości w /admin/flags (K8)', () => {
  it('przełącznik włącza moduł firmie: zapis flagi, czyszczenie cache i audyt z adresem admina', async () => {
    expect(await toggleTenantFlagAction('t1', 'ksiegowosc_enabled', true)).toMatchObject({ success: true });
    expect(mocks.upserty).toEqual([{ tenant_id: 't1', ksiegowosc_enabled: true }]);
    expect(mocks.cache).toHaveBeenCalledWith('t1');
    expect(mocks.audyt).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'admin.flag.toggled', tenantId: 't1', metadata: expect.objectContaining({ flag: 'ksiegowosc_enabled', enabled: true, adminEmail: 'admin@faktway.test' }) }),
    );
  });

  it('lista firm pokazuje stan flagi modułu; firma bez wiersza flag ma moduł wyłączony', async () => {
    mocks.flagi = [{ tenant_id: 't1', co_pilot_enabled: false, magic_import_enabled: false, exports_enabled: true, ksiegowosc_enabled: true }];
    expect((await listTenantsWithFlags({})).items[0].flags).toMatchObject({ ksiegowosc_enabled: true, exports_enabled: true });
    mocks.flagi = [];
    expect((await listTenantsWithFlags({})).items[0].flags).toMatchObject({ ksiegowosc_enabled: false });
  });
});

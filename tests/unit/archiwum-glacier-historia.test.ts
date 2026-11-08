import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';

/**
 * `cron.archive-old-invoices` kopiuje XML faktur starszych niż 2 lata do
 * Glacier i planuje ich usunięcie za 8 lat. Faktury z historii KSeF
 * (`origin = ksef_import`, decyzja Bartosza 22.10.2026) mają oryginał w KSeF —
 * Glacier dla nich dopiero po potwierdzeniu konfiguracji AWS na produkcji.
 * Bez filtra synchronizacja historii od 2022 r. wysłałaby do archiwum (i do
 * planu usunięcia) tysiące świeżo pobranych faktur.
 */

type Row = Record<string, unknown>;
const m = vi.hoisted(() => ({
  invoices: [] as Row[],
  glacier: vi.fn(async (_t: string, id: string) => `glacier/${id}`),
  updates: [] as Array<{ patch: Row; ids: unknown }>,
}));

vi.mock('@/lib/storage/glacier', () => ({ uploadToGlacier: m.glacier }));
vi.mock('@/lib/storage/r2', () => ({
  downloadInvoiceXml: vi.fn(async () => '<Faktura/>'),
  downloadInvoiceXmlUnchecked: vi.fn(async () => '<Faktura/>'),
}));
vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const predicates: Array<(r: Row) => boolean> = [];
      let patch: Row | null = null;
      let ids: unknown = null;
      const q = {
        select: () => q,
        lt: (k: string, v: string) => { predicates.push((r) => String(r[k]) < v); return q; },
        is: (k: string, v: unknown) => { predicates.push((r) => (v === null ? r[k] == null : r[k] === v)); return q; },
        not: (k: string, op: string, v: unknown) => {
          expect(op).toBe('is'); expect(v).toBeNull();
          predicates.push((r) => r[k] != null); return q;
        },
        neq: (k: string, v: unknown) => { predicates.push((r) => r[k] != null && r[k] !== v); return q; },
        eq: (k: string, v: unknown) => { predicates.push((r) => r[k] === v); return q; },
        in: (k: string, v: unknown[]) => { ids = v; predicates.push((r) => v.includes(r[k])); return q; },
        limit: () => q,
        update: (p: Row) => { patch = p; return q; },
        maybeSingle: async () => ({ data: null, error: null }),
        then: (ok: (v: unknown) => unknown) => {
          if (patch) {
            m.updates.push({ patch, ids });
            return Promise.resolve({ data: null, error: null }).then(ok);
          }
          const rows = table === 'invoices' ? m.invoices.filter((r) => predicates.every((p) => p(r))) : [];
          return Promise.resolve({ data: rows, error: null }).then(ok);
        },
      };
      return q;
    },
  }),
}));

import { runArchiveOldInvoices } from '@/lib/jobs/runners/archive-old-invoices';

const ctx = {
  attempt: 0,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  step: { run: async (_n: string, fn: () => unknown) => fn(), sleep: vi.fn(), sendEvent: vi.fn(), scheduleAfter: vi.fn() },
} as unknown as JobContext;

const old = (id: string, origin: string): Row => ({
  id, tenant_id: 't-1', issue_date: '2020-01-15', xml_storage_path: `t-1/${id}.xml`, archived_at: null, origin,
});

beforeEach(() => {
  vi.clearAllMocks();
  m.updates = [];
});

describe('archiwum Glacier a historia z KSeF', () => {
  it('nie archiwizuje (ani nie planuje usunięcia) faktur pobranych z historii KSeF', async () => {
    m.invoices = [old('app-1', 'app'), old('hist-1', 'ksef_import'), old('file-1', 'file_import')];

    await expect(runArchiveOldInvoices(ctx)).resolves.toEqual({ archived: 2 });

    expect(m.glacier.mock.calls.map((c) => c[1])).toEqual(['app-1', 'file-1']);
    for (const update of m.updates.filter((u) => 'archived_at' in u.patch || 'scheduled_deletion_at' in u.patch)) {
      expect(update.ids).toEqual(['app-1', 'file-1']);
    }
  });
});

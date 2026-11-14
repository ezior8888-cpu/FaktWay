import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  /** Wywołania `.lt(kolumna, wartość)`: granica archiwizacji. */
  lt: [] as Array<[string, string]>,
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
        lt: (k: string, v: string) => { m.lt.push([k, v]); predicates.push((r) => String(r[k]) < v); return q; },
        is: (k: string, v: unknown) => { predicates.push((r) => (v === null ? r[k] == null : r[k] === v)); return q; },
        not: (k: string, op: string, v: unknown) => {
          expect(op).toBe('is'); expect(v).toBeNull();
          predicates.push((r) => r[k] != null); return q;
        },
        neq: (k: string, v: unknown) => { predicates.push((r) => r[k] != null && r[k] !== v); return q; },
        eq: (k: string, v: unknown) => { if (k === 'id') ids = [v]; predicates.push((r) => r[k] === v); return q; },
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
  m.lt = [];
});

describe('archiwum Glacier a historia z KSeF', () => {
  it('nie archiwizuje (ani nie planuje usunięcia) faktur pobranych z historii KSeF', async () => {
    m.invoices = [old('app-1', 'app'), old('hist-1', 'ksef_import'), old('file-1', 'file_import')];

    await expect(runArchiveOldInvoices(ctx)).resolves.toEqual({ archived: 2 });

    expect(m.glacier.mock.calls.map((c) => c[1])).toEqual(['app-1', 'file-1']);
    // Znaczniki (i data usunięcia) tylko dla faktur skopiowanych do Glacier,
    // niezależnie od tego, czy zapis idzie jedną listą, czy po fakturze.
    const marked = m.updates
      .filter((u) => 'archived_at' in u.patch || 'scheduled_deletion_at' in u.patch)
      .flatMap((u) => u.ids as unknown[]);
    expect([...new Set(marked)].sort()).toEqual(['app-1', 'file-1']);
  });
});

/**
 * Granica archiwizacji i termin usunięcia w samym runnerze (NZ-RET-01,
 * `lib/retention/terminy.ts`). Test niezmiennika w `tests/filtr/` sprawdza
 * czyste funkcje; tu sprawdzamy, że runner bierze faktury ściśle sprzed
 * granicy (`.lt`, nie `.lte`), zapisuje termin z tej samej chwili co granica
 * i że oba są dniami w Polsce, a nie w strefie procesu.
 */
describe('archiwum Glacier: granica i termin usunięcia', () => {
  afterEach(() => vi.useRealTimers());

  const plan = () => m.updates.find((u) => 'scheduled_deletion_at' in u.patch);

  it.each([
    // 29.02.2028, 3:00 (CET): granica 28.02.2026, termin to północ po 29.02.2036.
    ['2028-02-29T02:00:00Z', '2026-02-28', '2026-02-27', '2036-02-29T23:00:00.000Z'],
    // 26.03.2034, dzień zmiany czasu, 3:00 (CEST): granica 26.03.2032, północ po 26.03.2042 (CET).
    ['2034-03-26T01:00:00Z', '2032-03-26', '2032-03-25', '2042-03-26T23:00:00.000Z'],
  ])('przebieg %s: granica %s bez faktury z tego dnia, faktura z %s usuwana od %s', async (chwila, granica, ostatnia, termin) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(chwila));
    m.invoices = [{ ...old('ostatnia', 'app'), issue_date: ostatnia }, { ...old('z-granicy', 'app'), issue_date: granica }];

    await expect(runArchiveOldInvoices(ctx)).resolves.toEqual({ archived: 1 });

    expect(m.lt).toEqual([['issue_date', granica]]);
    expect(plan()?.ids).toEqual(['ostatnia']);
    expect(plan()?.patch.scheduled_deletion_at).toBe(termin);
  });

  it('przebieg przez północ: termin z chwili startu, jak granica, a nie z kroku planowania', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2028-12-31T22:59:00Z')); // 31.12.2028, 23:59 w Polsce
    m.glacier.mockImplementationOnce(async (_t: string, id: string) => {
      vi.setSystemTime(new Date('2028-12-31T23:05:00Z')); // już 1.01.2029
      return `glacier/${id}`;
    });
    m.invoices = [{ ...old('a', 'app'), issue_date: '2026-12-30' }];

    await runArchiveOldInvoices(ctx);

    expect(m.lt).toEqual([['issue_date', '2026-12-31']]);
    // Dziś 31.12.2028 plus 8 lat to 31.12.2036; północ po nim to 1.01.2037, 0:00 (CET).
    expect(plan()?.patch.scheduled_deletion_at).toBe('2036-12-31T23:00:00.000Z');
  });
});

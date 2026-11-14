import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';

/**
 * FZ-011 (i punkt 30 planu skalowania 3000): `cron.archive-old-invoices`
 * oznaczał nawet 500 faktur jednym `.in('id', ids)`, a ten filtr trafia do
 * adresu PATCH (500 identyfikatorów to ok. 19 KB, ponad limit wiersza
 * żądania bramki, `lib/pagination/in-list.ts`). Zapisy idą paczkami
 * z `inListChunks` (najwyżej 100 wartości i 4000 znaków w adresie, dla UUID
 * 88 w paczce), a wynik jest ten sam: każda kandydatka oznaczona raz. Każda
 * paczka zapisuje obie kolumny naraz (FZ-009), więc błąd w kolejnej paczce
 * nie zostawia poprzednich bez terminu usunięcia.
 */

type Row = Record<string, unknown>;
const m = vi.hoisted(() => ({
  invoices: [] as Row[],
  /** Każdy zapis do `invoices`: zmiana i lista z `.in('id', …)` (albo `null` przy `.eq`). */
  zapisy: [] as Array<{ patch: Row; ids: string[] | null }>,
  /** Numer zapisu listą (od 1), który raz kończy się błędem; `null`: bez błędu. */
  bladZapisuListy: null as number | null,
}));

vi.mock('@/lib/storage/glacier', () => ({ uploadToGlacier: vi.fn(async (_t: string, id: string) => `glacier/${id}`) }));
vi.mock('@/lib/storage/r2', () => ({
  downloadInvoiceXml: vi.fn(async () => '<Faktura/>'),
  downloadInvoiceXmlUnchecked: vi.fn(async () => '<Faktura/>'),
}));
vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const predicates: Array<(r: Row) => boolean> = [];
      let patch: Row | null = null;
      let ids: string[] | null = null;
      const q = {
        select: () => q,
        lt: (k: string, v: string) => { predicates.push((r) => String(r[k]) < v); return q; },
        is: (k: string, v: unknown) => { predicates.push((r) => (v === null ? r[k] == null : r[k] === v)); return q; },
        not: () => { predicates.push((r) => r.xml_storage_path != null); return q; },
        neq: (k: string, v: unknown) => { predicates.push((r) => r[k] != null && r[k] !== v); return q; },
        eq: (k: string, v: unknown) => { predicates.push((r) => r[k] === v); return q; },
        in: (k: string, v: string[]) => { ids = v; predicates.push((r) => v.includes(r[k] as string)); return q; },
        limit: () => q,
        update: (p: Row) => { patch = p; return q; },
        maybeSingle: async () => ({ data: null, error: null }),
        then: (ok: (v: unknown) => unknown) => {
          if (patch && table === 'invoices') {
            if (ids && m.bladZapisuListy !== null && m.zapisy.filter((z) => z.ids).length + 1 === m.bladZapisuListy) {
              m.bladZapisuListy = null;
              return Promise.resolve({ data: null, error: { message: 'canceling statement due to statement timeout' } }).then(ok);
            }
            m.zapisy.push({ patch, ids });
            for (const r of m.invoices.filter((r) => predicates.every((p) => p(r)))) Object.assign(r, patch);
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

const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const faktura = (i: number): Row => ({
  id: uuid(i), tenant_id: 't-1', issue_date: '2020-01-15', xml_storage_path: `t-1/${i}.xml`, archived_at: null, origin: 'app',
});

beforeEach(() => {
  vi.clearAllMocks();
  m.zapisy = [];
  m.bladZapisuListy = null;
});

describe('archiwum Glacier: zapisy paczkami (FZ-011)', () => {
  it('500 kandydatek (limit przebiegu): każdy zapis listą najwyżej 100 identyfikatorów, każda faktura oznaczona raz', async () => {
    m.invoices = Array.from({ length: 500 }, (_, i) => faktura(i));

    await expect(runArchiveOldInvoices(ctx)).resolves.toEqual({ archived: 500 });

    const listy = m.zapisy.filter((z) => z.ids !== null);
    expect(listy.length).toBeGreaterThan(0);
    expect(Math.max(...listy.map((z) => z.ids!.length))).toBeLessThanOrEqual(100);
    for (const kolumna of ['archived_at', 'scheduled_deletion_at']) {
      const oznaczone = listy.filter((z) => kolumna in z.patch).flatMap((z) => z.ids!);
      expect(oznaczone.sort()).toEqual(m.invoices.map((f) => f.id).sort());
    }
    expect(m.invoices.every((f) => f.archived_at != null && typeof f.scheduled_deletion_at === 'string')).toBe(true);
  });

  it('błąd w drugiej paczce: pierwsza ma już termin, ponowienie od zera oznacza resztę', async () => {
    m.invoices = Array.from({ length: 250 }, (_, i) => faktura(i));
    m.bladZapisuListy = 2;

    await expect(runArchiveOldInvoices(ctx)).rejects.toThrow('statement timeout');
    // Po błędzie żadna faktura nie jest zarchiwizowana bez terminu.
    expect(m.invoices.filter((f) => f.archived_at != null && f.scheduled_deletion_at == null)).toEqual([]);

    await runArchiveOldInvoices(ctx);
    expect(m.invoices.every((f) => f.archived_at != null && typeof f.scheduled_deletion_at === 'string')).toBe(true);
  });
});

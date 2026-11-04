import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({ tables: {} as Record<string, Row[]> }));

/** Atrapa PostgREST z filtrami, których używa `getDailyMetrics` (liczenie po stronie bazy). */
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const predicates: Array<(r: Row) => boolean> = [];
      let head = false;
      const q = {
        select: (_c: string, opts?: { head?: boolean }) => { head = Boolean(opts?.head); return q; },
        eq: (k: string, v: unknown) => { predicates.push((r) => r[k] === v); return q; },
        neq: (k: string, v: unknown) => { predicates.push((r) => r[k] != null && r[k] !== v); return q; },
        in: (k: string, vs: unknown[]) => { predicates.push((r) => vs.includes(r[k])); return q; },
        gte: (k: string, v: string) => { predicates.push((r) => String(r[k]) >= v); return q; },
        order: () => q,
        then: (ok: (v: unknown) => unknown) => {
          const rows = (db.tables[table] ?? []).filter((r) => predicates.every((p) => p(r)));
          return Promise.resolve({ data: head ? null : rows, count: rows.length, error: null }).then(ok);
        },
      };
      return q;
    },
  }),
}));

import { getDailyMetrics, readSubscriptionCounts } from '@/lib/observability/business-metrics';

/**
 * AUD-106: tygodniowe metryki ściągały wszystkie aktywne i próbne
 * subskrypcje do pamięci, bez limitu. Teraz liczy baza (`count`, `head`).
 */

describe('liczby subskrypcji', () => {
  it('trzy zapytania count, bez pobierania wierszy', async () => {
    const calls: Array<{ head: boolean; filters: string[] }> = [];
    const counts: Record<string, number> = { 'active|monthly': 40, 'active|annual': 2, 'trialing|': 7 };
    const supabase = {
      from: () => ({
        select: (_c: string, opts: { head: boolean }) => {
          const filters: string[] = [];
          const q = {
            eq: (k: string, v: string) => { filters.push(`${k}=${v}`); return q; },
            then: (ok: (v: unknown) => unknown) => {
              calls.push({ head: opts.head, filters });
              const status = filters.find((f) => f.startsWith('status='))!.slice(7);
              const plan = filters.find((f) => f.startsWith('plan='))?.slice(5) ?? '';
              return Promise.resolve({ count: counts[`${status}|${plan}`], error: null }).then(ok);
            },
          };
          return q;
        },
      }),
    };

    const out = await readSubscriptionCounts(supabase as never);

    expect(out).toEqual({ active: 42, trialing: 7, monthlyCount: 40, annualCount: 2 });
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.head)).toBe(true);
  });
});

describe('metryki dzienne — faktury wystawione w FaktWay', () => {
  it('nie liczą sprzedaży pobranej z historii KSeF (`ksef_import`) — decyzja Bartosza 22.10.2026', async () => {
    const now = new Date().toISOString();
    db.tables = {
      invoices: [
        { direction: 'outgoing', origin: 'app', ksef_status: 'accepted', created_at: now },
        { direction: 'outgoing', origin: 'ksef_import', ksef_status: 'accepted', created_at: now },
        { direction: 'outgoing', origin: 'ksef_import', ksef_status: 'accepted', created_at: now },
        { direction: 'outgoing', origin: 'app', ksef_status: 'draft', created_at: now },
      ],
    };
    const metrics = await getDailyMetrics(24);
    expect(metrics.invoicesIssued).toBe(2);
    expect(metrics.invoicesAccepted).toBe(1);
  });
});

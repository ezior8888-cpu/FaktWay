import { describe, expect, it } from 'vitest';

import { listProducts, PRODUCTS_PAGE_SIZE } from '@/lib/produkty/baza';

/**
 * Odczyt katalogu stronami (PostgREST ucina odpowiedź do 1000 wierszy bez błędu).
 * Atrapa honoruje `range`, `eq`, `ilike` i zlicza zapytania.
 */

type Row = { id: string; tenant_id: string; name: string; is_archived: boolean; use_count: number };

function fake(rows: Row[], opts: { error?: boolean; cap?: number } = {}) {
  const calls: Array<{ from: number; to: number; filters: Record<string, unknown> }> = [];
  return {
    calls,
    client: {
      from() {
        const filters: Record<string, unknown> = {};
        let from = 0;
        let to = 0;
        const q = {
          select: () => q,
          eq: (k: string, v: unknown) => ((filters[k] = v), q),
          ilike: (k: string, v: unknown) => ((filters[`ilike:${k}`] = v), q),
          order: () => q,
          range: (f: number, t: number) => {
            from = f;
            to = t;
            return q;
          },
          then: (ok: (v: unknown) => unknown) => {
            calls.push({ from, to, filters });
            if (opts.error) return Promise.resolve({ data: null, count: null, error: { message: 'boom' } }).then(ok);
            const hit = rows.filter((r) => r.tenant_id === filters.tenant_id && r.is_archived === filters.is_archived);
            const cap = opts.cap ?? Infinity;
            const slice = hit.slice(from, Math.min(to + 1, from + cap));
            return Promise.resolve({ data: slice, count: hit.length, error: null }).then(ok);
          },
        };
        return q;
      },
    },
  };
}

const mk = (n: number, extra: Partial<Row> = {}): Row[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    tenant_id: 'T1',
    name: `Produkt ${i}`,
    is_archived: false,
    use_count: 0,
    ...extra,
  }));

describe('listProducts', () => {
  it('czyta więcej niż 1000 wierszy kilkoma stronami, bez ucięcia', async () => {
    const f = fake(mk(1200));
    const rows = await listProducts(f.client, 'T1', { q: '', archived: false });
    expect(rows).toHaveLength(1200);
    expect(PRODUCTS_PAGE_SIZE).toBeLessThanOrEqual(500);
    expect(f.calls.length).toBeGreaterThan(1);
  });

  it('filtruje firmę, archiwum i szukaną frazę po nazwie', async () => {
    const f = fake([...mk(3), ...mk(2, { tenant_id: 'T2' }), ...mk(1, { is_archived: true })]);
    const rows = await listProducts(f.client, 'T1', { q: 'szkol', archived: false });
    expect(rows).toHaveLength(3);
    expect(f.calls[0].filters.tenant_id).toBe('T1');
    expect(f.calls[0].filters.is_archived).toBe(false);
    expect(f.calls[0].filters['ilike:name']).toBe('%szkol%');
    const arch = await listProducts(f.client, 'T1', { q: '', archived: true });
    expect(arch).toHaveLength(1);
  });

  it('błąd bazy albo niepełna strona rzuca, nie oddaje częściowej listy', async () => {
    await expect(listProducts(fake(mk(2), { error: true }).client, 'T1', { q: '', archived: false })).rejects.toThrow();
    // serwer uciął stronę do 100 wierszy mimo 600 w bazie
    await expect(listProducts(fake(mk(600), { cap: 100 }).client, 'T1', { q: '', archived: false })).rejects.toThrow(/niepełn/i);
  });
});

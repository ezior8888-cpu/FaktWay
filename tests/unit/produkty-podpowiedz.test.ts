import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeSupabase, memoryDb, type MemoryDb, type Row } from '../helpers/fake-supabase-memory';

/**
 * Podpowiedź produktów przy nazwie pozycji faktury (plan kompletnej
 * aplikacji, krok 2.6, część 2a): `suggestProducts` (fraza, firma, bez
 * archiwum, kolejność, mapowanie) i akcja `suggestProductsAction` (firma
 * z sesji, błąd bez wyjątku). Atrapy tylko dla sesji i bazy; RLS katalogu
 * na prawdziwej bazie: migracje 00013 i 00186.
 */

const mocks = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock('@/lib/supabase/auth-context', () => ({
  requireOrgRole: mocks.auth,
  ActionAuthError: class ActionAuthError extends Error {},
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/audit/log', () => ({ logAudit: vi.fn() }));

import { suggestProductsAction } from '@/app/actions/produkty';
import { suggestProducts } from '@/lib/produkty/baza';
import { PRODUCT_SUGGESTIONS_LIMIT } from '@/lib/produkty/model';
import { ActionAuthError } from '@/lib/supabase/auth-context';

type Call = { table: string; filters: Record<string, unknown>; limit: number | null; orders: string[] };

/** Atrapa jednego zapytania: honoruje `eq`, `ilike` (zawiera) i `limit`, zapisuje wywołanie. */
function fake(rows: Row[], opts: { error?: boolean } = {}) {
  const calls: Call[] = [];
  return {
    calls,
    client: {
      from(table: string) {
        const call: Call = { table, filters: {}, limit: null, orders: [] };
        const q = {
          select: () => q,
          eq: (k: string, v: unknown) => ((call.filters[k] = v), q),
          ilike: (k: string, v: unknown) => ((call.filters[`ilike:${k}`] = v), q),
          order: (k: string) => (call.orders.push(k), q),
          limit: (n: number) => {
            call.limit = n;
            calls.push(call);
            if (opts.error) return Promise.resolve({ data: null, error: { message: 'boom' } });
            const needle = String(call.filters['ilike:name'] ?? '').replace(/%/g, '').toLowerCase();
            const hit = rows.filter(
              (r) =>
                r.tenant_id === call.filters.tenant_id &&
                r.is_archived === call.filters.is_archived &&
                String(r.name).toLowerCase().includes(needle),
            );
            return Promise.resolve({ data: hit.slice(0, n), error: null });
          },
        };
        return q;
      },
    },
  };
}

let n = 0;
function produkt(extra: Row = {}): Row {
  n += 1;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    tenant_id: 'T1',
    name: `Produkt ${n}`,
    unit: 'szt.',
    default_price_net: 100,
    default_vat_rate: '23',
    is_archived: false,
    ...extra,
  };
}

describe('suggestProducts', () => {
  it('fraza krótsza niż 2 znaki (także po usunięciu znaków specjalnych) nie pyta bazy', async () => {
    const f = fake([produkt({ name: 'Szkolenie' })]);
    expect(await suggestProducts(f.client, 'T1', ' s ')).toEqual([]);
    expect(await suggestProducts(f.client, 'T1', '%%')).toEqual([]);
    expect(await suggestProducts(f.client, 'T1', '')).toEqual([]);
    expect(f.calls).toHaveLength(0);
  });

  it('szuka w katalogu firmy, bez archiwum, frazą bez znaków wzorca', async () => {
    const f = fake([produkt({ name: 'Szkolenie' })]);
    await suggestProducts(f.client, 'T1', 'szk%_');
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toMatchObject({
      table: 'products',
      filters: { tenant_id: 'T1', is_archived: false, 'ilike:name': '%szk%' },
    });
    expect(f.calls[0]!.limit).toBeGreaterThanOrEqual(PRODUCT_SUGGESTIONS_LIMIT);
  });

  it('najpierw nazwy od frazy, potem słowa od frazy, potem reszta; w grupie kolejność z bazy', async () => {
    const f = fake([
      produkt({ name: 'Konsultacja szkoleniowa' }),
      produkt({ name: 'Szkolenie BHP' }),
      produkt({ name: 'Doszkalanie' }),
      produkt({ name: 'Szkło hartowane' }),
    ]);
    const out = await suggestProducts(f.client, 'T1', 'szk');
    expect(out.map((p) => p.name)).toEqual(['Szkolenie BHP', 'Szkło hartowane', 'Konsultacja szkoleniowa', 'Doszkalanie']);
  });

  it(`zwraca najwyżej ${PRODUCT_SUGGESTIONS_LIMIT} podpowiedzi`, async () => {
    const f = fake(Array.from({ length: 12 }, (_, i) => produkt({ name: `Usługa ${i}` })));
    const out = await suggestProducts(f.client, 'T1', 'usł');
    expect(out).toHaveLength(PRODUCT_SUGGESTIONS_LIMIT);
  });

  it('cena z bazy jako liczba albo napis, stawka spoza listy formularza to brak stawki', async () => {
    const f = fake([
      produkt({ name: 'Abonament A', unit: 'mies.', default_price_net: '1250.50', default_vat_rate: '8' }),
      produkt({ name: 'Abonament B', default_price_net: null, default_vat_rate: '7' }),
    ]);
    const out = await suggestProducts(f.client, 'T1', 'abonament');
    expect(out).toEqual([
      { id: expect.any(String), name: 'Abonament A', unit: 'mies.', priceNet: 1250.5, vatRate: '8' },
      { id: expect.any(String), name: 'Abonament B', unit: 'szt.', priceNet: null, vatRate: null },
    ]);
  });

  it('błąd bazy rzuca (pusta lista to nie „brak produktów”)', async () => {
    const f = fake([], { error: true });
    await expect(suggestProducts(f.client, 'T1', 'szk')).rejects.toThrow(/produkty/);
  });
});

describe('suggestProductsAction', () => {
  let db: MemoryDb;

  beforeEach(() => {
    vi.clearAllMocks();
    db = memoryDb({
      products: [
        produkt({ tenant_id: 'ten-1', name: 'Szkolenie' }),
        produkt({ tenant_id: 'ten-1', name: 'Szkolenie stare', is_archived: true }),
        produkt({ tenant_id: 'ten-2', name: 'Szkolenie obce' }),
      ],
    });
    mocks.auth.mockResolvedValue({ supabase: fakeSupabase(db), tenantId: 'ten-1', user: { id: 'u1' }, role: 'accountant' });
  });

  it('podpowiada produkty aktywnej firmy bez archiwum (każda rola czyta katalog)', async () => {
    const r = await suggestProductsAction('szk');
    expect(r).toEqual({ ok: true, items: [expect.objectContaining({ name: 'Szkolenie' })] });
    expect(mocks.auth).toHaveBeenCalledWith(expect.arrayContaining(['owner', 'admin', 'member', 'accountant']));
  });

  it('brak sesji albo firmy to ok: false, bez wyjątku', async () => {
    mocks.auth.mockRejectedValue(new ActionAuthError('Brak aktywnej organizacji'));
    expect(await suggestProductsAction('szk')).toEqual({ ok: false });
  });

  it('błąd bazy to ok: false, bez wyjątku', async () => {
    db.failures['products:select'] = { code: 'XX000', message: 'boom' };
    expect(await suggestProductsAction('szk')).toEqual({ ok: false });
  });

  it('wejście inne niż tekst to pusta lista bez zapytania', async () => {
    expect(await suggestProductsAction(42 as unknown as string)).toEqual({ ok: true, items: [] });
    expect(mocks.auth).not.toHaveBeenCalled();
  });
});

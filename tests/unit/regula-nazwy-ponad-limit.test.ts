import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Sesja 29 planu skalowania: reguły nazwy sprzedawcy (`name_exact`, F-084)
 * szły jednym zapytaniem bez stron. PostgREST na produkcji
 * (`PGRST_DB_MAX_ROWS = 1000`) ucina odpowiedź bez błędu, więc w firmie
 * z ponad 1000 regułami nazwy (wielu dostawców bez NIP, same paragony)
 * reguła spoza przypadkowych 1000 nie działała: paragon szedł do słów
 * kluczowych, heurystyki albo płatnego AI, choć klient słyszał „apka się
 * nauczyła”. Atrapa ucina KAŻDĄ odpowiedź do 1000 wierszy jak produkcja:
 * bez `order` w kolejności sterty, z `order('id')`, `gt('id')` i `limit`
 * stronami jak baza.
 */

type Row = Record<string, unknown>;

const db = vi.hoisted(() => {
  const MAX_ROWS = 1000;
  const byte = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const state = {
    rules: [] as Array<Record<string, unknown>>,
    updates: [] as Array<{ patch: Record<string, unknown>; eq: Array<[string, unknown]> }>,
    selects: 0,
    /** Numer odczytu (1, 2, …), który kończy się błędem bazy. */
    failOnSelect: null as number | null,
  };
  const from = (table: string) => {
    if (table !== 'categorization_rules') throw new Error(`Nieoczekiwana tabela: ${table}`);
    const filters: Array<(row: Record<string, unknown>) => boolean> = [];
    const eq: Array<[string, unknown]> = [];
    let patch: Record<string, unknown> | null = null;
    let byId = false;
    let limit: number | null = null;
    const run = () => {
      if (patch) {
        state.updates.push({ patch, eq });
        return { data: null, error: null };
      }
      state.selects += 1;
      if (state.failOnSelect === state.selects) {
        return { data: null, error: { message: 'canceling statement due to statement timeout' } };
      }
      let hits = state.rules.filter((row) => filters.every((f) => f(row)));
      if (byId) hits = [...hits].sort((a, b) => byte(String(a.id), String(b.id)));
      hits = hits.slice(0, limit ?? hits.length).slice(0, MAX_ROWS);
      return { data: hits.map((row) => ({ ...row })), error: null };
    };
    const query = {
      select: () => query,
      update: (values: Record<string, unknown>) => {
        patch = values;
        return query;
      },
      eq: (column: string, value: unknown) => {
        eq.push([column, value]);
        filters.push((row) => row[column] === value);
        return query;
      },
      gt: (column: string, value: string) => {
        filters.push((row) => String(row[column]) > value);
        return query;
      },
      order: (column: string) => {
        byId = column === 'id';
        return query;
      },
      limit: (count: number) => {
        limit = count;
        return query;
      },
      then: <A, B>(ok: (value: ReturnType<typeof run>) => A, fail?: (error: unknown) => B) =>
        Promise.resolve().then(run).then(ok, fail),
    };
    return query;
  };
  return { state, from };
});

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ from: db.from }) }));

import { classifyByExactName } from '@/lib/categorization/name-rule';

const TENANT = '33333333-3333-4333-8333-333333333333';
const OTHER_TENANT = '44444444-4444-4444-8444-444444444444';

/** uuid małymi literami: porządek napisów w JS = porządek uuid w Postgresie. */
const uuid = (n: number, x = 'a') => `${String(n).padStart(8, '0')}-${x.repeat(4)}-4${x.repeat(3)}-8${x.repeat(3)}-${x.repeat(12)}`;
/** Kolejność wstawiania ≠ kolejność id (7919 jest pierwsze, więc to permutacja 1..count). */
const heapOrder = (count: number) => Array.from({ length: count }, (_, i) => ((i * 7919) % count) + 1);

const rule = (id: string, tenant_id: string, match_type: string, match_value: string, category_label: string): Row => ({
  id, tenant_id, match_type, match_value, kpir_column: 'col_13', category_label,
  hit_count: 2, min_amount: null, max_amount: null,
});

/** Szukana reguła: dopisana do sterty jako ostatnia, w kolejności id na trzeciej stronie. */
const wanted = rule(uuid(1150, 'c'), TENANT, 'name_exact', 'Kawiarnia Pod Lipą', 'Spotkania z klientami');

/**
 * 1200 reguł nazwy tej firmy w kolejności sterty, a pomiędzy cudze: ta sama
 * nazwa w innej firmie i jako słowo kluczowe tej firmy. Filtr firmy i typu
 * reguły musi iść na każdej stronie.
 */
function manyNameRules(): Row[] {
  const own = heapOrder(1200).map((n) => rule(uuid(n), TENANT, 'name_exact', `Dostawca ${n}`, `Zakupy ${n}`));
  const foreign = [
    rule(uuid(7, 'b'), OTHER_TENANT, 'name_exact', 'Kawiarnia Pod Lipą', 'Cudza kategoria'),
    rule(uuid(8, 'b'), TENANT, 'keyword', 'Kawiarnia Pod Lipą', 'Słowo kluczowe'),
  ];
  return [...own.slice(0, 300), ...foreign, ...own.slice(300), wanted];
}

beforeEach(() => {
  db.state.rules = manyNameRules();
  db.state.updates = [];
  db.state.selects = 0;
  db.state.failOnSelect = null;
});

describe('reguły nazwy sprzedawcy ponad limit wierszy PostgREST (sesja 29)', () => {
  it('firma z 1200 regułami nazwy: działa też reguła spoza pierwszych 1000', async () => {
    const result = await classifyByExactName(TENANT, '  kawiarnia   pod LIPĄ ', 30);

    expect(result).toEqual({
      kpir_column: 'col_13',
      category_label: 'Spotkania z klientami',
      confidence: 0.96,
      method: 'learned',
    });
    expect(db.state.updates).toEqual([{ patch: expect.objectContaining({ hit_count: 3 }), eq: [['id', wanted.id]] }]);
  });

  // Strażnik zachowania: stary kod też dawał `null` przy błędzie bazy (nie
  // czytał `error`). Kategoryzacja idzie w jobie OCR przed zapisem wydatku,
  // więc wyjątek ponowiłby płatny OCR.
  it('błąd bazy na drugiej stronie: brak reguły, bez wyjątku i bez licznika trafień', async () => {
    db.state.failOnSelect = 2;

    await expect(classifyByExactName(TENANT, 'Kawiarnia Pod Lipą', 30)).resolves.toBeNull();
    expect(db.state.selects).toBe(2);
    expect(db.state.updates).toEqual([]);
  });
});

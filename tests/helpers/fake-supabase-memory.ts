/**
 * Mała baza w pamięci z interfejsem PostgREST (supabase-js) — tylko to, czego
 * używają testy faktur cyklicznych: eq/lte/in, select z count/head, insert,
 * update, delete, maybeSingle/single, range/order/limit (sortuje tylko `order('id')`,
 * jak `readCompletePages`; reszta w kolejności wstawienia). Bez RLS i bez wyzwalaczy: te sprawdza
 * tests/rls-faktury-cykliczne.test.ts na prawdziwej bazie.
 */

export type Row = Record<string, unknown>;

export interface MemoryDb {
  tables: Record<string, Row[]>;
  /** Kolejne wywołania `from(tabela)`. */
  touched: string[];
  /** Wymuszony błąd operacji na tabeli (np. `{ 'recurring_invoices:update': { code: '08006', message: '…' } }`). */
  failures: Record<string, { code: string; message: string } | undefined>;
}

export function memoryDb(tables: Record<string, Row[]> = {}): MemoryDb {
  return { tables, touched: [], failures: {} };
}

let nextId = 1;

export function fakeSupabase(db: MemoryDb) {
  return {
    from(name: string) {
      db.touched.push(name);
      const filters: Array<(r: Row) => boolean> = [];
      let op: 'select' | 'insert' | 'update' | 'delete' | 'upsert' = 'select';
      let payload: Row | Row[] | null = null;
      let conflictKey = 'id';
      let head = false;
      let withCount = false;
      let byId = false;
      const rows = () => (db.tables[name] ??= []);

      const run = async () => {
        await new Promise((r) => setTimeout(r, 0));
        const failure = db.failures[`${name}:${op}`];
        if (failure) return { data: null, count: null, error: failure };
        if (op === 'upsert') {
          const row = payload as Row;
          const hit = rows().find((r) => r[conflictKey] === row[conflictKey]);
          if (hit) {
            Object.assign(hit, row);
            return { data: [hit], count: null, error: null };
          }
          const created = {
            id: `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`,
            ...row,
          };
          rows().push(created);
          return { data: [created], count: null, error: null };
        }
        const hits = rows().filter((r) => filters.every((f) => f(r)));
        if (byId) hits.sort((a, b) => String(a.id).localeCompare(String(b.id)));
        if (op === 'insert') {
          const list = (Array.isArray(payload) ? payload : [payload!]).map((p) => ({
            id: `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`,
            created_at: '2026-10-20T08:00:00Z',
            updated_at: '2026-10-20T08:00:00Z',
            ...p,
          }));
          rows().push(...list);
          return { data: list, count: null, error: null };
        }
        if (op === 'update') {
          hits.forEach((r) => Object.assign(r, payload));
          return { data: hits, count: null, error: null };
        }
        if (op === 'delete') {
          db.tables[name] = rows().filter((r) => !hits.includes(r));
          return { data: hits, count: null, error: null };
        }
        return { data: head ? null : hits, count: withCount ? hits.length : null, error: null };
      };

      const q = {
        select: (_cols?: string, opts?: { count?: string; head?: boolean }) => {
          if (opts?.count) withCount = true;
          if (opts?.head) head = true;
          return q;
        },
        eq: (k: string, v: unknown) => {
          filters.push((r) => r[k] === v);
          return q;
        },
        lte: (k: string, v: string) => {
          filters.push((r) => String(r[k]) <= v);
          return q;
        },
        // `is` tylko dla null (PostgREST `is.null`), brak klucza liczy się jak NULL.
        is: (k: string, v: null) => {
          filters.push((r) => (r[k] ?? null) === v);
          return q;
        },
        gt: (k: string, v: number) => {
          filters.push((r) => typeof r[k] === 'number' && r[k] > v);
          return q;
        },
        lt: (k: string, v: string) => {
          filters.push((r) => r[k] != null && String(r[k]) < v);
          return q;
        },
        in: (k: string, vs: unknown[]) => {
          filters.push((r) => vs.includes(r[k]));
          return q;
        },
        ilike: (k: string, pattern: string) => {
          const needle = pattern.replace(/%/g, '').toLowerCase();
          filters.push((r) => String(r[k] ?? '').toLowerCase().includes(needle));
          return q;
        },
        not: () => q,
        order: (k: string) => {
          if (k === 'id') byId = true;
          return q;
        },
        limit: () => q,
        range: () => q,
        insert: (p: Row | Row[]) => {
          op = 'insert';
          payload = p;
          return q;
        },
        update: (p: Row) => {
          op = 'update';
          payload = p;
          return q;
        },
        upsert: (p: Row, opts?: { onConflict?: string }) => {
          op = 'upsert';
          payload = p;
          conflictKey = opts?.onConflict ?? 'id';
          return q;
        },
        delete: () => {
          op = 'delete';
          return q;
        },
        maybeSingle: async () => {
          const r = await run();
          return { data: (r.data as Row[] | null)?.[0] ?? null, error: r.error };
        },
        single: async () => {
          const r = await run();
          return { data: (r.data as Row[] | null)?.[0] ?? null, error: r.error };
        },
        then: (ok: (v: unknown) => unknown, fail?: (e: unknown) => unknown) => run().then(ok, fail),
      };
      return q;
    },
  };
}

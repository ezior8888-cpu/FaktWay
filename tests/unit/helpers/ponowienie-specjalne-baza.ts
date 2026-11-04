/**
 * Baza w pamięci dla testów ponowienia dokumentów specjalnych z kopii na
 * wierszu (A4b PR2a): runner wysyłki i akcje czytają przez nią jak przez
 * PostgREST.
 *
 * - SELECT zwraca TYLKO wybrane kolumny (kolumna wybrana, której wiersz nie
 *   ma, = null — jak domyślny NULL w tabeli); kolumny niewybranej nie ma.
 *   `rel(a, b)` zwraca zagnieżdżony obiekt z relacji zapisanej pod `rel`.
 * - Filtry eq/neq/in/is ograniczają wynik; maybeSingle/single biorą pierwszy
 *   pasujący wiersz (single bez wiersza = błąd jak PGRST116).
 * - INSERT nadaje UUID i zapisuje treść po przejściu przez jsonb (`jsonb`):
 *   undefined znika, klucze obiektów w kolejności Postgresa.
 *
 * Każdy odczyt trafia do `reads` (tabela, kolumny, filtry) — testy sprawdzają,
 * kiedy granica wysyłki czyta profil firmy.
 */

import { randomUUID } from 'node:crypto';

export type Row = Record<string, unknown>;

export interface DbRead {
  table: string;
  columns: string;
  filters: Record<string, unknown>;
}

export interface DbInsert {
  table: string;
  payload: Row;
}

/** Kolejność kluczy jsonb w Postgresie: krótsze najpierw, potem bajtowo. */
function jsonbKeyOrder(a: string, b: string): number {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const source = value as Row;
    return Object.fromEntries(Object.keys(source).sort(jsonbKeyOrder).map((k) => [k, sortKeys(source[k])]));
  }
  return value;
}

/** Wartość po zapisie w jsonb (wiersz faktury, zlecenie pg-boss) i odczycie. */
export function jsonb<T>(value: T): T {
  return sortKeys(JSON.parse(JSON.stringify(value ?? null))) as T;
}

/** Kolumny z listy SELECT, dzielone po przecinkach najwyższego poziomu. */
export function selectedColumns(columns: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of columns) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      out.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/** Wiersz tak, jak oddałby go PostgREST dla tej listy kolumn. */
export function project(row: Row, columns: string): Row {
  const out: Row = {};
  for (const column of selectedColumns(columns)) {
    if (column === '*') {
      Object.assign(out, row);
      continue;
    }
    const rel = /^(\w+)\((.*)\)$/.exec(column);
    if (rel) {
      const [, name, inner] = rel as unknown as [string, string, string];
      const related = row[name];
      out[name] = Array.isArray(related)
        ? related.map((r) => project(r as Row, inner))
        : related && typeof related === 'object' ? project(related as Row, inner) : null;
      continue;
    }
    out[column] = row[column] ?? null;
  }
  return out;
}


export type RpcHandler = (fn: string, args: Row) => { data: unknown; error: { message: string; code?: string } | null };

export function memoryDb(tables: Record<string, Row[]>, rpc: RpcHandler = () => ({ data: null, error: null })) {
  const reads: DbRead[] = [];
  const inserts: DbInsert[] = [];

  function from(table: string) {
    const rows = (tables[table] ??= []);
    const filters: Record<string, unknown> = {};
    const predicates: Array<(r: Row) => boolean> = [];
    let columns = '*';
    let op: 'select' | 'insert' | 'update' | 'delete' = 'select';
    let payload: Row | Row[] = {};
    let returning: string | null = null;
    let sort: { key: string; ascending: boolean } | null = null;
    let limitN: number | null = null;

    const exec = (mode: 'many' | 'maybe' | 'single') => {
      if (op === 'insert') {
        const list = (Array.isArray(payload) ? payload : [payload]).map((p) => ({ id: p.id ?? randomUUID(), ...jsonb(p) }));
        for (const r of list) {
          inserts.push({ table, payload: r });
          rows.push(r);
        }
        const data = list.map((r) => project(r, returning ?? '*'));
        return { data: mode === 'many' ? (returning ? data : null) : data[0] ?? null, error: null };
      }
      const hit = rows.filter((r) => predicates.every((p) => p(r)));
      if (op === 'update') {
        hit.forEach((r) => Object.assign(r, jsonb(payload)));
        const data = hit.map((r) => project(r, returning ?? '*'));
        return { data: mode === 'many' ? data : data[0] ?? null, error: null };
      }
      if (op === 'delete') {
        for (const r of hit) rows.splice(rows.indexOf(r), 1);
        return { data: null, error: null };
      }
      reads.push({ table, columns, filters: { ...filters } });
      let list = hit;
      if (sort) {
        const { key, ascending } = sort;
        list = [...list].sort((a, b) => String(a[key] ?? '').localeCompare(String(b[key] ?? '')) * (ascending ? 1 : -1));
      }
      if (limitN !== null) list = list.slice(0, limitN);
      const data = list.map((r) => project(r, columns));
      if (mode === 'many') return { data, error: null };
      if (mode === 'single' && data.length === 0) {
        return { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } };
      }
      return { data: data[0] ?? null, error: null };
    };

    const q = {
      select: (c?: string) => {
        if (op === 'select') columns = c ?? '*';
        else returning = c ?? '*';
        return q;
      },
      insert: (p: Row | Row[]) => { op = 'insert'; payload = p; return q; },
      update: (p: Row) => { op = 'update'; payload = p; return q; },
      delete: () => { op = 'delete'; return q; },
      eq: (k: string, v: unknown) => { filters[k] = v; predicates.push((r) => r[k] === v); return q; },
      neq: (k: string, v: unknown) => { predicates.push((r) => r[k] !== v); return q; },
      in: (k: string, vs: unknown[]) => { filters[k] = vs; predicates.push((r) => vs.includes(r[k])); return q; },
      is: (k: string, v: unknown) => { predicates.push((r) => (r[k] ?? null) === v); return q; },
      or: (expr: string) => {
        // Jedyny `or` na tej ścieżce: zapis porażki „chyba że przyjęta” (runner).
        if (expr !== 'ksef_status.is.null,ksef_status.neq.accepted') {
          throw new Error(`baza w pamięci: nieobsługiwany filtr or(${expr})`);
        }
        predicates.push((r) => r.ksef_status == null || r.ksef_status !== 'accepted');
        return q;
      },
      order: (key: string, o?: { ascending?: boolean }) => { sort = { key, ascending: o?.ascending ?? true }; return q; },
      limit: (n: number) => { limitN = n; return q; },
      maybeSingle: async () => exec('maybe'),
      single: async () => exec('single'),
      then: <A, B>(ok: (v: ReturnType<typeof exec>) => A, fail?: (e: unknown) => B) =>
        Promise.resolve().then(() => exec('many')).then(ok, fail),
    };
    return q;
  }

  return {
    from,
    rpc: async (fn: string, args: Row = {}) => rpc(fn, args),
    reads,
    inserts,
    tables,
  };
}

export type MemoryDb = ReturnType<typeof memoryDb>;

import type { PageContext } from '@/lib/supabase/page-context';

/**
 * Baza w pamięci dla testów odczytów analiz (plan Finora E7) — ten sam
 * kształt co atrapa w `tests/unit/pulpit-rankingi.test.ts`: filtry używane
 * przez moduły, `count: 'exact'`, `head`, sortowanie, `range`, `limit`,
 * `maybeSingle` i limit 1000 wierszy serwera (PostgREST ucina odpowiedź).
 * Zwraca TYLKO wybrane kolumny; ścieżka JSON jak w PostgREST
 * (`alias:kolumna->klucz->>pole`, bez aliasu klucz = ostatni człon) daje
 * wartość spod ścieżki, a osadzenie po kluczu obcym jednej kolumny
 * (`tabela!tabela_kolumna_fkey(kolumny)`) — wiersze tabeli podrzędnej, których
 * `kolumna` = `id` wiersza (bez filtrów, jak PostgREST bez `!inner`).
 * `or('a.gte.x,b->c->>d.eq.y')` — alternatywa prostych warunków (E11:
 * dzień wpływu z kilku kolumn), bez zagnieżdżeń.
 * Operator, którego tu nie ma, rzuca (nie ma
 * metody albo `not(...)` z nieznanym operatorem) — loader z nowym filtrem
 * nie dostanie po cichu pustego wyniku (PLAN-PRAWDZIWE-DANE §7 E2).
 */

export type Row = Record<string, unknown>;
export type Tables = Record<string, Row[]>;

/** PostgREST oddaje najwyżej tyle wierszy w jednej odpowiedzi. */
export const SERVER_CAP = 1000;

export interface Read {
  table: string;
  range: [number, number] | null;
}

/** Kolumna z listy select: klucz w wyniku i ścieżka do wartości w wierszu albo osadzenie. */
interface Column {
  key: string;
  path: string[];
  /** Osadzenie: tabela podrzędna, jej kolumna klucza obcego i kolumny wyniku. */
  embed?: { table: string; foreignKey: string; columns: Column[] };
}

/** Lista select z podziałem po przecinkach poza nawiasami osadzeń. */
function selectParts(selection: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of selection) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts.map((s) => s.trim()).filter(Boolean);
}

/**
 * `kolumna`, `alias:kolumna`, `alias:kolumna->klucz->>pole` albo
 * `[alias:]tabela!tabela_kolumna_fkey(kolumny)` (PostgREST).
 */
function column(part: string): Column {
  const embed = /^(?:(\w+):)?(\w+)!(\w+)\(([\s\S]*)\)$/.exec(part);
  if (embed) {
    const alias = embed[1];
    const table = embed[2]!;
    const fk = embed[3]!;
    const inner = embed[4]!;
    const prefix = `${table}_`;
    if (!fk.startsWith(prefix) || !fk.endsWith('_fkey')) {
      throw new Error(`fakePostgrest: nieobsługiwane osadzenie ${part}`);
    }
    return {
      key: alias ?? table,
      path: [],
      embed: { table, foreignKey: fk.slice(prefix.length, -'_fkey'.length), columns: selectParts(inner).map(column) },
    };
  }
  if (part.includes('(')) throw new Error(`fakePostgrest: nieobsługiwane osadzenie ${part}`);
  const [alias, source] = part.includes(':') ? part.split(':', 2) as [string, string] : [null, part];
  const path = source.split(/->>?/).map((s) => s.trim());
  return { key: (alias ?? path.at(-1)!).trim(), path };
}

/** Kolumna jak w wierszu; brak wartości pod ścieżką JSON = `null` (jak PostgREST). */
function valueAt(row: Row, path: readonly string[]): unknown {
  let value: unknown = row[path[0]!];
  if (path.length === 1) return value;
  for (const part of path.slice(1)) {
    value = value && typeof value === 'object' && !Array.isArray(value) ? (value as Row)[part] : undefined;
  }
  return value ?? null;
}

const OR_CONDITION = /^(\w+(?:->>?\w+)*)\.(eq|neq|gt|gte|lt|lte|is)\.(.*)$/;

/**
 * `or(...)` PostgREST-a: warunki `kolumna[->klucz->>pole].operator.wartość`
 * po przecinku, wiersz pasuje, gdy spełnia którykolwiek. Porównania jak
 * w `gte`/`lt` (tekstowo, `null` nie spełnia żadnego poza `is.null`).
 * Zagnieżdżone `and(...)`/`or(...)` i inne operatory rzucają.
 */
export function orPredicate(filters: string): (row: Row) => boolean {
  if (/[()]/.test(filters)) throw new Error(`fakePostgrest: nieobsługiwane or(${filters})`);
  const conditions = filters.split(',').map((part) => {
    const m = OR_CONDITION.exec(part.trim());
    if (!m) throw new Error(`fakePostgrest: nieobsługiwane or(${filters})`);
    const path = m[1]!.split(/->>?/);
    const op = m[2]!;
    const value = m[3]!;
    return (row: Row) => {
      const actual = valueAt(row, path);
      if (op === 'is') {
        if (value !== 'null') throw new Error(`fakePostgrest: nieobsługiwane or(${filters})`);
        return actual == null;
      }
      if (actual == null) return false;
      const text = String(actual);
      switch (op) {
        case 'eq': return text === value;
        case 'neq': return text !== value;
        case 'gt': return text > value;
        case 'gte': return text >= value;
        case 'lt': return text < value;
        default: return text <= value;
      }
    };
  });
  return (row) => conditions.some((condition) => condition(row));
}

function project(tables: Tables, row: Row, columns: readonly Column[]): Row {
  return Object.fromEntries(columns.map((c) => {
    if (!c.embed) return [c.key, valueAt(row, c.path)];
    const { table, foreignKey, columns: inner } = c.embed;
    const children = (tables[table] ?? []).filter((child) => child[foreignKey] === row.id);
    return [c.key, children.map((child) => project(tables, child, inner))];
  }));
}

export function fakePostgrest(tables: Tables, reads: Read[] = []): PageContext['supabase'] {
  return {
    from(table: string) {
      const read: Read = { table, range: null };
      reads.push(read);
      const predicates: Array<(row: Row) => boolean> = [];
      const ordering: Array<{ column: string; ascending: boolean }> = [];
      let columns: Column[] | null = null;
      let head = false;
      let counted = false;
      let window: [number, number] | null = null;
      let limit: number | null = null;
      const run = () => {
        const matching = (tables[table] ?? []).filter((r) => predicates.every((p) => p(r)));
        matching.sort((a, b) => {
          for (const { column, ascending } of ordering) {
            const x = String(a[column] ?? '');
            const y = String(b[column] ?? '');
            if (x !== y) return (x < y ? -1 : 1) * (ascending ? 1 : -1);
          }
          return 0;
        });
        const start = window?.[0] ?? 0;
        const wanted = window ? window[1] - window[0] + 1 : matching.length;
        const page = matching.slice(start, start + Math.min(wanted, limit ?? wanted, SERVER_CAP));
        const data = page.map((r) => (columns ? project(tables, r, columns) : r));
        return { data, count: matching.length };
      };
      const builder = {
        select(selection = '*', options?: { count?: string; head?: boolean }) {
          const parts = selectParts(selection);
          columns = parts.includes('*') ? null : parts.map(column);
          head = options?.head === true;
          counted = options?.count === 'exact';
          return builder;
        },
        eq(c: string, v: unknown) { predicates.push((r) => r[c] === v); return builder; },
        neq(c: string, v: unknown) { predicates.push((r) => r[c] !== v); return builder; },
        /** Liczba — porównanie liczb (`gross_total > 0`); napis — tekstowo jak `gte` (`id > ostatni`, strony po kluczu). */
        gt(c: string, v: number | string) {
          predicates.push((r) => (typeof v === 'number' ? Number(r[c]) > v : r[c] != null && String(r[c]) > v));
          return builder;
        },
        gte(c: string, v: string) { predicates.push((r) => r[c] != null && String(r[c]) >= v); return builder; },
        lt(c: string, v: string) { predicates.push((r) => r[c] != null && String(r[c]) < v); return builder; },
        in(c: string, v: unknown[]) { predicates.push((r) => v.includes(r[c])); return builder; },
        or(filters: string) { predicates.push(orPredicate(filters)); return builder; },
        is(c: string, v: null) { predicates.push((r) => (v === null ? r[c] == null : r[c] === v)); return builder; },
        /** `not(c, 'is', null)` i `not(c, 'eq', '{}')` (pusta tablica) — tylko te, których używa kod. */
        not(c: string, op: string, v: unknown) {
          if (op === 'is' && v === null) predicates.push((r) => r[c] != null);
          else if (op === 'eq' && v === '{}') predicates.push((r) => Array.isArray(r[c]) && (r[c] as unknown[]).length > 0);
          else throw new Error(`fakePostgrest: nieobsługiwane not(${c}, ${op})`);
          return builder;
        },
        order(column: string, options?: { ascending?: boolean }) {
          ordering.push({ column, ascending: options?.ascending !== false });
          return builder;
        },
        range(from: number, to: number) { window = [from, to]; read.range = [from, to]; return builder; },
        limit(n: number) { limit = n; return builder; },
        /** Jak PostgREST: zero wierszy → `null`, więcej niż jeden → błąd PGRST116. */
        maybeSingle() {
          const { data } = run();
          if (data.length > 1) {
            return Promise.resolve({
              data: null,
              error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' },
            });
          }
          return Promise.resolve({ data: data[0] ?? null, error: null });
        },
        then<T>(resolve: (value: { data: Row[] | null; count: number | null; error: null }) => T) {
          const { data, count } = run();
          return Promise.resolve({
            data: head ? null : data,
            count: counted ? count : null,
            error: null,
          }).then(resolve);
        },
      };
      return builder;
    },
  } as unknown as PageContext['supabase'];
}

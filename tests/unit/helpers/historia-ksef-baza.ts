/**
 * Baza w pamięci z interfejsem PostgREST (supabase-js) dla testów
 * synchronizacji historii KSeF (decyzja Bartosza 22.10.2026).
 *
 * Obsługuje to, czego używają `lib/ksef/history-sync/*` i runner:
 * select (kolumny z aliasami JSON `alias:kol->a->>b`, count/head), insert,
 * upsert (onConflict + ignoreDuplicates), update (zwraca zmienione wiersze),
 * eq/neq/in/is/not/lt/lte/gt/gte/ilike, `or('a.op.v,b.op.v')`, order, limit,
 * single/maybeSingle i `rpc` z podmienialną obsługą. `updated_at` rośnie przy
 * każdym UPDATE (jak wyzwalacz `set_updated_at`, 00155) — CAS na nim działa.
 *
 * Bez RLS, CHECK i wyzwalaczy faktur — te sprawdza tests/rls-historia-ksef.test.ts
 * na prawdziwej bazie.
 */

export type Row = Record<string, unknown>;

export interface HistoryDb {
  tables: Record<string, Row[]>;
  /** Każde zapytanie: tabela, operacja, filtry tekstowo (do asercji). */
  log: Array<{ table: string; op: string; filters: string[]; columns?: string; payload?: unknown }>;
  rpc: (fn: string, args: Record<string, unknown>) => { data: unknown; error: { message: string } | null };
  /** Wymuszony błąd: klucz `tabela:operacja`. */
  failures: Set<string>;
  /**
   * Limit wierszy odpowiedzi SELECT jak `PGRST_DB_MAX_ROWS` na produkcji
   * (1000): ucina BEZ błędu. Domyślnie bez limitu (sesja 27 planu skalowania).
   */
  maxRows?: number;
}

let lastStamp = 0;
/** Kolejny `updated_at` — „teraz” (zegar testu), rosnący i unikalny jak `now()` kolejnych transakcji. */
function nextStamp(): string {
  lastStamp = Math.max(Date.now(), lastStamp + 1);
  return new Date(lastStamp).toISOString();
}

let seq = 0;
function nextId(): string {
  seq += 1;
  return `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
}

export function historyDb(tables: Record<string, Row[]> = {}, options: { maxRows?: number } = {}): HistoryDb {
  return {
    tables,
    log: [],
    rpc: () => ({ data: null, error: null }),
    failures: new Set(),
    maxRows: options.maxRows,
  };
}

const DEFAULTS: Record<string, () => Row> = {
  ksef_history_sync: () => ({
    backfill_page_offset: 0, backfill_completed_at: null, backfill_progress_at: null, backfill_issue: null,
    backfill_issue_at: null, live_page_offset: 0, live_checked_at: null, live_issue: null, live_issue_at: null,
    paused_until: null, rate_limited_at: null, rate_limit_hits: 0, client_paused_at: null, client_paused_by: null,
    lease_until: null, last_enqueued_at: null, last_run_at: null, last_success_at: null, last_error_code: null,
    last_error_detail: null, last_error_at: null, consecutive_failures: 0, created_at: '2026-10-01T00:00:00.000Z',
  }),
  ksef_history_items: () => ({
    status: 'pending', reason_code: null, detail: null, attempts: 0, next_attempt_at: null, first_deferred_at: null,
    invoice_id: null, discovered_at: '2026-10-22T00:00:00.000Z', resolved_at: null,
  }),
};

function valueAt(row: Row, path: string): unknown {
  const parts = path.split(/->>?/);
  let value: unknown = row[parts[0]!];
  for (const part of parts.slice(1)) {
    value = value && typeof value === 'object' && !Array.isArray(value) ? (value as Row)[part] : undefined;
  }
  if (path.includes('->>') && value !== undefined && value !== null && typeof value !== 'string') return String(value);
  return value;
}

function project(row: Row, columns: string | undefined): Row {
  if (!columns || columns.trim() === '*') return { ...row };
  const out: Row = {};
  for (const raw of columns.split(',').map((c) => c.trim()).filter(Boolean)) {
    if (raw.includes('(')) continue; // osadzenia — poza zakresem
    if (raw.includes(':')) {
      const [alias, path] = raw.split(':') as [string, string];
      out[alias.trim()] = valueAt(row, path.trim()) ?? null;
    } else if (raw.includes('->')) {
      out[raw.split(/->>?/).pop()!] = valueAt(row, raw) ?? null;
    } else {
      out[raw] = row[raw] ?? null;
    }
  }
  return out;
}

function compare(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const an = Number(a);
  const bn = Number(b);
  if (typeof a === 'number' || typeof b === 'number') return an - bn;
  return String(a).localeCompare(String(b));
}

function matches(row: Row, column: string, op: string, value: unknown): boolean {
  const actual = valueAt(row, column);
  switch (op) {
    case 'eq': return actual === value || (actual != null && value != null && String(actual) === String(value));
    case 'neq': return actual != null && String(actual) !== String(value);
    case 'is': return value === null || value === 'null' ? actual == null : actual === value;
    case 'lt': return actual != null && compare(actual, value) < 0;
    case 'lte': return actual != null && compare(actual, value) <= 0;
    case 'gt': return actual != null && compare(actual, value) > 0;
    case 'gte': return actual != null && compare(actual, value) >= 0;
    case 'ilike': return actual != null && String(actual).toLowerCase() === String(value).replace(/%/g, '').toLowerCase();
    default: throw new Error(`Atrapa: nieznany operator ${op}`);
  }
}

/** `a.eq.1,b.is.null` — człony na najwyższym poziomie (bez zagnieżdżeń). */
function parseOr(expr: string): Array<(row: Row) => boolean> {
  return expr.split(',').map((term) => {
    const first = term.indexOf('.');
    const second = term.indexOf('.', first + 1);
    const column = term.slice(0, first);
    const op = term.slice(first + 1, second);
    const value = term.slice(second + 1);
    return (row: Row) => matches(row, column, op, value === 'null' ? null : value);
  });
}

/** Widok `ksef_history_item_counts` (00155) liczony z dziennika przy każdym odczycie. */
function itemCounts(db: HistoryDb): Row[] {
  const groups = new Map<string, Row>();
  for (const r of db.tables.ksef_history_items ?? []) {
    const key = [r.tenant_id, r.environment, r.direction, r.status, r.reason_code ?? ''].join('|');
    const g = groups.get(key) ?? {
      tenant_id: r.tenant_id, environment: r.environment, direction: r.direction,
      status: r.status, reason_code: r.reason_code ?? null, item_count: 0,
    };
    g.item_count = (g.item_count as number) + 1;
    groups.set(key, g);
  }
  return [...groups.values()];
}

/**
 * Widok `ksef_history_export_changes` (00155) liczony z dziennika i eksportów
 * przy każdym odczycie: pobrane (bez `repaired`) po zakończeniu eksportu,
 * którego okres obejmuje datę wystawienia, a zakres — kierunek. Bez okna
 * 24 miesięcy (to `now()` bazy) — całość sprawdza tests/rls-historia-ksef.test.ts.
 */
function exportChanges(db: HistoryDb): Row[] {
  const exports = (db.tables.export_jobs ?? []).filter((e) => e.status === 'completed' && e.completed_at);
  const groups = new Map<string, Row>();
  for (const i of db.tables.ksef_history_items ?? []) {
    if (i.status !== 'imported' || i.reason_code === 'repaired' || !i.resolved_at) continue;
    const issue = String(i.issue_date);
    const affected = exports.some((e) => e.tenant_id === i.tenant_id
      && issue >= String(e.period_start) && issue <= String(e.period_end)
      && Date.parse(String(i.resolved_at)) > Date.parse(String(e.completed_at))
      && (i.direction === 'outgoing' ? e.include_issued : e.include_received) === true);
    if (!affected) continue;
    const period = issue.slice(0, 7);
    const key = [i.tenant_id, i.environment, period].join('|');
    const g = groups.get(key) ?? { tenant_id: i.tenant_id, environment: i.environment, period, item_count: 0 };
    g.item_count = (g.item_count as number) + 1;
    groups.set(key, g);
  }
  return [...groups.values()];
}

const VIEWS: Record<string, (db: HistoryDb) => Row[]> = {
  ksef_history_item_counts: itemCounts,
  ksef_history_export_changes: exportChanges,
};

export function historyClient(db: HistoryDb) {
  return {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      db.log.push({ table: `rpc:${fn}`, op: 'rpc', filters: [], payload: args });
      return db.rpc(fn, args);
    },
    from(table: string) {
      const rows = () => (VIEWS[table] ? VIEWS[table](db) : (db.tables[table] ??= []));
      const predicates: Array<(r: Row) => boolean> = [];
      const filters: string[] = [];
      const orders: Array<[string, boolean]> = [];
      let op: 'select' | 'insert' | 'upsert' | 'update' = 'select';
      let payload: Row | Row[] = {};
      let columns: string | undefined;
      let head = false;
      let withCount = false;
      let returning = false;
      let single = false;
      let limitN: number | null = null;
      let upsertOpts: { onConflict?: string; ignoreDuplicates?: boolean } = {};
      const entry = { table, op: 'select', filters, columns: undefined as string | undefined, payload: undefined as unknown };
      db.log.push(entry);

      const add = (text: string, fn: (r: Row) => boolean) => {
        filters.push(text);
        predicates.push(fn);
        return q;
      };

      const exec = () => {
        entry.op = op;
        entry.columns = columns;
        entry.payload = op === 'select' ? undefined : payload;
        if (db.failures.has(`${table}:${op}`)) return { data: null, count: null, error: { message: `awaria ${table}:${op}` } };
        if (op === 'insert' || op === 'upsert') {
          const list = (Array.isArray(payload) ? payload : [payload]).map((p): Row => ({
            id: nextId(), ...(DEFAULTS[table]?.() ?? {}), updated_at: nextStamp(), ...p,
          }));
          const inserted: Row[] = [];
          for (const row of list) {
            if (op === 'upsert' && upsertOpts.onConflict) {
              const keys = upsertOpts.onConflict.split(',').map((k) => k.trim());
              const existing = rows().find((r) => keys.every((k) => r[k] === row[k]));
              if (existing) {
                if (!upsertOpts.ignoreDuplicates) Object.assign(existing, row, { id: existing.id, updated_at: nextStamp() });
                continue;
              }
            }
            rows().push(row);
            inserted.push(row);
          }
          const data = inserted.map((r) => project(r, columns));
          return { data: single ? data[0] ?? null : data, count: null, error: null };
        }
        let hits = rows().filter((r) => predicates.every((p) => p(r)));
        if (op === 'update') {
          for (const r of hits) Object.assign(r, payload, 'updated_at' in r || table.startsWith('ksef_history') ? { updated_at: nextStamp() } : {});
          const data = returning ? hits.map((r) => project(r, columns)) : null;
          if (single) return { data: data?.[0] ?? null, count: null, error: null };
          return { data, count: null, error: null };
        }
        for (const [key, asc] of [...orders].reverse()) {
          hits = [...hits].sort((a, b) => compare(valueAt(a, key) ?? '', valueAt(b, key) ?? '') * (asc ? 1 : -1));
        }
        const count = hits.length;
        if (limitN !== null) hits = hits.slice(0, limitN);
        if (db.maxRows !== undefined) hits = hits.slice(0, db.maxRows);
        const data = hits.map((r) => project(r, columns));
        if (single) return { data: data[0] ?? null, count, error: null };
        return { data: head ? null : data, count: withCount ? count : null, error: null };
      };

      const q = {
        select: (cols?: string, opts?: { count?: string; head?: boolean }) => {
          if (op === 'select') columns = cols;
          else { returning = true; columns = cols; }
          if (opts?.count) withCount = true;
          if (opts?.head) head = true;
          return q;
        },
        insert: (p: Row | Row[]) => { op = 'insert'; payload = p; return q; },
        upsert: (p: Row | Row[], opts: { onConflict?: string; ignoreDuplicates?: boolean } = {}) => {
          op = 'upsert'; payload = p; upsertOpts = opts; return q;
        },
        update: (p: Row) => { op = 'update'; payload = p; return q; },
        eq: (c: string, v: unknown) => add(`${c}=eq.${String(v)}`, (r) => matches(r, c, 'eq', v)),
        neq: (c: string, v: unknown) => add(`${c}=neq.${String(v)}`, (r) => matches(r, c, 'neq', v)),
        is: (c: string, v: unknown) => add(`${c}=is.${String(v)}`, (r) => matches(r, c, 'is', v)),
        not: (c: string, o: string, v: unknown) => {
          if (o !== 'is' || v !== null) throw new Error('Atrapa: not() tylko is null');
          return add(`${c}=not.is.null`, (r) => valueAt(r, c) != null);
        },
        in: (c: string, vs: unknown[]) => {
          // Zbiór zamiast `vs.some(matches)`: testy na 2500 firmach robią
          // setki `in.(…)` po tysiącach wierszy. Te same reguły co `eq`.
          const keys = new Set(vs.filter((v) => v != null).map(String));
          return add(`${c}=in.(${vs.join(',')})`, (r) => {
            const actual = valueAt(r, c);
            return actual == null ? vs.some((v) => v === actual) : keys.has(String(actual));
          });
        },
        lt: (c: string, v: unknown) => add(`${c}=lt.${String(v)}`, (r) => matches(r, c, 'lt', v)),
        lte: (c: string, v: unknown) => add(`${c}=lte.${String(v)}`, (r) => matches(r, c, 'lte', v)),
        gt: (c: string, v: unknown) => add(`${c}=gt.${String(v)}`, (r) => matches(r, c, 'gt', v)),
        gte: (c: string, v: unknown) => add(`${c}=gte.${String(v)}`, (r) => matches(r, c, 'gte', v)),
        ilike: (c: string, v: unknown) => add(`${c}=ilike.${String(v)}`, (r) => matches(r, c, 'ilike', v)),
        or: (expr: string) => {
          const terms = parseOr(expr);
          return add(`or=(${expr})`, (r) => terms.some((t) => t(r)));
        },
        filter: (c: string, o: string, v: unknown) => add(`${c}=${o}.${String(v)}`, (r) => matches(r, c, o, v)),
        order: (c: string, opts?: { ascending?: boolean }) => { orders.push([c, opts?.ascending ?? true]); return q; },
        limit: (n: number) => { limitN = n; return q; },
        maybeSingle: () => { single = true; return Promise.resolve(exec()); },
        single: () => { single = true; return Promise.resolve(exec()); },
        then: (ok: (v: unknown) => unknown, fail?: (e: unknown) => unknown) => Promise.resolve(exec()).then(ok, fail),
      };
      return q;
    },
  };
}

/** Wiersz strumienia z rozsądnymi wartościami (nadpisz, co potrzebne). */
export function streamRow(patch: Row = {}): Row {
  return {
    id: nextId(),
    tenant_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    environment: 'test',
    direction: 'outgoing',
    history_floor: '2022-01-01T00:00:00.000Z',
    boundary_at: '2026-10-01T00:00:00.000Z',
    backfill_window_end: '2026-10-01T00:00:00.000Z',
    backfill_cursor: '2026-07-03T00:00:00.000Z',
    live_hwm: '2026-10-01T00:00:00.000Z',
    ...(DEFAULTS.ksef_history_sync!()),
    updated_at: nextStamp(),
    ...patch,
  };
}

/** Wiersz dziennika. */
export function itemRow(patch: Row = {}): Row {
  return {
    id: nextId(),
    tenant_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    environment: 'test',
    direction: 'outgoing',
    ksef_number: '1234567890-20260910-AAAAAAAAAAAA-01',
    invoice_number: 'FV/1/09/2026',
    issue_date: '2026-09-10',
    acquisition_at: '2026-09-10T10:00:00.000Z',
    permanent_storage_at: '2026-09-10T10:00:05.000Z',
    invoice_type: 'Vat',
    counterparty_nip: '1111111111',
    counterparty_name: 'Nabywca',
    gross_amount: 123,
    currency: 'PLN',
    invoice_hash: null,
    ...(DEFAULTS.ksef_history_items!()),
    updated_at: nextStamp(),
    ...patch,
  };
}

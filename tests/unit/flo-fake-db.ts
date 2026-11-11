/**
 * Atrapa klienta bazy dla testów agenta FLO.
 *
 * PO CO: najważniejsza własność wykonawcy — „pięćdziesiąt równoległych
 * kliknięć daje jedno wykonanie” — jest własnością WSPÓŁBIEŻNOŚCI. Testu na
 * to nie da się napisać atrapą, która odpowiada natychmiast: pierwszy
 * wywołujący wygrywałby zawsze, bo nikt nie zdążyłby mu wejść w drogę.
 *
 * Dlatego każda operacja tej atrapy oddaje sterowanie (`await Promise.resolve()`)
 * zanim dotknie danych. Dzięki temu wszystkie równoległe wywołania zdążą
 * przejść przez odczyt, zanim którekolwiek wykona zapis — czyli dokładnie
 * ten przeplot, który w prawdziwej bazie robią osobne połączenia.
 *
 * Obsługuje tylko te operacje, których agent naprawdę używa. Świadomie nie
 * jest to symulator PostgREST-a — gdyby nim był, testowalibyśmy własną
 * imitację zamiast własnego kodu.
 */

import type { FloDbClient } from '@/lib/flo/db-types';

type Row = Record<string, unknown>;
type Filter = (row: Row) => boolean;
function columnValue(row: Row, column: string): unknown {
  if (!column.includes('->')) return row[column];
  const [root, ...keys] = column.split(/->>?/);
  let value: unknown = row[root!];
  for (const key of keys) {
    if (!value || typeof value !== 'object' || !Object.prototype.hasOwnProperty.call(value, key)) return null;
    value = (value as Row)[key];
  }
  if (value == null) return null;
  return column.includes('->>') ? String(value) : value;
}

interface Tables {
  invoices: Row[];
  expenses: Row[];
  payments: Row[];
  payment_imports: Row[];
  contractors: Row[];
  payment_reminders: Row[];
  flo_proposals: Row[];
  flo_approvals: Row[];
  flo_decisions: Row[];
  flo_prefs: Row[];
  flo_usage: Row[];
  flo_shadow: Row[];
  flo_kind_flags: Row[];
  flo_rollout: Row[];
}

export interface FakeDb {
  client: FloDbClient;
  tables: Tables;
  /** Ile razy sięgnięto do zapisu — do wykrywania niepotrzebnego ruchu. */
  writes: number;
}

const yieldToOthers = () => Promise.resolve();

/**
 * Wartości `DEFAULT` z migracji, których kod celowo nie wysyła przy wstawianiu.
 *
 * Bez tego propozycja utworzona przez `createProposal` nie miałaby statusu,
 * a kolejny przebieg producenta nie rozpoznałby jej jako żywej karty — test
 * „drugi przebieg nie stawia drugiej karty" przechodziłby albo padał z powodu
 * atrapy, a nie kodu.
 */
const INSERT_DEFAULTS: Partial<Record<keyof Tables, Row>> = {
  flo_proposals: { status: 'open' },
  // Postgres daje tu NULL, nie brak pola. Atrapa zostawiająca `undefined`
  // sprawiała, że `summarizeShadow` (porównuje `=== null`) liczyła wpis
  // oczekujący jako rozstrzygnięty i nietrafiony — czyli test pokazywałby
  // 0% trafności tam, gdzie produkcja pokazuje „jeszcze nie wiadomo".
  flo_shadow: { matched: null, actual: null },
  // Zgoda powstaje niezużyta — bez tego warunek `consumed_at IS NULL` nie
  // znalazłby świeżego żetonu.
  flo_approvals: { consumed_at: null },
};

export function createFakeDb(seed: Partial<Tables> = {}, beforeUpdate?: () => void): FakeDb {
  const tables: Tables = {
    invoices: seed.invoices ?? [],
    expenses: seed.expenses ?? [],
    payments: seed.payments ?? [],
    payment_imports: seed.payment_imports ?? [],
    contractors: seed.contractors ?? [],
    payment_reminders: seed.payment_reminders ?? [],
    flo_proposals: seed.flo_proposals ?? [],
    flo_approvals: seed.flo_approvals ?? [],
    flo_decisions: seed.flo_decisions ?? [],
    flo_prefs: seed.flo_prefs ?? [],
    flo_usage: seed.flo_usage ?? [],
    flo_shadow: seed.flo_shadow ?? [],
    flo_kind_flags: seed.flo_kind_flags ?? [],
    flo_rollout: seed.flo_rollout ?? [],
  };
  const state = { writes: 0 };

  function makeQuery(rows: Row[], filters: Filter[], mode: 'read' | 'update' | 'delete', patch?: Row,
    /** `bounds` z `range()` — granice włączne, jak w PostgREST. */
    options: { count?: 'exact'; limit?: number; bounds?: [number, number] } = {}) {
    const apply = () => {
      const matched = rows.filter((row) => filters.every((f) => f(row)));
      return options.bounds ? matched.slice(options.bounds[0], options.bounds[1] + 1) : matched;
    };

    const run = async (): Promise<{ data: Row[] | null; error: null; count: number | null }> => {
      await yieldToOthers();
      if (mode === "update") beforeUpdate?.();
      const matched = apply();
      const count = options.count === 'exact' ? matched.length : null;
      if (mode === 'update' && patch) {
        state.writes++;
        for (const row of matched) Object.assign(row, patch);
      }
      if (mode === 'delete') {
        state.writes++;
        for (const row of matched) {
          const idx = rows.indexOf(row);
          if (idx >= 0) rows.splice(idx, 1);
        }
      }
      return { data: matched.slice(0, options.limit).map((r) => ({ ...r })), error: null, count };
    };

    const builder = {
      eq: (col: string, value: unknown) =>
        makeQuery(rows, [...filters, (r) => columnValue(r, col) === value], mode, patch, options),
      neq: (col: string, value: unknown) =>
        makeQuery(rows, [...filters, (r) => r[col] !== value], mode, patch, options),
      not: (col: string, operator: 'like', pattern: string) => {
        if (operator !== 'like') throw new Error('Unsupported fake filter');
        const escaped = pattern.split('').map((char) => char === '%' ? '.*' : char === '_' ? '.' : '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0')).join('');
        const matches = new RegExp('^' + escaped + '$');
        return makeQuery(rows, [...filters, (r) => {
          const value = columnValue(r, col);
          return typeof value === 'string' && !matches.test(value);
        }], mode, patch, options);
      },
      in: (col: string, values: readonly unknown[]) =>
        makeQuery(rows, [...filters, (r) => values.includes(r[col])], mode, patch, options),
      contains: (col: string, values: readonly unknown[]) =>
        makeQuery(rows, [...filters, (r) => {
          const actual = columnValue(r, col);
          return Array.isArray(actual) && values.every((value) => actual.includes(value));
        }], mode, patch, options),
      is: (col: string, value: unknown) =>
        makeQuery(rows, [...filters, (r) => (r[col] ?? null) === value], mode, patch, options),
      lt: (col: string, value: string | number) =>
        makeQuery(rows, [...filters, (r) => String(r[col]) < String(value)], mode, patch, options),
      lte: (col: string, value: string | number) =>
        makeQuery(rows, [...filters, (r) => String(r[col]) <= String(value)], mode, patch, options),
      gt: (col: string, value: string | number) =>
        makeQuery(rows, [...filters, (r) => String(r[col] ?? '') > String(value)], mode, patch, options),
      gte: (col: string, value: string | number) =>
        makeQuery(rows, [...filters, (r) => String(r[col] ?? '') >= String(value)], mode, patch, options),
      or: (expression: string) => {
        const clauses = expression.split(',').map((part) => {
          const match = /^(payment_date|created_at|transaction_date|booking_date|imported_at)\.gte\.(.+)$/.exec(part);
          if (!match) throw new Error('Unsupported fake OR filter: ' + part);
          return { column: match[1]!, cutoff: match[2]! };
        });
        return makeQuery(rows, [...filters, (row) => clauses.some(({ column, cutoff }) => {
          const value = columnValue(row, column);
          return typeof value === 'string' && value >= cutoff;
        })], mode, patch, options);
      },
      order: () => builder,
      limit: (value: number) => makeQuery(rows, filters, mode, patch, { ...options, limit: value }),
      /** Stronicowanie — tnie PO filtrach, tak jak robi to PostgREST. */
      range: (from: number, to: number) =>
        makeQuery(rows, filters, mode, patch, { ...options, bounds: [from, to] }),
      select: (_columns?: string, selectOptions?: { count?: 'exact' }) =>
        makeQuery(rows, filters, mode, patch, { ...options, count: selectOptions?.count ?? options.count }),
      maybeSingle: async () => {
        const { data } = await run();
        return { data: data?.[0] ?? null, error: null };
      },
      single: async () => {
        const { data } = await run();
        return { data: data?.[0] ?? null, error: null };
      },
      then: (resolve: (v: { data: Row[] | null; error: null; count: number | null }) => unknown, reject?: (e: unknown) => unknown) =>
        run().then(resolve, reject),
    };

    return builder;
  }

  const client = {
    /** `flo_record_usage` (00105): dodawanie w JEDNYM kroku po oddaniu sterowania — jak w bazie. */
    async rpc(fn: string, args: Record<string, unknown>) {
      if (fn !== 'flo_record_usage') throw new Error('Nieobsługiwane RPC w atrapie: ' + fn);
      await yieldToOthers();
      state.writes += 1;
      const row = tables.flo_usage.find((r) => r.tenant_id === args.p_tenant_id && r.day === args.p_day);
      if (row) {
        row.input_tokens = Number(row.input_tokens ?? 0) + Number(args.p_input_tokens);
        row.output_tokens = Number(row.output_tokens ?? 0) + Number(args.p_output_tokens);
        row.cost_usd = Number(row.cost_usd ?? 0) + Number(args.p_cost_usd);
        row.calls = Number(row.calls ?? 0) + 1;
      } else {
        tables.flo_usage.push({
          tenant_id: args.p_tenant_id, day: args.p_day, input_tokens: args.p_input_tokens,
          output_tokens: args.p_output_tokens, cost_usd: args.p_cost_usd, calls: 1,
        });
      }
      return { error: null };
    },
    from(table: keyof Tables) {
      const rows = tables[table];
      return {
        select: (_columns?: string, options?: { count?: 'exact' }) => makeQuery(rows, [], 'read', undefined, options),
        insert: (payload: Row | Row[]) => {
          const incoming = Array.isArray(payload) ? payload : [payload];
          const inserted: Row[] = [];
          const run = async () => {
            await yieldToOthers();
            state.writes++;
            if (table === 'flo_approvals' && incoming.some((row) =>
              rows.some((existing) => existing.proposal_id === row.proposal_id && existing.consumed_at == null))) {
              return { data: null, error: { code: '23505', message: 'duplicate approval' } };
            }
            for (const row of incoming) {
              const withId = {
                id: row.id ?? `id-${rows.length + 1}`,
                ...INSERT_DEFAULTS[table],
                ...row,
              };
              rows.push(withId);
              inserted.push(withId);
            }
            return { data: inserted.map((r) => ({ ...r })), error: null };
          };
          return {
            select: () => ({
              maybeSingle: async () => {
                const { data, error } = await run();
                return { data: data?.[0] ?? null, error };
              },
              single: async () => {
                const { data, error } = await run();
                return { data: data?.[0] ?? null, error };
              },
            }),
            then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
              run().then(resolve, reject),
          };
        },
        upsert: (payload: Row | Row[], opts?: { onConflict?: string }) => {
          const incoming = Array.isArray(payload) ? payload : [payload];
          const keys = (opts?.onConflict ?? 'id').split(',').map((k) => k.trim());
          const run = async () => {
            await yieldToOthers();
            state.writes++;
            for (const row of incoming) {
              const existing = rows.find((r) => keys.every((k) => r[k] === row[k]));
              if (existing) Object.assign(existing, row);
              else rows.push({ ...row });
            }
            return { data: null, error: null };
          };
          return {
            select: () => makeQuery(rows, [], 'read'),
            then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
              run().then(resolve, reject),
          };
        },
        // `count: 'exact'` jak w supabase-js: liczba zmienionych wierszy w `count`.
        update: (patch: Row, opts?: { count?: 'exact' }) =>
          makeQuery(rows, [], 'update', patch, { count: opts?.count }),
        delete: () => makeQuery(rows, [], 'delete'),
      };
    },
  } as unknown as FloDbClient;

  return {
    client,
    tables,
    get writes() {
      return state.writes;
    },
  } as FakeDb;
}

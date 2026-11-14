import fc from 'fast-check';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';
import { KEYSET_PAGE_SIZE } from '@/lib/pagination/keyset';

type Row = Record<string, unknown>;

/** Jedno wykonanie zapytania: tabela, filtry równości, czy to licznik i co baza oddała. */
interface Read {
  table: string;
  eq: Row;
  head: boolean;
  rows: Row[];
}

const db = vi.hoisted(() => ({
  tables: {} as Record<string, Record<string, unknown>[]>,
  /** `PGRST_DB_MAX_ROWS` produkcji: odpowiedź ucięta bez błędu. */
  maxRows: 1000,
  reads: [] as Array<{ table: string; eq: Record<string, unknown>; head: boolean; rows: Record<string, unknown>[] }>,
  /** Błąd N-tego odczytu tabeli (`invoices`, `reminder_settings`), liczony od 1. */
  failRead: null as { table: string; nth: number } | null,
}));

/** Porządek napisów jak porównanie uuid w Postgresie (bajtowo). */
function byKey(key: string, ascending: boolean) {
  return (a: Row, b: Row) => {
    const x = String(a[key]);
    const y = String(b[key]);
    return (x < y ? -1 : x > y ? 1 : 0) * (ascending ? 1 : -1);
  };
}

/** Atrapa PostgREST: filtruje, sortuje dopiero po `order`, tnie do `limit` i do `maxRows`. */
function from(table: string) {
  const preds: Array<(r: Row) => boolean> = [];
  const eq: Row = {};
  let sort: { key: string; ascending: boolean } | null = null;
  let limit = Infinity;
  let head = false;
  let single = false;
  const q = {
    select: (_columns?: string, options?: { head?: boolean; count?: string }) => {
      head = Boolean(options?.head);
      return q;
    },
    eq: (c: string, v: unknown) => {
      eq[c] = v;
      preds.push((r) => r[c] === v);
      return q;
    },
    in: (c: string, vs: unknown[]) => (preds.push((r) => vs.includes(r[c])), q),
    lt: (c: string, v: string) => (preds.push((r) => r[c] != null && String(r[c]) < v), q),
    gt: (c: string, v: string) => (preds.push((r) => r[c] != null && String(r[c]) > v), q),
    order: (key: string, o?: { ascending?: boolean }) => ((sort = { key, ascending: o?.ascending !== false }), q),
    limit: (n: number) => ((limit = n), q),
    maybeSingle: () => ((single = true), q),
    then: <A, B>(ok: (v: { data: unknown; error: { message: string } | null; count: number }) => A, fail?: (e: unknown) => B) => {
      const nth = db.reads.filter((r) => r.table === table).length + 1;
      if (db.failRead && db.failRead.table === table && db.failRead.nth === nth) {
        db.reads.push({ table, eq: { ...eq }, head, rows: [] });
        return Promise.resolve({ data: null, error: { message: 'statement timeout' }, count: 0 }).then(ok, fail);
      }
      let out = (db.tables[table] ?? []).filter((r) => preds.every((p) => p(r)));
      const count = out.length;
      if (sort) out = [...out].sort(byKey(sort.key, sort.ascending));
      const rows = out.slice(0, Math.min(limit, db.maxRows)).map((r) => ({ ...r }));
      db.reads.push({ table, eq: { ...eq }, head, rows: head ? [] : rows });
      const data = head ? null : single ? (rows[0] ?? null) : rows;
      return Promise.resolve({ data, error: null, count }).then(ok, fail);
    },
  };
  return q;
}

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ from }) }));

import { runReminderScheduler } from '@/lib/jobs/runners/reminder-scheduler';

/**
 * Sesja 18 planu skalowania (DB-03, JOB-08). Cron ponagleń co godzinę czytał
 * zaległe faktury WSZYSTKICH firm, także tych z wyłączonymi ponagleniami
 * (odsiew dopiero po odczycie), i trzymał w pamięci całą listę, zanim
 * zajął się pierwszą fakturą. Pamięć rosła z liczbą stron.
 *
 * Pomiar na zapytaniach do atrapy bazy (jedyna atrapa, runner prawdziwy):
 *   - wiersze faktur, które baza oddała, per firma,
 *   - decyzja o fakturze = `decideNextReminder` liczy wysłane ponaglenia
 *     (licznik `payment_reminders` po `invoice_id`),
 *   - „w pamięci” = faktury odczytane, a jeszcze bez decyzji.
 */

const PAST_DUE = '2020-01-15';

const uuid = (kind: number, n: number) =>
  `${kind.toString(16).padStart(8, '0')}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

type Settings = 'on' | 'off' | 'none';

interface TenantSpec {
  settings: Settings;
  /** Faktury: `{}` = kandydat do ponaglenia, inaczej nadpisane pola wiersza. */
  invoices: Row[];
}

function settingsRow(n: number, tenantId: string, enabled: boolean): Row {
  return {
    id: uuid(2, n),
    tenant_id: tenantId,
    enabled,
    // Etapy wyłączone: decyzja kończy się „nie nadszedł czas”, bez propozycji.
    stage_1_enabled: false,
    stage_1_days_after_due: 3,
    stage_2_enabled: false,
    stage_2_days_after_due: 7,
    stage_3_enabled: false,
    stage_3_days_after_due: 14,
    max_reminders_per_invoice: 3,
    send_hour: 9,
    send_on_weekdays_only: false,
  };
}

/**
 * Firmy i faktury do bazy. Numery faktur przeplatają firmy (permutacja), a
 * kolejność wierszy w tabeli różni się od porządku `id`: zapytanie bez
 * `order('id')` zwróciłoby wiersze w złej kolejności.
 */
function seed(tenants: TenantSpec[]): { tenantIds: string[]; candidatesOf: (t: number) => string[] } {
  const tenantIds = tenants.map((_, i) => uuid(1, i + 1));
  const pairs = tenants.flatMap((t, ti) => t.invoices.map((o) => ({ ti, o })));
  const total = pairs.length;
  const invoices = pairs.map(({ ti, o }, k) => ({
    id: uuid(3, ((k * 7919) % Math.max(total, 1)) + 1),
    tenant_id: tenantIds[ti],
    internal_number: `FV ${k + 1}`,
    direction: 'outgoing',
    ksef_status: 'accepted',
    invoice_kind: 'regular',
    origin: 'app',
    payment_status: 'unpaid',
    payment_due_date: PAST_DUE,
    reminders_paused: false,
    gross_total: 1230,
    paid_amount: 0,
    buyer_data: { name: 'Klient', email: 'klient@example.test' },
    buyer_nip: null,
    payment_data: null,
    ...o,
    candidate: Object.keys(o).length === 0,
  }));
  db.tables = {
    invoices: [...invoices].reverse(),
    reminder_settings: tenants.flatMap((t, i) =>
      t.settings === 'none' ? [] : [settingsRow(tenants.length - i, tenantIds[i]!, t.settings === 'on')],
    ),
    contractors: [],
    payment_reminders: [],
  };
  return {
    tenantIds,
    candidatesOf: (t) => invoices.filter((r) => r.tenant_id === tenantIds[t] && r.candidate).map((r) => r.id),
  };
}

function ctx(): JobContext {
  return {
    attempt: 0,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    step: { run: async (_name, fn) => fn(), sleep: vi.fn(), sendEvent: vi.fn(), scheduleAfter: vi.fn() },
  };
}

const invoiceReads = (): Read[] => db.reads.filter((r) => r.table === 'invoices');
const isDecision = (r: Read) => r.table === 'payment_reminders' && r.head && typeof r.eq.invoice_id === 'string';

/** Ile wierszy faktur baza oddała, per firma. */
function rowsReadByTenant(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const read of invoiceReads()) {
    for (const row of read.rows) out[String(row.tenant_id)] = (out[String(row.tenant_id)] ?? 0) + 1;
  }
  return out;
}

/** Faktury z decyzją, w kolejności decyzji (z powtórzeniami, jeśli były). */
const decided = (): string[] => db.reads.filter(isDecision).map((r) => String(r.eq.invoice_id));

/** Najwięcej faktur odczytanych, a jeszcze bez decyzji, w dowolnej chwili przebiegu. */
function maxHeld(): number {
  const pending = new Set<string>();
  let max = 0;
  for (const read of db.reads) {
    if (read.table === 'invoices') {
      for (const row of read.rows) pending.add(String(row.id));
      max = Math.max(max, pending.size);
    } else if (isDecision(read)) {
      pending.delete(String(read.eq.invoice_id));
    }
  }
  return max;
}

const sorted = (ids: string[]) => [...ids].sort();
const candidates = (n: number): Row[] => Array.from({ length: n }, () => ({}));

beforeEach(() => {
  db.tables = {};
  db.reads = [];
  db.maxRows = 1000;
  db.failRead = null;
});

describe('cron ponagleń: najpierw firmy z włączonymi ponagleniami (DB-03)', () => {
  it('faktur firmy z wyłączonymi ponagleniami i firmy bez ustawień baza nie oddaje', async () => {
    const { tenantIds, candidatesOf } = seed([
      { settings: 'on', invoices: candidates(3) },
      { settings: 'off', invoices: candidates(4) },
      { settings: 'none', invoices: candidates(2) },
    ]);

    const out = await runReminderScheduler(ctx());

    expect(rowsReadByTenant()).toEqual({ [tenantIds[0]!]: 3 });
    expect(sorted(decided())).toEqual(sorted(candidatesOf(0)));
    expect(out).toMatchObject({ processed: 3, proposed: 0, errors: 0 });
  });

  it('ponad 1000 firm z włączonymi ponagleniami: każda dostaje decyzje, wyłączone dalej nieczytane', async () => {
    const on = Array.from({ length: 1203 }, (): TenantSpec => ({ settings: 'on', invoices: candidates(1) }));
    const off = Array.from({ length: 300 }, (): TenantSpec => ({ settings: 'off', invoices: candidates(1) }));
    const { tenantIds, candidatesOf } = seed([...on, ...off]);

    const out = await runReminderScheduler(ctx());

    const expected = on.flatMap((_, i) => candidatesOf(i));
    expect(decided()).toHaveLength(1203);
    expect(sorted(decided())).toEqual(sorted(expected));
    const read = rowsReadByTenant();
    expect(tenantIds.slice(1203).filter((t) => read[t] !== undefined)).toEqual([]);
    // Lista ustawień też idzie stronami: 1203 firmy to trzy strony po `id`.
    expect(out).toMatchObject({ tenants: 1203, processed: 1203 });
  }, 60_000);
});

describe('cron ponagleń: strona po stronie (JOB-08)', () => {
  it.each([
    [300, 'jedna strona'],
    [1203, 'trzy strony'],
    [2750, 'sześć stron'],
  ])('%i zaległych faktur (%s): w pamięci najwyżej jedna strona, każda faktura raz', async (count) => {
    const { candidatesOf } = seed([{ settings: 'on', invoices: candidates(count) }]);

    const out = await runReminderScheduler(ctx());

    expect(maxHeld()).toBeLessThanOrEqual(KEYSET_PAGE_SIZE);
    expect(decided()).toHaveLength(count);
    expect(sorted(decided())).toEqual(sorted(candidatesOf(0)));
    expect(out).toMatchObject({ processed: count, errors: 0 });
  }, 60_000);

  it('błąd drugiej strony kandydatów przerywa przebieg wyjątkiem, nie cichą połową listy', async () => {
    seed([{ settings: 'on', invoices: candidates(1203) }]);
    db.failRead = { table: 'invoices', nth: 2 };

    await expect(runReminderScheduler(ctx())).rejects.toThrow(/statement timeout/);
  }, 60_000);

  it('błąd odczytu ustawień przerywa przebieg, zanim baza odda jakąkolwiek fakturę', async () => {
    seed([{ settings: 'on', invoices: candidates(3) }]);
    db.failRead = { table: 'reminder_settings', nth: 1 };

    await expect(runReminderScheduler(ctx())).rejects.toThrow(/statement timeout/);
    expect(invoiceReads().flatMap((r) => r.rows)).toEqual([]);
  });
});

/** Faktury, których cron nie ściga: odpadają w zapytaniu, bez decyzji. */
const NOT_CANDIDATES: Row[] = [
  { payment_status: 'paid' },
  { reminders_paused: true },
  { invoice_kind: 'correction' },
  { origin: 'ksef_import' },
  { payment_due_date: '2999-01-01' },
  { direction: 'incoming' },
  { ksef_status: 'pending' },
];

describe('niezmiennik: dowolny podział na strony', () => {
  it('wyłączone firmy nieczytane, każdy kandydat włączonej firmy raz, w pamięci najwyżej jedna strona', async () => {
    const invoiceArb = fc.oneof(
      { weight: 3, arbitrary: fc.constant<Row>({}) },
      { weight: 1, arbitrary: fc.constantFrom(...NOT_CANDIDATES) },
    );
    const tenantArb = fc.record({
      settings: fc.constantFrom<Settings>('on', 'off', 'none'),
      invoices: fc.array(invoiceArb, { maxLength: 15 }),
    });

    await fc.assert(
      fc.asyncProperty(fc.array(tenantArb, { minLength: 1, maxLength: 12 }), fc.integer({ min: 1, max: 25 }), async (tenants, maxRows) => {
        db.reads = [];
        db.failRead = null;
        db.maxRows = maxRows;
        const { tenantIds, candidatesOf } = seed(tenants);

        await runReminderScheduler(ctx());

        const read = rowsReadByTenant();
        const enabled = tenants.flatMap((t, i) => (t.settings === 'on' ? [i] : []));
        const expected = enabled.flatMap((i) => candidatesOf(i));
        expect(tenantIds.filter((t, i) => tenants[i]!.settings !== 'on' && read[t] !== undefined)).toEqual([]);
        expect(decided()).toHaveLength(expected.length);
        expect(sorted(decided())).toEqual(sorted(expected));
        expect(maxHeld()).toBeLessThanOrEqual(maxRows);
      }),
      { numRuns: 40 },
    );
  }, 60_000);
});

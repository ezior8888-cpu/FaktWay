import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';
import type { KsefEnvironment } from '@/types/ksef';

/**
 * Cykl życia faktury, PR 4b — cron `cron.ksef-lifecycle-reconcile`:
 *   I1  queued bez zlecenia → release (szkic) albo failed ENQUEUE_LOST;
 *   I6  failed klasy transient → ponowienie co godzinę, po 24 → TRANSIENT_EXHAUSTED;
 *   I7  failed KSEF_PAUSED po zdjęciu hamulca → ponowienie;
 *   hamulec włączony albo nieczytelny → żadnych ponowień, I1 nadal porządkowane;
 *   KOR/ZAL (A4b PR2a) → zdarzenie odtworzone z kopii na wierszu (ZAL:
 *       `fa3_data.advanceEnvelope`, KOR: `special_data`, 00137): I6/I7 tylko
 *       w dniu wystawienia i gdy rodzaj nie jest wstrzymany w środowisku (KOR
 *       nie na PROD, ROZ nigdy — C4), I5 bez względu na datę; brak danych →
 *       `skippedNoData`, rodzaj wstrzymany → `skippedHeld`, północ między
 *       odczytem a zleceniem → `skippedIssueDate`, inna korekta w toku (00135)
 *       → `skippedConflict`;
 *   I5  (A3) zalegający wpis `sent` / zamiar `intent` > 48 h przy fakturze
 *       failed/rejected → „tylko uzgodnij” z aktorem NULL, najwyżej raz na
 *       dobę, po trzech próbach w tygodniu — operator (alarm).
 */

const ID1 = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';
const ID3 = '33333333-3333-4333-8333-333333333333';
const ID4 = '44444444-4444-4444-8444-444444444444';
const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** UUID v4 o numerze `n` — do paczek po 100 faktur. */
const uuidN = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
/** Komunikat 23505 z 00135 (jedyny tekst RPC dla korekt). */
const OPEN_CORRECTION_CONFLICT =
  'Faktura pierwotna ma korektę w toku: KOR/2 (draft). Dokończ ją albo wróć nią do szkicu i usuń, zanim wystawisz kolejną.';

type Row = Record<string, unknown>;
/** Filtry `eq` zapytania w kolejności wywołań (kolumna, wartość). */
type Recorded = Array<[string, unknown]>;

const m = vi.hoisted(() => ({
  tables: { invoices: [] as Row[], audit_logs: [] as Row[] },
  violations: [] as Array<{ invariant: string; invoice_id: string; tenant_id: string; detail?: Row }>,
  release: vi.fn(),
  send: vi.fn(),
  paused: vi.fn(),
  env: vi.fn((): KsefEnvironment => 'test'),
  captureMessage: vi.fn(),
  captureException: vi.fn(),
  updates: [] as Array<{ table: string; patch: Row; filters: Recorded }>,
  /** Każde `select(kolumny)` — test sprawdza, co cron naprawdę pobiera. */
  selects: [] as Array<{ table: string; columns: string }>,
  /** Każde `in(kolumna, wartości)` — rozmiary paczek i listy rodzajów. */
  ins: [] as Array<{ table: string; column: string; values: unknown[] }>,
  /** Każde `or(…)` — kursor stron (A5, zagłodzenie paczki). */
  ors: [] as Array<{ table: string; expr: string }>,
  /** Baza „gubi” kursor (ta sama strona w kółko) — test bezpiecznika postępu. */
  orIgnored: false,
  /** Hak po wykonaniu zapytania (np. przesunięcie zegara między odczytem a zleceniem). */
  afterQuery: undefined as undefined | ((query: { table: string; filters: Recorded }) => void),
}));

/** Kolumny z `select('a, b, rel(c, d)')` — podział po przecinkach najwyższego poziomu. */
function splitColumns(columns: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of columns) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      out.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/**
 * Wiersz tak, jak oddaje go PostgREST: tylko wybrane kolumny. Kolumna wybrana,
 * a nieobecna w danych testu → null; niewybrana → brak klucza (undefined).
 * `rel(a, b)` wybiera klucze relacji (obiekt albo tablica obiektów).
 */
function project(row: Row, columns: string): Row {
  const out: Row = {};
  for (const col of splitColumns(columns)) {
    if (col === '*') {
      Object.assign(out, row);
      continue;
    }
    const rel = /^(\w+)\(([\s\S]*)\)$/.exec(col);
    if (!rel) {
      out[col] = row[col] ?? null;
      continue;
    }
    const [, name, inner] = rel;
    const pick = (v: unknown): Row | null => (v !== null && typeof v === 'object' ? project(v as Row, inner!) : null);
    const value = row[name!];
    out[name!] = Array.isArray(value) ? value.map(pick) : pick(value);
  }
  // Kopia jak z sieci — zdarzenie nie dzieli obiektów z danymi testu.
  return structuredClone(out);
}

/**
 * Minimalny klient: filtry eq/in/is/lt/gte na tabelach w pamięci, select
 * z projekcją kolumn, order/limit po filtrach, update z zapisem łatki.
 */
function fakeAdmin() {
  return {
    rpc: async (fn: string, args?: Record<string, unknown>) => {
      if (fn === 'ksef_lifecycle_violations') return { data: m.violations, error: null };
      if (fn === 'release_ksef_enqueue') return { data: await m.release(args), error: null };
      throw new Error(`rpc ${fn}`);
    },
    from: (table: 'invoices' | 'audit_logs') => {
      const filters: Array<(r: Row) => boolean> = [];
      const recorded: Recorded = [];
      let patch: Row | null = null;
      let columns: string | null = null;
      const orderBy: Array<{ key: string; ascending: boolean }> = [];
      let limit: number | null = null;
      const run = () => {
        let rows = m.tables[table].filter((r) => filters.every((f) => f(r)));
        if (patch) {
          rows.forEach((r) => Object.assign(r, patch));
          m.updates.push({ table, patch, filters: recorded });
        }
        if (orderBy.length > 0) {
          rows = [...rows].sort((a, b) => {
            for (const { key, ascending } of orderBy) {
              const [x, y] = [String(a[key]), String(b[key])];
              if (x !== y) return (x < y ? -1 : 1) * (ascending ? 1 : -1);
            }
            return 0;
          });
        }
        if (limit !== null) rows = rows.slice(0, limit);
        const data = columns === null ? rows.map((r) => ({ ...r })) : rows.map((r) => project(r, columns!));
        m.afterQuery?.({ table, filters: recorded });
        return { data, error: null, count: rows.length };
      };
      const q = {
        select: (c = '*') => {
          columns = c;
          m.selects.push({ table, columns: c });
          return q;
        },
        update: (p: Row) => { patch = p; return q; },
        eq: (k: string, v: unknown) => {
          recorded.push([k, v]);
          // `kolumna->>klucz` jak w PostgREST: tekst z jsonb.
          const [col, key] = k.split('->>');
          filters.push((r) => (key ? String((r[col!] as Row | undefined)?.[key!] ?? '') === v : r[k] === v));
          return q;
        },
        in: (k: string, vs: unknown[]) => {
          m.ins.push({ table, column: k, values: [...vs] });
          filters.push((r) => vs.includes(r[k]));
          return q;
        },
        is: (k: string, v: unknown) => { filters.push((r) => r[k] === v || (v === null && r[k] === undefined)); return q; },
        lt: (k: string, v: string) => { filters.push((r) => String(r[k]) < v); return q; },
        gte: (k: string, v: string) => { filters.push((r) => String(r[k]) >= v); return q; },
        // Kursor (`applyCursorFilter`): `a.gt.X,and(a.eq.X,id.gt.Y)` — tylko gt/lt/eq; inna składnia = wyjątek.
        or: (expr: string) => {
          m.ors.push({ table, expr });
          const term = (t: string): ((r: Row) => boolean) => {
            const and = /^and\(([\s\S]*)\)$/.exec(t);
            if (and) {
              const parts = splitColumns(and[1]!).map(term);
              return (r) => parts.every((f) => f(r));
            }
            const cmp = /^(\w+)\.(gt|lt|eq)\.(.+)$/.exec(t);
            if (!cmp) throw new Error(`or: nieobsługiwany warunek ${t}`);
            const [, col, op, value] = cmp;
            return (r) => {
              const x = String(r[col!]);
              return op === 'gt' ? x > value! : op === 'lt' ? x < value! : x === value;
            };
          };
          const alternatives = splitColumns(expr).map(term);
          if (!m.orIgnored) filters.push((r) => alternatives.some((f) => f(r)));
          return q;
        },
        order: (k: string, o?: { ascending?: boolean }) => {
          orderBy.push({ key: k, ascending: o?.ascending !== false });
          return q;
        },
        limit: (n: number) => { limit = n; return q; },
        then: (ok: (v: unknown) => unknown, fail?: (e: unknown) => unknown) => Promise.resolve(run()).then(ok, fail),
      };
      return q;
    },
  };
}

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => fakeAdmin() }));
vi.mock('@/lib/jobs/enqueue', () => ({ sendJobEvent: m.send }));
vi.mock('@/lib/ksef/submission-holds', () => ({ isKsefSubmissionPaused: m.paused }));
vi.mock('@/lib/ksef/claim-environment', () => ({ requireConfiguredKsefEnvironment: m.env }));
vi.mock('@sentry/nextjs', () => ({ captureMessage: m.captureMessage, captureException: m.captureException }));

import {
  ENQUEUE_LOST_MESSAGE,
  I1_RELEASE_REASON,
  LIFECYCLE_BATCH,
  LIFECYCLE_RECONCILE_MAX,
  LIFECYCLE_REQUEUE_MAX,
  LIFECYCLE_SCAN_MAX_PAGES,
  runKsefLifecycleReconcile,
  TRANSIENT_EXHAUSTED_MESSAGE,
} from '@/lib/jobs/runners/ksef-lifecycle-reconcile';

const ctx: JobContext = {
  attempt: 0,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  step: { run: async (_n, fn) => fn(), sleep: vi.fn(), sendEvent: vi.fn(), scheduleAfter: vi.fn() },
};

const OLD = '2026-10-03T08:00:00.000Z'; // ponad godzinę przed „teraz”
const NOW = new Date('2026-10-03T12:00:00.000Z');
/** „Dziś” w Polsce przy NOW (14:00 czasu polskiego). */
const TODAY = '2026-10-03';

function failedRow(id: string, code: string, extra: Row = {}): Row {
  return {
    id, tenant_id: TENANT, direction: 'outgoing', ksef_status: 'failed', invoice_kind: 'regular',
    last_error_code: code, updated_at: OLD, tenants: { nip: '5260001246' }, issue_date: TODAY, special_data: null,
    fa3_data: { internalNumber: `FV/${id.slice(0, 2)}`, type: 'VAT', lines: [{ ordinal: 1 }], seller: { nip: '5260001246' } },
    ...extra,
  };
}

/** Zaliczka (ZAL): dane wysyłki w kopercie `fa3_data.advanceEnvelope` (od 02.10.2026). */
function zalRow(id: string, code: string, issueDate: string, extra: Row = {}): Row {
  return failedRow(id, code, {
    invoice_kind: 'advance',
    issue_date: issueDate,
    fa3_data: {
      internalNumber: `FZ/${id.slice(0, 2)}`, type: 'ZAL', issueDate, lines: [{ ordinal: 1 }], seller: { nip: '5260001246' },
      advanceEnvelope: { invoiceType: 'advance', issueDate },
    },
    ...extra,
  });
}

/** Korekta (KOR): dane wysyłki w `special_data.correctionData` (00137). */
function korRow(id: string, code: string, issueDate: string, extra: Row = {}): Row {
  return failedRow(id, code, {
    invoice_kind: 'correction',
    issue_date: issueDate,
    fa3_data: {
      internalNumber: `FK/${id.slice(0, 2)}`, type: 'KOR', issueDate, lines: [{ ordinal: 1 }], seller: { nip: '5260001246' },
    },
    special_data: { correctionData: { invoiceType: 'correction', issueDate } },
    ...extra,
  });
}

/** Wiersz audytu automatycznego ponowienia (aktor NULL) sprzed `hoursAgo` godzin. */
function autoRequeueAudit(invoiceId: string, hoursAgo: number): Row {
  return {
    action: 'invoice.send_requeued', user_id: null, entity_id: invoiceId,
    created_at: new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString(),
  };
}

type Tx = { executeSql: ReturnType<typeof vi.fn> };
const sqlCalls: Array<[string, unknown[]]> = [];

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  m.tables = { invoices: [], audit_logs: [] };
  m.violations = [];
  m.updates = [];
  m.selects = [];
  m.ins = [];
  m.ors = [];
  m.orIgnored = false;
  m.afterQuery = undefined;
  sqlCalls.length = 0;
  m.env.mockImplementation(() => 'test');
  m.paused.mockResolvedValue(false);
  m.release.mockResolvedValue(true);
  m.send.mockImplementation(async (_event: unknown, options?: { inTransaction?: (tx: Tx) => Promise<void> }) => {
    const tx: Tx = { executeSql: vi.fn(async (sql: string, values: unknown[]) => { sqlCalls.push([sql, values]); return { rows: [], rowCount: 1 }; }) };
    await options?.inTransaction?.(tx);
    return { ids: ['job'] };
  });
});

describe('I1 — queued bez zlecenia', () => {
  it('bez dowodu kontaktu: release_ksef_enqueue (szkic); z dowodem: failed ENQUEUE_LOST', async () => {
    m.violations = [
      { invariant: 'I1', invoice_id: ID1, tenant_id: TENANT },
      { invariant: 'I1', invoice_id: ID2, tenant_id: TENANT },
      { invariant: 'I3', invoice_id: ID3, tenant_id: TENANT },
    ];
    m.tables.invoices = [{ id: ID2, tenant_id: TENANT, ksef_status: 'queued' }];
    m.release.mockImplementation(async (args: { p_invoice_id: string }) => args.p_invoice_id === ID1);

    const report = await runKsefLifecycleReconcile(ctx);

    expect(m.release).toHaveBeenCalledWith({ p_invoice_id: ID1, p_tenant_id: TENANT, p_reason: I1_RELEASE_REASON });
    expect(report).toMatchObject({ i1Released: 1, i1Lost: 1, errors: 0 });
    expect(m.tables.invoices[0]).toMatchObject({
      ksef_status: 'failed', last_error_code: 'ENQUEUE_LOST', last_error: ENQUEUE_LOST_MESSAGE, ksef_send_owner: null,
    });
    expect(m.captureMessage).toHaveBeenCalled();
  });
});

describe('I6 — automatyczne ponowienie klasy transient', () => {
  it('failed INFRA starszy niż godzina: requeue_ksef_send z aktorem NULL, zdarzenie z sendAttemptId', async () => {
    m.tables.invoices = [failedRow(ID1, 'INFRA')];

    const report = await runKsefLifecycleReconcile(ctx);

    expect(report).toMatchObject({ requeued: 1, exhausted: 0, errors: 0 });
    const event = m.send.mock.calls[0]![0] as { singletonKey: string; data: Record<string, unknown> };
    expect(event.singletonKey).toBe(ID1);
    expect(event.data).toMatchObject({ invoiceId: ID1, tenantId: TENANT, nip: '5260001246', environment: 'test' });
    expect(event.data.sendAttemptId).toMatch(UUID);
    const [sql, values] = sqlCalls[0]!;
    expect(sql).toMatch(/public\.requeue_ksef_send\(/);
    expect(values).toEqual([ID1, TENANT, event.data.sendAttemptId, null, false]);
  });

  it('świeżo zmieniony (< 1 h) nie jest ponawiany', async () => {
    m.tables.invoices = [failedRow(ID1, 'KSEF_UNAVAILABLE', { updated_at: new Date(NOW.getTime() - 10 * 60_000).toISOString() })];
    const report = await runKsefLifecycleReconcile(ctx);
    expect(report.requeued).toBe(0);
    expect(m.send).not.toHaveBeenCalled();
  });

  it('po 24 automatycznych ponowieniach w dobie: TRANSIENT_EXHAUSTED zamiast kolejnego', async () => {
    m.tables.invoices = [failedRow(ID1, 'KSEF_SESSION'), failedRow(ID2, 'INFRA')];
    for (let h = 1; h <= LIFECYCLE_REQUEUE_MAX; h++) m.tables.audit_logs.push(autoRequeueAudit(ID1, h));
    // Ponowienia ludzi (aktor ≠ NULL) i stare (> 25 h) nie liczą się.
    m.tables.audit_logs.push({ ...autoRequeueAudit(ID2, 2), user_id: 'operator' });
    m.tables.audit_logs.push(autoRequeueAudit(ID2, 30));

    const report = await runKsefLifecycleReconcile(ctx);

    expect(report).toMatchObject({ exhausted: 1, requeued: 1 });
    expect(m.tables.invoices[0]).toMatchObject({ last_error_code: 'TRANSIENT_EXHAUSTED', last_error: TRANSIENT_EXHAUSTED_MESSAGE, ksef_status: 'failed' });
    expect(m.send).toHaveBeenCalledTimes(1);
    expect((m.send.mock.calls[0]![0] as { singletonKey: string }).singletonKey).toBe(ID2);
    expect(m.captureMessage).toHaveBeenCalled();
  });

  it('stara korekta bez special_data z dzisiejszą datą (TEST): wybrana i pominięta jako brak danych; kody spoza auto_requeue nie są wybierane', async () => {
    m.tables.invoices = [
      failedRow(ID1, 'INFRA', { invoice_kind: 'correction' }),
      failedRow(ID2, 'CREDENTIALS_UNAVAILABLE'),
      failedRow(ID3, 'XSD_INVALID'),
      // ZAL z kopią i dzisiejszą datą, ale kod spoza automatu — nie jest wybierana.
      zalRow(ID4, 'ISSUE_DATE_PASSED', TODAY),
    ];
    const report = await runKsefLifecycleReconcile(ctx);
    expect(report).toMatchObject({ requeued: 0, skippedNoData: 1 });
    expect(m.send).not.toHaveBeenCalled();
  });

  it('ZAL z dzisiejszą datą i kopertą (KSEF_UNAVAILABLE): zdarzenie z kopii — advanceData = koperta, jedno ponowienie', async () => {
    const row = zalRow(ID1, 'KSEF_UNAVAILABLE', TODAY);
    m.tables.invoices = [row];

    const report = await runKsefLifecycleReconcile(ctx);

    expect(report).toMatchObject({ requeued: 1, errors: 0 });
    expect(m.send).toHaveBeenCalledTimes(1);
    const event = m.send.mock.calls[0]![0] as { singletonKey: string; data: Record<string, unknown> };
    expect(event.singletonKey).toBe(ID1);
    expect(event.data).toMatchObject({ invoiceId: ID1, tenantId: TENANT, nip: '5260001246', environment: 'test' });
    expect(event.data.invoice).toEqual(row.fa3_data);
    expect(event.data.advanceData).toEqual({ invoiceType: 'advance', issueDate: TODAY });
    expect(event.data).not.toHaveProperty('correctionData');
    expect(event.data).not.toHaveProperty('reconcileOnly');
    expect(sqlCalls[0]![1]).toEqual([ID1, TENANT, event.data.sendAttemptId, null, false]);
  });

  it('100 ZAL po dacie wystawienia (starsze updated_at) nie zajmują paczki — zwykła INFRA zostaje ponowiona', async () => {
    const zals = Array.from({ length: 100 }, (_, i) =>
      zalRow(uuidN(i + 1), 'KSEF_UNAVAILABLE', '2026-10-02', { updated_at: '2026-10-03T07:00:00.000Z' }));
    m.tables.invoices = [...zals, failedRow(ID1, 'INFRA')];

    const report = await runKsefLifecycleReconcile(ctx);

    expect(m.send).toHaveBeenCalledTimes(1);
    expect((m.send.mock.calls[0]![0] as { singletonKey: string }).singletonKey).toBe(ID1);
    // ZAL po dacie odpada już w zapytaniu (issue_date = dziś), nie w budowaniu zdarzenia.
    expect(report).toMatchObject({ requeued: 1, skippedIssueDate: 0, errors: 0 });
  });

  it('stara ZAL bez koperty advanceEnvelope (sprzed 02.10.2026) z dzisiejszą datą: brak danych — skippedNoData, bez zlecenia', async () => {
    const row = zalRow(ID1, 'INFRA', TODAY);
    delete (row.fa3_data as Row).advanceEnvelope;
    m.tables.invoices = [row];

    const report = await runKsefLifecycleReconcile(ctx);

    expect(report).toMatchObject({ requeued: 0, skippedNoData: 1, errors: 0 });
    expect(m.send).not.toHaveBeenCalled();
  });

  it('liczenie ponowień paczkami po 100: 100 zwykłych + ZAL z dzisiaj po 24 ponowieniach → ZAL wyczerpana, 100 ponowionych', async () => {
    const regular = Array.from({ length: 100 }, (_, i) => failedRow(uuidN(i + 1), 'INFRA'));
    // Najmłodsza w kolejce (ale > 1 h) — w jednym zapytaniu z limitem 100 nie zmieściłaby się.
    m.tables.invoices = [...regular, zalRow(ID1, 'INFRA', TODAY, { updated_at: '2026-10-03T10:30:00.000Z' })];
    for (let h = 1; h <= LIFECYCLE_REQUEUE_MAX; h++) m.tables.audit_logs.push(autoRequeueAudit(ID1, h));

    const report = await runKsefLifecycleReconcile(ctx);

    expect(report).toMatchObject({ exhausted: 1, requeued: 100, errors: 0 });
    expect(m.tables.invoices.find((r) => r.id === ID1)).toMatchObject({ last_error_code: 'TRANSIENT_EXHAUSTED' });
    const counted = m.ins.filter((i) => i.table === 'audit_logs' && i.column === 'entity_id').map((i) => i.values.length);
    expect(counted).toEqual([100, 1]);
  });

  it('północ między odczytem a zleceniem: ZAL wybrana o 23:59:59, zdarzenie budowane po północy — skippedIssueDate, bez zlecenia', async () => {
    vi.setSystemTime(new Date('2026-10-03T21:59:59.000Z')); // 23:59:59 w Polsce
    m.tables.invoices = [zalRow(ID1, 'KSEF_UNAVAILABLE', '2026-10-03')];
    m.afterQuery = ({ filters }) => {
      if (filters.some(([column]) => column === 'issue_date')) vi.setSystemTime(new Date('2026-10-03T22:00:01.000Z'));
    };

    const report = await runKsefLifecycleReconcile(ctx);

    expect(report).toMatchObject({ requeued: 0, skippedIssueDate: 1, errors: 0 });
    expect(m.send).not.toHaveBeenCalled();
    // A5 #2: stan oczekiwany — bez zbiorczego Sentry; log nazywa fakturę, ścieżkę i powód.
    expect(m.captureMessage).not.toHaveBeenCalled();
    expect((ctx.logger.info as ReturnType<typeof vi.fn>).mock.calls).toContainEqual([
      'Cykl życia: faktury nie da się ponowić automatycznie', { invoiceId: ID1, invariant: 'I6', reason: 'issue-date' },
    ]);
  });

  it('KSeF produkcyjny: KOR z danymi i dzisiejszą datą odpada w zapytaniu (invoice_kind in [advance]) — bez zlecenia i bez pominięć', async () => {
    m.env.mockReturnValue('production');
    m.tables.invoices = [korRow(ID1, 'INFRA', TODAY)];

    const report = await runKsefLifecycleReconcile(ctx);

    expect(m.send).not.toHaveBeenCalled();
    expect(report).toMatchObject({ requeued: 0, skippedHeld: 0, skippedNoData: 0, errors: 0 });
    const kinds = m.ins.filter((i) => i.table === 'invoices' && i.column === 'invoice_kind').map((i) => i.values);
    expect(kinds).toEqual([['advance'], ['advance']]); // I6 i I7
  });

  it('błąd jednego ponowienia nie zatrzymuje reszty', async () => {
    m.tables.invoices = [failedRow(ID1, 'INFRA'), failedRow(ID2, 'INFRA')];
    m.send.mockRejectedValueOnce(Object.assign(new Error('Błąd treści dokumentu'), { code: 'P0001' }));
    const report = await runKsefLifecycleReconcile(ctx);
    expect(report).toMatchObject({ requeued: 1, errors: 1 });
    expect(m.captureException).toHaveBeenCalledTimes(1);
  });
});

describe('I7 i hamulec', () => {
  it('po zdjęciu hamulca failed KSEF_PAUSED jest ponawiany', async () => {
    m.tables.invoices = [failedRow(ID1, 'KSEF_PAUSED', { updated_at: new Date(NOW.getTime() - 60_000).toISOString() })];
    const report = await runKsefLifecycleReconcile(ctx);
    expect(report).toMatchObject({ resumedAfterPause: 1, requeued: 0 });
    expect(sqlCalls[0]![1]).toEqual([ID1, TENANT, expect.stringMatching(UUID), null, false]);
  });

  it('ZAL z dzisiejszą datą, failed KSEF_PAUSED: po zdjęciu hamulca wznowiona z kopii', async () => {
    m.tables.invoices = [zalRow(ID1, 'KSEF_PAUSED', TODAY, { updated_at: new Date(NOW.getTime() - 60_000).toISOString() })];

    const report = await runKsefLifecycleReconcile(ctx);

    expect(report).toMatchObject({ resumedAfterPause: 1, requeued: 0, errors: 0 });
    const event = m.send.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(event.data.advanceData).toEqual({ invoiceType: 'advance', issueDate: TODAY });
    expect(sqlCalls[0]![1]).toEqual([ID1, TENANT, expect.stringMatching(UUID), null, false]);
  });

  it('strażnik: ta sama ZAL z wczorajszą datą — bez wznowienia (pełna wysyłka tylko w dniu wystawienia, decyzja b)', async () => {
    m.tables.invoices = [zalRow(ID1, 'KSEF_PAUSED', '2026-10-02', { updated_at: new Date(NOW.getTime() - 60_000).toISOString() })];

    const report = await runKsefLifecycleReconcile(ctx);

    expect(report).toMatchObject({ resumedAfterPause: 0, errors: 0 });
    expect(m.send).not.toHaveBeenCalled();
  });

  it('hamulec włączony: I1 porządkowane, zero ponowień', async () => {
    m.paused.mockResolvedValue(true);
    m.violations = [{ invariant: 'I1', invoice_id: ID1, tenant_id: TENANT }];
    m.tables.invoices = [failedRow(ID2, 'INFRA'), failedRow(ID3, 'KSEF_PAUSED')];
    const report = await runKsefLifecycleReconcile(ctx);
    expect(report).toMatchObject({ paused: true, i1Released: 1, requeued: 0, resumedAfterPause: 0 });
    expect(m.send).not.toHaveBeenCalled();
  });

  it('hamulec nieczytelny (awaria bazy): zero ponowień — fail-closed', async () => {
    m.paused.mockRejectedValue(new Error('db'));
    m.tables.invoices = [failedRow(ID1, 'INFRA')];
    const report = await runKsefLifecycleReconcile(ctx);
    expect(report).toMatchObject({ paused: null, requeued: 0 });
    expect(m.send).not.toHaveBeenCalled();
  });
});

/** Wiersz audytu automatycznego „tylko uzgodnij” (aktor NULL, reconcile_only) sprzed `hoursAgo` godzin. */
function autoReconcileAudit(invoiceId: string, hoursAgo: number): Row {
  return { ...autoRequeueAudit(invoiceId, hoursAgo), details_json: { reconcile_only: true } };
}
const i5 = (invoiceId: string) => ({ invariant: 'I5', invoice_id: invoiceId, tenant_id: TENANT, detail: { session: 'S-1' } });

describe('I5 — zalegający wpis: automatyczne „tylko uzgodnij” (A3)', () => {
  it('failed RESULT_UNCERTAIN z wpisem sprzed 3 dni: jedno zlecenie reconcileOnly (RPC z p_reconcile_only = true, aktor NULL)', async () => {
    m.violations = [i5(ID1)];
    m.tables.invoices = [failedRow(ID1, 'RESULT_UNCERTAIN')];

    const report = await runKsefLifecycleReconcile(ctx);

    expect(report).toMatchObject({ i5Reconciled: 1, requeued: 0, errors: 0 });
    expect(m.send).toHaveBeenCalledTimes(1);
    const event = m.send.mock.calls[0]![0] as { singletonKey: string; data: Record<string, unknown> };
    expect(event.singletonKey).toBe(ID1);
    expect(event.data).toMatchObject({ invoiceId: ID1, reconcileOnly: true });
    expect(sqlCalls[0]![1]).toEqual([ID1, TENANT, event.data.sendAttemptId, null, true]);
  });

  it('rejected z otwartym wpisem też (RPC dopuszcza rejected w trybie uzgodnienia); kilka wierszy I5 tej samej faktury = jedno zlecenie', async () => {
    m.violations = [i5(ID1), i5(ID1)];
    m.tables.invoices = [failedRow(ID1, 'KSEF_REJECTED', { ksef_status: 'rejected' })];
    const report = await runKsefLifecycleReconcile(ctx);
    expect(report.i5Reconciled).toBe(1);
    expect(m.send).toHaveBeenCalledTimes(1);
  });

  it('najwyżej raz na dobę: próba sprzed 5 h — czekamy; ponowienia I6 (bez reconcile_only) się nie liczą', async () => {
    m.violations = [i5(ID1), i5(ID2)];
    m.tables.invoices = [failedRow(ID1, 'RESULT_UNCERTAIN'), failedRow(ID2, 'TRANSIENT_EXHAUSTED')];
    m.tables.audit_logs.push(autoReconcileAudit(ID1, 5));
    m.tables.audit_logs.push({ ...autoRequeueAudit(ID2, 2), details_json: { reconcile_only: false } });

    const report = await runKsefLifecycleReconcile(ctx);

    expect(report).toMatchObject({ i5Reconciled: 1, i5Deferred: 1 });
    expect((m.send.mock.calls[0]![0] as { singletonKey: string }).singletonKey).toBe(ID2);
  });

  it(`po ${3} próbach w tygodniu: bez kolejnej — operator (alarm)`, async () => {
    m.violations = [i5(ID1)];
    m.tables.invoices = [failedRow(ID1, 'RESULT_UNCERTAIN')];
    for (const h of [26, 50, 74].slice(0, LIFECYCLE_RECONCILE_MAX)) m.tables.audit_logs.push(autoReconcileAudit(ID1, h));

    const report = await runKsefLifecycleReconcile(ctx);

    expect(report).toMatchObject({ i5Reconciled: 0, i5NeedsOperator: 1 });
    expect(m.send).not.toHaveBeenCalled();
    expect(m.captureMessage).toHaveBeenCalled();
  });

  it('faktura poza failed/rejected (accepted z niezamkniętym wpisem, queued) — tylko alarm, bez zlecenia', async () => {
    m.violations = [i5(ID1), i5(ID2)];
    m.tables.invoices = [
      failedRow(ID1, 'RESULT_UNCERTAIN', { ksef_status: 'accepted', ksef_number: 'K-1' }),
      failedRow(ID2, 'RESULT_UNCERTAIN', { ksef_status: 'queued' }),
    ];
    const report = await runKsefLifecycleReconcile(ctx);
    expect(report).toMatchObject({ i5Reconciled: 0, i5Other: 2 });
    expect(m.send).not.toHaveBeenCalled();
  });

  it('stary dokument specjalny bez danych — pominięty', async () => {
    m.violations = [i5(ID1)];
    m.tables.invoices = [failedRow(ID1, 'RESULT_UNCERTAIN', { invoice_kind: 'correction' })];
    const report = await runKsefLifecycleReconcile(ctx);
    expect(report).toMatchObject({ i5Reconciled: 0, skippedNoData: 1 });
    expect(m.send).not.toHaveBeenCalled();
  });

  it('KOR z danymi w special_data na TEST (data sprzed dni): „tylko uzgodnij” z correctionData', async () => {
    m.violations = [i5(ID1)];
    const row = korRow(ID1, 'RESULT_UNCERTAIN', '2026-10-01');
    m.tables.invoices = [row];

    const report = await runKsefLifecycleReconcile(ctx);

    expect(report).toMatchObject({ i5Reconciled: 1, errors: 0 });
    expect(m.send).toHaveBeenCalledTimes(1);
    const event = m.send.mock.calls[0]![0] as { singletonKey: string; data: Record<string, unknown> };
    expect(event.singletonKey).toBe(ID1);
    expect(event.data).toMatchObject({ invoiceId: ID1, tenantId: TENANT, environment: 'test', reconcileOnly: true });
    expect(event.data.invoice).toEqual(row.fa3_data);
    expect(event.data.correctionData).toEqual({ invoiceType: 'correction', issueDate: '2026-10-01' });
    expect(sqlCalls[0]![1]).toEqual([ID1, TENANT, event.data.sendAttemptId, null, true]);
  });

  it('ZAL po dacie wystawienia (ISSUE_DATE_PASSED, 02.10): uzgodnienie mimo daty — reconcileOnly z kopertą (decyzja b, #242)', async () => {
    m.violations = [i5(ID1)];
    m.tables.invoices = [zalRow(ID1, 'ISSUE_DATE_PASSED', '2026-10-02')];

    const report = await runKsefLifecycleReconcile(ctx);

    expect(report).toMatchObject({ i5Reconciled: 1, errors: 0 });
    const event = m.send.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(event.data.reconcileOnly).toBe(true);
    expect(event.data.advanceData).toEqual({ invoiceType: 'advance', issueDate: '2026-10-02' });
    expect(sqlCalls[0]![1].slice(-2)).toEqual([null, true]);
  });

  it('KOR z danymi na KSeF produkcyjnym (KOR_HOLD): bez uzgadniania — skippedHeld', async () => {
    m.env.mockReturnValue('production');
    m.violations = [i5(ID1)];
    m.tables.invoices = [korRow(ID1, 'RESULT_UNCERTAIN', TODAY)];

    const report = await runKsefLifecycleReconcile(ctx);

    expect(report).toMatchObject({ i5Reconciled: 0, skippedHeld: 1, errors: 0 });
    expect(m.send).not.toHaveBeenCalled();
  });

  it('odrzucona KOR, gdy inna korekta tej faktury pierwotnej jest w toku (00135, 23505): skippedConflict, bez błędu i Sentry', async () => {
    m.violations = [i5(ID1)];
    m.tables.invoices = [korRow(ID1, 'KSEF_REJECTED', '2026-10-01', { ksef_status: 'rejected' })];
    m.send.mockRejectedValueOnce(Object.assign(new Error(OPEN_CORRECTION_CONFLICT), { code: '23505' }));

    const report = await runKsefLifecycleReconcile(ctx);

    expect(m.send).toHaveBeenCalledTimes(1);
    expect(report).toMatchObject({ i5Reconciled: 0, skippedConflict: 1, errors: 0 });
    expect(m.captureException).not.toHaveBeenCalled();
    // A5 #2: stan oczekiwany — bez zbiorczego Sentry; log nazywa fakturę i ścieżkę.
    expect(m.captureMessage).not.toHaveBeenCalled();
    expect((ctx.logger.info as ReturnType<typeof vi.fn>).mock.calls).toContainEqual([
      'Cykl życia: korekta czeka na inną korektę tej faktury pierwotnej', { invoiceId: ID1, invariant: 'I5' },
    ]);
  });

  it('inny 23505 przy uzgodnieniu tej samej KOR (unikalny numer faktury) to nadal błąd: errors + Sentry, skippedConflict 0', async () => {
    m.violations = [i5(ID1)];
    m.tables.invoices = [korRow(ID1, 'KSEF_REJECTED', '2026-10-01', { ksef_status: 'rejected' })];
    m.send.mockRejectedValueOnce(Object.assign(
      new Error('duplicate key value violates unique constraint "invoices_tenant_internal_number_key"'),
      { code: '23505' },
    ));

    const report = await runKsefLifecycleReconcile(ctx);

    expect(m.send).toHaveBeenCalledTimes(1);
    expect(report).toMatchObject({ i5Reconciled: 0, skippedConflict: 0, errors: 1 });
    expect(m.captureException).toHaveBeenCalledTimes(1);
  });

  it('zwykła INFRA bez pozycji w fa3_data i z wpisem I5: jedno skippedNoData (I6 i I5 nie liczą jej dwa razy), bez zlecenia i błędu', async () => {
    m.violations = [i5(ID1)];
    m.tables.invoices = [failedRow(ID1, 'INFRA', { fa3_data: { internalNumber: 'FV/11', type: 'VAT', seller: { nip: '5260001246' } } })];

    const report = await runKsefLifecycleReconcile(ctx);

    expect(report).toMatchObject({ requeued: 0, i5Reconciled: 0, skippedNoData: 1, errors: 0 });
    expect(m.send).not.toHaveBeenCalled();
  });

  it('hamulec włączony: bez uzgadniania z crona', async () => {
    m.paused.mockResolvedValue(true);
    m.violations = [i5(ID1)];
    m.tables.invoices = [failedRow(ID1, 'RESULT_UNCERTAIN')];
    const report = await runKsefLifecycleReconcile(ctx);
    expect(report.i5Reconciled).toBe(0);
    expect(m.send).not.toHaveBeenCalled();
  });
});

/**
 * A5, zagłodzenie paczki (przekazanie 14.10.2026): faktura, której automat nie
 * ruszy (odmowa budowy zlecenia, I5 poza failed/rejected, I5 po limicie prób),
 * nie zmienia wiersza, więc wraca w każdym przebiegu na to samo miejsce. Gdy
 * paczka 100 była limitem ODCZYTU (I6/I7: `limit(100)` po updated_at; I5:
 * `slice(0, 100)` przed filtrem stanu), sto takich faktur zajmowało ją na
 * zawsze, a poprawne za nimi nie były ponawiane nigdy. Paczka liczy teraz
 * faktury, przy których automat działa; odczyt idzie dalej stronami po
 * (updated_at, id), najwyżej LIFECYCLE_SCAN_MAX_PAGES stron (bezpiecznik
 * z ostrzeżeniem i licznikiem `scanCapped`).
 */
describe('A5: paczka liczy działania automatu, nie odczytane wiersze (zagłodzenie)', () => {
  const OLDER = '2026-10-03T07:00:00.000Z';
  const YOUNGER = '2026-10-03T10:30:00.000Z'; // młodsza od reszty, ale > 1 h przed NOW
  /** Zwykła faktura bez tablicy pozycji — builder zwraca `incomplete`. */
  const noLines = (id: string, code: string, extra: Row = {}) =>
    failedRow(id, code, { fa3_data: { internalNumber: `FV/${id.slice(0, 2)}`, type: 'VAT', seller: { nip: '5260001246' } }, ...extra });
  /** Brak NIP-u i w firmie, i w `fa3_data.seller` — builder zwraca `no-nip`. */
  const noNip = (id: string, code: string, extra: Row = {}) => failedRow(id, code, {
    tenants: { nip: null },
    fa3_data: { internalNumber: `FV/${id.slice(0, 2)}`, type: 'VAT', lines: [{ ordinal: 1 }], seller: {} },
    ...extra,
  });
  const sentIds = () => m.send.mock.calls.map(([event]) => (event as { singletonKey: string }).singletonKey);
  const invoiceOrs = () => m.ors.filter((o) => o.table === 'invoices').map((o) => o.expr);
  /** Zapytania I5 o faktury z zalegającym wpisem (`in('id', …)` na invoices). */
  const staleReads = () => m.ins.filter((i) => i.table === 'invoices' && i.column === 'id');
  type LogCall = [string, Record<string, unknown>?];
  const warns = () => (ctx.logger.warn as ReturnType<typeof vi.fn>).mock.calls as LogCall[];

  it('I6: 60 bez pozycji i 40 bez NIP-u (starsze) nie zajmują paczki — poprawna INFRA ponowiona w tym samym przebiegu', async () => {
    m.tables.invoices = [
      ...Array.from({ length: 60 }, (_, i) => noLines(uuidN(i + 1), 'INFRA', { updated_at: OLDER })),
      ...Array.from({ length: 40 }, (_, i) => noNip(uuidN(61 + i), 'KSEF_UNAVAILABLE', { updated_at: OLDER })),
      failedRow(ID1, 'INFRA'),
    ];

    const report = await runKsefLifecycleReconcile(ctx);

    expect(sentIds()).toEqual([ID1]);
    expect(report).toMatchObject({ requeued: 1, skippedNoData: 60, scanCapped: 0, errors: 0 });
  });

  it('I6: kursor po (updated_at, id) — 150 odmówionych z TYM SAMYM updated_at co poprawna (wyższe id); druga strona od id 100', async () => {
    // Wstawione odwrotnie do id: kolejność remisów ustala tylko order('id'), nie kolejność w tabeli.
    m.tables.invoices = [
      failedRow(uuidN(151), 'INFRA'),
      ...Array.from({ length: 150 }, (_, i) => noLines(uuidN(150 - i), 'INFRA')),
    ];

    const report = await runKsefLifecycleReconcile(ctx);

    expect(sentIds()).toEqual([uuidN(151)]);
    expect(report).toMatchObject({ requeued: 1, skippedNoData: 150, errors: 0 });
    // Remis updated_at rozstrzyga id; druga strona zaczyna się ZA setnym wierszem (nie od niego).
    expect(invoiceOrs()).toEqual([`updated_at.gt.${OLD},and(updated_at.eq.${OLD},id.gt.${uuidN(100)})`]);
  });

  it(`I6: paczka dalej ${100} zleceń — 100 odmówionych (starsze) + 150 poprawnych → ponowione 100 najstarszych poprawnych`, async () => {
    m.tables.invoices = [
      ...Array.from({ length: 100 }, (_, i) => noLines(uuidN(i + 1), 'INFRA', { updated_at: OLDER })),
      ...Array.from({ length: 150 }, (_, i) => failedRow(uuidN(101 + i), 'INFRA')),
    ];

    const report = await runKsefLifecycleReconcile(ctx);

    expect(report).toMatchObject({ requeued: LIFECYCLE_BATCH, skippedNoData: 100, errors: 0 });
    expect(sentIds()).toEqual(Array.from({ length: LIFECYCLE_BATCH }, (_, i) => uuidN(101 + i)));
  });

  it('I6 dokumenty specjalne: 100 dzisiejszych ZAL bez koperty (starsze) nie blokują ZAL z kopertą', async () => {
    const noEnvelope = (id: string) => {
      const row = zalRow(id, 'INFRA', TODAY, { updated_at: OLDER });
      delete (row.fa3_data as Row).advanceEnvelope;
      return row;
    };
    m.tables.invoices = [...Array.from({ length: 100 }, (_, i) => noEnvelope(uuidN(i + 1))), zalRow(ID1, 'INFRA', TODAY)];

    const report = await runKsefLifecycleReconcile(ctx);

    expect(sentIds()).toEqual([ID1]);
    expect(report).toMatchObject({ requeued: 1, skippedNoData: 100, errors: 0 });
  });

  it('I7: 100 odmówionych KSEF_PAUSED (starsze) nie blokują wznowienia poprawnej po zdjęciu hamulca', async () => {
    m.tables.invoices = [
      ...Array.from({ length: 100 }, (_, i) => noLines(uuidN(i + 1), 'KSEF_PAUSED', { updated_at: OLDER })),
      failedRow(ID1, 'KSEF_PAUSED', { updated_at: YOUNGER }),
    ];

    const report = await runKsefLifecycleReconcile(ctx);

    expect(sentIds()).toEqual([ID1]);
    expect(report).toMatchObject({ resumedAfterPause: 1, requeued: 0, skippedNoData: 100, errors: 0 });
  });

  it(`bezpiecznik odczytu: ${LIFECYCLE_SCAN_MAX_PAGES} pełnych stron odmówionych — koniec szukania, ostrzeżenie, scanCapped`, async () => {
    const refused = LIFECYCLE_SCAN_MAX_PAGES * LIFECYCLE_BATCH;
    m.tables.invoices = [
      ...Array.from({ length: refused }, (_, i) => noLines(uuidN(i + 1), 'INFRA', { updated_at: OLDER })),
      failedRow(ID1, 'INFRA', { updated_at: YOUNGER }),
    ];

    const report = await runKsefLifecycleReconcile(ctx);

    expect(m.send).not.toHaveBeenCalled();
    expect(report).toMatchObject({ requeued: 0, skippedNoData: refused, scanCapped: 1, errors: 0 });
    // Odczyt ograniczony: pierwsza strona bez kursora + (MAX − 1) z kursorem — i nic dalej.
    expect(invoiceOrs()).toHaveLength(LIFECYCLE_SCAN_MAX_PAGES - 1);
    const capped = warns().filter(([message]) => /bezpiecznik odczytu/.test(message));
    expect(capped).toHaveLength(1);
    expect(capped[0]![1]).toMatchObject({ invariant: 'I6', kind: 'regular', pages: LIFECYCLE_SCAN_MAX_PAGES, collected: 0 });
  });

  it('I7: wiersz zmieniony w trakcie odczytu (nowe updated_at) wraca na drugiej stronie — w paczce raz', async () => {
    const moved = uuidN(100);
    m.tables.invoices = [
      ...Array.from({ length: 99 }, (_, i) => noLines(uuidN(i + 1), 'KSEF_PAUSED', { updated_at: OLDER })),
      failedRow(moved, 'KSEF_PAUSED', { updated_at: OLDER }),
    ];
    let bumped = false;
    m.afterQuery = ({ table, filters }) => {
      if (bumped || table !== 'invoices' || !filters.some(([column, value]) => column === 'last_error_code' && value === 'KSEF_PAUSED')) return;
      bumped = true;
      m.tables.invoices.find((r) => r.id === moved)!.updated_at = YOUNGER;
    };

    const report = await runKsefLifecycleReconcile(ctx);

    expect(invoiceOrs()).toHaveLength(1); // druga strona była czytana i oddała ten wiersz jeszcze raz
    expect(sentIds()).toEqual([moved]);
    expect(report).toMatchObject({ resumedAfterPause: 1, skippedNoData: 99, errors: 0 });
  });

  it('I7: pełna strona kończy się wierszem bez updated_at (NULLS LAST) — odczyt przerwany z ostrzeżeniem, bez wyjątku', async () => {
    m.tables.invoices = [
      ...Array.from({ length: 99 }, (_, i) => noLines(uuidN(i + 1), 'KSEF_PAUSED', { updated_at: OLDER })),
      noLines(uuidN(100), 'KSEF_PAUSED', { updated_at: null }),
      failedRow(ID1, 'KSEF_PAUSED', { updated_at: null }),
    ];

    const report = await runKsefLifecycleReconcile(ctx);

    expect(report).toMatchObject({ resumedAfterPause: 0, skippedNoData: 100, scanCapped: 0, errors: 0 });
    expect(invoiceOrs()).toEqual([]);
    const stopped = warns().filter(([message]) => /bez updated_at/.test(message));
    expect(stopped.map(([, extra]) => extra)).toEqual([
      expect.objectContaining({ invariant: 'I7', kind: 'regular', pages: 1, collected: 0 }),
    ]);
  });

  it('I5: 100 faktur accepted z niezamkniętym wpisem (i5Other) nie zajmuje paczki — failed z wpisem uzgodniony', async () => {
    for (let i = 1; i <= 100; i++) {
      m.violations.push(i5(uuidN(i)));
      m.tables.invoices.push(failedRow(uuidN(i), 'RESULT_UNCERTAIN', { ksef_status: 'accepted', ksef_number: `K-${i}` }));
    }
    m.violations.push(i5(ID1));
    m.tables.invoices.push(failedRow(ID1, 'RESULT_UNCERTAIN'));

    const report = await runKsefLifecycleReconcile(ctx);

    expect(sentIds()).toEqual([ID1]);
    expect(report).toMatchObject({ i5Reconciled: 1, i5Other: 100, errors: 0 });
  });

  it('I5: 100 faktur po limicie prób (i5NeedsOperator) nie zajmuje paczki', async () => {
    for (let i = 1; i <= 100; i++) {
      m.violations.push(i5(uuidN(i)));
      m.tables.invoices.push(failedRow(uuidN(i), 'RESULT_UNCERTAIN'));
      for (const h of [26, 50, 74]) m.tables.audit_logs.push(autoReconcileAudit(uuidN(i), h));
    }
    m.violations.push(i5(ID1));
    m.tables.invoices.push(failedRow(ID1, 'RESULT_UNCERTAIN'));

    const report = await runKsefLifecycleReconcile(ctx);

    expect(sentIds()).toEqual([ID1]);
    expect(report).toMatchObject({ i5Reconciled: 1, i5NeedsOperator: 100, errors: 0 });
  });

  it('I5: 100 starych korekt bez danych (odmowa budowy zlecenia) nie zajmuje paczki', async () => {
    for (let i = 1; i <= 100; i++) {
      m.violations.push(i5(uuidN(i)));
      m.tables.invoices.push(failedRow(uuidN(i), 'RESULT_UNCERTAIN', { invoice_kind: 'correction' }));
    }
    m.violations.push(i5(ID1));
    m.tables.invoices.push(failedRow(ID1, 'RESULT_UNCERTAIN'));

    const report = await runKsefLifecycleReconcile(ctx);

    expect(sentIds()).toEqual([ID1]);
    expect(report).toMatchObject({ i5Reconciled: 1, skippedNoData: 100, errors: 0 });
  });

  it(`I5: paczka dalej ${100} uzgodnień — 50 i5Other + 200 do uzgodnienia → 100 pierwszych, dopełnione z drugiej strony`, async () => {
    for (let i = 1; i <= 250; i++) {
      m.violations.push(i5(uuidN(i)));
      m.tables.invoices.push(i <= 50
        ? failedRow(uuidN(i), 'RESULT_UNCERTAIN', { ksef_status: 'accepted', ksef_number: `K-${i}` })
        : failedRow(uuidN(i), 'RESULT_UNCERTAIN'));
    }

    const report = await runKsefLifecycleReconcile(ctx);

    expect(report).toMatchObject({ i5Reconciled: LIFECYCLE_BATCH, i5Other: 50, errors: 0 });
    expect(sentIds()).toEqual(Array.from({ length: LIFECYCLE_BATCH }, (_, i) => uuidN(51 + i)));
    // Strona 1: 50 do uzgodnienia, strona 2 dopełnia paczkę — trzecia nie jest czytana.
    expect(staleReads().map((r) => r.values.length)).toEqual([100, 100]);
  });

  it('bezpiecznik postępu: baza oddaje tę samą stronę mimo kursora — wyjątek zamiast pętli', async () => {
    m.orIgnored = true;
    m.tables.invoices = Array.from({ length: 150 }, (_, i) => noLines(uuidN(i + 1), 'INFRA'));

    await expect(runKsefLifecycleReconcile(ctx)).rejects.toThrow(/stronicowanie nie posuwa się naprzód/);
    // Druga strona (z kursorem) oddała to samo co pierwsza — stop od razu, nie po LIFECYCLE_SCAN_MAX_PAGES.
    expect(invoiceOrs()).toHaveLength(1);
  });

  it(`I5 bezpiecznik odczytu: ${LIFECYCLE_SCAN_MAX_PAGES} stron po 100 bez działania — koniec szukania, ostrzeżenie, scanCapped`, async () => {
    const other = LIFECYCLE_SCAN_MAX_PAGES * LIFECYCLE_BATCH;
    for (let i = 1; i <= other; i++) {
      m.violations.push(i5(uuidN(i)));
      m.tables.invoices.push(failedRow(uuidN(i), 'RESULT_UNCERTAIN', { ksef_status: 'accepted', ksef_number: `K-${i}` }));
    }
    m.violations.push(i5(ID1));
    m.tables.invoices.push(failedRow(ID1, 'RESULT_UNCERTAIN'));

    const report = await runKsefLifecycleReconcile(ctx);

    expect(m.send).not.toHaveBeenCalled();
    expect(report).toMatchObject({ i5Reconciled: 0, i5Other: other, scanCapped: 1, errors: 0 });
    expect(staleReads()).toHaveLength(LIFECYCLE_SCAN_MAX_PAGES);
    const capped = warns().filter(([message]) => /bezpiecznik odczytu/.test(message));
    expect(capped.map(([, extra]) => extra)).toEqual([
      expect.objectContaining({ invariant: 'I5', pages: LIFECYCLE_SCAN_MAX_PAGES, collected: 0 }),
    ]);
  });
});

describe('D-A4-1b-3 PR B: I5D — faktura czeka na decyzję klienta (00148)', () => {
  it('U20 strażnik: wiersz I5D (failed KSEF_DUPLICATE_RECONCILE, znacznik sprzed 3 dni) — cron go nie uzgadnia i nie liczy w I5', async () => {
    // Od 00148 faktura gotowa do decyzji klienta wypada z I5 (blokada decyzji = NULL)
    // i trafia do I5D; cron bierze tylko invariant === 'I5' (ksef-lifecycle-reconcile.ts:309).
    m.violations = [{
      invariant: 'I5D', invoice_id: ID1, tenant_id: TENANT,
      detail: {
        original_ksef_number: '1234567890-20261001-0100A0B0C0D0-1A', reason: 'no-own-file', env: 'test',
        checked_at: '2026-09-30T10:00:00.000Z', attempted_at: '2026-09-30T08:00:00.000Z', last_attempt_at: '2026-09-30T08:05:00.000Z',
      },
    }];
    m.tables.invoices = [failedRow(ID1, 'KSEF_DUPLICATE_RECONCILE', { updated_at: '2026-09-30T08:05:00.000Z' })];

    const report = await runKsefLifecycleReconcile(ctx);

    expect(report).toMatchObject({ i5Reconciled: 0, i5Deferred: 0, i5NeedsOperator: 0, i5Other: 0, requeued: 0, errors: 0 });
    expect(m.send).not.toHaveBeenCalled();
    expect(sqlCalls.filter(([sql]) => /requeue_ksef_send/.test(sql))).toEqual([]);
    expect(m.updates).toEqual([]);
    // Faktury z I5D nawet nie czytamy jako kandydatów I5.
    expect(m.ins.filter((i) => i.table === 'invoices' && i.column === 'id' && i.values.includes(ID1))).toEqual([]);
  });
});

/**
 * A5, luka #2 (przekazanie 13.10.2026): decyzje automatu, które nie zmieniają
 * wiersza faktury (I5 po trzech próbach, I5 poza failed/rejected, odmowa
 * budowy zlecenia), nie zostawiają śladu w bazie — jedynym tropem jest log
 * workera i Sentry, więc oba muszą nazwać fakturę. ENQUEUE_LOST
 * i TRANSIENT_EXHAUSTED zostawiają kod na wierszu (audyt tych przejść: luka #1).
 * Zbiorczy Sentry wysyłają nadal tylko exhausted / i1Lost / i5NeedsOperator:
 * stany trwałe bez deduplikacji zjadałyby kwotę Sentry (96 zdarzeń na dobę).
 */
describe('A5: identyfikatory faktur w logu i Sentry', () => {
  const SUMMARY = 'Cykl życia faktury: faktury czekają na operatora';
  type LogCall = [string, Record<string, unknown>?];
  const calls = (level: 'warn' | 'info') => (ctx.logger[level] as ReturnType<typeof vi.fn>).mock.calls as LogCall[];
  /** Kontekst wpisu w logu dla faktury `invoiceId` (pierwszy pasujący). */
  const logFor = (level: 'warn' | 'info', invoiceId: string) => calls(level).find(([, extra]) => extra?.invoiceId === invoiceId);
  const summaryExtra = (): Record<string, unknown> | undefined => {
    const call = m.captureMessage.mock.calls.find(([message]) => message === SUMMARY);
    return (call?.[1] as { extra?: Record<string, unknown> } | undefined)?.extra;
  };
  /** Zwykła faktura bez tablicy pozycji — builder zwraca `incomplete`. */
  const withoutLines = (id: string, code: string, extra: Row = {}) =>
    failedRow(id, code, { fa3_data: { internalNumber: `FV/${id.slice(0, 2)}`, type: 'VAT', seller: { nip: '5260001246' } }, ...extra });
  /** Brak NIP-u i w firmie, i w `fa3_data.seller` — builder zwraca `no-nip`. */
  const withoutNip = (id: string, code: string) => failedRow(id, code, {
    tenants: { nip: null },
    fa3_data: { internalNumber: `FV/${id.slice(0, 2)}`, type: 'VAT', lines: [{ ordinal: 1 }], seller: {} },
  });
  /** Faktura I5 po limicie prób z crona (wyzwala zbiorczy Sentry). */
  const needsOperator = (id: string) => {
    m.violations.push(i5(id));
    m.tables.invoices.push(failedRow(id, 'RESULT_UNCERTAIN'));
    for (const h of [26, 50, 74]) m.tables.audit_logs.push(autoReconcileAudit(id, h));
  };

  it('I5 po trzech próbach w tygodniu: ostrzeżenie z invoiceId, liczbą i datą OSTATNIEJ próby; Sentry z identyfikatorem', async () => {
    m.violations = [i5(ID1)];
    m.tables.invoices = [failedRow(ID1, 'RESULT_UNCERTAIN')];
    // Kolejność niemonotoniczna: baza bez ORDER BY nie gwarantuje żadnej, a ostatnia próba to maksimum
    // (tu w środku tablicy). Cztery próby — liczba w logu to długość listy, nie limit.
    for (const h of [50, 74, 26, 98]) m.tables.audit_logs.push(autoReconcileAudit(ID1, h));

    const report = await runKsefLifecycleReconcile(ctx);

    expect(report.i5NeedsOperator).toBe(1);
    const [message, extra] = logFor('warn', ID1) ?? [];
    expect(message).toMatch(/I5/);
    expect(extra).toMatchObject({
      invoiceId: ID1, invariant: 'I5', attempts: 4, lastAttemptAt: new Date(NOW.getTime() - 26 * 3_600_000).toISOString(),
    });
    expect(summaryExtra()).toMatchObject({ i5NeedsOperator: 1, i5NeedsOperatorIds: [ID1] });
  });

  it('I5 przy fakturze poza failed/rejected: ostrzeżenie z invoiceId i stanem dla każdej', async () => {
    m.violations = [i5(ID1), i5(ID2)];
    m.tables.invoices = [
      failedRow(ID1, 'RESULT_UNCERTAIN', { ksef_status: 'accepted', ksef_number: 'K-1' }),
      failedRow(ID2, 'RESULT_UNCERTAIN', { ksef_status: 'queued' }),
    ];

    const report = await runKsefLifecycleReconcile(ctx);

    expect(report.i5Other).toBe(2);
    expect(logFor('warn', ID1)?.[0]).toMatch(/I5/);
    expect(logFor('warn', ID1)?.[1]).toMatchObject({ invoiceId: ID1, invariant: 'I5', status: 'accepted' });
    expect(logFor('warn', ID2)?.[1]).toMatchObject({ invoiceId: ID2, invariant: 'I5', status: 'queued' });
  });

  it('odmowa „brak NIP-u” (ani w firmie, ani w fa3_data): licznik skippedNoNip, ostrzeżenie z invoiceId i inwariantem', async () => {
    m.tables.invoices = [withoutNip(ID1, 'INFRA')];

    const report = await runKsefLifecycleReconcile(ctx);

    expect(report).toMatchObject({ requeued: 0, skippedNoNip: 1, skippedNoData: 0, errors: 0 });
    expect(m.send).not.toHaveBeenCalled();
    expect(logFor('warn', ID1)?.[1]).toMatchObject({ invoiceId: ID1, reason: 'no-nip', invariant: 'I6' });
  });

  it('brak danych do ponowienia z każdej ścieżki: inwariant w logu (I6, I7, I5)', async () => {
    m.violations = [i5(ID3)];
    m.tables.invoices = [
      withoutLines(ID1, 'INFRA'),
      withoutLines(ID2, 'KSEF_PAUSED'),
      // Stara korekta bez special_data z wpisem I5 → missing-special-data (log info).
      failedRow(ID3, 'RESULT_UNCERTAIN', { invoice_kind: 'correction' }),
    ];

    const report = await runKsefLifecycleReconcile(ctx);

    expect(report).toMatchObject({ skippedNoData: 3, requeued: 0, resumedAfterPause: 0, i5Reconciled: 0, errors: 0 });
    expect(logFor('warn', ID1)?.[1]).toMatchObject({ invoiceId: ID1, reason: 'incomplete', invariant: 'I6' });
    expect(logFor('warn', ID2)?.[1]).toMatchObject({ invoiceId: ID2, reason: 'incomplete', invariant: 'I7' });
    expect(logFor('info', ID3)?.[1]).toMatchObject({ invoiceId: ID3, reason: 'missing-special-data', invariant: 'I5' });
  });

  it('strażnik: stany bez wyjścia automatu i stany oczekiwane same nie wysyłają zbiorczego Sentry (brak deduplikacji)', async () => {
    m.violations = [i5(ID1), i5(ID4)];
    m.tables.invoices = [
      failedRow(ID1, 'RESULT_UNCERTAIN', { ksef_status: 'accepted', ksef_number: 'K-1' }), // i5Other
      withoutLines(ID2, 'INFRA'), // skippedNoData
      withoutNip(ID3, 'INFRA'), // skippedNoNip
      failedRow(ID4, 'RESULT_UNCERTAIN'), // i5Deferred
    ];
    m.tables.audit_logs.push(autoReconcileAudit(ID4, 5));

    const report = await runKsefLifecycleReconcile(ctx);

    expect(report).toMatchObject({ i5Other: 1, skippedNoData: 1, skippedNoNip: 1, i5Deferred: 1, errors: 0 });
    expect(m.captureMessage).not.toHaveBeenCalled();
  });

  it('strażnik: rodzaj wstrzymany (KOR na PROD w I5) — bez zbiorczego Sentry; inwariant w logu', async () => {
    m.env.mockReturnValue('production');
    m.violations = [i5(ID1)];
    m.tables.invoices = [korRow(ID1, 'RESULT_UNCERTAIN', TODAY)];

    const report = await runKsefLifecycleReconcile(ctx);

    expect(report).toMatchObject({ skippedHeld: 1, i5Reconciled: 0, errors: 0 });
    expect(m.captureMessage).not.toHaveBeenCalled();
    expect(logFor('info', ID1)?.[1]).toMatchObject({ invoiceId: ID1, reason: 'kind-held', invariant: 'I5' });
  });

  it('gdy zbiorczy Sentry idzie (I5 po limicie), niesie identyfikatory każdego niepustego rodzaju', async () => {
    needsOperator(ID1);
    m.violations.push(i5(ID2));
    m.tables.invoices.push(
      failedRow(ID2, 'RESULT_UNCERTAIN', { ksef_status: 'accepted', ksef_number: 'K-2' }),
      withoutLines(ID3, 'INFRA'),
      withoutNip(ID4, 'KSEF_PAUSED'),
    );

    const report = await runKsefLifecycleReconcile(ctx);

    expect(report).toMatchObject({ i5NeedsOperator: 1, i5Other: 1, skippedNoData: 1, skippedNoNip: 1, errors: 0 });
    const extra = summaryExtra();
    expect(extra).toMatchObject({
      i5NeedsOperator: 1, i5NeedsOperatorIds: [ID1],
      i5Other: 1, i5OtherIds: [ID2],
      skippedNoData: 1, skippedNoDataIds: [ID3],
      skippedNoNip: 1, skippedNoNipIds: [ID4],
    });
    // Puste rodzaje bez list.
    expect(Object.keys(extra ?? {}).filter((key) => key.endsWith('Ids')).sort())
      .toEqual(['i5NeedsOperatorIds', 'i5OtherIds', 'skippedNoDataIds', 'skippedNoNipIds']);
  });

  it('zdarzenie niesie też identyfikatory odmów ze ścieżki I5 i stanów oczekiwanych (brak danych, inna korekta w toku)', async () => {
    needsOperator(ID1);
    m.violations.push(i5(ID2), i5(ID3));
    m.tables.invoices.push(
      failedRow(ID2, 'RESULT_UNCERTAIN', { invoice_kind: 'correction' }), // stara KOR bez special_data
      korRow(ID3, 'KSEF_REJECTED', '2026-10-01', { ksef_status: 'rejected' }),
    );
    m.send.mockRejectedValueOnce(Object.assign(new Error(OPEN_CORRECTION_CONFLICT), { code: '23505' }));

    const report = await runKsefLifecycleReconcile(ctx);

    expect(report).toMatchObject({ i5NeedsOperator: 1, skippedNoData: 1, skippedConflict: 1, errors: 0 });
    expect(summaryExtra()).toMatchObject({ skippedNoDataIds: [ID2], skippedConflictIds: [ID3] });
  });

  it('zdarzenie niesie identyfikatory rodzaju wstrzymanego (KOR na PROD w I5)', async () => {
    m.env.mockReturnValue('production');
    needsOperator(ID1);
    m.violations.push(i5(ID2));
    m.tables.invoices.push(korRow(ID2, 'RESULT_UNCERTAIN', TODAY));

    const report = await runKsefLifecycleReconcile(ctx);

    expect(report).toMatchObject({ i5NeedsOperator: 1, skippedHeld: 1 });
    expect(summaryExtra()).toMatchObject({ skippedHeld: 1, skippedHeldIds: [ID2] });
  });

  it('zdarzenie niesie identyfikatory odmowy „data minęła” (północ między odczytem a zleceniem)', async () => {
    vi.setSystemTime(new Date('2026-10-03T21:59:59.000Z')); // 23:59:59 w Polsce
    needsOperator(ID1);
    m.tables.invoices.push(zalRow(ID2, 'KSEF_UNAVAILABLE', '2026-10-03'));
    m.afterQuery = ({ filters }) => {
      if (filters.some(([column]) => column === 'issue_date')) vi.setSystemTime(new Date('2026-10-03T22:00:01.000Z'));
    };

    const report = await runKsefLifecycleReconcile(ctx);

    expect(report).toMatchObject({ i5NeedsOperator: 1, skippedIssueDate: 1 });
    expect(summaryExtra()).toMatchObject({ skippedIssueDate: 1, skippedIssueDateIds: [ID2] });
  });

  it('najwyżej 20 identyfikatorów NA RODZAJ w Sentry; liczniki w raporcie i w Sentry pełne; log ma każdą fakturę', async () => {
    needsOperator(ID1);
    for (let i = 1; i <= 25; i++) {
      m.tables.invoices.push(withoutLines(uuidN(i), 'INFRA'));
      m.violations.push(i5(uuidN(100 + i)));
      m.tables.invoices.push(failedRow(uuidN(100 + i), 'RESULT_UNCERTAIN', { ksef_status: 'accepted', ksef_number: `K-${i}` }));
    }

    const report = await runKsefLifecycleReconcile(ctx);

    expect(report).toMatchObject({ skippedNoData: 25, i5Other: 25, i5NeedsOperator: 1 });
    const extra = summaryExtra();
    expect(extra).toMatchObject({ skippedNoData: 25, i5Other: 25 });
    expect(extra?.skippedNoDataIds).toHaveLength(20);
    expect(extra?.i5OtherIds).toHaveLength(20);
    expect(extra?.i5NeedsOperatorIds).toEqual([ID1]);
    // Limit dotyczy tylko Sentry.
    expect(calls('warn').filter(([, e]) => e?.reason === 'incomplete')).toHaveLength(25);
    expect(calls('warn').filter(([, e]) => typeof e?.status === 'string')).toHaveLength(25);
  });

  it('zbiorczy Sentry przy samym ENQUEUE_LOST: liczniki bez pustych list identyfikatorów', async () => {
    m.violations = [{ invariant: 'I1', invoice_id: ID1, tenant_id: TENANT }];
    m.tables.invoices = [{ id: ID1, tenant_id: TENANT, ksef_status: 'queued' }];
    m.release.mockResolvedValue(false);

    await runKsefLifecycleReconcile(ctx);

    const extra = summaryExtra();
    expect(extra).toMatchObject({ i1Lost: 1 });
    expect(Object.keys(extra ?? {}).filter((key) => key.endsWith('Ids'))).toEqual([]);
  });

  it('linia „przebieg zakończony” ma liczniki (z skippedNoNip), bez list identyfikatorów — skrypt kontroli wypisuje ją w całości', async () => {
    m.violations = [i5(ID1)];
    m.tables.invoices = [failedRow(ID1, 'RESULT_UNCERTAIN', { ksef_status: 'accepted' })];

    const report = await runKsefLifecycleReconcile(ctx);

    const done = calls('info').find(([message]) => message === 'Cykl życia: przebieg zakończony');
    expect(done?.[1]).toEqual({ ...report });
    expect(done?.[1]).toHaveProperty('skippedNoNip', 0);
    expect(Object.keys(done?.[1] ?? {}).filter((key) => key.endsWith('Ids'))).toEqual([]);
  });
});

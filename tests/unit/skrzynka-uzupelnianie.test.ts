import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';

/**
 * K2 z rewizji 03.10.2026: cron `cron.inbox-backfill` co 15 minut szuka
 * faktur ze skrzynki, których kategoryzacja się nie domknęła
 * (`fa3_data._pendingFullFetch = true`, starsze niż 15 min), i emituje dla
 * nich zdarzenie `inbox/invoice-received` jeszcze raz. Obejmuje to także
 * faktury odebrane przed PR #183 bez XML (W11). Każda emisja zwiększa
 * `_backfillAttempts`; po 6 próbach faktura trafia do operatora, a nie do
 * pętli.
 */

type Row = Record<string, unknown>;

const db = vi.hoisted(() => ({
  pending: [] as Row[],
  exhaustedCount: 0,
  updates: [] as Array<{ patch: Row; filters: Array<[string, unknown]> }>,
  filters: [] as Array<[string, string, unknown]>,
  sentry: vi.fn(),
  waitingSql: vi.fn(),
  /** NIP-y firm do sprawdzenia pauzy po 429 (L1a); pauzy tu nie ma — przypadki pauzy: ksef-pauza-429-skrzynka.test.ts. */
  tenants: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', nip: '1234567890' }] as Row[],
}));

vi.mock('@sentry/nextjs', () => ({ captureMessage: db.sentry, captureException: vi.fn() }));
vi.mock('@/lib/jobs/boss', () => ({
  startBoss: async () => ({ getDb: () => ({ executeSql: db.waitingSql }) }),
}));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const eqs: Array<[string, unknown]> = [];
      let patch: Row | null = null;
      let head = false;
      const q: Record<string, unknown> = {};
      Object.assign(q, {
        select: (_cols: string, opts?: { head?: boolean }) => { head = Boolean(opts?.head); return q; },
        eq: (column: string, value: unknown) => { eqs.push([column, value]); db.filters.push(['eq', column, value]); return q; },
        filter: (column: string, op: string, value: unknown) => { db.filters.push([op, column, value]); return q; },
        or: (expr: string) => { db.filters.push(['or', expr, null]); return q; },
        lt: (column: string, value: unknown) => { db.filters.push(['lt', column, value]); return q; },
        in: (column: string, values: unknown) => { db.filters.push(['in', column, values]); return q; },
        order: () => q,
        limit: () => q,
        update: (p: Row) => { patch = p; return q; },
        then: (ok: (v: unknown) => unknown, fail?: (e: unknown) => unknown) => {
          let result: unknown;
          if (table === 'tenants') {
            result = { data: db.tenants, error: null };
          } else if (patch) {
            db.updates.push({ patch, filters: eqs });
            result = { data: null, error: null };
          } else if (head) {
            result = { data: null, count: db.exhaustedCount, error: null };
          } else {
            result = { data: db.pending, error: null };
          }
          return Promise.resolve(result).then(ok, fail);
        },
      });
      return q;
    },
  }),
}));

import {
  INBOX_BACKFILL_MAX_ATTEMPTS,
  INBOX_BACKFILL_MIN_AGE_MS,
  runInboxBackfill,
} from '@/lib/jobs/runners/inbox-backfill';

type SendEventFn = (step: string, events: unknown, options?: unknown) => Promise<void>;

function context() {
  const sendEvent = vi.fn<SendEventFn>(async () => undefined);
  const ctx: JobContext = {
    attempt: 0,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    step: { run: async (_n, fn) => fn(), sleep: vi.fn(), sendEvent, scheduleAfter: vi.fn() },
  };
  return { ctx, sendEvent };
}

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function pendingRow(id: string, attempts?: number): Row {
  return {
    id,
    tenant_id: TENANT,
    created_at: '2026-09-25T10:00:00Z',
    fa3_data: {
      _source: 'inbox-metadata',
      _pendingFullFetch: true,
      ...(attempts === undefined ? {} : { _backfillAttempts: attempts }),
    },
  };
}

beforeEach(() => {
  vi.stubEnv('KSEF_ENV', 'test');
  db.pending = [];
  db.exhaustedCount = 0;
  db.updates = [];
  db.filters = [];
  db.sentry.mockClear();
  db.waitingSql.mockReset();
  db.waitingSql.mockResolvedValue({ rows: [] });
});
afterEach(() => vi.unstubAllEnvs());

describe('cron uzupełniający skrzynkę (K2, W11)', () => {
  it('emituje zdarzenie kategoryzacji z singletonKey i zwiększa licznik prób', async () => {
    db.pending = [pendingRow('inv-1'), pendingRow('inv-2', 2)];
    const { ctx, sendEvent } = context();

    await expect(runInboxBackfill(ctx)).resolves.toEqual({ scanned: 2, emitted: 2, paused: 0, exhausted: 0 });

    const events = sendEvent.mock.calls[0]![1] as Array<{ name: string; data: Row; singletonKey?: string }>;
    expect(events.map((e) => e.name)).toEqual(['inbox/invoice-received', 'inbox/invoice-received']);
    expect(events.map((e) => e.singletonKey)).toEqual(['inv-1', 'inv-2']);
    expect(events[0]!.data).toEqual({ invoiceId: 'inv-1', tenantId: TENANT, environment: 'test' });

    expect(db.updates.map((u) => (u.patch.fa3_data as Row)._backfillAttempts)).toEqual([1, 3]);
    expect((db.updates[0]!.patch.fa3_data as Row)._pendingFullFetch).toBe(true);
    expect(db.updates[0]!.filters).toEqual(expect.arrayContaining([['id', 'inv-1'], ['tenant_id', TENANT]]));
  });

  it('pyta tylko o faktury skrzynki tego środowiska, starsze niż 15 min, z otwartym znacznikiem i poniżej limitu prób', async () => {
    const before = Date.now();
    const { ctx } = context();
    await runInboxBackfill(ctx);

    expect(db.filters).toEqual(expect.arrayContaining([
      ['eq', 'direction', 'incoming'],
      ['eq', 'origin', 'ksef_inbox'],
      ['eq', 'ksef_status', 'accepted'],
      ['eq', 'ksef_environment', 'test'],
      ['eq', 'fa3_data->>_pendingFullFetch', 'true'],
    ]));
    const lt = db.filters.find(([op, column]) => op === 'lt' && column === 'created_at');
    expect(lt).toBeDefined();
    const cutoff = Date.parse(lt![2] as string);
    expect(before - cutoff).toBeGreaterThanOrEqual(INBOX_BACKFILL_MIN_AGE_MS - 1000);
    const attemptsFilter = db.filters.find(([op, expr]) => op === 'or' && String(expr).includes('_backfillAttempts'));
    expect(attemptsFilter).toBeDefined();
    expect(String(attemptsFilter![1])).toContain(`lt.${INBOX_BACKFILL_MAX_ATTEMPTS}`);
  });

  it('bez zaległości nic nie emituje', async () => {
    const { ctx, sendEvent } = context();
    await expect(runInboxBackfill(ctx)).resolves.toEqual({ scanned: 0, emitted: 0, paused: 0, exhausted: 0 });
    expect(sendEvent).not.toHaveBeenCalled();
  });

  // Sesja 17 planu skalowania: `singletonKey` na kolejce `standard` nie deduplikuje,
  // więc przy długiej kolejce cron dokładał zadanie co 15 min i w 90 min zużywał
  // wszystkie próby, choć pierwsze zadanie jeszcze nie ruszyło.
  it('pomija faktury, których zadanie jeszcze czeka: bez emisji i bez zużycia próby', async () => {
    db.pending = [pendingRow('inv-1'), pendingRow('inv-2'), pendingRow('inv-3', 1)];
    db.waitingSql.mockResolvedValue({ rows: [{ value: 'inv-2' }] });
    const { ctx, sendEvent } = context();

    await expect(runInboxBackfill(ctx)).resolves.toEqual({ scanned: 3, emitted: 2, paused: 0, exhausted: 0 });

    const events = sendEvent.mock.calls[0]![1] as Array<{ data: Row }>;
    expect(events.map((e) => e.data.invoiceId)).toEqual(['inv-1', 'inv-3']);
    expect(db.updates.map((u) => u.filters.find(([c]) => c === 'id')?.[1])).toEqual(['inv-1', 'inv-3']);
    const [sql, args] = db.waitingSql.mock.calls[0]!;
    expect(sql).toContain('pgboss.job');
    expect(args).toEqual(['inbox.invoice-received', ['inv-1', 'inv-2', 'inv-3']]);
  });

  it('wszystkie czekają: bez emisji', async () => {
    db.pending = [pendingRow('inv-1')];
    db.waitingSql.mockResolvedValue({ rows: [{ value: 'inv-1' }] });
    const { ctx, sendEvent } = context();
    await expect(runInboxBackfill(ctx)).resolves.toEqual({ scanned: 1, emitted: 0, paused: 0, exhausted: 0 });
    expect(sendEvent).not.toHaveBeenCalled();
    expect(db.updates).toEqual([]);
  });

  it('błąd odczytu kolejki: emituje jak dawniej (dubel kończy się jednym odczytem)', async () => {
    db.pending = [pendingRow('inv-1')];
    db.waitingSql.mockRejectedValue(new Error('kolejka niedostępna'));
    const { ctx, sendEvent } = context();
    await expect(runInboxBackfill(ctx)).resolves.toEqual({ scanned: 1, emitted: 1, paused: 0, exhausted: 0 });
    expect(sendEvent).toHaveBeenCalledOnce();
    expect(ctx.logger.warn).toHaveBeenCalled();
  });

  it('faktury po wyczerpaniu prób zgłasza operatorowi, zamiast kręcić w pętli', async () => {
    db.exhaustedCount = 3;
    const { ctx } = context();

    await expect(runInboxBackfill(ctx)).resolves.toEqual({ scanned: 0, emitted: 0, paused: 0, exhausted: 3 });
    expect(db.sentry).toHaveBeenCalledOnce();
    expect(ctx.logger.error).toHaveBeenCalled();
  });
});

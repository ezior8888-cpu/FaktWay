import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';

/**
 * Takt rozsyłki skrzynki (`cron.inbox-polling`). Dawniej: co 15 min wszystkie
 * firmy z certyfikatem, jedno zadanie na firmę, bez filtra i bez deduplikacji
 * (`inbox-polling.ts:144`). Teraz: co minutę należne firmy do limitu slotów,
 * wybór i zapis zleceń w jednej transakcji, paczkami, reszta w następnym takcie.
 * Prawdziwe zachowanie wyboru (kolejność, dzierżawa, żywe firmy) sprawdza
 * `tests/rls-skrzynka-harmonogram.test.ts` na bazie.
 */

const st = vi.hoisted(() => ({
  backlog: {
    due: 0,
    in_flight: 0,
    oldest_due_at: null as string | null,
    polled_recent: 0,
    rate_limited_recent: 0,
  },
  backlogError: null as { message: string } | null,
  rpcCalls: [] as Array<{ name: string; args: Record<string, unknown> }>,
  firms: [] as Array<{ tenant_id: string; nip: string; due_at: string }>,
  claimArgs: [] as unknown[][],
  inserts: [] as Array<{ queue: string; jobs: Array<Record<string, unknown>>; db: unknown }>,
  insertError: null as Error | null,
  transactions: { started: 0, committed: 0, rolledBack: 0 },
  committedClaims: 0,
}));

const tx = { executeSql: vi.fn() };

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      st.rpcCalls.push({ name, args });
      if (name === 'ksef_inbox_poll_backlog') {
        return st.backlogError
          ? { data: null, error: st.backlogError }
          : { data: [st.backlog], error: null };
      }
      return { data: null, error: { message: `nieznane RPC ${name}` } };
    },
  }),
}));

vi.mock('@/lib/jobs/boss', () => ({
  startBoss: async () => ({
    getDb: () => ({
      executeSql: vi.fn(),
      withTransaction: async (fn: (db: unknown) => Promise<unknown>) => {
        st.transactions.started += 1;
        try {
          const out = await fn(tx);
          st.transactions.committed += 1;
          return out;
        } catch (e) {
          st.transactions.rolledBack += 1;
          throw e;
        }
      },
    }),
    insert: vi.fn(async (queue: string, jobs: Array<Record<string, unknown>>, options: { db: unknown }) => {
      if (st.insertError) throw st.insertError;
      st.inserts.push({ queue, jobs, db: options.db });
      return null;
    }),
  }),
}));

import { runInboxPolling } from '@/lib/jobs/runners/inbox-polling';
import { INBOX_LEASE_SECONDS } from '@/lib/ksef/inbox-schedule';

const NOW = new Date('2026-11-02T11:00:00Z');
const logged: string[] = [];

function context(): JobContext {
  return {
    attempt: 0,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    step: { run: async (_n, fn) => fn(), sleep: vi.fn(), sendEvent: vi.fn(), scheduleAfter: vi.fn() },
  };
}

function firm(i: number) {
  return {
    tenant_id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    nip: String(1000000000 + i),
    due_at: new Date(NOW.getTime() - (1000 - i) * 1000).toISOString(),
  };
}

function dueFirms(n: number) {
  return Array.from({ length: n }, (_, i) => firm(i));
}

/** Baza w RPC oddaje tylko firmy z pulą `st.firms`; zajęte znikają jak przy dzierżawie. */
tx.executeSql.mockImplementation(async (sql: string, args: unknown[]) => {
  if (!sql.includes('claim_ksef_inbox_polls')) throw new Error(`nieznane SQL: ${sql}`);
  st.claimArgs.push(args);
  const limit = args[1] as number;
  return { rows: st.firms.splice(0, limit) };
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.stubEnv('KSEF_ENV', 'test');
  // Liczby w tym pliku są dla 8 slotów, domyślną wartość pilnuje `skrzynka-harmonogram.test.ts`.
  vi.stubEnv('KSEF_INBOX_POLL_SLOTS', '8');
  st.backlog = { due: 0, in_flight: 0, oldest_due_at: null, polled_recent: 0, rate_limited_recent: 0 };
  st.backlogError = null;
  st.rpcCalls = [];
  st.firms = [];
  st.claimArgs = [];
  st.inserts = [];
  st.insertError = null;
  st.transactions = { started: 0, committed: 0, rolledBack: 0 };
  logged.length = 0;
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => { logged.push(String(line)); });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  tx.executeSql.mockImplementation(async (sql: string, args: unknown[]) => {
    if (!sql.includes('claim_ksef_inbox_polls')) throw new Error(`nieznane SQL: ${sql}`);
    st.claimArgs.push(args);
    return { rows: st.firms.splice(0, args[1] as number) };
  });
});

describe('takt rozsyłki', () => {
  it('nic należnego: bez zapisu zleceń, jedna linia pomiaru', async () => {
    const result = await runInboxPolling(context());
    expect(result).toMatchObject({ polled: 0 });
    expect(st.inserts).toEqual([]);
    expect(logged).toHaveLength(1);
    expect(JSON.parse(logged[0]!)).toMatchObject({ msg: 'ksef.inbox.dispatch', due: 0, sent: 0, oldestLagSeconds: 0 });
  });

  it('każde zlecenie ma groupId = NIP, firmę, środowisko i termin (AUD-91)', async () => {
    st.backlog.due = 2;
    st.firms = dueFirms(2);
    const firms = [...st.firms];
    await runInboxPolling(context());

    expect(st.inserts).toHaveLength(1);
    const { queue, jobs, db } = st.inserts[0]!;
    expect(queue).toBe('inbox.poll.tenant');
    expect(db).toBe(tx);
    expect(jobs.map((j) => (j.group as { id: string }).id)).toEqual(firms.map((f) => f.nip));
    expect(jobs.map((j) => j.data)).toEqual(firms.map((f) => ({
      tenantId: f.tenant_id,
      nip: f.nip,
      environment: 'test',
      dueAt: f.due_at,
    })));
  });

  it('wybór i zapis zleceń idą w jednej transakcji, z limitem i dzierżawą z konfiguracji', async () => {
    st.backlog.due = 3;
    st.firms = dueFirms(3);
    await runInboxPolling(context());
    expect(st.transactions).toEqual({ started: 1, committed: 1, rolledBack: 0 });
    expect(st.claimArgs[0]).toEqual(['test', 200, INBOX_LEASE_SECONDS]);
  });

  it('błąd zapisu zleceń wycofuje wybór: firma zostaje należna, job pada', async () => {
    st.backlog.due = 3;
    st.firms = dueFirms(3);
    st.insertError = new Error('pg-boss nie przyjął paczki');
    await expect(runInboxPolling(context())).rejects.toThrow('pg-boss nie przyjął paczki');
    expect(st.transactions).toEqual({ started: 1, committed: 0, rolledBack: 1 });
  });

  it('limit ze slotów: przepełnienie przechodzi na następny takt, jak najstarsze pierwsze', async () => {
    st.backlog = { due: 1000, in_flight: 0, oldest_due_at: new Date(NOW.getTime() - 120_000).toISOString(), polled_recent: 0, rate_limited_recent: 0 };
    st.firms = dueFirms(1000);
    const result = await runInboxPolling(context());

    // 8 slotów × 30 zadań na minutę = 240; paczki po 200.
    expect(result).toMatchObject({ polled: 240 });
    expect(st.claimArgs.map((args) => args[1])).toEqual([200, 40]);
    expect(st.firms).toHaveLength(760);
    expect(st.inserts.flatMap((i) => i.jobs)).toHaveLength(240);
    const line = JSON.parse(logged[0]!);
    expect(line).toMatchObject({ due: 1000, sent: 240, inFlight: 0, limit: 240, slots: 8, oldestLagSeconds: 120, braking: false });
    expect(line.durationMs).toBeTypeOf('number');
  });

  it('zlecenia w toku zmniejszają limit: wolniejsze zadania nie rozdymają kolejki', async () => {
    st.backlog = { due: 500, in_flight: 200, oldest_due_at: null, polled_recent: 0, rate_limited_recent: 0 };
    st.firms = dueFirms(500);
    await expect(runInboxPolling(context())).resolves.toMatchObject({ polled: 40 });
    expect(st.claimArgs.map((args) => args[1])).toEqual([40]);
  });

  it('kolejka pełna: bez wyboru firm i bez transakcji', async () => {
    st.backlog = { due: 500, in_flight: 240, oldest_due_at: null, polled_recent: 0, rate_limited_recent: 0 };
    st.firms = dueFirms(500);
    await expect(runInboxPolling(context())).resolves.toMatchObject({ polled: 0 });
    expect(st.transactions.started).toBe(0);
  });

  it('druga rozsyłka przy czekających zadaniach nic nie dodaje (RPC pomija firmy z dzierżawą)', async () => {
    st.backlog.due = 2;
    st.firms = dueFirms(2);
    await runInboxPolling(context());
    expect(st.inserts).toHaveLength(1);
    // Te same firmy mają teraz dzierżawę: RPC ich nie oddaje.
    st.backlog = { due: 0, in_flight: 2, oldest_due_at: null, polled_recent: 0, rate_limited_recent: 0 };
    await runInboxPolling(context());
    expect(st.inserts).toHaveLength(1);
  });

  it('krótka odpowiedź RPC kończy pętlę paczek', async () => {
    st.backlog.due = 500;
    st.firms = dueFirms(150);
    await expect(runInboxPolling(context())).resolves.toMatchObject({ polled: 150 });
    expect(st.claimArgs).toHaveLength(1);
  });

  it('KSEF_INBOX_POLL_SLOTS zmienia limit', async () => {
    vi.stubEnv('KSEF_INBOX_POLL_SLOTS', '2');
    st.backlog.due = 500;
    st.firms = dueFirms(500);
    await expect(runInboxPolling(context())).resolves.toMatchObject({ polled: 60 });
  });

  it('hamulec 429: wiele firm z 429 zmniejsza limit i widać to w logu', async () => {
    st.backlog = { due: 500, in_flight: 0, oldest_due_at: null, polled_recent: 100, rate_limited_recent: 40 };
    st.firms = dueFirms(500);
    const ctx = context();
    await expect(runInboxPolling(ctx)).resolves.toMatchObject({ polled: 60 });
    expect(JSON.parse(logged[0]!)).toMatchObject({ braking: true, limit: 60 });
    expect(ctx.logger.warn).toHaveBeenCalled();
  });

  it('błąd odczytu liczb wywraca takt, zanim cokolwiek pójdzie do kolejki', async () => {
    st.backlogError = { message: 'baza niedostępna' };
    await expect(runInboxPolling(context())).rejects.toThrow('baza niedostępna');
    expect(st.transactions.started).toBe(0);
  });

  it('w logu nie ma NIP-ów ani identyfikatorów firm', async () => {
    st.backlog.due = 2;
    st.firms = dueFirms(2);
    const firms = [...st.firms];
    await runInboxPolling(context());
    for (const f of firms) {
      expect(logged.join('\n')).not.toContain(f.nip);
      expect(logged.join('\n')).not.toContain(f.tenant_id);
    }
  });
});

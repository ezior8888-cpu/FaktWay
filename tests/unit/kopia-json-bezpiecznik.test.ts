import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { utworzAtrape, uuidNr, type Wiersz } from '../helpers/kopia-json-atrapa';

/**
 * Plan skalowania 3000, sesja 12 (JOB-02, CPU-03): nocna kopia JSON trzymała
 * całą bazę w pamięci workera, potem robiła z niej jeden napis i ściskała go
 * synchronicznie. Przy kilku tysiącach firm to koniec pamięci (albo limit
 * długości napisu w V8), czyli wywrócony worker, a po nim do 4 ponowień,
 * każde tak samo ciężkie.
 *
 * Teraz kopia liczy rozmiar JSON-a w trakcie i po przekroczeniu progu kończy
 * się kontrolowanie: jeden alarm „kopia niepełna”, wpis w `backup_log`, bez
 * wgrywania połowy kopii, bez ponowień. Próg w teście jest mały (64 KiB),
 * żeby atrapa nie musiała mieć setek megabajtów.
 *
 * Job idzie przez prawdziwy wrapper workera (`wrapHandler`) z tą samą
 * definicją co w `lib/jobs/handlers/package-a.ts` (`cronJob`, 4 ponowienia).
 */

const { PROG_TESTOWY } = vi.hoisted(() => ({ PROG_TESTOWY: 64 * 1024 }));

const state = vi.hoisted(() => ({
  atrapa: null as null | { admin: unknown; odczyty: Array<{ tabela: string; wiersze: number }> },
  cache: new Map<string, unknown>(),
  kolejnosc: [] as string[],
}));

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  start: vi.fn(),
  sendSlackAlert: vi.fn(),
  uploadSnapshot: vi.fn(),
  logBackupStart: vi.fn(),
  logBackupSuccess: vi.fn(),
  logBackupFailure: vi.fn(),
  logBackupKey: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock('pg-boss', () => ({
  PgBoss: class {
    start = mocks.start;
    send = mocks.send;
    createQueue = vi.fn();
    updateQueue = vi.fn();
    on = vi.fn();
  },
}));
vi.mock('@/lib/jobs/config', () => ({ getJobsDatabaseUrl: () => 'postgres://fixture', getJobsSchema: () => 'pgboss' }));
vi.mock('@/lib/jobs/run-log', () => ({ recordJobRun: vi.fn(async () => undefined) }));
vi.mock('@/lib/jobs/sentry', () => ({ reportExhaustedJob: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({ captureException: mocks.captureException, addBreadcrumb: vi.fn() }));
vi.mock('@/lib/alerts/slack', () => ({ sendSlackAlert: mocks.sendSlackAlert, alertCritical: vi.fn() }));
vi.mock('@/lib/cache', () => ({
  cacheGet: async (key: string) => state.cache.get(key) ?? null,
  cacheSet: async (key: string, value: unknown) => {
    state.cache.set(key, value);
    return true;
  },
}));
vi.mock('@/lib/supabase/server', () => ({ createAdminClient: () => state.atrapa!.admin }));
vi.mock('@/lib/backup/backup-log', () => ({
  logBackupStart: mocks.logBackupStart,
  logBackupSuccess: mocks.logBackupSuccess,
  logBackupFailure: mocks.logBackupFailure,
  logBackupKey: mocks.logBackupKey,
}));
vi.mock('@/lib/backup/r2-backup-client', () => ({
  buildSnapshotKey: (now: Date) => {
    const relative = `db/${now.toISOString().slice(0, 10).replace(/-/g, '/')}-010000.json.gz`;
    return { full: `backups/${relative}`, relative };
  },
  uploadSnapshot: mocks.uploadSnapshot,
}));
vi.mock('@/lib/backup/snapshot-tables', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  MAX_SNAPSHOT_JSON_BYTES: PROG_TESTOWY,
}));

import { wrapHandler } from '@/lib/jobs/run-job';
import { runDailyDbSnapshot } from '@/lib/jobs/runners/daily-db-snapshot';

import type { JobContext } from '@/lib/jobs/registry';

/** Jak `cronJob('cron.daily-db-snapshot', runDailyDbSnapshot)` w package-a. */
const definicja = {
  queue: 'cron.daily-db-snapshot',
  maxRetries: 4,
  handler: (_dane: unknown, ctx: JobContext) => runDailyDbSnapshot(ctx),
};

function wiersze(n: number, prefiks: string, pola: Record<string, unknown>): Wiersz[] {
  return Array.from({ length: n }, (_, i) => ({ id: uuidNr(i + 1, prefiks), nr: i + 1, ...pola }));
}

/** ~26 KB kontrahentów, ~300 KB faktur, potem tabela, do której kopia nie powinna dojść. */
function duzaBaza(): Record<string, Wiersz[]> {
  return {
    contractors: wiersze(200, '11111111', { name: 'Kontrahent testowy', nip: '1234567890', city: 'Warszawa' }),
    invoices: wiersze(2000, '22222222', { number: 'FV/1/2026', gross: 123.45, note: 'x'.repeat(60) }),
    payments: wiersze(50, '33333333', { amount: 10 }),
  };
}

function malaBaza(): Record<string, Wiersz[]> {
  return {
    contractors: wiersze(20, '11111111', { name: 'Kontrahent testowy' }),
    invoices: wiersze(20, '22222222', { number: 'FV/1/2026' }),
    payments: wiersze(5, '33333333', { amount: 10 }),
  };
}

let numerJoba = 0;
async function nocnaKopia(tabele: Record<string, Wiersz[]>) {
  state.atrapa = utworzAtrape({ tabele });
  numerJoba += 1;
  const job = {
    id: `job-${numerJoba}-0000-0000`,
    name: definicja.queue,
    data: {},
    groupId: null,
    expireInSeconds: 14_400,
    heartbeatSeconds: 120,
    signal: new AbortController().signal,
  };
  return wrapHandler(definicja as never)([job] as never);
}

const pilne = () =>
  mocks.sendSlackAlert.mock.calls
    .map(([m]) => m as { channel: string; text: string })
    .filter((m) => m.channel === 'urgent');

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-11T01:00:00Z'));
  numerJoba = 0;
  state.cache.clear();
  state.kolejnosc = [];
  mocks.start.mockResolvedValue(undefined);
  mocks.send.mockResolvedValue('retry-job');
  mocks.sendSlackAlert.mockResolvedValue(true);
  mocks.logBackupStart.mockImplementation(async () => `log-${numerJoba}`);
  mocks.logBackupKey.mockImplementation(async () => {
    state.kolejnosc.push('klucz');
  });
  mocks.uploadSnapshot.mockImplementation(async () => {
    state.kolejnosc.push('wgranie');
  });
  mocks.logBackupSuccess.mockImplementation(async () => {
    state.kolejnosc.push('sukces');
  });
  mocks.logBackupFailure.mockResolvedValue(undefined);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
});

describe('bezpiecznik rozmiaru nocnej kopii JSON', () => {
  it('kopia ponad progiem: jeden alarm „kopia niepełna”, worker kończy job bez ponowień i bez wgrywania', async () => {
    const wyniki = await nocnaKopia(duzaBaza());

    expect(wyniki).toEqual([{ id: 'job-1-0000-0000', status: 'completed' }]);
    expect(mocks.send).not.toHaveBeenCalled(); // wrapper nie planuje ponowienia

    const alarmy = pilne();
    expect(alarmy).toHaveLength(1);
    expect(alarmy[0]!.text).toMatch(/niepełna/i);
    // Fail-closed z wyjściem: alarm mówi, co zrobić, i wskazuje runbook.
    expect(alarmy[0]!.text).toContain('docs/runbooks/backup-restore.md');

    expect(mocks.uploadSnapshot).not.toHaveBeenCalled();
    expect(mocks.logBackupSuccess).not.toHaveBeenCalled();
    expect(mocks.logBackupFailure).toHaveBeenCalledTimes(1);
    expect(mocks.logBackupFailure).toHaveBeenCalledWith('log-1', expect.stringContaining('kopia_niepelna'), expect.any(Number));
  });

  it('kopia przestaje czytać zaraz po progu: pamięć workera rośnie najwyżej o próg, nie o całą bazę', async () => {
    await nocnaKopia(duzaBaza());
    const odczyty = state.atrapa!.odczyty;
    // Faktury: próg pada w pierwszej stronie, kolejnych stron już nie ma.
    expect(odczyty.filter((o) => o.tabela === 'invoices')).toHaveLength(1);
    expect(odczyty.some((o) => o.tabela === 'payments')).toBe(false);
  });

  it('ponowne doręczenie joba tej samej nocy (pg-boss po restarcie workera) nie wysyła drugiego alarmu', async () => {
    await nocnaKopia(duzaBaza());
    await nocnaKopia(duzaBaza());
    expect(pilne()).toHaveLength(1);
    // Każdy przebieg ma swój wpis w backup_log.
    expect(mocks.logBackupFailure).toHaveBeenCalledTimes(2);

    // Następna noc, problem dalej jest: nowy alarm.
    vi.setSystemTime(new Date('2026-11-12T01:00:00Z'));
    await nocnaKopia(duzaBaza());
    expect(pilne()).toHaveLength(2);
  });

  it('alarm niedostarczony (Slack nie potwierdził) nie blokuje następnej próby', async () => {
    mocks.sendSlackAlert.mockResolvedValueOnce(false);
    await nocnaKopia(duzaBaza());
    await nocnaKopia(duzaBaza());
    expect(pilne()).toHaveLength(2);
    await nocnaKopia(duzaBaza());
    expect(pilne()).toHaveLength(2);
  });

  it('kopia pod progiem: klucz kopii trafia do backup_log przed wgraniem pliku, potem sukces, bez alarmu', async () => {
    const wyniki = await nocnaKopia(malaBaza());
    expect(wyniki).toEqual([{ id: 'job-1-0000-0000', status: 'completed' }]);
    // Plik bez wpisu z kluczem byłby sierotą, której sprzątanie kopii nigdy nie usunie.
    expect(state.kolejnosc).toEqual(['klucz', 'wgranie', 'sukces']);
    expect(mocks.logBackupKey).toHaveBeenCalledWith('log-1', expect.stringMatching(/^db\/2026\/11\/11-/));
    expect(pilne()).toHaveLength(0);
    expect(mocks.logBackupFailure).not.toHaveBeenCalled();
  });

  it('błąd odczytu tabeli dalej idzie starą drogą: wpis „failed”, alarm o awarii i ponowienie', async () => {
    // Tabela jest na liście, ale jej odczyt pada (atrapa: „relation does not exist”).
    const wyniki = await nocnaKopia({ ...malaBaza(), invoices: undefined as unknown as Wiersz[] });
    expect(wyniki).toEqual([{ id: 'job-1-0000-0000', status: 'completed' }]);
    expect(mocks.send).toHaveBeenCalledTimes(1); // ponowienie zaplanowane
    expect(mocks.uploadSnapshot).not.toHaveBeenCalled();
    expect(pilne()).toHaveLength(1);
    expect(pilne()[0]!.text).toContain('FAILED');
  });
});

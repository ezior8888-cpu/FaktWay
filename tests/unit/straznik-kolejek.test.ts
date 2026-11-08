import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// AUD-34: zewnętrzny strażnik (ping co minutę do Healthchecks) potwierdzał
// tylko, że worker żyje i baza odpowiada. Nic nie sprawdzało zaległości
// kolejek ani tego, czy crony się uruchamiają. Teraz heartbeat milczy także
// przy zaległych zadaniach, zadaniach porzuconych przez pg-boss i cronach,
// które przestały się tworzyć — brak pinga = alarm u strażnika.

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: () => ({ select: () => ({ limit: () => Promise.resolve({ error: null }) }) }),
  }),
}));

import { runOpsHeartbeat } from '@/lib/jobs/heartbeat';
import { cronMaxGapMs, evaluateJobsHealth, type QueueHealthRow } from '@/lib/jobs/jobs-health';
import { CRON_JOBS, EVENT_QUEUE_MAP, RETIRED_QUEUES } from '@/lib/jobs/queues';
import { FANOUT_SLOT_SECONDS, LOCAL_CONCURRENCY } from '@/lib/ksef/history-sync/constants';

const NOW = Date.parse('2026-10-02T12:00:00Z');
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const CRONS = [
  { queue: 'cron.ops-heartbeat', cron: '* * * * *' },
  { queue: 'cron.upo-retry-stale', cron: '5 * * * *' },
  { queue: 'cron.daily-db-snapshot', cron: '0 2 * * *' },
  { queue: 'cron.verify-backup', cron: '0 3 * * 0' },
];
const healthy: QueueHealthRow[] = [
  { name: 'cron.ops-heartbeat', overdue: 0, failed: 0, last_created: ago(1) },
  { name: 'cron.upo-retry-stale', overdue: 0, failed: 0, last_created: ago(40) },
  { name: 'cron.daily-db-snapshot', overdue: 0, failed: 0, last_created: ago(600) },
  { name: 'invoice.submit.requested', overdue: 0, failed: 0, last_created: ago(5) },
];

describe('ocena zdrowia kolejek', () => {
  it('maksymalna przerwa crona: co godzinę i częściej 2 h, codziennie 26 h, rzadziej — bez oceny', () => {
    expect(cronMaxGapMs('* * * * *')).toBe(2 * 3600_000);
    expect(cronMaxGapMs('*/15 * * * *')).toBe(2 * 3600_000);
    expect(cronMaxGapMs('5 * * * *')).toBe(2 * 3600_000);
    expect(cronMaxGapMs('0 2 * * *')).toBe(26 * 3600_000);
    expect(cronMaxGapMs('0 3 * * 0')).toBeNull();
    expect(cronMaxGapMs('0 3 1 * *')).toBeNull();
  });

  it('wszystko w porządku — brak problemów', () => {
    expect(evaluateJobsHealth(healthy, CRONS, NOW, { schedulesDisabled: false })).toEqual([]);
  });

  it('zadania czekające ponad 15 min i porzucone przez pg-boss w ostatniej godzinie', () => {
    const rows = healthy.map((r) => r.name === 'invoice.submit.requested' ? { ...r, overdue: 4, failed: 1 } : r);
    const problems = evaluateJobsHealth(rows, CRONS, NOW, { schedulesDisabled: false });
    expect(problems).toEqual(['zaległe: invoice.submit.requested (4)', 'porzucone: invoice.submit.requested (1)']);
  });

  it('cron, który przestał się tworzyć', () => {
    const rows = healthy.map((r) => r.name === 'cron.daily-db-snapshot' ? { ...r, last_created: ago(27 * 60) } : r);
    expect(evaluateJobsHealth(rows, CRONS, NOW, { schedulesDisabled: false })).toEqual(['cron stoi: cron.daily-db-snapshot']);
  });

  it('crony wyłączone flagą WORKER_DISABLE_SCHEDULES — bez oceny cronów', () => {
    const rows = healthy.map((r) => r.name === 'cron.daily-db-snapshot' ? { ...r, last_created: ago(27 * 60) } : r);
    expect(evaluateJobsHealth(rows, CRONS, NOW, { schedulesDisabled: true })).toEqual([]);
  });

  it('cron bez żadnego wpisu (nowy) — bez oceny', () => {
    expect(evaluateJobsHealth(healthy.filter((r) => r.name !== 'cron.upo-retry-stale'), CRONS, NOW, { schedulesDisabled: false })).toEqual([]);
  });
});

describe('heartbeat ze strażnikiem kolejek', () => {
  beforeEach(() => vi.stubEnv('OPS_HEARTBEAT_URL', 'https://hc-ping.com/00000000-0000-0000-0000-synthetic000'));
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('kolejki w porządku — pinguje', async () => {
    const fetchMock = vi.fn(async () => new Response('OK'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(runOpsHeartbeat(async () => [])).resolves.toEqual({ sent: true });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('zaległe zadania — NIE pinguje i mówi dlaczego w logu', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await runOpsHeartbeat(async () => [{ name: 'inbox.poll.tenant', overdue: 2, failed: 0, last_created: null }]);
    expect(result).toEqual({ sent: false, reason: 'jobs-unhealthy', problems: ['zaległe: inbox.poll.tenant (2)'] });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(err.mock.calls.join(' ')).toContain('inbox.poll.tenant');
  });

  it('nie da się odczytać stanu kolejek — NIE pinguje', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(runOpsHeartbeat(async () => { throw new Error('fixture'); })).resolves.toEqual({ sent: false, reason: 'db-unavailable' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('kolejki historii KSeF a strażnik (decyzja Bartosza 22.10.2026)', () => {
  it('Magiczny import wycofany: kolejka w RETIRED_QUEUES, bez zdarzenia i bez crona', () => {
    expect(RETIRED_QUEUES).toContain('import.ksef-history.requested');
    expect(Object.values(EVENT_QUEUE_MAP).flat()).not.toContain('import.ksef-history.requested');
    expect(Object.keys(EVENT_QUEUE_MAP)).not.toContain('import/ksef-history.requested');
  });

  it('cron historii co 15 min — strażnik ocenia go jak skrzynkę (przerwa do 2 h)', () => {
    const cron = CRON_JOBS.find((c) => c.queue === 'cron.ksef-history-sync');
    expect(cron?.cron).toBe('11,26,41,56 * * * *');
    expect(cronMaxGapMs(cron!.cron)).toBe(2 * 3600_000);
  });

  it('fan-out jednego cyklu kończy się przed progiem „zaległe” heartbeatu (15 min)', () => {
    // 3 sloty × 13 min czasu przebiegów: ostatni przebieg cyklu startuje najpóźniej
    // po FANOUT_SLOT_SECONDS / LOCAL_CONCURRENCY sekundach od fan-outu.
    expect(FANOUT_SLOT_SECONDS / LOCAL_CONCURRENCY).toBeLessThan(15 * 60);
  });
});

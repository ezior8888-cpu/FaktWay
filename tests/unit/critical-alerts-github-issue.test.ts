import { afterEach, describe, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';

// Plan usprawnień 3.5: monitor alarmów krytycznych zgłasza odpalone alarmy
// do GitHuba OBOK Slacka i Telegrama, nie zamiast nich.

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  alertCritical: vi.fn(),
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
  captureException: vi.fn(),
  reportCriticalIssues: vi.fn(),
}));

vi.mock('@sentry/nextjs', () => ({ captureException: mocks.captureException }));
vi.mock('@/lib/alerts/slack', () => ({ alertCritical: mocks.alertCritical }));
vi.mock('@/lib/cache', () => ({ cacheGet: mocks.cacheGet, cacheSet: mocks.cacheSet }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({ from: mocks.from, rpc: async () => ({ data: [], error: null }) }),
}));
vi.mock('@/lib/alerts/github-issue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/alerts/github-issue')>()),
  reportCriticalIssues: mocks.reportCriticalIssues,
}));

import { runCriticalAlertsMonitor } from '@/lib/jobs/runners/critical-alerts-monitor';

function queryWithStaleBackup() {
  const query = {
    select: vi.fn(), eq: vi.fn(), not: vi.fn(), is: vi.fn(),
    in: vi.fn(), gte: vi.fn(), lt: vi.fn(), order: vi.fn(),
    or: vi.fn(), limit: vi.fn(), maybeSingle: vi.fn(), then: vi.fn(),
  };
  for (const name of ['select', 'eq', 'not', 'is', 'in', 'gte', 'lt', 'or', 'limit', 'order'] as const) {
    query[name].mockReturnValue(query);
  }
  // Ostatnia udana kopia sprzed 3 dni: alarm `stale_backup` musi odpalić.
  query.maybeSingle.mockResolvedValue({
    data: { started_at: new Date(Date.now() - 72 * 3600_000).toISOString() },
    error: null,
  });
  query.then.mockImplementation((resolve: (value: unknown) => void) =>
    Promise.resolve({ count: 0, error: null, data: [] }).then(resolve));
  return query;
}

function stepRecorder() {
  return {
    run: vi.fn(async (_name: string, fn: () => Promise<unknown>) => fn()),
  } as unknown as JobContext['step'];
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const mock of Object.values(mocks)) mock.mockReset();
});

describe('monitor alarmów → issue na GitHubie', () => {
  it('odpalony alarm idzie najpierw do Slacka/Telegrama, potem do GitHuba z samym kodem i źródłem', async () => {
    vi.stubEnv('KSEF_ENV', 'test');
    mocks.from.mockReturnValue(queryWithStaleBackup());
    mocks.cacheGet.mockResolvedValue(null);
    mocks.cacheSet.mockResolvedValue(true);
    mocks.alertCritical.mockResolvedValue(undefined);
    mocks.reportCriticalIssues.mockResolvedValue({ enabled: true });
    const step = stepRecorder();

    const result = await runCriticalAlertsMonitor({ step } as JobContext);

    expect(mocks.alertCritical).toHaveBeenCalledWith('Kopia bazy jest nieaktualna', expect.any(String), expect.anything());
    expect(step.run).toHaveBeenCalledWith('report-github-issues', expect.any(Function));
    expect(mocks.reportCriticalIssues).toHaveBeenCalledTimes(1);
    const [occurrences] = mocks.reportCriticalIssues.mock.calls[0]!;
    expect(occurrences).toContainEqual({ code: 'stale_backup', source: 'cron.critical-alerts-monitor' });
    for (const occurrence of occurrences as object[]) {
      expect(Object.keys(occurrence).sort()).toEqual(['code', 'source']);
    }
    expect(mocks.alertCritical.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.reportCriticalIssues.mock.invocationCallOrder[0]!,
    );
    expect(result).toMatchObject({ checked: 21 });
  });

  it('awaria zgłoszenia do GitHuba nie psuje wyniku monitora', async () => {
    vi.stubEnv('KSEF_ENV', 'test');
    mocks.from.mockReturnValue(queryWithStaleBackup());
    mocks.cacheGet.mockResolvedValue(null);
    mocks.cacheSet.mockResolvedValue(true);
    mocks.alertCritical.mockResolvedValue(undefined);
    mocks.reportCriticalIssues.mockRejectedValue(new Error('github down'));

    const result = await runCriticalAlertsMonitor({ step: stepRecorder() } as JobContext);

    expect(result).toMatchObject({ checked: 21 });
    expect(result.details).toContainEqual({ type: 'stale_backup', fired: true });
  });

  it('bez odpalonych alarmów nie zgłasza niczego', async () => {
    vi.stubEnv('KSEF_ENV', 'test');
    const query = queryWithStaleBackup();
    query.maybeSingle.mockResolvedValue({ data: { started_at: new Date().toISOString() }, error: null });
    mocks.from.mockReturnValue(query);
    mocks.cacheGet.mockResolvedValue(null);
    mocks.reportCriticalIssues.mockResolvedValue({ enabled: true });

    await runCriticalAlertsMonitor({ step: stepRecorder() } as JobContext);

    expect(mocks.alertCritical).not.toHaveBeenCalled();
    expect(mocks.reportCriticalIssues).not.toHaveBeenCalled();
  });
});

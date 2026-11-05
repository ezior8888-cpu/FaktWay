import { beforeEach, describe, expect, it, vi } from 'vitest';

// AUD-35: ponowna wysyłka joba przy retry była poza try/catch — awaria bazy
// w tej chwili wywracała cały batch bez retry i bez onExhausted, a nowy job
// gubił `group`. Teraz każdy job batcha rozliczany osobno (`perJobResults`):
// nieudane ponowienie = ten jeden job „failed” i ponowi go pg-boss.
// AUD-16: job zabity w trakcie (deploy, OOM) przepadał — kolejki mają teraz
// heartbeat, retry pg-boss i dłuższy limit czasu.
// AUD-88: aplikacja web startowała pg-boss z harmonogramem i nadzorem —
// przy leżącym workerze tworzyła crony, których nikt nie odbierał.

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  createQueue: vi.fn(),
  updateQueue: vi.fn(),
  ctor: vi.fn(),
  start: vi.fn(),
}));

vi.mock('pg-boss', () => ({
  PgBoss: class {
    constructor(opts: unknown) { mocks.ctor(opts); }
    start = mocks.start;
    send = mocks.send;
    createQueue = mocks.createQueue;
    updateQueue = mocks.updateQueue;
    on = vi.fn();
  },
}));
vi.mock('@/lib/jobs/config', () => ({ getJobsDatabaseUrl: () => 'postgres://fixture', getJobsSchema: () => 'pgboss' }));
vi.mock('@/lib/jobs/run-log', () => ({ recordJobRun: vi.fn(async () => undefined) }));
vi.mock('@/lib/jobs/sentry', () => ({ reportExhaustedJob: vi.fn() }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.start.mockResolvedValue(undefined);
  mocks.send.mockResolvedValue('retry-job');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

function job(id: string, data: object = {}, groupId: string | null = null) {
  return { id, name: 'fixture.queue', data, groupId, expireInSeconds: 900, heartbeatSeconds: null, signal: new AbortController().signal };
}

describe('wrapper jobów (AUD-35)', () => {
  it('nieudane zaplanowanie ponowienia oblewa tylko ten job, reszta batcha przechodzi', async () => {
    const { wrapHandler } = await import('@/lib/jobs/run-job');
    const handler = vi.fn(async (data: { fail?: boolean }) => { if (data.fail) throw new Error('fixture transient'); });
    mocks.send.mockRejectedValueOnce(new Error('fixture db down'));
    const run = wrapHandler({ queue: 'fixture.queue', maxRetries: 3, handler } as never);
    const results = await run([job('a', { fail: true }), job('b'), job('c')] as never);
    expect(results).toEqual([
      { id: 'a', status: 'failed', output: expect.anything() },
      { id: 'b', status: 'completed' },
      { id: 'c', status: 'completed' },
    ]);
    expect(handler).toHaveBeenCalledTimes(3);
  });

  it('ponowienie zachowuje grupę joba (limit per firma/NIP)', async () => {
    const { wrapHandler } = await import('@/lib/jobs/run-job');
    const run = wrapHandler({ queue: 'fixture.queue', maxRetries: 3, handler: async () => { throw new Error('fixture'); } } as never);
    await run([job('a', { x: 1 }, '1234567890')] as never);
    expect(mocks.send).toHaveBeenCalledWith(
      'fixture.queue',
      expect.objectContaining({ x: 1 }),
      expect.objectContaining({ group: { id: '1234567890' } }),
    );
  });

  it('wyczerpane próby — onExhausted i job „completed” (decyzję podjął handler domenowy)', async () => {
    const { wrapHandler } = await import('@/lib/jobs/run-job');
    const onExhausted = vi.fn(async () => undefined);
    const run = wrapHandler({ queue: 'fixture.queue', maxRetries: 0, onExhausted, handler: async () => { throw new Error('fixture'); } } as never);
    expect(await run([job('a')] as never)).toEqual([{ id: 'a', status: 'completed' }]);
    expect(onExhausted).toHaveBeenCalledOnce();
  });
});

describe('kolejki pg-boss (AUD-16)', () => {
  it('każda kolejka ma heartbeat, retry pg-boss i dłuższy limit czasu — także już istniejąca', async () => {
    const { ensureQueue, QUEUE_POLICY } = await import('@/lib/jobs/boss');
    await ensureQueue('fixture.queue');
    expect(QUEUE_POLICY).toEqual({ retryLimit: 2, retryDelay: 60, heartbeatSeconds: 120, expireInSeconds: 4 * 60 * 60 });
    expect(mocks.createQueue).toHaveBeenCalledWith('fixture.queue', QUEUE_POLICY);
    expect(mocks.updateQueue).toHaveBeenCalledWith('fixture.queue', QUEUE_POLICY);
  });
});

describe('rola pg-boss w procesie (AUD-88)', () => {
  it('aplikacja web tylko wysyła: bez harmonogramu i nadzoru', async () => {
    const { getBoss } = await import('@/lib/jobs/boss');
    getBoss();
    expect(mocks.ctor).toHaveBeenCalledWith(expect.objectContaining({ schedule: false, supervise: false }));
  });

  it('worker prowadzi harmonogram i nadzór', async () => {
    const { getBoss, enableWorkerRole } = await import('@/lib/jobs/boss');
    enableWorkerRole();
    getBoss();
    const opts = mocks.ctor.mock.calls[0]![0] as Record<string, unknown>;
    expect(opts.schedule).not.toBe(false);
    expect(opts.supervise).not.toBe(false);
  });
});

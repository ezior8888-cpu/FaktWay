import { beforeEach, describe, expect, it, vi } from 'vitest';

// AUD-91: (1) zdarzenie z kilkoma kolejkami (wynik wysyłki → powiadomienie
// + Offline24) szło kolejnymi `boss.send` — błąd przy drugiej kolejce
// zostawiał pierwszą, a ponowienie dublowało powiadomienie. Teraz wszystkie
// kolejki jednego zdarzenia w jednej transakcji pg-boss. (2) Fan-out skrzynki
// szedł bez `groupId`, więc limit „na NIP” nie działał — dwa przebiegi tej
// samej firmy mogły iść równolegle. Grupę w zleceniu pilnuje teraz
// `skrzynka-rozsylka.test.ts` (rozsyłka według harmonogramu, 00160).

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  withTransaction: vi.fn(),
  txDb: { executeSql: vi.fn() },
}));

vi.mock('@/lib/jobs/config', () => ({ getJobsBackend: () => 'pgboss' }));
vi.mock('@/lib/jobs/boss', () => ({
  startBoss: async () => ({
    send: mocks.send,
    getDb: () => ({ executeSql: vi.fn(), withTransaction: mocks.withTransaction }),
  }),
}));

import { sendJobEvent } from '@/lib/jobs/enqueue';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.send.mockImplementation(async (queue: string) => `job-${queue}`);
  mocks.withTransaction.mockImplementation(async (fn: (db: unknown) => Promise<unknown>) => fn(mocks.txDb));
});

describe('fan-out do kilku kolejek', () => {
  it('wysyła do wszystkich kolejek zdarzenia w jednej transakcji', async () => {
    const result = await sendJobEvent({ name: 'invoice/submit.succeeded', data: { invoiceId: 'x' } });
    expect(mocks.withTransaction).toHaveBeenCalledOnce();
    // 2 → 3: przyjęcie w KSeF to także webhook `invoice.ksef_accepted` (krok 7.1, część 3, 00187).
    expect(mocks.send).toHaveBeenCalledTimes(3);
    for (const call of mocks.send.mock.calls) {
      expect(call[2]).toEqual(expect.objectContaining({ db: mocks.txDb }));
    }
    expect(result.ids).toEqual([
      'job-invoice.submit.succeeded.notify',
      'job-invoice.submit.succeeded.offline-queue',
      'job-invoice.submit.succeeded.webhook',
    ]);
  });

  it('błąd drugiej kolejki wycofuje całość (błąd idzie do nadawcy)', async () => {
    mocks.send
      .mockImplementationOnce(async () => 'job-1')
      .mockImplementationOnce(async () => { throw new Error('fixture queue down'); });
    mocks.withTransaction.mockImplementation(async (fn: (db: unknown) => Promise<unknown>) => {
      try { return await fn(mocks.txDb); } catch (e) { throw e; }
    });
    await expect(sendJobEvent({ name: 'invoice/submit.failed', data: { invoiceId: 'x' } })).rejects.toThrow('fixture queue down');
    expect(mocks.withTransaction).toHaveBeenCalledOnce();
  });

  it('zdarzenie z jedną kolejką idzie bez transakcji', async () => {
    await sendJobEvent({ name: 'invoice/submit.requested', data: { invoiceId: 'x' } }, { groupId: 't1' });
    expect(mocks.withTransaction).not.toHaveBeenCalled();
    expect(mocks.send).toHaveBeenCalledWith('invoice.submit.requested', { invoiceId: 'x' }, { group: { id: 't1' } });
  });
});

describe('fan-out skrzynki', () => {
  it('worker przepuszcza jeden przebieg skrzynki na NIP naraz', async () => {
    vi.resetModules();
    const { getRegisteredJobs } = await import('@/lib/jobs/registry');
    await import('@/lib/jobs/handlers/package-d');
    const job = getRegisteredJobs().find((j) => j.queue === 'inbox.poll.tenant');
    expect(job?.groupConcurrency).toBe(1);
  });
});

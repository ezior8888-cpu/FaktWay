import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';

/**
 * F-039 (audyt bloku 1): po zaległości ponad 90 dni skrzynka pyta KSeF
 * o okno [HWM, HWM + 90 dni], ale następny start brała z zwróconego
 * `permanentStorageHwmDate`. Ten znacznik jest globalny („do kiedy dane są
 * kompletne”) i przy nadrabianiu bywa dużo późniejszy niż koniec okna, więc
 * faktury kosztowe z przedziału (koniec okna, HWM] nigdy nie były pobierane.
 * Dokumentacja MF (CIRFMF, pobieranie-faktur/przyrostowe-pobieranie-faktur.md):
 * „Przez »moment zakończenia« rozumie się wartość dateRange.to, gdy została
 * podana, lub PermanentStorageHwmDate, gdy dateRange.to pominięto”.
 */

const st = vi.hoisted(() => ({
  hwm: null as string | null,
  saved: [] as unknown[],
  query: vi.fn(),
}));

vi.mock('@/lib/supabase/admin-queries', () => ({ getTenantKsefCredentials: vi.fn(async () => ({})) }));
vi.mock('@/lib/ksef/inbox', () => ({ queryReceivedInvoices: st.query }));
vi.mock('@/lib/flo/proposals', () => ({ createProposal: vi.fn() }));
vi.mock('@/lib/flo/functions/expense-inbox', () => ({
  buildInboxSummaryProposal: () => null,
  classifyInboxDocuments: () => [],
}));
// Harmonogram ma własny test (`skrzynka-przebieg-harmonogram`). Bez tej atrapy jego błąd
// (brak bazy) szedłby do logu i Sentry i zasłaniałby asercje o błędach przebiegu.
vi.mock('@/lib/ksef/inbox-schedule-db', () => ({
  readInboxPollState: async () => null,
  finishInboxPoll: async () => undefined,
}));
vi.mock('@/lib/flo/functions/inbox-cursor', () => ({
  readInboxHwm: async () => st.hwm,
  saveInboxHwm: vi.fn(async (_tenantId: string, state: unknown) => { st.saved.push(state); }),
}));
vi.mock('@/lib/push/sender', () => ({ sendPushToTenant: vi.fn(async () => ({ sent: 0, failed: 0 })) }));
vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: async () => ({
    from: () => {
      const q = {
        select: () => q, eq: () => q, not: () => q, limit: () => q, in: () => q, insert: () => q,
        then: (ok: (v: unknown) => unknown, fail?: (e: unknown) => unknown) =>
          Promise.resolve({ data: [], error: null }).then(ok, fail),
      };
      return q;
    },
  }),
}));

import { nextInboxHwm, runInboxPollTenant } from '@/lib/jobs/runners/inbox-polling';

const ctx: JobContext = {
  attempt: 0,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  step: { run: async (_n, fn) => fn(), sleep: vi.fn(), sendEvent: vi.fn(), scheduleAfter: vi.fn() },
};
const DATA = { tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', nip: '1234567890', environment: 'test' as const };
const NOW = new Date('2026-10-02T12:00:00Z');

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  st.hwm = null;
  st.saved = [];
});

describe('nextInboxHwm (F-039)', () => {
  const okno = { from: '2026-01-01T00:00:00.000Z', to: '2026-04-01T00:00:00.000Z' };

  it('HWM po końcu okna → następny start = koniec okna', () => {
    expect(nextInboxHwm('2026-10-02T11:58:00Z', okno)).toBe('2026-04-01T00:00:00.000Z');
  });

  it('HWM wewnątrz okna → następny start = HWM', () => {
    expect(nextInboxHwm('2026-03-15T10:00:00Z', okno)).toBe('2026-03-15T10:00:00Z');
  });

  it('HWM przed początkiem okna albo nieczytelny → okno nie cofa się', () => {
    expect(nextInboxHwm('2025-12-01T00:00:00Z', okno)).toBe(okno.from);
    expect(nextInboxHwm('nie-data', okno)).toBe(okno.from);
  });
});

describe('przebieg skrzynki z zaległością ponad 90 dni (F-039)', () => {
  it('zapisuje koniec okna zapytania, a nie globalny HWM z KSeF', async () => {
    st.hwm = '2026-01-01T00:00:00.000Z';
    st.query.mockResolvedValue({ invoices: [], hwm: '2026-10-02T11:58:00Z' });

    await runInboxPollTenant(DATA, ctx);

    const [, from, to] = st.query.mock.calls[0]!;
    expect((from as Date).toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect((to as Date).toISOString()).toBe('2026-04-01T00:00:00.000Z');
    expect(st.saved).toEqual([expect.objectContaining({ hwm: '2026-04-01T00:00:00.000Z' })]);
  });

  it('bieżące okno (bez zaległości) nadal przesuwa się do HWM z KSeF', async () => {
    st.hwm = '2026-10-01T00:00:00.000Z';
    st.query.mockResolvedValue({ invoices: [], hwm: '2026-10-02T11:58:00Z' });

    await runInboxPollTenant(DATA, ctx);

    expect(st.saved).toEqual([expect.objectContaining({ hwm: '2026-10-02T11:58:00Z' })]);
  });
});

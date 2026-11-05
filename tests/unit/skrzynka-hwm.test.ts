import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';

// AUD-18: skrzynka chodziła przesuwnym oknem „ostatnie 48 h” — awaria
// dłuższa niż 48 h = faktury kosztowe, których nikt już nie pobierze.
// Teraz okno zaczyna się od zapisanego HWM (`permanentStorageHwmDate`
// z ostatniego pełnego przebiegu), a HWM przesuwa się dopiero PO zapisie
// faktur. Bez HWM (pierwszy przebieg) — 48 h wstecz, jak dotąd.

const st = vi.hoisted(() => ({
  hwm: null as string | null,
  saved: [] as unknown[],
  insertError: null as { message: string } | null,
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
      let op: 'select' | 'insert' = 'select';
      let rows: Record<string, unknown>[] = [];
      const q = {
        select: () => q, eq: () => q, not: () => q, limit: () => q, in: () => q,
        insert: (r: Record<string, unknown>[]) => { op = 'insert'; rows = r; return q; },
        then: (ok: (v: unknown) => unknown, fail?: (e: unknown) => unknown) => {
          const result = op === 'insert'
            ? (st.insertError
              ? { data: null, error: st.insertError }
              : { data: rows.map((r, i) => ({ id: `id-${i}`, ksef_number: r.ksef_number })), error: null })
            : { data: [], error: null };
          return Promise.resolve(result).then(ok, fail);
        },
      };
      return q;
    },
  }),
}));

import { runInboxPollTenant, inboxQueryWindow } from '@/lib/jobs/runners/inbox-polling';

const ctx: JobContext = {
  attempt: 0,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  step: { run: async (_n, fn) => fn(), sleep: vi.fn(), sendEvent: vi.fn(), scheduleAfter: vi.fn() },
};
const DATA = { tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', nip: '1234567890', environment: 'test' as const };
const NOW = new Date('2026-10-02T12:00:00Z');

function faktura(n: number) {
  return {
    ksefNumber: `1234567890-20260925-${String(n).padStart(12, '0')}-00`,
    invoiceNumber: `FV ${n}/2026`, acquisitionDate: '2026-09-25T10:00:00Z', issueDate: '2026-09-25',
    permanentStorageDate: '2026-09-25T10:00:00Z', invoiceType: 'Vat',
    seller: { nip: '5260001246', name: 'Dostawca' }, buyer: { identifier: { type: 'Nip', value: '1234567890' } },
    currency: 'PLN', grossAmount: 123, netAmount: 100, vatAmount: 23,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  st.hwm = null; st.saved = []; st.insertError = null;
  st.query.mockResolvedValue({ invoices: [], hwm: '2026-10-02T11:58:00Z' });
});

describe('okno zapytania', () => {
  it('bez HWM — ostatnie 48 h', () => {
    expect(inboxQueryWindow(null, NOW)).toEqual({ from: '2026-09-30T12:00:00.000Z', to: NOW.toISOString() });
  });

  it('z HWM sprzed 5 dni — od HWM, nie od „48 h temu” (nadrabianie po awarii)', () => {
    expect(inboxQueryWindow('2026-09-27T08:00:00.000Z', NOW)).toEqual({ from: '2026-09-27T08:00:00.000Z', to: NOW.toISOString() });
  });

  it('zaległość ponad limit API (100 dni) — okno 90 dni, reszta w kolejnych przebiegach', () => {
    expect(inboxQueryWindow('2026-01-01T00:00:00.000Z', NOW)).toEqual({ from: '2026-01-01T00:00:00.000Z', to: '2026-04-01T00:00:00.000Z' });
  });

  it('HWM z przyszłości (zegar) — nie ma czego pytać', () => {
    expect(inboxQueryWindow('2026-10-02T12:05:00.000Z', NOW)).toBeNull();
  });
});

describe('przebieg skrzynki', () => {
  it('pyta od zapisanego HWM i przesuwa go po zapisie faktur', async () => {
    st.hwm = '2026-09-27T08:00:00.000Z';
    st.query.mockResolvedValue({ invoices: [faktura(1)], hwm: '2026-10-02T11:58:00Z' });
    await runInboxPollTenant(DATA, ctx);
    const [, from, to] = st.query.mock.calls[0]!;
    expect((from as Date).toISOString()).toBe('2026-09-27T08:00:00.000Z');
    expect((to as Date).toISOString()).toBe(NOW.toISOString());
    expect(st.saved).toEqual([expect.objectContaining({ windowFrom: '2026-09-27T08:00:00.000Z', hwm: '2026-10-02T11:58:00Z' })]);
  });

  it('przesuwa HWM także, gdy w oknie nie ma faktur', async () => {
    await runInboxPollTenant(DATA, ctx);
    expect(st.saved).toEqual([expect.objectContaining({ hwm: '2026-10-02T11:58:00Z' })]);
  });

  it('nie przesuwa HWM, gdy zapis faktur padł — kolejny przebieg zapyta o to samo', async () => {
    st.query.mockResolvedValue({ invoices: [faktura(1)], hwm: '2026-10-02T11:58:00Z' });
    st.insertError = { message: 'fixture insert failed' };
    await expect(runInboxPollTenant(DATA, ctx)).rejects.toThrow();
    expect(st.saved).toEqual([]);
  });

  it('nie przesuwa HWM, gdy KSeF go nie podał', async () => {
    st.query.mockResolvedValue({ invoices: [], hwm: null });
    await runInboxPollTenant(DATA, ctx);
    expect(st.saved).toEqual([]);
    expect(ctx.logger.warn).toHaveBeenCalled();
  });

  it('HWM nigdy się nie cofa poniżej początku okna', async () => {
    st.hwm = '2026-10-01T00:00:00.000Z';
    st.query.mockResolvedValue({ invoices: [], hwm: '2026-09-30T00:00:00Z' });
    await runInboxPollTenant(DATA, ctx);
    expect(st.saved).toEqual([expect.objectContaining({ hwm: '2026-10-01T00:00:00.000Z' })]);
  });
});

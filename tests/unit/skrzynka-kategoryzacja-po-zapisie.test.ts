import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';

/**
 * K2 z rewizji 03.10.2026: po zapisie faktur ze skrzynki runner emitował
 * zdarzenie kategoryzacji (`inbox/invoice-received`) dopiero PO karcie FLO
 * i pushu. Błąd karty wywracał job, ponowienie widziało faktury „już w DB”,
 * przesuwało HWM i nigdy nie emitowało zdarzenia: faktury były w `/inbox`,
 * ale nie w `expenses`, KPiR, JPK, bez XML.
 *
 * Po naprawie: zdarzenia kategoryzacji wychodzą tuż po INSERT (z etykietą
 * `singletonKey` = id faktury; dubli pilnuje wczesne wyjście w zadaniu i cron
 * uzupełniający, `skrzynka-duble.test.ts`), a karta FLO, push i zdarzenie dla UI są „best effort” — ich błąd trafia
 * do logu i Sentry, nie przerywa przebiegu i nie blokuje HWM.
 */

type Row = Record<string, unknown>;

const db = vi.hoisted(() => ({
  inserted: [] as Row[],
  createProposal: vi.fn(),
  saveInboxHwm: vi.fn(),
  sendPush: vi.fn(async () => ({ sent: 0, failed: 0 })),
  sentry: vi.fn(),
}));

vi.mock('@sentry/nextjs', () => ({ captureException: db.sentry }));
vi.mock('@/lib/supabase/admin-queries', () => ({ getTenantKsefCredentials: vi.fn(async () => ({})) }));
vi.mock('@/lib/ksef/inbox', () => ({ queryReceivedInvoices: vi.fn() }));
vi.mock('@/lib/flo/proposals', () => ({ createProposal: db.createProposal }));
vi.mock('@/lib/flo/functions/expense-inbox', () => ({
  buildInboxSummaryProposal: () => ({ kind: 'expense.inbox', tenantId: 't' }),
  classifyInboxDocuments: (docs: unknown) => docs,
}));
vi.mock('@/lib/flo/functions/inbox-cursor', () => ({
  readInboxHwm: async () => null,
  saveInboxHwm: db.saveInboxHwm,
}));
vi.mock('@/lib/push/sender', () => ({ sendPushToTenant: db.sendPush }));
// Harmonogram ma własny test (`skrzynka-przebieg-harmonogram`). Bez tej atrapy jego błąd
// (brak bazy) szedłby do logu i Sentry i zasłaniałby asercje o błędach przebiegu.
vi.mock('@/lib/ksef/inbox-schedule-db', () => ({
  readInboxPollState: async () => null,
  finishInboxPoll: async () => undefined,
}));
vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: async () => ({
    from: () => {
      let op: 'select' | 'insert' = 'select';
      let rows: Row[] = [];
      const q = {
        select: () => q,
        eq: () => q,
        in: () => q,
        limit: () => q,
        insert: (r: Row[]) => {
          op = 'insert';
          rows = r;
          return q;
        },
        then: (ok: (v: unknown) => unknown, fail?: (e: unknown) => unknown) => {
          let result: unknown = { data: [], error: null };
          if (op === 'insert') {
            const inserted: Row[] = rows.map((r, i) => ({ ...r, id: `id-${i + 1}` }));
            db.inserted.push(...inserted);
            result = { data: inserted.map((r) => ({ id: r.id, ksef_number: r.ksef_number })), error: null };
          }
          return Promise.resolve(result).then(ok, fail);
        },
      };
      return q;
    },
  }),
}));

import { queryReceivedInvoices } from '@/lib/ksef/inbox';
import { runInboxPollTenant } from '@/lib/jobs/runners/inbox-polling';

const DATA = { tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', nip: '1234567890', environment: 'test' as const };

function faktura(n: number) {
  return {
    ksefNumber: `5260001246-20260925-${String(n).padStart(12, '0')}-00`,
    invoiceNumber: `FV ${n}/2026`,
    acquisitionDate: '2026-09-25T10:00:00Z',
    issueDate: '2026-09-25',
    seller: { nip: '5260001246', name: 'Dostawca' },
    buyer: { identifier: { type: 'Nip', value: '1234567890' } },
    currency: 'PLN',
    grossAmount: 123,
    netAmount: 100,
    vatAmount: 23,
  };
}

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

type SentEvent = { name: string; data: Record<string, unknown>; singletonKey?: string };
function eventsNamed(sendEvent: ReturnType<typeof context>['sendEvent'], step: string): SentEvent[] {
  const call = sendEvent.mock.calls.find((c) => c[0] === step);
  if (!call) return [];
  const events = call[1] as SentEvent | SentEvent[];
  return Array.isArray(events) ? events : [events];
}

beforeEach(() => {
  vi.stubEnv('KSEF_ENV', 'test');
  db.inserted = [];
  db.createProposal.mockReset();
  db.saveInboxHwm.mockReset();
  db.sendPush.mockClear();
  db.sentry.mockClear();
  vi.mocked(queryReceivedInvoices).mockResolvedValue({
    invoices: [faktura(1), faktura(2)] as never,
    hwm: '2026-09-25T12:00:00Z',
  } as never);
});

describe('skrzynka: kategoryzacja kosztów nie zależy od karty FLO ani pushu (K2)', () => {
  it('błąd karty FLO po zapisie: zdarzenia kategoryzacji wychodzą, przebieg się kończy, HWM idzie dalej', async () => {
    db.createProposal.mockRejectedValue(new Error('flo_proposals: limit'));
    const { ctx, sendEvent } = context();

    await expect(runInboxPollTenant(DATA, ctx)).resolves.toEqual({ fetched: 2, newlyAdded: 2 });

    const categorize = eventsNamed(sendEvent, 'fan-out-auto-categorize-inbox');
    expect(categorize.map((e) => e.data.invoiceId)).toEqual(['id-1', 'id-2']);
    expect(categorize.every((e) => e.name === 'inbox/invoice-received')).toBe(true);
    // Etykieta per faktura w `pgboss.job`. Na kolejce `standard` pg-boss po niej nie
    // deduplikuje: drugie zadanie kończy się jednym odczytem (`skrzynka-duble.test.ts`).
    expect(categorize.map((e) => e.singletonKey)).toEqual(['id-1', 'id-2']);
    expect(db.saveInboxHwm).toHaveBeenCalledWith(DATA.tenantId, expect.objectContaining({ saved: 2 }));
    expect(db.sentry).toHaveBeenCalled();
    expect(ctx.logger.error).toHaveBeenCalled();
  });

  it('zdarzenia kategoryzacji są emitowane PRZED kartą FLO, pushem i zdarzeniem dla UI', async () => {
    const order: string[] = [];
    db.createProposal.mockImplementation(async () => { order.push('flo'); });
    db.sendPush.mockImplementation(async () => { order.push('push'); return { sent: 0, failed: 0 }; });
    const { ctx, sendEvent } = context();
    sendEvent.mockImplementation(async (step: string) => { order.push(step); });

    await runInboxPollTenant(DATA, ctx);

    expect(order[0]).toBe('fan-out-auto-categorize-inbox');
    expect(order).toContain('flo');
    expect(order).toContain('push');
  });

  it('błąd pushu albo zdarzenia dla UI nie wywraca przebiegu', async () => {
    db.createProposal.mockResolvedValue(undefined);
    db.sendPush.mockRejectedValue(new Error('push down'));
    const { ctx, sendEvent } = context();
    sendEvent.mockImplementation(async (step: string) => {
      if (step === 'fan-out-new-invoices') throw new Error('kolejka UI niedostępna');
    });

    await expect(runInboxPollTenant(DATA, ctx)).resolves.toEqual({ fetched: 2, newlyAdded: 2 });
    expect(eventsNamed(sendEvent, 'fan-out-auto-categorize-inbox')).toHaveLength(2);
    expect(db.saveInboxHwm).toHaveBeenCalledOnce();
  });

  it('błąd emisji kategoryzacji nadal wywraca przebieg (HWM stoi, ponowienie i cron uzupełniający)', async () => {
    db.createProposal.mockResolvedValue(undefined);
    const { ctx, sendEvent } = context();
    sendEvent.mockImplementation(async (step: string) => {
      if (step === 'fan-out-auto-categorize-inbox') throw new Error('pg-boss down');
    });

    await expect(runInboxPollTenant(DATA, ctx)).rejects.toThrow('pg-boss down');
    expect(db.saveInboxHwm).not.toHaveBeenCalled();
  });
});

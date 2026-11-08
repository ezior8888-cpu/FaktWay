import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';

/**
 * A5, luka #3 (przekazanie 14.10.2026): powiadomienie o wyniku wysyłki faktury
 * (przyjęta, odrzucona, czeka na decyzję) ginęło po cichu:
 *   1. karta FLO szła PRZED e-mailem — jej błąd oblewał zadanie, e-mail i push
 *      nie wychodziły;
 *   2. właściciel i adres z wersji łagodnej (`getTenantAdminEmail`) — chwilowy
 *      błąd bazy albo GoTrue = „brak adresu”, e-mail pominięty bez ponowienia;
 *   3. błąd Resend rzucał przed pushem — push (niezależny kanał) nie wychodził;
 *   4. ponowienia co 10 s i 30 s (`maxRetries: 2`) — awaria dłuższa niż ~40 s
 *      gubiła wszystko; teraz 5 min, potem 30 min (`getDelayMs` kolejek notify,
 *      sprawdzane prawdziwym `decideRetry`);
 *   5. po wyczerpaniu prób Sentry bez numeru faktury — teraz `onExhausted`
 *      kolejek notify nazywa fakturę i firmę.
 *
 * Prawdziwe: runnery `notify-user.ts`, odczyt właściciela
 * (`@/lib/supabase/admin-queries`), granica firmy (`tenant-boundary`), ślad
 * powiadomienia o duplikacie, rejestracja paczki B. Baza w pamięci + atrapa
 * GoTrue. Atrapy: Resend, Web Push, FLO (`createProposal`), Sentry.
 */

const T = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_T = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ID = '11111111-1111-4111-8111-111111111111';
const OWNER = '33333333-3333-4333-8333-333333333333';
const OWNER_EMAIL = 'wlasciciel@example.test';
const NUMBER = 'FV/2026/10/14';
const KSEF_NUMBER = '5260001246-20261014-0100A0B0C0D0-3C';
const K = '5260001246-20261001-0100A0B0C0D0-1A';
const MIN = 60_000;

type Row = Record<string, unknown>;

const m = vi.hoisted(() => ({
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  failRead: new Set<string>(),
  authUsers: {} as Record<string, { email: string | null }>,
  authError: null as null | { name: string; status: number; message: string },
  acceptedEmail: vi.fn(),
  failedEmail: vi.fn(),
  duplicateEmail: vi.fn(),
  push: vi.fn(),
  proposal: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

function columnValue(row: Row, key: string): unknown {
  const [root, ...path] = key.split(/->>?/);
  let value: unknown = row[root!];
  for (const part of path) value = value && typeof value === 'object' ? (value as Row)[part] : undefined;
  return value;
}

/** Klient serwisowy na tabelach w pamięci (wzór: `powiadomienie-decyzja-duplikatu.test.ts`). */
function client() {
  return {
    from(table: string) {
      const filters: Array<(r: Row) => boolean> = [];
      let op: 'select' | 'insert' = 'select';
      let payload: Row = {};
      let head = false;
      let max = Infinity;
      let order: { key: string; ascending: boolean } | null = null;
      const execute = () => {
        if (op === 'insert') {
          const row = { id: `${table}-${(m.tables[table] ??= []).length + 1}`, created_at: new Date().toISOString(), ...payload };
          m.tables[table]!.push(row);
          return { data: [{ ...row }], error: null, count: null };
        }
        if (m.failRead.has(table)) return { data: null, error: { code: 'XX000', message: 'db down' }, count: null };
        let rows = (m.tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
        if (order) {
          const { key, ascending } = order;
          rows = [...rows].sort((a, b) => String(a[key] ?? '').localeCompare(String(b[key] ?? '')) * (ascending ? 1 : -1));
        }
        rows = rows.slice(0, max);
        return { data: head ? null : rows.map((r) => ({ ...r })), error: null, count: rows.length };
      };
      const q = {
        select: (_columns?: string, options?: { head?: boolean }) => { head = Boolean(options?.head); return q; },
        insert: (row: Row) => { op = 'insert'; payload = row; return q; },
        eq: (k: string, v: unknown) => { filters.push((r) => columnValue(r, k) === v); return q; },
        neq: (k: string, v: unknown) => { filters.push((r) => columnValue(r, k) !== v); return q; },
        in: (k: string, vs: unknown[]) => { filters.push((r) => vs.includes(columnValue(r, k))); return q; },
        is: (k: string, v: unknown) => { filters.push((r) => (columnValue(r, k) ?? null) === v); return q; },
        not: (k: string, _op: string, v: unknown) => { filters.push((r) => (columnValue(r, k) ?? null) !== v); return q; },
        gte: (k: string, v: string) => { filters.push((r) => String(columnValue(r, k) ?? '') >= v); return q; },
        lte: (k: string, v: string) => { filters.push((r) => String(columnValue(r, k) ?? '') <= v); return q; },
        order: (key: string, o?: { ascending?: boolean }) => { order = { key, ascending: o?.ascending ?? true }; return q; },
        limit: (n: number) => { max = n; return q; },
        maybeSingle: async () => { const r = execute(); return { data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: r.error }; },
        single: async () => { const r = execute(); return { data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: r.error }; },
        then: <A, B>(ok: (v: ReturnType<typeof execute>) => A, fail?: (e: unknown) => B) => Promise.resolve(execute()).then(ok, fail),
      };
      return q;
    },
    // Blokada decyzji (00148): NULL = faktura czeka na klienta.
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn === 'ksef_duplicate_decision_blocker' && args.p_invoice_id === ID && args.p_tenant_id === T) return { data: null, error: null };
      return { data: null, error: { code: 'PGRST202', message: `Could not find the function public.${fn}` } };
    },
    // GoTrue jak `@supabase/auth-js`: błąd HTTP w `error`; brak konta = 404.
    auth: {
      admin: {
        getUserById: async (id: string) => {
          if (m.authError) return { data: { user: null }, error: m.authError };
          const user = m.authUsers[id];
          if (!user) return { data: { user: null }, error: { name: 'AuthApiError', status: 404, message: 'User not found' } };
          return { data: { user: { id, email: user.email } }, error: null };
        },
      },
    },
  };
}

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => client() }));
vi.mock('@/lib/supabase/server', () => ({ createAdminClient: async () => client() }));
vi.mock('@/lib/email/send', () => ({
  sendInvoiceAcceptedEmail: m.acceptedEmail,
  sendInvoiceFailedEmail: m.failedEmail,
  sendInvoiceDuplicateDecisionEmail: m.duplicateEmail,
}));
vi.mock('@/lib/push/sender', () => ({ sendPushToUser: m.push, sendPushToTenant: vi.fn(async () => ({ sent: 0, failed: 0 })) }));
vi.mock('@/lib/flo/proposals', () => ({ createProposal: m.proposal }));
vi.mock('@sentry/nextjs', () => ({ captureException: m.captureException, captureMessage: m.captureMessage, addBreadcrumb: vi.fn() }));

import { NonRetriableError, RetryAfterError } from '@/lib/jobs/errors';
import { getRegisteredJobs, retryPolicyFor } from '@/lib/jobs/registry';
import { decideRetry } from '@/lib/jobs/retry';
import { runNotifyFailure, runNotifySuccess } from '@/lib/jobs/runners/notify-user';
import '@/lib/jobs/handlers/package-b';

const SUCCESS_Q = 'invoice.submit.succeeded.notify';
const FAILURE_Q = 'invoice.submit.failed.notify';
const jobs = new Map(getRegisteredJobs().map((job) => [job.queue, job]));
/** Decyzja workera (`run-job.ts`) dla błędu zadania — polityka z prawdziwej rejestracji kolejki. */
const decide = (error: unknown, attempt: number, queue: string) => decideRetry(error, attempt, retryPolicyFor(jobs.get(queue)!));
const retryIn = (ms: number, nextAttempt: number) => ({ action: 'retry', delayMs: ms, nextAttempt, nextWaits: 0 });

type SucceededEvent = Parameters<typeof runNotifySuccess>[0];
type FailedEvent = Parameters<typeof runNotifyFailure>[0];

const succeeded = (): SucceededEvent => ({ tenantId: T, invoiceId: ID, environment: 'test', ksefNumber: KSEF_NUMBER });
const failed = (extra: Partial<FailedEvent> = {}): FailedEvent => ({
  tenantId: T, invoiceId: ID, environment: 'test', error: 'KSeF odrzucił fakturę: niepoprawny NIP nabywcy', ...extra,
});
const ctx = (attempt = 0): JobContext => ({
  attempt,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  step: { run: async (_n, fn) => fn(), sleep: vi.fn(), sendEvent: vi.fn(), scheduleAfter: vi.fn() },
});

function seed(invoice: Row = {}) {
  m.tables = {
    invoices: [{
      id: ID, tenant_id: T, direction: 'outgoing', internal_number: NUMBER, ksef_status: 'accepted', ksef_number: KSEF_NUMBER,
      last_error_code: null, updated_at: '2026-10-14T08:00:00.000Z', ...invoice,
    }],
    upo_receipts: [],
    ksef_submissions: [],
    audit_logs: [],
    memberships: [{ organization_id: T, user_id: OWNER, role: 'owner', status: 'active', joined_at: '2026-01-02T08:00:00.000Z' }],
  };
  m.authUsers = { [OWNER]: { email: OWNER_EMAIL } };
}
const rejected = () => seed({ ksef_status: 'failed', ksef_number: null, last_error_code: 'KSEF_REJECTED_450' });

/** Odrzucenie zadania jako błąd — do sprawdzenia typu, opóźnienia i przyczyny. */
async function failure(run: Promise<unknown>): Promise<Error> {
  try {
    await run;
  } catch (e) {
    return e as Error;
  }
  throw new Error('zadanie skończyło się bez błędu');
}

afterEach(() => vi.unstubAllEnvs());

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('KSEF_ENV', 'test');
  m.failRead = new Set();
  m.authError = null;
  m.acceptedEmail.mockResolvedValue({ sent: true, messageId: 'msg-1' });
  m.failedEmail.mockResolvedValue({ sent: true, messageId: 'msg-2' });
  m.duplicateEmail.mockResolvedValue({ sent: true, messageId: 'msg-3' });
  m.push.mockResolvedValue({ sent: 1, failed: 0 });
  m.proposal.mockResolvedValue(undefined);
  seed();
});

describe('A5 #3: przyjęta — powiadomienie nie ginie po cichu', () => {
  it('karta FLO pada → e-mail i push i tak wychodzą, zadanie bez wyjątku; błąd FLO w logu i Sentry z fakturą', async () => {
    const floError = new Error('flo_proposals: relation does not exist');
    m.proposal.mockRejectedValue(floError);
    const c = ctx();

    const result = await runNotifySuccess(succeeded(), c);

    expect(m.acceptedEmail).toHaveBeenCalledTimes(1);
    expect(m.push).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ emailed: true });
    expect((c.logger.warn as ReturnType<typeof vi.fn>).mock.calls).toContainEqual([
      expect.stringContaining('FLO'), expect.objectContaining({ invoiceId: ID, tenantId: T }),
    ]);
    expect(m.captureException).toHaveBeenCalledWith(floError, expect.objectContaining({
      tags: expect.objectContaining({ step: 'flo-status-card' }), extra: expect.objectContaining({ invoiceId: ID }),
    }));
  });

  it('odczyt właściciela pada (memberships) → zadanie rzuca, ponowienie za 5 min; bez e-maila i pusha (dawniej: cichy „brak adresu”)', async () => {
    m.failRead.add('memberships');

    const error = await failure(runNotifySuccess(succeeded(), ctx()));

    expect(error.message).toMatch(/właściciela/);
    expect(decide(error, 0, SUCCESS_Q)).toEqual(retryIn(5 * MIN, 1));
    expect(m.acceptedEmail).not.toHaveBeenCalled();
    expect(m.push).not.toHaveBeenCalled();
  });

  it('GoTrue 503 przy adresie właściciela → zadanie rzuca (ponowienie); bez e-maila', async () => {
    m.authError = { name: 'AuthRetryableFetchError', status: 503, message: 'Service Unavailable' };

    const error = await failure(runNotifySuccess(succeeded(), ctx()));

    expect(error.message).toMatch(/e-maila właściciela/);
    expect(decide(error, 0, SUCCESS_Q)).toEqual(retryIn(5 * MIN, 1));
    expect(m.acceptedEmail).not.toHaveBeenCalled();
  });

  it('Resend pada → push i tak wychodzi, potem błąd Resend i ponowienie za 5 min (e-mail z tym samym kluczem)', async () => {
    const resendError = new Error('Resend error: {"statusCode":503}');
    m.acceptedEmail.mockRejectedValue(resendError);

    const error = await failure(runNotifySuccess(succeeded(), ctx()));

    expect(m.push).toHaveBeenCalledTimes(1);
    expect(m.push).toHaveBeenCalledWith(OWNER, 'invoice_accepted', expect.objectContaining({ tag: `invoice-${ID}` }));
    expect(error).toBe(resendError);
    expect(decide(error, 0, SUCCESS_Q)).toEqual(retryIn(5 * MIN, 1));
    expect(m.acceptedEmail.mock.calls[0]![2]).toEqual({ idempotencyKey: `invoice-accepted/${ID}` });
  });

  it('odstępy kolejek notify: po 1. próbie 5 min, po 2. — 30 min, po 3. — wyczerpane (onExhausted)', () => {
    const error = new Error('Resend error: {"statusCode":503}');
    for (const queue of [SUCCESS_Q, FAILURE_Q]) {
      expect(decide(error, 0, queue)).toEqual(retryIn(5 * MIN, 1));
      expect(decide(error, 1, queue)).toEqual(retryIn(30 * MIN, 2));
      expect(decide(error, 2, queue)).toEqual({ action: 'exhausted', reason: 'attempts-exhausted' });
    }
  });

  it('prawdziwy brak właściciela → bez wyjątku, bez e-maila i pusha (jak dotąd)', async () => {
    m.tables.memberships = [];

    const result = await runNotifySuccess(succeeded(), ctx());

    expect(result).toMatchObject({ emailed: false, reason: 'no-admin-email' });
    expect(m.acceptedEmail).not.toHaveBeenCalled();
    expect(m.push).not.toHaveBeenCalled();
  });

  it('faktura innej firmy (NonRetriable) → bez ponowienia, od razu onExhausted', async () => {
    seed({ tenant_id: OTHER_T });

    const error = await failure(runNotifySuccess(succeeded(), ctx()));

    expect(error).toBeInstanceOf(NonRetriableError);
    expect(decide(error, 0, SUCCESS_Q)).toEqual({ action: 'exhausted', reason: 'non-retriable' });
  });
});

describe('A5 #3: odrzucona — powiadomienie nie ginie po cichu', () => {
  beforeEach(rejected);

  it('karta FLO pada → e-mail „odrzucona” i push i tak wychodzą', async () => {
    m.proposal.mockRejectedValue(new Error('flo down'));

    await runNotifyFailure(failed(), ctx());

    expect(m.failedEmail).toHaveBeenCalledTimes(1);
    expect(m.push).toHaveBeenCalledWith(OWNER, 'invoice_rejected', expect.objectContaining({ tag: `invoice-${ID}` }));
    expect(m.captureException).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({
      tags: expect.objectContaining({ step: 'flo-fix-card' }),
    }));
  });

  it('Resend pada → push i tak wychodzi, potem błąd Resend i ponowienie za 5 min', async () => {
    const resendError = new Error('Resend error: {"statusCode":500}');
    m.failedEmail.mockRejectedValue(resendError);

    const error = await failure(runNotifyFailure(failed(), ctx()));

    expect(m.push).toHaveBeenCalledTimes(1);
    expect(error).toBe(resendError);
    expect(decide(error, 0, FAILURE_Q)).toEqual(retryIn(5 * MIN, 1));
  });

  it('odczyt właściciela pada → zadanie rzuca (ponowienie); bez e-maila i pusha', async () => {
    m.failRead.add('memberships');

    const error = await failure(runNotifyFailure(failed(), ctx()));

    expect(error.message).toMatch(/właściciela/);
    expect(m.failedEmail).not.toHaveBeenCalled();
    expect(m.push).not.toHaveBeenCalled();
  });

  it('faktura przyjęta w międzyczasie → bez e-maila „odrzucona” mimo awarii FLO (wyciszenie działa jak dotąd)', async () => {
    seed();
    m.proposal.mockRejectedValue(new Error('flo down'));

    const result = await runNotifyFailure(failed(), ctx());

    expect(result).toMatchObject({ skipped: true, reason: 'already-accepted' });
    expect(m.failedEmail).not.toHaveBeenCalled();
    expect(m.push).not.toHaveBeenCalled();
  });
});

describe('A5 #3: decyzja przy duplikacie 440 — push niezależny od Resend', () => {
  beforeEach(() => {
    seed({ ksef_status: 'failed', ksef_number: null, last_error_code: 'KSEF_DUPLICATE_RECONCILE' });
    m.tables.ksef_submissions = [{
      id: 'sub-marker', tenant_id: T, invoice_id: ID, status: 'sent', error_code: '440', original_ksef_number: K,
      session_reference_number: 'S-1', attempted_at: '2026-10-07T08:00:00.000Z',
      original_check: { v: 1, env: 'test', checkedAt: '2026-10-07T08:05:00.000Z', reason: 'no-own-file' },
    }];
  });
  const duplicate = () => failed({
    error: `KSeF ma już fakturę o tym numerze (numer KSeF ${K}).`,
    errorCode: 'KSEF_DUPLICATE_RECONCILE', terminal: true, manualReconciliationRequired: true,
  });
  const notices = () => (m.tables.audit_logs ?? []).filter((r) => r.action === 'invoice.ksef_duplicate_decision_notified');

  it('Resend pada, push doszedł → powiadomienie dostarczone: ślad z emailed=false, push 1; bez wyjątku', async () => {
    m.duplicateEmail.mockRejectedValue(new Error('Resend error: {"statusCode":503}'));
    const c = ctx();

    const result = await runNotifyFailure(duplicate(), c);

    expect(m.push).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ notified: true, emailed: false });
    expect(notices()).toHaveLength(1);
    expect(notices()[0]!.metadata).toMatchObject({ emailed: false, push_sent: 1 });
    expect((c.logger.warn as ReturnType<typeof vi.fn>).mock.calls).toContainEqual([
      expect.stringMatching(/e-mail/i), expect.objectContaining({ invoiceId: ID }),
    ]);
  });

  it('jawny odstęp z runnera ma pierwszeństwo: odczyt właściciela pada w 2. próbie → 5 min (nie 30)', async () => {
    m.failRead.add('memberships');

    const error = await failure(runNotifyFailure(duplicate(), ctx(1)));

    expect(error).toBeInstanceOf(RetryAfterError);
    expect(decide(error, 1, FAILURE_Q)).toEqual(retryIn(5 * MIN, 2));
  });

  it('Resend pada i push 0 → błąd Resend i ponowienie za 5 min, bez śladu (ponowienie wyśle z tym samym kluczem)', async () => {
    const resendError = new Error('Resend error: {"statusCode":503}');
    m.duplicateEmail.mockRejectedValue(resendError);
    m.push.mockResolvedValue({ sent: 0, failed: 0 });

    const error = await failure(runNotifyFailure(duplicate(), ctx()));

    expect(error).toBe(resendError);
    expect(decide(error, 0, FAILURE_Q)).toEqual(retryIn(5 * MIN, 1));
    expect(notices()).toEqual([]);
  });
});

describe('A5 #3: wyczerpane próby kolejek notify nazywają fakturę', () => {
  it.each([
    ['invoice.submit.succeeded.notify', { tenantId: T, invoiceId: ID, environment: 'test', ksefNumber: KSEF_NUMBER }],
    ['invoice.submit.failed.notify', { tenantId: T, invoiceId: ID, environment: 'test', error: 'odrzucona' }],
  ] as const)('%s: onExhausted → log error i Sentry z invoiceId, tenantId, kolejką i błędem', async (queue, data) => {
    const onExhausted = jobs.get(queue)?.onExhausted;
    expect(typeof onExhausted, `brak onExhausted: ${queue}`).toBe('function');
    const c = ctx(2);
    const error = new Error('Resend error: {"statusCode":503}');

    await onExhausted!(error, data as never, c);

    expect((c.logger.error as ReturnType<typeof vi.fn>).mock.calls).toContainEqual([
      expect.stringContaining('nie doszło'), expect.objectContaining({ invoiceId: ID, tenantId: T, queue }),
    ]);
    expect(m.captureMessage).toHaveBeenCalledWith(expect.stringContaining('nie doszło'), expect.objectContaining({
      level: 'error',
      tags: expect.objectContaining({ queue }),
      extra: expect.objectContaining({ invoiceId: ID, tenantId: T, error: error.message }),
    }));
  });

  it('onExhausted przy niepoprawnym payloadzie (brak identyfikatorów) nie rzuca', async () => {
    const onExhausted = jobs.get('invoice.submit.failed.notify')?.onExhausted;
    await expect(onExhausted!(new Error('Niepoprawny payload'), {} as never, ctx())).resolves.toBeUndefined();
    await expect(onExhausted!(new Error('Niepoprawny payload'), null as never, ctx())).resolves.toBeUndefined();
    expect(m.captureMessage).toHaveBeenCalledTimes(2);
    for (const [, options] of m.captureMessage.mock.calls) {
      expect(options).toMatchObject({ extra: { invoiceId: null, tenantId: null } });
    }
  });
});

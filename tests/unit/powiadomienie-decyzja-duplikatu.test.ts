import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';

/**
 * D-A4-1b-3 PR B (decyzja Bartosza 07.10.2026 (5); spec v3 §2.8, U7a–U7h):
 * e-mail „Faktura … czeka na Twoją decyzję” idzie DOKŁADNIE RAZ na fakturę
 * i numer KSeF oryginału (K). Trwały ślad w `audit_logs`
 * (`invoice.ksef_duplicate_decision_notified`, `metadata.original_ksef_number`)
 * — zapis tylko po dostarczeniu (e-mail albo push), a błąd odczytu śladu
 * zatrzymuje wysyłkę („nie wiem, co wysłałem” to nie „nic nie wysłałem”).
 *
 * Dziś `runNotifyFailure` pomija każde zdarzenie z
 * `manualReconciliationRequired` (`notify-user.ts:178-180`), więc klient
 * czekającej faktury nie dostaje żadnej wiadomości.
 *
 * Prawdziwe: `runNotifyFailure`, moduł śladu powiadomień i odczyt właściciela
 * firmy (`@/lib/supabase/admin-queries`) nad bazą w pamięci (invoices,
 * ksef_submissions, audit_logs, memberships, RPC blokady decyzji) i atrapą
 * GoTrue (`auth.admin.getUserById`). Atrapy: Resend (`@/lib/email/send`),
 * Web Push, FLO.
 */

const T = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID = '11111111-1111-4111-8111-111111111111';
const OWNER = '33333333-3333-4333-8333-333333333333';
const OWNER_EMAIL = 'owner@example.test';
const NUMBER = 'FV/2026/10/7';
const K = '5260001246-20261001-0100A0B0C0D0-1A';
const K2 = '5260001246-20260915-0200A0B0C0D0-2B';
const ACTION = 'invoice.ksef_duplicate_decision_notified';
const KEY = `ksef-duplicate-decision/${ID}/${K}`;

type Row = Record<string, unknown>;

const m = vi.hoisted(() => ({
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  /** Tabele, których odczyt kończy się błędem bazy. */
  failRead: new Set<string>(),
  /** Tabele, do których zapis (insert) kończy się błędem bazy. */
  failInsert: new Set<string>(),
  inserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  /** Wynik `ksef_duplicate_decision_blocker` (00148): NULL = czeka na klienta. */
  blocker: null as string | null,
  /** Konta GoTrue (`auth.users`): id → e-mail. Brak wpisu = 404 `user_not_found`. */
  authUsers: {} as Record<string, { email: string | null }>,
  /** Błąd GoTrue przy `getUserById` (np. 503) — zamiast odpowiedzi. */
  authError: null as null | { name: string; status: number; code?: string; message: string },
  authCalls: [] as string[],
  duplicateEmail: vi.fn(),
  failedEmail: vi.fn(),
  push: vi.fn(),
  proposal: vi.fn(),
  auditSystem: vi.fn(),
}));

/** Wartość kolumny albo ścieżki jsonb PostgREST (`metadata->>klucz`). */
function columnValue(row: Row, key: string): unknown {
  const [root, ...path] = key.split(/->>?/);
  let value: unknown = row[root!];
  for (const part of path) value = value && typeof value === 'object' ? (value as Row)[part] : undefined;
  return value;
}

/** Klient serwisowy na tabelach w pamięci (styl `jobs-tenant-boundaries.test.ts`) + RPC blokady decyzji. */
function client() {
  return {
    from(table: string) {
      const filters: Array<(r: Row) => boolean> = [];
      let op: 'select' | 'insert' = 'select';
      let payload: Row = {};
      let head = false;
      let columns: string | undefined;
      let max = Infinity;
      let order: { key: string; ascending: boolean } | null = null;
      const execute = () => {
        if (op === 'insert') {
          if (m.failInsert.has(table)) return { data: null, error: { code: 'XX000', message: 'db down' }, count: null };
          const row = { id: `${table}-${(m.tables[table] ??= []).length + 1}`, created_at: new Date().toISOString(), ...payload };
          m.tables[table]!.push(row);
          m.inserts.push({ table, row });
          return { data: [{ ...row }], error: null, count: null };
        }
        if (m.failRead.has(table)) return { data: null, error: { code: 'XX000', message: 'db down' }, count: null };
        let rows = (m.tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
        if (order) {
          const { key, ascending } = order;
          rows = [...rows].sort((a, b) => String(a[key] ?? '').localeCompare(String(b[key] ?? '')) * (ascending ? 1 : -1));
        }
        rows = rows.slice(0, max);
        // Jak PostgREST: wpisy `ksef_submissions` zwracają TYLKO wybrane kolumny — odczyt, któremu brakuje kolumny
        // historii (`session_reference_number`, `request_payload_hash`, …), widzi `undefined`, nie dane z fikstury.
        const only = table === 'ksef_submissions' && columns && columns !== '*' ? columns.split(',').map((c) => c.trim()) : null;
        const shaped = (r: Row): Row => (only ? Object.fromEntries(only.map((key) => [key, r[key] ?? null])) : { ...r });
        return { data: head ? null : rows.map(shaped), error: null, count: rows.length };
      };
      const q = {
        select: (cols?: string, options?: { head?: boolean }) => { columns = cols; head = Boolean(options?.head); return q; },
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
    // PostgREST: nieznana funkcja albo złe nazwy parametrów = PGRST202.
    rpc: async (fn: string, args: Record<string, unknown>) => {
      m.rpcCalls.push({ fn, args });
      if (fn === 'ksef_duplicate_decision_blocker' && args.p_invoice_id === ID && args.p_tenant_id === T) {
        return { data: m.blocker, error: null };
      }
      return { data: null, error: { code: 'PGRST202', message: `Could not find the function public.${fn}` } };
    },
    // GoTrue jak `@supabase/auth-js`: błąd HTTP wraca w `error` (nie rzuca); brak konta = 404 `user_not_found`.
    auth: {
      admin: {
        getUserById: async (id: string) => {
          m.authCalls.push(id);
          if (m.authError) return { data: { user: null }, error: m.authError };
          const user = m.authUsers[id];
          if (!user) {
            return { data: { user: null }, error: { name: 'AuthApiError', status: 404, code: 'user_not_found', message: 'User not found' } };
          }
          return { data: { user: { id, email: user.email } }, error: null };
        },
      },
    },
  };
}

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => client() }));
vi.mock('@/lib/supabase/server', () => ({ createAdminClient: async () => client() }));
vi.mock('@/lib/email/send', () => ({
  sendInvoiceDuplicateDecisionEmail: m.duplicateEmail,
  sendInvoiceFailedEmail: m.failedEmail,
  sendInvoiceAcceptedEmail: vi.fn(),
}));
vi.mock('@/lib/push/sender', () => ({ sendPushToUser: m.push, sendPushToTenant: vi.fn(async () => ({ sent: 0, failed: 0 })) }));
vi.mock('@/lib/flo/proposals', () => ({ createProposal: m.proposal }));
vi.mock('@/lib/jobs/runners/tenant-boundary', () => ({ requireInvoiceTenant: vi.fn(), assertJobIdentity: vi.fn() }));
// Ślad powiadomienia NIE idzie przez logAuditSystem (połyka błędy) — atrapa łapie taką pomyłkę.
vi.mock('@/lib/audit/log-system', () => ({ logAuditSystem: m.auditSystem }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn(), addBreadcrumb: vi.fn() }));

import { runNotifyFailure } from '@/lib/jobs/runners/notify-user';
import { RetryAfterError } from '@/lib/jobs/errors';
import { ORIGINAL_GATE_RULES } from '@/lib/ksef/duplicate-check';
import { DUPLICATE_DECISION_TEXTS } from '@/lib/ksef/duplicate-decision';

type FailedEvent = Parameters<typeof runNotifyFailure>[0];

/** Zdarzenie z `onSubmitInvoiceExhausted` dla nierozstrzygniętego 440 (klasa reconcile → manualReconciliationRequired). */
const failedEvent = (extra: Partial<FailedEvent> = {}): FailedEvent => ({
  invoiceId: ID,
  tenantId: T,
  environment: 'test',
  error: `KSeF ma już fakturę o tym numerze (numer KSeF ${K}) spoza FaktWay, a historia wysyłki nie ma naszego pliku do porównania treści.`,
  errorCode: 'KSEF_DUPLICATE_RECONCILE',
  terminal: true,
  manualReconciliationRequired: true,
  ...extra,
});
const ctx = (): JobContext => ({
  attempt: 0,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  step: { run: async (_n, fn) => fn(), sleep: vi.fn(), sendEvent: vi.fn(), scheduleAfter: vi.fn() },
});

const check = (extra: Row = {}): Row => ({
  v: 1, env: 'test', checkedAt: '2026-10-07T08:05:00.000Z', reason: 'no-own-file', sha256: 'bb'.repeat(32),
  archivePath: `${T}/ksef-import/${K}.xml`, sizeBytes: 1200, sameContentExceptHeader: null, ownHistory: false,
  acquiredAt: '2026-10-01T09:00:00.000Z', httpStatus: null, knownInvoice: null, recheck: null,
  summary: { systemInfo: 'Inny Program 2.0', number: NUMBER, issueDate: '2026-10-07', buyerNip: '5252241585', buyerName: 'Klient', gross: '123.00', currency: 'PLN' },
  ...extra,
});
const notice = (ksefNumber: string, extra: Row = {}): Row => ({
  id: `notice-${ksefNumber}`, tenant_id: T, user_id: null, action: ACTION, entity_type: 'invoice', entity_id: ID,
  metadata: {
    original_ksef_number: ksefNumber, via: 'auto', idempotency_key: `ksef-duplicate-decision/${ID}/${ksefNumber}`,
    emailed: true, push_sent: 1, reminder: null, operator: null, source: 'system',
  },
  created_at: '2026-10-07T09:00:00.000Z',
  ...extra,
});
const notices = () => (m.tables.audit_logs ?? []).filter((r) => r.action === ACTION);

function seed(options: { invoice?: Row; check?: Row; notices?: Row[]; submissions?: Row[] } = {}) {
  m.tables = {
    invoices: [{
      id: ID, tenant_id: T, direction: 'outgoing', internal_number: NUMBER, ksef_status: 'failed', ksef_number: null,
      last_error_code: 'KSEF_DUPLICATE_RECONCILE', ...options.invoice,
    }],
    ksef_submissions: [
      {
        id: 'sub-old', tenant_id: T, invoice_id: ID, status: 'abandoned', original_ksef_number: null, original_check: null,
        session_reference_number: 'S-0', attempted_at: '2026-10-06T08:00:00.000Z',
      },
      {
        id: 'sub-marker', tenant_id: T, invoice_id: ID, status: 'sent', error_code: '440', original_ksef_number: K,
        original_session_reference_number: 'S-OBCA', session_reference_number: 'S-1', invoice_reference_number: 'I-1',
        original_check: check(options.check), attempted_at: '2026-10-07T08:00:00.000Z',
      },
      ...(options.submissions ?? []),
    ],
    audit_logs: [...(options.notices ?? [])],
    memberships: [
      { organization_id: T, user_id: OWNER, role: 'owner', status: 'active', joined_at: '2026-01-02T08:00:00.000Z' },
    ],
  };
  m.authUsers = { [OWNER]: { email: OWNER_EMAIL } };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('KSEF_ENV', 'test');
  seed();
  m.failRead = new Set();
  m.failInsert = new Set();
  m.inserts = [];
  m.rpcCalls = [];
  m.blocker = null;
  m.authError = null;
  m.authCalls = [];
  m.duplicateEmail.mockResolvedValue({ sent: true, messageId: 'msg-1' });
  m.failedEmail.mockResolvedValue({ sent: true, messageId: 'msg-f' });
  m.push.mockResolvedValue({ sent: 1, failed: 0 });
});
afterEach(() => vi.unstubAllEnvs());

describe('U7a–U7c: „czeka na Twoją decyzję” — raz na (fakturę, K)', () => {
  it('U7a: blokada NULL, środowisko test, bez śladu → jeden e-mail z kluczem, push właściciela, jeden ślad w audit_logs; bez karty FLO i maila „odrzucona”', async () => {
    const result = await runNotifyFailure(failedEvent(), ctx());

    expect(m.duplicateEmail).toHaveBeenCalledTimes(1);
    expect(m.duplicateEmail).toHaveBeenCalledWith(
      OWNER_EMAIL,
      expect.objectContaining({ invoiceId: ID, invoiceNumber: NUMBER, ksefNumber: K, reminder: false }),
      expect.objectContaining({ idempotencyKey: KEY }),
    );
    expect(m.push).toHaveBeenCalledTimes(1);
    expect(m.push).toHaveBeenCalledWith(OWNER, 'invoice_rejected', {
      title: `Faktura ${NUMBER} czeka na Twoją decyzję`,
      body: 'KSeF ma już fakturę o tym numerze — porównaj dane i zdecyduj.',
      url: `/invoices/${ID}`,
      tag: `invoice-${ID}`,
    });
    expect(notices()).toHaveLength(1);
    expect(notices()[0]).toMatchObject({
      tenant_id: T, action: ACTION, entity_type: 'invoice', entity_id: ID,
      metadata: expect.objectContaining({
        original_ksef_number: K, via: 'auto', idempotency_key: KEY, emailed: true, push_sent: 1, source: 'system',
      }),
    });
    expect(m.auditSystem).not.toHaveBeenCalledWith(expect.objectContaining({ action: ACTION }));
    // Blokada z bazy (00148) jest autorytatywna — także wpłaty, których TypeScript nie widzi.
    expect(m.rpcCalls).toContainEqual({ fn: 'ksef_duplicate_decision_blocker', args: { p_invoice_id: ID, p_tenant_id: T } });
    expect(m.proposal).not.toHaveBeenCalled();
    expect(m.failedEmail).not.toHaveBeenCalled();
    expect(result).toMatchObject({ notified: true, emailed: true });
  });

  it('U7b: drugie zdarzenie dla tej samej faktury i K → bez e-maila, pusha i zapisu; powód already-notified (decyzja 5)', async () => {
    seed({ notices: [notice(K)] });

    const result = await runNotifyFailure(failedEvent(), ctx());

    expect(result).toMatchObject({ skipped: true, reason: 'already-notified' });
    expect(m.duplicateEmail).not.toHaveBeenCalled();
    expect(m.push).not.toHaveBeenCalled();
    expect(notices()).toHaveLength(1);
    expect(m.failedEmail).not.toHaveBeenCalled();
    expect(m.proposal).not.toHaveBeenCalled();
  });

  it('U7c: ślad powiadomienia o INNYM numerze KSeF nie blokuje — e-mail o K idzie (klucz z K)', async () => {
    seed({ notices: [notice(K2)] });

    await runNotifyFailure(failedEvent(), ctx());

    expect(m.duplicateEmail).toHaveBeenCalledTimes(1);
    expect(m.duplicateEmail).toHaveBeenCalledWith(
      OWNER_EMAIL, expect.objectContaining({ ksefNumber: K }), expect.objectContaining({ idempotencyKey: KEY }),
    );
    expect(notices().map((r) => (r.metadata as Row).original_ksef_number)).toEqual([K2, K]);
  });
});

describe('U7d–U7f: ślad niepewny albo niezapisany', () => {
  it('U7d: odczyt śladu (audit_logs) pada → krok rzuca, bez e-maila i pusha', async () => {
    m.failRead.add('audit_logs');

    await expect(runNotifyFailure(failedEvent(), ctx())).rejects.toThrow();

    expect(m.duplicateEmail).not.toHaveBeenCalled();
    expect(m.push).not.toHaveBeenCalled();
    expect(m.failedEmail).not.toHaveBeenCalled();
  });

  it('U7e: e-mail niewysłany (Resend nieskonfigurowany) i push 0 → próba była, ale bez zapisu śladu (bez automatycznego ponowienia — dla I5D nie przyjdzie kolejne zdarzenie; wyjście: „Przypomnij klientowi”, karta pokazuje 0 ×)', async () => {
    m.duplicateEmail.mockResolvedValue({ sent: false, reason: 'not-configured' });
    m.push.mockResolvedValue({ sent: 0, failed: 0 });

    const result = await runNotifyFailure(failedEvent(), ctx());

    expect(m.duplicateEmail).toHaveBeenCalledTimes(1);
    expect(notices()).toEqual([]);
    expect(result).toMatchObject({ notified: false, emailed: false });
    expect(m.failedEmail).not.toHaveBeenCalled();
  });

  it('U7f: zapis śladu pada po e-mailu → krok rzuca; ponowienie od zera wysyła z TYM SAMYM kluczem (Resend deduplikuje) i zapisuje ślad', async () => {
    m.failInsert.add('audit_logs');

    await expect(runNotifyFailure(failedEvent(), ctx())).rejects.toThrow();
    expect(m.duplicateEmail).toHaveBeenCalledTimes(1);
    expect(notices()).toEqual([]);

    m.failInsert.delete('audit_logs');
    await runNotifyFailure(failedEvent(), ctx());

    expect(m.duplicateEmail).toHaveBeenCalledTimes(2);
    expect(m.duplicateEmail.mock.calls.map((call) => (call[2] as { idempotencyKey?: string }).idempotencyKey)).toEqual([KEY, KEY]);
    expect(notices()).toHaveLength(1);
  });
});

describe('U7i–U7k: odczyt właściciela i jego e-maila — błąd to nie „brak właściciela” (przegląd PR B, #1/#4)', () => {
  // Powiadomienie automatyczne jest jedno: dla I5D nie przyjdzie kolejne zdarzenie.
  // Chwilowy błąd odczytu musi więc rzucić (pg-boss ponowi zadanie, maxRetries 2),
  // a nie zakończyć je jako „nie ma do kogo wysłać”.
  it('U7i: odczyt właściciela (memberships) pada → krok rzuca; bez e-maila, pusha i śladu', async () => {
    m.failRead.add('memberships');

    const thrown = await runNotifyFailure(failedEvent(), ctx()).then(() => null, (e: unknown) => e);
    expect(String(thrown)).toMatch(/właściciel/);
    // Dłuższa awaria (restart kontenera) nie zjada jedynego powiadomienia w ~40 s
    // domyślnego odstępu: kolejna próba za 5 min.
    expect(thrown).toBeInstanceOf(RetryAfterError);
    expect((thrown as RetryAfterError).retryAfterMs).toBe(5 * 60_000);

    expect(m.duplicateEmail).not.toHaveBeenCalled();
    expect(m.push).not.toHaveBeenCalled();
    expect(notices()).toEqual([]);
    expect(m.failedEmail).not.toHaveBeenCalled();
  });

  it('U7j: odczyt e-maila właściciela (GoTrue 503) pada → krok rzuca; bez e-maila, pusha i śladu', async () => {
    m.authError = { name: 'AuthRetryableFetchError', status: 503, message: 'Service Unavailable' };

    const thrown = await runNotifyFailure(failedEvent(), ctx()).then(() => null, (e: unknown) => e);
    expect(String(thrown)).toMatch(/e-mail/);
    expect(thrown).toBeInstanceOf(RetryAfterError);
    expect((thrown as RetryAfterError).retryAfterMs).toBe(5 * 60_000);

    expect(m.authCalls).toEqual([OWNER]);
    expect(m.duplicateEmail).not.toHaveBeenCalled();
    expect(m.push).not.toHaveBeenCalled();
    expect(notices()).toEqual([]);
  });

  it('U7k: firma bez aktywnego właściciela (prawdziwy brak) → bez rzucania, bez e-maila, pusha i śladu — jak dotąd', async () => {
    m.tables.memberships = [
      { organization_id: T, user_id: OWNER, role: 'owner', status: 'removed', joined_at: '2026-01-02T08:00:00.000Z' },
    ];

    const result = await runNotifyFailure(failedEvent(), ctx());

    expect(result).toMatchObject({ notified: false, emailed: false, push: { skipped: true, reason: 'no-owner' } });
    expect(m.authCalls).toEqual([]);
    expect(m.duplicateEmail).not.toHaveBeenCalled();
    expect(m.push).not.toHaveBeenCalled();
    expect(notices()).toEqual([]);
  });

  it.each([
    ['konta nie ma w GoTrue (404 user_not_found)', () => { m.authUsers = {}; }],
    ['konto bez adresu e-mail', () => { m.authUsers = { [OWNER]: { email: null } }; }],
  ] as const)('U7k: %s → bez rzucania i bez e-maila; push do właściciela idzie, ślad emailed:false — jak dotąd', async (_l, arrange) => {
    arrange();

    const result = await runNotifyFailure(failedEvent(), ctx());

    expect(result).toMatchObject({ notified: true, emailed: false });
    expect(m.duplicateEmail).not.toHaveBeenCalled();
    expect(m.push).toHaveBeenCalledTimes(1);
    expect(m.push).toHaveBeenCalledWith(OWNER, 'invoice_rejected', expect.objectContaining({ url: `/invoices/${ID}` }));
    expect(notices()).toHaveLength(1);
    expect(notices()[0]).toMatchObject({ metadata: expect.objectContaining({ emailed: false, push_sent: 1, via: 'auto' }) });
  });
});

describe('U7g–U7h: kiedy powiadomienia o decyzji nie ma', () => {
  it('U7g: oryginał sprawdzony w środowisku production, a KSEF_ENV=test → powód duplicate-env, bez e-maila i zapisu (operator dostaje I5D-env)', async () => {
    seed({ check: { env: 'production' } });

    const result = await runNotifyFailure(failedEvent(), ctx());

    expect(result).toMatchObject({ skipped: true, reason: 'duplicate-env' });
    expect(m.duplicateEmail).not.toHaveBeenCalled();
    expect(m.push).not.toHaveBeenCalled();
    expect(notices()).toEqual([]);
  });

  it.each([
    ['faktura już w szkicu (blokada not-pending)', 'not-pending', { ksef_status: 'draft', last_error_code: null }],
    ['wpłaty na dokumencie (blokada payments)', 'payments', {}],
  ] as const)('U7g strażnik: %s → pominięte jak dotąd (manual-reconciliation), bez e-maila i zapisu', async (_l, blocker, invoice) => {
    seed({ invoice });
    m.blocker = blocker;

    const result = await runNotifyFailure(failedEvent(), ctx());

    expect(result).toMatchObject({ skipped: true, reason: 'manual-reconciliation' });
    expect(m.duplicateEmail).not.toHaveBeenCalled();
    expect(m.push).not.toHaveBeenCalled();
    expect(m.failedEmail).not.toHaveBeenCalled();
    expect(notices()).toEqual([]);
  });

  it.each([
    ['ROZ_HOLD_RECONCILE', { errorCode: 'ROZ_HOLD_RECONCILE' }],
    ['bez errorCode (stary worker)', { errorCode: undefined }],
  ] as const)('U7h strażnik: %s → pominięte jak dotąd, bez pytania o blokadę decyzji', async (_l, extra) => {
    const result = await runNotifyFailure(failedEvent(extra), ctx());

    expect(result).toMatchObject({ skipped: true, reason: 'manual-reconciliation' });
    expect(m.rpcCalls.filter((c) => c.fn === 'ksef_duplicate_decision_blocker')).toEqual([]);
    expect(m.duplicateEmail).not.toHaveBeenCalled();
    expect(m.push).not.toHaveBeenCalled();
    expect(notices()).toEqual([]);
  });
});

/**
 * D-A4-1b-3 PR C (spec v3 5.7, INV-24; 7.2): wariant e-maila i pusha pochodzi
 * z TEJ SAMEJ funkcji oferty co panel (`duplicateNoticeVariant`), z własną
 * historią liczoną z kolumn wpisów, które czyta panel (`session_reference_number`,
 * `request_payload_hash`, `original_session_reference_number`) — nigdy `null` w miejscu
 * `ownHistoryDb`. W przeglądzie pliku (blokada `provenance-review`) klient dostaje
 * RAZ „sprawdzamy” (własny klucz i rodzina śladu), nigdy „czeka na Twoją decyzję”,
 * bez karty FLO i bez e-maila „odrzucona”. Na HEAD e-mail nie niesie `variant`,
 * a każda blokada oprócz NULL kończy się ścieżką ogólną.
 */
const FF = DUPLICATE_DECISION_TEXTS.FAKTFLOW;
const SHA = 'bb'.repeat(32);
const OPERATOR_ID = '99999999-9999-4999-8999-999999999999';
const GATE_IMPORTABLE: Row = { v: 1, rules: ORIGINAL_GATE_RULES, kind: 'importable', problems: [], preview: null };
const GATE_REVIEW: Row = { v: 1, rules: ORIGINAL_GATE_RULES, kind: 'review', problems: ['rates'], preview: null };
const GATE_RELEASED: Row = {
  ...GATE_REVIEW,
  release: { at: '2026-10-07T09:00:00.000Z', via: 'operator', actorUserId: OPERATOR_ID, note: 'Plik sprawdzony: nie powstał w FaktFlow.' },
};
/** Znacznik `faktflow-original` z plikiem FaktFlow i oceną pliku (00149). */
const faktflowCheck = (extra: Row = {}): Row => ({
  reason: 'faktflow-original',
  summary: { systemInfo: 'KSeF SaaS v1.0', number: NUMBER, issueDate: '2026-10-07', buyerNip: '5252241585', buyerName: 'Klient', gross: '123.00', currency: 'PLN' },
  sameContentExceptHeader: false,
  ownHistory: false,
  importGate: GATE_IMPORTABLE,
  ...extra,
});
/** Wpis X z próbą wysyłki: sesja i/albo skrót pliku (kolumny, z których panel liczy własną historię w bazie). */
const attempt = (extra: Row): Row => ({
  id: 'sub-proba', tenant_id: T, invoice_id: ID, status: 'abandoned', original_ksef_number: null,
  session_reference_number: 'S-PROBA', request_payload_hash: null, attempted_at: '2026-10-05T08:00:00.000Z', ...extra,
});
const reviewNotice = (createdAt = '2026-10-07T09:00:00.000Z'): Row => ({
  id: 'notice-review', tenant_id: T, user_id: null, action: ACTION, entity_type: 'invoice', entity_id: ID,
  metadata: {
    original_ksef_number: K, via: 'auto', idempotency_key: `${KEY}/sprawdzamy`, variant: 'review',
    emailed: true, push_sent: 1, reminder: null, operator: null, source: 'system',
  },
  created_at: createdAt,
});
const lastNotice = () => notices().at(-1) as { metadata: Row } | undefined;

describe('D-A4-1b-3 PR C: wariant powiadomienia o decyzji = oferta panelu (INV-24)', () => {
  it.each([
    ['powód PR B (no-own-file)', () => seed()],
    ['FO-PARA: brama importable, ownHistory=false w JSON i brak historii w bazie', () => seed({ check: faktflowCheck() })],
  ])('%s → wariant pair: tekst PR B, e-mail z variant "pair", ślad niesie wariant', async (_label, arrange) => {
    arrange();

    const result = await runNotifyFailure(failedEvent(), ctx());

    expect(result).toMatchObject({ notified: true, emailed: true });
    expect(m.duplicateEmail).toHaveBeenCalledTimes(1);
    expect(m.duplicateEmail).toHaveBeenCalledWith(
      OWNER_EMAIL,
      expect.objectContaining({ invoiceId: ID, invoiceNumber: NUMBER, ksefNumber: K, reminder: false, variant: 'pair' }),
      expect.objectContaining({ idempotencyKey: KEY }),
    );
    expect(m.push).toHaveBeenCalledWith(OWNER, 'invoice_rejected', {
      title: DUPLICATE_DECISION_TEXTS.NOTICE.PUSH_TITLE(NUMBER),
      body: DUPLICATE_DECISION_TEXTS.NOTICE.PUSH_BODY,
      url: `/invoices/${ID}`,
      tag: `invoice-${ID}`,
    });
    expect(notices()).toHaveLength(1);
    expect(lastNotice()?.metadata).toMatchObject({ original_ksef_number: K, variant: 'pair', idempotency_key: KEY, via: 'auto' });
  });

  it.each([
    ['ta sama treść (sameContentExceptHeader=true)', () => seed({ check: faktflowCheck({ sameContentExceptHeader: true }) })],
    ['ownHistory=true w JSON znacznika', () => seed({ check: faktflowCheck({ ownHistory: true }) })],
    [
      'JSON ownHistory=false, a skrót oryginału jest w request_payload_hash próby X (T3: historia w bazie, nie null)',
      () => seed({ check: faktflowCheck(), submissions: [attempt({ request_payload_hash: SHA })] }),
    ],
    [
      'JSON ownHistory=false, a sesja oryginału jest sesją próby X (historia w bazie)',
      () => seed({ check: faktflowCheck(), submissions: [attempt({ session_reference_number: 'S-OBCA' })] }),
    ],
  ])('%s → wariant record: e-mail z variant "record", push o zapisie faktury z KSeF', async (_label, arrange) => {
    arrange();

    const result = await runNotifyFailure(failedEvent(), ctx());

    expect(result).toMatchObject({ notified: true, emailed: true });
    expect(m.duplicateEmail).toHaveBeenCalledTimes(1);
    expect(m.duplicateEmail).toHaveBeenCalledWith(
      OWNER_EMAIL,
      expect.objectContaining({ ksefNumber: K, reminder: false, variant: 'record' }),
      expect.objectContaining({ idempotencyKey: KEY }),
    );
    expect(m.push).toHaveBeenCalledWith(OWNER, 'invoice_rejected', expect.objectContaining({
      body: FF.NOTICE_PUSH_BODY_RECORD,
      url: `/invoices/${ID}`,
      tag: `invoice-${ID}`,
    }));
    expect(lastNotice()?.metadata).toMatchObject({ variant: 'record', idempotency_key: KEY });
  });

  it('FO-ODDANA (operator oddał decyzję: importGate.release) → wariant released, ten sam klucz „raz na (fakturę, K)”', async () => {
    seed({ check: faktflowCheck({ importGate: GATE_RELEASED }) });

    const result = await runNotifyFailure(failedEvent(), ctx());

    expect(result).toMatchObject({ notified: true, emailed: true });
    expect(m.duplicateEmail).toHaveBeenCalledWith(
      OWNER_EMAIL,
      expect.objectContaining({ ksefNumber: K, reminder: false, variant: 'released' }),
      expect.objectContaining({ idempotencyKey: KEY }),
    );
    expect(lastNotice()?.metadata).toMatchObject({ variant: 'released', idempotency_key: KEY });
  });
});

describe('D-A4-1b-3 PR C: przegląd pliku (provenance-review) — klient dostaje raz „sprawdzamy”, nie „czeka na decyzję”', () => {
  const REVIEW_KEY = `${KEY}/sprawdzamy`;
  const reviewEvent = () => failedEvent({ error: FF.LAST_ERROR_REVIEW(K) });
  const seedReview = (over: { notices?: Row[] } = {}) => {
    seed({ check: faktflowCheck({ importGate: GATE_REVIEW }), notices: over.notices });
    m.blocker = 'provenance-review';
  };

  it('blokada provenance-review → jeden e-mail variant "review" z własnym kluczem, push „sprawdzamy”, ślad rodziny review; bez karty FLO i maila „odrzucona”', async () => {
    seedReview();

    const result = await runNotifyFailure(reviewEvent(), ctx());

    expect(result).not.toHaveProperty('pending');
    expect(result).toMatchObject({ notified: true, emailed: true });
    expect(m.duplicateEmail).toHaveBeenCalledTimes(1);
    expect(m.duplicateEmail).toHaveBeenCalledWith(
      OWNER_EMAIL,
      expect.objectContaining({ invoiceId: ID, invoiceNumber: NUMBER, ksefNumber: K, reminder: false, variant: 'review' }),
      expect.objectContaining({ idempotencyKey: REVIEW_KEY }),
    );
    expect(m.push).toHaveBeenCalledTimes(1);
    expect(m.push).toHaveBeenCalledWith(OWNER, 'invoice_rejected', {
      title: FF.NOTICE_PUSH_TITLE_REVIEW(NUMBER),
      body: FF.NOTICE_PUSH_BODY_REVIEW,
      url: `/invoices/${ID}`,
      tag: `invoice-${ID}`,
    });
    expect(notices()).toHaveLength(1);
    expect(lastNotice()?.metadata).toMatchObject({
      original_ksef_number: K, variant: 'review', idempotency_key: REVIEW_KEY, via: 'auto', emailed: true, push_sent: 1,
    });
    expect(m.proposal).not.toHaveBeenCalled();
    expect(m.failedEmail).not.toHaveBeenCalled();
    expect(m.rpcCalls).toContainEqual({ fn: 'ksef_duplicate_decision_blocker', args: { p_invoice_id: ID, p_tenant_id: T } });
  });

  it('raz na (fakturę, K): drugie zdarzenie w przeglądzie → already-notified, bez e-maila, pusha i zapisu', async () => {
    seedReview({ notices: [reviewNotice()] });

    const result = await runNotifyFailure(reviewEvent(), ctx());

    expect(result).toMatchObject({ skipped: true, reason: 'already-notified' });
    expect(m.duplicateEmail).not.toHaveBeenCalled();
    expect(m.push).not.toHaveBeenCalled();
    expect(notices()).toHaveLength(1);
    expect(m.proposal).not.toHaveBeenCalled();
    expect(m.failedEmail).not.toHaveBeenCalled();
  });

  it('ślad „sprawdzamy” nie blokuje późniejszego powiadomienia o decyzji (po oddaniu: blokada NULL, wariant released)', async () => {
    seed({ check: faktflowCheck({ importGate: GATE_RELEASED }), notices: [reviewNotice()] });
    m.blocker = null;

    const result = await runNotifyFailure(failedEvent(), ctx());

    expect(result).toMatchObject({ notified: true, emailed: true });
    expect(m.duplicateEmail).toHaveBeenCalledTimes(1);
    expect(m.duplicateEmail).toHaveBeenCalledWith(
      OWNER_EMAIL,
      expect.objectContaining({ ksefNumber: K, variant: 'released' }),
      expect.objectContaining({ idempotencyKey: KEY }),
    );
    expect(notices().map((r) => (r.metadata as Row).variant)).toEqual(['review', 'released']);
  });

  it('ślad powiadomienia o decyzji (bez wariantu, sprzed PR C) nie blokuje „sprawdzamy” — rodziny śladów są osobne', async () => {
    seedReview({ notices: [notice(K)] });

    const result = await runNotifyFailure(reviewEvent(), ctx());

    expect(result).toMatchObject({ notified: true, emailed: true });
    expect(m.duplicateEmail).toHaveBeenCalledTimes(1);
    expect(m.duplicateEmail).toHaveBeenCalledWith(
      OWNER_EMAIL,
      expect.objectContaining({ variant: 'review' }),
      expect.objectContaining({ idempotencyKey: REVIEW_KEY }),
    );
    expect(notices()).toHaveLength(2);
  });

  it('e-mail niewysłany i push 0 → próba była, bez śladu (jak przy decyzji: kolejne zdarzenie może ponowić)', async () => {
    seedReview();
    m.duplicateEmail.mockResolvedValue({ sent: false, reason: 'not-configured' });
    m.push.mockResolvedValue({ sent: 0, failed: 0 });

    const result = await runNotifyFailure(reviewEvent(), ctx());

    expect(result).toMatchObject({ notified: false, emailed: false });
    expect(notices()).toEqual([]);
    expect(m.failedEmail).not.toHaveBeenCalled();
    expect(m.proposal).not.toHaveBeenCalled();
  });
});

describe('D-A4-1b-3 PR C: inne blokady faktflow-original — bez powiadomienia o decyzji (ścieżka ogólna jak dziś)', () => {
  // Strażnik (zielony na HEAD z założenia: spec 5.7 „jak dziś”, `{ pending: false }`): recheck-needed, known-now
  // i cross-tenant nie obiecują decyzji — faktura jest w I5 (cron robi nowy werdykt) albo czeka na runbook.
  it.each([
    ['recheck-needed (znacznik bez oceny pliku, sprzed 00149)', 'recheck-needed', () => seed({ check: faktflowCheck({ importGate: undefined }) })],
    ['recheck-needed (trwały znacznik recheckNeeded po odmowie w chwili zapisu)', 'recheck-needed', () => seed({
      check: faktflowCheck({ recheckNeeded: { kind: 'gate-drift', at: '2026-10-07T08:30:00.000Z' } }),
    })],
    ['known-now (K ma już inna faktura tej firmy)', 'known-now', () => seed({ check: faktflowCheck() })],
    ['cross-tenant (K albo numer X ma faktura innej firmy z tym NIP)', 'cross-tenant', () => seed({ check: faktflowCheck() })],
  ])('strażnik: %s → ścieżka ogólna (manual-reconciliation), bez e-maila o decyzji, pusha i śladu', async (_label, blocker, arrange) => {
    arrange();
    m.blocker = blocker;

    const result = await runNotifyFailure(failedEvent({ error: FF.LAST_ERROR(K) }), ctx());

    expect(result).toMatchObject({ skipped: true, reason: 'manual-reconciliation' });
    expect(m.duplicateEmail).not.toHaveBeenCalled();
    expect(m.push).not.toHaveBeenCalled();
    expect(notices()).toEqual([]);
    expect(m.failedEmail).not.toHaveBeenCalled();
    expect(m.rpcCalls).toContainEqual({ fn: 'ksef_duplicate_decision_blocker', args: { p_invoice_id: ID, p_tenant_id: T } });
  });
});

import { inspect } from 'node:util';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Invoice } from '@/types/invoice';
import type { FakeKsef, MemoryDb, Row } from './helpers/ksef-pelna-sciezka';

/**
 * F-093-STATUS (z przeglądu PR #560, 10.11.2026). Gdy KSeF odrzuca fakturę
 * w statusie (kod 400–499 poza 440), `KsefInvoiceRejectedError` wklejał do
 * komunikatu błędu `status.description` i wszystkie `status.details` z KSeF.
 * Walidator KSeF może tam powtarzać wartości z dokumentu (NIP i nazwę
 * nabywcy), a komunikat szedł do kanałów operatora i telemetrii:
 * `ksef_submissions.error_message`, Sentry (podprocesor), log workera,
 * `inngest_run_log`, dziennik prób `ksef_send_attempts` i `audit_logs`.
 * Reguła projektu (`lib/ksef/history-sync/errors.ts`, `lib/observability/scrub.ts`):
 * operator dostaje status i kody, nigdy treść odpowiedzi.
 *
 * Klient tę treść dostaje dalej: to jego faktura i jedyna wskazówka, co
 * poprawić (karta faktury czyta `invoices.last_error`, e-mail „odrzucona”
 * bierze `error` ze zdarzenia `invoice/submit.failed`).
 *
 * Ścieżka prawdziwa: job zarejestrowany w `handlers/package-d.ts` →
 * `wrapHandler` (pg-boss, dziennik prób, `inngest_run_log`, obsługa
 * wyczerpania) → runner → `submitInvoiceFullFlow` → `submitInvoice` →
 * polling statusu. Atrapy tylko dla HTTP KSeF, bazy, magazynu plików,
 * kolejki i Sentry.
 */

const T = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID = '11111111-1111-4111-8111-111111111111';
const ATTEMPT = '22222222-2222-4222-8222-222222222222';
const JOB_1 = '33333333-3333-4333-8333-333333333331';
const NUMBER = 'FV 2026/11/001';

/** Opis i szczegół odrzucenia: fikcyjny nabywca, którego nie ma nigdzie indziej w teście. */
const OPIS = 'Błąd weryfikacji semantyki dokumentu faktury';
const SZCZEGOL = 'Nabywca Wartownik Testowy, NIP 9876543210: wartość pola P_15 niezgodna z sumą pozycji';
const ODRZUCENIE = { code: 450, description: OPIS, details: [SZCZEGOL] };
/** Wolny tekst z KSeF, którego nie może być w żadnym kanale operatora. */
const TRESC_KSEF = ['Wartownik', '9876543210', OPIS];
/** Tekst operatora: status i kod, bez treści odpowiedzi. */
const TEKST_OPERATORA = 'KSeF odrzucił fakturę (status 450)';
/** Co klient widział na karcie faktury i w mailu przed naprawą; ma zostać bez zmian. */
const TEKST_KLIENTA = `NonRetriableError: KSeF odrzucił fakturę: ${OPIS}. Szczegóły: ${SZCZEGOL}`;

const m = vi.hoisted(() => ({
  ksef: null as unknown as FakeKsef,
  mem: { db: {}, failWrite: null } as MemoryDb,
  storage: new Map<string, string>(),
  /** Wiersz faktury czytany i zmieniany przez runner (`@/lib/supabase/server`). */
  invoice: {} as Record<string, unknown>,
  /** Tabela `ksef_send_attempts` po zapisach (id → wiersz). */
  ledger: new Map<string, Record<string, unknown>>(),
  nextId: 0,
  audit: vi.fn(),
  sendEvents: vi.fn(),
  bossSend: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  addBreadcrumb: vi.fn(),
}));

vi.mock('@/lib/ksef/client', async (orig) =>
  (await import('./helpers/ksef-pelna-sciezka')).ksefClientModule(await orig(), () => m.ksef));
vi.mock('@/lib/ksef/encryption', async () => (await import('./helpers/ksef-pelna-sciezka')).encryptionModule());
vi.mock('@/lib/supabase/admin', async () => (await import('./helpers/ksef-pelna-sciezka')).adminClientModule(() => m.mem));
vi.mock('@/lib/ksef/session-cache', () => ({
  ksefSessionCache: { getSession: async () => ({ accessToken: 'token' }), invalidate: vi.fn() },
}));
vi.mock('@/lib/ksef/rate-limiter', () => ({
  ksefRateLimiter: { enqueue: (_nip: string, fn: () => unknown) => fn() },
}));
vi.mock('@/lib/storage/r2-client', () => ({ getR2Config: () => ({ bucketName: 'b' }), getR2Client: () => ({ send: vi.fn() }) }));
vi.mock('@/lib/storage/r2', async (orig) => {
  const real = await orig<typeof import('@/lib/storage/r2')>();
  return {
    ...real,
    uploadInvoiceXml: async (tenantId: string, invoiceId: string, issueDate: string, xml: string, o?: { attemptId?: string | null }) => {
      const storagePath = real.invoiceXmlKeyFor({ tenantId, invoiceId, issueDate, attemptId: o?.attemptId });
      m.storage.set(storagePath, xml);
      const { sha256Hex } = await import('./helpers/ksef-pelna-sciezka');
      return { storagePath, sha256Hash: sha256Hex(xml), sizeBytes: xml.length, etag: '"e"' };
    },
    downloadInvoiceXml: async (path: string) => {
      const xml = m.storage.get(path);
      if (xml === undefined) throw new Error(`brak pliku ${path}`);
      return xml;
    },
  };
});
vi.mock('@/lib/auth/ksef-verification-guard', () => ({
  requireKsefVerificationForBackgroundJob: vi.fn(async () => undefined),
  KsefNotVerifiedError: class KsefNotVerifiedError extends Error {},
}));
vi.mock('@/lib/ksef/xml-generated-at', () => ({ claimXmlGeneratedAt: async () => new Date('2026-11-02T10:00:00.000Z') }));
vi.mock('@/lib/xml/validator', () => ({ validateInvoiceXml: async () => ({ valid: true, errors: [] }), InvoiceXmlSchemaError: class extends Error {} }));
vi.mock('@/lib/feature-flags/global-flags', () => ({ getGlobalFlagForExecution: async () => false }));
vi.mock('@/lib/audit/log-system', () => ({ logAuditSystem: m.audit }));
vi.mock('@/lib/ksef/health-check', () => ({ shouldUseOfflineMode: async () => ({ offline: false }) }));
vi.mock('@/lib/ksef/health-status', () => ({ isKsefHealthy: async () => true }));
vi.mock('@/lib/ksef/offline-queue', () => ({ addToOfflineQueue: vi.fn() }));
vi.mock('@/lib/ksef/submit-reference-boundary', () => ({ assertSubmitReferences: async () => 'regular' }));
vi.mock('@/lib/jobs/runners/tenant-boundary', () => ({ requireInvoiceTenant: vi.fn(), assertJobIdentity: vi.fn() }));
vi.mock('@/lib/supabase/admin-queries', async (orig) => ({
  ...await orig<typeof import('@/lib/supabase/admin-queries')>(),
  getTenantKsefCredentials: async () => ({ type: 'token', nip: '1234567890', token: 't' }),
  updateInvoiceStatus: vi.fn(),
}));

/** `ksef_send_attempts` jak tabela (dziennik prób, A5). */
function ledgerQuery() {
  let pending: { op: 'insert'; row: Row } | { op: 'update'; patch: Row } | null = null;
  const filters: Row = {};
  const apply = () => {
    if (pending?.op === 'insert') {
      const id = `row-${++m.nextId}`;
      m.ledger.set(id, { ...pending.row, id });
      return { data: { id }, error: null };
    }
    if (pending?.op === 'update') {
      const target = m.ledger.get(String(filters.id));
      if (target) Object.assign(target, pending.patch);
      return { data: target ? { id: filters.id } : null, error: null };
    }
    return { data: null, error: null };
  };
  const q = {
    insert: (row: Row) => { pending = { op: 'insert', row }; return q; },
    update: (patch: Row) => { pending = { op: 'update', patch }; return q; },
    select: () => q,
    eq: (column: string, value: unknown) => { filters[column] = value; return q; },
    abortSignal: () => q,
    single: async () => apply(),
    maybeSingle: async () => apply(),
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(apply()).then(resolve),
  };
  return q;
}

/** Wiersz faktury: odczyt stanu i warunkowe zapisy runnera trafiają do `m.invoice`. */
function invoiceQuery() {
  let patch: Row | null = null;
  const q = {
    select: () => q,
    eq: () => q,
    in: () => q,
    or: () => q,
    update: (p: Row) => { patch = p; return q; },
    maybeSingle: async () => {
      if (patch) { Object.assign(m.invoice, patch); return { data: { id: ID }, error: null }; }
      return { data: { ...m.invoice }, error: null };
    },
    then: (resolve: (v: unknown) => unknown) => {
      if (patch) Object.assign(m.invoice, patch);
      return Promise.resolve({ data: null, error: null }).then(resolve);
    },
  };
  return q;
}

vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: async () => ({
    from: (table: string) => (table === 'ksef_send_attempts' ? ledgerQuery() : invoiceQuery()),
    rpc: async (fn: string) => {
      if (fn === 'claim_ksef_send') return { data: '2026-11-02T12:00:00.000000+00:00', error: null };
      if (fn === 'ksef_has_contact_evidence') {
        const rows = (m.mem.db.ksef_submissions ?? []) as Row[];
        return { data: rows.some((r) => ['intent', 'sent', 'accepted', 'duplicate'].includes(String(r.status))), error: null };
      }
      return { data: null, error: null };
    },
  }),
}));
vi.mock('@/lib/storage/xml-documents', () => ({ recordXmlDocument: vi.fn() }));
vi.mock('@/lib/cache/invalidation', () => ({ invalidateTenantDashboard: vi.fn() }));
vi.mock('@/lib/analytics/server', () => ({ trackServer: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({
  captureException: m.captureException,
  captureMessage: m.captureMessage,
  addBreadcrumb: m.addBreadcrumb,
}));
vi.mock('@/lib/jobs/boss', () => ({ startBoss: async () => ({ send: m.bossSend }) }));
vi.mock('@/lib/jobs/enqueue', () => ({ sendJobEvents: m.sendEvents, sendJobEvent: vi.fn() }));

import '@/lib/jobs/handlers/package-d';
import { getRegisteredJobs } from '@/lib/jobs/registry';
import { wrapHandler } from '@/lib/jobs/run-job';
import { finalizeInvoice } from '@/lib/xml/invoice-calculator';
import { freshKsef } from './helpers/ksef-pelna-sciezka';

const submitJob = getRegisteredJobs().find((j) => j.queue === 'invoice.submit.requested');
if (!submitJob) throw new Error('fixture: brak joba invoice.submit.requested w rejestrze');
const run = wrapHandler(submitJob);

const faktura = () => finalizeInvoice({
  internalNumber: NUMBER,
  type: 'VAT',
  issueDate: '2026-11-02',
  saleDate: '2026-11-02',
  seller: { nip: '5260001246', name: 'ACME', address: { countryCode: 'PL', addressLine1: 'ul. A 1', addressLine2: '00-001 Warszawa' } },
  buyer: { nip: '5252241585', name: 'Klient', address: { countryCode: 'PL', addressLine1: 'ul. B 2', addressLine2: '02-001 Warszawa' } },
  lines: [{ ordinal: 1, name: 'Usługa', unit: 'usł.', quantity: 1, unitPriceNet: 100, vatRate: '23' }],
  payment: { currency: 'PLN', dueDate: '2026-11-16', method: 'transfer', bankAccount: 'PL61109010140000071219812874' },
});

function job(extra: Record<string, unknown> = {}) {
  return {
    id: JOB_1,
    name: 'invoice.submit.requested',
    data: {
      invoiceId: ID, tenantId: T, nip: '1234567890', environment: 'test' as const,
      sendAttemptId: ATTEMPT, invoice: faktura() as Invoice, ...extra,
    },
    groupId: T, expireInSeconds: 900, heartbeatSeconds: null, signal: new AbortController().signal,
  };
}

const submissions = () => (m.mem.db.ksef_submissions ?? []) as Row[];
const consoleSpies: Array<{ mock: { calls: unknown[][] } }> = [];

/** To, co pokaże zwykła serializacja (log, JSON, Sentry): komunikat, stos, pola wyliczalne, `cause`. */
const widoczne = (value: unknown) => {
  let json = '';
  try { json = JSON.stringify(value) ?? ''; } catch { json = ''; }
  return `${inspect(value, { depth: 8 })}\n${json}`;
};

/** Kanały operatora i telemetrii: nazwa kanału → tekst, który tam trafił. */
function kanalyOperatora(): Array<[string, string]> {
  return [
    ...submissions().map((r): [string, string] => ['ksef_submissions.error_message', String(r.error_message ?? '')]),
    ...((m.mem.db.inngest_run_log ?? []) as Row[]).map((r): [string, string] => ['inngest_run_log.error_message', String(r.error_message ?? '')]),
    ...[...m.ledger.values()].map((r): [string, string] => ['ksef_send_attempts.error_message', String(r.error_message ?? '')]),
    ...m.audit.mock.calls.map((args): [string, string] => ['audit_logs (logAuditSystem)', widoczne(args)]),
    ...m.captureException.mock.calls.map((args): [string, string] => ['Sentry.captureException', widoczne(args)]),
    ...m.captureMessage.mock.calls.map((args): [string, string] => ['Sentry.captureMessage', widoczne(args)]),
    ...m.addBreadcrumb.mock.calls.map((args): [string, string] => ['Sentry.addBreadcrumb', widoczne(args)]),
    ...consoleSpies.flatMap((spy) => spy.mock.calls.map((args): [string, string] => ['log workera (console)', widoczne(args)])),
  ];
}

const wycieki = () => kanalyOperatora()
  .filter(([, text]) => TRESC_KSEF.some((t) => text.includes(t)))
  .map(([kanal, text]) => `${kanal}: ${text.slice(0, 240)}`);

const zdarzeniePorazki = () => m.sendEvents.mock.calls
  .flatMap(([events]) => events as Array<{ name: string; data: Row }>)
  .find((e) => e.name === 'invoice/submit.failed');

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('KSEF_ENV', 'test');
  m.ksef = freshKsef();
  m.mem = { db: { ksef_submissions: [], invoices: [], inngest_run_log: [] }, failWrite: null };
  m.storage = new Map();
  m.ledger = new Map();
  m.nextId = 0;
  m.invoice = {
    id: ID, direction: 'outgoing', ksef_status: 'queued', ksef_number: null, ksef_environment: 'test',
    invoice_type: 'VAT', invoice_kind: 'regular', internal_number: NUMBER, fa3_data: {},
  };
  m.bossSend.mockResolvedValue('retry-job');
  m.sendEvents.mockResolvedValue({ ids: ['e1'] });
  consoleSpies.length = 0;
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    consoleSpies.push(vi.spyOn(console, level).mockImplementation(() => {}));
  }
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('F-093-STATUS: odrzucenie w statusie przy nowej wysyłce', () => {
  beforeEach(() => {
    m.ksef.statusRejection = ODRZUCENIE;
  });

  it('kanały operatora i telemetrii: bez opisu i szczegółów z KSeF', async () => {
    await run([job()] as never);

    expect(m.ksef.invoicePosts).toBe(1);
    expect(wycieki()).toEqual([]);
  });

  it('operator dostaje status i kod: historia wysyłki, dziennik prób, Sentry', async () => {
    await run([job()] as never);

    expect(submissions()).toEqual([
      expect.objectContaining({ status: 'rejected', error_code: '450', error_message: TEKST_OPERATORA }),
    ]);
    expect([...m.ledger.values()]).toEqual([
      expect.objectContaining({ status: 'failed', ksef_code: 450, error_code: 'KSEF_REJECTED', retryable: false }),
    ]);
    // Dziennik maskuje każdą liczbę (`sendAttemptMessage`); kod jest w kolumnie `ksef_code`.
    expect(String([...m.ledger.values()][0]!.error_message)).toBe('NonRetriableError: KSeF odrzucił fakturę (status <n>)');
    expect(m.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'KsefInvoiceRejectedError', message: TEKST_OPERATORA }),
      expect.objectContaining({ extra: expect.objectContaining({ ksefStatusCode: 450 }) }),
    );
    expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'invoice.submit_failed',
      metadata: expect.objectContaining({ errorCode: 'KSEF_REJECTED', error: `NonRetriableError: ${TEKST_OPERATORA}` }),
    }));
    expect(m.bossSend).not.toHaveBeenCalled();
  });

  it('klient: karta faktury i e-mail „odrzucona” dostają opis i szczegóły jak dotąd', async () => {
    await run([job()] as never);

    expect(m.invoice).toMatchObject({ ksef_status: 'rejected', last_error_code: 'KSEF_REJECTED', last_error: TEKST_KLIENTA });
    expect(zdarzeniePorazki()?.data).toMatchObject({ invoiceId: ID, errorCode: 'KSEF_REJECTED', error: TEKST_KLIENTA });
  });
});

describe('F-093-STATUS: odrzucenie znalezione przy uzgadnianiu wcześniejszej wysyłki', () => {
  beforeEach(() => {
    // Wcześniejsza próba: plik przyjęty, polling skończył się przed rozstrzygnięciem,
    // a KSeF potem odrzucił fakturę w statusie.
    m.ksef.sessions.set('S-9', { open: false, invoices: [{
      referenceNumber: 'I-9', invoiceNumber: NUMBER, invoiceHash: 'h9', code: 450, ksefNumber: null, xml: '<xml/>',
      rejection: { description: OPIS, details: [SZCZEGOL] },
    }] });
    m.mem.db.ksef_submissions = [{
      id: 'row-9', tenant_id: T, invoice_id: ID, submission_type: 'online', status: 'sent',
      session_reference_number: 'S-9', invoice_reference_number: 'I-9', attempted_at: new Date().toISOString(),
    }];
  });

  it('bez drugiej wysyłki; operator bez treści KSeF, klient z treścią', async () => {
    await run([job({ __attempt: 1 })] as never);

    expect(m.ksef.invoicePosts).toBe(0);
    expect(wycieki()).toEqual([]);
    expect(submissions()).toEqual([
      expect.objectContaining({ id: 'row-9', status: 'rejected', error_code: '450', error_message: TEKST_OPERATORA }),
    ]);
    expect(m.invoice).toMatchObject({ ksef_status: 'rejected', last_error_code: 'KSEF_REJECTED', last_error: TEKST_KLIENTA });
    expect(zdarzeniePorazki()?.data).toMatchObject({ error: TEKST_KLIENTA });
  });
});

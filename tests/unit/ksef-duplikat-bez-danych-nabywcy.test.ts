import { inspect } from 'node:util';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Invoice } from '@/types/invoice';
import type { FakeKsef, MemoryDb, Row } from './helpers/ksef-pelna-sciezka';

/**
 * F-093-440 (z przeglądu PR #578, 10.11.2026). Przy cudzym duplikacie 440
 * runner pobiera oryginał z KSeF, a werdykt „numer zajęty” i werdykt
 * „operator” (ta sama treść z innego programu) wklejały do komunikatu błędu
 * joba dane oryginału: nazwę i NIP nabywcy, datę, kwotę i nazwę programu
 * (`describeOriginal` w `lib/ksef/duplicate-verdict.ts`). Komunikat szedł do
 * kanałów operatora i telemetrii: log workera, `inngest_run_log`, dziennik
 * prób `ksef_send_attempts` (NIP maskowany, nazwa zostawała) i `audit_logs`.
 * Reguła projektu (`lib/ksef/history-sync/errors.ts`): operator dostaje
 * status i kody, nigdy treść dokumentu.
 *
 * Klient tekst z danymi oryginału dostaje dalej: na nim decyduje, czy to ta
 * sama sprzedaż (karta faktury czyta `invoices.last_error`, e-mail
 * „odrzucona” bierze `error` ze zdarzenia `invoice/submit.failed`, a klucz
 * idempotencji maila liczy się z tego tekstu, więc ma zostać identyczny).
 *
 * Ścieżka prawdziwa: job zarejestrowany w `handlers/package-d.ts` →
 * `wrapHandler` (pg-boss, dziennik prób, `inngest_run_log`, obsługa
 * wyczerpania) → runner → `submitInvoiceFullFlow` → polling statusu (440) →
 * pobranie oryginału → werdykt. Atrapy dla HTTP KSeF, bazy, magazynu plików,
 * kolejki i Sentry oraz dla strażników i pomocników spoza drogi komunikatu.
 */

const T = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID = '11111111-1111-4111-8111-111111111111';
const ATTEMPT = '22222222-2222-4222-8222-222222222222';
const JOB_1 = '33333333-3333-4333-8333-333333333331';
const NUMBER = 'FV 2026/11/001';
const K = 'K-OBCA';
const GENERATED_AT = new Date('2026-11-02T10:00:00.000Z');

/** Fikcyjny nabywca i program oryginału, których nie ma nigdzie indziej w teście. */
const NABYWCA = 'Wartownik Nabywca Sp. z o.o.';
const NIP_NABYWCY = '9876543210';
const PROGRAM = 'Program Wartownik 9.9';
const DATA_ORYGINALU = '2026-09-17';
const KWOTA_ORYGINALU = '7777.77';

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
    // Archiwum bajtów oryginału (`archiveImportedKsefXml`) przy werdykcie „operator”.
    uploadToR2IfAbsent: async (key: string, body: Buffer) => {
      if (m.storage.has(key)) return false;
      m.storage.set(key, body.toString('utf8'));
      return true;
    },
    downloadFromR2: async (key: string) => {
      const xml = m.storage.get(key);
      if (xml === undefined) throw new Error(`brak pliku ${key}`);
      return Buffer.from(xml, 'utf8');
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
import { KSEF_MAX_RETRIES } from '@/lib/jobs/retry-schedule';
import { wrapHandler } from '@/lib/jobs/run-job';
import { DUPLICATE_DECISION_TEXTS } from '@/lib/ksef/duplicate-decision';
import { generateFA3Xml } from '@/lib/xml/fa3-generator';
import { finalizeInvoice } from '@/lib/xml/invoice-calculator';
import { freshKsef, seedKsefInvoice, sha256Hex } from './helpers/ksef-pelna-sciezka';

const submitJob = getRegisteredJobs().find((j) => j.queue === 'invoice.submit.requested');
if (!submitJob) throw new Error('fixture: brak joba invoice.submit.requested w rejestrze');
const run = wrapHandler(submitJob);

const faktura = (buyer: { nip: string; name: string } = { nip: '5252241585', name: 'Klient' }) => finalizeInvoice({
  internalNumber: NUMBER,
  type: 'VAT',
  issueDate: '2026-11-02',
  saleDate: '2026-11-02',
  seller: { nip: '5260001246', name: 'ACME', address: { countryCode: 'PL', addressLine1: 'ul. A 1', addressLine2: '00-001 Warszawa' } },
  buyer: { ...buyer, address: { countryCode: 'PL', addressLine1: 'ul. B 2', addressLine2: '02-001 Warszawa' } },
  lines: [{ ordinal: 1, name: 'Usługa', unit: 'usł.', quantity: 1, unitPriceNet: 100, vatRate: '23' }],
  payment: { currency: 'PLN', dueDate: '2026-11-16', method: 'transfer', bankAccount: 'PL61109010140000071219812874' },
});

/** Plik, który runner wygeneruje dla faktury (ta sama data wytworzenia co w atrapie `claimXmlGeneratedAt`). */
const ourXml = (invoice: ReturnType<typeof faktura>) => generateFA3Xml(invoice as Invoice, { generatedAt: GENERATED_AT });

const withProgram = (xml: string) => xml.replace(/<SystemInfo>[^<]*<\/SystemInfo>/, `<SystemInfo>${PROGRAM}</SystemInfo>`);
const withOtherHeaderDate = (xml: string) => xml
  .replace(/<DataWytworzeniaFa>[^<]*<\/DataWytworzeniaFa>/, '<DataWytworzeniaFa>2026-09-01T08:00:00Z</DataWytworzeniaFa>');

/** Cudza faktura o tym samym numerze: inny program, inny nabywca, inna data i kwota. */
const foreignOriginal = () => withProgram(ourXml(faktura()))
  .replace(/<P_1>[^<]*<\/P_1>/, `<P_1>${DATA_ORYGINALU}</P_1>`)
  .replace(/<P_15>[^<]*<\/P_15>/, `<P_15>${KWOTA_ORYGINALU}</P_15>`)
  .replace(/<Podmiot2>[\s\S]*?<\/Podmiot2>/, (block) => block
    .replace(/<NIP>[^<]*<\/NIP>/, `<NIP>${NIP_NABYWCY}</NIP>`)
    .replace(/<Nazwa>[^<]*<\/Nazwa>/, `<Nazwa>${NABYWCA}</Nazwa>`));

function job(invoice: ReturnType<typeof faktura>, extra: Record<string, unknown> = {}) {
  return {
    id: JOB_1,
    name: 'invoice.submit.requested',
    data: {
      invoiceId: ID, tenantId: T, nip: '1234567890', environment: 'test' as const,
      sendAttemptId: ATTEMPT, invoice: invoice as Invoice, ...extra,
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

const wycieki = (tresc: readonly string[]) => kanalyOperatora()
  .filter(([, text]) => tresc.some((t) => text.includes(t)))
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

describe('F-093-440: „numer zajęty” (oryginał z innego programu, inna treść)', () => {
  /** Dane oryginału, których nie może być w żadnym kanale operatora. */
  const TRESC_ORYGINALU = [NABYWCA, 'Wartownik', NIP_NABYWCY, DATA_ORYGINALU, KWOTA_ORYGINALU, PROGRAM];
  /** Co klient widział na karcie faktury i w mailu przed naprawą; ma zostać bez zmian. */
  const TEKST_KLIENTA = DUPLICATE_DECISION_TEXTS.NUMBER_TAKEN_LAST_ERROR(
    NUMBER,
    `numer KSeF ${K}, z ${DATA_ORYGINALU}, dla ${NABYWCA}, NIP ${NIP_NABYWCY}, na ${KWOTA_ORYGINALU} PLN`,
    PROGRAM,
  );

  beforeEach(() => {
    seedKsefInvoice(m.ksef, { session: 'S-OBCA', ksefNumber: K, xml: foreignOriginal() });
  });

  it('kanały operatora i telemetrii: bez nabywcy, NIP-u, daty, kwoty i programu oryginału', async () => {
    await run([job(faktura())] as never);

    expect(m.ksef.invoicePosts).toBe(1);
    expect(m.ksef.downloads).toBe(1);
    expect(wycieki(TRESC_ORYGINALU)).toEqual([]);
  });

  it('operator dostaje kod werdyktu i numer KSeF oryginału: log, audyt, dziennik prób, inngest_run_log', async () => {
    await run([job(faktura())] as never);

    const operator = `KSeF ma już fakturę o tym numerze (numer KSeF ${K}) spoza FaktWay, o innej treści: numer zajęty.`;
    expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'invoice.submit_failed',
      metadata: expect.objectContaining({ errorCode: 'KSEF_NUMBER_TAKEN', error: operator }),
    }));
    expect([...m.ledger.values()]).toEqual([
      expect.objectContaining({ status: 'failed', error_code: 'KSEF_NUMBER_TAKEN', retryable: false }),
    ]);
    expect(String([...m.ledger.values()][0]!.error_message)).toBe(`NonRetriableError: [KSEF_NUMBER_TAKEN] ${operator}`);
    expect(m.mem.db.inngest_run_log).toEqual([
      expect.objectContaining({ status: 'failed', error_message: `[KSEF_NUMBER_TAKEN] ${operator}` }),
    ]);
    expect(submissions().map((r) => r.status)).toEqual(['number_taken']);
    expect(m.bossSend).not.toHaveBeenCalled();
  });

  it('klient: karta faktury i e-mail dostają dane oryginału jak dotąd (ten sam tekst, ten sam klucz maila)', async () => {
    await run([job(faktura())] as never);

    expect(m.invoice).toMatchObject({ ksef_status: 'failed', last_error_code: 'KSEF_NUMBER_TAKEN', last_error: TEKST_KLIENTA });
    expect(zdarzeniePorazki()?.data).toMatchObject({ invoiceId: ID, errorCode: 'KSEF_NUMBER_TAKEN', error: TEKST_KLIENTA });
  });

  /** Nasza wcześniejsza wysyłka: KSeF rozstrzygnął ją jako 440 po tym, jak polling się skończył. */
  const openSent440 = () => {
    const xml = ourXml(faktura());
    m.ksef.sessions.set('S-9', { open: false, invoices: [{
      referenceNumber: 'I-9', invoiceNumber: NUMBER, invoiceHash: Buffer.from(sha256Hex(xml), 'hex').toString('base64'),
      code: 440, ksefNumber: null, xml, originalSession: 'S-OBCA', originalKsef: K,
    }] });
    const path = `${T}/2026/11/${ID}/wczesniejsza-proba.xml`;
    m.storage.set(path, xml);
    m.mem.db.ksef_submissions = [{
      id: 'row-9', tenant_id: T, invoice_id: ID, submission_type: 'online', status: 'sent',
      session_reference_number: 'S-9', invoice_reference_number: 'I-9', request_payload_hash: sha256Hex(xml),
      xml_storage_path: path, attempted_at: new Date().toISOString(),
    }];
  };

  it('440 przy uzgadnianiu otwartego wpisu sent: ta sama weryfikacja bez wysyłki, operator bez danych oryginału', async () => {
    openSent440();

    await run([job(faktura(), { __attempt: 1 })] as never);

    expect(m.ksef.invoicePosts).toBe(0);
    expect(m.ksef.downloads).toBe(1);
    expect(wycieki(TRESC_ORYGINALU)).toEqual([]);
    expect(m.invoice).toMatchObject({ last_error_code: 'KSEF_NUMBER_TAKEN', last_error: TEKST_KLIENTA });
    expect(zdarzeniePorazki()?.data).toMatchObject({ error: TEKST_KLIENTA });
  });

  it('strażnik: oczekiwanie na pobranie oryginału (503) do wyczerpania prób, tekst klienta jak dotąd (z nazwą klasy błędu)', async () => {
    openSent440();
    m.ksef.downloadFailure = { status: 503 };

    await run([job(faktura(), { __attempt: KSEF_MAX_RETRIES })] as never);

    const tekst = 'RetryAfterError: KSeF ma już fakturę o tym numerze (numer KSeF K-OBCA), ale nie udało się pobrać jej treści ' +
      'do porównania (HTTP 503). Do uzgodnienia; nie wystawiaj faktury ponownie.';
    expect(m.bossSend).not.toHaveBeenCalled();
    expect(m.invoice).toMatchObject({ last_error_code: 'KSEF_DUPLICATE_RECONCILE', last_error: tekst });
    expect(zdarzeniePorazki()?.data).toMatchObject({ error: tekst });
  });
});

describe('F-093-440: werdykt „operator” (ta sama treść z innego programu)', () => {
  /** Ta sama sprzedaż: nabywca oryginału to nabywca naszej faktury. */
  const nasza = () => faktura({ nip: NIP_NABYWCY, name: NABYWCA });
  const TRESC_ORYGINALU = [NABYWCA, 'Wartownik', NIP_NABYWCY, PROGRAM];

  beforeEach(() => {
    seedKsefInvoice(m.ksef, { session: 'S-OBCA', ksefNumber: K, xml: withOtherHeaderDate(withProgram(ourXml(nasza()))) });
  });

  it('kanały operatora bez danych oryginału; klient dostaje tekst z danymi jak dotąd', async () => {
    await run([job(nasza())] as never);

    expect(m.ksef.downloads).toBe(1);
    expect(wycieki(TRESC_ORYGINALU)).toEqual([]);

    const operator = `KSeF ma już fakturę o tym numerze (numer KSeF ${K}) spoza FaktWay, z tą samą treścią: ta sama sprzedaż, do uzgodnienia przez operatora.`;
    expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ errorCode: 'KSEF_DUPLICATE_RECONCILE', error: operator }),
    }));

    const gross = /<P_15>([^<]*)<\/P_15>/.exec(ourXml(nasza()))![1];
    const klient =
      `KSeF ma już fakturę o tym numerze (numer KSeF ${K}, z 2026-11-02, dla ${NABYWCA}, NIP ${NIP_NABYWCY}, na ${gross} PLN) ` +
      `z tą samą treścią, wystawioną w programie „${PROGRAM}” — to ta sama sprzedaż. Nie wystawiaj jej ponownie; do uzgodnienia przez operatora.`;
    expect(m.invoice).toMatchObject({ ksef_status: 'failed', last_error_code: 'KSEF_DUPLICATE_RECONCILE', last_error: klient });
    expect(zdarzeniePorazki()?.data).toMatchObject({ errorCode: 'KSEF_DUPLICATE_RECONCILE', error: klient, manualReconciliationRequired: true });
  });
});

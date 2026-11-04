import { createHash } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';
import type { JobEvent } from '@/lib/jobs/enqueue';
import type { CorrectionInvoiceSchemaIn } from '@/lib/validators/invoice-validators';

import { jsonb, memoryDb, project, type MemoryDb, type Row } from './helpers/ponowienie-specjalne-baza';

/**
 * A4b PR2a (§3.4): ponowienie dokumentu specjalnego z kopii na wierszu.
 *
 * Zdarzenie A wkłada do kolejki „Zapisz i wyślij” (prawdziwa akcja ZAL/KOR
 * i `enqueueKsefSubmitAfterDraft`). Po nieudanej próbie cron albo operator
 * odtwarza zdarzenie B z wiersza zapisanego przy wystawieniu
 * (`buildKsefRequeueEvent`: ZAL z `fa3_data.advanceEnvelope`, KOR
 * z `special_data`). B musi przejść tę samą, prawdziwą granicę wysyłki
 * i zbudować TEN SAM plik — te same bajty i skrót (KSeF rozpozna własny
 * duplikat po skrócie, D-A4-1) — pod kluczem nowej próby (D5). Do tej zmiany
 * budowniczy odmawiał każdego dokumentu specjalnego (`'special-kind'`), więc
 * ZAL i KOR po błędzie infrastruktury nie miały automatycznego ponowienia.
 *
 * Decyzja Bartosza 06.10.2026 (b): pełna wysyłka z kopii tylko w dniu
 * wystawienia — budowniczy odmawia po północy, a zdarzenie, które mimo to
 * dojdzie do workera, kończy się ISSUE_DATE_PASSED przed plikiem (00147).
 *
 * Prawdziwe: akcje, enqueue, runner, granica (`assertSubmitReferences`),
 * `submitInvoiceFullFlow`, generatory FA(3), hak otwarcia sesji.
 * Atrapy: baza (projekcja kolumn jak PostgREST), zapis zlecenia pg-boss
 * (krok transakcji na atrapie, zlecenie przez jsonb), magazyn R2 (liczy
 * sha256 z prawdziwego XML), walidator XSD, HTTP KSeF (woła hak sesji).
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const PARENT = '22222222-2222-4222-8222-222222222222';
const ATTEMPT_B = '33333333-3333-4333-8333-333333333333';
const NIP = '1234567890';
// Dzień wystawienia: 02.10.2026, 12:00 w Polsce.
const TODAY = '2026-10-02';
const ISSUE_DAY = new Date('2026-10-02T10:00:00Z');
const NEXT_DAY = new Date('2026-10-03T10:00:00Z');
// 00:00:01 03.10 w Polsce (CEST, UTC+2).
const AFTER_MIDNIGHT = new Date('2026-10-02T22:00:01Z');

interface Upload { key: string; xml: string; sha256: string }
interface SqlCall { sql: string; values: unknown[] }

const m = vi.hoisted(() => ({
  db: null as unknown as MemoryDb,
  jobs: [] as Array<{ name: string; groupId?: string; singletonKey?: string; data: Record<string, unknown> }>,
  sql: [] as SqlCall[],
  uploads: [] as Upload[],
  posted: [] as string[],
  submit: vi.fn(),
  intent: vi.fn(),
  recordSent: vi.fn(),
  /** Odpowiedź atrapy KSeF na plik: 503 (próba A) albo przyjęcie. */
  ksefAnswer: '503' as '503' | 'accept',
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/xml/invoice-calculator', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/xml/invoice-calculator')>(),
  // Fikcyjny NIP 1234567890 nie ma poprawnej sumy kontrolnej — jak w innych testach akcji.
  validateNipChecksum: () => true,
}));
vi.mock('@/lib/audit/log', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/audit/log-system', () => ({ logAuditSystem: vi.fn() }));
vi.mock('@/lib/feature-flags/global-flags', () => ({ getGlobalFlagForExecution: async () => false }));
vi.mock('@/lib/auth/ksef-verification-guard', () => ({
  requireKsefVerification: vi.fn(async () => undefined),
  requireKsefVerificationForBackgroundJob: vi.fn(async () => undefined),
  KsefNotVerifiedError: class KsefNotVerifiedError extends Error {},
}));
vi.mock('@/lib/auth/sensitive-mfa', () => ({
  assertSensitiveMfa: async () => undefined,
  SensitiveMfaRequiredError: class SensitiveMfaRequiredError extends Error {},
}));
vi.mock('@/lib/ksef/health-check', () => ({ shouldUseOfflineMode: async () => ({ offline: false, isMfOutage: false }) }));
vi.mock('@/lib/ksef/offline-queue', () => ({ addToOfflineQueue: vi.fn() }));
vi.mock('@/lib/ksef/credentials-crypto', () => ({
  decryptCredentials: () => ({ type: 'token', nip: '1234567890', token: 't' }),
}));
vi.mock('@/lib/jobs/enqueue', () => ({
  // Jak pg-boss: krok wołającego (RPC 00131) i zapis zlecenia w jednej
  // transakcji; zlecenie leży w jsonb (undefined znika, klucze posortowane).
  sendJobEvent: async (
    event: { name: string; data: object },
    options?: { inTransaction?: (tx: { executeSql: (sql: string, values?: unknown[]) => Promise<unknown> }) => Promise<void> },
  ) => {
    await options?.inTransaction?.({
      executeSql: async (sql: string, values: unknown[] = []) => {
        m.sql.push({ sql, values });
        const row = m.db.tables.invoices?.find((r) => r.id === values[0]);
        if (row && /(enqueue|requeue)_ksef_send/.test(sql)) row.ksef_status = 'queued';
        return { rows: [{ id: values[0] }], rowCount: 1 };
      },
    });
    m.jobs.push(jsonb(event) as (typeof m.jobs)[number]);
    return { ids: [`job-${m.jobs.length}`] };
  },
}));
vi.mock('@/lib/supabase/auth-context', () => ({
  requireUserAndActiveOrg: async () => ({ supabase: m.db, user: { id: 'fixture-user' }, tenantId: TENANT, role: 'owner' }),
  ActionAuthError: class ActionAuthError extends Error {},
}));
// Klient sesji (akcje) i serwisowy (enqueue, runner, granica) czytają tę samą bazę w pamięci.
vi.mock('@/lib/supabase/server', () => ({ createAdminClient: () => m.db, createClient: async () => m.db }));
vi.mock('@/lib/storage/r2-client', () => ({ getR2Config: () => ({ bucketName: 'b' }), getR2Client: () => ({ send: vi.fn() }) }));
vi.mock('@/lib/storage/r2', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/storage/r2')>();
  return {
    ...actual,
    invoiceXmlExistsForId: vi.fn(async () => false),
    listInvoiceAttemptXmls: vi.fn(async () => []),
    // Prawdziwy skrót prawdziwego pliku — stała wartość przepuściłaby każdą różnicę bajtów.
    uploadInvoiceXml: vi.fn(async (t: string, i: string, issueDate: string, xml: string, o?: { attemptId?: string | null }) => {
      const key = actual.invoiceXmlKeyFor({ tenantId: t, invoiceId: i, issueDate, attemptId: o?.attemptId });
      const sha256 = createHash('sha256').update(xml).digest('hex');
      m.uploads.push({ key, xml, sha256 });
      return { storagePath: key, sha256Hash: sha256, sizeBytes: Buffer.byteLength(xml), etag: '"e"' };
    }),
  };
});
vi.mock('@/lib/ksef/submit', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/ksef/submit')>(),
  submitInvoice: m.submit,
  checkInvoiceStatusByReference: vi.fn(),
}));
vi.mock('@/lib/ksef/submission-log', () => ({
  // A2: bez zamiarów wysyłki do rozstrzygnięcia — runner idzie jak dotąd.
  findOpenKsefSubmissionIntents: vi.fn(async () => []),
  promoteKsefSubmissionIntent: vi.fn(async () => false),
  abandonKsefSubmissionIntent: vi.fn(),
  recordKsefSubmissionIntent: m.intent,
  // D-A4-1: weryfikacja cudzego 440 — domyślnie bez sesji w historii i bez znanego numeru.
  findKsefSessionRow: vi.fn(async () => null),
  findSubmissionPayloads: vi.fn(async () => []),
  findTenantInvoiceByKsefNumber: vi.fn(async () => null),
  closeKsefAttempt: vi.fn(),
  markKsefSubmissionsNumberTaken: vi.fn(),
  recordKsefDuplicateCheck: vi.fn(),
  recordKsefAcceptedSession: vi.fn(),
  markKsefAttemptDuplicatePending: vi.fn(),
  recordKsefSubmissionSent: m.recordSent,
  markKsefSubmission: vi.fn(),
  // Próba A nie dostała numeru referencyjnego (503 przed przyjęciem pliku) — brak wpisu sent.
  findOpenKsefSubmission: vi.fn(async () => null),
  findOwnKsefSessionXmlPath: vi.fn(async () => null),
  isOwnKsefSession: vi.fn(async () => false),
  findSessionReferenceForKsefNumber: vi.fn(async () => null),
}));
// `DataWytworzeniaFa` z pierwszej próby (AUD-46): `requeue_ksef_send` nie rusza `xml_generated_at`.
vi.mock('@/lib/ksef/xml-generated-at', () => ({ claimXmlGeneratedAt: async () => new Date('2026-10-02T09:59:00.000Z') }));
vi.mock('@/lib/xml/validator', () => ({ validateInvoiceXml: async () => ({ valid: true, errors: [] }), InvoiceXmlSchemaError: class extends Error {} }));
vi.mock('@/lib/jobs/runners/tenant-boundary', () => ({ requireInvoiceTenant: vi.fn(), assertJobIdentity: vi.fn() }));
vi.mock('@/lib/supabase/admin-queries', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/supabase/admin-queries')>(),
  getTenantKsefCredentials: async () => ({ type: 'token', nip: NIP, token: 't' }),
  updateInvoiceStatus: vi.fn(),
}));
vi.mock('@/lib/storage/xml-documents', () => ({ recordXmlDocument: vi.fn() }));
vi.mock('@/lib/cache/invalidation', () => ({ invalidateTenantDashboard: vi.fn() }));
vi.mock('@/lib/analytics/server', () => ({ trackServer: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn(), addBreadcrumb: vi.fn() }));

import { saveAndSendAdvanceAction } from '@/components/invoices/advance-actions';
import { saveAndSendCorrectionAction } from '@/components/invoices/correction-actions';
import { buildKsefRequeueEvent } from '@/lib/invoices/ksef-requeue-event';
import { ksefSendTransactionStep } from '@/lib/invoices/ksef-send-step';
import { sendJobEvent } from '@/lib/jobs/enqueue';
import { runSubmitInvoice } from '@/lib/jobs/runners/submit-invoice';
import { KsefApiError } from '@/lib/ksef/client';
import { classifySendError } from '@/lib/ksef/send-error-codes';

type Kind = 'advance' | 'correction';
type SubmitData = Parameters<typeof runSubmitInvoice>[0];

const address = { countryCode: 'PL', addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa' };
const seller = { nip: NIP, name: 'Firma testowa', address };
const buyer = { type: 'b2b' as const, idType: 'nip' as const, nip: NIP, name: 'Nabywca testowy', address };
const BANK = '61109010140000071219812874';

const advanceInput = () => ({
  invoiceType: 'advance' as const, internalNumber: 'ZAL/2026/10/1', issueDate: TODAY,
  paymentMethod: 'transfer' as const, paymentDueDate: '2026-10-16', bankAccount: BANK,
  seller, buyer, splitPayment: false,
  advanceAmount: 123, totalContractAmount: 1000, vatRate: '23' as const, description: 'Testowa zaliczka na usługę',
});
const parentLine = { name: 'Usługa', unit: 'szt', quantity: 1, unitPriceNet: 1000, vatRate: '23' as const };
// Korekta „przed/po” z PKWiU, typKorekty 1 i kompensatą (jak w `dane-specjalne-zapis-akcje`).
const correctionInput = (): CorrectionInvoiceSchemaIn => ({
  invoiceType: 'correction',
  internalNumber: 'KOR/2026/10/1',
  issueDate: TODAY,
  paymentMethod: 'compensation',
  paymentDueDate: '2026-10-16',
  parentInvoiceId: PARENT,
  parentInvoiceNumber: 'FV/2026/9/1',
  parentInvoiceIssueDate: '2026-09-15',
  parentKsefNumber: '1234567890-20260915-ABCDEF',
  correctionType: 'before_after',
  correctionReason: 'Rabat po reklamacji',
  typKorekty: '1',
  seller,
  buyer,
  linesBefore: [parentLine],
  linesAfter: [{ ...parentLine, unitPriceNet: 800, pkwiuCode: '62.01.11.0' }],
});

function freshDb(): MemoryDb {
  return memoryDb(
    {
      tenants: [{
        id: TENANT, nip: NIP, name: 'Firma testowa', address_json: address,
        vat_cash_method: false, ksef_credentials_encrypted: '\\x00',
      }],
      invoices: [jsonb({
        // Faktura pierwotna korekty: przyjęta w KSeF TEST, z adnotacjami P_16/P_18A (AUD-23).
        id: PARENT, tenant_id: TENANT, direction: 'outgoing', invoice_kind: 'regular', invoice_type: 'VAT',
        ksef_status: 'accepted', ksef_environment: 'test', issue_date: '2026-09-15',
        internal_number: 'FV/2026/9/1', ksef_number: '1234567890-20260915-ABCDEF',
        seller_nip: NIP, seller_data: seller,
        buyer_data: { nip: NIP, name: 'Nabywca testowy', address, jst: 2, gv: 2 },
        net_total: 1000, vat_total: 230, gross_total: 1230,
        fa3_data: { annotations: { cashMethod: 1, splitPayment: 2 } },
      })],
      invoice_line_items: [{
        invoice_id: PARENT, ordinal: 1, name: 'Usługa', unit: 'szt', quantity: 1, unit_price_net: 1000, vat_rate: '23',
      }],
    },
    (fn) => ({
      data: fn === 'claim_ksef_send' ? '2026-10-02T10:00:00.000000+00:00' : fn === 'ksef_has_contact_evidence' ? false : null,
      error: null,
    }),
  );
}

const ctx: JobContext = {
  attempt: 0,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  step: { run: async (_n, fn) => fn(), sleep: vi.fn(), sendEvent: vi.fn(), scheduleAfter: vi.fn() },
};

async function failing(run: Promise<unknown>): Promise<Error> {
  return run.then(() => { throw new Error('oczekiwano błędu'); }, (e: unknown) => e as Error);
}

/** „Zapisz i wyślij” — zdarzenie A z kolejki i id nowego dokumentu. */
async function firstSend(kind: Kind) {
  const result = kind === 'advance'
    ? await saveAndSendAdvanceAction(advanceInput(), TENANT)
    : await saveAndSendCorrectionAction(correctionInput(), TENANT);
  expect(result, JSON.stringify(result)).toMatchObject({ success: true });
  expect(m.jobs).toHaveLength(1);
  const first = m.jobs[0]!;
  const invoiceId = String(first.data.invoiceId);
  return { first, invoiceId, row: () => m.db.tables.invoices!.find((r) => r.id === invoiceId)! };
}

/** Próba A: plik przygotowany, sesja otwarta, KSeF odpowiada 503 — ponowienia wyczerpane, faktura failed. */
async function attemptAFails(first: (typeof m.jobs)[number], row: Row) {
  m.ksefAnswer = '503';
  const error = await failing(runSubmitInvoice(first.data as SubmitData, ctx));
  expect(error.name, error.message).toBe('RetryAfterError');
  Object.assign(row, { ksef_status: 'failed', last_error_code: 'KSEF_UNAVAILABLE', ksef_send_owner: null });
}

/** Wiersz tak, jak czyta go cron/operator (kolumny `KSEF_RESEND_SOURCE_COLUMNS` + id, tenant_id, tenants(nip)). */
function storedSourceRow(row: Row) {
  return {
    ...project(row, 'invoice_kind, issue_date, fa3_data, special_data, id, tenant_id'),
    tenants: { nip: NIP },
  } as Parameters<typeof buildKsefRequeueEvent>[0];
}

/** Ponowienie jak w cronie: zdarzenie z budowniczego i `requeue_ksef_send` w transakcji zlecenia. */
async function requeue(event: JobEvent, invoiceId: string, attemptId: string) {
  await sendJobEvent(event, {
    inTransaction: ksefSendTransactionStep(
      { kind: 'requeue', actorUserId: null, reconcileOnly: false },
      { invoiceId, tenantId: TENANT, attemptId },
    ),
  });
  return m.jobs.at(-1)!;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('KSEF_ENV', 'test');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(ISSUE_DAY);
  m.db = freshDb();
  m.jobs = [];
  m.sql = [];
  m.uploads = [];
  m.posted = [];
  m.ksefAnswer = '503';
  // Atrapa HTTP KSeF: jak prawdziwy `submitInvoice` — hak otwarcia sesji przed plikiem
  // (data wystawienia i zamiar wysyłki), potem POST pliku.
  m.submit.mockImplementation(async (xml: string, _auth: unknown, _env: unknown, _audit: unknown, hooks?: {
    onSessionOpened?: (s: { sessionReferenceNumber: string }) => Promise<void>;
    onInvoiceSent?: (r: { sessionReferenceNumber: string; invoiceReferenceNumber: string }) => Promise<void>;
  }) => {
    await hooks?.onSessionOpened?.({ sessionReferenceNumber: `S-${m.posted.length + 1}` });
    m.posted.push(xml);
    if (m.ksefAnswer === '503') throw new KsefApiError(503, 'Service Unavailable', 'KSeF HTTP 503');
    await hooks?.onInvoiceSent?.({ sessionReferenceNumber: `S-${m.posted.length}`, invoiceReferenceNumber: `R-${m.posted.length}` });
    return { ksefNumber: `${NIP}-20261002-0100A0B0C0D1-AF`, acquisitionTimestamp: '2026-10-02T10:01:00Z', sessionReferenceNumber: `S-${m.posted.length}`, invoiceReferenceNumber: `R-${m.posted.length}` };
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('ponowienie ZAL i KOR (TEST) z kopii na wierszu: ten sam plik, nowy klucz próby (A4b PR2a)', () => {
  it.each(['advance', 'correction'] as const)('%s: zdarzenie B z wiersza przechodzi granicę i daje te same bajty i skrót co A', async (kind) => {
    const { first, invoiceId, row } = await firstSend(kind);
    const attemptA = String(first.data.sendAttemptId);
    await attemptAFails(first, row());
    expect(m.uploads).toHaveLength(1);

    const built = buildKsefRequeueEvent(storedSourceRow(row()), 'test', ATTEMPT_B, { reconcileOnly: false });
    expect(built).toMatchObject({ ok: true, sendAttemptId: ATTEMPT_B });
    if (!built.ok) throw new Error(`budowniczy odmówił: ${built.reason}`);
    const second = await requeue(built.event, invoiceId, built.sendAttemptId);
    expect(m.sql.at(-1)?.values).toEqual([invoiceId, TENANT, ATTEMPT_B, null, false]);

    m.ksefAnswer = 'accept';
    await expect(runSubmitInvoice(second.data as SubmitData, ctx)).resolves.toMatchObject({ success: true });

    expect(m.uploads).toHaveLength(2);
    const [a, b] = m.uploads as [Upload, Upload];
    expect(b.xml).toBe(a.xml);
    expect(b.sha256).toBe(a.sha256);
    expect(m.posted).toEqual([a.xml, a.xml]);
    // Hak sesji zapisał zamiar z tym samym skrótem dla obu prób.
    expect(m.intent.mock.calls.map(([i]) => (i as { payloadHash: string }).payloadHash)).toEqual([a.sha256, a.sha256]);
    expect(a.key.endsWith(`/${invoiceId}/${attemptA}.xml`)).toBe(true);
    expect(b.key.endsWith(`/${invoiceId}/${ATTEMPT_B}.xml`)).toBe(true);
    expect(b.key).not.toBe(a.key);
  });

  it.each(['advance', 'correction'] as const)('%s: dzień po dacie wystawienia budowniczy odmawia pełnej wysyłki („issue-date”) — bez zlecenia i bez pliku', async (kind) => {
    const { first, row } = await firstSend(kind);
    await attemptAFails(first, row());

    vi.setSystemTime(NEXT_DAY);
    const built = buildKsefRequeueEvent(storedSourceRow(row()), 'test', ATTEMPT_B, { reconcileOnly: false });

    expect(built).toEqual({ ok: false, reason: 'issue-date' });
    expect(m.jobs).toHaveLength(1);
    expect(m.uploads).toHaveLength(1);
  });

  it.each(['advance', 'correction'] as const)('strażnik: %s — ręcznie złożone zdarzenie B po północy kończy się ISSUE_DATE_PASSED przed plikiem', async (kind) => {
    const { first, row } = await firstSend(kind);
    await attemptAFails(first, row());
    expect(m.uploads).toHaveLength(1);
    expect(m.posted).toHaveLength(1);

    // Zdarzenie spoza budowniczego (np. stare zlecenie, ręczny replay): treść A, nowa próba.
    const handMade = jsonb({ ...first.data, sendAttemptId: ATTEMPT_B });
    vi.setSystemTime(AFTER_MIDNIGHT);
    m.ksefAnswer = 'accept';
    const error = await failing(runSubmitInvoice(handMade as SubmitData, ctx));

    expect(error.name).toBe('NonRetriableError');
    expect(classifySendError(error).code).toBe('ISSUE_DATE_PASSED');
    expect(error.message).toContain(TODAY);
    expect(m.uploads).toHaveLength(1);
    expect(m.posted).toHaveLength(1);
  });
});

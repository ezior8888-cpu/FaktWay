import { Readable } from 'node:stream';

import { NoSuchKey } from '@aws-sdk/client-s3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Invoice } from '@/types/invoice';

/**
 * D-A4-1b-3 PR C (00149, spec v3 5.6 „Operator”, 6.6, 7.2): operator i zapis
 * oryginału z oznaczeniem FaktFlow (`faktflow-original`):
 *  - „Zapisz decyzję klienta” (`operatorDecideDuplicateAction`, `via='operator'`)
 *    dla ofert `pair` / `record` / `released` oraz — w przeglądzie pliku (I5R) —
 *    „Zapisz fakturę z KSeF w FaktFlow” dla `review-pair` / `review-record`;
 *  - „Oddaj decyzję klientowi (plik nie z FaktFlow)” (`operatorReleaseOriginalReviewAction`)
 *    z e-mailem „sprawdziliśmy plik — zdecyduj” (klucz Resend z `release_at`);
 *  - „Przypomnij klientowi” w przeglądzie i przy `recheck-needed`.
 *
 * Prawdziwe: akcje operatora, polityka decyzji, ładowarka faktów, ślad powiadomień,
 * opakowania RPC, magazyn (`downloadFromR2` nad atrapą klienta S3), brama
 * pochodzenia, projekcja i suchy przebieg (`prepareOriginalImport`,
 * `originalDecisionAlarms`) oraz pliki FA(3) z prawdziwego generatora. Atrapy:
 * baza w pamięci (`helpers/baza-w-pamieci`) z RPC, S3, Resend, adres właściciela,
 * Sentry, audyt systemowy, `requireAdmin()`.
 *
 * Na HEAD (kontrakt, commit 1): polityka odmawia `faktflow-original` powodem
 * `reason`, a ciała modułów PR C rzucają „PR C: nie zaimplementowane” — czerwone
 * są asercje zachowania. Akcji oddania (`operatorReleaseOriginalReviewAction`)
 * jeszcze nie ma — wywołanie przez `Reflect.get` jak w `admin-ksef-cykl-akcje`.
 */

const T = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
/** X — dokument, który KSeF odrzucił (440). */
const ID = '11111111-1111-4111-8111-111111111111';
/** K — faktura z KSeF zapisana decyzją. */
const K_ID = '55555555-5555-4555-8555-555555555555';
const TENANT_NIP = '5260001246';
const BUYER_NIP = '5252241585';
const NR = 'FV 2026/10/001';
const K = '5260001246-20261001-0100A0B0C0D0-1A';
const ARCHIVE = `${T}/ksef-import/${K}.xml`;
const OPERATOR = { userId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', email: 'operator@example.test' };
const OWNER_EMAIL = 'owner@example.test';
const NOW = '2026-10-08T12:00:00.000Z';
const RELEASE_AT = '2026-10-08T11:30:00.000Z';
const NOTE = 'e-mail od właściciela 08.10, Jan Kowalski';
const RELEASE_NOTE = 'Plik z cenami brutto z innego generatora — nie powstał w FaktFlow.';
const NOTICE_ACTION = 'invoice.ksef_duplicate_decision_notified';

type Row = Record<string, unknown>;

const m = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  rpc: vi.fn(),
  audit: vi.fn(),
  revalidate: vi.fn(),
  duplicateEmail: vi.fn(),
  ownerEmail: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  s3Send: vi.fn(),
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  /** Tabele, do których zapis (insert) kończy się błędem bazy. */
  failInsertInto: [] as string[],
  /** Kod blokady z bazy (`ksef_duplicate_decision_blocker`); `null` — faktura czeka na decyzję. */
  blocker: null as string | null,
  decideReply: null as unknown,
  releaseReply: null as unknown,
  flagReply: null as unknown,
  /** Wstrzyknięta odmowa suchego przebiegu (`not-buildable` przy pair/record, której plik z generatora nie wywoła); `null` — prawdziwy przebieg. */
  prepareOverride: null as null | ((input: unknown) => Promise<unknown>),
}));

vi.mock('@/lib/auth/admin-guard', () => ({ requireAdmin: m.requireAdmin }));
vi.mock('@/lib/supabase/admin', async () => {
  const { memoryClient } = await import('./helpers/baza-w-pamieci');
  return { createAdminClient: () => ({ ...memoryClient(m.tables, { failInsertInto: m.failInsertInto }), rpc: m.rpc }) };
});
vi.mock('@/lib/jobs/enqueue', () => ({ sendJobEvent: vi.fn() }));
vi.mock('@/lib/ksef/submission-holds', () => ({ isKsefSubmissionPaused: vi.fn() }));
vi.mock('@/lib/ksef/claim-environment', () => ({
  configuredKsefEnvironment: () => 'test',
  requireConfiguredKsefEnvironment: () => 'test',
}));
vi.mock('@/lib/audit/log-system', () => ({ logAuditSystem: m.audit }));
vi.mock('next/cache', () => ({ revalidatePath: m.revalidate }));
vi.mock('@/lib/email/send', () => ({
  sendInvoiceDuplicateDecisionEmail: m.duplicateEmail,
  sendInvoiceFailedEmail: vi.fn(),
  sendInvoiceAcceptedEmail: vi.fn(),
}));
vi.mock('@/lib/supabase/admin-queries', async (orig) => ({
  ...await orig<typeof import('@/lib/supabase/admin-queries')>(),
  // Wariant ścisły: błąd odczytu rzuca, prawdziwy brak = null (jak w `admin-ksef-cykl-akcje`).
  readTenantOwnerContact: async (tenantId: string) => {
    const email = (await m.ownerEmail(tenantId)) as string | null;
    return { ownerUserId: email ? 'owner-user' : null, email };
  },
}));
// Magazyn: prawdziwy `downloadFromR2` nad atrapą klienta S3 (GetObject → bajty albo NoSuchKey).
vi.mock('@/lib/storage/r2-client', () => ({
  getR2Config: () => ({ bucketName: 'bucket', accountId: 'a', accessKeyId: 'k', secretAccessKey: 's', endpoint: 'http://r2.test' }),
  getR2Client: () => ({ send: m.s3Send }),
}));
// Suchy przebieg: domyślnie prawdziwy; `m.prepareOverride` wstrzykuje odmowę `not-buildable` przy ofercie pair/record
// (brama „importable” i lustro 4.8 liczą z tych samych wejść, więc z prawdziwego pliku jej nie wywołamy).
// Mapowanie rodzaju znacznika (`originalRecheckKindFor`) zostaje prawdziwe.
vi.mock('@/lib/ksef/duplicate-original-import', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/ksef/duplicate-original-import')>();
  return {
    ...real,
    prepareOriginalImport: (input: Parameters<typeof real.prepareOriginalImport>[0]) =>
      m.prepareOverride ? m.prepareOverride(input) : real.prepareOriginalImport(input),
  };
});
vi.mock('@sentry/nextjs', () => ({
  captureException: m.captureException,
  captureMessage: m.captureMessage,
  addBreadcrumb: vi.fn(),
}));

import * as operatorActions from '@/app/admin/ksef/actions';
import {
  operatorDecideDuplicateAction,
  operatorRemindDuplicateDecisionAction,
  type OperatorActionResult,
  type OperatorDecideDuplicateInput,
} from '@/app/admin/ksef/actions';
import { OPERATOR_DUPLICATE_MESSAGES } from '@/lib/admin/ksef-operator-policy';
import { formatWarsawDateTime } from '@/lib/format/warsaw-date';
import { KSEF_ORIGINAL_ALARM_KINDS, ORIGINAL_GATE_RULES, type DuplicateOriginalOffer } from '@/lib/ksef/duplicate-check';
import { DUPLICATE_DECISION_SQL_TEXTS, DUPLICATE_DECISION_TEXTS, fillSqlText } from '@/lib/ksef/duplicate-decision';
import { generateFA3Xml } from '@/lib/xml/fa3-generator';
import { finalizeInvoice } from '@/lib/xml/invoice-calculator';

import { sha256Hex } from './helpers/ksef-pelna-sciezka';

// ─── Pliki z KSeF: prawdziwy generator FaktFlow i jego wariacje ──────────────

const swap = (xml: string, from: string, to: string): string => {
  if (!xml.includes(from)) throw new Error(`fikstura: w pliku FA(3) nie ma ${from}`);
  return xml.replace(from, to);
};

const faktura = () => finalizeInvoice({
  internalNumber: NR,
  type: 'VAT',
  issueDate: '2026-10-01',
  saleDate: '2026-10-01',
  seller: { nip: TENANT_NIP, name: 'ACME', address: { countryCode: 'PL', addressLine1: 'ul. A 1', addressLine2: '00-001 Warszawa' } },
  buyer: { nip: BUYER_NIP, name: 'Klient', address: { countryCode: 'PL', addressLine1: 'ul. B 2', addressLine2: '02-001 Warszawa' } },
  lines: [{ ordinal: 1, name: 'Usługa', unit: 'usł.', quantity: 1, unitPriceNet: 100, vatRate: '23' }],
  payment: { currency: 'PLN', dueDate: '2026-10-15', method: 'transfer', bankAccount: 'PL61109010140000071219812874' },
});

/** Plik jak z generatora FaktFlow dla dokumentu X: brama `importable`, projekcja przechodzi lustro. */
const OUR_XML = generateFA3Xml(faktura() as Invoice, { generatedAt: new Date('2026-10-01T10:00:00.000Z') });
/** Ten sam plik w formularzu `FA (2)` — brama `review` z jednym problemem `form` (zapisywalny w przeglądzie). */
const FORM_XML = swap(OUR_XML, 'kodSystemowy="FA (3)"', 'kodSystemowy="FA (2)"');
/** Plik w EUR — brama `review` z problemem `currency` (zapisu operatora nigdy: `not-buildable:currency`). */
const EUR_XML = swap(OUR_XML, '<KodWaluty>PLN</KodWaluty>', '<KodWaluty>EUR</KodWaluty>');

// ─── Znacznik 440 i fakty ───────────────────────────────────────────────────

const PREVIEW = {
  issueDate: '2026-10-01', saleDate: null, period: '10.2026', buyerIdKind: 'nip', annotations: [], exemptionBasis: null, lineCount: 1,
  lines: [{ ordinal: 1, name: 'Usługa', quantity: '1', unit: 'usł.', unitPriceNet: '100.00', vatRate: '23', gross: '123.00' }],
  totals: { net: '100.00', vat: '23.00', gross: '123.00' },
};
const gate = (over: Row = {}): Row => ({ v: 1, rules: ORIGINAL_GATE_RULES, kind: 'importable', problems: [], preview: PREVIEW, ...over });
const reviewGate = (problems: string[], over: Row = {}): Row => gate({ kind: 'review', problems, ...over });
const RELEASE = { at: RELEASE_AT, via: 'operator', actorUserId: OPERATOR.userId, note: RELEASE_NOTE };

/** `ksef_submissions.original_check` znacznika `faktflow-original` dla bajtów `xml` z archiwum. */
const faktflowCheck = (xml: string, over: Row = {}): Row => ({
  v: 1,
  env: 'test',
  checkedAt: '2026-10-08T08:00:00.000Z',
  reason: 'faktflow-original',
  sha256: sha256Hex(xml),
  archivePath: ARCHIVE,
  sizeBytes: Buffer.byteLength(xml, 'utf8'),
  summary: { systemInfo: 'KSeF SaaS v1.0', number: NR, issueDate: '2026-10-01', buyerNip: BUYER_NIP, buyerName: 'Klient', gross: '123.00', currency: 'PLN' },
  sameContentExceptHeader: false,
  ownHistory: false,
  acquiredAt: '2026-10-01T09:00:00.000Z',
  httpStatus: null,
  knownInvoice: null,
  recheck: null,
  importGate: gate(),
  ...over,
});

/** Znacznik sprzed 00149: `faktflow-original` bez klucza `importGate` (jsonb bez klucza, nie klucz z `undefined`). */
const checkWithoutGate = (xml: string, over: Row = {}): Row => Object.fromEntries(
  Object.entries(faktflowCheck(xml, over)).filter(([key]) => key !== 'importGate'),
);

const invoiceRow = (over: Row = {}): Row => ({
  id: ID, tenant_id: T, direction: 'outgoing', invoice_kind: 'regular', ksef_status: 'failed', last_error_code: 'KSEF_DUPLICATE_RECONCILE',
  internal_number: NR, ksef_number: null, issue_date: '2026-10-01', sale_date: '2026-10-01', stripe_invoice_id: null,
  offline_idempotency_key: null, offline_qr_offline: null, offline_qr_certyfikat: null, paid_amount: 0,
  buyer_nip: BUYER_NIP, buyer_data: { name: 'Klient', nip: BUYER_NIP }, gross_total: 123, currency: 'PLN',
  fa3_data: { internalNumber: NR, type: 'VAT', lines: [{ ordinal: 1 }], seller: { nip: TENANT_NIP } }, special_data: null,
  tenants: { nip: TENANT_NIP },
  ...over,
});
const markerRow = (check: Row, over: Row = {}): Row => ({
  id: 'sub-marker', tenant_id: T, invoice_id: ID, status: 'sent', error_code: '440',
  session_reference_number: 'SES-OWN-1', invoice_reference_number: 'REF-1', request_payload_hash: 'aa'.repeat(32), response_ksef_number: null,
  original_ksef_number: K, original_session_reference_number: 'SES-ORIG-1', original_check: check,
  attempted_at: '2026-10-08T07:00:00.000Z', completed_at: null,
  ...over,
});
/** Faktura K zapisana decyzją i jej wpis z sesją oryginału — stan, który czytają alarmy po decyzji. */
const kInvoiceRow = (over: Row = {}): Row => ({
  id: K_ID, tenant_id: T, direction: 'outgoing', origin: 'ksef_import', ksef_status: 'accepted', ksef_number: K,
  ksef_accepted_at: '2026-10-01T09:00:00.000Z', internal_number: NR,
  ...over,
});
const kSessionRow = (over: Row = {}): Row => ({
  id: 'sub-k', tenant_id: T, invoice_id: K_ID, status: 'accepted', response_ksef_number: K, session_reference_number: 'SES-ORIG-1',
  ...over,
});
/** Wpis `number_taken` szkicu wycofanego decyzją z zapisem K (stan po RPC, zgubiona odpowiedź). */
const decidedRow = (check: Row, decision: Row = {}): Row => markerRow(
  {
    ...check,
    decision: {
      choice: 'same_sale', via: 'operator', at: '2026-10-08T10:00:00.000Z', reason: 'faktflow-original', env: 'test',
      mode: 'import', offer: 'pair', actorUserId: OPERATOR.userId, note: NOTE, importedInvoiceId: K_ID, retiredInternalNumber: NR,
      ...decision,
    },
  },
  { id: 'sub-decided', status: 'number_taken', error_code: 'NUMBER_TAKEN', completed_at: '2026-10-08T10:00:00.000Z' },
);
/** Próba wysyłki X z kolumnami, z których liczy się własna historia w bazie. */
const attempt = (over: Row): Row => ({
  id: 'sub-proba', tenant_id: T, invoice_id: ID, status: 'abandoned', original_ksef_number: null, session_reference_number: 'SES-PROBA',
  request_payload_hash: null, attempted_at: '2026-10-05T08:00:00.000Z', ...over,
});
const notice = (createdAt: string, metadata: Row = {}): Row => ({
  id: `notice-${createdAt}`, tenant_id: T, user_id: null, action: NOTICE_ACTION, entity_type: 'invoice', entity_id: ID,
  metadata: {
    original_ksef_number: K, via: 'auto', idempotency_key: `ksef-duplicate-decision/${ID}/${K}`, emailed: true, push_sent: 1,
    reminder: null, operator: null, source: 'system', ...metadata,
  },
  created_at: createdAt,
});

interface Arrangement {
  /** Oferta, którą w tym stanie pokazuje karta operatora (INV-8); brak = stan bez oferty karty (np. wczesny powrót z `decided`). */
  offer?: DuplicateOriginalOffer;
  /** Bajty pliku w archiwum (pod `archivePath`); brak obiektu (NoSuchKey) robi test: `objects.delete(ARCHIVE)`. */
  xml: string;
  /** `original_check` znacznika; domyślnie `faktflowCheck(xml)` (brama importable). */
  check?: Row;
  invoice?: Row;
  blocker?: string | null;
  extraSubmissions?: Row[];
  notices?: Row[];
  /** `null` — brak faktury K w bazie. */
  kInvoice?: Row | null;
  kSubmissions?: Row[];
}
const objects = new Map<string, string>();
let arranged: { xml: string; check: Row; offer: DuplicateOriginalOffer | undefined } = { xml: OUR_XML, check: {}, offer: undefined };

function arrange(a: Arrangement): void {
  const check = a.check ?? faktflowCheck(a.xml);
  arranged = { xml: a.xml, check, offer: a.offer };
  objects.clear();
  objects.set(ARCHIVE, a.xml);
  m.tables = {
    invoices: [invoiceRow(a.invoice), ...(a.kInvoice === null ? [] : [kInvoiceRow(a.kInvoice)])],
    ksef_submissions: [markerRow(check), ...(a.extraSubmissions ?? []), ...(a.kSubmissions ?? [kSessionRow()])],
    audit_logs: [...(a.notices ?? [])],
  };
  m.blocker = a.blocker ?? null;
}

// ─── Oferty (4.4): FO-PARA, FO-WŁASNA, FO-TA-SAMA-TREŚĆ, FO-ODDANA, FO-PRZEGLĄD ──

const seedPair = (over: Partial<Arrangement> = {}) => arrange({ xml: OUR_XML, offer: 'pair', ...over });
const seedRecord = (kind: 'json' | 'same-content' | 'db-hash' | 'db-session', over: Partial<Arrangement> = {}) => {
  const xml = over.xml ?? OUR_XML;
  arrange({
    xml,
    offer: 'record',
    ...(kind === 'json' ? { check: faktflowCheck(xml, { ownHistory: true }) } : {}),
    ...(kind === 'same-content' ? { check: faktflowCheck(xml, { sameContentExceptHeader: true }) } : {}),
    ...(kind === 'db-hash' ? { extraSubmissions: [attempt({ request_payload_hash: sha256Hex(xml) })] } : {}),
    ...(kind === 'db-session' ? { extraSubmissions: [attempt({ session_reference_number: 'SES-ORIG-1' })] } : {}),
    ...over,
  });
};
const seedReleased = (over: Partial<Arrangement> = {}) => arrange({
  offer: 'released',
  xml: EUR_XML,
  check: faktflowCheck(EUR_XML, { importGate: reviewGate(['currency'], { release: RELEASE }) }),
  ...over,
});
/** Przegląd pliku: poprawna brama `review`, blokada `provenance-review` (I5R). */
const seedReview = (offer: 'review-pair' | 'review-record', over: Partial<Arrangement> & { problems?: string[] } = {}) => {
  const xml = over.xml ?? FORM_XML;
  const { problems = ['form'], ...rest } = over;
  arrange({
    offer,
    xml,
    check: faktflowCheck(xml, { importGate: reviewGate(problems), ...(offer === 'review-record' ? { ownHistory: true } : {}) }),
    blocker: 'provenance-review',
    ...rest,
  });
};

// ─── Pomocnicze ─────────────────────────────────────────────────────────────

/**
 * Wejście karty operatora: wiązanie z widokiem (K, SHA-256) i — PR C, INV-8 — z tym, co karta pokazała:
 * tryb i oferta stanu zasianego (`released` → `no-import`, reszta `import`) oraz środowisko serwera.
 * Stan bez oferty karty (`arranged.offer` brak) nie niesie tych pól.
 */
const decideInput = (extra: Partial<OperatorDecideDuplicateInput> = {}): OperatorDecideDuplicateInput => ({
  choice: 'same_sale', note: NOTE, originalKsefNumber: K, originalSha256: sha256Hex(arranged.xml), confirmed: true,
  ...(arranged.offer ? { mode: arranged.offer === 'released' ? 'no-import' as const : 'import' as const, offer: arranged.offer, env: 'test' as const } : {}),
  ...extra,
});
const rpcCallsOf = (fn: string) => m.rpc.mock.calls.filter(([name]) => name === fn) as Array<[string, Row]>;
const s3Keys = () => m.s3Send.mock.calls.map(([command]) => (command as { input: { Key: string } }).input.Key);
const notices = () => (m.tables.audit_logs ?? []).filter((r) => r.action === NOTICE_ACTION);
const messageOf = (r: OperatorActionResult): string => (r.success ? r.message : r.error);

interface SentryEvent {
  kind: string | undefined;
  area: string | undefined;
  detail: string | undefined;
  level: unknown;
  fingerprint: unknown;
  extra: unknown;
}
/** Zgłoszenia do Sentry z `tags.kind` (captureMessage albo captureException) — odcisk, poziom i dodatki. */
function sentryEvents(): SentryEvent[] {
  const contexts = [
    ...m.captureMessage.mock.calls.map(([, ctx]) => ctx),
    ...m.captureException.mock.calls.map(([, ctx]) => ctx),
  ] as Array<Row | undefined>;
  return contexts.filter((c): c is Row => c !== undefined && typeof c === 'object').map((c) => {
    const tags = (c.tags ?? {}) as Record<string, string>;
    return { kind: tags.kind, area: tags.area, detail: tags.detail, level: c.level, fingerprint: c.fingerprint, extra: c.extra };
  });
}
const alarmsOf = (kind: string) => sentryEvents().filter((e) => e.kind === kind);
const noOriginalAlarms = () => sentryEvents().filter((e) => e.kind?.startsWith('ksef-duplicate'));

/** Alarm z odciskiem `[kind, X]` (jedno zgłoszenie na fakturę), poziom warning, obszar decyzji. */
const alarm = (kind: string, extra?: Row) => expect.objectContaining({
  kind, area: 'ksef.duplicate-decision', level: 'warning', fingerprint: [kind, ID], ...(extra ? { extra: expect.objectContaining(extra) } : {}),
});

interface ReleaseInput { originalKsefNumber: string; originalSha256: string; note: string }
const NO_RELEASE_ACTION: OperatorActionResult = { success: false, error: 'brak akcji operatora (operatorReleaseOriginalReviewAction)' };
const release = (invoiceId: string, input: ReleaseInput): Promise<OperatorActionResult> => {
  const fn: unknown = Reflect.get(operatorActions, 'operatorReleaseOriginalReviewAction');
  return typeof fn === 'function'
    ? (fn as (id: string, i: ReleaseInput) => Promise<OperatorActionResult>)(invoiceId, input)
    : Promise.resolve(NO_RELEASE_ACTION);
};
const releaseInput = (extra: Partial<ReleaseInput> = {}): ReleaseInput => ({
  originalKsefNumber: K, originalSha256: sha256Hex(arranged.xml), note: RELEASE_NOTE, ...extra,
});

const decideData = (over: Row = {}): Row => ({
  invoice_id: ID, internal_number: null, original_ksef_number: K, choice: 'same_sale', via: 'operator', reason: 'faktflow-original',
  already_decided: false, submissions_closed: 1, mode: 'import', offer: 'pair', imported_invoice_id: K_ID, retired_internal_number: NR,
  acquired_at_missing: false, session_missing: false,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  m.failInsertInto = [];
  m.requireAdmin.mockResolvedValue(OPERATOR);
  m.ownerEmail.mockResolvedValue(OWNER_EMAIL);
  m.duplicateEmail.mockResolvedValue({ sent: true, messageId: 'msg-1' });
  m.decideReply = { data: decideData(), error: null };
  m.releaseReply = { data: { invoice_id: ID, original_ksef_number: K, already_released: false, release_at: RELEASE_AT }, error: null };
  m.flagReply = { data: { flagged: true }, error: null };
  m.prepareOverride = null;
  m.rpc.mockImplementation(async (fn: string) => {
    switch (fn) {
      case 'ksef_duplicate_decision_blocker': return { data: m.blocker, error: null };
      case 'decide_ksef_duplicate_original': return m.decideReply;
      case 'release_ksef_original_review': return m.releaseReply;
      case 'flag_ksef_original_recheck': return m.flagReply;
      default: return { data: null, error: { code: 'PGRST202', message: `Could not find the function public.${fn}` } };
    }
  });
  // GetObject: bajty z `objects`; brak klucza = NoSuchKey jak w S3.
  m.s3Send.mockImplementation(async (command: { input: { Key: string } }) => {
    const body = objects.get(command.input.Key);
    if (body === undefined) throw new NoSuchKey({ message: 'The specified key does not exist.', $metadata: {} });
    return { Body: Readable.from([Buffer.from(body, 'utf8')]) };
  });
  seedPair();
});

afterEach(() => {
  vi.useRealTimers();
});

// ═════════════════════════════════════════════════════════════════════════════
// „Zapisz decyzję klienta” — oferty pair / record / released
// ═════════════════════════════════════════════════════════════════════════════

describe('D-A4-1b-3 PR C: operator zapisuje decyzję — oferta pair (FO-PARA)', () => {
  it.each(['same_sale', 'other_sale'] as const)('%s: RPC decide_ksef_duplicate_original z projekcją, mode "import", offer "pair" i aktorem operatorem; audyt z mode/offer/importedInvoiceId', async (choice) => {
    m.decideReply = { data: decideData({ choice }), error: null };

    const result = await operatorDecideDuplicateAction(ID, decideInput({ choice }));

    expect(result).toEqual({ success: true, message: OPERATOR_DUPLICATE_MESSAGES.successImport(choice, NR) });
    expect(rpcCallsOf('decide_ksef_duplicate')).toEqual([]);
    const calls = rpcCallsOf('decide_ksef_duplicate_original');
    expect(calls).toHaveLength(1);
    expect(calls[0]![1]).toEqual({
      p_invoice_id: ID,
      p_tenant_id: T,
      p_actor_user_id: OPERATOR.userId,
      p_choice: choice,
      p_via: 'operator',
      p_original_ksef_number: K,
      p_original_sha256: sha256Hex(OUR_XML),
      p_env: 'test',
      p_note: NOTE,
      p_mode: 'import',
      p_offer: 'pair',
      p_import: expect.objectContaining({
        v: 1,
        invoice: expect.objectContaining({ internal_number: NR, seller_nip: TENANT_NIP, buyer_nip: BUYER_NIP }),
        lines: [expect.objectContaining({ ordinal: 1, name: 'Usługa' })],
        xml: { storage_path: ARCHIVE, sha256: sha256Hex(OUR_XML), size_bytes: Buffer.byteLength(OUR_XML, 'utf8') },
      }),
    });
    expect(m.audit).toHaveBeenCalledTimes(1);
    expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'invoice.operator_duplicate_decision', tenantId: T, userId: OPERATOR.userId, entityType: 'invoice', entityId: ID,
      metadata: expect.objectContaining({
        operator: OPERATOR.email, choice, note: NOTE, originalKsefNumber: K, mode: 'import', offer: 'pair', importedInvoiceId: K_ID,
      }),
    }));
    expect(m.revalidate).toHaveBeenCalledWith(`/admin/ksef/${ID}`);
    expect(m.revalidate).toHaveBeenCalledWith(`/invoices/${ID}`);
  });

  it('suchy przebieg czyta archiwum raz, pod kluczem z original_check, i niczego tam nie zapisuje', async () => {
    await operatorDecideDuplicateAction(ID, decideInput());

    expect(s3Keys()).toEqual([ARCHIVE]);
    expect(m.s3Send.mock.calls.every(([command]) => (command as { constructor: { name: string } }).constructor.name === 'GetObjectCommand')).toBe(true);
  });

  it('notatka za krótka → noteError; bez odczytu archiwum, RPC decyzji i audytu', async () => {
    const result = await operatorDecideDuplicateAction(ID, decideInput({ note: 'ok' }));

    expect(result).toEqual({ success: false, error: OPERATOR_DUPLICATE_MESSAGES.noteError });
    expect(m.s3Send).not.toHaveBeenCalled();
    expect(rpcCallsOf('decide_ksef_duplicate_original')).toEqual([]);
    expect(m.audit).not.toHaveBeenCalled();
  });

  it('„inna sprzedaż” przy tym samym NIP nabywcy bez potwierdzenia klienta → confirmMissing; bez odczytu archiwum i RPC (decyzja 7)', async () => {
    const result = await operatorDecideDuplicateAction(ID, decideInput({ choice: 'other_sale', confirmed: false }));

    expect(result).toEqual({ success: false, error: OPERATOR_DUPLICATE_MESSAGES.confirmMissing });
    expect(m.s3Send).not.toHaveBeenCalled();
    expect(rpcCallsOf('decide_ksef_duplicate_original')).toEqual([]);
  });

  it.each([
    ['inny numer KSeF niż w widoku', { originalKsefNumber: '5260001246-20261002-0200A0B0C0D0-2B' }],
    ['inny skrót pliku niż w widoku', { originalSha256: 'cc'.repeat(32) }],
  ])('wiązanie z widokiem: %s → STALE; bez odczytu archiwum i RPC', async (_label, patch) => {
    const result = await operatorDecideDuplicateAction(ID, decideInput(patch));

    expect(result).toEqual({ success: false, error: DUPLICATE_DECISION_TEXTS.STALE });
    expect(m.s3Send).not.toHaveBeenCalled();
    expect(rpcCallsOf('decide_ksef_duplicate_original')).toEqual([]);
  });

  it('powtórzenie po zgubionej odpowiedzi (already_decided) → sukces z tym samym K, bez drugiego audytu', async () => {
    m.decideReply = { data: decideData({ already_decided: true }), error: null };

    const result = await operatorDecideDuplicateAction(ID, decideInput());

    expect(result).toEqual({ success: true, message: OPERATOR_DUPLICATE_MESSAGES.successImport('same_sale', NR) });
    expect(rpcCallsOf('decide_ksef_duplicate_original')).toHaveLength(1);
    expect(m.audit).not.toHaveBeenCalled();
  });

  describe('odmowa w chwili zapisu → znacznik „sprawdź ponownie” (INV-25), bez RPC decyzji', () => {
    const flagCall = (kind: string) => [['flag_ksef_original_recheck', {
      p_invoice_id: ID, p_tenant_id: T, p_actor_user_id: OPERATOR.userId, p_original_ksef_number: K,
      p_original_sha256: sha256Hex(arranged.xml), p_kind: kind,
    }]];

    it('brak pliku w archiwum (NoSuchKey) → archive(ścieżka, "missing"), znacznik archive-missing i jeden alarm z odciskiem', async () => {
      objects.delete(ARCHIVE);

      const result = await operatorDecideDuplicateAction(ID, decideInput());

      expect(result).toEqual({ success: false, error: OPERATOR_DUPLICATE_MESSAGES.archive(ARCHIVE, 'missing') });
      expect(rpcCallsOf('flag_ksef_original_recheck')).toEqual(flagCall('archive-missing'));
      expect(rpcCallsOf('decide_ksef_duplicate_original')).toEqual([]);
      expect(alarmsOf(KSEF_ORIGINAL_ALARM_KINDS.recheck)).toEqual([alarm(KSEF_ORIGINAL_ALARM_KINDS.recheck)]);
      expect(m.audit).not.toHaveBeenCalled();
    });

    it('inny plik pod kluczem (SHA-256 i rozmiar ≠ original_check) → archive(ścieżka, "mismatch"), znacznik archive-mismatch', async () => {
      objects.set(ARCHIVE, `${OUR_XML}\n`);

      const result = await operatorDecideDuplicateAction(ID, decideInput());

      expect(result).toEqual({ success: false, error: OPERATOR_DUPLICATE_MESSAGES.archive(ARCHIVE, 'mismatch') });
      expect(rpcCallsOf('flag_ksef_original_recheck')).toEqual(flagCall('archive-mismatch'));
      expect(rpcCallsOf('decide_ksef_duplicate_original')).toEqual([]);
      expect(alarmsOf(KSEF_ORIGINAL_ALARM_KINDS.recheck)).toHaveLength(1);
    });

    it('zapisana brama importable, a bieżąca ocena pliku ma problem (form) → gateDrift, znacznik gate-drift', async () => {
      seedPair({ xml: FORM_XML });

      const result = await operatorDecideDuplicateAction(ID, decideInput());

      expect(result).toEqual({ success: false, error: OPERATOR_DUPLICATE_MESSAGES.gateDrift });
      expect(rpcCallsOf('flag_ksef_original_recheck')).toEqual(flagCall('gate-drift'));
      expect(rpcCallsOf('decide_ksef_duplicate_original')).toEqual([]);
      expect(alarmsOf(KSEF_ORIGINAL_ALARM_KINDS.recheck)).toHaveLength(1);
    });
  });

  describe('odmowa bazy mimo zgody lustra TS', () => {
    it('P0001 IMPORT_MISMATCH (import-mismatch:number) → importMismatch("number"), jeden alarm import-refused z tagiem detail; bez audytu', async () => {
      m.decideReply = {
        data: null,
        error: {
          code: 'P0001',
          message: fillSqlText(DUPLICATE_DECISION_SQL_TEXTS.IMPORT_MISMATCH.template, K, NR),
          details: 'import-mismatch:number',
        },
      };

      const result = await operatorDecideDuplicateAction(ID, decideInput());

      expect(result).toEqual({ success: false, error: OPERATOR_DUPLICATE_MESSAGES.importMismatch('number') });
      const alarms = alarmsOf(KSEF_ORIGINAL_ALARM_KINDS.importRefused);
      expect(alarms).toEqual([alarm(KSEF_ORIGINAL_ALARM_KINDS.importRefused)]);
      expect(alarms[0]!.detail).toEqual(expect.stringContaining('number'));
      expect(m.audit).not.toHaveBeenCalled();
    });

    it('22023 import-projection:lines → importProgram (błąd programu), jeden alarm import-refused; bez audytu', async () => {
      m.decideReply = { data: null, error: { code: '22023', message: 'KSeF original import projection is invalid', details: 'import-projection:lines' } };

      const result = await operatorDecideDuplicateAction(ID, decideInput());

      // Tekst niesie kod problemu; dopuszczamy zapis „lines” i pełny „import-projection:lines”.
      expect([
        OPERATOR_DUPLICATE_MESSAGES.importProgram('lines'),
        OPERATOR_DUPLICATE_MESSAGES.importProgram('import-projection:lines'),
      ]).toContain(messageOf(result));
      expect(result.success).toBe(false);
      expect(alarmsOf(KSEF_ORIGINAL_ALARM_KINDS.importRefused)).toEqual([alarm(KSEF_ORIGINAL_ALARM_KINDS.importRefused)]);
      expect(m.audit).not.toHaveBeenCalled();
    });
  });
});

// Finding 4 (recenzja commitów 6–8): `not-buildable` przy ofercie pair/record oznacza błąd programu (brama mówiła
// „importable”, a projekcja nie przechodzi) — faktura jest oznaczona do ponownego sprawdzenia. Tekst `notBuildable`
// ("przy review-pair oddaj decyzję…; przy review-record zgłoś Bartoszowi") dotyczy ofert przeglądu i tu mylił operatora.
describe('D-A4-1b-3 PR C: not-buildable przy ofercie pair/record — tekst o błędzie programu (finding 4)', () => {
  const NOT_BUILDABLE: Array<[detail: string, kind: string]> = [
    ['lines', 'not-buildable'],
    ['totals', 'not-buildable'],
    ['number', 'import-mismatch'],
    ['seller', 'import-mismatch'],
  ];

  it('brzmienie tekstu: błąd programu, oznaczone do ponownego sprawdzenia, zgłoś Bartoszowi (runbook)', () => {
    expect(OPERATOR_DUPLICATE_MESSAGES.notBuildableProgram('lines')).toBe(
      'Nie da się zapisać faktury z pliku (lines) mimo oceny „importable” — błąd programu; oznaczone do ponownego sprawdzenia (cron „Tylko uzgodnij”), zgłoś Bartoszowi (runbook „Zapis oryginału odmówiony”).',
    );
  });

  it.each(NOT_BUILDABLE)('pair, not-buildable:%s → notBuildableProgram; znacznik %s, jeden alarm recheck z tagiem detail; bez RPC decyzji i audytu', async (detail, kind) => {
    m.prepareOverride = async () => ({ ok: false, kind: 'not-buildable', detail });

    const result = await operatorDecideDuplicateAction(ID, decideInput());

    expect(result).toEqual({ success: false, error: OPERATOR_DUPLICATE_MESSAGES.notBuildableProgram(detail) });
    expect(rpcCallsOf('flag_ksef_original_recheck')).toHaveLength(1);
    expect(rpcCallsOf('flag_ksef_original_recheck')[0]![1]).toMatchObject({ p_kind: kind, p_actor_user_id: OPERATOR.userId, p_original_ksef_number: K });
    expect(alarmsOf(KSEF_ORIGINAL_ALARM_KINDS.recheck)).toEqual([alarm(KSEF_ORIGINAL_ALARM_KINDS.recheck)]);
    expect(rpcCallsOf('decide_ksef_duplicate_original')).toEqual([]);
    expect(m.audit).not.toHaveBeenCalled();
  });

  it('record, not-buildable:lines → ten sam tekst o błędzie programu (nie tekst przeglądu); znacznik not-buildable', async () => {
    seedRecord('json');
    m.prepareOverride = async () => ({ ok: false, kind: 'not-buildable', detail: 'lines' });

    const result = await operatorDecideDuplicateAction(ID, decideInput());

    expect(result).toEqual({ success: false, error: OPERATOR_DUPLICATE_MESSAGES.notBuildableProgram('lines') });
    expect(rpcCallsOf('flag_ksef_original_recheck')[0]![1]).toMatchObject({ p_kind: 'not-buildable' });
    expect(rpcCallsOf('decide_ksef_duplicate_original')).toEqual([]);
  });

  it('review-pair zostaje przy tekście przeglądu (notBuildable): bez znacznika, bez nowego tekstu', async () => {
    seedReview('review-pair');
    m.prepareOverride = async () => ({ ok: false, kind: 'not-buildable', detail: 'currency' });

    const result = await operatorDecideDuplicateAction(ID, decideInput());

    expect(result).toEqual({ success: false, error: OPERATOR_DUPLICATE_MESSAGES.notBuildable('currency') });
    expect(rpcCallsOf('flag_ksef_original_recheck')).toEqual([]);
  });
});

// Finding 5: `flag_ksef_original_recheck` odpowiada `{flagged:false, reason:'stale'|'not-pending'}`, gdy stan zmienił się
// od kliknięcia (np. operator zdecydował w międzyczasie). Tekst „sprawdź ponownie” i alarm byłyby wtedy nieprawdziwe.
describe('D-A4-1b-3 PR C: flag recheck odpowiada stale / not-pending → STALE, bez alarmu (finding 5)', () => {
  const REASONS = ['stale', 'not-pending'] as const;
  const staleFlag = (reason: (typeof REASONS)[number]) => { m.flagReply = { data: { flagged: false, reason }, error: null }; };

  it.each(REASONS)('suchy przebieg (brak pliku w archiwum), flag: %s → STALE; jedno wywołanie flag, bez alarmu recheck, RPC decyzji i audytu', async (reason) => {
    objects.delete(ARCHIVE);
    staleFlag(reason);

    const result = await operatorDecideDuplicateAction(ID, decideInput());

    expect(result).toEqual({ success: false, error: DUPLICATE_DECISION_TEXTS.STALE });
    expect(rpcCallsOf('flag_ksef_original_recheck')).toHaveLength(1);
    expect(rpcCallsOf('decide_ksef_duplicate_original')).toEqual([]);
    expect(alarmsOf(KSEF_ORIGINAL_ALARM_KINDS.recheck)).toEqual([]);
    expect(m.audit).not.toHaveBeenCalled();
  });

  it('oferta przeglądu (review-pair), brak pliku w archiwum, flag: stale → STALE bez alarmu', async () => {
    seedReview('review-pair');
    objects.delete(ARCHIVE);
    staleFlag('stale');

    const result = await operatorDecideDuplicateAction(ID, decideInput());

    expect(result).toEqual({ success: false, error: DUPLICATE_DECISION_TEXTS.STALE });
    expect(alarmsOf(KSEF_ORIGINAL_ALARM_KINDS.recheck)).toEqual([]);
  });

  it.each(REASONS)('pair, not-buildable:lines, flag: %s → STALE bez alarmu recheck', async (reason) => {
    m.prepareOverride = async () => ({ ok: false, kind: 'not-buildable', detail: 'lines' });
    staleFlag(reason);

    const result = await operatorDecideDuplicateAction(ID, decideInput());

    expect(result).toEqual({ success: false, error: DUPLICATE_DECISION_TEXTS.STALE });
    expect(alarmsOf(KSEF_ORIGINAL_ALARM_KINDS.recheck)).toEqual([]);
  });

  it.each(REASONS)('baza odmawia (P0001 import-mismatch:number), flag: %s → STALE bez alarmu import-refused', async (reason) => {
    m.decideReply = {
      data: null,
      error: { code: 'P0001', message: fillSqlText(DUPLICATE_DECISION_SQL_TEXTS.IMPORT_MISMATCH.template, K, NR), details: 'import-mismatch:number' },
    };
    staleFlag(reason);

    const result = await operatorDecideDuplicateAction(ID, decideInput());

    expect(result).toEqual({ success: false, error: DUPLICATE_DECISION_TEXTS.STALE });
    expect(rpcCallsOf('flag_ksef_original_recheck')).toHaveLength(1);
    expect(alarmsOf(KSEF_ORIGINAL_ALARM_KINDS.importRefused)).toEqual([]);
    expect(m.audit).not.toHaveBeenCalled();
  });

  it.each(REASONS)('baza odmawia (22023 import-projection:lines), flag: %s → STALE bez alarmu import-refused', async (reason) => {
    m.decideReply = { data: null, error: { code: '22023', message: 'KSeF original import projection is invalid', details: 'import-projection:lines' } };
    staleFlag(reason);

    const result = await operatorDecideDuplicateAction(ID, decideInput());

    expect(result).toEqual({ success: false, error: DUPLICATE_DECISION_TEXTS.STALE });
    expect(alarmsOf(KSEF_ORIGINAL_ALARM_KINDS.importRefused)).toEqual([]);
  });

  it('kontrola: znacznik już był (already) albo oznaczono (flagged) → dotychczasowy tekst i alarm', async () => {
    objects.delete(ARCHIVE);
    m.flagReply = { data: { flagged: false, already: true }, error: null };

    const result = await operatorDecideDuplicateAction(ID, decideInput());

    expect(result).toEqual({ success: false, error: OPERATOR_DUPLICATE_MESSAGES.archive(ARCHIVE, 'missing') });
    expect(alarmsOf(KSEF_ORIGINAL_ALARM_KINDS.recheck)).toHaveLength(1);
  });
});

// I4 (weryfikacja commitu 2, INV-8/T7): akcja operatora dostaje od karty to, co karta pokazała — tryb, ofertę
// i środowisko — i porównuje to ze świeżym stanem. Bez tego karta otwarta w `review-pair` („Zapisz fakturę z KSeF”,
// import), kliknięta po tym, jak stan stał się `released`, zapisałaby po cichu decyzję bez importu.
describe('D-A4-1b-3 PR C: wiązanie akcji operatora z kartą — mode, offer, env (INV-8, T7)', () => {
  const noEffects = () => {
    expect(m.s3Send).not.toHaveBeenCalled();
    expect(rpcCallsOf('decide_ksef_duplicate_original')).toEqual([]);
    expect(rpcCallsOf('decide_ksef_duplicate')).toEqual([]);
    expect(rpcCallsOf('flag_ksef_original_recheck')).toEqual([]);
    expect(m.audit).not.toHaveBeenCalled();
    expect(noOriginalAlarms()).toEqual([]);
  };

  it.each([
    ['karta w review-pair, stan: oddana (released)', () => seedReleased(), { mode: 'import', offer: 'review-pair' }],
    ['karta w pair, stan: record (ten sam tryb import, inna oferta)', () => seedRecord('json'), { mode: 'import', offer: 'pair' }],
    ['karta w record, stan: pair', () => seedPair(), { mode: 'import', offer: 'record' }],
    ['karta w review-pair, stan: pair (brama znów importable)', () => seedPair(), { mode: 'import', offer: 'review-pair' }],
    ['karta w pair, stan: przegląd review-pair', () => seedReview('review-pair'), { mode: 'import', offer: 'pair' }],
    ['karta w review-record, stan: review-pair', () => seedReview('review-pair'), { mode: 'import', offer: 'review-record' }],
    ['karta w released, stan: pair', () => seedPair(), { mode: 'no-import', offer: 'released' }],
  ] as const)('oferta: %s → STALE; bez odczytu archiwum, RPC, znacznika, audytu i alarmów', async (_label, setup, shown) => {
    setup();

    const result = await operatorDecideDuplicateAction(ID, decideInput(shown));

    expect(result).toEqual({ success: false, error: DUPLICATE_DECISION_TEXTS.STALE });
    noEffects();
  });

  it.each([
    ['karta: tryb import, stan: oddana (released) — ta sama oferta released', () => seedReleased(), { mode: 'import', offer: 'released' }],
    ['karta: tryb no-import, stan: pair — ta sama oferta pair', () => seedPair(), { mode: 'no-import', offer: 'pair' }],
    ['karta: tryb no-import, stan: record — ta sama oferta record', () => seedRecord('json'), { mode: 'no-import', offer: 'record' }],
  ] as const)('tryb: %s → STALE; bez odczytu archiwum i RPC', async (_label, setup, shown) => {
    setup();

    const result = await operatorDecideDuplicateAction(ID, decideInput(shown));

    expect(result).toEqual({ success: false, error: DUPLICATE_DECISION_TEXTS.STALE });
    noEffects();
  });

  it.each(['production', 'demo'] as const)('środowisko: karta pokazała %s, serwer jest na test → STALE; bez odczytu archiwum i RPC', async (env) => {
    const result = await operatorDecideDuplicateAction(ID, decideInput({ env }));

    expect(result).toEqual({ success: false, error: DUPLICATE_DECISION_TEXTS.STALE });
    noEffects();
  });

  it('zgodne mode, offer i env (wejście domyślne) przechodzą dalej — jedno RPC z tymi samymi wartościami', async () => {
    const input = decideInput();
    expect(input).toMatchObject({ mode: 'import', offer: 'pair', env: 'test' });

    const result = await operatorDecideDuplicateAction(ID, input);

    expect(result.success).toBe(true);
    expect(rpcCallsOf('decide_ksef_duplicate_original')).toHaveLength(1);
    expect(rpcCallsOf('decide_ksef_duplicate_original')[0]![1]).toMatchObject({ p_mode: 'import', p_offer: 'pair', p_env: 'test' });
  });
});

describe.each([
  ['ownHistory=true w JSON znacznika (FO-WŁASNA)', () => seedRecord('json')],
  ['sameContentExceptHeader=true (FO-TA-SAMA-TREŚĆ)', () => seedRecord('same-content')],
  ['JSON ownHistory=false, a skrót oryginału jest w request_payload_hash próby X (T3)', () => seedRecord('db-hash')],
  ['JSON ownHistory=false, a sesja oryginału jest sesją próby X (T3)', () => seedRecord('db-session')],
])('D-A4-1b-3 PR C: operator zapisuje decyzję — oferta record: %s', (_label, setup) => {
  beforeEach(() => setup());

  it('„ta sama sprzedaż” → RPC z mode "import" i offer "record"; komunikat successRecord; audyt z ofertą i K', async () => {
    m.decideReply = { data: decideData({ offer: 'record' }), error: null };

    const result = await operatorDecideDuplicateAction(ID, decideInput({ choice: 'same_sale' }));

    expect(result).toEqual({ success: true, message: OPERATOR_DUPLICATE_MESSAGES.successRecord(NR) });
    const calls = rpcCallsOf('decide_ksef_duplicate_original');
    expect(calls).toHaveLength(1);
    expect(calls[0]![1]).toMatchObject({
      p_choice: 'same_sale', p_via: 'operator', p_note: NOTE, p_mode: 'import', p_offer: 'record', p_import: expect.objectContaining({ v: 1 }),
    });
    expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'invoice.operator_duplicate_decision',
      metadata: expect.objectContaining({ choice: 'same_sale', mode: 'import', offer: 'record', importedInvoiceId: K_ID }),
    }));
  });

  it('„inna sprzedaż” niedostępna → CHOICE z numerem dokumentu; bez odczytu archiwum, RPC i audytu', async () => {
    const result = await operatorDecideDuplicateAction(ID, decideInput({ choice: 'other_sale' }));

    expect(result).toEqual({ success: false, error: fillSqlText(DUPLICATE_DECISION_SQL_TEXTS.CHOICE.template, NR) });
    expect(m.s3Send).not.toHaveBeenCalled();
    expect(rpcCallsOf('decide_ksef_duplicate_original')).toEqual([]);
    expect(m.audit).not.toHaveBeenCalled();
  });
});

describe('D-A4-1b-3 PR C: operator zapisuje decyzję — oferta released (FO-ODDANA, tryb no-import)', () => {
  beforeEach(() => {
    seedReleased();
    m.decideReply = { data: decideData({ mode: 'no-import', offer: 'released', imported_invoice_id: null, retired_internal_number: null, internal_number: NR }), error: null };
  });

  it.each(['same_sale', 'other_sale'] as const)('%s: RPC z mode "no-import", offer "released" i p_import NULL; bez odczytu archiwum, alarmów i tekstu zapisu K; audyt bez importedInvoiceId', async (choice) => {
    m.decideReply = { data: decideData({ choice, mode: 'no-import', offer: 'released', imported_invoice_id: null, retired_internal_number: null }), error: null };

    const result = await operatorDecideDuplicateAction(ID, decideInput({ choice, originalSha256: sha256Hex(EUR_XML) }));

    expect(result).toEqual({ success: true, message: OPERATOR_DUPLICATE_MESSAGES.success(choice) });
    expect(m.s3Send).not.toHaveBeenCalled();
    expect(rpcCallsOf('decide_ksef_duplicate')).toEqual([]);
    const calls = rpcCallsOf('decide_ksef_duplicate_original');
    expect(calls).toHaveLength(1);
    expect(calls[0]![1]).toEqual({
      p_invoice_id: ID,
      p_tenant_id: T,
      p_actor_user_id: OPERATOR.userId,
      p_choice: choice,
      p_via: 'operator',
      p_original_ksef_number: K,
      p_original_sha256: sha256Hex(EUR_XML),
      p_env: 'test',
      p_note: NOTE,
      p_mode: 'no-import',
      p_offer: 'released',
      p_import: null,
    });
    const audit = m.audit.mock.calls.map(([entry]) => entry as { action: string; metadata: Row });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.action).toBe('invoice.operator_duplicate_decision');
    expect(audit[0]!.metadata).toMatchObject({ choice, note: NOTE, originalKsefNumber: K, mode: 'no-import', offer: 'released' });
    expect(audit[0]!.metadata.importedInvoiceId ?? null).toBeNull();
    expect(noOriginalAlarms()).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Przegląd pliku (I5R) — „Zapisz fakturę z KSeF w FaktWay”
// ═════════════════════════════════════════════════════════════════════════════

describe('D-A4-1b-3 PR C: operator w przeglądzie pliku (review-pair) — zapis faktury z KSeF', () => {
  beforeEach(() => seedReview('review-pair'));

  it.each(['same_sale', 'other_sale'] as const)('%s: plik zapisywalny (problem form) → RPC z p_offer "review-pair", p_via "operator", notatką i projekcją; successImport; audyt z ofertą review-pair', async (choice) => {
    m.decideReply = { data: decideData({ choice, offer: 'review-pair' }), error: null };

    const result = await operatorDecideDuplicateAction(ID, decideInput({ choice }));

    expect(result).toEqual({ success: true, message: OPERATOR_DUPLICATE_MESSAGES.successImport(choice, NR) });
    expect(s3Keys()).toEqual([ARCHIVE]);
    const calls = rpcCallsOf('decide_ksef_duplicate_original');
    expect(calls).toHaveLength(1);
    expect(calls[0]![1]).toMatchObject({
      p_actor_user_id: OPERATOR.userId, p_choice: choice, p_via: 'operator', p_note: NOTE, p_mode: 'import', p_offer: 'review-pair',
      p_original_sha256: sha256Hex(FORM_XML),
      p_import: expect.objectContaining({ v: 1, xml: expect.objectContaining({ storage_path: ARCHIVE, sha256: sha256Hex(FORM_XML) }) }),
    });
    expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'invoice.operator_duplicate_decision',
      metadata: expect.objectContaining({ choice, mode: 'import', offer: 'review-pair', importedInvoiceId: K_ID, note: NOTE }),
    }));
  });

  it('rozjazd oceny pliku względem zapisanej bramy review nie jest błędem — operator ocenia plik, który widzi (bez gate-drift)', async () => {
    seedReview('review-pair', { problems: ['rates'] });
    m.decideReply = { data: decideData({ offer: 'review-pair' }), error: null };

    const result = await operatorDecideDuplicateAction(ID, decideInput());

    expect(result.success).toBe(true);
    expect(rpcCallsOf('flag_ksef_original_recheck')).toEqual([]);
    expect(rpcCallsOf('decide_ksef_duplicate_original')).toHaveLength(1);
    expect(alarmsOf(KSEF_ORIGINAL_ALARM_KINDS.recheck)).toEqual([]);
  });

  it('pliku, którego nie da się zapisać (waluta EUR), nie zapisujemy: notBuildable("currency") bez RPC decyzji, bez znacznika i bez audytu', async () => {
    seedReview('review-pair', { xml: EUR_XML, problems: ['currency'] });

    const result = await operatorDecideDuplicateAction(ID, decideInput());

    expect(result).toEqual({ success: false, error: OPERATOR_DUPLICATE_MESSAGES.notBuildable('currency') });
    expect(s3Keys()).toEqual([ARCHIVE]);
    expect(rpcCallsOf('decide_ksef_duplicate_original')).toEqual([]);
    expect(rpcCallsOf('flag_ksef_original_recheck')).toEqual([]);
    expect(m.audit).not.toHaveBeenCalled();
  });

  it('brak pliku w archiwum → archive(ścieżka, "missing") i znacznik, jak przy ofercie pair', async () => {
    objects.delete(ARCHIVE);

    const result = await operatorDecideDuplicateAction(ID, decideInput());

    expect(result).toEqual({ success: false, error: OPERATOR_DUPLICATE_MESSAGES.archive(ARCHIVE, 'missing') });
    expect(rpcCallsOf('flag_ksef_original_recheck')).toHaveLength(1);
    expect(rpcCallsOf('flag_ksef_original_recheck')[0]![1]).toMatchObject({ p_kind: 'archive-missing', p_actor_user_id: OPERATOR.userId });
    expect(rpcCallsOf('decide_ksef_duplicate_original')).toEqual([]);
  });

  it('notatka za krótka → noteError przed odczytem archiwum', async () => {
    const result = await operatorDecideDuplicateAction(ID, decideInput({ note: 'za krótka' }));

    expect(result).toEqual({ success: false, error: OPERATOR_DUPLICATE_MESSAGES.noteError });
    expect(m.s3Send).not.toHaveBeenCalled();
    expect(rpcCallsOf('decide_ksef_duplicate_original')).toEqual([]);
  });
});

describe('D-A4-1b-3 PR C: operator w przeglądzie pliku (review-record) — tylko zapis, „ta sama sprzedaż”', () => {
  beforeEach(() => seedReview('review-record'));

  it('„ta sama sprzedaż” → RPC z p_offer "review-record"; komunikat successRecord (etykieta record); audyt z ofertą', async () => {
    m.decideReply = { data: decideData({ offer: 'review-record' }), error: null };

    const result = await operatorDecideDuplicateAction(ID, decideInput({ choice: 'same_sale' }));

    expect(result).toEqual({ success: true, message: OPERATOR_DUPLICATE_MESSAGES.successRecord(NR) });
    const calls = rpcCallsOf('decide_ksef_duplicate_original');
    expect(calls).toHaveLength(1);
    expect(calls[0]![1]).toMatchObject({ p_choice: 'same_sale', p_via: 'operator', p_mode: 'import', p_offer: 'review-record' });
    expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ mode: 'import', offer: 'review-record', importedInvoiceId: K_ID }),
    }));
  });

  it('„inna sprzedaż” niedostępna → CHOICE; bez odczytu archiwum i RPC', async () => {
    const result = await operatorDecideDuplicateAction(ID, decideInput({ choice: 'other_sale' }));

    expect(result).toEqual({ success: false, error: fillSqlText(DUPLICATE_DECISION_SQL_TEXTS.CHOICE.template, NR) });
    expect(m.s3Send).not.toHaveBeenCalled();
    expect(rpcCallsOf('decide_ksef_duplicate_original')).toEqual([]);
  });

  it('plik, którego nie da się zapisać (waluta EUR) → notBuildable("currency"); bez RPC i bez znacznika (runbook: Bartosz)', async () => {
    seedReview('review-record', { xml: EUR_XML, problems: ['currency'] });

    const result = await operatorDecideDuplicateAction(ID, decideInput());

    expect(result).toEqual({ success: false, error: OPERATOR_DUPLICATE_MESSAGES.notBuildable('currency') });
    expect(rpcCallsOf('decide_ksef_duplicate_original')).toEqual([]);
    expect(rpcCallsOf('flag_ksef_original_recheck')).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// T5: alarmy po decyzji — ze stanu bazy, na każdej ścieżce sukcesu
// ═════════════════════════════════════════════════════════════════════════════

describe('D-A4-1b-3 PR C: originalDecisionAlarms na każdej ścieżce sukcesu operatora (INV-13)', () => {
  const noDate = KSEF_ORIGINAL_ALARM_KINDS.importNoDate;
  const noSession = KSEF_ORIGINAL_ALARM_KINDS.importNoSession;
  const incomplete = { kInvoice: { ksef_accepted_at: null }, kSubmissions: [] as Row[] };

  it('nowa decyzja: K bez daty nadania i bez sesji → dwa alarmy (no-date, no-session), każdy z odciskiem [kind, X] i danymi K', async () => {
    seedPair(incomplete);

    const result = await operatorDecideDuplicateAction(ID, decideInput());

    expect(result.success).toBe(true);
    expect(alarmsOf(noDate)).toEqual([alarm(noDate, { tenantId: T, invoiceId: ID, importedInvoiceId: K_ID })]);
    expect(alarmsOf(noSession)).toEqual([alarm(noSession, { tenantId: T, invoiceId: ID, importedInvoiceId: K_ID })]);
  });

  it('K z datą i sesją → bez alarmów', async () => {
    const result = await operatorDecideDuplicateAction(ID, decideInput());

    expect(result.success).toBe(true);
    expect(noOriginalAlarms()).toEqual([]);
  });

  it('already_decided (zgubiona odpowiedź): alarmy ze stanu bazy także tu — i bez drugiego audytu', async () => {
    seedPair(incomplete);
    m.decideReply = { data: decideData({ already_decided: true, acquired_at_missing: true, session_missing: true }), error: null };

    const result = await operatorDecideDuplicateAction(ID, decideInput());

    expect(result.success).toBe(true);
    expect(m.audit).not.toHaveBeenCalled();
    expect(alarmsOf(noDate)).toHaveLength(1);
    expect(alarmsOf(noSession)).toHaveLength(1);
  });

  describe('wczesny powrót z widoku decided (decyzja z zapisem K już w bazie): bez RPC, ale z alarmami', () => {
    const arrangeDecided = (over: Partial<Arrangement> = {}, decision: Row = {}) => {
      const check = faktflowCheck(OUR_XML);
      arrange({
        xml: OUR_XML,
        check,
        invoice: { ksef_status: 'draft', last_error_code: null, internal_number: null },
        ...over,
      });
      m.tables.ksef_submissions = [decidedRow(check, decision), ...(m.tables.ksef_submissions ?? []).filter((r) => r.invoice_id !== ID)];
    };

    it('ta sama decyzja o tym samym K → sukces bez RPC i audytu; K bez daty i sesji → alarmy', async () => {
      arrangeDecided(incomplete);

      const result = await operatorDecideDuplicateAction(ID, decideInput());

      expect(result).toEqual({ success: true, message: OPERATOR_DUPLICATE_MESSAGES.successImport('same_sale', NR) });
      expect(rpcCallsOf('decide_ksef_duplicate_original')).toEqual([]);
      expect(rpcCallsOf('decide_ksef_duplicate')).toEqual([]);
      expect(m.audit).not.toHaveBeenCalled();
      expect(alarmsOf(noDate)).toEqual([alarm(noDate, { importedInvoiceId: K_ID })]);
      expect(alarmsOf(noSession)).toEqual([alarm(noSession, { importedInvoiceId: K_ID })]);
    });

    it('ten sam wybór przy ofercie record → komunikat successRecord', async () => {
      arrangeDecided({}, { offer: 'record' });

      const result = await operatorDecideDuplicateAction(ID, decideInput());

      expect(result).toEqual({ success: true, message: OPERATOR_DUPLICATE_MESSAGES.successRecord(NR) });
      expect(rpcCallsOf('decide_ksef_duplicate_original')).toEqual([]);
    });

    it('inny wybór niż zapisany → ALREADY_IMPORTED z dawnym numerem i etykietą zapisanej decyzji; bez RPC, audytu i alarmów', async () => {
      arrangeDecided(incomplete);

      const result = await operatorDecideDuplicateAction(ID, decideInput({ choice: 'other_sale' }));

      expect(result).toEqual({
        success: false,
        error: fillSqlText(
          DUPLICATE_DECISION_SQL_TEXTS.ALREADY_IMPORTED.template,
          NR,
          DUPLICATE_DECISION_TEXTS.FAKTFLOW.IMPORTED_CARD_CHOICE.same_sale,
        ),
      });
      expect(rpcCallsOf('decide_ksef_duplicate_original')).toEqual([]);
      expect(m.audit).not.toHaveBeenCalled();
      expect(noOriginalAlarms()).toEqual([]);
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// „Oddaj decyzję klientowi (plik nie z FaktWay)”
// ═════════════════════════════════════════════════════════════════════════════

describe('D-A4-1b-3 PR C: operatorReleaseOriginalReviewAction — oddanie decyzji klientowi (T8)', () => {
  const RELEASE_KEY = `ksef-duplicate-decision/${ID}/${K}/oddanie-${Date.parse(RELEASE_AT)}`;
  beforeEach(() => seedReview('review-pair'));

  it('autoryzacja: odmowa requireAdmin zatrzymuje wszystko przed kluczem serwisowym', async () => {
    m.requireAdmin.mockRejectedValue(new Error('synthetic authorization denied'));

    await expect(release(ID, releaseInput())).rejects.toThrow('synthetic authorization denied');

    expect(m.rpc).not.toHaveBeenCalled();
    expect(m.duplicateEmail).not.toHaveBeenCalled();
    expect(m.audit).not.toHaveBeenCalled();
  });

  it('sukces: RPC release_ksef_original_review z aktorem, K, SHA, środowiskiem i notatką; e-mail released z kluczem …/oddanie-{release_at} i reminder:false; ślad; audyt operatora', async () => {
    const result = await release(ID, releaseInput());

    expect(result).toEqual({ success: true, message: OPERATOR_DUPLICATE_MESSAGES.releaseSuccess(OWNER_EMAIL) });
    expect(rpcCallsOf('release_ksef_original_review')).toEqual([['release_ksef_original_review', {
      p_invoice_id: ID, p_tenant_id: T, p_actor_user_id: OPERATOR.userId, p_original_ksef_number: K,
      p_original_sha256: sha256Hex(FORM_XML), p_env: 'test', p_note: RELEASE_NOTE,
    }]]);
    expect(m.duplicateEmail).toHaveBeenCalledTimes(1);
    expect(m.duplicateEmail).toHaveBeenCalledWith(
      OWNER_EMAIL,
      expect.objectContaining({ invoiceId: ID, invoiceNumber: NR, ksefNumber: K, reminder: false, variant: 'released' }),
      expect.objectContaining({ idempotencyKey: RELEASE_KEY }),
    );
    expect(notices()).toHaveLength(1);
    expect(notices()[0]).toMatchObject({
      tenant_id: T, action: NOTICE_ACTION, entity_type: 'invoice', entity_id: ID,
      metadata: expect.objectContaining({ original_ksef_number: K, variant: 'released', idempotency_key: RELEASE_KEY, emailed: true }),
    });
    expect(m.audit).toHaveBeenCalledTimes(1);
    expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'invoice.operator_original_release', tenantId: T, userId: OPERATOR.userId, entityType: 'invoice', entityId: ID,
      metadata: expect.objectContaining({ operator: OPERATOR.email, note: RELEASE_NOTE, originalKsefNumber: K }),
    }));
    expect(m.revalidate).toHaveBeenCalledWith(`/admin/ksef/${ID}`);
    expect(m.revalidate).toHaveBeenCalledWith(`/invoices/${ID}`);
  });

  it.each([
    ['ślad „sprawdzamy” (rodzina review) sprzed godziny', () => [notice('2026-10-08T11:00:00.000Z', { variant: 'review', idempotency_key: `ksef-duplicate-decision/${ID}/${K}/sprawdzamy` })]],
    ['ślad powiadomienia o decyzji sprzed godziny (zwykły, bez wariantu)', () => [notice('2026-10-08T11:00:00.000Z')]],
  ])('bez reguły 24 h: %s nie blokuje e-maila po oddaniu', async (_label, make) => {
    seedReview('review-pair', { notices: make() });

    const result = await release(ID, releaseInput());

    expect(result).toEqual({ success: true, message: OPERATOR_DUPLICATE_MESSAGES.releaseSuccess(OWNER_EMAIL) });
    expect(m.duplicateEmail).toHaveBeenCalledTimes(1);
    expect(m.duplicateEmail).toHaveBeenCalledWith(
      OWNER_EMAIL, expect.objectContaining({ variant: 'released', reminder: false }), expect.objectContaining({ idempotencyKey: RELEASE_KEY }),
    );
  });

  describe('widok nie pozwala oddać', () => {
    it('review-record (plik w historii dokumentu albo ta sama treść) → reviewRecordOnly; bez RPC i e-maila', async () => {
      seedReview('review-record');

      const result = await release(ID, releaseInput());

      expect(result).toEqual({ success: false, error: OPERATOR_DUPLICATE_MESSAGES.reviewRecordOnly });
      expect(rpcCallsOf('release_ksef_original_review')).toEqual([]);
      expect(m.duplicateEmail).not.toHaveBeenCalled();
    });

    it('faktura czeka na decyzję klienta (brama importable, blokada NULL) → releaseNotReview; bez RPC i e-maila', async () => {
      seedPair();

      const result = await release(ID, releaseInput({ originalSha256: sha256Hex(OUR_XML) }));

      expect(result).toEqual({ success: false, error: OPERATOR_DUPLICATE_MESSAGES.releaseNotReview });
      expect(rpcCallsOf('release_ksef_original_review')).toEqual([]);
      expect(m.duplicateEmail).not.toHaveBeenCalled();
    });

    it.each([
      ['inny numer KSeF', { originalKsefNumber: '5260001246-20261002-0200A0B0C0D0-2B' }],
      ['inny skrót pliku', { originalSha256: 'cc'.repeat(32) }],
    ])('%s niż w widoku → releaseStale; bez RPC i e-maila', async (_label, patch) => {
      const result = await release(ID, releaseInput(patch));

      expect(result).toEqual({ success: false, error: OPERATOR_DUPLICATE_MESSAGES.releaseStale });
      expect(rpcCallsOf('release_ksef_original_review')).toEqual([]);
      expect(m.duplicateEmail).not.toHaveBeenCalled();
    });

    it('notatka za krótka → noteError (RPC liczy to samo: 22023); bez RPC i e-maila', async () => {
      const result = await release(ID, releaseInput({ note: 'krótko' }));

      expect(result).toEqual({ success: false, error: OPERATOR_DUPLICATE_MESSAGES.noteError });
      expect(rpcCallsOf('release_ksef_original_review')).toEqual([]);
      expect(m.duplicateEmail).not.toHaveBeenCalled();
    });
  });

  describe('odmowy RPC → teksty operatora (bez e-maila, bez audytu oddania)', () => {
    const refuse = (message: string, details?: string) => {
      m.releaseReply = { data: null, error: { code: 'P0001', message, ...(details ? { details } : {}) } };
    };

    const REFUSALS: Array<[code: string, details: string | undefined, expected: string]> = [
      ['release:own-file', undefined, OPERATOR_DUPLICATE_MESSAGES.reviewRecordOnly],
      ['release:not-review', 'none', OPERATOR_DUPLICATE_MESSAGES.releaseNotReview],
      ['release:stale', undefined, OPERATOR_DUPLICATE_MESSAGES.releaseStale],
      ['release:no-gate', undefined, OPERATOR_DUPLICATE_MESSAGES.releaseNoGate],
    ];

    it.each(REFUSALS)('%s (DETAIL: %s) → tekst z 6.6', async (code, details, expected) => {
      refuse(code, details);

      const result = await release(ID, releaseInput());

      expect(result).toEqual({ success: false, error: expected });
      expect(rpcCallsOf('release_ksef_original_review')).toHaveLength(1);
      expect(m.duplicateEmail).not.toHaveBeenCalled();
      expect(m.audit).not.toHaveBeenCalled();
    });

    it('release:not-review z DETAIL payments (wpłata pojawiła się między odczytem a RPC) → tekst wpłat operatora', async () => {
      refuse('release:not-review', 'payments');

      const result = await release(ID, releaseInput());

      // paid_amount faktury w widoku = 0 (wpłata jest w wierszach `payments`, których widok nie liczy).
      expect(result).toEqual({ success: false, error: OPERATOR_DUPLICATE_MESSAGES.payments('0') });
      expect(m.duplicateEmail).not.toHaveBeenCalled();
      expect(m.audit).not.toHaveBeenCalled();
    });

    it('release:not-review z DETAIL recheck-needed (wyścig z znacznikiem „sprawdź ponownie”) → recheckPending', async () => {
      refuse('release:not-review', 'recheck-needed');

      const result = await release(ID, releaseInput());

      // Widok z chwili odczytu nie miał `recheckNeeded`, więc rodzaj i czas są puste.
      expect(result).toEqual({ success: false, error: OPERATOR_DUPLICATE_MESSAGES.recheckPending(null, null) });
      expect(m.duplicateEmail).not.toHaveBeenCalled();
    });

    // Finding 6: 22023 z RPC oddania to też zły id/SHA/środowisko (rozjazd programu), nie tylko notatka.
    const NOTE_RPC_MESSAGE = 'KSeF original release requires a note of 10 to 1000 characters';

    it('22023 z komunikatem o notatce (baza policzyła notatkę krócej niż akcja) → noteError; bez Sentry, e-maila i audytu', async () => {
      m.releaseReply = { data: null, error: { code: '22023', message: NOTE_RPC_MESSAGE } };

      const result = await release(ID, releaseInput());

      expect(result).toEqual({ success: false, error: OPERATOR_DUPLICATE_MESSAGES.noteError });
      expect(m.captureException).not.toHaveBeenCalled();
      expect(m.duplicateEmail).not.toHaveBeenCalled();
      expect(m.audit).not.toHaveBeenCalled();
    });

    it.each([
      'KSeF original release requires an invoice, a tenant and an actor',
      'KSeF original release requires the original KSeF number',
      'KSeF original release requires a lowercase hex SHA-256 of the original',
      'KSeF original release environment must be test, demo or production',
    ])('inny 22023 (%s) → tekst ogólny i zgłoszenie do Sentry operator-release, nie noteError', async (message) => {
      m.releaseReply = { data: null, error: { code: '22023', message } };

      const result = await release(ID, releaseInput());

      expect(result).toEqual({ success: false, error: DUPLICATE_DECISION_TEXTS.GENERIC });
      expect(m.captureException).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ tags: expect.objectContaining({ area: 'ksef.duplicate-decision', kind: 'operator-release' }) }),
      );
      expect(m.duplicateEmail).not.toHaveBeenCalled();
      expect(m.audit).not.toHaveBeenCalled();
    });

    it('XX000 (stan po zapisie niezgodny — baza wycofała oddanie) → releaseFailed i jedno zgłoszenie Sentry release-failed; bez e-maila i audytu', async () => {
      m.releaseReply = { data: null, error: { code: 'XX000', message: 'Original review release left an inconsistent state' } };

      const result = await release(ID, releaseInput());

      expect(result).toEqual({ success: false, error: OPERATOR_DUPLICATE_MESSAGES.releaseFailed });
      expect(alarmsOf(KSEF_ORIGINAL_ALARM_KINDS.releaseFailed)).toEqual([alarm(KSEF_ORIGINAL_ALARM_KINDS.releaseFailed)]);
      expect(m.duplicateEmail).not.toHaveBeenCalled();
      expect(m.audit).not.toHaveBeenCalled();
    });
  });

  describe('already_released (zgubiona odpowiedź, podwójne kliknięcie)', () => {
    beforeEach(() => {
      m.releaseReply = { data: { invoice_id: ID, original_ksef_number: K, already_released: true, release_at: RELEASE_AT }, error: null };
    });

    it('bez śladu rodziny decision od release_at → e-mail z TYM SAMYM kluczem (Resend deduplikuje 24 h); bez drugiego audytu oddania', async () => {
      seedReview('review-pair', {
        // Ślad sprzed oddania i ślad „sprawdzamy” po oddaniu nie są powiadomieniem o decyzji.
        notices: [notice('2026-10-08T10:00:00.000Z'), notice('2026-10-08T11:45:00.000Z', { variant: 'review' })],
      });

      const result = await release(ID, releaseInput());

      expect(result).toEqual({ success: true, message: OPERATOR_DUPLICATE_MESSAGES.releaseSuccess(OWNER_EMAIL) });
      expect(m.duplicateEmail).toHaveBeenCalledTimes(1);
      expect(m.duplicateEmail).toHaveBeenCalledWith(
        OWNER_EMAIL, expect.objectContaining({ variant: 'released', reminder: false }), expect.objectContaining({ idempotencyKey: RELEASE_KEY }),
      );
      expect(m.audit).not.toHaveBeenCalled();
    });

    it('jest ślad rodziny decision od release_at → bez e-maila, komunikat releaseAlreadyEmailed z datą śladu; bez audytu', async () => {
      const lastAt = '2026-10-08T11:40:00.000Z';
      seedReview('review-pair', { notices: [notice(lastAt, { variant: 'released', idempotency_key: RELEASE_KEY })] });

      const result = await release(ID, releaseInput());

      expect(messageOf(result)).toBe(OPERATOR_DUPLICATE_MESSAGES.releaseAlreadyEmailed(formatWarsawDateTime(lastAt)));
      expect(m.duplicateEmail).not.toHaveBeenCalled();
      expect(notices()).toHaveLength(1);
      expect(m.audit).not.toHaveBeenCalled();
    });

    // INV-21, spec 5.13 wiersz 7: po commicie oddania baza nie ma już przeglądu. Znacznik niesie `importGate.release`,
    // blokada SQL jest NULL, więc widok to `decidable` z ofertą `released` — nie `review`. Drugie kliknięcie MUSI dojść
    // do RPC (odpowiedź `already_released`), inaczej e-mail po zgubionej odpowiedzi nigdy nie wyjdzie z kluczem …/oddanie-{release_at}.
    describe('prawdziwy znacznik po oddaniu (importGate.release zapisane, blokada NULL → widok released)', () => {
      beforeEach(() => seedReleased());

      it('bez śladu rodziny decision od release_at → RPC, potem e-mail z kluczem z ZAPISANEGO release_at; bez audytu oddania', async () => {
        const result = await release(ID, releaseInput());

        expect(result).toEqual({ success: true, message: OPERATOR_DUPLICATE_MESSAGES.releaseSuccess(OWNER_EMAIL) });
        expect(rpcCallsOf('release_ksef_original_review')).toEqual([['release_ksef_original_review', {
          p_invoice_id: ID, p_tenant_id: T, p_actor_user_id: OPERATOR.userId, p_original_ksef_number: K,
          p_original_sha256: sha256Hex(EUR_XML), p_env: 'test', p_note: RELEASE_NOTE,
        }]]);
        expect(m.duplicateEmail).toHaveBeenCalledTimes(1);
        expect(m.duplicateEmail).toHaveBeenCalledWith(
          OWNER_EMAIL, expect.objectContaining({ variant: 'released', reminder: false }), expect.objectContaining({ idempotencyKey: RELEASE_KEY }),
        );
        expect(notices()).toHaveLength(1);
        expect(m.audit).not.toHaveBeenCalled();
      });

      it('jest ślad rodziny decision od release_at → RPC, ale bez drugiego e-maila; releaseAlreadyEmailed z datą śladu', async () => {
        const lastAt = '2026-10-08T11:40:00.000Z';
        seedReleased({ notices: [notice(lastAt, { variant: 'released', idempotency_key: RELEASE_KEY })] });

        const result = await release(ID, releaseInput());

        expect(messageOf(result)).toBe(OPERATOR_DUPLICATE_MESSAGES.releaseAlreadyEmailed(formatWarsawDateTime(lastAt)));
        expect(rpcCallsOf('release_ksef_original_review')).toHaveLength(1);
        expect(m.duplicateEmail).not.toHaveBeenCalled();
        expect(m.audit).not.toHaveBeenCalled();
      });

      it.each([
        ['inny numer KSeF', { originalKsefNumber: '5260001246-20261002-0200A0B0C0D0-2B' }],
        ['inny skrót pliku', { originalSha256: 'cc'.repeat(32) }],
      ])('%s niż w widoku → releaseStale; bez RPC i e-maila (wiązanie z plikiem zostaje)', async (_label, patch) => {
        const result = await release(ID, releaseInput(patch));

        expect(result).toEqual({ success: false, error: OPERATOR_DUPLICATE_MESSAGES.releaseStale });
        expect(rpcCallsOf('release_ksef_original_review')).toEqual([]);
        expect(m.duplicateEmail).not.toHaveBeenCalled();
      });

      it('notatka za krótka → noteError; bez RPC i e-maila (sprawdzenie notatki zostaje)', async () => {
        const result = await release(ID, releaseInput({ note: 'krótko' }));

        expect(result).toEqual({ success: false, error: OPERATOR_DUPLICATE_MESSAGES.noteError });
        expect(rpcCallsOf('release_ksef_original_review')).toEqual([]);
        expect(m.duplicateEmail).not.toHaveBeenCalled();
      });
    });
  });

  it('e-mail wyszedł, ale ślad nie zapisał się (audit_logs odmawia) → releaseSentNotRecorded: „Przypomnij klientowi” wyśle drugi e-mail, użyj go dopiero po potwierdzeniu klienta', async () => {
    m.failInsertInto = ['audit_logs'];

    const result = await release(ID, releaseInput());

    expect(result).toEqual({ success: false, error: OPERATOR_DUPLICATE_MESSAGES.releaseSentNotRecorded });
    // Finding 7: przypomnienie ma inny klucz (…/przypomnienie-n), więc Resend go nie zdeduplikuje — tekst nie może tego obiecywać.
    expect(OPERATOR_DUPLICATE_MESSAGES.releaseSentNotRecorded).toBe(
      'Oddano decyzję klientowi i e-mail wyszedł, ale nie zapisaliśmy śladu w audit_logs — „Przypomnij klientowi” wyśle drugi e-mail; użyj go dopiero, gdy klient potwierdzi, że e-maila nie ma.',
    );
    expect(m.duplicateEmail).toHaveBeenCalledTimes(1);
    expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'invoice.operator_original_release' }));
  });

  it('e-mail niewysłany (Resend nieskonfigurowany) nie cofa oddania → releaseSentNoEmail z powodem; ślad nie powstaje, audyt oddania jest', async () => {
    m.duplicateEmail.mockResolvedValue({ sent: false, reason: 'not-configured' });

    const result = await release(ID, releaseInput());

    expect(messageOf(result)).toBe(OPERATOR_DUPLICATE_MESSAGES.releaseSentNoEmail('not-configured'));
    expect(rpcCallsOf('release_ksef_original_review')).toHaveLength(1);
    expect(m.duplicateEmail).toHaveBeenCalledTimes(1);
    expect(notices()).toEqual([]);
    expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'invoice.operator_original_release' }));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// „Przypomnij klientowi” — wariant z oferty i odmowy
// ═════════════════════════════════════════════════════════════════════════════

describe('D-A4-1b-3 PR C: operatorRemindDuplicateDecisionAction — wariant z oferty (INV-24)', () => {
  const remind = (id = ID) => operatorRemindDuplicateDecisionAction(id);

  it.each([
    ['pair', () => seedPair(), 'pair'],
    ['record', () => seedRecord('json'), 'record'],
    ['record z historii w bazie', () => seedRecord('db-hash'), 'record'],
    ['released', () => seedReleased(), 'released'],
  ])('oferta %s → przypomnienie z właściwym wariantem (reminder:true), ślad niesie wariant', async (_label, setup, variant) => {
    setup();

    const result = await remind();

    expect(result).toEqual({ success: true, message: OPERATOR_DUPLICATE_MESSAGES.remindSuccess(OWNER_EMAIL) });
    expect(m.duplicateEmail).toHaveBeenCalledTimes(1);
    expect(m.duplicateEmail).toHaveBeenCalledWith(
      OWNER_EMAIL,
      expect.objectContaining({ invoiceId: ID, invoiceNumber: NR, ksefNumber: K, reminder: true, variant }),
      expect.objectContaining({ idempotencyKey: `ksef-duplicate-decision/${ID}/${K}/przypomnienie-0` }),
    );
    expect(notices()).toHaveLength(1);
    expect(notices()[0]).toMatchObject({ metadata: expect.objectContaining({ via: 'operator', variant, reminder: 0, operator: OPERATOR.email }) });
  });

  it('reguła 24 h liczy tylko ślady rodziny decision: ślad „sprawdzamy” sprzed godziny nie blokuje przypomnienia', async () => {
    seedReleased({ notices: [notice('2026-10-08T11:00:00.000Z', { variant: 'review', idempotency_key: `ksef-duplicate-decision/${ID}/${K}/sprawdzamy` })] });

    const result = await remind();

    expect(result).toEqual({ success: true, message: OPERATOR_DUPLICATE_MESSAGES.remindSuccess(OWNER_EMAIL) });
    expect(m.duplicateEmail).toHaveBeenCalledTimes(1);
    // Numer przypomnienia liczy ślady rodziny decision — „sprawdzamy” do niego nie wchodzi.
    expect(m.duplicateEmail).toHaveBeenCalledWith(
      OWNER_EMAIL, expect.objectContaining({ variant: 'released' }),
      expect.objectContaining({ idempotencyKey: `ksef-duplicate-decision/${ID}/${K}/przypomnienie-0` }),
    );
  });

  it('ślad rodziny decision młodszy niż 24 h nadal blokuje (REMIND_TOO_SOON), także przy ofercie record', async () => {
    seedRecord('json', { notices: [notice('2026-10-08T11:00:00.000Z', { variant: 'record' })] });

    const result = await remind();

    expect(result).toEqual({ success: false, error: OPERATOR_DUPLICATE_MESSAGES.remindTooSoon('2026-10-08T11:00:00.000Z') });
    expect(m.duplicateEmail).not.toHaveBeenCalled();
  });

  it('w przeglądzie pliku klient nie zdecyduje, dopóki operator nie przejrzy pliku → remindReview; bez e-maila i śladu', async () => {
    seedReview('review-pair');

    const result = await remind();

    expect(result).toEqual({ success: false, error: OPERATOR_DUPLICATE_MESSAGES.remindReview });
    expect(m.duplicateEmail).not.toHaveBeenCalled();
    expect(notices()).toEqual([]);
  });

  it('przy recheck-needed (trwały znacznik „sprawdź ponownie”) → recheckPending z rodzajem i czasem; bez e-maila i śladu', async () => {
    const recheckAt = '2026-10-08T09:30:00.000Z';
    seedPair({
      check: faktflowCheck(OUR_XML, { recheckNeeded: { kind: 'gate-drift', at: recheckAt } }),
      blocker: 'recheck-needed',
    });

    const result = await remind();

    expect(result).toEqual({ success: false, error: OPERATOR_DUPLICATE_MESSAGES.recheckPending('gate-drift', recheckAt) });
    expect(m.duplicateEmail).not.toHaveBeenCalled();
    expect(notices()).toEqual([]);
  });

  it('przy recheck-needed bez oceny pliku (znacznik sprzed 00149) → recheckPending bez rodzaju; bez e-maila', async () => {
    seedPair({ check: checkWithoutGate(OUR_XML), blocker: 'recheck-needed' });

    const result = await remind();

    expect(result).toEqual({ success: false, error: OPERATOR_DUPLICATE_MESSAGES.recheckPending(null, null) });
    expect(m.duplicateEmail).not.toHaveBeenCalled();
  });
});

describe('D-A4-1b-3 PR C: odmowy operatora z blokady SQL (teksty 6.6 zamiast ogólnego runbooku)', () => {
  it.each([
    ['known-now', () => OPERATOR_DUPLICATE_MESSAGES.knownNow(K)],
    ['cross-tenant', () => OPERATOR_DUPLICATE_MESSAGES.crossTenant(K)],
  ])('%s → „Zapisz decyzję klienta” odmawia tekstem z numerem KSeF; bez odczytu archiwum, RPC decyzji i audytu', async (blocker, expected) => {
    seedPair({ blocker });

    const result = await operatorDecideDuplicateAction(ID, decideInput());

    expect(result).toEqual({ success: false, error: expected() });
    expect(m.s3Send).not.toHaveBeenCalled();
    expect(rpcCallsOf('decide_ksef_duplicate_original')).toEqual([]);
    expect(m.audit).not.toHaveBeenCalled();
  });

  it('znacznik faktflow-original z bramą sprzed 00149 (brak importGate) → recheckPending; decyzja klienta niedostępna', async () => {
    seedPair({ check: checkWithoutGate(OUR_XML), blocker: 'recheck-needed' });

    const result = await operatorDecideDuplicateAction(ID, decideInput());

    expect(result).toEqual({ success: false, error: OPERATOR_DUPLICATE_MESSAGES.recheckPending(null, null) });
    expect(rpcCallsOf('decide_ksef_duplicate_original')).toEqual([]);
  });
});

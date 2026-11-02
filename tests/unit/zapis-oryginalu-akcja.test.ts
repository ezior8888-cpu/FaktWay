import { createHash } from 'node:crypto';

import { NoSuchKey } from '@aws-sdk/client-s3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * D-A4-1b-3 PR C (00149, decyzje Bartosza 08.10.2026 C1–C8): klient — właściciel
 * albo administrator — zapisuje decyzję przy powodzie `faktflow-original`
 * (KSeF ma już fakturę tej firmy o numerze naszego dokumentu, a plik oryginału
 * ma `SystemInfo` FaktFlow). Akcja `decideKsefDuplicateAction` (spec v3 5.6)
 * nie woła już 9-argumentowego `decide_ksef_duplicate`, tylko:
 *   1. czyta fakty sesją i blokadę SQL `ksef_duplicate_decision_blocker_for_session`,
 *   2. liczy tę samą politykę co panel (oferta `pair` / `record` / `released`),
 *   3. wiąże z tym, co pokazał panel: K, SHA-256, tryb, ofertę i środowisko (STALE),
 *   4. przy trybie `import` robi suchy przebieg `prepareOriginalImport`
 *      (archiwum → SHA/rozmiar → brama → projekcja) — każda odmowa zostawia
 *      trwały znacznik `recheckNeeded` (`flag_ksef_original_recheck`, INV-25),
 *      tekst `FAKTFLOW.RECHECK` i jeden alarm Sentry z odciskiem,
 *   5. woła `decide_ksef_duplicate_original` z projekcją,
 *   6. po decyzji (także `already_decided` i wczesny widok `decided`) alarmy
 *      ze stanu bazy: K bez daty nadania / bez sesji (INV-13, T5).
 *
 * Do PR C ta ścieżka kończyła się odmową `reason` (ogólny tekst, bez RPC):
 * klient nie miał jak zdecydować i faktura zostawała w `failed KSEF_DUPLICATE_RECONCILE`.
 *
 * Prawdziwe: akcja, polityka (`lib/ksef/duplicate-decision.ts`), loader faktów,
 * `duplicate-check`, `prepareOriginalImport` z bramą i projekcją na PRAWDZIWYM
 * pliku z generatora FaktFlow (`generateFA3Xml`), opakowania RPC, alarmy po
 * decyzji. Zastąpione: sesja Supabase (baza w pamięci z projekcją kolumn),
 * klucz serwisowy (baza w pamięci + `rpc`), magazyn (`downloadFromR2`),
 * środowisko KSeF, `next/cache`, Sentry. Wyjątek: odmowy `not-buildable:*`,
 * których z prawdziwego pliku nie da się wywołać przy ofercie `pair` (brama
 * i lustro 4.8 liczą z tych samych wejść), wstrzykuje `m.prepareOverride`;
 * mapowanie rodzaju (`originalRecheckKindFor`) zostaje prawdziwe.
 */

const m = vi.hoisted(() => ({
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  session: null as null | { from: (table: string) => unknown },
  admin: null as null | { from: (table: string) => unknown },
  role: 'owner',
  env: 'test' as string | null,
  rpc: vi.fn(),
  sessionRpc: vi.fn(),
  download: vi.fn(),
  prepareOverride: null as null | ((input: unknown) => Promise<unknown>),
  captureMessage: vi.fn(),
  captureException: vi.fn(),
  revalidate: vi.fn(),
}));

vi.mock('@/lib/supabase/auth-context', () => {
  class ActionAuthError extends Error {}
  const ctx = async () => ({
    supabase: {
      from: (table: string) => m.session!.from(table),
      rpc: (fn: string, args: unknown) => m.sessionRpc(fn, args),
    },
    user: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
    tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    role: m.role,
  });
  return {
    ActionAuthError,
    requireUserAndActiveOrg: ctx,
    requireOrgRole: async (roles: string | string[]) => {
      const c = await ctx();
      const allowed = Array.isArray(roles) ? roles : [roles];
      if (!allowed.includes(c.role)) throw new ActionAuthError('Niewystarczające uprawnienia');
      return c;
    },
  };
});
// Klucz serwisowy: RPC decyzji i znacznika oraz odczyt K po decyzji (alarmy).
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    rpc: (fn: string, args: unknown) => m.rpc(fn, args),
    from: (table: string) => m.admin!.from(table),
  }),
}));
vi.mock('@/lib/ksef/claim-environment', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ksef/claim-environment')>()),
  configuredKsefEnvironment: () => m.env,
}));
vi.mock('@sentry/nextjs', () => ({ captureMessage: m.captureMessage, captureException: m.captureException }));
vi.mock('next/cache', () => ({ revalidatePath: m.revalidate }));
// Magazyn: bajty archiwum oryginału (`downloadFromR2`); reszta modułu prawdziwa, klient S3 podstawiony.
vi.mock('@/lib/storage/r2-client', () => ({ getR2Config: () => ({ bucketName: 'b' }), getR2Client: () => ({ send: vi.fn() }) }));
vi.mock('@/lib/storage/r2', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/storage/r2')>()),
  downloadFromR2: (key: string, tenantId: string) => m.download(key, tenantId),
  downloadInvoiceXml: vi.fn(),
}));
// Suchy przebieg: domyślnie prawdziwy; `m.prepareOverride` wstrzykuje odmowy, których plik z generatora nie wywoła.
vi.mock('@/lib/ksef/duplicate-original-import', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/ksef/duplicate-original-import')>();
  return {
    ...real,
    prepareOriginalImport: (input: Parameters<typeof real.prepareOriginalImport>[0]) =>
      m.prepareOverride ? m.prepareOverride(input) : real.prepareOriginalImport(input),
  };
});
// Sąsiednie akcje pliku `actions-detail` — bez znaczenia dla decyzji.
vi.mock('@/lib/invoices/ksef-submit-enqueue', () => ({ enqueueKsefSubmitAfterDraft: vi.fn() }));
vi.mock('@/lib/audit/log', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/pdf/invoice-pdf', () => ({ generateInvoicePdf: vi.fn(), verifyInvoicePdfDeliveryState: vi.fn() }));
vi.mock('@/lib/pdf/invoice-data', () => ({ loadInvoiceForPdf: vi.fn() }));
vi.mock('@/lib/email/send', () => ({ sendInvoiceEmail: vi.fn() }));

import * as detailActions from '@/components/invoices/actions-detail';
import { deleteDraftInvoiceAction, sendDraftInvoiceAction } from '@/components/invoices/draft-actions';
import { KSEF_ORIGINAL_ALARM_KINDS } from '@/lib/ksef/duplicate-check';
import {
  DUPLICATE_DECISION_SQL_TEXTS,
  DUPLICATE_DECISION_TEXTS,
  fillSqlText,
  type DuplicateDecisionSqlTextKey,
} from '@/lib/ksef/duplicate-decision';
import { KSEF_SEND_MESSAGES } from '@/lib/invoices/ksef-send-policy';
import { generateFA3Xml } from '@/lib/xml/fa3-generator';
import { finalizeInvoice } from '@/lib/xml/invoice-calculator';

import { memoryClient } from './helpers/baza-w-pamieci';
import { DECIDED_AT, K, K2, Y_ID, Y_NR, duplicateCheck, knownNumberCheck, markerRow, numberTakenRow } from './helpers/decyzja-klienta';
import { withoutKey } from './helpers/ksef-duplicate-decision-cases';
import { memoryDb, type Row } from './helpers/ponowienie-specjalne-baza';

const T = DUPLICATE_DECISION_TEXTS;
const F = DUPLICATE_DECISION_TEXTS.FAKTFLOW;
const ALARM = KSEF_ORIGINAL_ALARM_KINDS;

/** Tekst SQL z `DUPLICATE_DECISION_SQL_TEXTS` wypełniony jak `RAISE` w 00149. */
const sql = (key: DuplicateDecisionSqlTextKey, ...args: string[]): string =>
  fillSqlText(DUPLICATE_DECISION_SQL_TEXTS[key].template, ...args);

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const X_ID = '22222222-2222-4222-8222-222222222221';
const K_ID = '33333333-3333-4333-8333-333333333331';
const NR = 'FV/12/10/2026';
/** NIP firmy = sprzedawca w pliku (reguła bramy `seller`); fikcyjne NIP-y z poprawną sumą kontrolną jak w sąsiednich testach. */
const TENANT_NIP = '5260001246';
const BUYER_NIP = '5252241585';
const ARCHIVE_PATH = `${TENANT}/ksef-import/${K}.xml`;

// ─── Prawdziwy plik z generatora FaktFlow ───────────────────────────────────

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const bytesOf = (xml: string): Buffer => Buffer.from(xml, 'utf8');

const faktura = finalizeInvoice({
  internalNumber: NR,
  type: 'VAT',
  issueDate: '2026-10-01',
  saleDate: '2026-10-01',
  seller: { nip: TENANT_NIP, name: 'ACME', address: { countryCode: 'PL', addressLine1: 'ul. A 1', addressLine2: '00-001 Warszawa' } },
  buyer: { nip: BUYER_NIP, name: 'Nabywca testowy', address: { countryCode: 'PL', addressLine1: 'ul. B 2', addressLine2: '02-001 Warszawa' } },
  lines: [{ ordinal: 1, name: 'Usługa', unit: 'usł.', quantity: 1, unitPriceNet: 100, vatRate: '23' }],
  payment: { currency: 'PLN', dueDate: '2026-10-15', method: 'transfer', bankAccount: 'PL61109010140000071219812874' },
});

/** Plik, który FaktFlow wysłał w pierwszej próbie i który KSeF ma pod numerem K (SystemInfo `KSeF SaaS v1.0`). */
const OUR_XML = generateFA3Xml(faktura, { generatedAt: new Date('2026-10-01T10:00:00.000Z') });
/** Ten sam plik w EUR — bieżąca brama ocenia go inaczej (`currency`) niż zapisana ocena `importable`. */
const XML_EUR = OUR_XML.replace('<KodWaluty>PLN</KodWaluty>', '<KodWaluty>EUR</KodWaluty>');
const SHA = sha256(bytesOf(OUR_XML));
const SIZE = bytesOf(OUR_XML).length;

/** `original_check.importGate` pliku z generatora: ocena `importable`, podgląd do panelu (kształt 5.2). */
const GATE_IMPORTABLE = {
  v: 1,
  rules: 1,
  kind: 'importable',
  problems: [],
  preview: {
    issueDate: '2026-10-01',
    saleDate: '2026-10-01',
    period: '10.2026',
    buyerIdKind: 'nip',
    annotations: [],
    exemptionBasis: null,
    lineCount: 1,
    lines: [{ ordinal: 1, name: 'Usługa', quantity: '1.0000', unit: 'usł.', unitPriceNet: '100.0000', vatRate: '23', gross: '123.00' }],
    totals: { net: '100.00', vat: '23.00', gross: '123.00' },
  },
};

/** Przegląd pliku (poprawna brama `review`): klient nie decyduje, decyduje operator (I5R). */
const GATE_REVIEW = { ...GATE_IMPORTABLE, kind: 'review', problems: ['gross-prices'] };

/** Oddanie decyzji klientowi przez operatora (`release_ksef_original_review`): oferta `released`. */
const GATE_RELEASED = {
  ...GATE_REVIEW,
  release: { at: '2026-10-03T09:00:00.000Z', via: 'operator', actorUserId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', note: 'Plik sprawdzony — nie powstał w FaktFlow.' },
};

/** `original_check` znacznika `faktflow-original` dla pliku `xml` (SHA i rozmiar liczone z bajtów). */
function faktflowCheck(patch: Row = {}, xml: string = OUR_XML): Row {
  const bytes = bytesOf(xml);
  return duplicateCheck({
    reason: 'faktflow-original',
    sha256: sha256(bytes),
    archivePath: ARCHIVE_PATH,
    sizeBytes: bytes.length,
    summary: {
      systemInfo: 'KSeF SaaS v1.0',
      number: NR,
      issueDate: '2026-10-01',
      buyerNip: BUYER_NIP,
      buyerName: 'Nabywca testowy',
      gross: '123.00',
      currency: 'PLN',
    },
    sameContentExceptHeader: false,
    ownHistory: false,
    importGate: GATE_IMPORTABLE,
    ...patch,
  });
}

// ─── Baza w pamięci ─────────────────────────────────────────────────────────

/** Faktura X: zwykła, `failed KSEF_DUPLICATE_RECONCILE`, NIP i kwota zgodne z oryginałem. */
function xRow(patch: Row = {}): Row {
  return {
    id: X_ID,
    tenant_id: TENANT,
    internal_number: NR,
    direction: 'outgoing',
    ksef_status: 'failed',
    last_error_code: 'KSEF_DUPLICATE_RECONCILE',
    last_error: F.LAST_ERROR(K),
    ksef_number: null,
    invoice_kind: 'regular',
    invoice_type: 'VAT',
    stripe_invoice_id: null,
    offline_idempotency_key: null,
    offline_qr_offline: null,
    offline_qr_certyfikat: null,
    paid_amount: 0,
    issue_date: '2026-10-02',
    sale_date: null,
    buyer_nip: BUYER_NIP,
    buyer_data: { nip: BUYER_NIP, name: 'Nabywca testowy' },
    gross_total: 123,
    currency: 'PLN',
    ...patch,
  };
}

/** Faktura Y — w FaktFlow ma numer KSeF oryginału (known-number). */
const yRow = (): Row => ({ id: Y_ID, tenant_id: TENANT, internal_number: Y_NR, direction: 'outgoing', ksef_status: 'accepted', ksef_number: K });

/** Faktura K zapisana decyzją: z datą nadania i sesją oryginału albo bez nich (I3K, alarmy po decyzji). */
function importedK(o: { date?: boolean; session?: boolean } = {}): { invoice: Row; submissions: Row[] } {
  const { date = true, session = true } = o;
  return {
    invoice: {
      id: K_ID,
      tenant_id: TENANT,
      direction: 'outgoing',
      origin: 'ksef_import',
      internal_number: NR,
      ksef_status: 'accepted',
      ksef_number: K,
      ksef_accepted_at: date ? '2026-09-30T08:00:00.000Z' : null,
    },
    submissions: session
      ? [{ id: 'sub-k-session', tenant_id: TENANT, invoice_id: K_ID, status: 'accepted', session_reference_number: 'SES-ORIG-1', response_ksef_number: K }]
      : [],
  };
}

function seed(o: { invoice?: Row; submissions?: Row[]; extraInvoices?: Row[]; k?: { date?: boolean; session?: boolean } | null } = {}): void {
  const imported = o.k === null ? null : importedK(o.k);
  m.tables = {
    invoices: [o.invoice ?? xRow(), ...(o.extraInvoices ?? []), ...(imported ? [imported.invoice] : [])],
    ksef_submissions: [...(o.submissions ?? [markerRow(TENANT, X_ID, { original_check: faktflowCheck() })]), ...(imported?.submissions ?? [])],
    tenants: [{ id: TENANT, nip: TENANT_NIP }],
  };
  m.session = memoryDb(m.tables);
  m.admin = memoryClient(m.tables);
}

/** Znacznik 440 z podanym `original_check` (jedyny wpis X, jak zostawia go runner). */
const withCheck = (check: Row): Row[] => [markerRow(TENANT, X_ID, { original_check: check })];

/** Szkic wycofany po decyzji: wpis `number_taken` z `decision` (00148 + klucze 00149). */
function decidedImport(patch: Row = {}, check: Row = {}): { invoice: Row; submissions: Row[] } {
  return {
    invoice: xRow({ ksef_status: 'draft', last_error_code: null, last_error: null, internal_number: null }),
    submissions: [numberTakenRow(TENANT, X_ID, 'automatic', {
      original_check: faktflowCheck({
        decision: {
          choice: 'same_sale', via: 'client', at: DECIDED_AT, reason: 'faktflow-original', env: 'test',
          mode: 'import', offer: 'pair', actorUserId: USER, note: null, importedInvoiceId: K_ID, retiredInternalNumber: NR, ...patch,
        },
        ...check,
      }),
    })],
  };
}

function decidedNoImport(patch: Row = {}): { invoice: Row; submissions: Row[] } {
  return {
    invoice: xRow({ ksef_status: 'draft', last_error_code: null, last_error: null }),
    submissions: [numberTakenRow(TENANT, X_ID, 'automatic', {
      original_check: faktflowCheck({
        importGate: GATE_RELEASED,
        decision: {
          choice: 'same_sale', via: 'client', at: DECIDED_AT, reason: 'faktflow-original', env: 'test',
          mode: 'no-import', offer: 'released', actorUserId: USER, note: null, ...patch,
        },
      }),
    })],
  };
}

// ─── Wywołanie akcji ────────────────────────────────────────────────────────

type Choice = 'same_sale' | 'other_sale';
type DecideInput = {
  invoiceId: string;
  choice: Choice;
  originalKsefNumber: string;
  originalSha256: string;
  confirmed: boolean;
  /** PR C (5.6): to, co pokazał panel. */
  mode?: 'import' | 'no-import' | null;
  offer?: string | null;
  env?: string | null;
};
type DecideResult = { success: true; message: string } | { success: false; error: string };

/** Wejście z panelu `faktflow-original` w ofercie `pair`; każde pole do nadpisania. */
async function decide(patch: Partial<DecideInput> = {}): Promise<DecideResult> {
  const action = detailActions.decideKsefDuplicateAction as unknown as (input: DecideInput) => Promise<DecideResult>;
  return action({
    invoiceId: X_ID,
    choice: 'same_sale',
    originalKsefNumber: K,
    originalSha256: SHA,
    confirmed: false,
    mode: 'import',
    offer: 'pair',
    env: 'test',
    ...patch,
  });
}

function originalResult(args: Row, patch: Row = {}): Row {
  const imported = args.p_mode === 'import';
  return {
    invoice_id: args.p_invoice_id,
    internal_number: imported ? null : NR,
    original_ksef_number: args.p_original_ksef_number,
    choice: args.p_choice,
    via: args.p_via,
    reason: 'faktflow-original',
    already_decided: false,
    submissions_closed: 2,
    mode: args.p_mode,
    offer: args.p_offer,
    imported_invoice_id: imported ? K_ID : null,
    retired_internal_number: imported ? NR : null,
    acquired_at_missing: false,
    session_missing: false,
    ...patch,
  };
}

/** Odpowiedzi RPC serwisowego: decyzja `_original`, znacznik „sprawdź ponownie” i — dla powodów PR B — 9-argumentowa decyzja. */
function defaultRpc(fn: string, args: Row): { data: unknown; error: null } {
  switch (fn) {
    case 'decide_ksef_duplicate_original':
      return { data: originalResult(args), error: null };
    case 'flag_ksef_original_recheck':
      return { data: { flagged: true }, error: null };
    case 'decide_ksef_duplicate':
      return {
        data: {
          invoice_id: args.p_invoice_id, internal_number: NR, original_ksef_number: args.p_original_ksef_number,
          choice: args.p_choice, via: args.p_via, reason: 'known-number', already_decided: false, submissions_closed: 1,
        },
        error: null,
      };
    default:
      throw new Error(`zapis-oryginalu-akcja: nieoczekiwane RPC serwisowe ${fn}`);
  }
}

const rpcNames = (): string[] => m.rpc.mock.calls.map(([fn]) => fn as string);
const rpcArgs = (fn: string): Row => {
  const call = m.rpc.mock.calls.find(([name]) => name === fn);
  expect(call, `brak wywołania RPC ${fn}`).toBeDefined();
  return call![1] as Row;
};

/** Alarmy Sentry danego rodzaju (`tags.kind`) — `captureMessage` z `level: 'warning'`. */
const alarmsOf = (kind: string): Array<[string, Row]> =>
  (m.captureMessage.mock.calls as Array<[string, Row]>).filter(([, options]) => (options.tags as Row | undefined)?.kind === kind);
const alarmKinds = (): string[] => (m.captureMessage.mock.calls as Array<[string, Row]>)
  .map(([, options]) => (options.tags as Row | undefined)?.kind as string).filter(Boolean).sort();

function expectAlarm(kind: string, extra: Row = {}): void {
  const found = alarmsOf(kind);
  expect(found, `alarm ${kind}`).toHaveLength(1);
  expect(found[0]![1]).toMatchObject({
    level: 'warning',
    tags: { area: 'ksef.duplicate-decision', kind },
    fingerprint: [kind, X_ID],
    ...extra,
  });
}

/** Nic nie poszło do bazy ani do magazynu — odmowa przed suchym przebiegiem. */
function expectNothingWritten(): void {
  expect(m.rpc).not.toHaveBeenCalled();
  expect(m.download).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.resetAllMocks();
  m.role = 'owner';
  m.env = 'test';
  m.prepareOverride = null;
  seed();
  m.rpc.mockImplementation(async (fn: string, args: Row) => defaultRpc(fn, args));
  // Blokada SQL dla sesji klienta (4.9): NULL = faktura czeka na decyzję.
  m.sessionRpc.mockResolvedValue({ data: null, error: null });
  m.download.mockImplementation(async () => bytesOf(OUR_XML));
});

describe('decideKsefDuplicateAction — zapis oryginału z FaktFlow, oferta pair/record (D-A4-1b-3 PR C)', () => {
  it.each([
    ['same_sale', false, F.TOAST_SAME(NR)],
    ['other_sale', true, F.TOAST_OTHER(NR)],
  ] as const)('ZA1: oferta pair, %s — jedno RPC decide_ksef_duplicate_original (tryb import, oferta, projekcja z archiwum), nigdy 9-argumentowe; toast z wyniku', async (choice, confirmed, toast) => {
    const r = await decide({ choice, confirmed });

    expect(r).toEqual({ success: true, message: toast });
    expect(rpcNames()).toEqual(['decide_ksef_duplicate_original']);
    expect(rpcArgs('decide_ksef_duplicate_original')).toMatchObject({
      p_invoice_id: X_ID,
      p_tenant_id: TENANT,
      p_actor_user_id: USER,
      p_choice: choice,
      p_via: 'client',
      p_original_ksef_number: K,
      p_original_sha256: SHA,
      p_env: 'test',
      p_note: null,
      p_mode: 'import',
      p_offer: 'pair',
      p_import: {
        v: 1,
        invoice: { internal_number: NR },
        lines: [expect.objectContaining({ ordinal: 1, name: 'Usługa' })],
        xml: { storage_path: ARCHIVE_PATH, sha256: SHA, size_bytes: SIZE },
      },
    });
    // Blokadę czyta sesja klienta (4.9), plik — suchy przebieg z archiwum tej firmy.
    expect(m.sessionRpc).toHaveBeenCalledWith('ksef_duplicate_decision_blocker_for_session', { p_invoice_id: X_ID });
    expect(m.download).toHaveBeenCalledWith(ARCHIVE_PATH, TENANT);
    expect(m.revalidate).toHaveBeenCalledWith('/invoices');
    expect(m.revalidate).toHaveBeenCalledWith(`/invoices/${X_ID}`);
    // K z datą nadania i sesją — nie ma czego alarmować.
    expect(m.captureMessage).not.toHaveBeenCalled();
    expect(m.captureException).not.toHaveBeenCalled();
  });

  it('ZA2: oferta record (ta sama treść) — jeden wybór „ta sama sprzedaż”, p_offer record, toast „Zapisano fakturę …”; bez „Rozumiem skutki”', async () => {
    seed({ submissions: withCheck(faktflowCheck({ sameContentExceptHeader: true })) });

    const r = await decide({ offer: 'record', confirmed: false });

    expect(r).toEqual({ success: true, message: F.TOAST_RECORD(NR) });
    expect(rpcNames()).toEqual(['decide_ksef_duplicate_original']);
    expect(rpcArgs('decide_ksef_duplicate_original')).toMatchObject({ p_choice: 'same_sale', p_mode: 'import', p_offer: 'record' });
  });

  it('ZA2: oferta record (własna historia w JSON, treść inna) — „Rozumiem skutki” wymagane na serwerze; z potwierdzeniem RPC z ofertą record', async () => {
    seed({ submissions: withCheck(faktflowCheck({ ownHistory: true })) });

    expect(await decide({ offer: 'record', confirmed: false })).toEqual({ success: false, error: T.CONFIRM });
    expect(m.rpc).not.toHaveBeenCalled();
    expect(m.download).not.toHaveBeenCalled();

    const r = await decide({ offer: 'record', confirmed: true });

    expect(r).toEqual({ success: true, message: F.TOAST_RECORD(NR) });
    expect(rpcArgs('decide_ksef_duplicate_original')).toMatchObject({ p_offer: 'record', p_mode: 'import' });
  });

  it('ZA3 (T3): JSON ownHistory=false, ale plik oryginału jest w próbach tego dokumentu (request_payload_hash) — oferta record liczona z bazy: pair → STALE, record → zapis', async () => {
    const attempt = { id: 'sub-x-1', tenant_id: TENANT, invoice_id: X_ID, status: 'sent', error_code: null, session_reference_number: 'SES-X-1', request_payload_hash: SHA, response_ksef_number: null, original_ksef_number: null, original_session_reference_number: null, original_check: null, attempted_at: '2026-10-01T09:00:00.000Z', completed_at: null };
    seed({ submissions: [attempt, ...withCheck(faktflowCheck())] });

    expect(await decide({ offer: 'pair', choice: 'same_sale' })).toEqual({ success: false, error: T.STALE });
    expect(m.rpc).not.toHaveBeenCalled();

    // Treść z naszego pliku nie jest „ta sama” (sameContent=false) — „Rozumiem skutki” wymagane.
    const r = await decide({ offer: 'record', choice: 'same_sale', confirmed: true });

    expect(r).toEqual({ success: true, message: F.TOAST_RECORD(NR) });
    expect(rpcArgs('decide_ksef_duplicate_original')).toMatchObject({ p_offer: 'record', p_mode: 'import' });
  });

  it.each([
    ['tryb no-import przy widoku import', { mode: 'no-import' as const }],
    ['brak trybu (panel sprzed PR C)', { mode: null }],
    ['oferta record przy widoku pair', { offer: 'record' }],
    ['oferta released przy widoku pair', { offer: 'released' }],
    ['brak oferty', { offer: null }],
    ['środowisko production przy serwerze test', { env: 'production' }],
  ])('ZA4 (INV-8): %s — STALE, bez RPC i bez odczytu archiwum', async (_label, patch) => {
    const r = await decide(patch);

    expect(r).toEqual({ success: false, error: T.STALE });
    expectNothingWritten();
  });

  it('ZA4: świeży powód known-number (cron zrobił nowy werdykt), a panel przysłał mode=import — STALE, bez RPC (9-argumentowe też nie)', async () => {
    seed({ submissions: withCheck(knownNumberCheck({ sha256: SHA })), extraInvoices: [yRow()] });

    const r = await decide({ mode: 'import', offer: 'pair', choice: 'other_sale', confirmed: true });

    expect(r).toEqual({ success: false, error: T.STALE });
    expectNothingWritten();
  });

  it.each([
    ['inny numer KSeF niż na stronie', { originalKsefNumber: K2 }],
    ['inny SHA-256 niż na stronie', { originalSha256: 'cc'.repeat(32) }],
  ])('ZA4: %s — STALE, bez RPC i bez odczytu archiwum', async (_label, patch) => {
    const r = await decide(patch);

    expect(r).toEqual({ success: false, error: T.STALE });
    expectNothingWritten();
  });

  it.each([
    ['własna historia w JSON', faktflowCheck({ ownHistory: true })],
    ['ta sama treść poza nagłówkiem', faktflowCheck({ sameContentExceptHeader: true })],
  ])('ZA5 (C3/C5): oferta record (%s), „inna sprzedaż” — CHOICE z numerem dokumentu, bez RPC, bez odczytu archiwum i bez znacznika', async (_label, check) => {
    seed({ submissions: withCheck(check) });

    const r = await decide({ offer: 'record', choice: 'other_sale', confirmed: true });

    expect(r).toEqual({ success: false, error: sql('CHOICE', NR) });
    expectNothingWritten();
  });

  it.each([
    ['pair, „inna sprzedaż” przy tym samym NIP nabywcy', 'pair', 'other_sale', {}, {}],
    ['pair, „ta sama sprzedaż” przy innej kwocie brutto', 'pair', 'same_sale', { gross_total: 150 }, {}],
    ['pair, „ta sama sprzedaż” przy innym NIP nabywcy', 'pair', 'same_sale', { buyer_nip: '1234567899', buyer_data: { nip: '1234567899', name: 'Inny nabywca' } }, {}],
    ['record z treścią inną niż plik oryginału (własna historia)', 'record', 'same_sale', {}, { ownHistory: true }],
    ['record z nieznaną zgodnością treści (sameContentExceptHeader null)', 'record', 'same_sale', {}, { sameContentExceptHeader: null, ownHistory: true }],
  ] as const)('ZA6: %s bez „Rozumiem skutki” — CONFIRM, bez RPC i bez odczytu archiwum; z zaznaczeniem ta sama decyzja idzie do RPC', async (_label, offer, choice, invoicePatch, checkPatch) => {
    seed({ invoice: xRow(invoicePatch), submissions: withCheck(faktflowCheck(checkPatch)) });

    const unconfirmed = await decide({ offer, choice, confirmed: false });

    expect(unconfirmed).toEqual({ success: false, error: T.CONFIRM });
    expectNothingWritten();

    const confirmed = await decide({ offer, choice, confirmed: true });

    expect(confirmed.success).toBe(true);
    expect(rpcNames()).toEqual(['decide_ksef_duplicate_original']);
  });

  it('ZA6: pair, „ta sama sprzedaż” przy zgodnym NIP i kwocie — bez tarcia, RPC także bez potwierdzenia', async () => {
    const r = await decide({ choice: 'same_sale', confirmed: false });

    expect(r.success).toBe(true);
    expect(rpcNames()).toEqual(['decide_ksef_duplicate_original']);
  });
});

describe('decideKsefDuplicateAction — suchy przebieg zapisu oryginału i znacznik „sprawdź ponownie” (INV-25)', () => {
  /** Odmowy, które daje PRAWDZIWY `prepareOriginalImport` na pliku z archiwum. */
  const REAL_FAILURES: Array<[string, () => Partial<DecideInput>, string]> = [
    ['archive-missing: brak obiektu w magazynie (NoSuchKey)', () => {
      m.download.mockRejectedValue(new NoSuchKey({ message: 'The specified key does not exist.', $metadata: {} }));
      return {};
    }, 'archive-missing'],
    ['archive-mismatch: inny SHA-256 bajtów niż w original_check', () => {
      m.download.mockResolvedValue(bytesOf(`${OUR_XML}\n`));
      return {};
    }, 'archive-mismatch'],
    ['archive-mismatch: inny rozmiar niż w original_check (ten sam SHA-256)', () => {
      seed({ submissions: withCheck(faktflowCheck({ sizeBytes: SIZE + 1 })) });
      return {};
    }, 'archive-mismatch'],
    ['gate-drift: bieżąca ocena pliku (waluta EUR) inna niż zapisana „importable”', () => {
      seed({ submissions: withCheck(faktflowCheck({}, XML_EUR)) });
      m.download.mockResolvedValue(bytesOf(XML_EUR));
      return { originalSha256: sha256(bytesOf(XML_EUR)) };
    }, 'gate-drift'],
  ];

  /** Odmowy `not-buildable`: przy ofercie pair/record to błąd programu (brama mówiła „importable”) — wstrzyknięte. */
  const NOT_BUILDABLE: Array<[string, string]> = [
    ['lines', 'not-buildable'],
    ['totals', 'not-buildable'],
    ['number', 'import-mismatch'],
    ['seller', 'import-mismatch'],
  ];

  it.each(REAL_FAILURES)('ZB1: %s — RECHECK z numerem dokumentu, flag_ksef_original_recheck z właściwym rodzajem, jeden alarm Sentry z odciskiem, bez RPC decyzji', async (_label, arrange, kind) => {
    const patch = arrange();

    const r = await decide({ choice: 'other_sale', confirmed: true, ...patch });

    expect(r).toEqual({ success: false, error: F.RECHECK(NR) });
    expect(rpcNames()).toEqual(['flag_ksef_original_recheck']);
    expect(rpcArgs('flag_ksef_original_recheck')).toEqual({
      p_invoice_id: X_ID,
      p_tenant_id: TENANT,
      p_actor_user_id: USER,
      p_original_ksef_number: K,
      p_original_sha256: patch.originalSha256 ?? SHA,
      p_kind: kind,
    });
    expectAlarm(ALARM.recheck);
    expect(alarmKinds()).toEqual([ALARM.recheck]);
  });

  it.each(NOT_BUILDABLE)('ZB2: not-buildable:%s przy ofercie pair — RECHECK, znacznik %s, jeden alarm recheck z tagiem detail, bez RPC decyzji', async (detail, kind) => {
    m.prepareOverride = async () => ({ ok: false, kind: 'not-buildable', detail });

    const r = await decide({ choice: 'other_sale', confirmed: true });

    expect(r).toEqual({ success: false, error: F.RECHECK(NR) });
    expect(rpcNames()).toEqual(['flag_ksef_original_recheck']);
    expect(rpcArgs('flag_ksef_original_recheck')).toMatchObject({ p_invoice_id: X_ID, p_original_ksef_number: K, p_original_sha256: SHA, p_kind: kind });
    expectAlarm(ALARM.recheck, { tags: { area: 'ksef.duplicate-decision', kind: ALARM.recheck, detail: expect.stringContaining(detail) } });
    expect(alarmKinds()).toEqual([ALARM.recheck]);
  });

  it('ZB3: znacznik „sprawdź ponownie” już jest (flag zwraca already) — klient nadal dostaje RECHECK, bez błędu i bez RPC decyzji', async () => {
    m.download.mockRejectedValue(new NoSuchKey({ message: 'The specified key does not exist.', $metadata: {} }));
    m.rpc.mockImplementation(async (fn: string, args: Row) =>
      fn === 'flag_ksef_original_recheck' ? { data: { flagged: false, already: true }, error: null } : defaultRpc(fn, args));

    const r = await decide();

    expect(r).toEqual({ success: false, error: F.RECHECK(NR) });
    expect(rpcNames()).toEqual(['flag_ksef_original_recheck']);
  });

  it.each([
    ['flag_ksef_original_recheck zwraca błąd bazy', () => m.rpc.mockImplementation(async (fn: string, args: Row) =>
      fn === 'flag_ksef_original_recheck' ? { data: null, error: { code: 'XX000', message: 'PRIVATE-DB-DIAGNOSTIC' } } : defaultRpc(fn, args))],
    ['flag_ksef_original_recheck rzuca wyjątek klienta', () => m.rpc.mockImplementation(async (fn: string, args: Row) => {
      if (fn === 'flag_ksef_original_recheck') throw new Error('PRIVATE fetch failed');
      return defaultRpc(fn, args);
    })],
  ])('ZB4: %s — klient nadal dostaje RECHECK, a błąd zapisu znacznika trafia do Sentry (jedyny ślad)', async (_label, arrange) => {
    m.download.mockRejectedValue(new NoSuchKey({ message: 'The specified key does not exist.', $metadata: {} }));
    arrange();

    const r = await decide();

    expect(r).toEqual({ success: false, error: F.RECHECK(NR) });
    expect(rpcNames()).toEqual(['flag_ksef_original_recheck']);
    expect(m.captureException).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tags: expect.objectContaining({ kind: ALARM.recheckFlag }) }),
    );
  });

  // Finding 5 (recenzja commitów 6–8): `flag_ksef_original_recheck` odpowiada `{flagged:false, reason:'stale'|'not-pending'}`,
  // gdy stan zmienił się od kliknięcia (np. operator zdecydował w międzyczasie). Tekst „sprawdzamy” i alarm byłyby nieprawdziwe.
  describe.each(['stale', 'not-pending'] as const)('ZB6: flag_ksef_original_recheck odpowiada %s', (reason) => {
    const flagReplies = (): void => {
      m.rpc.mockImplementation(async (fn: string, args: Row) =>
        fn === 'flag_ksef_original_recheck' ? { data: { flagged: false, reason }, error: null } : defaultRpc(fn, args));
    };

    it('brak obiektu w magazynie (NoSuchKey) — STALE zamiast RECHECK, bez alarmu recheck i bez RPC decyzji', async () => {
      m.download.mockRejectedValue(new NoSuchKey({ message: 'The specified key does not exist.', $metadata: {} }));
      flagReplies();

      const r = await decide();

      expect(r).toEqual({ success: false, error: T.STALE });
      expect(rpcNames()).toEqual(['flag_ksef_original_recheck']);
      expect(alarmKinds()).toEqual([]);
    });

    it('not-buildable:lines przy ofercie pair — STALE zamiast RECHECK, bez alarmu recheck', async () => {
      m.prepareOverride = async () => ({ ok: false, kind: 'not-buildable', detail: 'lines' });
      flagReplies();

      const r = await decide({ choice: 'other_sale', confirmed: true });

      expect(r).toEqual({ success: false, error: T.STALE });
      expect(rpcNames()).toEqual(['flag_ksef_original_recheck']);
      expect(alarmKinds()).toEqual([]);
    });

    it.each([
      ['P0001 import-mismatch:number', { code: 'P0001', message: 'IMPORT_MISMATCH', details: 'import-mismatch:number' }],
      ['22023 import-projection:lines', { code: '22023', message: 'KSeF original import projection rejected', details: 'import-projection:lines' }],
    ])('odmowa bazy %s — STALE zamiast RECHECK, bez alarmu import-refused', async (_label, error) => {
      m.rpc.mockImplementation(async (fn: string, args: Row) => {
        if (fn === 'decide_ksef_duplicate_original') return { data: null, error };
        if (fn === 'flag_ksef_original_recheck') return { data: { flagged: false, reason }, error: null };
        return defaultRpc(fn, args);
      });

      const r = await decide();

      expect(r).toEqual({ success: false, error: T.STALE });
      expect(rpcNames()).toEqual(['decide_ksef_duplicate_original', 'flag_ksef_original_recheck']);
      expect(alarmKinds()).toEqual([]);
    });
  });

  it('ZB5: błąd odczytu magazynu (chwilowy) — READ_FAILED, captureException z przyczyną, BEZ znacznika i bez RPC decyzji', async () => {
    const cause = new Error('R2: connect ETIMEDOUT');
    m.download.mockRejectedValue(cause);

    const r = await decide();

    expect(r).toEqual({ success: false, error: F.READ_FAILED(NR) });
    expect(m.rpc).not.toHaveBeenCalled();
    expect((m.captureException.mock.calls as unknown[][]).some(([err]) => err === cause)).toBe(true);
    expect(alarmKinds()).toEqual([]);
  });
});

describe('decideKsefDuplicateAction — odmowy RPC decide_ksef_duplicate_original (5.6 krok 11)', () => {
  const rpcError = (error: Row) => m.rpc.mockImplementation(async (fn: string, args: Row) =>
    fn === 'decide_ksef_duplicate_original' ? { data: null, error } : defaultRpc(fn, args));

  it.each([
    ['mode', sql('STALE', NR)],
    ['offer', sql('STALE', NR)],
    ['choice', sql('CHOICE', NR)],
    ['already', sql('ALREADY_IMPORTED', NR, F.IMPORTED_CARD_CHOICE.same_sale)],
    ['recheck-needed', sql('recheck-needed', NR)],
    ['provenance-review', sql('provenance-review', NR)],
    ['known-now', sql('known-now', K, NR)],
    ['cross-tenant', sql('cross-tenant', NR, NR)],
  ])('ZC1: P0001 DETAIL „%s” (wyścig — stan zmienił się od odczytu) — tekst z bazy dla klienta, bez znacznika i bez Sentry', async (details, message) => {
    rpcError({ code: 'P0001', message, details });

    const r = await decide();

    expect(r).toEqual({ success: false, error: message });
    expect(rpcNames()).toEqual(['decide_ksef_duplicate_original']);
    expect(m.captureMessage).not.toHaveBeenCalled();
    expect(m.captureException).not.toHaveBeenCalled();
  });

  it.each([
    ['P0001 import-mismatch:number', 'import-mismatch', 'number', { code: 'P0001', message: sql('IMPORT_MISMATCH', K, NR), details: 'import-mismatch:number' }],
    ['P0001 import-mismatch:seller', 'import-mismatch', 'seller', { code: 'P0001', message: sql('IMPORT_MISMATCH', K, NR), details: 'import-mismatch:seller' }],
    ['22023 import-projection:totals', 'import-projection', 'totals', { code: '22023', message: 'KSeF original import projection rejected', details: 'import-projection:totals' }],
    ['22023 import-projection:fa3', 'import-projection', 'fa3', { code: '22023', message: 'KSeF original import projection rejected', details: 'import-projection:fa3' }],
  ])('ZC2: %s — lustro TS przepuściło to, czego baza nie przyjęła: RECHECK, znacznik z rodzajem i alarm ksef-duplicate-import-refused z tagiem detail', async (_label, kind, detail, error) => {
    rpcError(error);

    const r = await decide();

    expect(r).toEqual({ success: false, error: F.RECHECK(NR) });
    expect(rpcNames()).toEqual(['decide_ksef_duplicate_original', 'flag_ksef_original_recheck']);
    expect(rpcArgs('flag_ksef_original_recheck')).toMatchObject({ p_invoice_id: X_ID, p_original_ksef_number: K, p_original_sha256: SHA, p_kind: kind });
    expectAlarm(ALARM.importRefused, { tags: { area: 'ksef.duplicate-decision', kind: ALARM.importRefused, detail: expect.stringContaining(detail) } });
    expect(alarmKinds()).toEqual([ALARM.importRefused]);
  });

  it('ZC3: inny P0001 (np. wiersz payments niewidoczny dla sesji) — komunikat bazy dla klienta i ostrzeżenie Sentry o rozjeździe polityki', async () => {
    const message = sql('payments', NR);
    rpcError({ code: 'P0001', message });

    const r = await decide();

    expect(r).toEqual({ success: false, error: message });
    expect(m.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('RPC odmówiło mimo zgody polityki'),
      expect.objectContaining({ level: 'warning', tags: expect.objectContaining({ area: 'ksef.duplicate-decision' }) }),
    );
    expect(rpcNames()).toEqual(['decide_ksef_duplicate_original']);
  });

  it.each([
    ['P0002 (faktura nie tej firmy)', 'P0002', KSEF_SEND_MESSAGES.notFound],
    ['42501 (rola)', '42501', T.ROLE],
  ])('ZC4: RPC zwraca %s — tekst klienta', async (_label, code, expected) => {
    rpcError({ code, message: 'PRIVATE-DB-DIAGNOSTIC' });

    const r = await decide();

    expect(r).toEqual({ success: false, error: expected });
  });

  it.each([
    ['błąd bazy z RPC', () => rpcError({ code: '57014', message: 'PRIVATE canceling statement due to statement timeout' })],
    ['wyjątek klienta RPC', () => m.rpc.mockImplementation(async (fn: string, args: Row) => {
      if (fn === 'decide_ksef_duplicate_original') throw new Error('PRIVATE fetch failed');
      return defaultRpc(fn, args);
    })],
  ])('ZC5: %s — GENERIC bez szczegółów bazy i jedno captureException', async (_label, arrange) => {
    arrange();

    const r = await decide();

    expect(r).toEqual({ success: false, error: T.GENERIC });
    expect(m.captureException).toHaveBeenCalledTimes(1);
  });
});

describe('decideKsefDuplicateAction — blokada SQL i ocena pliku w polityce klienta (5.5)', () => {
  it.each([
    ['cross-tenant', sql('cross-tenant', NR, NR)],
    ['known-now', sql('known-now', K, NR)],
    ['recheck-needed', sql('recheck-needed', NR)],
    ['payments', sql('payments', NR)],
    // Wyścig: baza już widzi przegląd pliku, a TS (brama importable) jeszcze nie — baza ma ostatnie słowo.
    ['provenance-review', sql('provenance-review', NR)],
  ])('ZD1: blokada SQL „%s” z sesji klienta — odmowa z tekstem z numerem dokumentu, bez odczytu archiwum, bez RPC i bez znacznika', async (code, message) => {
    m.sessionRpc.mockResolvedValue({ data: code, error: null });

    const r = await decide();

    expect(r).toEqual({ success: false, error: message });
    expectNothingWritten();
    expect(m.sessionRpc).toHaveBeenCalledWith('ksef_duplicate_decision_blocker_for_session', { p_invoice_id: X_ID });
  });

  it('ZD1: odczyt blokady nieudany (błąd bazy sesji) — READ_FAILED, fail-closed: bez archiwum i bez RPC', async () => {
    m.sessionRpc.mockResolvedValue({ data: null, error: { code: 'XX000', message: 'PRIVATE-DB-DIAGNOSTIC' } });

    const r = await decide();

    expect(r).toEqual({ success: false, error: F.READ_FAILED(NR) });
    expectNothingWritten();
  });

  it.each([
    ['znacznik bez importGate (sprzed 00149 / stary runner)', withoutKey(faktflowCheck(), 'importGate')],
    ['znacznik z recheckNeeded (odmowa w chwili zapisu)', faktflowCheck({ recheckNeeded: { kind: 'archive-missing', at: '2026-10-05T10:00:00.000Z' } })],
    ['brama w złym kształcie (kind importable z problemem)', faktflowCheck({ importGate: { ...GATE_IMPORTABLE, problems: ['rates'] } })],
  ])('ZD2 (INV-10 c): %s — recheck-needed liczone przez TS z JSON (lustro 11c), bez RPC i bez archiwum', async (_label, check) => {
    seed({ submissions: withCheck(check) });

    const r = await decide();

    expect(r).toEqual({ success: false, error: sql('recheck-needed', NR) });
    expectNothingWritten();
  });

  it('ZD3 (T8): poprawna brama „review” — klient: provenance-review (decyzję podejmie operator), bez archiwum, bez RPC i bez znacznika', async () => {
    seed({ submissions: withCheck(faktflowCheck({ importGate: GATE_REVIEW })) });

    const r = await decide({ offer: 'review-pair' });

    expect(r).toEqual({ success: false, error: sql('provenance-review', NR) });
    expectNothingWritten();
  });
});

describe('decideKsefDuplicateAction — oddana decyzja (FO-ODDANA), tryb no-import', () => {
  beforeEach(() => {
    seed({ submissions: withCheck(faktflowCheck({ importGate: GATE_RELEASED })) });
  });

  it.each([
    ['same_sale', T.TOAST_SAME(NR)],
    ['other_sale', T.TOAST_OTHER],
  ] as const)('ZE1: oferta released, %s — RPC decide_ksef_duplicate_original w trybie no-import bez projekcji, bez odczytu archiwum; toast jak w PR B', async (choice, toast) => {
    const r = await decide({ choice, confirmed: true, mode: 'no-import', offer: 'released' });

    expect(r).toEqual({ success: true, message: toast });
    expect(rpcNames()).toEqual(['decide_ksef_duplicate_original']);
    expect(rpcArgs('decide_ksef_duplicate_original')).toMatchObject({
      p_invoice_id: X_ID, p_choice: choice, p_via: 'client', p_original_ksef_number: K, p_original_sha256: SHA, p_env: 'test',
      p_note: null, p_mode: 'no-import', p_offer: 'released', p_import: null,
    });
    expect(m.download).not.toHaveBeenCalled();
    expect(m.captureMessage).not.toHaveBeenCalled();
  });

  it('ZE2: oferta released, a panel przysłał mode=import / offer=pair (stara karta sprzed oddania) — STALE, bez RPC', async () => {
    const r = await decide({ mode: 'import', offer: 'pair', confirmed: true });

    expect(r).toEqual({ success: false, error: T.STALE });
    expectNothingWritten();
  });

  it('ZE3: oferta released — „Rozumiem skutki” wg reguł PR B („inna sprzedaż” przy tym samym NIP) wymagane na serwerze', async () => {
    const r = await decide({ choice: 'other_sale', confirmed: false, mode: 'no-import', offer: 'released' });

    expect(r).toEqual({ success: false, error: T.CONFIRM });
    expect(m.rpc).not.toHaveBeenCalled();
  });
});

describe('decideKsefDuplicateAction — po decyzji: alarmy ze stanu bazy i toast z wyniku (INV-13, T5)', () => {
  type KState = { date: boolean; session: boolean };
  const ALARM_CASES: Array<[string, KState, string[]]> = [
    ['K z datą nadania i sesją oryginału', { date: true, session: true }, []],
    ['K bez daty nadania (ksef_accepted_at NULL)', { date: false, session: true }, [ALARM.importNoDate]],
    ['K bez sesji oryginału (brak wpisu z sesją)', { date: true, session: false }, [ALARM.importNoSession]],
    ['K bez daty i bez sesji', { date: false, session: false }, [ALARM.importNoDate, ALARM.importNoSession].sort()],
  ];

  /** Trzy ścieżki sukcesu akcji; stan K ze ścieżki (zawsze z bazy — flagi z RPC są `false`). */
  const PATHS: Array<[string, (k: KState) => void]> = [
    ['nowa decyzja (RPC zapisuje K)', (k) => seed({ k })],
    ['already_decided (zgubiona odpowiedź, drugie kliknięcie)', (k) => {
      seed({ k });
      m.rpc.mockImplementation(async (fn: string, args: Row) =>
        fn === 'decide_ksef_duplicate_original' ? { data: originalResult(args, { already_decided: true }), error: null } : defaultRpc(fn, args));
    }],
    ['wczesny widok decided (szkic już wycofany, RPC niewołane)', (k) => {
      const decided = decidedImport();
      seed({ invoice: decided.invoice, submissions: decided.submissions, k });
    }],
  ];

  describe.each(PATHS)('ścieżka: %s', (pathLabel, arrange) => {
    it.each(ALARM_CASES)('ZF1: %s — sukces z toastem „Zapisano …” i alarmy tylko dla brakujących danych K (odcisk [kind, X])', async (_label, k, expected) => {
      arrange(k);

      const r = await decide({ choice: 'same_sale' });

      expect(r).toEqual({ success: true, message: F.TOAST_SAME(NR) });
      expect(alarmKinds()).toEqual(expected);
      for (const kind of expected) {
        expectAlarm(kind, { extra: expect.objectContaining({ tenantId: TENANT, invoiceId: X_ID, importedInvoiceId: K_ID }) });
      }
      if (pathLabel.startsWith('wczesny')) {
        expect(m.rpc).not.toHaveBeenCalled();
        expect(m.download).not.toHaveBeenCalled();
      }
    });
  });

  it('ZF2: ponowienie tej samej decyzji wysyła alarm z tym samym odciskiem [kind, X] (Sentry grupuje po odcisku, nie mnoży zgłoszeń)', async () => {
    const decided = decidedImport();
    seed({ invoice: decided.invoice, submissions: decided.submissions, k: { date: false, session: true } });

    await decide();
    await decide();

    const found = alarmsOf(ALARM.importNoDate);
    expect(found).toHaveLength(2);
    expect(found[0]![1].fingerprint).toEqual([ALARM.importNoDate, X_ID]);
    expect(found[1]![1].fingerprint).toEqual(found[0]![1].fingerprint);
  });

  it('ZF3: błąd odczytu K po decyzji nie cofa sukcesu — decyzja zapisana, błąd do Sentry (captureException), I3K i tak pokaże stan', async () => {
    const failing = memoryClient(m.tables);
    m.admin = {
      from: (table: string) => {
        if (table === 'invoices') throw new Error('PRIVATE odczyt K nieudany');
        return failing.from(table);
      },
    };

    const r = await decide();

    expect(r.success).toBe(true);
    expect(m.captureException).toHaveBeenCalled();
  });

  it('ZF4: wczesny widok decided — zapisana decyzja z ofertą record: sukces z toastem „Zapisano fakturę …” z ZAPISANEJ oferty (stara karta przysłała offer=pair), bez RPC', async () => {
    const decided = decidedImport({ offer: 'record' }, { sameContentExceptHeader: true });
    seed({ invoice: decided.invoice, submissions: decided.submissions });

    const r = await decide({ offer: 'pair' });

    expect(r).toEqual({ success: true, message: F.TOAST_RECORD(NR) });
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it('ZF4: wczesny widok decided — zapisany import, a stara karta przysłała mode=no-import / offer=released: toast z zapisanej decyzji („jest w FaktWay”), nie z wejścia', async () => {
    const decided = decidedImport({ choice: 'other_sale' });
    seed({ invoice: decided.invoice, submissions: decided.submissions });

    const r = await decide({ choice: 'other_sale', confirmed: true, mode: 'no-import', offer: 'released' });

    expect(r).toEqual({ success: true, message: F.TOAST_OTHER(NR) });
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ['import, pair, „ta sama sprzedaż” — inny wybór niż zapisany', decidedImport(), { choice: 'other_sale' as const }, sql('ALREADY_IMPORTED', NR, F.IMPORTED_CARD_CHOICE.same_sale)],
    ['import, pair, „inna sprzedaż” — inny wybór niż zapisany', decidedImport({ choice: 'other_sale' }), { choice: 'same_sale' as const }, sql('ALREADY_IMPORTED', NR, F.IMPORTED_CARD_CHOICE.other_sale)],
    ['import, record („zapis faktury z KSeF”) — inny wybór niż zapisany', decidedImport({ offer: 'record' }), { choice: 'other_sale' as const, offer: 'record' }, sql('ALREADY_IMPORTED', NR, F.IMPORTED_CARD_CHOICE.record)],
    ['import, ten sam wybór, ale inny numer KSeF niż zapisany', decidedImport(), { originalKsefNumber: K2 }, sql('ALREADY_IMPORTED', NR, F.IMPORTED_CARD_CHOICE.same_sale)],
  ])('ZF5: zapisana decyzja (%s) — ALREADY_IMPORTED z dawnym numerem dokumentu i etykietą zapisanej decyzji, bez RPC', async (_label, decided, patch, message) => {
    seed({ invoice: decided.invoice, submissions: decided.submissions });

    const r = await decide({ confirmed: true, ...patch });

    expect(r).toEqual({ success: false, error: message });
    expect(m.rpc).not.toHaveBeenCalled();
    expect(m.download).not.toHaveBeenCalled();
  });

  // STRAŻNIK (spec 7.2 wymienia ten przypadek, ale zachowanie PR B już go spełnia — zielony przed i po):
  // zgubiona odpowiedź po decyzji no-import nie może dostać toastu „jest w FaktWay” ani alarmów K.
  it('ZF6 strażnik: zgubiona odpowiedź po decyzji no-import — stara karta (mode=import, offer=pair) dostaje toast PR B, nie „jest w FaktWay”, bez alarmów K i bez RPC', async () => {
    const decided = decidedNoImport();
    seed({ invoice: decided.invoice, submissions: decided.submissions, k: null });

    const r = await decide({ choice: 'same_sale', mode: 'import', offer: 'pair' });

    expect(r).toEqual({ success: true, message: T.TOAST_SAME(NR) });
    expect(r.success && r.message).not.toBe(F.TOAST_SAME(NR));
    expect(m.rpc).not.toHaveBeenCalled();
    expect(m.captureMessage).not.toHaveBeenCalled();
  });
});

describe('szkic wycofany po zapisie oryginału — wysyłka i usunięcie z paska akcji (6.4, INV-6)', () => {
  // Dokument X nie ma już numeru (przeszedł na K), więc teksty odmów nazywają DAWNY numer z decyzji
  // (`retiredInternalNumber`), nie „(bez numeru)”. Te same teksty daje wyzwalacz 00149 dla innych ról.
  it.each([
    ['ta sama sprzedaż (pair)', {}, sql('TRIGGER_SAME_IMPORTED', NR, K, NR)],
    ['zapis faktury z KSeF (record)', { offer: 'record' }, sql('TRIGGER_SAME_IMPORTED', NR, K, NR)],
    ['inna sprzedaż (pair)', { choice: 'other_sale' }, sql('TRIGGER_OTHER_IMPORTED', NR, NR, K)],
  ])('ZG1: „Wyślij do KSeF” po decyzji „%s” — odmowa TRIGGER_*_IMPORTED z dawnym numerem i numerem KSeF, bez kolejki', async (_label, patch, message) => {
    const decided = decidedImport(patch);
    seed({ invoice: decided.invoice, submissions: decided.submissions });

    const r = await sendDraftInvoiceAction(X_ID);

    expect(r).toEqual({ success: false, error: message });
  });

  it('ZG2: „Usuń szkic” wycofanego dokumentu po zapisie — odmowa TRIGGER_DELETE_IMPORTED z dawnym numerem i numerem KSeF; szkic zostaje jako ślad decyzji', async () => {
    const decided = decidedImport();
    seed({ invoice: decided.invoice, submissions: decided.submissions });

    const r = await deleteDraftInvoiceAction(X_ID);

    expect(r).toEqual({ success: false, error: sql('TRIGGER_DELETE_IMPORTED', NR, K) });
    expect(m.tables.invoices?.some((row) => row.id === X_ID)).toBe(true);
  });
});

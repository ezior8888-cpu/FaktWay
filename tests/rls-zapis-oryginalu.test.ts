import { createHash } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { parseFa3Xml } from '@/lib/import/fa3-parser';
import { importedInvoiceContent } from '@/lib/import/imported-invoice-row';
import { buildInvoiceAnnotations } from '@/lib/invoices/annotations';
import { buyerPartyFromBuyerData } from '@/lib/invoices/map-buyer-party';
import {
  ORIGINAL_IMPORT_SOURCE,
  type DuplicateOriginalOffer,
  type KsefDuplicateCheck,
  type KsefOriginalImportGate,
} from '@/lib/ksef/duplicate-check';
import {
  DUPLICATE_DECISION_SQL_TEXTS,
  DUPLICATE_DECISION_TEXTS,
  decisionLabel,
  duplicateCheckAllows,
  duplicateDecisionOptions,
  duplicateOriginalOffer,
  fillSqlText,
  originalGateOk,
  retiredDraftSendRefusal,
  retiredDraftView,
  type DuplicateChoice,
  type DuplicateDecisionSqlTextKey,
} from '@/lib/ksef/duplicate-decision';
import { loadDuplicateDecisionFacts } from '@/lib/ksef/duplicate-decision-facts';
import { evaluateOriginalGate } from '@/lib/ksef/duplicate-original-gate';
import {
  ORIGINAL_IMPORT_CLIENT_PROBLEMS,
  buildOriginalImportProjection,
  originalImportProjectionProblem,
  type OriginalImportProblemContext,
} from '@/lib/ksef/duplicate-original-projection';
import { summarizeInvoiceXml } from '@/lib/ksef/duplicate-verdict';
import { generateFA3Xml } from '@/lib/xml/fa3-generator';
import { finalizeInvoice, validateInvoice } from '@/lib/xml/invoice-calculator';
import type { BuyerParty, Invoice, PaymentInfo, VatRate } from '@/types/invoice';

import { getRlsTestDatabaseUrl, getRlsTestEnvironment } from './helpers/rls-environment';
import {
  DUPLICATE_CHECK_CASES,
  faktflowOfferCases,
  originalImportBase,
  originalImportMismatchCases,
} from './unit/helpers/ksef-duplicate-decision-cases';

/**
 * D-A4-1b-3 PR C (00156, dawniej rezerwacja 00149) na prawdziwej bazie — zapis oryginału z oznaczeniem
 * FaktFlow (`faktflow-original`) przy nierozstrzygniętym 440 (spec v3, 7.1;
 * kontrakt `.agents/pr-c-contract.md`, rozstrzygnięcia commitów 2 i 3).
 *
 * R-C1…R-C23 z tabeli 7.1. Wejścia z prawdziwego kodu, importowane statycznie
 * (moduły czyste z commitu 3): plik oryginału = `generateFA3Xml(finalizeInvoice(…))`,
 * `summary` = `summarizeInvoiceXml`, SHA i rozmiar z bajtów, `importGate` =
 * `evaluateOriginalGate`, `p_import` = `buildOriginalImportProjection(parseFa3Xml(…))`.
 * Czerwień przed 00156 wynika wyłącznie z bazy: nowych funkcji nie ma
 * (PGRST202 przez PostgREST, 42883 przez `pg`), a stare (`ksef_duplicate_decision_blocker`,
 * `decide_ksef_duplicate`, `ksef_lifecycle_violations`, `guard_ksef_retired_draft`)
 * mają zachowanie 00148 (kod `reason`, I5 zamiast I5D/I5R, teksty bez importu).
 * R-C22 to strażnik — zielony przed i po (INV-14, plik PR B: `tests/rls-decyzja-duplikatu.test.ts`).
 *
 * Fikstury (F48): własna firma z NIP 9480000050 (poprawna suma kontrolna, ten sam
 * w `tenants.nip`, w sprzedawcy faktury i w pliku), nabywca B2B 9480000067, numery
 * dokumentów `FV/ZO/…` i numery KSeF `9480000050-…-ZO` tylko tego pliku. Druga
 * firma z tym samym NIP (R-C7, R-C18) powstaje i znika w teście, nigdy nie jest
 * oznaczona jako zweryfikowana w KSeF (`idx_tenants_nip_ksef_unique_verified`).
 *
 * Testy z połączeniem Postgres (`RLS_TEST_DATABASE_URL`, pula pg-boss jak
 * w `rls-kolejkowanie-wysylki`) są w zagnieżdżonym `describe.skipIf(!hasDatabaseUrl)`;
 * każdy, który woła RPC albo pisze do tabel z wyzwalaczami, robi `BEGIN;
 * SET LOCAL ROLE service_role` (F51: `postgres` omija gałęzie ról).
 *
 * R-C20 (INV-11): silnik importu bierze klienta serwisowego z `@/lib/supabase/server`
 * — atrapa zwraca klienta serwisowego TEJ bazy testowej (F49; bez `vi.stubEnv`).
 */

const supabaseMock = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: () => supabaseMock.client,
  createClient: async () => supabaseMock.client,
  createClientForOrg: async () => supabaseMock.client,
}));
// `recordXmlDocument` (xml_documents) bierze klienta z `@/lib/supabase/admin` — ta sama baza.
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => supabaseMock.client }));

const hasDatabase = Boolean(
  process.env.RLS_TEST_SUPABASE_URL?.trim() &&
    process.env.RLS_TEST_SUPABASE_ANON_KEY?.trim() &&
    process.env.RLS_TEST_SUPABASE_SERVICE_ROLE_KEY?.trim(),
);
const hasDatabaseUrl = hasDatabase && Boolean(process.env.RLS_TEST_DATABASE_URL?.trim());
const environment = hasDatabase ? getRlsTestEnvironment() : null;
const databaseUrl = hasDatabaseUrl ? getRlsTestDatabaseUrl() : null;
const admin: SupabaseClient = environment
  ? createClient(environment.url, environment.serviceRoleKey)
  : (null as unknown as SupabaseClient);
supabaseMock.client = admin;

const ORG = '14141414-1414-4414-8414-141414141414';
/** Druga firma z tym samym NIP (R-C7) albo „firma B” (R-C18) — powstaje i znika w teście. */
const ORG2 = '14141414-2222-4222-8222-141414141414';
const PASS = 'RlsZapisOryginaluPass2026Aa!';
const EMAIL = {
  owner: 'rls-zapis-oryginalu-owner@ksef-saas.test',
  operator: 'rls-zapis-oryginalu-operator@ksef-saas.test',
} as const;

const SELLER_NIP = '9480000050';
const BUYER_NIP = '9480000067';
/** PESEL z poprawną sumą kontrolną (jak w macierzy rundy C0b). */
const PESEL = '44051401359';
const BANK_ACCOUNT = '61109010140000071219812874';
const ART_43 = 'art. 43 ust. 1 pkt 19 ustawy o VAT';
/** Skrót naszego pliku próby (`request_payload_hash` znacznika) — inny niż oryginału. */
const OUR_HASH = 'aa'.repeat(32);
const SEEDED_ERROR = 'KSeF ma już fakturę o tym numerze z oznaczeniem FaktWay — decyzja na karcie faktury.';
const OPERATOR_NOTE = 'telefon od właściciela 10.10, Jan Kowalski — plik sprawdzony ręcznie';
const ISSUE = '2026-09-01';
const GENERATED_AT = new Date('2026-09-01T08:00:00Z');
const ACQUIRED_AT = '2026-09-01T09:00:00.000Z';
const CHECKED_AT = '2026-09-01T10:05:00.000Z';
const MARKER_AT = '2026-09-01T10:00:00.000Z';
const OLDER_AT = '2026-08-31T10:00:00.000Z';
const SUBMITTED_AT = '2026-09-01T09:55:00.000Z';
const PREPARED_AT = new Date('2026-09-02T08:00:00.000Z');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const SUBMISSION_COLUMNS = 'id, invoice_id, tenant_id, status, submission_type, session_reference_number, invoice_reference_number, request_payload_hash, response_ksef_number, original_ksef_number, original_session_reference_number, original_check, xml_storage_path, attempted_at, completed_at, error_code, error_message';
const INVOICE_COLUMNS = 'direction, internal_number, ksef_status, ksef_number, ksef_send_owner, submitted_to_ksef_at, xml_storage_path, xml_generated_at, last_attempt_at, submission_attempts, last_error, last_error_code, last_error_field, last_error_suggestion, notes, fa3_data, paid_amount, updated_at';
const K_COLUMNS = 'id, tenant_id, direction, origin, internal_number, ksef_status, ksef_environment, ksef_accepted_at, ksef_number, invoice_kind, invoice_type, issue_date, sale_date, seller_nip, buyer_nip, currency, net_total, vat_total, gross_total, payment_due_date, fa3_data, seller_data, buyer_data, payment_data, is_b2c, buyer_id_type, buyer_pesel, buyer_id_number, notes, xml_storage_path, submitted_to_ksef_at, updated_at';
const LINE_COLUMNS = 'ordinal, name, unit, quantity, unit_price_net, net_amount, vat_rate, vat_amount, gross_amount';

type Json = Record<string, unknown>;
type RpcError = { code?: string; message: string; details?: string | null } | null;
type PolicySubmissions = Parameters<typeof retiredDraftSendRefusal>[1];
type ViewSubmissions = Parameters<typeof retiredDraftView>[0]['submissions'];

const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const sha256Hex = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const cents = (value: unknown): number => Math.round(Number(value) * 100);

const ids = { owner: '', operator: '' };
let owner: SupabaseClient;
let ownerNoOrg: SupabaseClient;
let counter = 0;

function nextId(): string {
  counter += 1;
  return `1414aaaa-0000-4000-8000-${String(counter).padStart(12, '0')}`;
}

/** Fikcyjny numer KSeF oryginału w formacie KSeF, z przedrostkiem tego pliku. */
function ksefNumber(n: number): string {
  return `${SELLER_NIP}-20260901-${String(n).padStart(12, '0')}-ZO`;
}

function anonClient(): SupabaseClient {
  return createClient(environment!.url, environment!.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

async function userId(email: string): Promise<string> {
  for (let page = 1; page < 50; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const hit = data.users.find((u) => u.email?.toLowerCase() === email);
    if (hit) return hit.id;
    if (data.users.length < 1000) break;
  }
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASS, email_confirm: true });
  if (error || !data.user) throw error ?? new Error('createUser');
  return data.user.id;
}

/** Sesja klienta; `org` = nagłówek `x-active-org` (`get_current_tenant_id`, 00037), `null` — bez nagłówka. */
async function signedIn(email: string, org: string | null): Promise<SupabaseClient> {
  const c = createClient(environment!.url, environment!.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    ...(org ? { global: { headers: { 'x-active-org': org } } } : {}),
  });
  const { error } = await c.auth.signInWithPassword({ email, password: PASS });
  if (error) throw error;
  return c;
}

/** Tekst odmowy z bazy = szablon 6.3 wypełniony jak w RAISE (lustro TS). */
function sqlText(key: DuplicateDecisionSqlTextKey, ...args: string[]): string {
  return fillSqlText(DUPLICATE_DECISION_SQL_TEXTS[key].template, ...args);
}

/** Etykieta decyzji (karta K, `ALREADY_IMPORTED`, tekst wpisów): `record`/`review-record` → „zapis faktury z KSeF”. */
function choiceLabel(offer: DuplicateOriginalOffer, choice: DuplicateChoice): string {
  return DUPLICATE_DECISION_TEXTS.FAKTFLOW.IMPORTED_CARD_CHOICE[decisionLabel(offer, choice)];
}

/** `error_message` wpisów po zapisie oryginału (4.6 krok 7; marka FaktWay jak teksty 00151). */
function importedEntryMessage(via: 'client' | 'operator', offer: DuplicateOriginalOffer, choice: DuplicateChoice, nr: string, k: string): string {
  return `Decyzja klienta${via === 'operator' ? ' (zapisał operator)' : ''}: ${choiceLabel(offer, choice)} — numer ${nr} ma faktura ${k} z KSeF, zapisana w FaktWay`;
}

/** `error_message` wpisów decyzji bez zapisu (PR B, 00148 — także `no-import`). */
function retiredEntryMessage(via: 'client' | 'operator', choice: DuplicateChoice, nr: string, k: string): string {
  return `Decyzja klienta${via === 'operator' ? ' (zapisał operator)' : ''}: ${choice === 'same_sale' ? 'ta sama sprzedaż' : 'inna sprzedaż'} — numer ${nr} zajęty w KSeF przez fakturę ${k}`;
}

// ─── plik oryginału z generatora FaktFlow ───────────────────────────────

const SELLER = {
  nip: SELLER_NIP,
  name: 'Firma Zapis Oryginału sp. z o.o.',
  email: 'biuro@example.test',
  address: { countryCode: 'PL', addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa' },
};
const ADDRESS_PL = { countryCode: 'PL', addressLine1: 'ul. Kliencka 2', addressLine2: '00-002 Warszawa' };
const ADDRESS_DE = { countryCode: 'DE', addressLine1: 'Teststraße 1', addressLine2: '10115 Berlin' };
const BUYER_B2B: BuyerParty = { nip: BUYER_NIP, name: 'Nabywca Zapis sp. z o.o.', email: 'nabywca@example.test', address: ADDRESS_PL };
const TRANSFER: Omit<PaymentInfo, 'amountDue'> = { currency: 'PLN', dueDate: '2026-09-15', method: 'transfer', bankAccount: BANK_ACCOUNT };
const CASH: Omit<PaymentInfo, 'amountDue'> = { currency: 'PLN', dueDate: ISSUE, method: 'cash' };

function consumerPesel(): BuyerParty {
  return buyerPartyFromBuyerData({ type: 'b2c', idType: 'pesel', name: 'Jan Testowy', pesel: PESEL, address: ADDRESS_PL });
}

interface OriginalFile {
  /** Treść faktury — także `fa3_data` naszego dokumentu X. */
  invoice: Invoice;
  xml: string;
  sha256: string;
  sizeBytes: number;
  summary: Json;
  /** Prawdziwa ocena pliku (`evaluateOriginalGate`) — runner zapisuje ją jako `importGate`. */
  gate: KsefOriginalImportGate;
}

/** Plik z generatora FaktFlow dla dokumentu `number`: dwie pozycje, nabywca NIP albo PESEL, stawka 23 albo zw (P_19A). */
function originalFile(number: string, k: string, opts: { buyer?: 'nip' | 'pesel'; rate?: VatRate } = {}): OriginalFile {
  const rate = opts.rate ?? '23';
  const pesel = opts.buyer === 'pesel';
  const finalized = finalizeInvoice({
    internalNumber: number,
    type: 'VAT',
    issueDate: ISSUE,
    saleDate: ISSUE,
    seller: SELLER,
    buyer: pesel ? consumerPesel() : BUYER_B2B,
    lines: [
      { ordinal: 1, name: 'Usługa wdrożeniowa', unit: 'usł.', quantity: 2, unitPriceNet: 50, vatRate: rate },
      { ordinal: 2, name: 'Szkolenie', unit: 'godz.', quantity: 1, unitPriceNet: 100, vatRate: rate },
    ],
    payment: pesel ? CASH : TRANSFER,
  });
  // Jak formularz faktury: adnotacje z `buildInvoiceAnnotations`, doklejone po sumach.
  const annotations = buildInvoiceAnnotations({
    lines: finalized.lines,
    vatExemptionBasis: rate === 'zw' ? ART_43 : null,
    splitPayment: false,
  });
  const invoice: Invoice = annotations ? { ...finalized, annotations } : finalized;
  const errors = validateInvoice(invoice);
  if (errors.length > 0) throw new Error(`fikstura ${number}: validateInvoice odmówiło: ${JSON.stringify(errors)}`);
  const xml = generateFA3Xml(invoice, { generatedAt: GENERATED_AT });
  const bytes = Buffer.from(xml, 'utf8');
  const { gate } = evaluateOriginalGate({ xml, ksefNumber: k, internalNumber: number, tenantNip: SELLER_NIP });
  // Warunek wstępny fikstury (INV-10 a), nie asercja testu: plik z generatora ma bramę importable.
  if (gate.kind !== 'importable') {
    throw new Error(`fikstura ${number}: brama ${gate.kind} (${gate.problems.join(', ')}) — plik z generatora FaktFlow ma być importable`);
  }
  return { invoice, xml, sha256: sha256Hex(bytes), sizeBytes: bytes.length, summary: { ...summarizeInvoiceXml(xml) }, gate };
}

// ─── wiersze ────────────────────────────────────────────────────────────

async function insertInvoice(row: Json): Promise<void> {
  const { error } = await admin.from('invoices').insert(row);
  if (error) throw new Error(`insert invoices: ${error.message}`);
}

async function updateInvoice(id: string, patch: Json): Promise<void> {
  const { data, error } = await admin.from('invoices').update(patch).eq('id', id).select('id');
  if (error) throw new Error(`update invoices: ${error.message}`);
  if ((data ?? []).length !== 1) throw new Error(`update invoices ${id}: ${(data ?? []).length} wierszy`);
}

async function insertSubmission(row: Json, tenantId: string = ORG): Promise<string> {
  const { data, error } = await admin.from('ksef_submissions')
    .insert({ tenant_id: tenantId, submission_type: 'online', ...row })
    .select('id').single();
  if (error) throw new Error(`insert ksef_submissions: ${error.message}`);
  return data.id as string;
}

async function insertPayment(invoiceId: string): Promise<void> {
  const { error } = await admin.from('payments')
    .insert({ tenant_id: ORG, invoice_id: invoiceId, amount: 100, payment_date: '2026-10-03' });
  if (error) throw new Error(`insert payments: ${error.message}`);
}

interface PendingOpts {
  reason?: 'faktflow-original' | 'no-own-file';
  buyer?: 'nip' | 'pesel';
  rate?: VatRate;
  /**
   * `importGate` znacznika: `importable` — prawdziwa ocena pliku (domyślnie przy
   * `faktflow-original`); `review` — ta sama ocena z problemem `rates` (poprawny
   * kształt 4.4a, plik nadal zapisywalny wg 1.1); `none` — brak klucza (znacznik sprzed 00156).
   */
  gate?: 'importable' | 'review' | 'none';
  /** Nadpisania `original_check` (ownHistory, sameContentExceptHeader, acquiredAt, recheckNeeded…). */
  checkPatch?: Json;
  /** `original_session_reference_number` znacznika; `null` — oryginał bez sesji (R-C14). */
  session?: string | null;
  /** Własna historia w bazie (T3, INV-19): sesja oryginału albo SHA oryginału w próbie X. */
  history?: 'hash' | 'session';
  markerAt?: string;
  /** `attempted_at` starszego otwartego wpisu `sent` (domyślnie 2026-08-31 — też liczy się do I5 po 48 h). */
  olderAt?: string;
}

interface Pending {
  id: string;
  n: number;
  number: string;
  k: string;
  markerId: string;
  olderId: string;
  session: string | null;
  archivePath: string;
  file: OriginalFile;
  /** `original_check.importGate` znacznika; `null` = brak klucza. */
  gate: Json | null;
  /** `original_check` znacznika dokładnie tak, jak jest w bazie. */
  check: Json;
  /** Ten sam zapis w typie aplikacji (wejście `buildOriginalImportProjection`). */
  typed: KsefDuplicateCheck;
  /** Wiersz X (bez stanu wysyłki). */
  x: Json;
  /** Pozycje X (`invoice_line_items`). */
  lines: Json[];
  /** Poprawna projekcja K (5.3) — jak jsonb po drodze przez supabase-js. */
  projection: Json;
}

/**
 * Faktura X czekająca na decyzję: `failed KSEF_DUPLICATE_RECONCILE` z polami
 * wysyłki (submitted_to_ksef_at, plik, 6 prób), pozycje z pliku (wstawione,
 * gdy X był jeszcze szkicem — 00119 mrozi pozycje faktury z `submitted_to_ksef_at`),
 * starszy wpis `sent` bez znacznika i znacznik 440 na wpisie `sent`
 * (SES-OWN-ZO-n, oryginał SES-ORIG-ZO-n, nasz plik `aa`×32) z `original_check`
 * runnera: SystemInfo FaktFlow, archiwum, rozmiar, `summary` pliku, `importGate`.
 */
async function pendingOriginal(opts: PendingOpts = {}): Promise<Pending> {
  const id = nextId();
  const n = counter;
  const number = `FV/ZO/${n}`;
  const k = ksefNumber(n);
  const reason = opts.reason ?? 'faktflow-original';
  const file = originalFile(number, k, { buyer: opts.buyer, rate: opts.rate });
  const archivePath = `${ORG}/ksef-import/${k}.xml`;
  const session = opts.session === undefined ? `SES-ORIG-ZO-${n}` : opts.session;
  const gateMode = opts.gate ?? (reason === 'faktflow-original' ? 'importable' : 'none');
  const realGate = clone(file.gate) as unknown as Json;
  const gate: Json | null = gateMode === 'none'
    ? null
    : gateMode === 'review' ? { ...realGate, kind: 'review', problems: ['rates'] } : realGate;
  const check: Json = {
    v: 1,
    env: 'test',
    checkedAt: CHECKED_AT,
    reason,
    sha256: file.sha256,
    archivePath,
    sizeBytes: file.sizeBytes,
    summary: reason === 'faktflow-original' ? file.summary : { ...file.summary, systemInfo: 'Inny Program 1.0' },
    sameContentExceptHeader: reason === 'faktflow-original' ? false : null,
    ownHistory: false,
    acquiredAt: ACQUIRED_AT,
    httpStatus: null,
    knownInvoice: null,
    recheck: null,
    ...(gate ? { importGate: gate } : {}),
    ...opts.checkPatch,
  };

  const inv = file.invoice;
  const buyer = inv.buyer;
  const x: Json = {
    id,
    tenant_id: ORG,
    direction: 'outgoing',
    internal_number: number,
    invoice_type: 'VAT',
    invoice_kind: 'regular',
    issue_date: ISSUE,
    sale_date: inv.saleDate ?? null,
    payment_due_date: inv.payment.dueDate,
    seller_nip: SELLER_NIP,
    buyer_nip: buyer.nip ?? null,
    is_b2c: !buyer.nip,
    buyer_id_type: buyer.pesel ? 'pesel' : 'nip',
    buyer_pesel: buyer.pesel ?? null,
    net_total: inv.netTotal,
    vat_total: inv.vatTotal,
    gross_total: inv.grossTotal,
    currency: 'PLN',
    ksef_status: 'draft',
    fa3_data: clone(inv),
    seller_data: { nip: SELLER_NIP, name: SELLER.name },
    buyer_data: clone(buyer),
    payment_data: clone(inv.payment),
  };
  await insertInvoice(x);
  const lines = inv.lines.map((l) => ({
    ordinal: l.ordinal, name: l.name, unit: l.unit, quantity: l.quantity, unit_price_net: l.unitPriceNet,
    net_amount: l.netAmount, vat_rate: l.vatRate, vat_amount: l.vatAmount, gross_amount: l.grossAmount,
  }));
  const { error: linesError } = await admin.from('invoice_line_items').insert(lines.map((l) => ({ invoice_id: id, ...l })));
  if (linesError) throw new Error(`insert invoice_line_items: ${linesError.message}`);
  await updateInvoice(id, {
    ksef_status: 'failed', last_error_code: 'KSEF_DUPLICATE_RECONCILE', last_error: SEEDED_ERROR,
    submitted_to_ksef_at: SUBMITTED_AT, last_attempt_at: SUBMITTED_AT, submission_attempts: 6,
    xml_storage_path: `${ORG}/2026/09/${id}.xml`, xml_generated_at: '2026-09-01T09:54:00Z',
  });

  const olderId = await insertSubmission({
    invoice_id: id, status: 'sent', session_reference_number: `SES-OWN-ZO-${n}-0`, invoice_reference_number: `REF-ZO-${n}-0`,
    request_payload_hash: 'cc'.repeat(32), attempted_at: opts.olderAt ?? OLDER_AT,
  });
  if (opts.history) {
    if (opts.history === 'session' && !session) throw new Error('fikstura: historia po sesji wymaga sesji oryginału');
    await insertSubmission({
      invoice_id: id, status: 'abandoned',
      session_reference_number: opts.history === 'session' ? session : `SES-OWN-ZO-${n}-h`,
      // Skrót wielkimi literami — 4.3 porównuje `lower(request_payload_hash)`.
      request_payload_hash: opts.history === 'hash' ? file.sha256.toUpperCase() : 'dd'.repeat(32),
      attempted_at: '2026-08-30T10:00:00Z',
    });
  }
  const markerId = await insertSubmission({
    invoice_id: id, status: 'sent', error_code: '440', session_reference_number: `SES-OWN-ZO-${n}`,
    invoice_reference_number: `REF-ZO-${n}`, request_payload_hash: OUR_HASH, original_ksef_number: k,
    original_session_reference_number: session, original_check: check, attempted_at: opts.markerAt ?? MARKER_AT,
  });

  const typed: KsefDuplicateCheck = {
    v: 1,
    env: 'test',
    checkedAt: CHECKED_AT,
    reason: 'faktflow-original',
    sha256: file.sha256,
    archivePath,
    sizeBytes: file.sizeBytes,
    summary: summarizeInvoiceXml(file.xml),
    sameContentExceptHeader: false,
    ownHistory: false,
    acquiredAt: typeof check.acquiredAt === 'string' ? check.acquiredAt : null,
    httpStatus: null,
    knownInvoice: null,
    recheck: null,
  };
  const parsed = parseFa3Xml(file.xml, { ksefNumber: k });
  const { content, amounts } = importedInvoiceContent(parsed);
  const projection = clone(buildOriginalImportProjection(parsed, content, amounts, {
    tenantId: ORG, env: 'test', check: typed, ksefNumber: k, now: PREPARED_AT,
  })) as unknown as Json;
  // Warunek wstępny fikstury: projekcja przechodzi lustro 4.8 (inaczej czerwień byłaby z fikstury, nie z bazy).
  const mirror = originalImportProjectionProblem(projection, {
    internalNumber: number, tenantNip: SELLER_NIP, tenantId: ORG, ksefNumber: k, check: typed, offer: 'pair',
  });
  if (mirror !== null) throw new Error(`fikstura ${number}: lustro 4.8 odrzuca projekcję (${mirror})`);

  return { id, n, number, k, markerId, olderId, session, archivePath, file, gate, check, typed, x, lines, projection };
}

/** Faktura zwykła innej firmy (ORG2) albo tej firmy — wiersz bez historii wysyłki. */
async function plainInvoice(tenantId: string, number: string, columns: Json = {}): Promise<string> {
  const id = nextId();
  await insertInvoice({
    id, tenant_id: tenantId, direction: 'outgoing', internal_number: number, invoice_type: 'VAT', invoice_kind: 'regular',
    issue_date: '2026-09-15', seller_nip: SELLER_NIP, buyer_nip: BUYER_NIP, gross_total: 123, net_total: 100, vat_total: 23,
    currency: 'PLN', ksef_status: 'draft', fa3_data: { internalNumber: number, type: 'VAT' },
    seller_data: { nip: SELLER_NIP }, buyer_data: { nip: BUYER_NIP, name: 'Nabywca' }, ...columns,
  });
  return id;
}

/** Przyjęta faktura sprzedaży z numerem KSeF `k` (Y w tej firmie — R-C8; w innej firmie — R-C7 a). */
async function acceptedInvoice(tenantId: string, number: string, k: string): Promise<string> {
  return plainInvoice(tenantId, number, {
    ksef_status: 'accepted', ksef_environment: 'test', ksef_number: k, ksef_accepted_at: '2026-09-15T09:00:00Z',
    xml_storage_path: `${tenantId}/ksef-import/${k}.xml`,
  });
}

async function invoiceRow(id: string): Promise<Json | null> {
  const { data, error } = await admin.from('invoices').select(INVOICE_COLUMNS).eq('id', id).maybeSingle();
  if (error) throw error;
  return data as Json | null;
}

async function submissionsOf(invoiceId: string): Promise<Json[]> {
  const { data, error } = await admin.from('ksef_submissions')
    .select(SUBMISSION_COLUMNS).eq('invoice_id', invoiceId).order('attempted_at');
  if (error) throw error;
  return (data ?? []) as Json[];
}

async function markerOf(p: Pending): Promise<Json> {
  const marker = (await submissionsOf(p.id)).find((s) => s.id === p.markerId);
  if (!marker) throw new Error(`brak znacznika ${p.markerId}`);
  return marker;
}

/** Wszystkie faktury firmy z numerem KSeF `k` (INV-1: po zapisie dokładnie jedna). */
async function kInvoices(k: string, tenantId: string = ORG): Promise<Json[]> {
  const { data, error } = await admin.from('invoices').select(K_COLUMNS).eq('tenant_id', tenantId).eq('ksef_number', k);
  if (error) throw error;
  return (data ?? []) as Json[];
}

async function linesOf(invoiceId: string): Promise<Json[]> {
  const { data, error } = await admin.from('invoice_line_items').select(LINE_COLUMNS).eq('invoice_id', invoiceId).order('ordinal');
  if (error) throw error;
  return (data ?? []) as Json[];
}

async function xmlDocumentsOf(invoiceId: string): Promise<Json[]> {
  const { data, error } = await admin.from('xml_documents')
    .select('tenant_id, storage_provider, storage_path, sha256_hash, file_size_bytes').eq('invoice_id', invoiceId);
  if (error) throw error;
  return (data ?? []) as Json[];
}

async function upoOf(invoiceId: string): Promise<Json[]> {
  const { data, error } = await admin.from('upo_receipts')
    .select('tenant_id, ksef_number, ksef_acceptance_timestamp, status, last_error, ksef_environment').eq('invoice_id', invoiceId);
  if (error) throw error;
  return (data ?? []) as Json[];
}

async function auditRows(entityId: string, action: string): Promise<Array<{ user_id: string | null; details_json: Json }>> {
  const { data, error } = await admin.from('audit_logs')
    .select('user_id, details_json').eq('tenant_id', ORG).eq('entity_id', entityId).eq('action', action);
  if (error) throw error;
  return (data ?? []) as Array<{ user_id: string | null; details_json: Json }>;
}

async function tenantCount(table: 'xml_documents' | 'upo_receipts' | 'audit_logs' | 'invoices'): Promise<number> {
  const { count, error } = await admin.from(table).select('id', { count: 'exact', head: true }).eq('tenant_id', ORG);
  if (error) throw error;
  return count ?? 0;
}

/**
 * Stan, który odmowa (INV-4) ma zostawić bez zmian: wiersz X, jego wpisy i audyt,
 * brak K (faktury z numerem KSeF oryginału) oraz liczniki tabel, do których
 * pisze zapis oryginału (xml_documents, upo_receipts, audit_logs, invoices).
 */
async function state(p: Pending) {
  const { data: audit, error } = await admin.from('audit_logs').select('action').eq('tenant_id', ORG).eq('entity_id', p.id);
  if (error) throw error;
  const submissions = await submissionsOf(p.id);
  return {
    invoice: await invoiceRow(p.id),
    lines: await linesOf(p.id),
    submissions: [...submissions].sort((a, b) => String(a.id).localeCompare(String(b.id))),
    audit: (audit ?? []).map((a) => a.action as string).sort(),
    k: await kInvoices(p.k),
    xmlDocuments: await tenantCount('xml_documents'),
    upo: await tenantCount('upo_receipts'),
    tenantAudit: await tenantCount('audit_logs'),
    invoices: await tenantCount('invoices'),
  };
}

/** INV-4: X dalej czeka (failed z numerem i polami wysyłki), wpisy otwarte, bez K i bez audytu. */
async function expectUntouched(p: Pending, before: Awaited<ReturnType<typeof state>>): Promise<void> {
  const after = await state(p);
  expect(after).toEqual(before);
  expect(after.invoice).toMatchObject({ ksef_status: 'failed', last_error_code: 'KSEF_DUPLICATE_RECONCILE', internal_number: p.number });
  expect(after.invoice?.submitted_to_ksef_at).not.toBeNull();
  expect(after.k).toEqual([]);
  const marker = after.submissions.find((s) => s.id === p.markerId);
  expect(marker?.status).toBe('sent');
  const markerCheck = marker?.original_check;
  expect(isRecord(markerCheck) ? markerCheck : {}).not.toHaveProperty('decision');
}

interface OriginalArgs {
  p_invoice_id: string;
  p_tenant_id: string;
  p_actor_user_id: string | null;
  p_choice: string;
  p_via: string;
  p_original_ksef_number: string;
  p_original_sha256: string;
  p_env: string;
  p_note: string | null;
  p_mode: string | null;
  p_offer: string | null;
  p_import: unknown;
}

/** Argumenty `decide_ksef_duplicate_original` (4.6, 12 nazwanych, bez wartości domyślnych); domyślnie: klient, oferta `pair`, `same_sale`. */
function originalArgs(p: Pending, over: Partial<OriginalArgs> = {}): OriginalArgs {
  return {
    p_invoice_id: p.id,
    p_tenant_id: ORG,
    p_actor_user_id: ids.owner,
    p_choice: 'same_sale',
    p_via: 'client',
    p_original_ksef_number: p.k,
    p_original_sha256: p.file.sha256,
    p_env: 'test',
    p_note: null,
    p_mode: 'import',
    p_offer: 'pair',
    ...over,
    p_import: 'p_import' in over ? over.p_import : clone(p.projection),
  };
}

/** Operator z notatką (T8, INV-22). */
const asOperator = (over: Partial<OriginalArgs> = {}): Partial<OriginalArgs> => ({
  p_via: 'operator', p_actor_user_id: ids.operator, p_note: OPERATOR_NOTE, ...over,
});

function decideOriginal(p: Pending, over: Partial<OriginalArgs> = {}, client: SupabaseClient = admin) {
  return client.rpc('decide_ksef_duplicate_original', originalArgs(p, over));
}

/** `decide_ksef_duplicate` — 9 argumentów z 00148 (tryb `retire` core). */
function decideRetire(p: Pending, over: Json = {}) {
  return admin.rpc('decide_ksef_duplicate', {
    p_invoice_id: p.id, p_tenant_id: ORG, p_actor_user_id: ids.owner, p_choice: 'other_sale', p_via: 'client',
    p_original_ksef_number: p.k, p_original_sha256: p.file.sha256, p_env: 'test', p_note: null, ...over,
  });
}

function releaseReview(p: Pending, over: Json = {}) {
  return admin.rpc('release_ksef_original_review', {
    p_invoice_id: p.id, p_tenant_id: ORG, p_actor_user_id: ids.operator, p_original_ksef_number: p.k,
    p_original_sha256: p.file.sha256, p_env: 'test', p_note: OPERATOR_NOTE, ...over,
  });
}

function flagRecheck(p: Pending, kind: string, over: Json = {}) {
  return admin.rpc('flag_ksef_original_recheck', {
    p_invoice_id: p.id, p_tenant_id: ORG, p_actor_user_id: ids.owner, p_original_ksef_number: p.k,
    p_original_sha256: p.file.sha256, p_kind: kind, ...over,
  });
}

async function blocker(invoiceId: string, tenantId: string = ORG): Promise<string | null> {
  const { data, error } = await admin.rpc('ksef_duplicate_decision_blocker', { p_invoice_id: invoiceId, p_tenant_id: tenantId });
  expect(error, `ksef_duplicate_decision_blocker: ${error?.message}`).toBeNull();
  return (data ?? null) as string | null;
}

async function violationsOf(invoiceId: string): Promise<Array<{ invariant: string; detail: Json }>> {
  const { data, error } = await admin.rpc('ksef_lifecycle_violations');
  expect(error, `ksef_lifecycle_violations: ${error?.message}`).toBeNull();
  return ((data ?? []) as Array<{ invariant: string; invoice_id: string; detail: Json }>)
    .filter((v) => v.invoice_id === invoiceId)
    .map((v) => ({ invariant: v.invariant, detail: v.detail }));
}

async function invariantsOf(invoiceId: string): Promise<string[]> {
  return (await violationsOf(invoiceId)).map((v) => v.invariant);
}

/**
 * Werdykt polityki TS na faktach z ładowarki (klient serwisu, blokada SQL odczytana
 * kluczem serwisowym — `sqlBlocker: 'admin'`, 5.4): odmowa albo rodzaj widoku.
 */
async function tsVerdict(invoiceId: string, actor: 'client' | 'operator'): Promise<string> {
  const facts = await loadDuplicateDecisionFacts(admin, ORG, invoiceId, undefined, { sqlBlocker: 'admin' });
  const view = duplicateDecisionOptions({ facts, actor, canManage: true, environment: 'test', now: new Date() });
  return view.kind === 'refused' ? view.refusal : view.kind;
}

/** Wiersze z bazy w typie parametru polityki TS (sprawdzenie zgodności TS ↔ SQL). */
async function policySubmissions(invoiceId: string): Promise<PolicySubmissions> {
  return (await submissionsOf(invoiceId)) as unknown as PolicySubmissions;
}

const lineOf = (l: Json) => ({
  ordinal: Number(l.ordinal),
  name: l.name,
  unit: l.unit,
  quantity: Number(l.quantity),
  unit_price_net: l.unit_price_net === null ? null : Number(l.unit_price_net),
  net_amount: Number(l.net_amount),
  vat_rate: l.vat_rate,
  vat_amount: Number(l.vat_amount),
  gross_amount: Number(l.gross_amount),
});

const retiredLineOf = (l: Json) => ({
  ordinal: Number(l.ordinal),
  name: l.name,
  unit: l.unit,
  quantity: Number(l.quantity),
  unitPriceNet: l.unitPriceNet === null ? null : Number(l.unitPriceNet),
  netAmount: Number(l.netAmount),
  vatRate: l.vatRate,
  vatAmount: Number(l.vatAmount),
  grossAmount: Number(l.grossAmount),
});

const sameInstant = (a: unknown, b: unknown): void => {
  expect(typeof a, `czas ${String(a)}`).toBe('string');
  expect(Date.parse(String(a)), `${String(a)} = ${String(b)}`).toBe(Date.parse(String(b)));
};

interface ImportExpectation {
  choice: DuplicateChoice;
  offer: DuplicateOriginalOffer;
  via: 'client' | 'operator';
  actorUserId: string;
  note: string | null;
}

/**
 * INV-1, INV-2, INV-3, INV-18, INV-20 po zapisie oryginału z sesją i datą nadania:
 * jedna faktura K (kolumny i pozycje z projekcji, plik, sesja, UPO `pending`),
 * X wycofany bez numeru z decyzją i kopią treści na znaczniku, trzy audyty,
 * bez I3/I3K dla K. Zwraca wiersz K.
 */
async function expectImported(p: Pending, result: unknown, e: ImportExpectation): Promise<Json> {
  // (f) wynik — 00148 + klucze trybu import.
  expect(result).toMatchObject({
    invoice_id: p.id, internal_number: p.number, original_ksef_number: p.k, choice: e.choice, via: e.via,
    reason: 'faktflow-original', already_decided: false, submissions_closed: 2,
    mode: 'import', offer: e.offer, retired_internal_number: p.number, acquired_at_missing: false, session_missing: false,
  });
  const importedId = (result as Json).imported_invoice_id;
  expect(typeof importedId === 'string' && UUID.test(importedId), `imported_invoice_id ${String(importedId)}`).toBe(true);

  // INV-1: dokładnie jedna faktura sprzedaży z K, zapisana z KSeF; numer przeszedł z X.
  const kRows = await kInvoices(p.k);
  expect(kRows).toHaveLength(1);
  const k = kRows[0]!;
  expect(k).toMatchObject({
    id: importedId, tenant_id: ORG, direction: 'outgoing', origin: 'ksef_import', ksef_status: 'accepted',
    ksef_environment: 'test', internal_number: p.number, ksef_number: p.k, invoice_kind: 'regular',
    invoice_type: 'VAT', currency: 'PLN', xml_storage_path: p.archivePath, submitted_to_ksef_at: null,
  });
  sameInstant(k.ksef_accepted_at, ACQUIRED_AT); // INV-16
  const invoice = p.projection.invoice as Json;
  for (const key of ['issue_date', 'sale_date', 'seller_nip', 'buyer_nip', 'payment_due_date', 'seller_data', 'buyer_data',
    'payment_data', 'is_b2c', 'buyer_id_type', 'buyer_pesel', 'buyer_id_number', 'notes']) {
    expect(k[key], `K.${key} = projekcja`).toEqual(invoice[key]);
  }
  for (const key of ['net_total', 'vat_total', 'gross_total']) expect(Number(k[key]), `K.${key}`).toBe(Number(invoice[key]));
  const fa3 = k.fa3_data as Json;
  expect(fa3).not.toHaveProperty('lines');
  const { decision: kDecision, ...importRest } = fa3.import as Json;
  expect({ ...fa3, import: importRest }).toEqual(invoice.fa3_data);
  expect(importRest).toMatchObject({ source: ORIGINAL_IMPORT_SOURCE, originalSha256: p.file.sha256 });
  expect(kDecision).toMatchObject({
    choice: e.choice, via: e.via, offer: e.offer, actorUserId: e.actorUserId, note: e.note,
    retiredInvoiceId: p.id, retiredInternalNumber: p.number, markerSubmissionId: p.markerId,
  });
  expect(Number.isNaN(Date.parse(String((kDecision as Json).at)))).toBe(false);

  // INV-2: pozycje = projekcja, sumy = nagłówek co do grosza, jeden wiersz xml_documents z plikiem oryginału.
  const kLines = await linesOf(k.id as string);
  expect(kLines.length).toBeGreaterThan(0);
  expect(kLines.map(lineOf)).toEqual((p.projection.lines as Json[]).map(lineOf));
  for (const [line, total] of [['net_amount', 'net_total'], ['vat_amount', 'vat_total'], ['gross_amount', 'gross_total']] as const) {
    expect(kLines.reduce((sum, l) => sum + cents(l[line]), 0), `Σ ${line}`).toBe(cents(k[total]));
  }
  expect(await xmlDocumentsOf(k.id as string)).toEqual([{
    tenant_id: ORG, storage_provider: 'r2', storage_path: p.archivePath, sha256_hash: p.file.sha256, file_size_bytes: p.file.sizeBytes,
  }]);

  // INV-3: X wycofany bez numeru i bez pól wysyłki, fa3_data bez zmian, wpisy number_taken z decyzją.
  const x = await invoiceRow(p.id);
  expect(x).toMatchObject({
    direction: 'outgoing', ksef_status: 'draft', internal_number: null, ksef_number: null, ksef_send_owner: null,
    submitted_to_ksef_at: null, xml_storage_path: null, xml_generated_at: null, last_attempt_at: null, submission_attempts: 0,
    last_error: null, last_error_code: null, last_error_field: null, last_error_suggestion: null,
  });
  expect(x?.fa3_data).toEqual(p.x.fa3_data);
  const rows = await submissionsOf(p.id);
  const closed = rows.filter((r) => r.status === 'number_taken');
  expect(closed.map((r) => r.id).sort()).toEqual([p.markerId, p.olderId].sort());
  for (const r of closed) {
    expect(r).toMatchObject({ error_code: 'NUMBER_TAKEN', error_message: importedEntryMessage(e.via, e.offer, e.choice, p.number, p.k) });
    expect(r.completed_at).not.toBeNull();
  }
  expect(rows.find((r) => r.id === p.olderId)?.original_check).toBeNull();
  const marker = rows.find((r) => r.id === p.markerId)!;
  const { decision, ...rest } = marker.original_check as Json & { decision: Json };
  expect(rest).toEqual(p.check);
  const gate = p.gate as Json;
  expect(decision).toMatchObject({
    choice: e.choice, via: e.via, reason: 'faktflow-original', env: 'test', mode: 'import', offer: e.offer,
    actorUserId: e.actorUserId, note: e.note, importedInvoiceId: importedId, retiredInternalNumber: p.number,
    original: {
      sha256: p.file.sha256, archivePath: p.archivePath, sizeBytes: p.file.sizeBytes, session: p.session,
      gateRules: gate.rules, gateProblems: gate.problems, buyerIdKind: (gate.preview as Json).buyerIdKind,
    },
    retired: {
      internalNumber: p.number, issueDate: ISSUE, saleDate: p.x.sale_date, buyerNip: p.x.buyer_nip,
      buyerName: (p.x.buyer_data as Json).name, currency: 'PLN', lineCount: p.lines.length,
    },
  });
  expect(decision).not.toHaveProperty('release');
  expect(Number.isNaN(Date.parse(String(decision.at))), `decision.at ${String(decision.at)}`).toBe(false);
  sameInstant((decision.original as Json).acquiredAt, ACQUIRED_AT);
  const retired = decision.retired as Json;
  for (const [key, column] of [['netTotal', 'net_total'], ['vatTotal', 'vat_total'], ['grossTotal', 'gross_total']] as const) {
    expect(Number(retired[key]), `retired.${key}`).toBe(Number(p.x[column]));
  }
  expect((retired.lines as Json[]).map(retiredLineOf)).toEqual(p.lines.map((l) => retiredLineOf({
    ordinal: l.ordinal, name: l.name, unit: l.unit, quantity: l.quantity, unitPriceNet: l.unit_price_net,
    netAmount: l.net_amount, vatRate: l.vat_rate, vatAmount: l.vat_amount, grossAmount: l.gross_amount,
  })));

  // INV-18: sesja oryginału na K (kształt recordKsefAcceptedSession) i UPO pending w środowisku decyzji.
  const kSubmissions = await submissionsOf(k.id as string);
  expect(kSubmissions).toHaveLength(1);
  expect(kSubmissions[0]).toMatchObject({
    tenant_id: ORG, submission_type: 'online', status: 'accepted', session_reference_number: p.session,
    invoice_reference_number: null, response_ksef_number: p.k, request_payload_hash: p.file.sha256, xml_storage_path: p.archivePath,
  });
  expect(kSubmissions[0]!.attempted_at).not.toBeNull();
  expect(kSubmissions[0]!.completed_at).not.toBeNull();
  const upo = await upoOf(k.id as string);
  expect(upo).toHaveLength(1);
  expect(upo[0]).toMatchObject({ tenant_id: ORG, ksef_number: p.k, status: 'pending', last_error: null, ksef_environment: 'test' });
  sameInstant(upo[0]!.ksef_acceptance_timestamp, ACQUIRED_AT);

  // Audyty: decyzja (z trybem i importem), reset X, zapis K.
  const decided = await auditRows(p.id, 'invoice.ksef_duplicate_decided');
  expect(decided).toHaveLength(1);
  expect(decided[0]!.user_id).toBe(e.actorUserId);
  expect(decided[0]!.details_json).toMatchObject({
    choice: e.choice, via: e.via, note: e.note, env: 'test', reason: 'faktflow-original', marker_submission_id: p.markerId,
    mode: 'import', offer: e.offer,
    import: { imported_invoice_id: importedId, acquired_at_missing: false, session_missing: false, gate_problems: gate.problems },
  });
  const resets = await auditRows(p.id, 'invoice.send_reset');
  expect(resets.filter((r) => r.details_json?.via === 'ksef_duplicate_decision')).toHaveLength(1);
  const imported = await auditRows(k.id as string, 'invoice.ksef_original_imported');
  expect(imported).toHaveLength(1);
  expect(imported[0]!.user_id).toBe(e.actorUserId);
  expect(imported[0]!.details_json).toMatchObject({
    retired_invoice_id: p.id, retired_internal_number: p.number, choice: e.choice, offer: e.offer, via: e.via,
    original_ksef_number: p.k, session: p.session, sha256: p.file.sha256, archive_path: p.archivePath, upo_status: 'pending',
  });
  sameInstant(imported[0]!.details_json.acquired_at, ACQUIRED_AT);

  // K zawsze ma wiersz UPO (bez I3), a przy sesji i dacie nie jest w I3K.
  const kInvariants = await invariantsOf(k.id as string);
  expect(kInvariants).not.toContain('I3');
  expect(kInvariants).not.toContain('I3K');
  return k;
}

/** Pierwsza decyzja z zapisem K (oferta `pair`, klient) — fundament R-C9, R-C12, R-C13, R-C20. */
async function importedPair(choice: DuplicateChoice = 'same_sale'): Promise<{ p: Pending; k: Json }> {
  const p = await pendingOriginal();
  const { data, error } = await decideOriginal(p, { p_choice: choice });
  expect(error, error?.message).toBeNull();
  const k = await expectImported(p, data, { choice, offer: 'pair', via: 'client', actorUserId: ids.owner, note: null });
  return { p, k };
}

// ─── druga firma z tym samym NIP (R-C7, R-C18) ───────────────────────────

async function cleanupTenant(tenantId: string): Promise<void> {
  await admin.from('ksef_submissions').delete().eq('tenant_id', tenantId);
  await admin.from('payments').delete().eq('tenant_id', tenantId);
  // Statusy do szkicu bez pól wysyłki (00119/00122/00132 pozwalają wtedy na DELETE);
  // przyjęte faktury (K, Y) serwis usuwa wprost — 00117 nie pozwala zmienić ich statusu.
  await admin.from('invoices').update({
    ksef_status: 'draft', ksef_send_owner: null, submitted_to_ksef_at: null, last_attempt_at: null,
    ksef_number: null, ksef_accepted_at: null, xml_storage_path: null,
    offline_idempotency_key: null, offline_qr_offline: null, offline_qr_certyfikat: null,
  }).eq('tenant_id', tenantId).neq('ksef_status', 'accepted');
  await admin.from('invoices').delete().eq('tenant_id', tenantId);
  await admin.from('audit_logs').delete().eq('tenant_id', tenantId);
  await admin.from('contractors').delete().eq('tenant_id', tenantId);
  await admin.from('products').delete().eq('tenant_id', tenantId);
}

/** Druga firma z NIP tej firmy, NIEzweryfikowana w KSeF; po teście znika razem z danymi. */
async function withSecondTenant(fn: () => Promise<void>): Promise<void> {
  await cleanupTenant(ORG2);
  await admin.from('tenants').delete().eq('id', ORG2);
  const { error } = await admin.from('tenants').insert({ id: ORG2, nip: SELLER_NIP, name: 'Druga firma z tym samym NIP' });
  if (error) throw error;
  try {
    await fn();
  } finally {
    await cleanupTenant(ORG2);
    await admin.from('tenants').delete().eq('id', ORG2);
  }
}

async function cleanup(): Promise<void> {
  await cleanupTenant(ORG);
}

// ─── macierz rundy (R-C1c; kopia budowniczych z zapis-oryginalu-projekcja.test.ts) ───

interface LineSpec {
  name?: string;
  unit?: string;
  qty: number;
  price: number;
  rate: VatRate;
}

interface MatrixCase {
  name: string;
  lines: LineSpec[];
  buyer: BuyerParty;
  /** Data sprzedaży (P_6): brak pola = `M_ISSUE`, `null` = faktura bez P_6. */
  saleDate?: string | null;
  notes?: string;
  payment?: Omit<PaymentInfo, 'amountDue'>;
  exemptionBasis?: string | null;
  splitPayment?: boolean;
  cashMethod?: boolean;
}

const M_ISSUE = '2026-09-10';
const M_GENERATED_AT = new Date('2026-09-10T08:00:00Z');
const ART_113 = 'art. 113 ust. 1 ustawy o VAT';
const ELEVEN_DIGITS_BAD_CHECKSUM = '12345678901';
const M_TRANSFER: Omit<PaymentInfo, 'amountDue'> = { currency: 'PLN', dueDate: '2026-09-24', method: 'transfer', bankAccount: BANK_ACCOUNT };
const BUYER_EU: BuyerParty = { vatUeNumber: 'DE123456789', name: 'Kunde GmbH', address: ADDRESS_DE };

const single = (rate: VatRate, price = 50, qty = 2): LineSpec[] => [{ name: 'Usługa wdrożeniowa', unit: 'usł.', qty, price, rate }];

const consumer = (
  idType: 'pesel' | 'id_card' | 'passport' | 'no_id',
  fields: { name: string; pesel?: string; idNumber?: string; address: typeof ADDRESS_PL },
): BuyerParty => buyerPartyFromBuyerData({ type: 'b2c', idType, ...fields });

/** Macierz rundy (spec 7.2): każdy plik z generatora FaktFlow dla faktury zwykłej, którą przyjmuje `validateInvoice`. */
function roundMatrix(): MatrixCase[] {
  return [
    { name: 'stawka 23', lines: single('23'), buyer: BUYER_B2B },
    { name: 'stawka 8', lines: single('8'), buyer: BUYER_B2B },
    { name: 'stawka 5', lines: single('5'), buyer: BUYER_B2B },
    { name: 'stawka 0 (0 KR)', lines: single('0'), buyer: BUYER_B2B },
    { name: 'stawka zw z podstawą (art. 113)', lines: single('zw'), buyer: BUYER_B2B, exemptionBasis: ART_113 },
    { name: 'stawka oo (P_18=1)', lines: single('oo'), buyer: BUYER_B2B },
    { name: 'stawka np', lines: single('np'), buyer: BUYER_B2B },
    { name: 'mieszane 23 + zw', lines: [...single('23', 100, 1), ...single('zw', 200, 1)], buyer: BUYER_B2B, exemptionBasis: ART_113 },
    {
      name: 'mieszane 8 + 5 + 0',
      lines: [
        { name: 'Książka', unit: 'szt.', qty: 3, price: 33.33, rate: '8' },
        { name: 'Woda', unit: 'szt.', qty: 1, price: 100, rate: '5' },
        { name: 'Eksport próbki', unit: 'szt.', qty: 1, price: 100, rate: '0' },
      ],
      buyer: BUYER_B2B,
    },
    { name: 'mieszane 23 + oo', lines: [...single('23', 100, 1), ...single('oo', 100, 1)], buyer: BUYER_B2B },
    { name: 'np_ii z nabywcą VAT-UE', lines: single('np_ii', 500, 1), buyer: BUYER_EU },
    { name: 'np + np_ii z nabywcą VAT-UE', lines: [...single('np', 100, 1), ...single('np_ii', 500, 1)], buyer: BUYER_EU },
    { name: 'nabywca NIP', lines: single('23'), buyer: BUYER_B2B },
    {
      name: 'nabywca PESEL z adresem w Polsce',
      lines: single('23'),
      buyer: consumer('pesel', { name: 'Jan Testowy', pesel: PESEL, address: ADDRESS_PL }),
      payment: { currency: 'PLN', dueDate: M_ISSUE, method: 'cash' },
    },
    {
      name: 'nabywca PESEL z adresem zagranicznym → nrInny',
      lines: single('23'),
      buyer: consumer('pesel', { name: 'Jan Testowy', pesel: PESEL, address: ADDRESS_DE }),
    },
    { name: 'nabywca NrInny: dowód osobisty (id_card)', lines: single('23'), buyer: consumer('id_card', { name: 'Anna Testowa', idNumber: 'ABC123456', address: ADDRESS_PL }) },
    { name: 'nabywca NrInny: paszport (passport)', lines: single('23'), buyer: consumer('passport', { name: 'John Test', idNumber: 'C01X00T47', address: ADDRESS_DE }) },
    { name: 'nabywca NrInny 11 cyfr z sumą PESEL i adresem PL → pesel', lines: single('23'), buyer: consumer('passport', { name: 'Jan Paszportowy', idNumber: PESEL, address: ADDRESS_PL }) },
    { name: 'nabywca NrInny 11 cyfr bez sumy PESEL (adres PL) → nrInny', lines: single('23'), buyer: consumer('id_card', { name: 'Jan Dowodowy', idNumber: ELEVEN_DIGITS_BAD_CHECKSUM, address: ADDRESS_PL }) },
    { name: 'nabywca VAT-UE z innego kraju UE', lines: single('23'), buyer: BUYER_EU },
    { name: 'nabywca VAT-UE z prefiksem PL', lines: single('23'), buyer: { vatUeNumber: `PL${BUYER_NIP}`, name: 'Spółka z numerem VAT-UE PL', address: ADDRESS_PL } },
    { name: 'nabywca BrakID', lines: single('23'), buyer: consumer('no_id', { name: 'Konsument', address: ADDRESS_PL }) },
    { name: 'JST=1', lines: single('23'), buyer: { ...BUYER_B2B, jst: 1 } },
    { name: 'GV=1', lines: single('23'), buyer: { ...BUYER_B2B, gv: 1 } },
    { name: 'JST=1 i GV=1', lines: single('23'), buyer: { ...BUYER_B2B, jst: 1, gv: 1 } },
    { name: 'MPP (P_18A=1)', lines: single('23', 15000, 1), buyer: BUYER_B2B, splitPayment: true },
    { name: 'metoda kasowa (P_16=1)', lines: single('23'), buyer: BUYER_B2B, cashMethod: true },
    { name: 'zw z P_19A (art. 43)', lines: single('zw'), buyer: BUYER_B2B, exemptionBasis: ART_43 },
    { name: 'zw z metodą kasową (P_16=1 + P_19A)', lines: single('zw'), buyer: BUYER_B2B, exemptionBasis: ART_43, cashMethod: true },
    { name: 'P_6 różne od P_1', lines: single('23'), buyer: BUYER_B2B, saleDate: '2026-09-05' },
    { name: 'bez P_6', lines: single('23'), buyer: BUYER_B2B, saleDate: null },
    { name: 'P_16 z P_6', lines: single('23'), buyer: BUYER_B2B, saleDate: '2026-09-05', cashMethod: true },
    { name: 'z uwagami (Stopka)', lines: single('23'), buyer: BUYER_B2B, notes: 'Dziękujemy za zakup. Zamówienie nr 42 & "pilne" <3' },
    { name: 'z uwagami z odstępami na brzegach (przycięcie)', lines: single('23'), buyer: BUYER_B2B, notes: '  Termin realizacji: 14 dni.  ' },
    { name: 'bez uwag', lines: single('23'), buyer: BUYER_B2B },
    { name: 'płatność: przelew z rachunkiem i nazwą banku', lines: single('23'), buyer: BUYER_B2B, payment: { ...M_TRANSFER, bankName: 'Santander Bank Polska' } },
    { name: 'płatność: gotówka', lines: single('23'), buyer: BUYER_B2B, payment: { currency: 'PLN', dueDate: M_ISSUE, method: 'cash' } },
    { name: 'płatność: karta', lines: single('23'), buyer: BUYER_B2B, payment: { currency: 'PLN', dueDate: M_ISSUE, method: 'card' } },
    { name: 'płatność: inna', lines: single('23'), buyer: BUYER_B2B, payment: { currency: 'PLN', dueDate: M_ISSUE, method: 'other' } },
    { name: 'ilość i cena z 4 miejscami po przecinku', lines: [{ name: 'Materiał na metry', unit: 'm', qty: 1.2345, price: 12.3456, rate: '23' }], buyer: BUYER_B2B },
    {
      name: 'pozycja z ceną 0',
      lines: [
        { name: 'Usługa wdrożeniowa', unit: 'usł.', qty: 1, price: 100, rate: '23' },
        { name: 'Gratis do zamówienia', unit: 'szt.', qty: 1, price: 0, rate: '23' },
      ],
      buyer: BUYER_B2B,
    },
    {
      name: '40 pozycji po 0,02 zł przy 23% (zaokrąglenia)',
      lines: Array.from({ length: 40 }, (_, i) => ({ name: `Drobiazg ${i + 1}`, unit: 'szt.', qty: 1, price: 0.02, rate: '23' as const })),
      buyer: BUYER_B2B,
    },
  ];
}

interface MatrixInput {
  name: string;
  projection: Json;
  ctx: OriginalImportProblemContext;
}

/** Plik z macierzy → `parseFa3Xml` → projekcja i kontekst 4.8 (numer X = P_2, NIP firmy = sprzedawca, znacznik pliku). */
function matrixInput(c: MatrixCase, index: number): MatrixInput {
  const number = `FV/ZO/GR/${String(index).padStart(2, '0')}`;
  const k = `${SELLER_NIP}-20260910-GR${String(index).padStart(10, '0')}-ZO`;
  const finalized = finalizeInvoice({
    internalNumber: number,
    type: 'VAT',
    issueDate: M_ISSUE,
    saleDate: c.saleDate === null ? undefined : (c.saleDate ?? M_ISSUE),
    seller: SELLER,
    buyer: c.buyer,
    lines: c.lines.map((l, i) => ({
      ordinal: i + 1, name: l.name ?? `Pozycja ${i + 1}`, unit: l.unit ?? 'szt.', quantity: l.qty, unitPriceNet: l.price, vatRate: l.rate,
    })),
    payment: c.payment ?? M_TRANSFER,
    notes: c.notes,
  });
  const annotations = buildInvoiceAnnotations({
    lines: finalized.lines,
    vatExemptionBasis: c.exemptionBasis ?? null,
    splitPayment: c.splitPayment === true,
    cashMethod: c.cashMethod,
  });
  const invoice: Invoice = annotations ? { ...finalized, annotations } : finalized;
  const errors = validateInvoice(invoice);
  if (errors.length > 0) throw new Error(`${c.name}: validateInvoice odmówiło: ${JSON.stringify(errors)}`);
  const xml = generateFA3Xml(invoice, { generatedAt: M_GENERATED_AT });
  const bytes = Buffer.from(xml, 'utf8');
  const check: KsefDuplicateCheck = {
    v: 1, env: 'test', checkedAt: CHECKED_AT, reason: 'faktflow-original', sha256: sha256Hex(bytes),
    archivePath: `${ORG}/ksef-import/${k}.xml`, sizeBytes: bytes.length, summary: summarizeInvoiceXml(xml),
    sameContentExceptHeader: false, ownHistory: false, acquiredAt: ACQUIRED_AT, httpStatus: null, knownInvoice: null, recheck: null,
  };
  const parsed = parseFa3Xml(xml, { ksefNumber: k });
  const { content, amounts } = importedInvoiceContent(parsed);
  const projection = clone(buildOriginalImportProjection(parsed, content, amounts, {
    tenantId: ORG, env: 'test', check, ksefNumber: k, now: PREPARED_AT,
  })) as unknown as Json;
  return {
    name: c.name,
    projection,
    ctx: { internalNumber: number, tenantNip: SELLER_NIP, tenantId: ORG, ksefNumber: k, check, offer: 'pair' },
  };
}

// ─── połączenie Postgres (pula pg-boss, jak rls-kolejkowanie-wysylki) ─────

interface SqlRunner {
  executeSql(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

interface TransactionalDb extends SqlRunner {
  withTransaction<T>(fn: (tx: SqlRunner) => Promise<T>): Promise<T>;
}

let boss: import('pg-boss').PgBoss;
let stopBoss: typeof import('@/lib/jobs/boss').stopBoss;

/** Wbudowany `Db` pg-boss: `executeSql` z puli i `withTransaction` na jednym połączeniu (BEGIN … COMMIT/ROLLBACK). */
function pgDb(): TransactionalDb {
  const db = boss.getDb() as unknown as Partial<TransactionalDb>;
  if (typeof db.executeSql !== 'function' || typeof db.withTransaction !== 'function') {
    throw new Error('pg-boss: Db bez executeSql/withTransaction — test wymaga wbudowanej puli pg-boss');
  }
  return db as TransactionalDb;
}

/** Jedna transakcja jako `service_role` (F51) — COMMIT po `fn`, ROLLBACK po błędzie. */
function asService<T>(fn: (tx: SqlRunner) => Promise<T>): Promise<T> {
  return pgDb().withTransaction(async (tx) => {
    await tx.executeSql('SET LOCAL ROLE service_role');
    return fn(tx);
  });
}

const ROLLBACK = Symbol('rollback');

/** Transakcja cofnięta zawsze (także po sukcesie `fn`); zwraca wynik albo błąd `fn`. */
async function rolledBack<T>(fn: (tx: SqlRunner) => Promise<T>): Promise<{ value?: T; error?: unknown }> {
  let value: T | undefined;
  try {
    await pgDb().withTransaction(async (tx) => {
      value = await fn(tx);
      throw ROLLBACK;
    });
  } catch (e) {
    if (e === ROLLBACK) return { value };
    return { error: e };
  }
  return { value };
}

/** `decide_ksef_duplicate_original` przez `pg` z nazwanymi argumentami; id faktury wprost w tekście (sonda `pg_stat_activity`). */
function decideSql(args: OriginalArgs): { text: string; values: unknown[] } {
  if (!UUID.test(args.p_invoice_id)) throw new Error(`id faktury ${args.p_invoice_id} nie jest UUID`);
  return {
    text: `SELECT public.decide_ksef_duplicate_original(p_invoice_id => '${args.p_invoice_id}'::uuid, p_tenant_id => $1::uuid, `
      + 'p_actor_user_id => $2::uuid, p_choice => $3::text, p_via => $4::text, p_original_ksef_number => $5::text, '
      + 'p_original_sha256 => $6::text, p_env => $7::text, p_note => $8::text, p_mode => $9::text, p_offer => $10::text, '
      + 'p_import => $11::jsonb) AS result',
    values: [
      args.p_tenant_id, args.p_actor_user_id, args.p_choice, args.p_via, args.p_original_ksef_number, args.p_original_sha256,
      args.p_env, args.p_note, args.p_mode, args.p_offer, args.p_import === null ? null : JSON.stringify(args.p_import),
    ],
  };
}

/** Czeka (≤ 2 s), aż zapytanie z `tag` w tekście czeka na blokadę (`wait_event_type = 'Lock'`). */
async function waitsOnLock(tag: string): Promise<boolean> {
  for (let i = 0; i < 40; i += 1) {
    const { rows } = await pgDb().executeSql(
      `SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE $1`,
      [`%${tag}%`],
    );
    if (Number(rows[0]?.n) > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

type PlanNode = { 'Node Type'?: string; 'Relation Name'?: string; Plans?: PlanNode[] };

function planNodes(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(planNodes)];
}

describe.skipIf(!hasDatabase)('D-A4-1b-3 PR C (00156): zapis oryginału z oznaczeniem FaktWay', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    ids.owner = await userId(EMAIL.owner);
    ids.operator = await userId(EMAIL.operator);
    await cleanupTenant(ORG2);
    await admin.from('tenants').delete().eq('id', ORG2);
    await cleanup();
    await admin.from('memberships').delete().eq('organization_id', ORG);
    await admin.from('tenants').delete().eq('id', ORG);
    const { error: tErr } = await admin.from('tenants').insert({ id: ORG, nip: SELLER_NIP, name: 'Firma Zapis Oryginału' });
    if (tErr) throw tErr;
    await admin.from('users').upsert([
      { id: ids.owner, name: 'Owner Zapis Oryginału' },
      // Operator FaktFlow: użytkownik bez członkostwa w firmie (audit_logs.user_id → users).
      { id: ids.operator, name: 'Operator Zapis Oryginału' },
    ], { onConflict: 'id' });
    const { error: mErr } = await admin.from('memberships').insert([
      { organization_id: ORG, user_id: ids.owner, role: 'owner', status: 'active' },
    ]);
    if (mErr) throw mErr;
    owner = await signedIn(EMAIL.owner, ORG);
    ownerNoOrg = await signedIn(EMAIL.owner, null);
  }, 120_000);

  beforeEach(async () => {
    await cleanup();
  }, 60_000);

  afterAll(async () => {
    if (!hasDatabase) return;
    await cleanup();
    await cleanupTenant(ORG2);
    await admin.from('tenants').delete().eq('id', ORG2);
    await admin.from('memberships').delete().eq('organization_id', ORG);
    await admin.from('tenants').delete().eq('id', ORG);
  }, 120_000);

  // ─── R-C1 … R-C4: zapis oryginału przez klienta ──────────────────────────

  describe('R-C1–R-C4: decyzja klienta z zapisem oryginału K (INV-1, INV-2, INV-3, INV-18, INV-20)', () => {
    it('R-C1: FO-PARA same_sale (plik 23%) — K zapisany z pozycjami, plikiem, sesją i UPO pending; X wycofany bez numeru; audyty; bez I3/I3K', async () => {
      const p = await pendingOriginal();

      const { data, error } = await decideOriginal(p);

      // Dziś: PGRST202 — decide_ksef_duplicate_original nie istnieje (00156 puste).
      expect(error, error?.message).toBeNull();
      await expectImported(p, data, { choice: 'same_sale', offer: 'pair', via: 'client', actorUserId: ids.owner, note: null });
    });

    it('R-C1b: plik tylko zw (P_19A) i nabywca PESEL (po C0b) — ten sam skutek, K bez NIP nabywcy (B2C)', async () => {
      const p = await pendingOriginal({ buyer: 'pesel', rate: 'zw' });
      expect((p.gate?.preview as Json).buyerIdKind).toBe('pesel');
      expect((p.projection.invoice as Json)).toMatchObject({ buyer_nip: null, is_b2c: true, buyer_id_type: 'pesel', buyer_pesel: PESEL });

      const { data, error } = await decideOriginal(p);

      expect(error, error?.message).toBeNull();
      const k = await expectImported(p, data, { choice: 'same_sale', offer: 'pair', via: 'client', actorUserId: ids.owner, note: null });
      expect(k).toMatchObject({ buyer_nip: null, is_b2c: true, buyer_id_type: 'pesel', buyer_pesel: PESEL });
      expect(Number(k.vat_total)).toBe(0);
      expect((await linesOf(k.id as string)).map((l) => l.vat_rate)).toEqual(['zw', 'zw']);
    });

    it('R-C2: FO-PARA other_sale — ten sam skutek, decision.choice other_sale, error_message wpisów z tekstem zapisu', async () => {
      const p = await pendingOriginal();

      const { data, error } = await decideOriginal(p, { p_choice: 'other_sale' });

      expect(error, error?.message).toBeNull();
      await expectImported(p, data, { choice: 'other_sale', offer: 'pair', via: 'client', actorUserId: ids.owner, note: null });
      const marker = await markerOf(p);
      expect(marker.error_message).toBe(importedEntryMessage('client', 'pair', 'other_sale', p.number, p.k));
      expect((marker.original_check as Json & { decision: Json }).decision.choice).toBe('other_sale');
    });

    it.each<{ name: string; opts: PendingOpts }>([
      { name: 'R-C3: ownHistory=true w JSON', opts: { checkPatch: { ownHistory: true } } },
      { name: 'R-C3b (T3): JSON ownHistory=false, próba X z SHA oryginału w request_payload_hash', opts: { history: 'hash' } },
      { name: 'R-C3b (T3): JSON ownHistory=false, próba X z sesją oryginału', opts: { history: 'session' } },
      { name: 'R-C4: sameContentExceptHeader=true', opts: { checkPatch: { sameContentExceptHeader: true } } },
    ])('$name — oferta record: p_offer pair → STALE (offer), other_sale → CHOICE (choice), same_sale → zapis K', async ({ opts }) => {
      const p = await pendingOriginal(opts);
      // Własna historia nie blokuje faktflow-original (krok 12 pominięty, 4.5) — wybiera ofertę „tylko zapis”.
      expect(await blocker(p.id)).toBeNull();
      const before = await state(p);

      const stale = await decideOriginal(p, { p_offer: 'pair' });
      expect(stale.error?.code, stale.error?.message).toBe('P0001');
      expect(stale.error?.details).toBe('offer');
      expect(stale.error?.message).toBe(sqlText('STALE', p.number));
      await expectUntouched(p, before);

      const choice = await decideOriginal(p, { p_offer: 'record', p_choice: 'other_sale' });
      expect(choice.error?.code, choice.error?.message).toBe('P0001');
      expect(choice.error?.details).toBe('choice');
      expect(choice.error?.message).toBe(sqlText('CHOICE', p.number));
      await expectUntouched(p, before);

      const { data, error } = await decideOriginal(p, { p_offer: 'record' });
      expect(error, error?.message).toBeNull();
      await expectImported(p, data, { choice: 'same_sale', offer: 'record', via: 'client', actorUserId: ids.owner, note: null });
    });
  });

  // ─── R-C5, R-C6: atomowość i niezgodności projekcji ──────────────────────

  describe('R-C5, R-C6: odmowa przed zapisem albo w trakcie — nic się nie zmienia (INV-4)', () => {
    it('R-C5 (a): pozycja z jednostką 51 znaków → 22023 import-projection:lines przed zapisem; X, wpisy, K, pliki, UPO i audyt bez zmian', async () => {
      const p = await pendingOriginal();
      const projection = clone(p.projection);
      (projection.lines as Json[])[0]!.unit = 'u'.repeat(51);
      const before = await state(p);

      const { error } = await decideOriginal(p, { p_import: projection });

      expect(error?.code, error?.message).toBe('22023');
      expect(error?.details).toBe('import-projection:lines');
      await expectUntouched(p, before);
    });

    it('R-C6: każdy przypadek tabeli ORIGINAL_IMPORT_MISMATCH_CASES przez RPC (oferta pair, kontekst z bazy) — number/seller → P0001 IMPORT_MISMATCH, reszta → 22023 import-projection; stan bez zmian', async () => {
      const p = await pendingOriginal();
      const cases = originalImportMismatchCases().filter((c) => c.expected !== null && !c.ctx && c.offer === 'pair');
      expect(cases.length).toBeGreaterThan(50);
      const before = await state(p);

      const mismatches: Array<{ name: string; got: Json; want: Json }> = [];
      for (const c of cases) {
        const payload = c.mutate(clone(p.projection));
        const { error } = await decideOriginal(p, { p_import: payload });
        const expected = c.expected!;
        const client = (ORIGINAL_IMPORT_CLIENT_PROBLEMS as readonly string[]).includes(expected);
        // `v` ≠ 1 albo nie obiekt odmawia już krok 0 (22023, tekst techniczny) — DETAIL tylko od kroku 6d.
        const stepZero = !isRecord(payload) || payload.v !== 1;
        const want: Json = client
          ? { code: 'P0001', details: `import-mismatch:${expected}`, message: sqlText('IMPORT_MISMATCH', p.k, p.number) }
          : stepZero ? { code: '22023' } : { code: '22023', details: `import-projection:${expected}` };
        const got: Json = { code: error?.code ?? null };
        if ('details' in want) got.details = error?.details ?? null;
        if ('message' in want) got.message = error?.message ?? null;
        if (JSON.stringify(got) !== JSON.stringify(want)) mismatches.push({ name: c.name, got, want });
      }

      // Dziś: PGRST202 dla każdego przypadku (RPC nie istnieje).
      expect(mismatches).toEqual([]);
      await expectUntouched(p, before);
    });

    it('R-C6: stawka 0 WDT przy ofercie review-pair (operator, przegląd) → zapis przechodzi; K ma stawkę 0 WDT (jak Magiczny import, F42)', async () => {
      const p = await pendingOriginal({ gate: 'review' });
      const projection = clone(p.projection);
      for (const line of projection.lines as Json[]) line.vat_rate = '0 WDT';

      const { data, error } = await decideOriginal(p, asOperator({ p_offer: 'review-pair', p_import: projection }));

      expect(error, error?.message).toBeNull();
      expect(data).toMatchObject({ mode: 'import', offer: 'review-pair', via: 'operator', already_decided: false });
      const kRows = await kInvoices(p.k);
      expect(kRows).toHaveLength(1);
      expect((await linesOf(kRows[0]!.id as string)).map((l) => l.vat_rate)).toEqual(['0 WDT', '0 WDT']);
    });
  });

  // ─── R-C7, R-C8: inna firma i znany numer ────────────────────────────────

  describe('R-C7, R-C8: K albo numer X w innej firmie (INV-9) i K przy innym dokumencie tej firmy', () => {
    it.each<{ name: string; setup: (p: Pending) => Promise<void> }>([
      { name: '(a) faktura sprzedaży drugiej firmy ma K', setup: async (p) => { await acceptedInvoice(ORG2, `FV/ZO/INNA/${p.n}`, p.k); } },
      {
        name: '(b) faktura sprzedaży drugiej firmy ma numer X i wpis ksef_submissions (była wysyłana)',
        setup: async (p) => {
          const other = await plainInvoice(ORG2, p.number);
          await insertSubmission({ invoice_id: other, status: 'abandoned', session_reference_number: `SES-INNA-ZO-${p.n}`, attempted_at: '2026-08-20T10:00:00Z' }, ORG2);
        },
      },
    ])('R-C7 $name → blokada cross-tenant, RPC P0001 cross-tenant (nr, nr), I5 (stary znacznik) bez I5D/I5R; stan bez zmian', async ({ setup }) => {
      await withSecondTenant(async () => {
        const p = await pendingOriginal();
        await setup(p);
        const before = await state(p);

        // Dziś 00148: `reason` (allows odrzuca faktflow-original), kodu 00156 nie zna.
        expect(await blocker(p.id)).toBe('cross-tenant');
        const invariants = await invariantsOf(p.id);
        expect(invariants).toContain('I5');
        expect(invariants).not.toContain('I5D');
        expect(invariants).not.toContain('I5R');

        const { error } = await decideOriginal(p);
        expect(error?.code, error?.message).toBe('P0001');
        expect(error?.details).toBe('cross-tenant');
        expect(error?.message).toBe(sqlText('cross-tenant', p.number, p.number));
        await expectUntouched(p, before);
        expect(await tsVerdict(p.id, 'client')).toBe('cross-tenant');
      });
    });

    it('R-C7 (b′): druga firma ma tylko szkic z numerem X, bez wpisu ksef_submissions → blokada NULL (I5D), decyzja dostępna', async () => {
      await withSecondTenant(async () => {
        const p = await pendingOriginal();
        await plainInvoice(ORG2, p.number);

        expect(await blocker(p.id)).toBeNull();
        const invariants = await invariantsOf(p.id);
        expect(invariants).toContain('I5D');
        expect(invariants).not.toContain('I5');
        expect(await tsVerdict(p.id, 'client')).toBe('decidable');
      });
    });

    it('R-C8: inna faktura sprzedaży tej firmy ma już K → blokada known-now, RPC P0001 known-now (K, nr), I5; stan bez zmian', async () => {
      const p = await pendingOriginal();
      await acceptedInvoice(ORG, `FV/ZO/Y/${p.n}`, p.k);
      const before = await state(p);

      // Dziś 00148: `reason` (allows odrzuca faktflow-original), kodu 00156 nie zna.
      expect(await blocker(p.id)).toBe('known-now');
      const invariants = await invariantsOf(p.id);
      expect(invariants).toContain('I5');
      expect(invariants).not.toContain('I5D');

      const { error } = await decideOriginal(p);
      expect(error?.code, error?.message).toBe('P0001');
      expect(error?.details).toBe('known-now');
      expect(error?.message).toBe(sqlText('known-now', p.k, p.number));
      expect(await state(p)).toEqual(before);
      expect(await tsVerdict(p.id, 'client')).toBe('known-now');
    });
  });

  // ─── R-C9, R-C10: powtórzenie i wiązanie trybu ───────────────────────────

  describe('R-C9, R-C10: powtórzenie od zera (INV-5) i wiązanie trybu, oferty i projekcji (INV-8)', () => {
    it('R-C9: ta sama decyzja drugi raz = already_decided z tym samym imported_invoice_id, jeden K, audyt bez zmian; inny wybór → ALREADY_IMPORTED (nr, „ta sama sprzedaż”)', async () => {
      const { p, k } = await importedPair('same_sale');
      const afterFirst = await state(p);
      const kAudit = await auditRows(k.id as string, 'invoice.ksef_original_imported');

      const again = await decideOriginal(p);

      expect(again.error, again.error?.message).toBeNull();
      expect(again.data).toMatchObject({
        invoice_id: p.id, original_ksef_number: p.k, choice: 'same_sale', already_decided: true,
        imported_invoice_id: k.id, mode: 'import', offer: 'pair', retired_internal_number: p.number,
      });
      expect(await state(p)).toEqual(afterFirst);
      expect(await kInvoices(p.k)).toHaveLength(1);
      expect(await auditRows(k.id as string, 'invoice.ksef_original_imported')).toEqual(kAudit);

      const other = await decideOriginal(p, { p_choice: 'other_sale' });
      expect(other.error?.code, other.error?.message).toBe('P0001');
      expect(other.error?.details).toBe('already');
      expect(other.error?.message).toBe(sqlText('ALREADY_IMPORTED', p.number, choiceLabel('pair', 'same_sale')));
      expect(await state(p)).toEqual(afterFirst);
    });

    it('R-C9: decyzja z oferty record — inny wybór potem → ALREADY_IMPORTED z etykietą „zapis faktury z KSeF”', async () => {
      const p = await pendingOriginal({ checkPatch: { ownHistory: true } });
      const first = await decideOriginal(p, { p_offer: 'record' });
      expect(first.error, first.error?.message).toBeNull();
      const afterFirst = await state(p);

      const other = await decideOriginal(p, { p_offer: 'record', p_choice: 'other_sale' });

      expect(other.error?.code, other.error?.message).toBe('P0001');
      expect(other.error?.details).toBe('already');
      expect(other.error?.message).toBe(sqlText('ALREADY_IMPORTED', p.number, choiceLabel('record', 'same_sale')));
      expect(choiceLabel('record', 'same_sale')).toBe(DUPLICATE_DECISION_TEXTS.FAKTFLOW.IMPORTED_CARD_CHOICE.record);
      expect(await state(p)).toEqual(afterFirst);
    });

    it('R-C10: 9-argumentowe decide_ksef_duplicate dla faktflow-original z bramą importable → P0001 STALE (mode); stan bez zmian', async () => {
      const p = await pendingOriginal();
      const before = await state(p);

      const { error } = await decideRetire(p);

      // Dziś 00148 odmawia kodem `reason` (allows bez faktflow-original).
      expect(error?.code, error?.message).toBe('P0001');
      expect(error?.details).toBe('mode');
      expect(error?.message).toBe(sqlText('STALE', p.number));
      await expectUntouched(p, before);
    });

    it('R-C10: decide_ksef_duplicate_original dla no-own-file → P0001 STALE (mode); stan bez zmian', async () => {
      const p = await pendingOriginal({ reason: 'no-own-file' });
      expect(await blocker(p.id)).toBeNull();
      const before = await state(p);

      const { error } = await decideOriginal(p);

      expect(error?.code, error?.message).toBe('P0001');
      expect(error?.details).toBe('mode');
      expect(error?.message).toBe(sqlText('STALE', p.number));
      await expectUntouched(p, before);
    });

    it.each<{ name: string; over: (p: Pending) => Partial<OriginalArgs> }>([
      { name: 'tryb import z ofertą released', over: () => ({ p_offer: 'released' }) },
      { name: 'tryb import bez oferty', over: () => ({ p_offer: null }) },
      { name: 'tryb no-import z ofertą pair', over: () => ({ p_mode: 'no-import', p_offer: 'pair', p_import: null }) },
      { name: 'tryb spoza listy', over: () => ({ p_mode: 'zapisz' }) },
      { name: 'tryb import bez projekcji (p_import NULL)', over: () => ({ p_import: null }) },
      { name: 'tryb import z projekcją napisem', over: () => ({ p_import: 'projekcja' }) },
      { name: 'tryb no-import z projekcją', over: (p) => ({ p_mode: 'no-import', p_offer: 'released', p_import: clone(p.projection) }) },
    ])('R-C10: $name → 22023; stan bez zmian', async ({ over }) => {
      const p = await pendingOriginal();
      const before = await state(p);

      const { error } = await decideOriginal(p, over(p));

      expect(error?.code, error?.message).toBe('22023');
      await expectUntouched(p, before);
    });

    it('R-C10: via=client przy przeglądzie (brama review, oferta review-pair) → P0001 provenance-review (nr); stan bez zmian', async () => {
      const p = await pendingOriginal({ gate: 'review' });
      const before = await state(p);

      const { error } = await decideOriginal(p, { p_offer: 'review-pair' });

      expect(error?.code, error?.message).toBe('P0001');
      expect(error?.details).toBe('provenance-review');
      expect(error?.message).toBe(sqlText('provenance-review', p.number));
      await expectUntouched(p, before);
    });
  });

  // ─── R-C11: oddanie decyzji klientowi ────────────────────────────────────

  describe('R-C11: FO-ODDANA — release_ksef_original_review (INV-21) i decyzja no-import', () => {
    it('R-C11: oddanie przy review-pair — importGate.release {at, via, actorUserId, note}, blokada NULL (I5D), audyt; powtórzenie = already_released bez audytu; decyzja no-import → X szkic Z numerem, bez K', async () => {
      const p = await pendingOriginal({ gate: 'review' });
      // Dziś blokada 00148: reason.
      expect(await blocker(p.id)).toBe('provenance-review');

      const first = await releaseReview(p);

      expect(first.error, first.error?.message).toBeNull();
      expect(first.data).toMatchObject({ invoice_id: p.id, original_ksef_number: p.k, already_released: false });
      const marker = await markerOf(p);
      const check = marker.original_check as Json;
      const { release, ...gateRest } = check.importGate as Json & { release: Json };
      // Pełny kształt T6 zapisany przez SQL (4.7 krok 8); `release_at` wyniku = ta sama chwila (klucz e-maila z Date.parse).
      expect(Object.keys(release).sort()).toEqual(['actorUserId', 'at', 'note', 'via']);
      expect(release).toMatchObject({ via: 'operator', actorUserId: ids.operator, note: OPERATOR_NOTE });
      sameInstant((first.data as Json).release_at, release.at);
      const releaseAt = release.at;
      expect(gateRest).toEqual(p.gate);
      expect({ ...check, importGate: gateRest }).toEqual(p.check);
      expect(duplicateOriginalOffer(check, false)).toBe('released');
      expect(await blocker(p.id)).toBeNull();
      const invariants = await invariantsOf(p.id);
      expect(invariants).toContain('I5D');
      expect(invariants).not.toContain('I5');
      expect(invariants).not.toContain('I5R');
      const released = await auditRows(p.id, 'invoice.ksef_original_review_released');
      expect(released).toHaveLength(1);
      expect(released[0]!.user_id).toBe(ids.operator);
      expect(released[0]!.details_json).toMatchObject({ note: OPERATOR_NOTE, original_ksef_number: p.k, sha256: p.file.sha256, gate_problems: ['rates'] });

      const again = await releaseReview(p);
      expect(again.error, again.error?.message).toBeNull();
      expect(again.data).toMatchObject({ invoice_id: p.id, original_ksef_number: p.k, already_released: true, release_at: releaseAt });
      expect(await auditRows(p.id, 'invoice.ksef_original_review_released')).toHaveLength(1);
      expect((await markerOf(p)).original_check).toEqual(check);

      const { data, error } = await decideOriginal(p, { p_mode: 'no-import', p_offer: 'released', p_import: null, p_choice: 'other_sale' });

      expect(error, error?.message).toBeNull();
      expect(data).toMatchObject({
        invoice_id: p.id, internal_number: p.number, original_ksef_number: p.k, choice: 'other_sale', via: 'client',
        reason: 'faktflow-original', already_decided: false, mode: 'no-import', offer: 'released',
      });
      expect((data as Json).imported_invoice_id ?? null).toBeNull();
      expect(await invoiceRow(p.id)).toMatchObject({ ksef_status: 'draft', internal_number: p.number, submitted_to_ksef_at: null, last_error_code: null });
      expect(await kInvoices(p.k)).toEqual([]);
      const decided = await markerOf(p);
      expect(decided).toMatchObject({ status: 'number_taken', error_message: retiredEntryMessage('client', 'other_sale', p.number, p.k) });
      const decision = (decided.original_check as Json & { decision: Json }).decision;
      expect(decision).toMatchObject({
        choice: 'other_sale', via: 'client', reason: 'faktflow-original', env: 'test', mode: 'no-import', offer: 'released',
        actorUserId: ids.owner, note: null,
        release: { at: releaseAt, via: 'operator', actorUserId: ids.operator, note: OPERATOR_NOTE },
      });
      expect(decision).not.toHaveProperty('importedInvoiceId');
      expect(decision).not.toHaveProperty('retiredInternalNumber');
      // Szkic wycofany bez zapisu oryginału — teksty 00148 (4.11: „Bez v_imported — teksty 00148; FO-ODDANA też tu”).
      const enqueue = await admin.rpc('enqueue_ksef_send', { p_invoice_id: p.id, p_tenant_id: ORG, p_attempt_id: 'proba-rc11' });
      expect(enqueue.error?.code).toBe('P0001');
      expect(enqueue.error?.message).toBe(sqlText('TRIGGER_OTHER', p.number, p.k));
    });

    it('R-C11: sameContentExceptHeader = null (F50) i brama review — oddanie działa: oferta released, blokada NULL', async () => {
      const p = await pendingOriginal({ gate: 'review', checkPatch: { sameContentExceptHeader: null } });
      expect(await blocker(p.id)).toBe('provenance-review');

      const { error } = await releaseReview(p);

      expect(error, error?.message).toBeNull();
      const { data: offer, error: offerError } = await admin.rpc('ksef_duplicate_original_offer', {
        p_check: (await markerOf(p)).original_check, p_own_history_db: false,
      });
      expect(offerError, offerError?.message).toBeNull();
      expect(offer).toBe('released');
      expect(await blocker(p.id)).toBeNull();
    });

    it.each<{ name: string; setup: () => Promise<Pending>; call?: (p: Pending) => PromiseLike<{ error: RpcError }>; code: string; message?: string; details?: string }>([
      {
        name: 'review-record (ownHistory true) → release:own-file',
        setup: () => pendingOriginal({ gate: 'review', checkPatch: { ownHistory: true } }),
        code: 'P0001', message: 'release:own-file',
      },
      { name: 'brama importable (blokada NULL) → release:not-review, DETAIL none', setup: () => pendingOriginal(), code: 'P0001', message: 'release:not-review', details: 'none' },
      {
        name: 'znacznik bez importGate → release:not-review, DETAIL recheck-needed (F41)',
        setup: () => pendingOriginal({ gate: 'none' }), code: 'P0001', message: 'release:not-review', details: 'recheck-needed',
      },
      {
        name: 'wpłata na X przy przeglądzie → release:not-review, DETAIL payments',
        setup: async () => {
          const p = await pendingOriginal({ gate: 'review' });
          await insertPayment(p.id);
          return p;
        },
        code: 'P0001', message: 'release:not-review', details: 'payments',
      },
      {
        name: 'inny numer KSeF oryginału niż pokazany → release:stale',
        setup: () => pendingOriginal({ gate: 'review' }), call: (p) => releaseReview(p, { p_original_ksef_number: ksefNumber(99999) }),
        code: 'P0001', message: 'release:stale',
      },
      {
        name: 'inny SHA niż pokazany → release:stale',
        setup: () => pendingOriginal({ gate: 'review' }), call: (p) => releaseReview(p, { p_original_sha256: 'cc'.repeat(32) }),
        code: 'P0001', message: 'release:stale',
      },
      {
        name: 'środowisko inne niż sprawdzenia oryginału → release:env',
        setup: () => pendingOriginal({ gate: 'review' }), call: (p) => releaseReview(p, { p_env: 'production' }),
        code: 'P0001', message: 'release:env',
      },
      {
        name: 'notatka krótsza niż 10 znaków → 22023',
        setup: () => pendingOriginal({ gate: 'review' }), call: (p) => releaseReview(p, { p_note: 'ok' }), code: '22023',
      },
    ])('R-C11: $name; original_check i audyt bez zmian', async ({ setup, call, code, message, details }) => {
      const p = await setup();
      const before = await state(p);

      const { error } = await (call ? call(p) : releaseReview(p));

      expect(error?.code, error?.message).toBe(code);
      if (message !== undefined) expect(error?.message).toBe(message);
      if (details !== undefined) expect(error?.details).toBe(details);
      expect(await state(p)).toEqual(before);
    });
  });

  // ─── R-C12, R-C13: szkic wycofany po zapisie i faktura K ─────────────────

  describe('R-C12, R-C13: szkic wycofany po zapisie oryginału (INV-6) i K bez historii wysyłki', () => {
    it.each<DuplicateChoice>(['same_sale', 'other_sale'])('R-C12 (%s): sesja klienta nie usuwa X, nie nadaje mu numeru i nie zmienia kierunku; enqueue/claim odmawiają — teksty *_IMPORTED = TS; serwis może', async (choice) => {
      const { p } = await importedPair(choice);
      const submissions = await policySubmissions(p.id);
      const view = retiredDraftView({ invoiceNumber: null, invoiceKind: 'regular', submissions: submissions as unknown as ViewSubmissions, kindHeld: false });
      const sendText = choice === 'same_sale'
        ? sqlText('TRIGGER_SAME_IMPORTED', p.number, p.k, p.number)
        : sqlText('TRIGGER_OTHER_IMPORTED', p.number, p.number, p.k);

      const del = await owner.from('invoices').delete().eq('id', p.id).select('id');
      // Dziś zapis K (importedPair) pada wcześniej na PGRST202; ciało 00148 wyzwalacza dałoby TRIGGER_DELETE z „(bez numeru)”.
      expect(del.error?.code, del.error?.message).toBe('P0001');
      expect(del.data ?? []).toEqual([]);
      expect(del.error?.message).toBe(sqlText('TRIGGER_DELETE_IMPORTED', p.number, p.k));
      expect(del.error?.message).toBe(view?.deleteRefusal);
      expect(await invoiceRow(p.id)).not.toBeNull();

      const renumber = await owner.from('invoices').update({ internal_number: `${p.number}-NOWY` }).eq('id', p.id).select('internal_number');
      expect(renumber.error?.code, renumber.error?.message).toBe('P0001');
      expect(renumber.error?.message).toBe(sqlText('TRIGGER_RENUMBER_IMPORTED', p.number, p.k));
      expect((await invoiceRow(p.id))?.internal_number).toBeNull();

      const flip = await owner.from('invoices').update({ direction: 'incoming' }).eq('id', p.id).select('direction');
      expect(flip.error?.code, flip.error?.message).toBe('P0001');
      expect(flip.error?.message).toBe(sqlText('TRIGGER_DIRECTION_IMPORTED', p.number, p.k));
      expect((await invoiceRow(p.id))?.direction).toBe('outgoing');

      const enqueue = await admin.rpc('enqueue_ksef_send', { p_invoice_id: p.id, p_tenant_id: ORG, p_attempt_id: 'proba-rc12' });
      expect(enqueue.error?.code, enqueue.error?.message).toBe('P0001');
      expect(enqueue.error?.message).toBe(sendText);
      expect(enqueue.error?.message).toBe(retiredDraftSendRefusal(null, submissions));
      const claim = await admin.rpc('claim_ksef_send', { p_invoice_id: p.id, p_tenant_id: ORG, p_owner: 'stara-proba-rc12', p_lease_seconds: 900 });
      expect(claim.error?.code, claim.error?.message).toBe('P0001');
      expect(claim.error?.message).toBe(sendText);
      expect(await invoiceRow(p.id)).toMatchObject({ ksef_status: 'draft', submitted_to_ksef_at: null, ksef_send_owner: null });
      expect(await auditRows(p.id, 'invoice.send_enqueued')).toHaveLength(0);

      // INV-6: serwis może (00148 bez zmian semantyki) — kierunek, numer inny niż K, usunięcie.
      const serviceFlip = await admin.from('invoices').update({ direction: 'incoming' }).eq('id', p.id).select('direction');
      expect(serviceFlip.error, serviceFlip.error?.message).toBeNull();
      expect(serviceFlip.data).toEqual([{ direction: 'incoming' }]);
      const serviceDelete = await admin.from('invoices').delete().eq('id', p.id).select('id');
      expect(serviceDelete.error, serviceDelete.error?.message).toBeNull();
      expect(serviceDelete.data).toHaveLength(1);
    });

    it('R-C13: K nie ma submitted_to_ksef_at; enqueue_ksef_send(K) odmawia (stan accepted) — P0002, K bez zmian', async () => {
      const { k } = await importedPair();
      expect(k.submitted_to_ksef_at).toBeNull();

      const { error } = await admin.rpc('enqueue_ksef_send', { p_invoice_id: k.id, p_tenant_id: ORG, p_attempt_id: 'proba-rc13' });

      expect(error?.code, error?.message).toBe('P0002');
      expect((await kInvoices(k.ksef_number as string))[0]).toEqual(k);
    });
  });

  // ─── R-C14: brak daty nadania albo sesji ─────────────────────────────────

  describe('R-C14 (C6, T4): oryginał bez daty nadania albo bez sesji — K zapisany, trwały sygnał I3K', () => {
    it.each<{ name: string; acquiredAt: string | null }>([
      { name: 'acquiredAt null', acquiredAt: null },
      { name: 'acquiredAt nie jest datą', acquiredAt: 'wczoraj' },
    ])('R-C14: $name → K.ksef_accepted_at NULL (nigdy now()), UPO z czasem zastępczym ≈ now, I3K no_date; wynik acquired_at_missing', async ({ acquiredAt }) => {
      const p = await pendingOriginal({ checkPatch: { acquiredAt } });
      const t0 = Date.now();

      const { data, error } = await decideOriginal(p);

      const t1 = Date.now();
      expect(error, error?.message).toBeNull();
      expect(data).toMatchObject({ mode: 'import', acquired_at_missing: true, session_missing: false });
      const kRows = await kInvoices(p.k);
      expect(kRows).toHaveLength(1);
      const k = kRows[0]!;
      expect(k.ksef_accepted_at).toBeNull();
      const upo = await upoOf(k.id as string);
      expect(upo).toHaveLength(1);
      expect(upo[0]).toMatchObject({ status: 'pending', ksef_environment: 'test', ksef_number: p.k, last_error: null });
      const upoAt = Date.parse(String(upo[0]!.ksef_acceptance_timestamp));
      expect(upoAt).toBeGreaterThanOrEqual(t0 - 5 * 60_000);
      expect(upoAt).toBeLessThanOrEqual(t1 + 5 * 60_000);
      const violations = await violationsOf(k.id as string);
      expect(violations.map((v) => v.invariant)).not.toContain('I3');
      const i3k = violations.filter((v) => v.invariant === 'I3K');
      expect(i3k).toHaveLength(1);
      expect(i3k[0]!.detail).toMatchObject({ ksef_number: p.k, no_date: true, no_session: false, upo_status: 'pending' });
      const decided = await auditRows(p.id, 'invoice.ksef_duplicate_decided');
      expect(decided[0]!.details_json).toMatchObject({ import: { imported_invoice_id: k.id, acquired_at_missing: true, session_missing: false } });
    });

    it('R-C14: oryginał bez sesji → brak wpisu K, UPO failed z tekstem NO_SESSION_REFERENCE (upo-client.ts), I3K no_session, bez I3; wynik session_missing', async () => {
      const { downloadUpoFromKsef } = await import('@/lib/ksef/upo-client');
      // Bez numeru sesji funkcja odmawia przed jakąkolwiek siecią i bazą — to ten sam tekst co (c7).
      const noSession = await downloadUpoFromKsef(ORG, ksefNumber(1));
      if (noSession.success) throw new Error('downloadUpoFromKsef bez sesji powinno odmówić');
      expect(noSession.errorCode).toBe('NO_SESSION_REFERENCE');
      const p = await pendingOriginal({ session: null });

      const { data, error } = await decideOriginal(p);

      expect(error, error?.message).toBeNull();
      expect(data).toMatchObject({ mode: 'import', acquired_at_missing: false, session_missing: true });
      const kRows = await kInvoices(p.k);
      expect(kRows).toHaveLength(1);
      const k = kRows[0]!;
      sameInstant(k.ksef_accepted_at, ACQUIRED_AT);
      expect(await submissionsOf(k.id as string)).toEqual([]);
      const upo = await upoOf(k.id as string);
      expect(upo).toHaveLength(1);
      expect(upo[0]).toMatchObject({ status: 'failed', last_error: noSession.error, ksef_environment: 'test', ksef_number: p.k });
      sameInstant(upo[0]!.ksef_acceptance_timestamp, ACQUIRED_AT);
      const violations = await violationsOf(k.id as string);
      expect(violations.map((v) => v.invariant)).not.toContain('I3');
      const i3k = violations.filter((v) => v.invariant === 'I3K');
      expect(i3k).toHaveLength(1);
      expect(i3k[0]!.detail).toMatchObject({ ksef_number: p.k, no_date: false, no_session: true, upo_status: 'failed' });
      const imported = await auditRows(k.id as string, 'invoice.ksef_original_imported');
      expect(imported[0]!.details_json).toMatchObject({ session: null, upo_status: 'failed' });
    });
  });

  // ─── R-C15: lustra TS = SQL ──────────────────────────────────────────────

  describe('R-C15 (INV-15): lustra jsonb na wspólnych tabelach', () => {
    it('R-C15: ksef_duplicate_check_allows = duplicateCheckAllows = oczekiwanie (pełna DUPLICATE_CHECK_CASES, z faktflow-original)', async () => {
      expect(DUPLICATE_CHECK_CASES.some((c) => isRecord(c.check) && c.check.reason === 'faktflow-original' && c.allows)).toBe(true);

      const sql: Array<{ name: string; sql: unknown; error: string | null; allows: boolean }> = [];
      for (const c of DUPLICATE_CHECK_CASES) {
        const { data, error } = await admin.rpc('ksef_duplicate_check_allows', { p_check: c.check ?? null, p_choice: c.choice });
        sql.push({ name: c.name, sql: data, error: error ? `${error.code}: ${error.message}` : null, allows: c.allows });
      }
      // Dziś 00148 odmawia każdemu faktflow-original (allows = false).
      expect(sql.filter((r) => r.error !== null || r.sql !== r.allows)).toEqual([]);

      const ts = DUPLICATE_CHECK_CASES.map((c) => ({
        name: c.name, ts: duplicateCheckAllows(clone(c.check ?? null) as unknown, c.choice), allows: c.allows,
      }));
      expect(ts.filter((r) => r.ts !== r.allows)).toEqual([]);
    });

    it('R-C15: ksef_duplicate_original_offer = duplicateOriginalOffer i ksef_duplicate_gate_ok = originalGateOk (faktflowOfferCases)', async () => {
      const cases = faktflowOfferCases();
      expect(cases.length).toBeGreaterThan(50);
      const gateOf = (check: unknown): unknown => (isRecord(check) && 'importGate' in check ? check.importGate ?? null : null);

      const rows: Array<{ name: string; offer: unknown; gateOk: unknown; error: string | null; want: { offer: unknown; gateOk: boolean } }> = [];
      for (const c of cases) {
        const offer = await admin.rpc('ksef_duplicate_original_offer', { p_check: c.check ?? null, p_own_history_db: c.ownHistoryDb });
        const gate = await admin.rpc('ksef_duplicate_gate_ok', { p_gate: gateOf(c.check) });
        const error = offer.error ?? gate.error;
        rows.push({
          name: c.name, offer: offer.data ?? null, gateOk: gate.data, error: error ? `${error.code}: ${error.message}` : null,
          want: { offer: c.offer, gateOk: c.gateOk },
        });
      }
      // Dziś: PGRST202 dla każdego wiersza (funkcje nie istnieją).
      expect(rows.filter((r) => r.error !== null || r.offer !== r.want.offer || r.gateOk !== r.want.gateOk)).toEqual([]);

      const ts = cases.map((c) => {
        const check = clone(c.check ?? null) as unknown;
        return { name: c.name, offer: duplicateOriginalOffer(check, c.ownHistoryDb), gateOk: originalGateOk(gateOf(check)), want: { offer: c.offer, gateOk: c.gateOk } };
      });
      expect(ts.filter((r) => r.offer !== r.want.offer || r.gateOk !== r.want.gateOk)).toEqual([]);
    });
  });

  // ─── R-C16: I5D, I5R, I5 ─────────────────────────────────────────────────

  describe('R-C16: I5D / I5R / I5 dla faktflow-original; blokada = polityka TS', () => {
    it('R-C16: brama importable → I5D (z powodem faktflow-original), bez I5 i I5R; blokada NULL; TS decidable', async () => {
      const p = await pendingOriginal();

      const violations = await violationsOf(p.id);

      // Dziś 00148: blokada `reason` → I5, I5D nie powstaje.
      expect(violations.map((v) => v.invariant)).toEqual(['I5D']);
      expect(violations[0]!.detail).toMatchObject({ original_ksef_number: p.k, reason: 'faktflow-original', env: 'test', checked_at: CHECKED_AT });
      expect(await blocker(p.id)).toBeNull();
      expect(await tsVerdict(p.id, 'client')).toBe('decidable');
    });

    it('R-C16: poprawna brama review → I5R z problemami bramy, bez I5D i I5; blokada provenance-review; TS: klient provenance-review, operator — widok review', async () => {
      const p = await pendingOriginal({ gate: 'review' });

      const violations = await violationsOf(p.id);

      expect(violations.map((v) => v.invariant)).toEqual(['I5R']);
      expect(violations[0]!.detail).toMatchObject({ original_ksef_number: p.k, reason: 'faktflow-original', env: 'test', problems: ['rates'] });
      expect(await blocker(p.id)).toBe('provenance-review');
      expect(await tsVerdict(p.id, 'client')).toBe('provenance-review');
      expect(await tsVerdict(p.id, 'operator')).toBe('review');
    });

    it.each<{ name: string; opts: PendingOpts }>([
      { name: 'znacznik bez importGate (sprzed 00156)', opts: { gate: 'none' } },
      { name: 'importGate w złym kształcie (importable z problemem)', opts: { checkPatch: { importGate: { v: 1, rules: 1, kind: 'importable', problems: ['rates'], preview: null } } } },
      { name: 'znacznik z recheckNeeded (odmowa w chwili zapisu)', opts: { checkPatch: { recheckNeeded: { kind: 'gate-drift', at: '2026-09-02T10:00:00.000Z' } } } },
    ])('R-C16: $name → I5 (stary znacznik), nie I5R ani I5D; blokada recheck-needed = TS (lustro 11c)', async ({ opts }) => {
      const p = await pendingOriginal(opts);

      const invariants = await invariantsOf(p.id);

      expect(invariants).toContain('I5');
      expect(invariants).not.toContain('I5D');
      expect(invariants).not.toContain('I5R');
      expect(await blocker(p.id)).toBe('recheck-needed');
      expect(await tsVerdict(p.id, 'client')).toBe('recheck-needed');
      expect(await tsVerdict(p.id, 'operator')).toBe('recheck-needed');
    });
  });

  // ─── R-C18: blokada dla sesji klienta ────────────────────────────────────

  describe('R-C18: ksef_duplicate_decision_blocker_for_session (4.9, firma z x-active-org)', () => {
    it('R-C18: właściciel firmy dla własnej faktury → kod blokady (= blokada serwisowa); faktura firmy B → not-found; bez x-active-org → not-found; anon → 42501', async () => {
      await withSecondTenant(async () => {
        const review = await pendingOriginal({ gate: 'review' });
        const ready = await pendingOriginal();
        const otherFirm = await plainInvoice(ORG2, `FV/ZO/B/${counter}`, {
          ksef_status: 'failed', last_error_code: 'KSEF_DUPLICATE_RECONCILE', last_error: SEEDED_ERROR,
        });

        const call = (client: SupabaseClient, invoiceId: string) =>
          client.rpc('ksef_duplicate_decision_blocker_for_session', { p_invoice_id: invoiceId });

        // Dziś: PGRST202 (funkcja nie istnieje).
        const own = await call(owner, review.id);
        expect(own.error, own.error?.message).toBeNull();
        expect(own.data).toBe('provenance-review');
        expect(own.data).toBe(await blocker(review.id));
        const waiting = await call(owner, ready.id);
        expect(waiting.error, waiting.error?.message).toBeNull();
        expect(waiting.data ?? null).toBeNull();

        const foreign = await call(owner, otherFirm);
        expect(foreign.error, foreign.error?.message).toBeNull();
        expect(foreign.data).toBe('not-found');

        const noOrg = await call(ownerNoOrg, review.id);
        expect(noOrg.error, noOrg.error?.message).toBeNull();
        expect(noOrg.data).toBe('not-found');

        const anon = await call(anonClient(), review.id);
        expect(anon.error?.code).toBe('42501');
      });
    });
  });

  // ─── R-C19: zapis operatora w przeglądzie ────────────────────────────────

  describe('R-C19 (INV-22, INV-17): zapis operatora w przeglądzie pliku', () => {
    it('R-C19: via=operator z notatką, oferta review-pair → K zapisany; decyzja i K niosą operatora i notatkę', async () => {
      const p = await pendingOriginal({ gate: 'review' });

      const { data, error } = await decideOriginal(p, asOperator({ p_offer: 'review-pair' }));

      expect(error, error?.message).toBeNull();
      await expectImported(p, data, { choice: 'same_sale', offer: 'review-pair', via: 'operator', actorUserId: ids.operator, note: OPERATOR_NOTE });
    });

    it.each<{ name: string; setup: () => Promise<Pending>; over: Partial<OriginalArgs>; text: (p: Pending) => [DuplicateDecisionSqlTextKey, ...string[]]; details: string }>([
      {
        name: 'review-record + other_sale → CHOICE',
        setup: () => pendingOriginal({ gate: 'review', checkPatch: { ownHistory: true } }),
        over: { p_offer: 'review-record', p_choice: 'other_sale' }, text: (p) => ['CHOICE', p.number], details: 'choice',
      },
      {
        name: 'wpłata na X → payments mimo przeglądu (payments przed provenance-review)',
        setup: async () => {
          const p = await pendingOriginal({ gate: 'review' });
          await insertPayment(p.id);
          return p;
        },
        over: { p_offer: 'review-pair' }, text: (p) => ['payments', p.number], details: 'payments',
      },
      {
        name: 'recheckNeeded na znaczniku → recheck-needed (bez wyjątku operatora)',
        setup: () => pendingOriginal({ gate: 'review', checkPatch: { recheckNeeded: { kind: 'gate-drift', at: '2026-09-02T10:00:00.000Z' } } }),
        over: { p_offer: 'review-pair' }, text: (p) => ['recheck-needed', p.number], details: 'recheck-needed',
      },
    ])('R-C19: operator, $name; stan bez zmian', async ({ setup, over, text, details }) => {
      const p = await setup();
      const before = await state(p);

      const { error } = await decideOriginal(p, asOperator(over));

      expect(error?.code, error?.message).toBe('P0001');
      const [key, ...args] = text(p);
      expect(error?.message).toBe(sqlText(key, ...args));
      // `payments` to kod 00148 bez DETAIL; nowe kody 00156 niosą DETAIL (4.14).
      if (details !== 'payments') expect(error?.details).toBe(details);
      expect(await state(p)).toEqual(before);
    });
  });

  // ─── R-C20: Magiczny import po zapisie ───────────────────────────────────

  it('R-C20 (INV-11): import historii z KSeF obejmujący K po zapisie → „Pominięto duplikat (DB, KSeF)”, invoicesFailed 0, K bez zmian, jeden wiersz xml_documents', async () => {
    const { p, k } = await importedPair();
    const { processImportedInvoices } = await import('@/lib/import/import-engine');
    const parsed = parseFa3Xml(p.file.xml, { ksefNumber: p.k });
    parsed.xmlArchive = { storagePath: p.archivePath, sha256Hash: p.file.sha256, sizeBytes: p.file.sizeBytes };

    const result = await processImportedInvoices({
      tenantId: ORG,
      importJobId: 'rls-zapis-oryginalu-rc20',
      invoices: [parsed],
      source: 'ksef_history',
      invoiceDirection: 'outgoing',
      invoiceKsefStatus: 'accepted',
      ksefEnvironment: 'test',
    });

    // Dziś K nie powstaje (RPC nie istnieje) — importedPair pada wcześniej.
    expect(result.warnings).toContain(`Pominięto duplikat (DB, KSeF): ${p.k}`);
    expect(result.invoicesFailed).toBe(0);
    expect(result.invoicesImported).toBe(0);
    expect(await kInvoices(p.k)).toEqual([k]);
    expect(await xmlDocumentsOf(k.id as string)).toHaveLength(1);
  });

  // ─── R-C22: strażnik PR B ────────────────────────────────────────────────

  it('R-C22 strażnik (INV-14): 9-argumentowe decide_ksef_duplicate dla no-own-file — wynik, decyzja, tekst wpisów i audyt w kształcie 00148, bez kluczy PR C', async () => {
    const p = await pendingOriginal({ reason: 'no-own-file' });

    const { data, error } = await decideRetire(p);

    // Zielony przed i po 00156: tryb `retire` core = 00151 (00148 w marce FaktWay) bajt w bajt.
    expect(error, error?.message).toBeNull();
    expect(Object.keys(data as Json).sort()).toEqual(
      ['already_decided', 'choice', 'internal_number', 'invoice_id', 'original_ksef_number', 'reason', 'submissions_closed', 'via'],
    );
    expect(data).toMatchObject({ invoice_id: p.id, internal_number: p.number, choice: 'other_sale', reason: 'no-own-file', already_decided: false, submissions_closed: 2 });
    expect(await invoiceRow(p.id)).toMatchObject({ ksef_status: 'draft', internal_number: p.number });
    expect(await kInvoices(p.k)).toEqual([]);
    const marker = await markerOf(p);
    expect(marker).toMatchObject({ status: 'number_taken', error_message: retiredEntryMessage('client', 'other_sale', p.number, p.k) });
    expect(Object.keys((marker.original_check as Json & { decision: Json }).decision).sort()).toEqual(['at', 'choice', 'env', 'reason', 'via']);
    const decided = await auditRows(p.id, 'invoice.ksef_duplicate_decided');
    expect(decided).toHaveLength(1);
    expect(Object.keys(decided[0]!.details_json).sort()).toEqual(
      ['choice', 'env', 'marker_submission_id', 'note', 'original', 'previous', 'reason', 'retired', 'submissions_closed', 'via'],
    );
  });

  // ─── R-C23: znacznik „sprawdź ponownie” ──────────────────────────────────

  describe('R-C23 (INV-25): flag_ksef_original_recheck', () => {
    it('R-C23: gate-drift na FO-PARA → recheckNeeded {kind, at}, blokada recheck-needed, I5 dopiero po 48 h od próby (nie I5D); drugi raz already bez audytu; decyzja klienta → recheck-needed', async () => {
      // Oba otwarte wpisy świeże — I5 liczy każdy wpis sent/intent starszy niż 48 h, nie tylko znacznik.
      const p = await pendingOriginal({
        markerAt: new Date(Date.now() - 60_000).toISOString(), olderAt: new Date(Date.now() - 120_000).toISOString(),
      });
      expect(await blocker(p.id)).toBeNull();

      const { data, error } = await flagRecheck(p, 'gate-drift');

      // Dziś: PGRST202 (funkcja nie istnieje).
      expect(error, error?.message).toBeNull();
      expect(data).toMatchObject({ flagged: true });
      const flagged = (await markerOf(p)).original_check as Json;
      const { recheckNeeded, ...rest } = flagged;
      expect(rest).toEqual(p.check);
      expect(recheckNeeded).toMatchObject({ kind: 'gate-drift' });
      expect(Number.isNaN(Date.parse(String((recheckNeeded as Json).at)))).toBe(false);
      expect(await blocker(p.id)).toBe('recheck-needed');
      expect(await invoiceRow(p.id)).toMatchObject({ ksef_status: 'failed', last_error_code: 'KSEF_DUPLICATE_RECONCILE', internal_number: p.number });
      const audit = await auditRows(p.id, 'invoice.ksef_original_recheck_flagged');
      expect(audit).toHaveLength(1);
      expect(audit[0]!.details_json).toMatchObject({ kind: 'gate-drift', original_ksef_number: p.k, sha256: p.file.sha256 });
      // Świeży znacznik: jeszcze nie I5 (48 h), a blokada ≠ NULL — nie I5D.
      const fresh = await invariantsOf(p.id);
      expect(fresh).not.toContain('I5');
      expect(fresh).not.toContain('I5D');
      expect(fresh).not.toContain('I5R');
      const { error: shiftError } = await admin.from('ksef_submissions')
        .update({ attempted_at: new Date(Date.now() - 49 * 3_600_000).toISOString() }).eq('id', p.markerId);
      expect(shiftError).toBeNull();
      const old = await invariantsOf(p.id);
      expect(old).toContain('I5');
      expect(old).not.toContain('I5D');

      const again = await flagRecheck(p, 'archive-missing');
      expect(again.error, again.error?.message).toBeNull();
      expect(again.data).toMatchObject({ flagged: false, already: true });
      expect((await markerOf(p)).original_check).toEqual(flagged);
      expect(await auditRows(p.id, 'invoice.ksef_original_recheck_flagged')).toHaveLength(1);

      const decision = await decideOriginal(p);
      expect(decision.error?.code, decision.error?.message).toBe('P0001');
      expect(decision.error?.details).toBe('recheck-needed');
      expect(decision.error?.message).toBe(sqlText('recheck-needed', p.number));
    });

    it.each<{ name: string; setup: () => Promise<Pending>; call?: (p: Pending) => ReturnType<typeof flagRecheck>; reason: string }>([
      {
        name: 'decyzja zapisana na znaczniku (decision obecne)',
        setup: () => pendingOriginal({ checkPatch: { decision: { choice: 'same_sale', via: 'client', at: '2026-09-02T10:00:00.000Z', reason: 'faktflow-original', env: 'test' } } }),
        reason: 'stale',
      },
      { name: 'powód inny niż faktflow-original', setup: () => pendingOriginal({ reason: 'no-own-file' }), reason: 'stale' },
      { name: 'inny K niż na znaczniku', setup: () => pendingOriginal(), call: (p) => flagRecheck(p, 'gate-drift', { p_original_ksef_number: ksefNumber(99999) }), reason: 'stale' },
      { name: 'inny SHA niż na znaczniku', setup: () => pendingOriginal(), call: (p) => flagRecheck(p, 'gate-drift', { p_original_sha256: 'cc'.repeat(32) }), reason: 'stale' },
      {
        name: 'faktura nie w failed KSEF_DUPLICATE_RECONCILE (po decyzji — szkic wycofany)',
        setup: async () => {
          const p = await pendingOriginal();
          const { error } = await decideOriginal(p);
          expect(error, error?.message).toBeNull();
          return p;
        },
        reason: 'not-pending',
      },
    ])('R-C23: $name → {flagged: false, reason: $reason}, bez zapisu i audytu', async ({ setup, call, reason }) => {
      const p = await setup();
      const before = await state(p);

      const { data, error } = await (call ? call(p) : flagRecheck(p, 'gate-drift'));

      expect(error, error?.message).toBeNull();
      expect(data).toMatchObject({ flagged: false, reason });
      expect(await state(p)).toEqual(before);
    });

    it('R-C23: rodzaj spoza listy 4.7b → 22023, stan bez zmian', async () => {
      const p = await pendingOriginal();
      const before = await state(p);

      const { error } = await flagRecheck(p, 'cokolwiek');

      expect(error?.code, error?.message).toBe('22023');
      expect(await state(p)).toEqual(before);
    });
  });

  // ─── Połączenie Postgres: lustro 4.8, atomowość, plan, uprawnienia, wyścigi ───

  describe.skipIf(!hasDatabaseUrl)('połączenie Postgres (pg, SET LOCAL ROLE service_role)', () => {
    beforeAll(async () => {
      // Moduł kolejki czyta DATABASE_URL przy pierwszym użyciu — ta sama lokalna baza.
      process.env.DATABASE_URL = databaseUrl!;
      process.env.JOBS_BACKEND = 'pgboss';
      const bossModule = await import('@/lib/jobs/boss');
      stopBoss = bossModule.stopBoss;
      boss = await bossModule.startBoss();
    }, 120_000);

    afterAll(async () => {
      await stopBoss?.();
    }, 60_000);

    const MISMATCH_SQL = 'SELECT public.ksef_original_import_mismatch($1::jsonb, '
      + 'jsonb_populate_record(NULL::public.invoices, $2::jsonb), '
      + 'jsonb_populate_record(NULL::public.ksef_submissions, $3::jsonb), $4::uuid, $5::text, $6::text) AS problem';

    /** `p_inv` / `p_marker` z kontekstu lustra (numer X, K, `original_check`). */
    const mismatchValues = (projection: unknown, ctx: OriginalImportProblemContext): unknown[] => [
      JSON.stringify(projection),
      JSON.stringify({
        id: '1414ffff-0000-4000-8000-000000000001', tenant_id: ctx.tenantId, direction: 'outgoing', internal_number: ctx.internalNumber,
        ksef_status: 'failed', last_error_code: 'KSEF_DUPLICATE_RECONCILE',
      }),
      JSON.stringify({
        id: '1414ffff-0000-4000-8000-000000000002', tenant_id: ctx.tenantId, invoice_id: '1414ffff-0000-4000-8000-000000000001',
        status: 'sent', original_ksef_number: ctx.ksefNumber, original_session_reference_number: 'SES-ORIG-ZO', original_check: ctx.check,
      }),
      ctx.tenantId,
      ctx.tenantNip,
      ctx.offer,
    ];

    it('R-C1c: cała macierz rundy przez ksef_original_import_mismatch (każda oferta importu) → NULL; check_b2c_has_id na wierszu z projekcji → prawda', async () => {
      const inputs = roundMatrix().map((c, i) => matrixInput(c, i + 1));
      expect(inputs.length).toBeGreaterThan(35);

      const rows = await asService(async (tx) => {
        const { rows: defs } = await tx.executeSql(
          `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
            WHERE c.conname = 'check_b2c_has_id' AND c.conrelid = 'public.invoices'::regclass`,
        );
        const def = String(defs[0]?.def ?? '');
        const expr = /^CHECK \(([\s\S]*)\)$/.exec(def)?.[1];
        if (!expr) throw new Error(`check_b2c_has_id: nieoczekiwana definicja „${def}”`);
        const out: Array<{ name: string; offer: string; problem: unknown; ts: unknown; b2c: unknown }> = [];
        for (const input of inputs) {
          const { rows: b2c } = await tx.executeSql(
            `SELECT (${expr}) AS ok FROM jsonb_populate_record(NULL::public.invoices, $1::jsonb) AS r`,
            [JSON.stringify(input.projection.invoice)],
          );
          for (const offer of ['pair', 'record', 'review-pair', 'review-record'] as const) {
            const ctx = { ...input.ctx, offer };
            const { rows: problem } = await tx.executeSql(MISMATCH_SQL, mismatchValues(input.projection, ctx));
            out.push({
              name: input.name, offer, problem: problem[0]?.problem ?? null,
              ts: originalImportProjectionProblem(input.projection, ctx), b2c: b2c[0]?.ok,
            });
          }
        }
        return out;
      });

      // Dziś: 42883 — ksef_original_import_mismatch nie istnieje.
      expect(rows.filter((r) => r.problem !== null || r.ts !== null || r.b2c !== true)).toEqual([]);
    });

    it('R-C6: ORIGINAL_IMPORT_MISMATCH_CASES przez ksef_original_import_mismatch = oczekiwany kod = lustro TS (originalImportProjectionProblem)', async () => {
      const cases = originalImportMismatchCases();
      expect(cases.length).toBeGreaterThan(100);

      const rows = await asService(async (tx) => {
        const out: Array<{ name: string; sql: unknown; ts: unknown; expected: unknown }> = [];
        for (const c of cases) {
          const base = originalImportBase();
          const projection = c.mutate(base.projection);
          const ctx: OriginalImportProblemContext = { ...base.ctx, offer: c.offer, ...c.ctx };
          const { rows: problem } = await tx.executeSql(MISMATCH_SQL, mismatchValues(projection, ctx));
          out.push({ name: c.name, sql: problem[0]?.problem ?? null, ts: originalImportProjectionProblem(projection, ctx), expected: c.expected });
        }
        return out;
      });

      // Dziś: 42883 — funkcja nie istnieje.
      expect(rows.filter((r) => r.sql !== r.expected || r.ts !== r.expected)).toEqual([]);
    });

    it('R-C5 (b): awaria OSTATNIEGO zapisu (c7, upo_receipts) w transakcji RPC → błąd z wyzwalacza, wszystko cofnięte (INV-4)', async () => {
      const p = await pendingOriginal();
      const before = await state(p);
      const { text, values } = decideSql(originalArgs(p));

      const outcome = await rolledBack(async (tx) => {
        // Jako postgres: wyzwalacz testowy tylko w tej transakcji (DDL w Postgresie jest transakcyjny).
        await tx.executeSql(`CREATE FUNCTION public.rls_zapis_oryginalu_upo_fail() RETURNS trigger
          LANGUAGE plpgsql AS $f$ BEGIN RAISE EXCEPTION 'test'; END $f$`);
        await tx.executeSql(`CREATE TRIGGER rls_zapis_oryginalu_upo_fail BEFORE INSERT ON public.upo_receipts
          FOR EACH ROW EXECUTE FUNCTION public.rls_zapis_oryginalu_upo_fail()`);
        await tx.executeSql('SET LOCAL ROLE service_role');
        return tx.executeSql(text, values);
      });

      // Dziś: 42883 — RPC nie istnieje (błąd przed zapisem, nie z wyzwalacza).
      expect(outcome.error).toMatchObject({ code: 'P0001', message: 'test' });
      await expectUntouched(p, before);
      const { rows } = await pgDb().executeSql(
        `SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'rls_zapis_oryginalu_upo_fail'`,
      );
      expect(Number(rows[0]?.n)).toBe(0);
    });

    it('R-C7 (c): plan ksef_duplicate_cross_tenant (prosrc w PREPARE, enable_seqscan off) — bez Seq Scan na invoices, tenants i ksef_submissions', async () => {
      const p = await pendingOriginal();
      const name = `rls_zapis_cross_tenant_${Date.now()}`;

      const plan = await pgDb().withTransaction(async (tx) => {
        const { rows } = await tx.executeSql(
          `SELECT p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.proname = 'ksef_duplicate_cross_tenant'`,
        );
        expect(rows, 'ksef_duplicate_cross_tenant w pg_proc').toHaveLength(1);
        const body = String(rows[0]!.prosrc);
        await tx.executeSql('SET LOCAL enable_seqscan = off');
        await tx.executeSql(`PREPARE ${name}(uuid, text, text) AS ${body}`);
        const { rows: explained } = await tx.executeSql(
          `EXPLAIN (FORMAT JSON) EXECUTE ${name}('${ORG}'::uuid, '${p.k}', '${p.number}')`,
        );
        await tx.executeSql(`DEALLOCATE ${name}`);
        return explained[0]!['QUERY PLAN'] as Array<{ Plan: PlanNode }>;
      });

      // Dziś: brak funkcji w pg_proc.
      const seqScans = planNodes(plan[0]!.Plan)
        .filter((node) => node['Node Type'] === 'Seq Scan')
        .map((node) => node['Relation Name']);
      expect(seqScans.filter((relation) => ['invoices', 'tenants', 'ksef_submissions'].includes(String(relation)))).toEqual([]);
    });

    it('R-C17: uprawnienia nowych funkcji (has_function_privilege) — anon i authenticated bez EXECUTE poza blokadą dla sesji (authenticated tak, anon nie); service_role tak', async () => {
      const functions: ReadonlyArray<{ fn: string; authenticated: boolean }> = [
        { fn: 'public.ksef_duplicate_own_history(uuid, uuid, text, text)', authenticated: false },
        { fn: 'public.ksef_duplicate_gate_ok(jsonb)', authenticated: false },
        { fn: 'public.ksef_duplicate_original_offer(jsonb, boolean)', authenticated: false },
        { fn: 'public.ksef_duplicate_cross_tenant(uuid, text, text)', authenticated: false },
        { fn: 'public.ksef_duplicate_decision_blocker_for_session(uuid)', authenticated: true },
        { fn: 'public.ksef_original_import_mismatch(jsonb, public.invoices, public.ksef_submissions, uuid, text, text)', authenticated: false },
        { fn: 'public.ksef_duplicate_decide_core(text, text, uuid, uuid, uuid, text, text, text, text, text, text, jsonb)', authenticated: false },
        { fn: 'public.decide_ksef_duplicate_original(uuid, uuid, uuid, text, text, text, text, text, text, text, text, jsonb)', authenticated: false },
        { fn: 'public.release_ksef_original_review(uuid, uuid, uuid, text, text, text, text)', authenticated: false },
        { fn: 'public.flag_ksef_original_recheck(uuid, uuid, uuid, text, text, text)', authenticated: false },
      ];

      const { rows } = await pgDb().executeSql(
        `SELECT f AS fn, r AS role, has_function_privilege(r, f, 'EXECUTE') AS ok
           FROM unnest($1::text[]) AS f CROSS JOIN unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r`,
        [functions.map((f) => f.fn)],
      );

      // Dziś: 42883 — funkcje nie istnieją.
      const want = functions.flatMap((f) => [
        { fn: f.fn, role: 'anon', ok: false },
        { fn: f.fn, role: 'authenticated', ok: f.authenticated },
        { fn: f.fn, role: 'service_role', ok: true },
      ]);
      const key = (r: { fn: unknown; role: unknown }) => `${String(r.fn)}|${String(r.role)}`;
      expect([...rows].map((r) => ({ fn: r.fn, role: r.role, ok: r.ok })).sort((a, b) => key(a).localeCompare(key(b))))
        .toEqual([...want].sort((a, b) => key(a).localeCompare(key(b))));
    });

    it('R-C21 (a): dwa równoległe _original z tym samym wyborem — pierwsze already_decided=false, drugie (czekało na blokadę) true z tym samym K; z innym wyborem → ALREADY_IMPORTED', async () => {
      for (const second of ['same_sale', 'other_sale'] as const) {
        const p = await pendingOriginal();
        const first = decideSql(originalArgs(p));
        const other = decideSql(originalArgs(p, { p_choice: second }));
        // Obiekt, nie `let`: przypisania w wywołaniu zwrotnym nie zawężają typu po wyjściu z niego.
        const race: { second?: Promise<{ result?: Json; error?: unknown }>; sawWait: boolean } = { sawWait: false };

        const firstResult = await asService(async (tx) => {
          const { rows } = await tx.executeSql(first.text, first.values);
          race.second = asService((txB) => txB.executeSql(other.text, other.values))
            .then(({ rows: r }) => ({ result: r[0]?.result as Json }), (error: unknown) => ({ error }));
          race.sawWait = await waitsOnLock(p.id);
          return rows[0]?.result as Json;
        });
        if (!race.second) throw new Error('drugie wywołanie nie wystartowało');
        const secondOutcome = await race.second;

        // Dziś: 42883 — RPC nie istnieje.
        expect(firstResult).toMatchObject({ already_decided: false, mode: 'import', offer: 'pair' });
        expect(race.sawWait, 'drugie wywołanie nie czekało na blokadę pierwszego — wyścig nie został sprawdzony').toBe(true);
        if (second === 'same_sale') {
          expect(secondOutcome.error).toBeUndefined();
          expect(secondOutcome.result).toMatchObject({ already_decided: true, imported_invoice_id: firstResult.imported_invoice_id });
        } else {
          expect(secondOutcome.error).toMatchObject({
            code: 'P0001', detail: 'already', message: sqlText('ALREADY_IMPORTED', p.number, choiceLabel('pair', 'same_sale')),
          });
        }
        expect(await kInvoices(p.k)).toHaveLength(1);
      }
    });

    it('R-C21 (b): transakcja A po RPC (otwarta) — B wstawia fakturę z numerem X → czeka na A; A COMMIT → B 23505 (indeks 00120)', async () => {
      const p = await pendingOriginal();
      const { text, values } = decideSql(originalArgs(p));
      const tId = nextId();
      const race: { insert?: Promise<unknown>; sawWait: boolean } = { sawWait: false };

      await asService(async (tx) => {
        await tx.executeSql(text, values);
        race.insert = asService((txB) => txB.executeSql(
          `INSERT INTO public.invoices (id, tenant_id, direction, internal_number, invoice_type, invoice_kind, issue_date,
             seller_nip, buyer_nip, gross_total, net_total, vat_total, currency, ksef_status, fa3_data, seller_data, buyer_data)
           VALUES ('${tId}'::uuid, $1::uuid, 'outgoing', $2, 'VAT', 'regular', '2026-10-01', $3, $4, 123, 100, 23, 'PLN', 'draft',
             $5::jsonb, $6::jsonb, $7::jsonb)`,
          [ORG, p.number, SELLER_NIP, BUYER_NIP, JSON.stringify({ internalNumber: p.number, type: 'VAT' }),
            JSON.stringify({ nip: SELLER_NIP }), JSON.stringify({ nip: BUYER_NIP, name: 'Nabywca' })],
        )).then(() => null, (error: unknown) => error);
        race.sawWait = await waitsOnLock(tId);
      });
      if (!race.insert) throw new Error('wstawienie B nie wystartowało');
      const insertError = await race.insert;

      // Dziś: 42883 — RPC nie istnieje (A pada przed B).
      expect(race.sawWait, 'wstawienie B nie czekało na transakcję A — wyścig nie został sprawdzony').toBe(true);
      expect(insertError).toMatchObject({ code: '23505' });
      expect((await kInvoices(p.k)).map((k) => k.internal_number)).toEqual([p.number]);
      expect(await invoiceRow(tId)).toBeNull();
    });
  });
});

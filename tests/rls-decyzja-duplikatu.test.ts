import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { getRlsTestEnvironment } from './helpers/rls-environment';

/**
 * D-A4-1b-3 PR B (00148) na prawdziwej bazie — decyzja klienta przy
 * nierozstrzygniętym duplikacie 440 (decyzje Bartosza 04.10 i 07.10.2026):
 *
 *   - szkic z wpisem `number_taken` (decyzja albo automatyczny „numer zajęty”)
 *     nie wychodzi ze stanu `draft` — kolejkowanie, przejęcie, zapis porażki
 *     i akceptacji odbijają się od wyzwalacza `c_guard_ksef_retired_draft`
 *     z tekstem równym `retiredDraftSendRefusal` z TS (R1a–R1d),
 *   - sesja klienta nie usuwa wycofanego szkicu zwykłej faktury ani zaliczki
 *     (KOR i ROZ zostają usuwalne — 07.10 (9)), także po zmianie kierunku,
 *     i nie zmienia jego numeru (07.10 (11)) ani kierunku (rewizja PR B #0);
 *     serwis może (R1e–R1i),
 *   - RPC `decide_ksef_duplicate`: skutki w jednej transakcji, odmowy
 *     z tekstami z `DUPLICATE_DECISION_SQL_TEXTS`, powtórzenie = already_decided
 *     (R2–R4),
 *   - I5D „czeka na klienta” zamiast I5, blokada = polityka TS (R5),
 *   - `ksef_duplicate_check_allows` = `duplicateCheckAllows` na wspólnej tabeli (R6),
 *   - nowe funkcje tylko dla serwisu (R7).
 *
 * Moduły TS PR B (`@/lib/ksef/duplicate-decision`, `…-facts`) i wspólna
 * tabela (`tests/unit/helpers/ksef-duplicate-decision-cases.ts`) ładujemy
 * dynamicznie i dopiero PO asercji zachowania bazy — przed naprawą każdy
 * przypadek pada na zachowaniu (PGRST202, brak odmowy), a plik ładuje się
 * i bez bazy jest pomijany. Faktura abonamentu (`billing`) jest w
 * tests/rls-kolejkowanie-wysylki.test.ts: serwis nie założy jej przez
 * PostgREST (00079/00080), potrzebna jest rola `postgres`.
 */

const hasDatabase = Boolean(
  process.env.RLS_TEST_SUPABASE_URL?.trim() &&
    process.env.RLS_TEST_SUPABASE_ANON_KEY?.trim() &&
    process.env.RLS_TEST_SUPABASE_SERVICE_ROLE_KEY?.trim(),
);
const environment = hasDatabase ? getRlsTestEnvironment() : null;
const admin: SupabaseClient = environment
  ? createClient(environment.url, environment.serviceRoleKey)
  : (null as unknown as SupabaseClient);

const ORG = '13131313-1313-4313-8313-131313131313';
const PASS = 'RlsDecyzjaPass2026Aa!';
const EMAIL = {
  owner: 'rls-decyzja-owner@ksef-saas.test',
  admin: 'rls-decyzja-admin@ksef-saas.test',
  member: 'rls-decyzja-member@ksef-saas.test',
  operator: 'rls-decyzja-operator@ksef-saas.test',
} as const;

const SELLER = '9480000014';
const BUYER = '1234567890';
const BUYER_NAME = 'Nabywca Decyzja';
/** Skrót bajtów oryginału (`original_check.sha256`). */
const SHA = 'bb'.repeat(32);
/** Skrót naszego pliku próby (`request_payload_hash`) — inny niż oryginału. */
const OUR_HASH = 'aa'.repeat(32);
const SEEDED_ERROR = 'KSeF ma już fakturę o tym numerze — do rozstrzygnięcia na karcie faktury (ta sama czy inna sprzedaż); nie wystawiaj jej ponownie.';
const OPERATOR_NOTE = 'e-mail od właściciela 05.10, Jan Kowalski';
const MARKER_AT = '2026-09-01T10:00:00.000Z';
const OLDER_AT = '2026-08-31T10:00:00.000Z';
const SUBMITTED_AT = '2026-10-01T10:00:00.000Z';
const ENV_LABEL: Record<string, string> = { test: 'testowe', production: 'produkcyjne', demo: 'demo' };
/** Kolumny wpisu próby, które czyta loader PR B (2.3) — plus kod i treść błędu. */
const SUBMISSION_COLUMNS = 'id, status, session_reference_number, request_payload_hash, response_ksef_number, original_ksef_number, original_session_reference_number, original_check, attempted_at, completed_at, error_code, error_message';
const INVOICE_COLUMNS = 'internal_number, ksef_status, ksef_number, ksef_send_owner, submitted_to_ksef_at, xml_storage_path, xml_generated_at, last_attempt_at, submission_attempts, last_error, last_error_code, last_error_field, last_error_suggestion, notes, updated_at';

type Kind = 'regular' | 'advance' | 'correction' | 'final';
type Choice = 'same_sale' | 'other_sale';
type Reason = 'no-own-file' | 'known-number' | 'faktflow-original' | 'same-content-other-program' | 'download-refused';
type RpcError = { code?: string; message: string } | null;
type Json = Record<string, unknown>;

type DecisionModule = typeof import('@/lib/ksef/duplicate-decision');
type SqlTextKey = keyof DecisionModule['DUPLICATE_DECISION_SQL_TEXTS'];
/** Wiersze `ksef_submissions` tak, jak je przyjmuje polityka (spec nie przypina typu wiersza — bierzemy go z funkcji). */
type PolicySubmissions = Parameters<DecisionModule['retiredDraftSendRefusal']>[1];
type ViewSubmissions = Parameters<DecisionModule['retiredDraftView']>[0]['submissions'];

const ids = { owner: '', admin: '', member: '', operator: '' };
let owner: SupabaseClient;
let member: SupabaseClient;
let counter = 0;

function nextId(): string {
  counter += 1;
  return `1313aaaa-0000-4000-8000-${String(counter).padStart(12, '0')}`;
}

/** Fikcyjny numer KSeF w formacie KSeF. */
function ksefNumber(n: number): string {
  return `9480000014-20260915-${String(n).padStart(12, '0')}-00`;
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

async function signedIn(email: string): Promise<SupabaseClient> {
  const c = createClient(environment!.url, environment!.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { 'x-active-org': ORG } },
  });
  const { error } = await c.auth.signInWithPassword({ email, password: PASS });
  if (error) throw error;
  return c;
}

/** Polityka i teksty PR B — ładowane po asercji zachowania bazy. */
function policy(): Promise<DecisionModule> {
  return import('@/lib/ksef/duplicate-decision');
}

/** Tekst odmowy z bazy = szablon 2.11.A wypełniony jak w RAISE (lustro TS). */
async function sqlText(key: SqlTextKey, ...args: string[]): Promise<string> {
  const { DUPLICATE_DECISION_SQL_TEXTS, fillSqlText } = await policy();
  return fillSqlText(DUPLICATE_DECISION_SQL_TEXTS[key].template, ...args);
}

// ─── wiersze ────────────────────────────────────────────────────────────

function invoiceData(id: string, number: string | null, columns: Json): Json {
  const type = typeof columns.invoice_type === 'string' ? columns.invoice_type : 'VAT';
  return {
    id, tenant_id: ORG, direction: 'outgoing', internal_number: number, invoice_type: 'VAT', invoice_kind: 'regular',
    issue_date: '2026-10-01', seller_nip: SELLER, buyer_nip: BUYER, gross_total: 123, net_total: 100, vat_total: 23,
    currency: 'PLN', ksef_status: 'draft',
    fa3_data: { internalNumber: number, type }, seller_data: { nip: SELLER }, buyer_data: { nip: BUYER, name: BUYER_NAME },
    ...columns,
  };
}

async function insertInvoice(row: Json): Promise<void> {
  const { error } = await admin.from('invoices').insert(row);
  if (error) throw new Error(`insert invoices: ${error.message}`);
}

async function insertSubmission(row: Json): Promise<string> {
  const { data, error } = await admin.from('ksef_submissions')
    .insert({ tenant_id: ORG, submission_type: 'online', ...row })
    .select('id').single();
  if (error) throw new Error(`insert ksef_submissions: ${error.message}`);
  return data.id as string;
}

/** Faktura przyjęta w KSeF TEST — rodzic korekty albo zaliczka rozliczana przez ROZ. */
async function acceptedInvoice(kind: 'regular' | 'advance'): Promise<string> {
  const id = nextId();
  const number = `${kind === 'advance' ? 'ZAL' : 'FV'}/PRZYJETA/${counter}`;
  await insertInvoice(invoiceData(id, number, {
    ...(kind === 'advance' ? { invoice_type: 'ZAL', invoice_kind: 'advance', advance_amount: 100 } : {}),
    ksef_status: 'accepted', ksef_environment: 'test', ksef_number: ksefNumber(5000 + counter),
    ksef_accepted_at: '2026-09-20T10:00:00Z', xml_storage_path: `${ORG}/przyjeta-${counter}.xml`,
  }));
  return id;
}

/** Kolumny rodzaju dokumentu (00012: ZAL z kwotą, KOR z rodzicem, ROZ z zaliczką; 00118: rodzic przyjęty). */
async function kindColumns(kind: Kind): Promise<{ prefix: string; columns: Json }> {
  switch (kind) {
    case 'regular':
      return { prefix: 'FV', columns: {} };
    case 'advance':
      return { prefix: 'ZAL', columns: { invoice_type: 'ZAL', invoice_kind: 'advance', advance_amount: 100 } };
    case 'correction':
      return {
        prefix: 'KOR',
        columns: {
          invoice_type: 'KOR', invoice_kind: 'correction', parent_invoice_id: await acceptedInvoice('regular'),
          correction_reason: 'test', correction_type: 'before_after', gross_total: -123, net_total: -100, vat_total: -23,
        },
      };
    case 'final':
      return {
        prefix: 'ROZ',
        columns: { invoice_type: 'ROZ', invoice_kind: 'final', advance_invoice_ids: [await acceptedInvoice('advance')] },
      };
  }
}

function originalCheck(input: {
  reason: Reason;
  number: string;
  k: string;
  knownInvoice?: { id: string; internalNumber: string | null } | null;
}): Json {
  const fetched = input.reason !== 'download-refused';
  return {
    v: 1,
    env: 'test',
    checkedAt: '2026-09-01T10:05:00Z',
    reason: input.reason,
    sha256: fetched ? SHA : null,
    archivePath: fetched ? `${ORG}/ksef-import/${input.k}.xml` : null,
    sizeBytes: fetched ? 2048 : null,
    summary: fetched
      ? {
        systemInfo: input.reason === 'faktflow-original' ? 'KSeF SaaS v1.0' : 'Inny Program 1.0', number: input.number,
        issueDate: '2026-10-01', buyerNip: BUYER, buyerName: BUYER_NAME, gross: '123.00', currency: 'PLN',
      }
      : null,
    sameContentExceptHeader: input.reason === 'known-number' ? false : input.reason === 'same-content-other-program' ? true : null,
    ownHistory: fetched ? false : null,
    acquiredAt: fetched ? '2026-08-31T09:00:00Z' : null,
    httpStatus: fetched ? null : 403,
    knownInvoice: input.knownInvoice ?? null,
    recheck: null,
  };
}

/** Kształt PR A dla known-number: werdykt przed pobraniem — bez sha256, summary i ownHistory. */
function prACheck(knownInvoice: { id: string; internalNumber: string | null }): Json {
  return {
    v: 1, env: 'test', checkedAt: '2026-09-01T10:05:00Z', reason: 'known-number', sha256: null, archivePath: null,
    sizeBytes: null, summary: null, sameContentExceptHeader: null, ownHistory: null, acquiredAt: null,
    httpStatus: null, knownInvoice, recheck: null,
  };
}

interface Pending {
  id: string;
  /** Numer kolejny fixture: SES-OWN-n, SES-ORIG-n, …/DEC/n. */
  n: number;
  number: string;
  k: string;
  markerId: string | null;
  olderId: string;
  extraIds: string[];
  yId: string | null;
  yNumber: string | null;
  check: Json | null;
  xmlPath: string;
}

/**
 * Faktura czekająca na decyzję: failed KSEF_DUPLICATE_RECONCILE z polami
 * wysyłki (submitted_to_ksef_at, plik, 6 prób) + znacznik 440 na wpisie `sent`
 * (SES-OWN-n, oryginał SES-ORIG-n, nasz plik 'aa'×32, 2026-09-01) + starszy
 * wpis `sent` bez znacznika. `known` dodaje Y — fakturę firmy z numerem K.
 */
async function pendingDuplicate(opts: {
  reason?: Reason;
  kind?: Kind;
  known?: boolean;
  yStatus?: 'accepted' | 'failed';
  yHoldsOriginal?: boolean;
  knownInvoiceId?: string;
  check?: 'full' | 'pr-a' | null;
  checkPatch?: Json;
  marker?: boolean;
  markerAt?: string;
  patch?: Json;
  rows?: Json[];
} = {}): Promise<Pending> {
  const reason = opts.reason ?? 'no-own-file';
  const { prefix, columns } = await kindColumns(opts.kind ?? 'regular');
  const id = nextId();
  const n = counter;
  const number = `${prefix}/DEC/${n}`;
  const k = ksefNumber(n);
  const xmlPath = `${ORG}/2026/10/${id}/proba-6.xml`;

  let yId: string | null = null;
  let yNumber: string | null = null;
  if (opts.known ?? reason === 'known-number') {
    yId = nextId();
    yNumber = `FV/INNA/${n}`;
    const yStatus = opts.yStatus ?? 'accepted';
    await insertInvoice(invoiceData(yId, yNumber, {
      issue_date: '2026-09-15', ksef_status: yStatus, ksef_environment: 'test',
      ksef_number: (opts.yHoldsOriginal ?? true) ? k : null, xml_storage_path: `${ORG}/ksef-import/${k}.xml`,
      ...(yStatus === 'accepted'
        ? { ksef_accepted_at: '2026-09-15T09:00:00Z' }
        : { last_error_code: 'INFRA', last_error: 'PostgREST 503' }),
    }));
  }

  await insertInvoice(invoiceData(id, number, {
    ...columns,
    ksef_status: 'failed', last_error_code: 'KSEF_DUPLICATE_RECONCILE', last_error: SEEDED_ERROR,
    submitted_to_ksef_at: SUBMITTED_AT, last_attempt_at: SUBMITTED_AT, submission_attempts: 6,
    xml_storage_path: xmlPath, xml_generated_at: '2026-10-01T09:59:00Z',
    ...opts.patch,
  }));

  const knownInvoice = yId || opts.knownInvoiceId
    ? { id: opts.knownInvoiceId ?? yId!, internalNumber: yNumber ?? `FV/INNA/${n}` }
    : null;
  const check = opts.check === null
    ? null
    : opts.check === 'pr-a'
      ? prACheck(knownInvoice!)
      : { ...originalCheck({ reason, number, k, knownInvoice }), ...opts.checkPatch };

  const olderId = await insertSubmission({
    invoice_id: id, status: 'sent', session_reference_number: `SES-OWN-${n}-0`, invoice_reference_number: `REF-${n}-0`,
    request_payload_hash: 'cc'.repeat(32), attempted_at: OLDER_AT,
  });
  const markerId = (opts.marker ?? true)
    ? await insertSubmission({
      invoice_id: id, status: 'sent', error_code: '440', session_reference_number: `SES-OWN-${n}`,
      invoice_reference_number: `REF-${n}`, request_payload_hash: OUR_HASH, original_ksef_number: k,
      original_session_reference_number: `SES-ORIG-${n}`, original_check: check, attempted_at: opts.markerAt ?? MARKER_AT,
    })
    : null;
  if (!markerId) {
    // Bez znacznika: dwa zwykłe otwarte wpisy, żaden bez numeru oryginału.
    await insertSubmission({
      invoice_id: id, status: 'sent', session_reference_number: `SES-OWN-${n}`, invoice_reference_number: `REF-${n}`,
      request_payload_hash: OUR_HASH, attempted_at: MARKER_AT,
    });
  }
  const extraIds: string[] = [];
  for (const [i, row] of (opts.rows ?? []).entries()) {
    extraIds.push(await insertSubmission({
      invoice_id: id, session_reference_number: `SES-OWN-${n}-x${i}`, invoice_reference_number: `REF-${n}-x${i}`,
      attempted_at: '2026-08-30T10:00:00Z', ...row,
    }));
  }
  return { id, n, number, k, markerId, olderId, extraIds, yId, yNumber, check, xmlPath };
}

type TakenRow =
  | { shape: 'decided'; choice: Choice; k?: 'k' | 'k2'; at?: string; via?: 'client' | 'operator' }
  | { shape: 'automatic'; k?: 'k' | 'k2'; at?: string }
  | { shape: 'unmarked'; at?: string };

interface Retired { id: string; number: string; kind: Kind; k: string; k2: string }

/**
 * Szkic wycofany: szkic bez pól wysyłki + wpisy number_taken trzech kształtów —
 * `decided` (original_check.decision), `automatic` (numer oryginału, bez
 * decyzji — automatyczny KSEF_NUMBER_TAKEN) i `unmarked` (bez numeru oryginału).
 */
async function retiredDraft(kind: Kind, rows: TakenRow[]): Promise<Retired> {
  const { prefix, columns } = await kindColumns(kind);
  const id = nextId();
  const n = counter;
  const number = `${prefix}/WYC/${n}`;
  const k = ksefNumber(n);
  const k2 = ksefNumber(7000 + n);
  await insertInvoice(invoiceData(id, number, columns));
  for (const [i, row] of rows.entries()) {
    const at = row.at ?? new Date(Date.parse('2026-10-02T10:00:00Z') + i * 60_000).toISOString();
    const original = row.shape === 'unmarked' ? null : row.k === 'k2' ? k2 : k;
    const choiceText = row.shape === 'decided' ? (row.choice === 'same_sale' ? 'ta sama sprzedaż' : 'inna sprzedaż') : '';
    await insertSubmission({
      invoice_id: id, status: 'number_taken', error_code: 'NUMBER_TAKEN',
      error_message: row.shape === 'decided'
        ? `Decyzja klienta: ${choiceText} — numer ${number} zajęty w KSeF przez fakturę ${original}`
        : `Numer ${number} zajęty w KSeF${original ? ` przez fakturę ${original}` : ''}`,
      session_reference_number: `SES-NT-${n}-${i}`, invoice_reference_number: `REF-NT-${n}-${i}`,
      original_ksef_number: original, original_session_reference_number: original ? `SES-ORIG-${n}-${i}` : null,
      original_check: row.shape === 'decided'
        ? {
          ...originalCheck({ reason: 'no-own-file', number, k: original! }),
          decision: { choice: row.choice, via: row.via ?? 'client', at, reason: 'no-own-file', env: 'test' },
        }
        : null,
      attempted_at: at, completed_at: at,
    });
  }
  return { id, number, kind, k, k2 };
}

async function plainDraft(): Promise<{ id: string; number: string }> {
  const id = nextId();
  const number = `FV/SZKIC/${counter}`;
  await insertInvoice(invoiceData(id, number, {}));
  return { id, number };
}

async function invoiceRow(id: string): Promise<Json | null> {
  const { data, error } = await admin.from('invoices')
    .select(INVOICE_COLUMNS)
    .eq('id', id).maybeSingle();
  if (error) throw error;
  return data as Json | null;
}

/** Kierunek i numer faktury (INVOICE_COLUMNS nie ma kierunku). */
async function directionRow(id: string): Promise<{ direction: string; internal_number: string | null } | null> {
  const { data, error } = await admin.from('invoices')
    .select('direction, internal_number')
    .eq('id', id).maybeSingle();
  if (error) throw error;
  return data as { direction: string; internal_number: string | null } | null;
}

async function submissionsOf(invoiceId: string): Promise<Json[]> {
  const { data, error } = await admin.from('ksef_submissions')
    .select(SUBMISSION_COLUMNS).eq('invoice_id', invoiceId).order('attempted_at');
  if (error) throw error;
  return (data ?? []) as Json[];
}

/** Te same wiersze z bazy, w typie parametru polityki TS (sprawdzenie zgodności TS ↔ SQL). */
async function policySubmissions(invoiceId: string): Promise<PolicySubmissions> {
  return (await submissionsOf(invoiceId)) as unknown as PolicySubmissions;
}

async function auditRows(invoiceId: string, action: string): Promise<Array<{ user_id: string | null; details_json: Json }>> {
  const { data, error } = await admin.from('audit_logs')
    .select('user_id, details_json').eq('tenant_id', ORG).eq('entity_id', invoiceId).eq('action', action);
  if (error) throw error;
  return (data ?? []) as Array<{ user_id: string | null; details_json: Json }>;
}

/** Stan, który odmowa ma zostawić bez zmian: wiersz faktury, wpisy prób, audyt. */
async function state(invoiceId: string) {
  const { data: audit, error } = await admin.from('audit_logs').select('action').eq('tenant_id', ORG).eq('entity_id', invoiceId);
  if (error) throw error;
  const submissions = await submissionsOf(invoiceId);
  return {
    invoice: await invoiceRow(invoiceId),
    submissions: [...submissions].sort((a, b) => String(a.id).localeCompare(String(b.id))),
    audit: (audit ?? []).map((a) => a.action as string).sort(),
  };
}

interface DecideArgs {
  p_invoice_id: string;
  p_tenant_id: string;
  p_actor_user_id: string | null;
  p_choice: string;
  p_via: string;
  p_original_ksef_number: string;
  p_original_sha256: string;
  p_env: string;
  p_note: string | null;
}

function decideArgs(p: Pending, over: Partial<DecideArgs> = {}): DecideArgs {
  return {
    p_invoice_id: p.id, p_tenant_id: ORG, p_actor_user_id: ids.owner, p_choice: 'other_sale', p_via: 'client',
    p_original_ksef_number: p.k, p_original_sha256: SHA, p_env: 'test', p_note: null, ...over,
  };
}

function decide(p: Pending, over: Partial<DecideArgs> = {}, client: SupabaseClient = admin) {
  return client.rpc('decide_ksef_duplicate', decideArgs(p, over));
}

async function blocker(invoiceId: string): Promise<string | null> {
  const { data, error } = await admin.rpc('ksef_duplicate_decision_blocker', { p_invoice_id: invoiceId, p_tenant_id: ORG });
  expect(error, `ksef_duplicate_decision_blocker: ${error?.message}`).toBeNull();
  return (data ?? null) as string | null;
}

async function violationsOf(invoiceId: string): Promise<Array<{ invariant: string; detail: Json }>> {
  const { data, error } = await admin.rpc('ksef_lifecycle_violations');
  expect(error).toBeNull();
  return ((data ?? []) as Array<{ invariant: string; invoice_id: string; detail: Json }>)
    .filter((v) => v.invoice_id === invoiceId)
    .map((v) => ({ invariant: v.invariant, detail: v.detail }));
}

type FactsOptions = Parameters<typeof import('@/lib/ksef/duplicate-decision-facts').loadDuplicateDecisionFacts>[4];

/** Werdykt polityki TS na faktach z loadera (klient serwisu, jak operator). */
async function tsVerdict(invoiceId: string, options?: FactsOptions): Promise<string> {
  const { loadDuplicateDecisionFacts } = await import('@/lib/ksef/duplicate-decision-facts');
  const { duplicateDecisionOptions } = await policy();
  const facts = await loadDuplicateDecisionFacts(admin, ORG, invoiceId, undefined, options);
  const view = duplicateDecisionOptions({ facts, actor: 'operator', canManage: true, environment: 'test', now: new Date() });
  return view.kind === 'refused' ? view.refusal : view.kind;
}

async function insertPayment(invoiceId: string, extra: Json = {}): Promise<string> {
  const { data, error } = await admin.from('payments')
    .insert({ tenant_id: ORG, invoice_id: invoiceId, amount: 100, payment_date: '2026-10-03', ...extra })
    .select('id').single();
  if (error) throw new Error(`insert payments: ${error.message}`);
  return data.id as string;
}

async function cleanup() {
  await admin.from('ksef_submissions').delete().eq('tenant_id', ORG);
  await admin.from('payments').delete().eq('tenant_id', ORG);
  // Statusy do szkicu bez pól wysyłki (00119/00122/00132 pozwalają wtedy na DELETE);
  // wyzwalacze 00148 przepuszczają serwis, a status draft → draft ich nie budzi.
  await admin.from('invoices').update({
    ksef_status: 'draft', ksef_send_owner: null, submitted_to_ksef_at: null, last_attempt_at: null,
    ksef_number: null, ksef_accepted_at: null, xml_storage_path: null,
    offline_idempotency_key: null, offline_qr_offline: null, offline_qr_certyfikat: null,
    // Bez ksef_environment: 00117 odmawia serwisowi zmiany ustawionego środowiska,
    // a Y w failed z numerem K je ma — jeden taki wiersz wywróciłby cały UPDATE.
  }).eq('tenant_id', ORG).neq('ksef_status', 'accepted');
  await admin.from('invoices').delete().eq('tenant_id', ORG).eq('invoice_kind', 'correction');
  await admin.from('invoices').delete().eq('tenant_id', ORG).eq('invoice_kind', 'final');
  await admin.from('invoices').delete().eq('tenant_id', ORG);
  await admin.from('audit_logs').delete().eq('tenant_id', ORG);
}

describe.skipIf(!hasDatabase)('D-A4-1b-3 PR B (00148): decyzja klienta przy duplikacie 440 i szkic wycofany', () => {
  beforeAll(async () => {
    ids.owner = await userId(EMAIL.owner);
    ids.admin = await userId(EMAIL.admin);
    ids.member = await userId(EMAIL.member);
    ids.operator = await userId(EMAIL.operator);
    await cleanup();
    await admin.from('memberships').delete().eq('organization_id', ORG);
    await admin.from('tenants').delete().eq('id', ORG);
    const { error: tErr } = await admin.from('tenants').insert({ id: ORG, nip: SELLER, name: 'Firma Decyzja Duplikatu' });
    if (tErr) throw tErr;
    await admin.from('users').upsert([
      { id: ids.owner, name: 'Owner Decyzja' },
      { id: ids.admin, name: 'Admin Decyzja' },
      { id: ids.member, name: 'Member Decyzja' },
      // Operator FaktWay: użytkownik bez członkostwa w firmie (audit_logs.user_id → users).
      { id: ids.operator, name: 'Operator Decyzja' },
    ], { onConflict: 'id' });
    const { error: mErr } = await admin.from('memberships').insert([
      { organization_id: ORG, user_id: ids.owner, role: 'owner', status: 'active' },
      { organization_id: ORG, user_id: ids.admin, role: 'admin', status: 'active' },
      { organization_id: ORG, user_id: ids.member, role: 'member', status: 'active' },
    ]);
    if (mErr) throw mErr;
    owner = await signedIn(EMAIL.owner);
    member = await signedIn(EMAIL.member);
  });

  beforeEach(async () => {
    await cleanup();
  });

  afterAll(async () => {
    if (!hasDatabase) return;
    await cleanup();
    await admin.from('memberships').delete().eq('organization_id', ORG);
    await admin.from('tenants').delete().eq('id', ORG);
  });

  // ─── R1: wyzwalacze szkicu wycofanego ────────────────────────────────────

  describe('R1: szkic wycofany nie wychodzi ze stanu draft, nie znika i nie zmienia numeru z sesji klienta', () => {
    it('R1a: enqueue_ksef_send na szkicu wycofanym („inna sprzedaż”) — P0001 z tekstem z TS, szkic zostaje, bez audytu kolejkowania', async () => {
      const d = await retiredDraft('regular', [{ shape: 'decided', choice: 'other_sale' }]);

      const { error } = await admin.rpc('enqueue_ksef_send', { p_invoice_id: d.id, p_tenant_id: ORG, p_attempt_id: 'proba-r1a' });

      // Dziś enqueue przyjmuje każdy szkic (00131:164-171): faktura w queued i audyt send_enqueued.
      expect(error?.code).toBe('P0001');
      expect((await invoiceRow(d.id))?.ksef_status).toBe('draft');
      expect(await auditRows(d.id, 'invoice.send_enqueued')).toHaveLength(0);

      const { retiredDraftSendRefusal } = await policy();
      expect(error?.message).toBe(retiredDraftSendRefusal(d.number, await policySubmissions(d.id)));
      expect(error?.message).toBe(await sqlText('TRIGGER_OTHER', d.number, d.k));
    });

    it('R1b: claim_ksef_send starej próby na szkicu wycofanym — P0001, szkic bez znacznika przejęcia', async () => {
      const d = await retiredDraft('regular', [{ shape: 'automatic' }]);

      const { data, error } = await admin.rpc('claim_ksef_send', {
        p_invoice_id: d.id, p_tenant_id: ORG, p_owner: 'stara-proba', p_lease_seconds: 900,
      });

      // Dziś przejęcie wygrywa na submitted_to_ksef_at IS NULL (00124:79): znacznik czasu, stan sending.
      expect(error?.code).toBe('P0001');
      expect(data).toBeNull();
      expect(await invoiceRow(d.id)).toMatchObject({ ksef_status: 'draft', submitted_to_ksef_at: null, ksef_send_owner: null });
      const { retiredDraftSendRefusal } = await policy();
      expect(error?.message).toBe(retiredDraftSendRefusal(d.number, await policySubmissions(d.id)));
    });

    it('R1c: zapis porażki (kształt markFailureUnlessAccepted) i akceptacji (save-ksef-number, ze środowiskiem i ksef_accepted_at — C12) — oba P0001', async () => {
      const failedWrite = await retiredDraft('regular', [{ shape: 'automatic' }]);
      const failure = await admin.from('invoices')
        .update({
          ksef_status: 'failed', last_error: 'Faktury nie ma w KSeF', last_error_code: 'NOT_IN_KSEF',
          last_error_field: null, last_error_suggestion: null, ksef_send_owner: null,
        })
        .eq('id', failedWrite.id).eq('tenant_id', ORG)
        .or('ksef_status.is.null,ksef_status.neq.accepted')
        .select('id').maybeSingle();

      const acceptedWrite = await retiredDraft('regular', [{ shape: 'decided', choice: 'same_sale' }]);
      const acceptance = await admin.from('invoices')
        .update({
          ksef_status: 'accepted', ksef_number: ksefNumber(8000 + counter), ksef_environment: 'test',
          ksef_accepted_at: '2026-10-07T10:00:00Z', xml_storage_path: `${ORG}/przyjeta.xml`,
          last_error: null, last_error_code: null, last_error_field: null, last_error_suggestion: null,
        })
        .eq('id', acceptedWrite.id).eq('tenant_id', ORG)
        .select('id').maybeSingle();

      // Dziś serwis przechodzi 00132 (blok stanu dostawy tylko dla klienta), 00073 i 00117
      // (środowisko jest) — oba UPDATE się udają.
      expect(failure.error?.code).toBe('P0001');
      expect(acceptance.error?.code).toBe('P0001');
      expect(await invoiceRow(failedWrite.id)).toMatchObject({ ksef_status: 'draft', last_error_code: null });
      expect(await invoiceRow(acceptedWrite.id)).toMatchObject({ ksef_status: 'draft', ksef_number: null });

      const { retiredDraftSendRefusal } = await policy();
      expect(failure.error?.message).toBe(retiredDraftSendRefusal(failedWrite.number, await policySubmissions(failedWrite.id)));
      expect(acceptance.error?.message).toBe(retiredDraftSendRefusal(acceptedWrite.number, await policySubmissions(acceptedWrite.id)));
    });

    it.each<{ name: string; rows: TakenRow[]; key: SqlTextKey; args: (d: Retired) => string[] }>([
      {
        name: 'ta sama sprzedaż → TRIGGER_SAME',
        rows: [{ shape: 'decided', choice: 'same_sale' }],
        key: 'TRIGGER_SAME', args: (d) => [d.number, d.k],
      },
      {
        name: 'inna sprzedaż → TRIGGER_OTHER',
        rows: [{ shape: 'decided', choice: 'other_sale' }],
        key: 'TRIGGER_OTHER', args: (d) => [d.number, d.k],
      },
      {
        name: 'automatyczny z numerem oryginału → TRIGGER_AUTO „fakturę K”',
        rows: [{ shape: 'automatic' }],
        key: 'TRIGGER_AUTO', args: (d) => [d.number, `fakturę ${d.k}`],
      },
      {
        name: 'tylko wpisy bez numeru oryginału → TRIGGER_AUTO „inną fakturę Twojej firmy”',
        rows: [{ shape: 'unmarked' }, { shape: 'unmarked' }],
        key: 'TRIGGER_AUTO', args: (d) => [d.number, 'inną fakturę Twojej firmy'],
      },
      {
        name: 'automatyczny z K i nowszy bez numeru → tekst z K (wpis z numerem wygrywa, 2.1.4 krok 2)',
        rows: [{ shape: 'automatic', at: '2026-10-02T10:00:00Z' }, { shape: 'unmarked', at: '2026-10-02T10:05:00Z' }],
        key: 'TRIGGER_AUTO', args: (d) => [d.number, `fakturę ${d.k}`],
      },
      {
        name: 'decyzja (K) i nowszy automatyczny (K2) → tekst decyzji z K (decyzja pierwsza)',
        rows: [{ shape: 'decided', choice: 'other_sale', k: 'k', at: '2026-10-02T10:00:00Z' }, { shape: 'automatic', k: 'k2', at: '2026-10-02T10:05:00Z' }],
        key: 'TRIGGER_OTHER', args: (d) => [d.number, d.k],
      },
      {
        name: 'dwa automatyczne → nowszy completed_at (K2)',
        rows: [{ shape: 'automatic', k: 'k', at: '2026-10-02T10:00:00Z' }, { shape: 'automatic', k: 'k2', at: '2026-10-02T10:05:00Z' }],
        key: 'TRIGGER_AUTO', args: (d) => [d.number, `fakturę ${d.k2}`],
      },
    ])('R1d: tekst odmowy przez enqueue — $name; równy retiredDraftSendRefusal', async ({ rows, key, args }) => {
      const d = await retiredDraft('regular', rows);

      const { error } = await admin.rpc('enqueue_ksef_send', { p_invoice_id: d.id, p_tenant_id: ORG, p_attempt_id: 'proba-r1d' });

      expect(error?.code).toBe('P0001');
      expect((await invoiceRow(d.id))?.ksef_status).toBe('draft');
      expect(error?.message).toBe(await sqlText(key, ...args(d)));
      const { retiredDraftSendRefusal } = await policy();
      expect(error?.message).toBe(retiredDraftSendRefusal(d.number, await policySubmissions(d.id)));
    });

    it('R1d: szkic bez numeru wewnętrznego — „(bez numeru)” w tekście wyzwalacza', async () => {
      const id = nextId();
      const k = ksefNumber(counter);
      await insertInvoice(invoiceData(id, null, {}));
      await insertSubmission({
        invoice_id: id, status: 'number_taken', error_code: 'NUMBER_TAKEN', original_ksef_number: k,
        attempted_at: '2026-10-02T10:00:00Z', completed_at: '2026-10-02T10:00:00Z',
      });

      const { error } = await admin.rpc('enqueue_ksef_send', { p_invoice_id: id, p_tenant_id: ORG, p_attempt_id: 'proba-r1d-nr' });

      expect(error?.code).toBe('P0001');
      expect(error?.message).toBe(await sqlText('TRIGGER_AUTO', '(bez numeru)', `fakturę ${k}`));
    });

    it.each<{ name: string; kind: Kind; rows: TakenRow[]; ref: (d: Retired) => string }>([
      { name: 'zwykła, decyzja', kind: 'regular', rows: [{ shape: 'decided', choice: 'other_sale' }], ref: (d) => `faktura ${d.k}` },
      { name: 'zwykła, automatyczny', kind: 'regular', rows: [{ shape: 'automatic' }], ref: (d) => `faktura ${d.k}` },
      { name: 'zaliczka (ZAL), automatyczny', kind: 'advance', rows: [{ shape: 'automatic' }], ref: (d) => `faktura ${d.k}` },
      { name: 'zwykła, tylko bez numeru oryginału', kind: 'regular', rows: [{ shape: 'unmarked' }], ref: () => 'inna faktura Twojej firmy' },
    ])('R1e: właściciel nie usuwa szkicu wycofanego ($name) — P0001 TRIGGER_DELETE = deleteRefusal; wiersz i ślad zostają', async ({ kind, rows, ref }) => {
      const d = await retiredDraft(kind, rows);

      const { data, error } = await owner.from('invoices').delete().eq('id', d.id).select('id');

      // Dziś RLS pozwala usunąć każdy szkic (00002:114-120), a 00132 przepuszcza szkic bez
      // pól wysyłki — wiersz znika razem z wpisami number_taken (ON DELETE CASCADE).
      expect(error?.code).toBe('P0001');
      expect(data ?? []).toEqual([]);
      expect(await invoiceRow(d.id)).not.toBeNull();
      expect((await submissionsOf(d.id)).filter((s) => s.status === 'number_taken')).toHaveLength(rows.length);

      expect(error?.message).toBe(await sqlText('TRIGGER_DELETE', d.number, ref(d)));
      const { retiredDraftView } = await policy();
      const submissions = (await submissionsOf(d.id)) as unknown as ViewSubmissions;
      const view = retiredDraftView({ invoiceNumber: d.number, invoiceKind: kind, submissions, kindHeld: false });
      expect(view?.deletable).toBe(false);
      expect(error?.message).toBe(view?.deleteRefusal);
    });

    it('R1f strażnik: serwis usuwa szkic wycofany zwykłej faktury (operator za zgodą Bartosza)', async () => {
      const d = await retiredDraft('regular', [{ shape: 'decided', choice: 'other_sale' }]);

      const { data, error } = await admin.from('invoices').delete().eq('id', d.id).select('id');

      expect(error).toBeNull();
      expect(data).toHaveLength(1);
      expect(await invoiceRow(d.id)).toBeNull();
    });

    it('R1g strażnik: zwykły szkic — przejęcie, kolejkowanie i usunięcie działają; wycofane KOR i ROZ właściciel usuwa (07.10 (9))', async () => {
      const claimed = await plainDraft();
      const claim = await admin.rpc('claim_ksef_send', { p_invoice_id: claimed.id, p_tenant_id: ORG, p_owner: 'proba-r1g', p_lease_seconds: 900 });
      expect(claim.error).toBeNull();
      expect(claim.data).not.toBeNull();
      expect((await invoiceRow(claimed.id))?.ksef_status).toBe('sending');

      const queued = await plainDraft();
      expect((await admin.rpc('enqueue_ksef_send', { p_invoice_id: queued.id, p_tenant_id: ORG, p_attempt_id: 'proba-r1g' })).error).toBeNull();
      expect((await invoiceRow(queued.id))?.ksef_status).toBe('queued');

      const deleted = await plainDraft();
      const del = await owner.from('invoices').delete().eq('id', deleted.id).select('id');
      expect(del.error).toBeNull();
      expect(del.data).toHaveLength(1);

      for (const kind of ['correction', 'final'] as const) {
        const d = await retiredDraft(kind, [{ shape: 'automatic' }]);
        const res = await owner.from('invoices').delete().eq('id', d.id).select('id');
        expect(res.error, `${kind}: ${res.error?.message}`).toBeNull();
        expect(res.data, kind).toHaveLength(1);
        expect(await invoiceRow(d.id), kind).toBeNull();
      }
    });

    it.each<{ name: string; kind: Kind; rows: TakenRow[] }>([
      { name: 'zwykła, decyzja', kind: 'regular', rows: [{ shape: 'decided', choice: 'other_sale' }] },
      { name: 'zwykła, automatyczny', kind: 'regular', rows: [{ shape: 'automatic' }] },
      { name: 'korekta (KOR), automatyczny', kind: 'correction', rows: [{ shape: 'automatic' }] },
    ])('R1h: właściciel nie zmienia numeru szkicu wycofanego ($name) — P0001 TRIGGER_RENUMBER, numer zostaje', async ({ kind, rows }) => {
      const d = await retiredDraft(kind, rows);

      const { data, error } = await owner.from('invoices')
        .update({ internal_number: `${d.number}-NOWY` }).eq('id', d.id).select('internal_number');

      // Dziś na szkicu bez pól wysyłki nie strzeże nic (00132:77-108, :168-186), RLS pozwala
      // (00002:108-112): numer się zmienia i FV/N wraca do podpowiedzi.
      expect(error?.code).toBe('P0001');
      expect(data ?? []).toEqual([]);
      expect((await invoiceRow(d.id))?.internal_number).toBe(d.number);
      expect(error?.message).toBe(await sqlText('TRIGGER_RENUMBER', d.number, `faktura ${d.k}`));
    });

    it('R1h strażnik: serwis zmienia numer i kierunek szkicu wycofanego; właściciel zmienia uwagi szkicu wycofanego oraz numer i kierunek zwykłego szkicu', async () => {
      const byService = await retiredDraft('regular', [{ shape: 'automatic' }]);
      const service = await admin.from('invoices')
        .update({ internal_number: `${byService.number}-SERWIS` }).eq('id', byService.id).select('internal_number');
      expect(service.error).toBeNull();
      expect(service.data).toEqual([{ internal_number: `${byService.number}-SERWIS` }]);

      // Rewizja PR B #0: wyzwalacz numeru strzeże też kierunku, ale serwis dalej go przechodzi (krok 1).
      const flippedByService = await retiredDraft('regular', [{ shape: 'decided', choice: 'other_sale' }]);
      const serviceDirection = await admin.from('invoices')
        .update({ direction: 'incoming' }).eq('id', flippedByService.id).select('direction');
      expect(serviceDirection.error).toBeNull();
      expect(serviceDirection.data).toEqual([{ direction: 'incoming' }]);

      const notes = await retiredDraft('regular', [{ shape: 'decided', choice: 'other_sale' }]);
      const edit = await owner.from('invoices').update({ notes: 'uwaga do wycofanego szkicu' }).eq('id', notes.id).select('notes');
      expect(edit.error).toBeNull();
      expect(edit.data).toEqual([{ notes: 'uwaga do wycofanego szkicu' }]);

      const plain = await plainDraft();
      const renumber = await owner.from('invoices')
        .update({ internal_number: `${plain.number}-NOWY` }).eq('id', plain.id).select('internal_number');
      expect(renumber.error).toBeNull();
      expect(renumber.data).toEqual([{ internal_number: `${plain.number}-NOWY` }]);

      // Zwykły szkic (bez wpisu number_taken): zmiana kierunku z sesji klienta przechodzi.
      const plainDirection = await plainDraft();
      const flip = await owner.from('invoices')
        .update({ direction: 'incoming' }).eq('id', plainDirection.id).select('direction');
      expect(flip.error).toBeNull();
      expect(flip.data).toEqual([{ direction: 'incoming' }]);
    });

    it.each<{ name: string; rows: TakenRow[] }>([
      { name: 'decyzja', rows: [{ shape: 'decided', choice: 'other_sale' }] },
      { name: 'automatyczny', rows: [{ shape: 'automatic' }] },
    ])('R1i: właściciel nie zmienia kierunku szkicu wycofanego zwykłej faktury na zakupowy ($name) — P0001 TRIGGER_DIRECTION, kierunek i numer zostają', async ({ rows }) => {
      const d = await retiredDraft('regular', rows);

      const { data, error } = await owner.from('invoices')
        .update({ direction: 'incoming' }).eq('id', d.id).select('direction');

      // Dziś (rewizja PR B #0) kierunku szkicu bez pól wysyłki nie strzeże nic: 00132 zamraża
      // treść tylko przy historii dostawy, 00073 — tylko na przyjętej fakturze, a wyzwalacz
      // numeru patrzy tylko na internal_number. PATCH przechodzi i FV/N wypada z indeksu
      // unikalnego numerów sprzedaży (00120), a wyzwalacz usunięcia (WHEN direction) przestaje działać.
      expect(error?.code).toBe('P0001');
      expect(data ?? []).toEqual([]);
      expect(await directionRow(d.id)).toEqual({ direction: 'outgoing', internal_number: d.number });
      expect(error?.message).toBe(await sqlText('TRIGGER_DIRECTION', d.number, `faktura ${d.k}`));
    });

    it('R1i: szkic wycofany z kierunkiem zmienionym przez serwis (dawne obejście) — właściciel go nie usuwa: P0001 TRIGGER_DELETE, wiersz i wpis number_taken zostają', async () => {
      const d = await retiredDraft('regular', [{ shape: 'decided', choice: 'other_sale' }]);
      const flip = await admin.from('invoices').update({ direction: 'incoming' }).eq('id', d.id).select('direction');
      expect(flip.error).toBeNull();
      expect(flip.data).toEqual([{ direction: 'incoming' }]);

      const { data, error } = await owner.from('invoices').delete().eq('id', d.id).select('id');

      // Dziś WHEN wyzwalacza usunięcia wymaga OLD.direction = 'outgoing': szkic znika razem
      // z wpisem number_taken (ON DELETE CASCADE, 00001), a FV/N wraca do podpowiedzi.
      expect(error?.code).toBe('P0001');
      expect(data ?? []).toEqual([]);
      expect(await directionRow(d.id)).toEqual({ direction: 'incoming', internal_number: d.number });
      expect((await submissionsOf(d.id)).filter((s) => s.status === 'number_taken')).toHaveLength(1);
      expect(error?.message).toBe(await sqlText('TRIGGER_DELETE', d.number, `faktura ${d.k}`));
    });
  });

  // ─── R2: skutki decyzji ──────────────────────────────────────────────────

  describe('R2: skutki decyzji w jednej transakcji', () => {
    it('R2 (1): no-own-file, „inna sprzedaż” właściciela — szkic wycofany z numerem, otwarte wpisy number_taken, decyzja na znaczniku bez aktora, prawdziwy poprzedni stan w audycie', async () => {
      const p = await pendingDuplicate({
        rows: [
          { status: 'duplicate', attempted_at: '2026-08-30T10:00:00Z' },
          { status: 'rejected', attempted_at: '2026-08-29T10:00:00Z' },
          // Rewizja PR B #7: starszy otwarty zamiar bez znacznika — skutek (a) zamyka też
          // `intent`; bez tego (b) widziałby dowód kontaktu (00136) i odmawiał EVIDENCE.
          { status: 'intent', attempted_at: '2026-08-28T10:00:00Z' },
        ],
      });
      const [duplicateId, rejectedId, intentId] = p.extraIds;

      const { data, error } = await decide(p);

      // Dziś RPC nie istnieje (PGRST202) — faktura zostaje failed KSEF_DUPLICATE_RECONCILE bez wyjścia klienta.
      expect(error).toBeNull();
      expect(data).toMatchObject({
        invoice_id: p.id, internal_number: p.number, original_ksef_number: p.k, choice: 'other_sale', via: 'client',
        reason: 'no-own-file', already_decided: false, submissions_closed: 4,
      });

      expect(await invoiceRow(p.id)).toMatchObject({
        ksef_status: 'draft', internal_number: p.number, ksef_send_owner: null, submitted_to_ksef_at: null,
        xml_storage_path: null, xml_generated_at: null, last_attempt_at: null, submission_attempts: 0,
        last_error: null, last_error_code: null, last_error_field: null, last_error_suggestion: null,
      });

      const rows = await submissionsOf(p.id);
      const closed = rows.filter((r) => r.status === 'number_taken');
      expect(closed.map((r) => r.id).sort()).toEqual([p.markerId, p.olderId, duplicateId, intentId].sort());
      for (const r of closed) {
        expect(r).toMatchObject({
          error_code: 'NUMBER_TAKEN',
          error_message: `Decyzja klienta: inna sprzedaż — numer ${p.number} zajęty w KSeF przez fakturę ${p.k}`,
        });
        expect(r.completed_at).not.toBeNull();
      }
      expect(rows.find((r) => r.id === rejectedId)?.status).toBe('rejected');

      const marker = rows.find((r) => r.id === p.markerId)!;
      const { decision, ...rest } = marker.original_check as Json & { decision: Json };
      expect(rest).toEqual(p.check);
      expect(decision).toMatchObject({ choice: 'other_sale', via: 'client', reason: 'no-own-file', env: 'test' });
      expect(Object.keys(decision).sort()).toEqual(['at', 'choice', 'env', 'reason', 'via']);
      // Klient czyta original_check (00002:183-186): bez aktora i notatki.
      expect(JSON.stringify(marker.original_check)).not.toContain(ids.owner);
      expect(rows.find((r) => r.id === p.olderId)?.original_check).toBeNull();
      expect(rows.find((r) => r.id === intentId)?.original_check).toBeNull();

      const evidence = await admin.rpc('ksef_has_contact_evidence', { p_invoice_id: p.id, p_tenant_id: ORG });
      expect(evidence.error).toBeNull();
      expect(evidence.data).toBe(false);

      const decided = await auditRows(p.id, 'invoice.ksef_duplicate_decided');
      expect(decided).toHaveLength(1);
      expect(decided[0]!.user_id).toBe(ids.owner);
      const details = decided[0]!.details_json as Json & { retired: Json; previous: Json };
      expect(details).toMatchObject({
        choice: 'other_sale', via: 'client', note: null, env: 'test', reason: 'no-own-file',
        marker_submission_id: p.markerId, submissions_closed: 4,
        original: {
          ksef_number: p.k, session: `SES-ORIG-${p.n}`, sha256: SHA,
          summary: (p.check as Json).summary, acquired_at: (p.check as Json).acquiredAt,
          archive_path: (p.check as Json).archivePath, known_invoice: null, same_content: null,
        },
        retired: { internal_number: p.number, issue_date: '2026-10-01', buyer_nip: BUYER, buyer_name: BUYER_NAME, currency: 'PLN' },
        previous: {
          status: 'failed', code: 'KSEF_DUPLICATE_RECONCILE', error: SEEDED_ERROR, attempts: 6, xml_storage_path: p.xmlPath,
        },
      });
      expect(Number(details.retired.gross_total)).toBe(123);
      expect(new Date(String(details.previous.submitted_to_ksef_at)).toISOString()).toBe(SUBMITTED_AT);
      expect(new Date(String(details.previous.last_attempt_at)).toISOString()).toBe(SUBMITTED_AT);

      const resets = await auditRows(p.id, 'invoice.send_reset');
      expect(resets).toHaveLength(1);
      expect(resets[0]!.user_id).toBe(ids.owner);
      expect(resets[0]!.details_json).toMatchObject({
        previous_status: 'failed', previous_code: 'KSEF_DUPLICATE_RECONCILE', previous_error: SEEDED_ERROR,
        previous_attempts: 6, previous_xml_storage_path: p.xmlPath, via: 'ksef_duplicate_decision',
      });
    });

    it('R2 (2): „ta sama sprzedaż” administratora firmy — szkic wycofany, tekst wpisów i decyzja same_sale', async () => {
      const p = await pendingDuplicate();

      const { data, error } = await decide(p, { p_choice: 'same_sale', p_actor_user_id: ids.admin });

      expect(error).toBeNull();
      expect(data).toMatchObject({ choice: 'same_sale', via: 'client', already_decided: false });
      expect((await invoiceRow(p.id))?.ksef_status).toBe('draft');
      const marker = (await submissionsOf(p.id)).find((r) => r.id === p.markerId)!;
      expect(marker).toMatchObject({
        status: 'number_taken',
        error_message: `Decyzja klienta: ta sama sprzedaż — numer ${p.number} zajęty w KSeF przez fakturę ${p.k}`,
        original_check: { decision: { choice: 'same_sale', via: 'client' } },
      });
      expect((await auditRows(p.id, 'invoice.ksef_duplicate_decided'))[0]?.user_id).toBe(ids.admin);
    });

    it('R2 (3): operator z notatką — decision.via operator, tekst „(zapisał operator)”, notatka tylko w audycie', async () => {
      const p = await pendingDuplicate();

      const { data, error } = await decide(p, { p_via: 'operator', p_note: OPERATOR_NOTE, p_actor_user_id: ids.operator });

      expect(error).toBeNull();
      expect(data).toMatchObject({ via: 'operator', already_decided: false });
      const marker = (await submissionsOf(p.id)).find((r) => r.id === p.markerId)!;
      expect(marker).toMatchObject({
        status: 'number_taken',
        error_message: `Decyzja klienta (zapisał operator): inna sprzedaż — numer ${p.number} zajęty w KSeF przez fakturę ${p.k}`,
        original_check: { decision: { choice: 'other_sale', via: 'operator' } },
      });
      expect(JSON.stringify(marker.original_check)).not.toContain('Jan Kowalski');
      expect(JSON.stringify(marker.original_check)).not.toContain(ids.operator);
      const decided = await auditRows(p.id, 'invoice.ksef_duplicate_decided');
      expect(decided).toHaveLength(1);
      expect(decided[0]).toMatchObject({ user_id: ids.operator, details_json: { via: 'operator', note: OPERATOR_NOTE } });
    });

    it('R2 (4): dane z wcześniejszego udanego sprawdzenia z `recheck` (późniejsze 503) — decyzja przyjęta, recheck zostaje', async () => {
      const recheck = { reason: 'download-pending', httpStatus: 503, checkedAt: '2026-09-03T10:00:00Z' };
      const p = await pendingDuplicate({ checkPatch: { recheck } });

      const { error } = await decide(p);

      expect(error).toBeNull();
      const marker = (await submissionsOf(p.id)).find((r) => r.id === p.markerId)!;
      expect(marker.original_check).toMatchObject({ recheck, decision: { choice: 'other_sale' } });
    });

    it.each<Choice>(['other_sale', 'same_sale'])('R2 (5): known-number (Y przyjęta z K) — %s: te same skutki, audyt z known_invoice, Y bez zmian', async (choice) => {
      const p = await pendingDuplicate({ reason: 'known-number' });
      const yBefore = await invoiceRow(p.yId!);

      const { data, error } = await decide(p, { p_choice: choice });

      expect(error).toBeNull();
      expect(data).toMatchObject({ choice, reason: 'known-number', already_decided: false, submissions_closed: 2 });
      expect(await invoiceRow(p.id)).toMatchObject({ ksef_status: 'draft', internal_number: p.number, last_error_code: null });
      const marker = (await submissionsOf(p.id)).find((r) => r.id === p.markerId)!;
      expect(marker).toMatchObject({ status: 'number_taken', original_check: { reason: 'known-number', decision: { choice, reason: 'known-number' } } });
      const decided = await auditRows(p.id, 'invoice.ksef_duplicate_decided');
      expect(decided).toHaveLength(1);
      expect(decided[0]!.details_json).toMatchObject({
        choice, reason: 'known-number',
        original: { ksef_number: p.k, known_invoice: { id: p.yId, internalNumber: p.yNumber }, same_content: false },
      });
      expect(await invoiceRow(p.yId!)).toEqual(yBefore);
    });
  });

  // ─── R3: odmowy ──────────────────────────────────────────────────────────

  describe('R3: odmowy — kod, tekst z DUPLICATE_DECISION_SQL_TEXTS, stan bez zmian', () => {
    interface RefusalCase {
      name: string;
      setup: () => Promise<Pending>;
      call?: (p: Pending) => PromiseLike<{ error: RpcError }>;
      code: string;
      text?: (p: Pending) => [SqlTextKey, ...string[]];
      contains?: (p: Pending) => string[];
    }

    const refusals: RefusalCase[] = [
      { name: 'anon → 42501', setup: () => pendingDuplicate(), call: (p) => decide(p, {}, anonClient()), code: '42501' },
      { name: 'zalogowany właściciel (authenticated) → 42501', setup: () => pendingDuplicate(), call: (p) => decide(p, {}, owner), code: '42501' },
      {
        name: 'członek (member) jako aktor klienta → 42501 ROLE', setup: () => pendingDuplicate(),
        call: (p) => decide(p, { p_actor_user_id: ids.member }), code: '42501', text: () => ['ROLE'],
      },
      {
        name: 'operator z notatką „ok” → 22023 NOTE', setup: () => pendingDuplicate(),
        call: (p) => decide(p, { p_via: 'operator', p_note: 'ok', p_actor_user_id: ids.operator }), code: '22023', text: () => ['NOTE'],
      },
      {
        name: 'faktura w kolejce (queued) → IN_FLIGHT', setup: () => pendingDuplicate({ patch: { ksef_status: 'queued' } }),
        code: 'P0001', text: (p) => ['IN_FLIGHT', p.number],
      },
      {
        name: 'kod RESULT_UNCERTAIN → not-pending', setup: () => pendingDuplicate({ patch: { last_error_code: 'RESULT_UNCERTAIN' } }),
        code: 'P0001', text: (p) => ['not-pending', p.number],
      },
      {
        name: 'faktura z numerem KSeF → in-ksef', setup: () => pendingDuplicate({ patch: { ksef_number: ksefNumber(9000 + counter + 1) } }),
        code: 'P0001', text: (p) => ['in-ksef', p.number],
      },
      {
        name: 'zaliczka (invoice_kind advance) → kind', setup: () => pendingDuplicate({ kind: 'advance' }),
        code: 'P0001', text: (p) => ['kind', p.number],
      },
      {
        name: 'Offline24 (offline_idempotency_key) → offline',
        setup: () => pendingDuplicate({ patch: { offline_idempotency_key: `offline-decyzja-${counter + 1}` } }),
        code: 'P0001', text: (p) => ['offline', p.number],
      },
      {
        name: 'brak znacznika 440 → no-marker', setup: () => pendingDuplicate({ marker: false }),
        code: 'P0001', text: (p) => ['no-marker', p.number],
      },
      {
        name: 'drugi wpis z innym numerem oryginału → conflicting-originals',
        setup: () => pendingDuplicate({ rows: [{ status: 'rejected', original_ksef_number: ksefNumber(6000 + counter + 1) }] }),
        code: 'P0001', text: (p) => ['conflicting-originals', p.number],
      },
      {
        name: 'original_check NULL (znacznik sprzed 00144) → no-check', setup: () => pendingDuplicate({ check: null }),
        code: 'P0001', text: (p) => ['no-check', p.number],
      },
      // PR C (00156, spec 7.4): faktflow-original z SystemInfo FaktFlow (F28) bez importGate przechodzi `allows`
      // (4.2) i dostaje blokadę recheck-needed (4.5 krok 11c) — nie `reason`. Dwa pozostałe powody bez zmian.
      {
        name: 'faktflow-original bez importGate (sprzed 00156) → recheck-needed', setup: () => pendingDuplicate({ reason: 'faktflow-original' }),
        code: 'P0001', text: (p) => ['recheck-needed', p.number],
      },
      ...(['same-content-other-program', 'download-refused'] as const).map((reason): RefusalCase => ({
        name: `powód ${reason} → reason`, setup: () => pendingDuplicate({ reason }),
        code: 'P0001', text: (p) => ['reason', p.number],
      })),
      {
        name: 'known-number bez danych oryginału (kształt PR A) → reason',
        setup: () => pendingDuplicate({ reason: 'known-number', check: 'pr-a' }),
        code: 'P0001', text: (p) => ['reason', p.number],
      },
      {
        name: 'ownHistory true → reason', setup: () => pendingDuplicate({ checkPatch: { ownHistory: true } }),
        code: 'P0001', text: (p) => ['reason', p.number],
      },
      {
        name: 'known-stale: Y przyjęta, ale bez numeru KSeF',
        setup: () => pendingDuplicate({ reason: 'known-number', yHoldsOriginal: false }),
        code: 'P0001', text: (p) => ['known-stale', p.k, p.number],
      },
      {
        name: 'known-stale: knownInvoice.id nie jest UUID',
        setup: () => pendingDuplicate({ reason: 'known-number', known: false, knownInvoiceId: 'nie-uuid' }),
        code: 'P0001', text: (p) => ['known-stale', p.k, p.number],
      },
      {
        name: 'known-stale: Y w failed z numerem K (I9; uwaga 1 sprawdzenia)',
        setup: () => pendingDuplicate({ reason: 'known-number', yStatus: 'failed' }),
        code: 'P0001', text: (p) => ['known-stale', p.k, p.number],
      },
      {
        name: 'own-history: wpis faktury z sesją oryginału (SES-ORIG-n)',
        setup: async () => {
          const p = await pendingDuplicate();
          await insertSubmission({
            invoice_id: p.id, status: 'abandoned', session_reference_number: `SES-ORIG-${p.n}`,
            attempted_at: '2026-08-28T10:00:00Z',
          });
          return p;
        },
        code: 'P0001', text: (p) => ['own-history', p.k, p.number],
      },
      {
        name: 'own-history: wpis faktury z plikiem oryginału (skrót wielkimi literami — lower())',
        setup: () => pendingDuplicate({ rows: [{ status: 'abandoned', request_payload_hash: SHA.toUpperCase() }] }),
        code: 'P0001', text: (p) => ['own-history', p.k, p.number],
      },
      {
        name: 'paid_amount bez wiersza wpłaty → payments', setup: () => pendingDuplicate({ patch: { paid_amount: 100 } }),
        code: 'P0001', text: (p) => ['payments', p.number], contains: (p) => [p.number, 'pomoc@faktway.pl'],
      },
      {
        name: 'inny numer KSeF oryginału niż pokazany → STALE', setup: () => pendingDuplicate(),
        call: (p) => decide(p, { p_original_ksef_number: ksefNumber(9999) }), code: 'P0001', text: (p) => ['STALE', p.number],
      },
      {
        name: 'inny skrót danych niż pokazany → STALE', setup: () => pendingDuplicate(),
        call: (p) => decide(p, { p_original_sha256: 'cc'.repeat(32) }), code: 'P0001', text: (p) => ['STALE', p.number],
      },
      {
        name: 'dane z produkcji, serwer w test → ENV', setup: () => pendingDuplicate({ checkPatch: { env: 'production' } }),
        code: 'P0001', text: (p) => ['ENV', p.k, ENV_LABEL.production, ENV_LABEL.test, p.number],
        contains: () => ['„produkcyjne”', '„testowe”'],
      },
    ];

    it.each(refusals)('R3: $name', async ({ setup, call, code, text, contains }) => {
      const p = await setup();
      const before = await state(p.id);

      const { error } = await (call ? call(p) : decide(p));

      // Dziś: PGRST202 (RPC nie istnieje).
      expect(error?.code, error?.message).toBe(code);
      expect(await state(p.id)).toEqual(before);
      if (p.markerId) {
        const marker = before.submissions.find((s) => s.id === p.markerId);
        expect(marker?.status).toBe('sent');
        expect(marker?.original_check ?? {}).not.toHaveProperty('decision');
      }
      for (const fragment of contains?.(p) ?? []) expect(error?.message).toContain(fragment);
      if (text) {
        const [key, ...args] = text(p);
        expect(error?.message).toBe(await sqlText(key, ...args));
      }
    });

    it('R3: wpis wpłaty (niepotwierdzone dopasowanie, paid_amount 0) → payments z numerem dokumentu i pomoc@faktway.pl (C13, marka od 00151); wpłata nietknięta', async () => {
      const p = await pendingDuplicate();
      const paymentId = await insertPayment(p.id, { is_auto_matched: true, is_confirmed: false });
      const paymentBefore = await admin.from('payments').select('id, invoice_id, amount, is_confirmed').eq('id', paymentId).single();
      expect(Number((await admin.from('invoices').select('paid_amount').eq('id', p.id).single()).data?.paid_amount)).toBe(0);
      const before = await state(p.id);

      const { error } = await decide(p);

      expect(error?.code).toBe('P0001');
      expect(error?.message).toContain(p.number);
      expect(error?.message).toContain('pomoc@faktway.pl');
      expect(error?.message).not.toMatch(/faktflow/i);
      expect(await state(p.id)).toEqual(before);
      const paymentAfter = await admin.from('payments').select('id, invoice_id, amount, is_confirmed').eq('id', paymentId).single();
      expect(paymentAfter.data).toEqual(paymentBefore.data);
      expect(error?.message).toBe(await sqlText('payments', p.number));
    });

    it('R3: znacznik no-own-file z nieaktualnym knownInvoice NIE jest known-stale (C2) — decyzja przechodzi', async () => {
      const p = await pendingDuplicate({ knownInvoiceId: '1313ffff-0000-4000-8000-000000000001' });
      expect((p.check as Json).knownInvoice).toMatchObject({ id: '1313ffff-0000-4000-8000-000000000001' });

      const { data, error } = await decide(p);

      expect(error).toBeNull();
      expect(data).toMatchObject({ reason: 'no-own-file', already_decided: false });
      expect((await invoiceRow(p.id))?.ksef_status).toBe('draft');
    });

    it.each<{ name: string; over: (p: Pending) => Partial<DecideArgs> }>([
      { name: 'wybór spoza listy', over: () => ({ p_choice: 'moze' }) },
      { name: 'p_via spoza listy', over: () => ({ p_via: 'cron' }) },
      { name: 'pusty numer KSeF', over: () => ({ p_original_ksef_number: '   ' }) },
      { name: 'skrót nie-hex', over: () => ({ p_original_sha256: 'xyz' }) },
      { name: 'skrót wielkimi literami', over: () => ({ p_original_sha256: SHA.toUpperCase() }) },
      { name: 'aktor NULL', over: () => ({ p_actor_user_id: null }) },
      { name: 'p_env spoza listy', over: () => ({ p_env: 'staging' }) },
      { name: 'notatka dłuższa niż 1000 znaków', over: () => ({ p_via: 'operator', p_actor_user_id: ids.operator, p_note: 'x'.repeat(1001) }) },
    ])('R3: argument techniczny ($name) → 22023, stan bez zmian', async ({ over }) => {
      const p = await pendingDuplicate();
      const before = await state(p.id);

      const { error } = await decide(p, over(p));

      expect(error?.code, error?.message).toBe('22023');
      expect(await state(p.id)).toEqual(before);
    });
  });

  // ─── R4: powtórzenie ─────────────────────────────────────────────────────

  describe('R4: powtórzenie od zera', () => {
    it('R4: ta sama decyzja drugi raz = already_decided bez zapisów; inna — ALREADY; po usunięciu szkicu przez serwis — P0002', async () => {
      const p = await pendingDuplicate();
      expect((await decide(p)).error).toBeNull();
      const afterFirst = await state(p.id);

      const again = await decide(p);

      expect(again.error).toBeNull();
      expect(again.data).toMatchObject({ invoice_id: p.id, original_ksef_number: p.k, choice: 'other_sale', already_decided: true });
      expect(await state(p.id)).toEqual(afterFirst);
      expect(await auditRows(p.id, 'invoice.ksef_duplicate_decided')).toHaveLength(1);
      expect((await auditRows(p.id, 'invoice.send_reset')).filter((r) => r.details_json?.via === 'ksef_duplicate_decision')).toHaveLength(1);

      const other = await decide(p, { p_choice: 'same_sale' });
      expect(other.error?.code).toBe('P0001');
      expect(other.error?.message).toBe(await sqlText('ALREADY', p.number, 'inna sprzedaż'));
      expect(await state(p.id)).toEqual(afterFirst);

      // Wycofany szkic nie wraca do kolejki trybem „tylko uzgodnij” (00131:279-282).
      const requeue = await admin.rpc('requeue_ksef_send', {
        p_invoice_id: p.id, p_tenant_id: ORG, p_attempt_id: 'proba-r4', p_actor_user_id: null, p_reconcile_only: true,
      });
      expect(requeue.error?.code).toBe('P0001');

      const removed = await admin.from('invoices').delete().eq('id', p.id).select('id');
      expect(removed.error).toBeNull();
      expect(removed.data).toHaveLength(1);
      const gone = await decide(p);
      expect(gone.error?.code).toBe('P0002');
    });

    it('R4 strażnik: requeue_ksef_send(p_reconcile_only) na szkicu wycofanym — P0001, szkic zostaje', async () => {
      const d = await retiredDraft('regular', [{ shape: 'automatic' }]);

      const { error } = await admin.rpc('requeue_ksef_send', {
        p_invoice_id: d.id, p_tenant_id: ORG, p_attempt_id: 'proba-r4s', p_actor_user_id: null, p_reconcile_only: true,
      });

      expect(error?.code).toBe('P0001');
      expect((await invoiceRow(d.id))?.ksef_status).toBe('draft');
    });
  });

  // ─── R5: I5 / I5D ────────────────────────────────────────────────────────

  describe('R5: I5D „czeka na klienta” zamiast I5; blokada = polityka TS', () => {
    it.each<Reason>(['no-own-file', 'known-number'])('R5 (1): %s gotowa do decyzji, znacznik z 2026-09-01 — jeden wiersz I5D, bez I5; blokada NULL; TS decidable', async (reason) => {
      const p = await pendingDuplicate({ reason });

      const violations = await violationsOf(p.id);

      // Dziś I5 zgłasza każdy otwarty wpis starszy niż 48 h (00136:118-127), I5D nie istnieje.
      expect(violations.map((v) => v.invariant)).toEqual(['I5D']);
      expect(violations[0]!.detail).toMatchObject({ original_ksef_number: p.k, reason, env: 'test', checked_at: '2026-09-01T10:05:00Z' });
      expect(new Date(String(violations[0]!.detail.attempted_at)).toISOString()).toBe(MARKER_AT);
      expect(new Date(String(violations[0]!.detail.last_attempt_at)).toISOString()).toBe(SUBMITTED_AT);
      expect(await blocker(p.id)).toBeNull();
      expect(await tsVerdict(p.id)).toBe('decidable');
    });

    it('R5 (2): świeży znacznik (minuta temu) — I5D od pierwszej minuty, bez I5', async () => {
      const p = await pendingDuplicate({ markerAt: new Date(Date.now() - 60_000).toISOString() });

      const violations = await violationsOf(p.id);

      expect(violations.map((v) => v.invariant)).toEqual(['I5D']);
      expect(await blocker(p.id)).toBeNull();
      expect(await tsVerdict(p.id)).toBe('decidable');
    });

    it.each<{ name: string; setup: () => Promise<Pending>; code: string }>([
      {
        name: 'wpłata (paid_amount z potwierdzonej wpłaty)', code: 'payments',
        setup: async () => {
          const p = await pendingDuplicate();
          await insertPayment(p.id);
          return p;
        },
      },
      { name: 'zaliczka', code: 'kind', setup: () => pendingDuplicate({ kind: 'advance' }) },
      // PR C (00156, spec 7.4): intencja bez zmian (I5, bez I5D), kod recheck-needed — znacznik bez importGate (4.5 krok 11c).
      { name: 'faktflow-original', code: 'recheck-needed', setup: () => pendingDuplicate({ reason: 'faktflow-original' }) },
      { name: 'original_check NULL', code: 'no-check', setup: () => pendingDuplicate({ check: null }) },
      {
        name: 'drugi oryginał (inny K)', code: 'conflicting-originals',
        setup: () => pendingDuplicate({ rows: [{ status: 'rejected', original_ksef_number: ksefNumber(6500 + counter + 1) }] }),
      },
      { name: 'known-stale: Y bez numeru KSeF', code: 'known-stale', setup: () => pendingDuplicate({ reason: 'known-number', yHoldsOriginal: false }) },
      { name: 'known-stale: Y w failed z K', code: 'known-stale', setup: () => pendingDuplicate({ reason: 'known-number', yStatus: 'failed' }) },
    ])('R5 (3)(4): klient nie zdecyduje ($name) — zostaje I5 (stary znacznik), bez I5D; blokada $code = odmowa TS', async ({ setup, code }) => {
      const p = await setup();

      const invariants = (await violationsOf(p.id)).map((v) => v.invariant);

      expect(invariants).toContain('I5');
      expect(invariants).not.toContain('I5D');
      expect(await blocker(p.id)).toBe(code);
      // PR C (5.4, 5.5 krok 1): przy znaczniku faktflow-original polityka TS wymaga odczytanej blokady SQL
      // (bez niej state-unknown) — dla tego wiersza ładowarka czyta ją kluczem serwisowym; recheck-needed
      // TS i tak liczy sam z JSON (lustro 11c). Powody PR B bez zmian (bez odczytu blokady).
      expect(await tsVerdict(p.id, code === 'recheck-needed' ? { sqlBlocker: 'admin' } : undefined)).toBe(code);
    });

    it('R5 strażnik: RESULT_UNCERTAIN ze starym wpisem sent — I5, nie I5D', async () => {
      const id = nextId();
      await insertInvoice(invoiceData(id, `FV/NIEPEWNA/${counter}`, { ksef_status: 'failed', last_error_code: 'RESULT_UNCERTAIN' }));
      await insertSubmission({ invoice_id: id, status: 'sent', session_reference_number: `SES-NIEPEWNA-${counter}`, attempted_at: MARKER_AT });

      const invariants = (await violationsOf(id)).map((v) => v.invariant);

      expect(invariants).toEqual(['I5']);
    });
  });

  // ─── R6: zgodność jsonb ──────────────────────────────────────────────────

  it('R6: ksef_duplicate_check_allows = duplicateCheckAllows = oczekiwanie wspólnej tabeli (każdy wiersz)', async () => {
    // PR C: R6 zostaje strażnikiem PR B — iteruje tabelę bez wierszy `faktflow-original`, bo SQL 00148 i polityka
    // TS dopuszczają je dopiero po 00156 i implementacji grupy B; pełną tabelę (R-C15) sprawdza `rls-zapis-oryginalu`.
    const { PR_B_DUPLICATE_CHECK_CASES: DUPLICATE_CHECK_CASES } = await import('./unit/helpers/ksef-duplicate-decision-cases');
    expect(DUPLICATE_CHECK_CASES.length).toBeGreaterThan(0);

    const sql: Array<{ name: string; sql: unknown; error: string | null; allows: boolean }> = [];
    for (const c of DUPLICATE_CHECK_CASES) {
      const { data, error } = await admin.rpc('ksef_duplicate_check_allows', { p_check: c.check ?? null, p_choice: c.choice });
      sql.push({ name: c.name, sql: data, error: error ? `${error.code}: ${error.message}` : null, allows: c.allows });
    }
    // Dziś: PGRST202 dla każdego wiersza (funkcja nie istnieje).
    expect(sql.filter((r) => r.error !== null || r.sql !== r.allows)).toEqual([]);

    // TS na tym, co faktycznie dotarło do bazy (JSON): przypadki nie mogą zależeć od undefined ani 1.0.
    const { duplicateCheckAllows } = await policy();
    const ts = DUPLICATE_CHECK_CASES.map((c) => ({
      name: c.name,
      ts: duplicateCheckAllows(JSON.parse(JSON.stringify(c.check ?? null)) as unknown, c.choice),
      allows: c.allows,
    }));
    expect(ts.filter((r) => r.ts !== r.allows)).toEqual([]);
  });

  // ─── R7: uprawnienia ─────────────────────────────────────────────────────

  it('R7: anon i zalogowani (właściciel, członek) dostają 42501 na trzech nowych funkcjach; serwis je wywołuje', async () => {
    const p = await pendingDuplicate();
    const before = await state(p.id);
    const calls: Array<[string, Json]> = [
      ['decide_ksef_duplicate', { ...decideArgs(p) }],
      ['ksef_duplicate_decision_blocker', { p_invoice_id: p.id, p_tenant_id: ORG }],
      ['ksef_duplicate_check_allows', { p_check: p.check, p_choice: null }],
    ];

    const results: Array<{ who: string; fn: string; code: string | null }> = [];
    for (const [who, client] of [['anon', anonClient()], ['właściciel', owner], ['członek', member]] as const) {
      for (const [fn, args] of calls) {
        const { error } = await client.rpc(fn, args);
        results.push({ who, fn, code: error?.code ?? null });
      }
    }

    // Dziś: PGRST202 (funkcje nie istnieją), nie 42501.
    expect(results.filter((r) => r.code !== '42501')).toEqual([]);
    expect(await state(p.id)).toEqual(before);
    const allows = await admin.rpc('ksef_duplicate_check_allows', { p_check: p.check, p_choice: null });
    expect(allows.error).toBeNull();
    expect(allows.data).toBe(true);
    expect(await blocker(p.id)).toBeNull();
  });
});

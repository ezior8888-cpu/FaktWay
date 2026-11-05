/**
 * Panel operatora `/admin/ksef` — dane cyklu życia faktury (PR 3c).
 *
 * Czyta kluczem serwisowym, dlatego każda funkcja najpierw `requireAdmin()`
 * (wzorzec `lib/admin/support.ts`). Źródła: `ksef_lifecycle_violations()`
 * (strażnik I1–I5, I9 z 00131; I5D „czeka na klienta” z 00148), `invoices`
 * po kodzie z katalogu `ksef_error_codes`, historia `ksef_submissions`,
 * ślad w `audit_logs`.
 */

import { hasOpenSubmission, type DuplicateNoticeSummary, type OperatorRecordable } from '@/lib/admin/ksef-operator-policy';
import { requireAdmin } from '@/lib/auth/admin-guard';
import { KSEF_RESEND_SOURCE_COLUMNS, ksefResendFacts, type KsefResendFacts } from '@/lib/invoices/ksef-requeue-event';
import { configuredKsefEnvironment } from '@/lib/ksef/claim-environment';
import {
  DUPLICATE_DECISION_MODES,
  DUPLICATE_ORIGINAL_OFFERS,
  parseDuplicateCheck,
  type DuplicateDecisionMode,
  type DuplicateOriginalOffer,
  type KsefDuplicateCheck,
} from '@/lib/ksef/duplicate-check';
import { duplicateDecisionOptions, duplicateMarker, type DuplicateDecisionView } from '@/lib/ksef/duplicate-decision';
import { loadDuplicateDecisionFacts } from '@/lib/ksef/duplicate-decision-facts';
import { findDuplicateNotices } from '@/lib/ksef/duplicate-decision-notice';
import { prepareOriginalImport } from '@/lib/ksef/duplicate-original-import';
import { sendErrorClassOf, type SendErrorClass } from '@/lib/ksef/send-error-classes';
import { createAdminClient } from '@/lib/supabase/admin';
import type { Json } from '@/types/database';
import type { KsefEnvironment } from '@/types/ksef';

/** Wartość filtra `?code=` dla faktur bez kodu (historycznych). */
export const NO_CODE_FILTER = 'brak';

export const INVARIANT_LABELS: Record<string, string> = {
  I1: 'queued bez zlecenia w pg-boss (ponad 15 min)',
  I2: 'sending dłużej niż dzierżawa (ponad 30 min) albo bez znacznika przejęcia',
  // 00155 (decyzja Bartosza 22.10.2026): UPO wymagane tylko, gdy `ksef_upo_expected`.
  I3: 'accepted bez numeru KSeF, środowiska, pliku XML albo UPO (UPO tylko dla faktur wysłanych z FaktWay)',
  I4: 'failed / rejected bez kodu z katalogu albo z trzymanym przejęciem',
  // 00156 (PR C): dopisek — faktflow-original bez oceny pliku albo do ponownego sprawdzenia też stoi w I5, a cron sam robi nowy werdykt.
  I5: 'otwarty wpis sent albo zamiar intent starszy niż 48 h, w tym faktflow-original bez oceny pliku albo do ponownego sprawdzenia (recheck-needed) — cron sam robi nowy werdykt',
  I9: 'failed / rejected z numerem KSeF (stan sprzeczny)',
  // 00148 (D-A4-1b-3 PR B, decyzja 4): stan, nie naruszenie — osobno w raporcie i w /admin/ksef.
  I5D: 'czeka na decyzję klienta: nierozstrzygnięty 440 z danymi oryginału (no-own-file, known-number, faktflow-original z oceną pliku) — bez automatu i bez alarmu; e-mail idzie raz i nie jest ponawiany; gdy nie doszedł — operator: „Przypomnij klientowi”',
  // 00156 (D-A4-1b-3 PR C, spec v3 6.6): naruszenia (KPI i „Naruszenia strażnika”), nie I5D.
  I5R: 'przegląd pliku z oznaczeniem FaktWay przez operatora (faktflow-original z oceną review) — klient czeka na „damy znać”; alarm krytyczny po 72 h od ostatniego sprawdzenia',
  I3K: 'faktura zapisana z KSeF decyzją bez sesji UPO albo bez daty nadania — UPO ręcznie albo skrypt daty (runbook)',
};

/** Wiersz `ksef_lifecycle_violations()` „faktura czeka na decyzję klienta” (00148). */
export const CLIENT_DECISION_INVARIANT = 'I5D';

/**
 * Naruszenia strażnika bez I5D i faktury czekające na decyzję klienta (I5D) —
 * osobno: I5D to stan (klient decyduje; e-mail idzie raz i nie jest
 * ponawiany), nie praca operatora od razu. Wyjątek — faktura, o której
 * klient nie dostał powiadomienia (tabela I5D: „nie”): operator, „Przypomnij
 * klientowi”.
 */
export function splitClientDecisionPending<T extends { invariant: string }>(
  rows: readonly T[],
): { violations: T[]; clientPending: T[] } {
  const violations: T[] = [];
  const clientPending: T[] = [];
  for (const row of rows) (row.invariant === CLIENT_DECISION_INVARIANT ? clientPending : violations).push(row);
  return { violations, clientPending };
}

export interface ClientDecisionRow {
  invoiceId: string;
  tenantName: string | null;
  internalNumber: string | null;
  originalKsefNumber: string | null;
  reason: string | null;
  /** `original_check.env` — środowisko KSeF, w którym sprawdzono oryginał. */
  env: string | null;
  /** `false` — klient nie zapisze decyzji w tym środowisku (alarm I5D-env). */
  envMatches: boolean;
  attemptedAt: string | null;
}

const detailString = (detail: unknown, key: string): string | null => {
  if (typeof detail !== 'object' || detail === null || Array.isArray(detail)) return null;
  const value = (detail as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
};

/** Tabela I5D w `/admin/ksef` z `detail` wiersza strażnika; nieznane środowisko aplikacji = nic się nie zgadza. */
export function clientDecisionRows(
  rows: ReadonlyArray<{ invoiceId: string; tenantName: string | null; internalNumber: string | null; detail: unknown }>,
  environment: KsefEnvironment | null,
): ClientDecisionRow[] {
  return rows.map((r) => {
    const env = detailString(r.detail, 'env');
    return {
      invoiceId: r.invoiceId,
      tenantName: r.tenantName,
      internalNumber: r.internalNumber,
      originalKsefNumber: detailString(r.detail, 'original_ksef_number'),
      reason: detailString(r.detail, 'reason'),
      env,
      envMatches: environment !== null && env === environment,
      attemptedAt: detailString(r.detail, 'attempted_at'),
    };
  });
}

export interface ViolationSummary {
  invariant: string;
  label: string;
  count: number;
}

/** Zliczenie naruszeń per inwariant — czysta funkcja do testów. */
export function summarizeViolations(rows: ReadonlyArray<{ invariant: string }>): ViolationSummary[] {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.invariant, (counts.get(row.invariant) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([invariant, count]) => ({ invariant, label: INVARIANT_LABELS[invariant] ?? invariant, count }));
}

export interface CodeCount {
  /** Kod z katalogu albo `NO_CODE_FILTER` dla braku kodu. */
  code: string;
  errorClass: SendErrorClass | null;
  failed: number;
  rejected: number;
  total: number;
}

/** Faktury failed/rejected per kod — czysta funkcja do testów; PostgREST nie ma GROUP BY. */
export function countByCode(
  rows: ReadonlyArray<{ last_error_code: string | null; ksef_status: string | null }>,
): CodeCount[] {
  const counts = new Map<string, CodeCount>();
  for (const row of rows) {
    const code = row.last_error_code ?? NO_CODE_FILTER;
    const entry = counts.get(code) ?? { code, errorClass: sendErrorClassOf(row.last_error_code), failed: 0, rejected: 0, total: 0 };
    if (row.ksef_status === 'rejected') entry.rejected += 1;
    else entry.failed += 1;
    entry.total += 1;
    counts.set(code, entry);
  }
  return [...counts.values()].sort((a, b) => b.total - a.total || a.code.localeCompare(b.code));
}

type TenantEmbed = { name: string | null; nip: string | null } | { name: string | null; nip: string | null }[] | null;

function tenantOf(embed: TenantEmbed): { name: string | null; nip: string | null } {
  const t = Array.isArray(embed) ? embed[0] : embed;
  return { name: t?.name ?? null, nip: t?.nip ?? null };
}

/** Wiersz z `ksef_lifecycle_violations()` (RETURNS TABLE, bez argumentów). */
interface ViolationRow {
  invariant: string;
  invoice_id: string;
  tenant_id: string;
  detail: Json;
}

export interface LifecycleViolation {
  invariant: string;
  label: string;
  invoiceId: string;
  tenantId: string;
  tenantName: string | null;
  internalNumber: string | null;
  ksefStatus: string | null;
  detail: Json;
}

export async function listLifecycleViolations(): Promise<LifecycleViolation[]> {
  await requireAdmin();
  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc('ksef_lifecycle_violations');
  if (error) throw new Error(`ksef_lifecycle_violations: ${error.message}`);
  const rows = (data ?? []) as ViolationRow[];
  if (rows.length === 0) return [];

  const ids = [...new Set(rows.map((r) => r.invoice_id))];
  const { data: invoices, error: invoicesError } = await supabase
    .from('invoices')
    .select('id, internal_number, ksef_status, tenants(name, nip)')
    .in('id', ids);
  if (invoicesError) throw new Error(`invoices lookup: ${invoicesError.message}`);
  type InvoiceRow = { id: string; internal_number: string | null; ksef_status: string | null; tenants: TenantEmbed };
  const byId = new Map(((invoices ?? []) as InvoiceRow[]).map((i) => [i.id, i]));

  return rows.map((r) => {
    const inv = byId.get(r.invoice_id);
    return {
      invariant: r.invariant,
      label: INVARIANT_LABELS[r.invariant] ?? r.invariant,
      invoiceId: r.invoice_id,
      tenantId: r.tenant_id,
      tenantName: inv ? tenantOf(inv.tenants).name : null,
      internalNumber: inv?.internal_number ?? null,
      ksefStatus: inv?.ksef_status ?? null,
      detail: r.detail,
    };
  });
}

/** Naruszenia strażnika na KPI panelu — BEZ I5D (faktury czekające na decyzję klienta, 00148). */
export async function countLifecycleViolations(): Promise<number> {
  await requireAdmin();
  const { data, error } = await createAdminClient().rpc('ksef_lifecycle_violations');
  if (error) throw new Error(`ksef_lifecycle_violations: ${error.message}`);
  return splitClientDecisionPending(data ?? []).violations.length;
}

export interface FailedInvoiceRow {
  id: string;
  tenantId: string;
  tenantName: string | null;
  tenantNip: string | null;
  internalNumber: string | null;
  ksefStatus: string | null;
  errorCode: string | null;
  errorClass: SendErrorClass | null;
  lastError: string | null;
  sendOwner: string | null;
  updatedAt: string | null;
}

export async function listFailedInvoices(options: { code?: string | null; limit?: number } = {}): Promise<{
  rows: FailedInvoiceRow[];
  counts: CodeCount[];
}> {
  await requireAdmin();
  const supabase = createAdminClient();

  const { data: all, error: allError } = await supabase
    .from('invoices')
    .select('last_error_code, ksef_status')
    .eq('direction', 'outgoing')
    .in('ksef_status', ['failed', 'rejected'])
    .limit(5000);
  if (allError) throw new Error(`invoices counts: ${allError.message}`);
  const counts = countByCode(all ?? []);

  let query = supabase
    .from('invoices')
    .select('id, tenant_id, internal_number, ksef_status, last_error_code, last_error, ksef_send_owner, updated_at, tenants(name, nip)')
    .eq('direction', 'outgoing')
    .in('ksef_status', ['failed', 'rejected'])
    .order('updated_at', { ascending: false })
    .limit(options.limit ?? 100);
  if (options.code === NO_CODE_FILTER) query = query.is('last_error_code', null);
  else if (options.code) query = query.eq('last_error_code', options.code);

  const { data, error } = await query;
  if (error) throw new Error(`invoices failed list: ${error.message}`);
  type Row = {
    id: string; tenant_id: string; internal_number: string | null; ksef_status: string | null;
    last_error_code: string | null; last_error: string | null; ksef_send_owner: string | null;
    updated_at: string | null; tenants: TenantEmbed;
  };
  const rows = ((data ?? []) as Row[]).map((row) => {
    const tenant = tenantOf(row.tenants);
    return {
      id: row.id,
      tenantId: row.tenant_id,
      tenantName: tenant.name,
      tenantNip: tenant.nip,
      internalNumber: row.internal_number,
      ksefStatus: row.ksef_status,
      errorCode: row.last_error_code,
      errorClass: sendErrorClassOf(row.last_error_code),
      lastError: row.last_error,
      sendOwner: row.ksef_send_owner,
      updatedAt: row.updated_at,
    };
  });
  return { rows, counts };
}

export interface SubmissionHistoryRow {
  id: string;
  status: string | null;
  sessionReferenceNumber: string | null;
  invoiceReferenceNumber: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  attemptedAt: string | null;
  completedAt: string | null;
  /** Znacznik 440 (00142): numer KSeF oryginału. */
  originalKsefNumber: string | null;
  /** D-A4-1b-3 (00144): dane oryginału przy nierozstrzygniętym 440. */
  originalCheck: KsefDuplicateCheck | null;
  /**
   * PR C (00156): pola decyzji `faktflow-original` z surowego `original_check.decision` — parser PR B zachowuje
   * tylko wybór, kanał i czas. `null` — wpis bez decyzji albo decyzja PR B (bez tych kluczy).
   */
  originalDecision: OriginalDecisionInfo | null;
}

/** Tryb, oferta i faktura K z `original_check.decision` decyzji `faktflow-original` (karta operatora, 6.6). */
export interface OriginalDecisionInfo {
  mode: DuplicateDecisionMode | null;
  offer: DuplicateOriginalOffer | null;
  /** K zapisana z KSeF (`mode = 'import'`). */
  importedInvoiceId: string | null;
  /** Numer, który przeszedł z X na K. */
  retiredInternalNumber: string | null;
}

/**
 * Stan faktury K zapisanej decyzją (I3K, 6.6): brak daty nadania numeru KSeF (`ksef_accepted_at`) i brak sesji
 * UPO (wpis K z `response_ksef_number = K` i sesją). Tylko odczyt — alarmy idą z akcji decyzji.
 */
export interface ImportedOriginalState {
  invoiceId: string;
  ksefNumber: string | null;
  noDate: boolean;
  noSession: boolean;
}

export interface AuditTrailRow {
  id: string;
  action: string;
  userId: string | null;
  createdAt: string;
  details: Json | null;
}

export interface InvoiceLifecycle {
  invoice: {
    id: string;
    tenantId: string;
    tenantName: string | null;
    tenantNip: string | null;
    internalNumber: string | null;
    direction: string | null;
    invoiceKind: string | null;
    invoiceType: string | null;
    issueDate: string | null;
    ksefStatus: string | null;
    ksefNumber: string | null;
    ksefEnvironment: string | null;
    errorCode: string | null;
    errorClass: SendErrorClass | null;
    lastError: string | null;
    sendOwner: string | null;
    submittedToKsefAt: string | null;
    lastAttemptAt: string | null;
    submissionAttempts: number | null;
    xmlStoragePath: string | null;
    updatedAt: string | null;
  };
  submissions: SubmissionHistoryRow[];
  audit: AuditTrailRow[];
  /** Jest otwarty wpis `sent` — „tylko uzgodnij” ma czego dotyczyć. */
  openSent: boolean;
  /** Dowód kontaktu z KSeF (`ksef_has_contact_evidence`) — blokuje powrót do szkicu. */
  evidence: boolean;
  /** Ponowienie z kopii (A4b PR2a) — bez treści dokumentu. */
  resendFacts: KsefResendFacts;
  /** `KSEF_ENV` aplikacji (`null` = niepoprawne — nic nie zlecamy). */
  environment: KsefEnvironment | null;
  /**
   * D-A4-1b-3 PR B: widok decyzji klienta (actor operator) dla failed
   * KSEF_DUPLICATE_RECONCILE; `null` — faktura w innym stanie.
   */
  duplicateDecision: DuplicateDecisionView | null;
  /** Ślad powiadomień klienta o (fakturze, K znacznika); `null` — bez znacznika 440. */
  duplicateNotice: (DuplicateNoticeSummary & { ksefNumber: string }) | null;
  /**
   * PR C (6.6, INV-13): suchy przebieg zapisu oryginału przy widoku `review` (odczyt archiwum, bez alarmów
   * i zapisów) — czy plik da się zapisać jako fakturę K; `null` — widok inny niż `review`.
   */
  originalRecordable: OperatorRecordable | null;
  /** PR C (I3K): K zapisana decyzją z tego wpisu; `null` — brak decyzji z zapisem oryginału. */
  importedOriginal: ImportedOriginalState | null;
}

const LIFECYCLE_INVOICE_COLUMNS =
  `${KSEF_RESEND_SOURCE_COLUMNS}, id, tenant_id, internal_number, direction, invoice_type, ksef_status, ksef_number, ksef_environment, last_error_code, last_error, ksef_send_owner, submitted_to_ksef_at, last_attempt_at, submission_attempts, xml_storage_path, updated_at, tenants(name, nip)` as const;

export async function getInvoiceLifecycle(invoiceId: string): Promise<InvoiceLifecycle | null> {
  await requireAdmin();
  const supabase = createAdminClient();

  const { data: inv, error } = await supabase
    .from('invoices')
    .select(LIFECYCLE_INVOICE_COLUMNS)
    .eq('id', invoiceId)
    .maybeSingle();
  if (error) throw new Error(`invoice lookup: ${error.message}`);
  if (!inv) return null;

  const [submissions, audit, evidence] = await Promise.all([
    supabase
      .from('ksef_submissions')
      .select('id, status, session_reference_number, invoice_reference_number, error_code, error_message, attempted_at, completed_at, original_ksef_number, original_check')
      .eq('invoice_id', invoiceId)
      .order('attempted_at', { ascending: false }),
    supabase
      .from('audit_logs')
      .select('id, action, user_id, created_at, details_json, metadata')
      .eq('entity_id', invoiceId)
      .like('action', 'invoice.%')
      .order('created_at', { ascending: false })
      .limit(50),
    supabase.rpc('ksef_has_contact_evidence', { p_invoice_id: invoiceId, p_tenant_id: inv.tenant_id }),
  ]);
  if (submissions.error) throw new Error(`ksef_submissions: ${submissions.error.message}`);
  if (audit.error) throw new Error(`audit_logs: ${audit.error.message}`);

  const tenant = tenantOf(inv.tenants as TenantEmbed);
  const environment = configuredKsefEnvironment();

  // D-A4-1b-3 PR B: decyzja klienta przy nierozstrzygniętym 440 — ta sama
  // polityka co RPC (fakty kluczem serwisowym, filtr firmy w każdym odczycie).
  let duplicateDecision: DuplicateDecisionView | null = null;
  let duplicateNotice: (DuplicateNoticeSummary & { ksefNumber: string }) | null = null;
  let originalRecordable: OperatorRecordable | null = null;
  if (inv.ksef_status === 'failed' && inv.last_error_code === 'KSEF_DUPLICATE_RECONCILE') {
    // PR C (5.4): przy znaczniku `faktflow-original` ładowarka czyta też blokadę SQL (`facts.sqlBlocker`).
    const facts = await loadDuplicateDecisionFacts(supabase, inv.tenant_id, inv.id, undefined, { sqlBlocker: 'admin' });
    duplicateDecision = duplicateDecisionOptions({ facts, actor: 'operator', canManage: false, environment, now: new Date() });
    const marker = duplicateMarker(facts.submissions);
    const k = marker?.original_ksef_number ?? null;
    if (k) duplicateNotice = { ...(await findDuplicateNotices(inv.tenant_id, inv.id, k)), ksefNumber: k };
    if (duplicateDecision.kind === 'review' && environment !== null) {
      originalRecordable = await dryRunOriginalImport({
        tenantId: inv.tenant_id,
        internalNumber: inv.internal_number,
        tenantNip: tenant.nip,
        offer: duplicateDecision.offer,
        check: parseDuplicateCheck(marker?.original_check),
        ksefNumber: duplicateDecision.originalKsefNumber,
        environment,
      });
    }
  }
  const history: SubmissionHistoryRow[] = (submissions.data ?? []).map((s) => ({
    id: s.id,
    status: s.status,
    sessionReferenceNumber: s.session_reference_number,
    invoiceReferenceNumber: s.invoice_reference_number,
    errorCode: s.error_code,
    errorMessage: s.error_message,
    attemptedAt: s.attempted_at,
    completedAt: s.completed_at,
    originalKsefNumber: s.original_ksef_number,
    // `original_check` z 00144 — typy bazy dogenerujemy z produkcji po wgraniu.
    originalCheck: parseDuplicateCheck((s as { original_check?: unknown }).original_check),
    originalDecision: originalDecisionOf((s as { original_check?: unknown }).original_check),
  }));
  const importedOriginal = await importedOriginalState(supabase, inv.tenant_id, history);

  return {
    invoice: {
      id: inv.id,
      tenantId: inv.tenant_id,
      tenantName: tenant.name,
      tenantNip: tenant.nip,
      internalNumber: inv.internal_number,
      direction: inv.direction,
      invoiceKind: inv.invoice_kind,
      invoiceType: inv.invoice_type,
      issueDate: inv.issue_date,
      ksefStatus: inv.ksef_status,
      ksefNumber: inv.ksef_number,
      ksefEnvironment: inv.ksef_environment,
      errorCode: inv.last_error_code,
      errorClass: sendErrorClassOf(inv.last_error_code),
      lastError: inv.last_error,
      sendOwner: inv.ksef_send_owner,
      submittedToKsefAt: inv.submitted_to_ksef_at,
      lastAttemptAt: inv.last_attempt_at,
      submissionAttempts: inv.submission_attempts,
      xmlStoragePath: inv.xml_storage_path,
      updatedAt: inv.updated_at,
    },
    submissions: history,
    audit: (audit.data ?? []).map((a) => ({
      id: a.id,
      action: a.action,
      userId: a.user_id,
      createdAt: a.created_at,
      details: a.details_json ?? a.metadata ?? null,
    })),
    openSent: hasOpenSubmission(history),
    evidence: evidence.error ? true : Boolean(evidence.data),
    resendFacts: ksefResendFacts(inv, environment),
    environment,
    duplicateDecision,
    duplicateNotice,
    originalRecordable,
    importedOriginal,
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const oneOf = <T extends string>(v: unknown, list: readonly T[]): T | null =>
  typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : null;

/** Pola decyzji `faktflow-original` z surowego `original_check.decision` (tryb, oferta, K, dawny numer). */
function originalDecisionOf(rawCheck: unknown): OriginalDecisionInfo | null {
  const decision = isRecord(rawCheck) ? rawCheck.decision : null;
  if (!isRecord(decision)) return null;
  const info: OriginalDecisionInfo = {
    mode: oneOf(decision.mode, DUPLICATE_DECISION_MODES),
    offer: oneOf(decision.offer, DUPLICATE_ORIGINAL_OFFERS),
    importedInvoiceId: text(decision.importedInvoiceId),
    retiredInternalNumber: text(decision.retiredInternalNumber),
  };
  return info.mode === null && info.offer === null && info.importedInvoiceId === null ? null : info;
}

/**
 * Suchy przebieg zapisu oryginału dla strony operatora (INV-13): archiwum, brama, projekcja — tylko odczyty,
 * bez alarmów i zapisów. Wynik czyta polityka przycisków przeglądu (`operatorReviewButtons`).
 */
async function dryRunOriginalImport(input: {
  tenantId: string;
  internalNumber: string | null;
  tenantNip: string | null;
  offer: DuplicateOriginalOffer;
  check: KsefDuplicateCheck | null;
  ksefNumber: string;
  environment: KsefEnvironment;
}): Promise<OperatorRecordable> {
  if (!input.check) return { ok: false, detail: 'znacznik bez poprawnych danych oryginału' };
  if (!input.tenantNip) return { ok: false, detail: 'firma bez NIP' };
  try {
    const prepared = await prepareOriginalImport({
      tenantId: input.tenantId,
      internalNumber: input.internalNumber ?? '',
      tenantNip: input.tenantNip,
      offer: input.offer,
      check: input.check,
      ksefNumber: input.ksefNumber,
      env: input.environment,
      now: new Date(),
    });
    if (prepared.ok) return { ok: true };
    return { ok: false, detail: prepared.kind === 'not-buildable' ? prepared.detail ?? 'not-buildable' : prepared.kind };
  } catch {
    // Strona karty nie pada przez awarię magazynu — zapis zostaje wyłączony (fail-closed), oddanie nadal możliwe.
    return { ok: false, detail: 'read-failed' };
  }
}

/** K zapisana decyzją z wpisu `number_taken` tej faktury: data nadania numeru i sesja UPO (I3K). */
async function importedOriginalState(
  supabase: ReturnType<typeof createAdminClient>,
  tenantId: string,
  history: readonly SubmissionHistoryRow[],
): Promise<ImportedOriginalState | null> {
  const decided = history.find((h) => h.originalDecision?.importedInvoiceId);
  const importedId = decided?.originalDecision?.importedInvoiceId ?? null;
  if (!importedId) return null;
  const [invoiceRead, submissionsRead] = await Promise.all([
    supabase.from('invoices').select('id, ksef_number, ksef_accepted_at').eq('id', importedId).eq('tenant_id', tenantId).maybeSingle(),
    supabase.from('ksef_submissions').select('session_reference_number, response_ksef_number').eq('invoice_id', importedId).eq('tenant_id', tenantId),
  ]);
  if (invoiceRead.error) throw new Error(`invoice K lookup: ${invoiceRead.error.message}`);
  if (submissionsRead.error) throw new Error(`ksef_submissions K: ${submissionsRead.error.message}`);
  const k = invoiceRead.data;
  if (!k) return { invoiceId: importedId, ksefNumber: null, noDate: true, noSession: true };
  const noSession = !(submissionsRead.data ?? []).some((r) =>
    k.ksef_number !== null && r.response_ksef_number === k.ksef_number && typeof r.session_reference_number === 'string' && r.session_reference_number !== '');
  return { invoiceId: importedId, ksefNumber: k.ksef_number, noDate: !k.ksef_accepted_at, noSession };
}

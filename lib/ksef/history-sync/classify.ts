/**
 * Klasyfikacja faktur z KSeF w synchronizacji historii (decyzja Bartosza
 * 22.10.2026) — co zrobić z fakturą, ZANIM ją pobierzemy i zapiszemy.
 *
 * Inwariant: faktury, którą FaktWay sam wysłał do KSeF, nigdy nie
 * importujemy drugi raz. Fakturę sprzedaży pobieramy tylko, gdy:
 *   - żaden wiersz sprzedaży firmy nie ma jej numeru KSeF (dowolne pochodzenie),
 *   - żadna próba wysyłki firmy (`ksef_submissions`) nie wskazuje jej numerem
 *     odpowiedzi, numerem oryginału 440 ani skrótem pliku,
 *   - żaden wiersz sprzedaży nie zajmuje jej numeru faktury.
 * Inaczej: pominięta, odłożona albo zablokowana z powodem (każdy powód ma
 * tekst dla klienta i ścieżkę operatora — runbook synchronizacja-historii-ksef).
 *
 * Numer zajęty przez szkic wycofany przy duplikacie 440 (`number_taken`) NIE
 * jest importowany (`retired_draft`): numer przenosi wyłącznie PR C (00156),
 * decyzja 07.10 (A).
 *
 * „Jest już w FaktWay” (`already_present`, `imported`) w sprzedaży znaczy
 * „jest w księgach” — ten sam filtr co przychód, KPiR, JPK i Pulpit
 * (`inSalesBooks`, ZAP-01). Szkic z importu pliku ma ten sam numer i dane,
 * ale księgi go nie liczą: blokada `number_conflict` (klient usuwa szkic,
 * sprawdzane co godzinę), nie pominięcie oryginału.
 *
 * Synchronizacja niczego tu nie zmienia w fakturach — tylko czyta.
 */

import { readDuplicateDecisionBlocker } from '@/lib/ksef/duplicate-decision-rpc';
import type { createAdminClient } from '@/lib/supabase/admin';
import type { InvoiceMetadata } from '@/types/ksef';

import {
  DEFERRED_RECHECK_MS,
  OWN_SEND_GRACE_MS,
} from './constants';
import type {
  KsefHistoryBlockedReason,
  KsefHistoryDeferredReason,
  KsefHistoryEnvironment,
  KsefHistoryItemInsert,
  KsefHistoryItemPatch,
  KsefHistoryItemRow,
  KsefHistorySkippedReason,
} from './db';
import type { HistoryDirection } from './windows';

type AdminClient = ReturnType<typeof createAdminClient>;

export interface ClassifyContext {
  admin: AdminClient;
  tenantId: string;
  environment: KsefHistoryEnvironment;
  direction: HistoryDirection;
  /** `ksef_history_sync.id` — pochodzenie zapisu silnika (`fa3_data.import.importJobId`). */
  streamId: string;
}

/** Numer KSeF ma ~35 znaków — 100 w `in.(…)` to ~3,6 KB adresu (jak skrzynka). */
const KSEF_NUMBERS_PER_QUERY = 100;
const KSEF_NUMBER_RE = /^[A-Za-z0-9-]{1,64}$/;

export type ProcessingOutcome =
  | { action: 'download'; repair: boolean }
  | { action: 'resolve'; status: 'skipped'; reason: KsefHistorySkippedReason; invoiceId: string | null }
  | { action: 'resolve'; status: 'imported'; reason: 'repaired' | null; invoiceId: string | null }
  | { action: 'defer'; reason: KsefHistoryDeferredReason; invoiceId: string | null }
  | { action: 'block'; reason: KsefHistoryBlockedReason; invoiceId: string | null; detail?: string };

interface LocalKsefRow {
  id: string;
  origin: string | null;
  ksef_number: string | null;
  ksef_status: string | null;
  ksef_environment: string | null;
  xml_storage_path: string | null;
  annotations: unknown;
  import_job: string | null;
}

const LOCAL_KSEF_COLUMNS =
  'id, origin, ksef_number, ksef_status, ksef_environment, xml_storage_path, annotations:fa3_data->annotations, import_job:fa3_data->import->>importJobId';

function digits(value: string | null | undefined): string {
  return (value ?? '').replace(/\D/g, '');
}

type BooksRow = { origin: string | null; ksef_status: string | null; ksef_environment: string | null };

/**
 * ZAP-01: czy wiersz sprzedaży jest w księgach — ten sam filtr co przychód,
 * KPiR, JPK i Pulpit (`ksef_status = 'accepted'` w środowisku strumienia,
 * np. `lib/analytics-finance/sales.ts`). Tylko taki posiadacz może dać
 * `already_present`: szkic z importu CSV ma ten sam numer i dane, ale
 * pominięcie oryginału z KSeF zgubiłoby sprzedaż bez komunikatu.
 *
 * Wyjątek: dawny import KSeF bez środowiska. Pulpit i przychód zatrzymują się
 * na nim komunikatem (`assertAcceptedEnvironmentKnown`), operator widzi go
 * w `ksef-historia.sh stan`, a drugi zapis oryginału silnik i tak odrzuci.
 */
function inSalesBooks(row: BooksRow, environment: KsefHistoryEnvironment): boolean {
  if (row.ksef_status !== 'accepted') return false;
  return row.ksef_environment === environment
    || (row.ksef_environment === null && row.origin === 'ksef_import');
}

/** Skrót KSeF (Base64 SHA-256) → hex jak `ksef_submissions.request_payload_hash`; `null` dla innego kształtu. */
export function invoiceHashToHex(hash: string | null | undefined): string | null {
  if (!hash || !/^[A-Za-z0-9+/]+={0,2}$/.test(hash)) return null;
  const bytes = Buffer.from(hash, 'base64');
  return bytes.length === 32 ? bytes.toString('hex') : null;
}

function counterparty(inv: InvoiceMetadata, direction: HistoryDirection): { nip: string | null; name: string | null } {
  if (direction === 'outgoing') {
    const id = inv.buyer?.identifier;
    return {
      nip: id?.type === 'Nip' ? id.value ?? null : null,
      name: inv.buyer?.name ?? null,
    };
  }
  return { nip: inv.seller?.nip ?? null, name: inv.seller?.name ?? null };
}

function metadataColumns(ctx: ClassifyContext, inv: InvoiceMetadata) {
  const party = counterparty(inv, ctx.direction);
  const gross = Number(inv.grossAmount);
  return {
    tenant_id: ctx.tenantId,
    environment: ctx.environment,
    direction: ctx.direction,
    ksef_number: inv.ksefNumber,
    invoice_number: String(inv.invoiceNumber ?? ''),
    issue_date: String(inv.issueDate ?? '').slice(0, 10),
    acquisition_at: inv.acquisitionDate ?? null,
    permanent_storage_at: inv.permanentStorageDate ?? null,
    invoice_type: inv.invoiceType ?? null,
    counterparty_nip: party.nip,
    counterparty_name: party.name,
    gross_amount: Number.isFinite(gross) ? gross : null,
    currency: inv.currency ?? null,
    invoice_hash: inv.invoiceHash ?? null,
  };
}

async function readLocalByKsefNumbers(ctx: ClassifyContext, numbers: string[]): Promise<Map<string, LocalKsefRow[]>> {
  const byNumber = new Map<string, LocalKsefRow[]>();
  for (let i = 0; i < numbers.length; i += KSEF_NUMBERS_PER_QUERY) {
    const { data, error } = await ctx.admin
      .from('invoices')
      .select(LOCAL_KSEF_COLUMNS)
      .eq('tenant_id', ctx.tenantId)
      .eq('direction', ctx.direction)
      .in('ksef_number', numbers.slice(i, i + KSEF_NUMBERS_PER_QUERY));
    if (error) throw new Error(`Historia KSeF: odczyt faktur po numerze KSeF: ${error.message}`);
    for (const row of (data ?? []) as unknown as LocalKsefRow[]) {
      const n = row.ksef_number?.trim();
      if (!n) continue;
      byNumber.set(n, [...(byNumber.get(n) ?? []), row]);
    }
  }
  return byNumber;
}

function contentMissing(row: LocalKsefRow): boolean {
  return !row.xml_storage_path || row.annotations === null || row.annotations === undefined;
}

/**
 * Czy zapis faktury z KSeF jest pełny: ścieżka XML, adnotacje, co najmniej
 * jedna pozycja i wiersz `xml_documents` (SHA-256 oryginału — KOD I na
 * fakturze i w PDF, lista plików retencji).
 *
 * Samo pochodzenie (`fa3_data.import.importJobId` = ten strumień) tego NIE
 * dowodzi (decyzja Bartosza 22.10.2026, poprawka po przeglądzie): silnik
 * zapisuje nagłówek, pozycje i `xml_documents` osobnymi zapytaniami. Nieudany
 * zapis oryginału zostawia fakturę z `failed` do uzupełnienia ponownym
 * importem (gałąź duplikatu silnika: `repairImportedXml`), a przerwany zapis
 * (SIGTERM, OOM między nagłówkiem a pozycjami) — sam nagłówek. Niepełna
 * faktura idzie więc do silnika w trybie uzupełnienia; nagłówek bez pozycji
 * nie przejdzie jego sprawdzenia liczby pozycji i po 3 próbach trafi do
 * operatora (`save_failed` / `repair_failed`).
 */
async function localContentComplete(ctx: ClassifyContext, row: LocalKsefRow): Promise<boolean> {
  if (contentMissing(row)) return false;
  const [lines, xml] = await Promise.all([
    ctx.admin
      .from('invoice_line_items')
      .select('id', { count: 'exact', head: true })
      .eq('invoice_id', row.id),
    ctx.admin
      .from('xml_documents')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', ctx.tenantId)
      .eq('invoice_id', row.id),
  ]);
  if (lines.error || typeof lines.count !== 'number') {
    throw new Error(`Historia KSeF: odczyt pozycji faktury: ${lines.error?.message ?? 'brak liczby'}`);
  }
  if (xml.error || typeof xml.count !== 'number') {
    throw new Error(`Historia KSeF: odczyt oryginału XML faktury: ${xml.error?.message ?? 'brak liczby'}`);
  }
  return lines.count > 0 && xml.count > 0;
}

/**
 * Strona KSeF → wiersze dziennika (przed jakąkolwiek zmianą kursora).
 * `null` w wyniku = faktura FaktWay albo bieżąca ze Skrzynki KSeF — bez wiersza.
 */
export async function classifyDiscovered(
  ctx: ClassifyContext,
  page: readonly InvoiceMetadata[],
  now: Date,
): Promise<KsefHistoryItemInsert[]> {
  const unique = [...new Map(page.map((inv) => [inv.ksefNumber, inv])).values()];
  for (const inv of unique) {
    if (!KSEF_NUMBER_RE.test(inv.ksefNumber ?? '')) {
      throw new Error('Historia KSeF: numer KSeF spoza formatu w odpowiedzi KSeF');
    }
  }
  const locals = await readLocalByKsefNumbers(ctx, unique.map((inv) => inv.ksefNumber));
  const resolvedAt = now.toISOString();
  const rows: KsefHistoryItemInsert[] = [];

  for (const inv of unique) {
    const base = metadataColumns(ctx, inv);
    const matches = locals.get(inv.ksefNumber) ?? [];
    const conflict = matches.length > 1
      || matches.some((r) => r.ksef_environment !== null && r.ksef_environment !== ctx.environment);
    if (conflict) {
      rows.push({ ...base, status: 'blocked', reason_code: 'local_conflict', invoice_id: matches[0]?.id ?? null, resolved_at: resolvedAt });
      continue;
    }
    const local = matches[0];
    if (local) {
      const own = (ctx.direction === 'outgoing' && local.origin === 'app')
        || (ctx.direction === 'incoming' && local.origin === 'ksef_inbox');
      if (own) continue;
      if (ctx.direction === 'outgoing' && !inSalesBooks(local, ctx.environment)) {
        // ZAP-01: wiersz z tym numerem KSeF, którego księgi nie liczą — operator, sprawdzane co godzinę.
        rows.push({ ...base, status: 'blocked', reason_code: 'local_conflict', invoice_id: local.id, resolved_at: resolvedAt });
        continue;
      }
      if (local.origin === 'ksef_import') {
        if (local.ksef_environment === null) {
          // Dawny import bez środowiska — bez naprawy; operator widzi je w `ksef-historia.sh stan`.
          rows.push({ ...base, status: 'skipped', reason_code: 'already_present', invoice_id: local.id, resolved_at: resolvedAt });
        } else if (local.import_job === ctx.streamId) {
          // Zapis tego strumienia: `imported` tylko pełny; niepełny czeka na
          // uzupełnienie silnikiem (pending, liczy się potem jako pobrana).
          rows.push(await localContentComplete(ctx, local)
            ? { ...base, status: 'imported', reason_code: null, invoice_id: local.id, resolved_at: resolvedAt }
            : { ...base, status: 'pending', reason_code: null, invoice_id: local.id, resolved_at: null });
        } else if (ctx.direction === 'outgoing' && local.ksef_environment === ctx.environment && contentMissing(local)) {
          rows.push({ ...base, status: 'pending', reason_code: 'repair_content', invoice_id: local.id, resolved_at: null });
        } else {
          rows.push({ ...base, status: 'skipped', reason_code: 'already_present', invoice_id: local.id, resolved_at: resolvedAt });
        }
        continue;
      }
      rows.push({ ...base, status: 'skipped', reason_code: 'already_present', invoice_id: local.id, resolved_at: resolvedAt });
      continue;
    }
    if (inv.currency && inv.currency.trim().toUpperCase() !== 'PLN') {
      rows.push({ ...base, status: 'blocked', reason_code: 'currency_not_supported', invoice_id: null, resolved_at: resolvedAt });
      continue;
    }
    rows.push({ ...base, status: 'pending', reason_code: null, invoice_id: null, resolved_at: null });
  }
  return rows;
}

interface SubmissionRow {
  id: string;
  invoice_id: string;
  status: string | null;
  original_ksef_number: string | null;
  response_ksef_number: string | null;
  request_payload_hash: string | null;
}

interface LocalNumberRow {
  id: string;
  origin: string | null;
  internal_number: string | null;
  ksef_number: string | null;
  ksef_status: string | null;
  ksef_environment: string | null;
  buyer_nip: string | null;
  issue_date: string | null;
  gross_total: number | string | null;
}

/**
 * Pozycja dziennika → decyzja tuż przed pobraniem (i przy ponownym
 * sprawdzeniu). Kroki 1, 1b, 2, 3, 4 w tej kolejności — pierwszy, który coś
 * rozstrzyga, wygrywa.
 */
export async function classifyForProcessing(
  ctx: ClassifyContext,
  item: Pick<KsefHistoryItemRow, 'ksef_number' | 'invoice_number' | 'issue_date' | 'reason_code' | 'counterparty_nip' | 'gross_amount' | 'invoice_hash' | 'invoice_id'>,
): Promise<ProcessingOutcome> {
  const n = item.ksef_number;
  if (!KSEF_NUMBER_RE.test(n)) return { action: 'block', reason: 'local_conflict', invoiceId: null, detail: 'numer KSeF spoza formatu' };

  // ── 1. Wiersz tego kierunku z tym numerem KSeF ──
  const { data: byKsef, error: ksefError } = await ctx.admin
    .from('invoices')
    .select(LOCAL_KSEF_COLUMNS)
    .eq('tenant_id', ctx.tenantId)
    .eq('direction', ctx.direction)
    .eq('ksef_number', n);
  if (ksefError) throw new Error(`Historia KSeF: odczyt faktury po numerze KSeF: ${ksefError.message}`);
  const sameNumber = (byKsef ?? []) as unknown as LocalKsefRow[];
  if (sameNumber.length > 1
      || sameNumber.some((r) => r.ksef_environment !== null && r.ksef_environment !== ctx.environment)) {
    return { action: 'block', reason: 'local_conflict', invoiceId: sameNumber[0]?.id ?? null };
  }
  const local = sameNumber[0];
  if (local) {
    if (ctx.direction === 'outgoing' && local.origin === 'app') {
      return { action: 'resolve', status: 'skipped', reason: 'own_invoice', invoiceId: local.id };
    }
    if (ctx.direction === 'outgoing' && !inSalesBooks(local, ctx.environment)) {
      // ZAP-01: wiersz z tym numerem KSeF, którego księgi nie liczą — nie „już w FaktWay”.
      return { action: 'block', reason: 'local_conflict', invoiceId: local.id };
    }
    if (local.origin === 'ksef_import') {
      const repairItem = item.reason_code === 'repair_content';
      const ownSave = local.import_job === ctx.streamId;
      if (local.ksef_environment === ctx.environment && (repairItem || ownSave)) {
        // Naprawa dawnego importu albo zapis tego strumienia: rozstrzygamy
        // dopiero przy PEŁNYM zapisie (pozycje, XML, `xml_documents`,
        // adnotacje) — inaczej silnik w trybie uzupełnienia (bez katalogów).
        if (!(await localContentComplete(ctx, local))) return { action: 'download', repair: true };
        return repairItem
          ? { action: 'resolve', status: 'imported', reason: 'repaired', invoiceId: local.id }
          // Awaria po pełnym zapisie silnika — faktura jest, drugi zapis byłby zbędny.
          : { action: 'resolve', status: 'imported', reason: null, invoiceId: local.id };
      }
      return { action: 'resolve', status: 'skipped', reason: 'already_present', invoiceId: local.id };
    }
    return { action: 'resolve', status: 'skipped', reason: 'already_present', invoiceId: local.id };
  }

  // ── 1b. Zakupy: ta sama faktura przepisana bez numeru KSeF (OCR, ręcznie, plik) ──
  if (ctx.direction === 'incoming') {
    const sellerNip = digits(item.counterparty_nip);
    if (sellerNip) {
      const { data, error } = await ctx.admin
        .from('invoices')
        .select('id, internal_number')
        .eq('tenant_id', ctx.tenantId)
        .eq('direction', 'incoming')
        .is('ksef_number', null)
        .eq('seller_nip', sellerNip)
        .eq('issue_date', item.issue_date);
      if (error) throw new Error(`Historia KSeF: odczyt zakupów bez numeru KSeF: ${error.message}`);
      const copy = ((data ?? []) as Array<{ id: string; internal_number: string | null }>)
        .find((r) => (r.internal_number ?? '').trim() === item.invoice_number.trim());
      if (copy) return { action: 'resolve', status: 'skipped', reason: 'already_present', invoiceId: copy.id };
    }
    return { action: 'download', repair: false };
  }

  // ── 2. Sprzedaż: nasza próba wysyłki wskazuje ten dokument ──
  const hashHex = invoiceHashToHex(item.invoice_hash);
  const filters = [`original_ksef_number.eq.${n}`, `response_ksef_number.eq.${n}`];
  if (hashHex) filters.push(`request_payload_hash.ilike.${hashHex}`);
  const { data: subsData, error: subsError } = await ctx.admin
    .from('ksef_submissions')
    .select('id, invoice_id, status, original_ksef_number, response_ksef_number, request_payload_hash')
    .eq('tenant_id', ctx.tenantId)
    .or(filters.join(','));
  if (subsError) throw new Error(`Historia KSeF: odczyt prób wysyłki: ${subsError.message}`);
  const submissions = (subsData ?? []) as SubmissionRow[];
  const originals = submissions.filter((s) => s.original_ksef_number === n);
  if (originals.length > 0) {
    const retired = originals.find((s) => s.status === 'number_taken');
    if (retired) return { action: 'resolve', status: 'skipped', reason: 'retired_draft', invoiceId: retired.invoice_id };
    const open = originals.find((s) => s.status === 'intent' || s.status === 'sent');
    if (open) {
      // NULL = faktura czeka na decyzję klienta (I5D) — panel klienta i e-mail 440.
      const blocker = await readDuplicateDecisionBlocker(ctx.admin, open.invoice_id, ctx.tenantId);
      return { action: 'defer', reason: blocker === null ? 'duplicate_decision' : 'own_send_pending', invoiceId: open.invoice_id };
    }
    return { action: 'defer', reason: 'own_send_pending', invoiceId: originals[0]!.invoice_id };
  }
  if (submissions.length > 0) {
    // Numer z odpowiedzi albo ten sam plik — wynik naszej wysyłki jeszcze nie
    // trafił do faktury; po uzgodnieniu krok 1 da `own_invoice`.
    return { action: 'defer', reason: 'own_send_pending', invoiceId: submissions[0]!.invoice_id };
  }

  // ── 3. Sprzedaż: numer faktury zajęty w FaktWay ──
  const trimmed = item.invoice_number.trim();
  const variants = [...new Set([trimmed, item.invoice_number])].filter(Boolean);
  if (variants.length > 0) {
    const { data: numData, error: numError } = await ctx.admin
      .from('invoices')
      .select('id, origin, internal_number, ksef_number, ksef_status, ksef_environment, buyer_nip, issue_date, gross_total')
      .eq('tenant_id', ctx.tenantId)
      .eq('direction', 'outgoing')
      .in('internal_number', variants);
    if (numError) throw new Error(`Historia KSeF: odczyt numeru faktury: ${numError.message}`);
    const sameInternal = ((numData ?? []) as LocalNumberRow[])
      .filter((r) => (r.internal_number ?? '').trim() === trimmed);
    if (sameInternal.length > 1) return { action: 'block', reason: 'local_conflict', invoiceId: sameInternal[0]!.id };
    const row = sameInternal[0];
    if (row) return classifyNumberHolder(ctx, item, row);
  }

  // ── 4. Nic nie zajmuje tej faktury ──
  return { action: 'download', repair: false };
}

async function classifyNumberHolder(
  ctx: ClassifyContext,
  item: Pick<KsefHistoryItemRow, 'ksef_number' | 'issue_date' | 'counterparty_nip' | 'gross_amount'>,
  row: LocalNumberRow,
): Promise<ProcessingOutcome> {
  if (row.origin !== 'app') {
    const ksefNumber = row.ksef_number?.trim() ?? '';
    if (ksefNumber !== '' && ksefNumber !== item.ksef_number) return { action: 'block', reason: 'number_taken_local', invoiceId: row.id };
    // ZAP-01: szkic z importu pliku (CSV/JPK) ma ten sam numer i dane, ale
    // księgi go nie liczą — pominięcie oryginału zgubiłoby sprzedaż. Z numerem
    // KSeF albo bez statusu — operator. Bez numeru KSeF klient mógł go wysłać
    // z FaktWay (440 bez numeru oryginału — klient go nie usunie, 00148) — dalej
    // jak faktura FaktWay, z operatorem zamiast „innego numeru KSeF”.
    if (!inSalesBooks(row, ctx.environment)) {
      if (ksefNumber !== '' || row.ksef_status === null) return { action: 'block', reason: 'local_conflict', invoiceId: row.id };
      return classifyBySendAttempts(ctx, row, 'local_conflict');
    }
    if (ksefNumber !== '') return { action: 'resolve', status: 'skipped', reason: 'already_present', invoiceId: row.id };
    const gross = Number(row.gross_total);
    const sameData = digits(row.buyer_nip) === digits(item.counterparty_nip)
      && row.issue_date === item.issue_date
      && item.gross_amount !== null
      && Number.isFinite(gross)
      && Math.abs(gross - Number(item.gross_amount)) < 0.005;
    // Przeniesiona plikiem (CSV/JPK) albo OCR i przyjęta — ta sama sprzedaż; wiersza nie ruszamy.
    return sameData
      ? { action: 'resolve', status: 'skipped', reason: 'already_present', invoiceId: row.id }
      : { action: 'block', reason: 'file_import_mismatch', invoiceId: row.id };
  }
  return classifyBySendAttempts(ctx, row, 'number_taken_local');
}

/**
 * Posiadacz numeru, który mógł iść do KSeF z FaktWay. `number_conflict`
 * („usuń szkic”) tylko dla szkicu bez prób wysyłki: `deleteDraftInvoiceAction`
 * usuwa wyłącznie `draft`, a wycofanego 440 nie (wyzwalacz 00148 — usuwa serwis
 * za zgodą Bartosza). Szkic z próbą ocenia operator, jak w gałęzi `app`
 * (recenzja #339). Reszta — operator (`fallback`, alarm `ksef_history_blocked`).
 */
async function classifyBySendAttempts(
  ctx: ClassifyContext,
  row: LocalNumberRow,
  fallback: 'number_taken_local' | 'local_conflict',
): Promise<ProcessingOutcome> {
  const status = row.ksef_status;
  if (status === 'queued' || status === 'sending' || status === 'offline_queued') {
    return { action: 'defer', reason: 'own_send_pending', invoiceId: row.id };
  }
  const { count, error } = await ctx.admin
    .from('ksef_submissions')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', ctx.tenantId)
    .eq('invoice_id', row.id);
  if (error || typeof count !== 'number') {
    throw new Error(`Historia KSeF: odczyt prób wysyłki faktury: ${error?.message ?? 'brak liczby'}`);
  }
  if (status === 'draft' && count === 0) {
    // Zwykły szkic bez prób wysyłki — klient go usuwa.
    return { action: 'block', reason: 'number_conflict', invoiceId: row.id };
  }
  if ((status === 'failed' || status === 'rejected') && count > 0) {
    return { action: 'defer', reason: 'own_send_pending', invoiceId: row.id };
  }
  return { action: 'block', reason: fallback, invoiceId: row.id };
}

/**
 * Zmiana pozycji wynikająca z decyzji (czysta funkcja). Odłożenie: pierwszy
 * termin zostaje, następne sprawdzenie za godzinę; `own_send_pending` dłużej
 * niż 48 h = `own_send_unresolved` (jak strażnik I5). `duplicate_decision`
 * bez limitu — decyduje klient (e-mail 440 i I5D to jego ścieżka).
 */
export function itemPatchFor(
  item: Pick<KsefHistoryItemRow, 'invoice_id' | 'first_deferred_at'>,
  outcome: ProcessingOutcome,
  now: Date,
): KsefHistoryItemPatch {
  const at = now.toISOString();
  switch (outcome.action) {
    case 'download':
      return {
        status: 'pending',
        reason_code: outcome.repair ? 'repair_content' : null,
        invoice_id: outcome.repair ? item.invoice_id : null,
        attempts: 0,
        next_attempt_at: null,
        first_deferred_at: null,
        resolved_at: null,
        detail: null,
      };
    case 'resolve':
      return {
        status: outcome.status,
        reason_code: outcome.reason,
        invoice_id: outcome.invoiceId,
        next_attempt_at: null,
        resolved_at: at,
        detail: null,
      };
    case 'block':
      return {
        status: 'blocked',
        reason_code: outcome.reason,
        invoice_id: outcome.invoiceId,
        next_attempt_at: null,
        resolved_at: at,
        detail: outcome.detail?.slice(0, 300) ?? null,
      };
    case 'defer': {
      const first = item.first_deferred_at ?? at;
      if (outcome.reason === 'own_send_pending' && now.getTime() - Date.parse(first) > OWN_SEND_GRACE_MS) {
        return {
          status: 'blocked',
          reason_code: 'own_send_unresolved',
          invoice_id: outcome.invoiceId,
          next_attempt_at: null,
          resolved_at: at,
          detail: null,
        };
      }
      return {
        status: 'deferred',
        reason_code: outcome.reason,
        invoice_id: outcome.invoiceId,
        first_deferred_at: first,
        next_attempt_at: new Date(now.getTime() + DEFERRED_RECHECK_MS).toISOString(),
        resolved_at: null,
        detail: null,
      };
    }
  }
}

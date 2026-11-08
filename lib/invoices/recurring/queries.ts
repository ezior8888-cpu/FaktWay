/**
 * Odczyty faktur cyklicznych (plan Finora N1, P6) — klientem z sesji, więc
 * RLS pilnuje firmy; `eq('tenant_id')` jest drugą warstwą, nie jedyną
 * (§2.4 pkt 9).
 *
 * Kwota przy pozycji to `gross_total` faktury-wzoru — „Kwota brutto wzoru”,
 * nie suma sprzedaży, więc reguły liczenia z §2.4 (proweniencja, środowisko
 * KSeF) jej nie dotyczą: to cena z ostatniego wzoru, którą klient i tak
 * może zmienić w formularzu.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { readCompletePages } from '@/lib/accounting/read-complete-pages';
import { todayInWarsaw } from '@/lib/format/warsaw-date';
import type { Database, Json } from '@/types/database';
import type { RecurringInvoiceRow, RecurringStatus } from '@/types/recurring-invoice';

import { recurringDb, toRecurringRow, type RecurringInvoiceDbRow } from './db';
import { coveredThroughDate, recurringPeriodKey, statusOf, type IssuedPeriod } from './schedule';
import { TEMPLATE_FILTERS } from './template';

type AnyClient = SupabaseClient<Database> | SupabaseClient;

const RECURRING_COLUMNS =
  'id, tenant_id, template_invoice_id, name, frequency, day_of_month, next_run_date, active, created_by, created_at, updated_at';

/** Paczka identyfikatorów w `.in('id', …)` — krótki adres zapytania PostgREST. */
const IN_CHUNK = 100;

/** Pozycja na liście P6 z danymi faktury-wzoru. */
export interface RecurringInvoiceListItem extends RecurringInvoiceRow {
  /** Stan przy odczycie (`statusOf`, dziś w Europe/Warsaw). */
  status: RecurringStatus;
  /** Okres następnej faktury (`recurringPeriodKey(next_run_date, frequency)`). */
  period: string;
  /** Nazwa nabywcy z faktury-wzoru (`buyer_data.name`) — pełna, skraca UI. */
  contractorName: string | null;
  templateNumber: string | null;
  /** „Kwota brutto wzoru” w PLN (wzór jest zawsze w PLN). */
  templateGrossTotal: number | null;
  /**
   * Do kiedy okresy są pokryte fakturą (`coveredThroughDate`: wzór albo
   * faktury z tej pozycji) — podgląd terminu po zmianie częstotliwości
   * w arkuszu „Edytuj” liczy z tej samej daty co akcja edycji. Brak (błąd
   * odczytu faktur) — podgląd liczy od dziś, akcja i tak czyta sama.
   */
  coveredThrough?: string | null;
}

/** Faktura, którą można wskazać jako wzór („+ Nowa faktura cykliczna”). */
export interface RecurringTemplateCandidate {
  id: string;
  internalNumber: string | null;
  issueDate: string;
  grossTotal: number | null;
  contractorName: string | null;
}

function buyerName(buyerData: Json | null): string | null {
  if (!buyerData || typeof buyerData !== 'object' || Array.isArray(buyerData)) return null;
  const name = buyerData.name;
  return typeof name === 'string' && name.trim() ? name.trim() : null;
}

const toRow = toRecurringRow;

/**
 * Wszystkie pozycje firmy (pełne strony, `readCompletePages` — §2.4 pkt 7),
 * posortowane: najpierw najbliższe wystawienie, potem nazwa. Rzuca `Error`
 * z polskim komunikatem, gdy odczyt się nie uda (karta w `SectionErrorBoundary`).
 */
export async function listRecurringInvoices(
  supabase: AnyClient,
  tenantId: string,
  today: string = todayInWarsaw(),
): Promise<RecurringInvoiceListItem[]> {
  const db = recurringDb(supabase);
  let rows: RecurringInvoiceRow[];
  try {
    const raw = await readCompletePages<RecurringInvoiceDbRow>('Faktury cykliczne', (from, to) =>
      db
        .from('recurring_invoices')
        .select(RECURRING_COLUMNS, { count: 'exact' })
        .eq('tenant_id', tenantId)
        .order('id', { ascending: true })
        .range(from, to),
    );
    rows = raw.map(toRecurringRow);
  } catch {
    throw new Error('Nie udało się wczytać faktur cyklicznych. Odśwież stronę za chwilę.');
  }

  const templateIds = [...new Set(rows.map((r) => r.template_invoice_id))];
  const templates = new Map<
    string,
    { internal_number: string | null; gross_total: number | null; buyer_data: Json | null; issue_date: string | null }
  >();
  for (let i = 0; i < templateIds.length; i += IN_CHUNK) {
    const { data, error } = await db
      .from('invoices')
      .select('id, internal_number, gross_total, buyer_data, issue_date')
      .eq('tenant_id', tenantId)
      .in('id', templateIds.slice(i, i + IN_CHUNK));
    if (error) throw new Error('Nie udało się wczytać faktur-wzorów. Odśwież stronę za chwilę.');
    for (const t of data ?? []) templates.set(t.id, t);
  }

  const issued = await readIssuedPeriods(db, tenantId, rows.map((r) => r.id));

  return rows
    .map((row) => {
      const t = templates.get(row.template_invoice_id);
      const ownIssued = issued?.get(row.id) ?? [];
      return {
        ...row,
        status: statusOf(row, today),
        period: recurringPeriodKey(row.next_run_date, row.frequency),
        contractorName: t ? buyerName(t.buyer_data) : null,
        templateNumber: t?.internal_number ?? null,
        templateGrossTotal: t?.gross_total == null ? null : Number(t.gross_total),
        ...(issued ? { coveredThrough: coveredThroughDate(t?.issue_date ?? null, ownIssued) } : {}),
      };
    })
    .sort((a, b) => a.next_run_date.localeCompare(b.next_run_date) || a.name.localeCompare(b.name, 'pl'));
}

type IssuedRow = IssuedPeriod & { id: string; recurring_invoice_id: string | null };

/**
 * Okresy i daty faktur wystawionych z pozycji (pełne strony po `id`).
 * `null`, gdy odczyt się nie udał — lista działa dalej, a podgląd terminu
 * w „Edytuj” liczy wtedy od dziś (akcja edycji czyta faktury sama).
 */
async function readIssuedPeriods(
  db: ReturnType<typeof recurringDb>,
  tenantId: string,
  recurringIds: string[],
): Promise<Map<string, IssuedPeriod[]> | null> {
  const byItem = new Map<string, IssuedPeriod[]>();
  try {
    for (let i = 0; i < recurringIds.length; i += IN_CHUNK) {
      const chunk = recurringIds.slice(i, i + IN_CHUNK);
      const rows = await readCompletePages<IssuedRow>('Faktury z pozycji cyklicznych', (from, to) =>
        db
          .from('invoices')
          .select('id, recurring_invoice_id, recurring_period, issue_date', { count: 'exact' })
          .eq('tenant_id', tenantId)
          .in('recurring_invoice_id', chunk)
          .order('id', { ascending: true })
          .range(from, to),
      );
      for (const r of rows) {
        if (!r.recurring_invoice_id) continue;
        const list = byItem.get(r.recurring_invoice_id) ?? [];
        list.push({ recurring_period: r.recurring_period, issue_date: r.issue_date });
        byItem.set(r.recurring_invoice_id, list);
      }
    }
  } catch {
    return null;
  }
  return byItem;
}

/** Okres pokryty fakturą dla jednej pozycji — wzór i faktury z pozycji (akcja edycji). */
export async function readCoveredThrough(
  supabase: AnyClient,
  tenantId: string,
  item: Pick<RecurringInvoiceRow, 'id' | 'template_invoice_id'>,
): Promise<{ ok: true; coveredThrough: string | null } | { ok: false }> {
  const db = recurringDb(supabase);
  const [template, issued] = await Promise.all([
    db.from('invoices').select('issue_date').eq('id', item.template_invoice_id).eq('tenant_id', tenantId).maybeSingle(),
    db
      .from('invoices')
      .select('recurring_period, issue_date')
      .eq('tenant_id', tenantId)
      .eq('recurring_invoice_id', item.id),
  ]);
  if (template.error || issued.error) return { ok: false };
  return { ok: true, coveredThrough: coveredThroughDate(template.data?.issue_date ?? null, issued.data ?? []) };
}

/**
 * Licznik do banera na `/invoices` („N faktur cyklicznych czeka na
 * wystawienie”): aktywne z `next_run_date <= dziś` (Europe/Warsaw).
 * `null`, gdy odczyt się nie udał (np. przed wgraniem 00154) — baner wtedy
 * się nie pokazuje, lista faktur działa dalej.
 */
export async function countRecurringInvoicesDue(
  supabase: AnyClient,
  tenantId: string,
  today: string = todayInWarsaw(),
): Promise<number | null> {
  const { count, error } = await recurringDb(supabase)
    .from('recurring_invoices')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('active', true)
    .lte('next_run_date', today);
  if (error || typeof count !== 'number') return null;
  return count;
}

/** Jedna pozycja tej firmy albo `null` (brak, obca, błąd odczytu). */
export async function getRecurringInvoice(
  supabase: AnyClient,
  tenantId: string,
  id: string,
): Promise<RecurringInvoiceRow | null> {
  const { data, error } = await recurringDb(supabase)
    .from('recurring_invoices')
    .select(RECURRING_COLUMNS)
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error || !data) return null;
  return toRow(data);
}

/**
 * Faktury, które mogą być wzorem (warunki `TEMPLATE_FILTERS` 1:1 z akcją
 * tworzenia), od najnowszej. Do wyboru w arkuszu „+ Nowa faktura cykliczna”;
 * `limit` domyślnie 50 — starsze wzory znajdzie wyszukiwanie po numerze
 * (`numberQuery`, fragment numeru).
 */
export async function listRecurringTemplateCandidates(
  supabase: AnyClient,
  tenantId: string,
  options: { limit?: number; numberQuery?: string } = {},
): Promise<RecurringTemplateCandidate[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  let query = recurringDb(supabase)
    .from('invoices')
    .select('id, internal_number, issue_date, gross_total, buyer_data')
    .eq('tenant_id', tenantId)
    .eq('direction', TEMPLATE_FILTERS.direction)
    .eq('origin', TEMPLATE_FILTERS.origin)
    .eq('invoice_kind', TEMPLATE_FILTERS.invoice_kind)
    .eq('invoice_type', TEMPLATE_FILTERS.invoice_type)
    .eq('ksef_status', TEMPLATE_FILTERS.ksef_status)
    .eq('currency', TEMPLATE_FILTERS.currency);
  const needle = options.numberQuery?.trim().replace(/[%_\\,()]/g, '');
  if (needle) query = query.ilike('internal_number', `%${needle}%`);
  const { data, error } = await query
    .order('issue_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error('Nie udało się wczytać faktur do wyboru wzoru. Spróbuj ponownie.');
  return (data ?? []).map((r) => ({
    id: r.id,
    internalNumber: r.internal_number,
    issueDate: r.issue_date,
    grossTotal: r.gross_total == null ? null : Number(r.gross_total),
    contractorName: buyerName(r.buyer_data),
  }));
}

/**
 * Jedna faktura jako kandydat na wzór (`?wzor=<id>` na `/invoices/recurring`)
 * albo `null`: nie ma jej, jest obca albo nie spełnia warunków wzoru
 * (`TEMPLATE_FILTERS`, te same co lista kandydatów i akcja tworzenia).
 * Błąd odczytu też daje `null` — strona pokazuje wtedy komunikat i pusty
 * wybór, nie 500.
 */
export async function getRecurringTemplateCandidate(
  supabase: AnyClient,
  tenantId: string,
  invoiceId: string,
): Promise<RecurringTemplateCandidate | null> {
  const { data, error } = await recurringDb(supabase)
    .from('invoices')
    .select('id, internal_number, issue_date, gross_total, buyer_data')
    .eq('id', invoiceId)
    .eq('tenant_id', tenantId)
    .eq('direction', TEMPLATE_FILTERS.direction)
    .eq('origin', TEMPLATE_FILTERS.origin)
    .eq('invoice_kind', TEMPLATE_FILTERS.invoice_kind)
    .eq('invoice_type', TEMPLATE_FILTERS.invoice_type)
    .eq('ksef_status', TEMPLATE_FILTERS.ksef_status)
    .eq('currency', TEMPLATE_FILTERS.currency)
    .maybeSingle();
  if (error || !data) return null;
  return {
    id: data.id,
    internalNumber: data.internal_number,
    issueDate: data.issue_date,
    grossTotal: data.gross_total == null ? null : Number(data.gross_total),
    contractorName: buyerName(data.buyer_data),
  };
}

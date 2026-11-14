import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { amountDueOf } from '@/lib/invoices/amount-due';
import { RECEIPT_REVENUE_COLUMNS } from '@/lib/invoices/receipt-revenue-guard';
import { countRemindersSentThisMonth, readLatestReminders, type LatestReminderState } from '@/lib/overdue/reminder-overview';
import { isReminderInvoiceChaseable } from '@/lib/reminders/delivery-schema';
import type { Database } from '@/types/database';

/**
 * Lista „Po terminie” (`/payments/overdue`) dla strony i telefonu (plan
 * aplikacji mobilnej 4.3, M10a; `GET /api/mobile/v1/naleznosci`). Logika
 * przeniesiona ze strony bez zmian: te same faktury (środowisko KSeF,
 * korekty, zaliczki, uzgodnienie kwot), ten sam limit 100 i ten sam stan
 * przypomnień. Odczyty klientem sesji klienta (RLS), z jawnym filtrem firmy.
 *
 * Każda niepewność listy daje `ok: false` ze zdaniem dla klienta zamiast
 * niepełnej listy (fail-closed, jak dotąd na stronie).
 */

export interface OverdueInvoice {
  id: string;
  internal_number: string;
  payment_due_date: string;
  gross_total: number;
  amount_due: number;
  days_overdue: number;
  buyer_name: string;
  buyer_nip: string | null;
  buyer_email: string | null;
  reminders_paused: boolean;
  reminders_sent_count: number;
  reminder_status: 'none' | 'pending' | 'review' | 'unavailable';
  /** Ostatni wpis `payment_reminders` (kolumny „Przypomnienie” i „Status”). */
  latest_reminder: LatestReminderState;
}

export type OverdueOverview =
  | { ok: false; error: string }
  | {
      ok: true;
      invoices: OverdueInvoice[];
      /** Lista mogła się nie zmieścić w limicie (100 pozycji). */
      limitReached: boolean;
      /** `null`, gdy odczytu nie da się potwierdzić: kafel pokazuje „—”, nie „0”. */
      sentThisMonth: number | null;
    };

type OverdueViewRow = Database['public']['Views']['invoices_overdue']['Row'];
type OverdueInvoiceBase = Omit<OverdueInvoice, 'reminder_status' | 'latest_reminder'>;
const PENDING_REVIEW_AFTER_MS = 30 * 60_000;
const OVERDUE_PAGE_SIZE = 100;
const MAX_VISIBLE_INVOICES = 100;
const MAX_RELATED_INVOICES_PER_PAGE = 500;

function reminderReviewBefore(): number {
  // Server-only page: evaluate the clock once per request, after the read.
  return Date.now() - PENDING_REVIEW_AFTER_MS;
}

function toOverdueInvoice(row: OverdueViewRow): OverdueInvoiceBase | null {
  if (!row.id) return null;
  return {
    id: row.id,
    internal_number: row.internal_number ?? '',
    payment_due_date: row.payment_due_date ?? '',
    gross_total: Number(row.gross_total ?? 0),
    amount_due: Number(row.amount_due ?? 0),
    days_overdue: Number(row.days_overdue ?? 0),
    buyer_name: row.buyer_name ?? '',
    buyer_nip: row.buyer_nip,
    buyer_email: row.buyer_email,
    reminders_paused: Boolean(row.reminders_paused),
    reminders_sent_count: Number(row.reminders_sent_count ?? 0),
  };
}

/**
 * `environment`: środowisko KSeF z konfiguracji (`requireConfiguredKsefEnvironment`);
 * faktury z innego środowiska nie trafiają na listę.
 */
export async function loadOverdueOverview(
  supabase: SupabaseClient<Database>,
  tenantId: string,
  environment: string,
): Promise<OverdueOverview> {
  // The currently deployed view may predate the reconciliation guard. Check
  // origin, both invoice classifications, linked children and environment
  // independently before displaying an amount or allowing a preview.
  const overdueRows: OverdueViewRow[] = [];
  const seenViewIds = new Set<string>();
  let overdueError: string | null = null;
  let totalCandidates: number | null = null;
  // Czy pętla przejrzała cały widok. Gdy stanie na limicie wcześniej, dalsze
  // pozycje są niesprawdzone — nie wiemy, czy któraś by się zmieściła.
  let scannedAll = false;
  for (let offset = 0; overdueRows.length < MAX_VISIBLE_INVOICES; offset += OVERDUE_PAGE_SIZE) {
    const page = await supabase
      .from('invoices_overdue')
      .select('*', { count: 'exact' })
      .eq('tenant_id', tenantId)
      .order('days_overdue', { ascending: false })
      .order('id', { ascending: true })
      .range(offset, offset + OVERDUE_PAGE_SIZE - 1);
    if (page.error || !page.data || page.count === null ||
        (totalCandidates !== null && page.count !== totalCandidates) ||
        page.data.length !== Math.min(OVERDUE_PAGE_SIZE, Math.max(0, page.count - offset))) {
      overdueError = 'Nie można potwierdzić pełnej listy zaległych faktur';
      break;
    }
    totalCandidates = page.count;
    if (page.data.length === 0) { scannedAll = true; break; }

    const ids = page.data.map((row) => row.id).filter((id): id is string => id !== null);
    if (ids.length !== page.data.length || ids.some((id) => seenViewIds.has(id)) ||
        new Set(ids).size !== ids.length) {
      overdueError = 'Nie można potwierdzić tożsamości zaległych faktur';
      break;
    }
    for (const id of ids) seenViewIds.add(id);
    const matching = await supabase
      .from('invoices')
      .select(`id, ksef_environment, origin, invoice_kind, invoice_type, currency, payment_data, ${RECEIPT_REVENUE_COLUMNS}`, { count: 'exact' })
      .eq('tenant_id', tenantId)
      .in('id', ids);
    if (matching.error || !matching.data || matching.count === null ||
        matching.count !== ids.length || matching.data.length !== ids.length ||
        new Set(matching.data.map((invoice) => invoice.id)).size !== ids.length ||
        matching.data.some((invoice) => !ids.includes(invoice.id))) {
      overdueError = 'Nie można potwierdzić danych zaległych faktur';
      break;
    }
    if (matching.data.some((invoice) =>
      invoice.ksef_environment !== 'test' &&
      invoice.ksef_environment !== 'demo' &&
      invoice.ksef_environment !== 'production')) {
      overdueError = 'Zaległe faktury wymagają uzgodnienia środowiska KSeF';
      break;
    }
    const eligibleInvoices = matching.data.filter((invoice) =>
      invoice.ksef_environment === environment && isReminderInvoiceChaseable(invoice) &&
      (invoice.currency === null || invoice.currency === 'PLN'));
    const eligibleIds = new Set(eligibleInvoices.map((invoice) => invoice.id));
    const eligibleById = new Map(eligibleInvoices.map((invoice) => [invoice.id, invoice]));
    const relatedParents = new Set<string>();
    if (eligibleIds.size > 0) {
      // One bounded complete read per page. A server cap or failed exact count
      // must not make a corrected original appear safe to chase.
      const related = await supabase.from('invoices')
        .select('id, tenant_id, parent_invoice_id', { count: 'exact' })
        .eq('tenant_id', tenantId)
        .in('parent_invoice_id', [...eligibleIds])
        .limit(MAX_RELATED_INVOICES_PER_PAGE);
      if (related.error || !related.data || related.count === null ||
          !Number.isSafeInteger(related.count) || related.count < 0 ||
          related.count > MAX_RELATED_INVOICES_PER_PAGE || related.data.length !== related.count ||
          new Set(related.data.map((row) => row.id)).size !== related.data.length ||
          related.data.some((row) => row.tenant_id !== tenantId || !row.parent_invoice_id ||
            !eligibleIds.has(row.parent_invoice_id))) {
        overdueError = 'Nie można potwierdzić faktur powiązanych z korektami';
        break;
      }
      for (const row of related.data) relatedParents.add(row.parent_invoice_id!);

      // A final invoice settles advances through advance_invoice_ids rather
      // than parent_invoice_id. Exact HEAD counts cannot be silently truncated.
      const advances = eligibleInvoices.filter((invoice) =>
        invoice.invoice_kind === 'advance' && invoice.invoice_type === 'ZAL');
      try {
        const settledCounts = await Promise.all(advances.map(async (invoice) => {
          const result = await supabase.from('invoices')
            .select('id', { count: 'exact', head: true })
            .eq('tenant_id', tenantId)
            .contains('advance_invoice_ids', [invoice.id]);
          return { id: invoice.id, ...result };
        }));
        if (settledCounts.some(({ error, count }) => error || count === null ||
            !Number.isSafeInteger(count) || count < 0)) {
          overdueError = 'Nie można potwierdzić faktur rozliczających zaliczki';
          break;
        }
        for (const { id, count } of settledCounts) {
          if (count! > 0) relatedParents.add(id);
        }
      } catch {
        overdueError = 'Nie można potwierdzić faktur rozliczających zaliczki';
        break;
      }
    }
    const safeRows = page.data.filter((row) => row.id && eligibleIds.has(row.id) && !relatedParents.has(row.id));
    if (safeRows.some((row) => {
      const gross = Number(row.gross_total); const paid = Number(row.paid_amount);
      const due = Number(row.amount_due);
      const matchingRow = row.id ? eligibleById.get(row.id) : undefined;
      if (!matchingRow) return true;
      // ROZ: do zapłaty to `payment_data.amountDue` (reszta po zaliczkach),
      // nie całe `gross_total` — ta sama reguła co w widoku (C-16, 00145).
      const expectedDue = amountDueOf({
        invoice_kind: matchingRow.invoice_kind, gross_total: row.gross_total,
        payment_data: matchingRow.payment_data,
      });
      return row.gross_total === null || row.paid_amount === null || row.amount_due === null ||
        !Number.isFinite(gross) || !Number.isFinite(paid) || !Number.isFinite(due) ||
        gross <= 0 || paid < 0 || paid >= expectedDue || Math.abs(due - (expectedDue - paid)) > 0.005;
    })) {
      overdueError = 'Zaległe faktury wymagają uzgodnienia kwot';
      break;
    }
    overdueRows.push(...safeRows);
    if (offset + page.data.length >= page.count) { scannedAll = true; break; }
  }

  if (overdueError) return { ok: false, error: overdueError };

  // Poprawka Bartosza 21.10.2026: limit 100 pokazujemy tylko wtedy, gdy lista
  // mogła się w nim nie zmieścić — bezpiecznych pozycji jest więcej (ucięte
  // na pewno) albo pętla stanęła na setnej przed końcem widoku (dalszych nie
  // sprawdziliśmy). Dokładnie 100 po przejrzeniu całości to pełna lista.
  const limitReached = overdueRows.length > MAX_VISIBLE_INVOICES ||
    (overdueRows.length === MAX_VISIBLE_INVOICES && !scannedAll);

  const baseInvoices = overdueRows.slice(0, MAX_VISIBLE_INVOICES).flatMap((row) => {
    const inv = toOverdueInvoice(row);
    return inv ? [inv] : [];
  });

  // Query only pending rows for the invoices actually shown. The session
  // client enforces RLS, while both explicit filters protect this page if a
  // view or policy is changed later. A read failure must not look like "none".
  const pendingByInvoice = new Map<string, 'pending' | 'review'>();
  let pendingReadFailed = false;
  if (baseInvoices.length > 0) {
    const visibleIds = baseInvoices.map((invoice) => invoice.id);
    // Four stages per invoice in the current enum. If the schema or PostgREST
    // returns fewer rows than its exact count, the status is unknown.
    const maximumRows = visibleIds.length * 4;
    try {
      const { data: pending, count, error: pendingError } = await supabase
        .from('payment_reminders')
        .select('invoice_id, scheduled_for', { count: 'exact' })
        .eq('tenant_id', tenantId)
        .in('invoice_id', visibleIds)
        .eq('status', 'pending')
        .limit(maximumRows);
      if (pendingError || !pending || typeof count !== 'number' ||
          count > maximumRows || count !== pending.length) {
        pendingReadFailed = true;
      } else {
        const reviewBefore = reminderReviewBefore();
        for (const row of pending) {
          if (!visibleIds.includes(row.invoice_id)) {
            pendingReadFailed = true;
            break;
          }
          const scheduled = Date.parse(row.scheduled_for);
          const state = !Number.isFinite(scheduled) || scheduled < reviewBefore
            ? 'review' : 'pending';
          if (state === 'review' || !pendingByInvoice.has(row.invoice_id)) {
            pendingByInvoice.set(row.invoice_id, state);
          }
        }
      }
    } catch {
      pendingReadFailed = true;
    }
  }
  // Kolumny „Przypomnienie” i „Status”: ostatni wpis `payment_reminders`
  // każdej faktury. Odczyt idzie PO odczycie stanu „pending” i nie wpływa na
  // to, czy wolno przygotować przypomnienie — to rozstrzyga wyłącznie
  // `reminder_status` powyżej.
  const latestReminders = baseInvoices.length > 0
    ? await readLatestReminders(supabase, tenantId, baseInvoices.map((invoice) => invoice.id))
    : new Map();
  const overdueInvoices: OverdueInvoice[] = baseInvoices.map((invoice) => ({
    ...invoice,
    reminder_status: pendingReadFailed ? 'unavailable'
      : pendingByInvoice.get(invoice.id) ?? 'none',
    latest_reminder: latestReminders === null ? 'unavailable'
      : latestReminders.get(invoice.id) ?? null,
  }));

  // Kafel „Przypomnień wysłanych w miesiącu” — osobne źródło, więc jego błąd
  // zabiera tylko ten kafel („—”), nie listę.
  let sentThisMonth: number | null = null;
  try {
    sentThisMonth = await countRemindersSentThisMonth(supabase, tenantId);
  } catch {
    sentThisMonth = null;
  }


  return { ok: true, invoices: overdueInvoices, limitReached, sentThisMonth };
}

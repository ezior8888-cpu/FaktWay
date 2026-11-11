import 'server-only';
import { ReminderConsentDenied } from './delivery-errors';
import { createAdminClient } from '@/lib/supabase/admin';
import { evaluateChaseSafety, SAFETY_WINDOW_MS } from '@/lib/flo/functions/payment-chase';
import { isReminderInvoiceChaseable, reminderInvoiceFingerprint, reminderRefusalMessage } from './delivery-schema';
import { assertNoRelatedInvoice } from './reconciliation-guard';
import { outstandingOf } from '@/lib/invoices/amount-due';
import type { ReminderDelivery } from '@/types/reminder-delivery';

// PostgREST can silently truncate result sets. Every bounded read below also
// requires an exact count, so a busy tenant cannot accidentally bypass the guard.
const MAX_RECENT_ROWS = 500;
const MAX_INVOICES_PER_QUERY = 100;

function paymentDay(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) {
    throw new ReminderConsentDenied('Nieprawidłowa data płatności.');
  }
  return value;
}

function normalizeNip(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\D/g, '');
}

function invoiceNip(row: { buyer_nip: unknown; buyer_data: unknown }): string {
  const buyer = row.buyer_data && typeof row.buyer_data === 'object' && !Array.isArray(row.buyer_data)
    ? row.buyer_data as Record<string, unknown> : {};
  const columnNip = normalizeNip(row.buyer_nip);
  const embeddedNip = normalizeNip(buyer.nip);
  if (columnNip && embeddedNip && columnNip !== embeddedNip) {
    throw new ReminderConsentDenied('Dane kontrahenta są niespójne.');
  }
  return columnNip || embeddedNip;
}

function requireCompleteRead(data: unknown[] | null, count: number | null, label: string): void {
  if (!data || count === null || !Number.isInteger(count) || count < 0 ||
      count !== data.length || count > MAX_RECENT_ROWS) {
    throw new ReminderConsentDenied('Nie można potwierdzić wszystkich ' + label + '. Wysyłka wstrzymana.');
  }
}

/** Never place these reads in a separately cached durable step. */
export async function assertReminderSendable(delivery: ReminderDelivery) {
  const client = createAdminClient();
  const invoice = await client.from('invoices').select('*')
    .eq('id', delivery.invoiceId).eq('tenant_id', delivery.tenantId).maybeSingle();
  if (invoice.error) throw new Error('Nie można odczytać stanu faktury.');
  if (!invoice.data || invoice.data.tenant_id !== delivery.tenantId ||
      invoice.data.id !== delivery.invoiceId) throw new ReminderConsentDenied('Faktura nie należy do organizacji przypomnienia.');
  const row = invoice.data;
  if (!isReminderInvoiceChaseable(row)) throw new ReminderConsentDenied(reminderRefusalMessage(row));
  if (reminderInvoiceFingerprint(row) !== delivery.sourceFingerprint) {
    throw new ReminderConsentDenied('Dane faktury zmieniły się po przygotowaniu wiadomości. Wysyłka wstrzymana.');
  }
  await assertNoRelatedInvoice(client, delivery.tenantId, delivery.invoiceId);
  const recent = await client.from('payments').select('payment_date')
    .eq('tenant_id', delivery.tenantId).eq('invoice_id', delivery.invoiceId)
    .order('payment_date', { ascending: false }).limit(1);
  if (recent.error || !recent.data) throw new Error('Nie można sprawdzić ostatnich płatności.');
  const day = recent.data?.[0]?.payment_date;
  // ROZ: zaległość liczona od `payment_data.amountDue`, nie od całego
  // `gross_total` — ta sama reguła co w `prepare-delivery.ts` (C-16, 00145).
  const outstanding = outstandingOf({
    invoice_kind: row.invoice_kind, gross_total: row.gross_total,
    payment_data: row.payment_data, paid_amount: row.paid_amount,
  });
  if (!Number.isFinite(outstanding) || row.gross_total === null || row.paid_amount === null) {
    throw new ReminderConsentDenied('Nieprawidłowa kwota należności.');
  }
  const safety = evaluateChaseSafety({ outstanding, remindersPaused: row.reminders_paused,
    // DATE has no time. End-of-day prevents a premature send at the 48-hour edge.
    lastPaymentFromContractorAt: day ? paymentDay(day) + 'T23:59:59.999Z' : null, now: new Date() });
  if (!safety.ok) throw new ReminderConsentDenied(safety.message);

  const nip = invoiceNip(row);
  if (!/^\d{10}$/.test(nip)) throw new ReminderConsentDenied('Brak poprawnego NIP kontrahenta: nie można sprawdzić innych wpłat przed wysyłką.');
  const excluded = await client.from('contractors').select('tenant_id,nip', { count: 'exact' })
    .eq('tenant_id', delivery.tenantId).eq('reminder_excluded', true).limit(MAX_RECENT_ROWS + 1);
  if (excluded.error) throw new Error('Nie można sprawdzić wykluczeń kontrahentów.');
  requireCompleteRead(excluded.data, excluded.count, 'wykluczeń kontrahentów');
  for (const contractor of excluded.data!) {
    if (contractor.tenant_id !== delivery.tenantId) {
      throw new ReminderConsentDenied('Nie można potwierdzić organizacji wykluczenia.');
    }
    const excludedNip = normalizeNip(contractor.nip);
    if (!/^\d{10}$/.test(excludedNip) || excludedNip === nip) {
      throw new ReminderConsentDenied('Przypomnienia dla tego kontrahenta są wstrzymane.');
    }
  }

  const cutoffAt = new Date(Date.now() - SAFETY_WINDOW_MS);
  const cutoffDay = cutoffAt.toISOString().slice(0, 10);
  const payments = await client.from('payments')
    .select('invoice_id,tenant_id,payment_date,created_at', { count: 'exact' })
    .eq('tenant_id', delivery.tenantId)
    .or('payment_date.gte.' + cutoffDay + ',created_at.gte.' + cutoffAt.toISOString())
    .limit(MAX_RECENT_ROWS + 1);
  if (payments.error) throw new Error('Nie można sprawdzić wpłat kontrahenta.');
  requireCompleteRead(payments.data, payments.count, 'ostatnich wpłat');
  const recentPayments = payments.data!;
  const invoiceIds = [...new Set(recentPayments.map((payment) => {
    if (payment.tenant_id !== delivery.tenantId || !payment.invoice_id) {
      throw new ReminderConsentDenied('Nie można potwierdzić organizacji ostatniej wpłaty.');
    }
    paymentDay(payment.payment_date);
    if (!Number.isFinite(Date.parse(payment.created_at))) {
      throw new ReminderConsentDenied('Nieprawidłowa data zapisu wpłaty.');
    }
    return payment.invoice_id;
  }))];
  if (invoiceIds.length > 0) {
    const byId = new Map<string, { id: string; tenant_id: string; buyer_nip: unknown; buyer_data: unknown }>();
    // Keep each GET URL comfortably below common proxy request-line limits.
    for (let offset = 0; offset < invoiceIds.length; offset += MAX_INVOICES_PER_QUERY) {
      const batch = invoiceIds.slice(offset, offset + MAX_INVOICES_PER_QUERY);
      const related = await client.from('invoices').select('id,tenant_id,buyer_nip,buyer_data')
        .in('id', batch).eq('tenant_id', delivery.tenantId);
      if (related.error) throw new Error('Nie można sprawdzić faktur ostatnich wpłat.');
      const relatedRows = related.data;
      if (!relatedRows || relatedRows.length !== batch.length ||
          relatedRows.some((linked) => linked.tenant_id !== delivery.tenantId || !batch.includes(linked.id))) {
        throw new ReminderConsentDenied('Nie można potwierdzić właściciela ostatniej wpłaty.');
      }
      for (const linked of relatedRows) byId.set(linked.id, linked);
    }
    if (byId.size !== invoiceIds.length) {
      throw new ReminderConsentDenied('Nie można potwierdzić wszystkich faktur ostatnich wpłat.');
    }
    for (const payment of recentPayments) {
      const linked = byId.get(payment.invoice_id);
      if (!linked) throw new ReminderConsentDenied('Nie można powiązać ostatniej wpłaty z fakturą.');
      const paidBy = invoiceNip(linked);
      if (!/^\d{10}$/.test(paidBy) || paidBy === nip) {
        throw new ReminderConsentDenied('Kontrahent mógł niedawno zapłacić. Sprawdź wpłaty przed wysyłką.');
      }
    }
  }

  // The imports table is only useful when a bank integration has populated it.
  // Keep matched and ignored rows: user-writable flags must not hide a transfer.
  // A transfer can be recorded today with an older transaction date.
  const imports = await client.from('payment_imports')
    .select('tenant_id,transaction_date,booking_date,imported_at,counterparty_nip', { count: 'exact' })
    .eq('tenant_id', delivery.tenantId).neq('amount', 0)
    .or('transaction_date.gte.' + cutoffDay + ',booking_date.gte.' + cutoffDay +
      ',imported_at.gte.' + cutoffAt.toISOString())
    .limit(MAX_RECENT_ROWS + 1);
  if (imports.error) throw new Error('Nie można sprawdzić importowanych wpłat.');
  requireCompleteRead(imports.data, imports.count, 'importowanych wpłat');
  for (const transfer of imports.data!) {
    if (transfer.tenant_id !== delivery.tenantId) {
      throw new ReminderConsentDenied('Nie można potwierdzić organizacji importowanej wpłaty.');
    }
    paymentDay(transfer.transaction_date);
    if (transfer.booking_date !== null) paymentDay(transfer.booking_date);
    if (!Number.isFinite(Date.parse(transfer.imported_at))) {
      throw new ReminderConsentDenied('Nieprawidłowa data importu wpłaty.');
    }
    const paidBy = normalizeNip(transfer.counterparty_nip);
    if (!/^\d{10}$/.test(paidBy) || paidBy === nip) {
      throw new ReminderConsentDenied('Kontrahent mógł niedawno zapłacić. Sprawdź wpłaty przed wysyłką.');
    }
  }
}

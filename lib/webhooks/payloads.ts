import type { SupabaseClient } from '@supabase/supabase-js';

import { expenseAmountsCurrency } from '@/lib/expenses/amounts-currency';
import { webhookEventId } from '@/lib/webhooks/event-id';
import type { WebhookEventType } from '@/lib/webhooks/types';
import type { Json } from '@/types/database';

/**
 * Treść zdarzeń webhooków (krok 7.1, część 3). Odczyt kluczem serwisowym
 * w jobie, zawsze z filtrem firmy zdarzenia.
 *
 * DANE: identyfikatory, numery, daty, stany i kwoty, te same nazwy pól co
 * w `GET /api/v1/…` (kwoty jako tekst z bazy, `::text`). BEZ danych osobowych:
 * bez nazw i NIP-ów stron, bez danych płatnika z wyciągu, bez uwag. Kto
 * potrzebuje więcej, pobiera obiekt kluczem API (`GET /api/v1/invoices/{id}`),
 * w zakresie klucza i z wpisem w dzienniku zdarzeń.
 *
 * `occurredAt` pochodzi z obiektu (nie z chwili joba): ponowna emisja po
 * awarii ma ten sam czas, a webhook dodany później nie dostanie starego zdarzenia.
 */

export interface WebhookEventDraft {
  eventId: string;
  type: WebhookEventType;
  occurredAt: string;
  data: Record<string, unknown>;
}

type Row = Record<string, unknown>;

const text = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

class WebhookPayloadReadError extends Error {
  constructor(what: string, code: string | undefined) {
    super(`webhooks: odczyt ${what} nieudany (${code ?? 'bez kodu'})`);
    this.name = 'WebhookPayloadReadError';
  }
}

async function one(query: PromiseLike<{ data: unknown; error: { code?: string } | null }>, what: string): Promise<Row | null> {
  const { data, error } = await query;
  if (error) throw new WebhookPayloadReadError(what, error.code);
  return (data ?? null) as Row | null;
}

async function invoiceAccepted(db: SupabaseClient, tenantId: string, invoiceId: string): Promise<WebhookEventDraft | null> {
  const row = await one(
    db
      .from('invoices')
      .select(
        'id, tenant_id, direction, internal_number, invoice_kind, issue_date, currency, net_total::text, vat_total::text, gross_total::text, ksef_status, ksef_number, ksef_accepted_at, ksef_environment, updated_at',
      )
      .eq('id', invoiceId)
      .eq('tenant_id', tenantId)
      .maybeSingle(),
    'faktury',
  );
  if (!row || row.direction !== 'outgoing' || row.ksef_status !== 'accepted' || !text(row.ksef_number)) return null;
  return {
    eventId: webhookEventId('invoice.ksef_accepted', invoiceId),
    type: 'invoice.ksef_accepted',
    occurredAt: String(row.ksef_accepted_at ?? row.updated_at),
    data: {
      invoice: {
        id: String(row.id),
        number: text(row.internal_number),
        direction: 'outgoing',
        kind: text(row.invoice_kind) ?? 'regular',
        issue_date: String(row.issue_date),
        currency: text(row.currency)?.toUpperCase() ?? 'PLN',
        net_total: text(row.net_total),
        vat_total: text(row.vat_total),
        gross_total: text(row.gross_total),
        ksef_status: 'accepted',
        ksef_number: text(row.ksef_number),
        ksef_accepted_at: text(row.ksef_accepted_at),
        ksef_environment: text(row.ksef_environment),
      },
    },
  };
}

/** Koszt ze skrzynki KSeF dla faktury otrzymanej `invoiceId` (jeden koszt na fakturę, 00121). */
async function expenseReceived(db: SupabaseClient, tenantId: string, invoiceId: string): Promise<WebhookEventDraft | null> {
  const expense = await one(
    db
      .from('expenses')
      .select(
        'id, document_number, document_type, issue_date, net_amount::text, vat_amount::text, gross_amount::text, is_reviewed, source, ksef_invoice_id, ocr_source:ocr_extracted_data->>source, ocr_currency:ocr_extracted_data->>currency, ocr_fx:ocr_extracted_data->fx, created_at',
      )
      .eq('tenant_id', tenantId)
      .eq('ksef_invoice_id', invoiceId)
      .eq('source', 'ksef_inbox')
      .maybeSingle(),
    'kosztu',
  );
  if (!expense) return null;
  const invoice = await one(
    db.from('invoices').select('id, ksef_number, currency').eq('id', invoiceId).eq('tenant_id', tenantId).maybeSingle(),
    'faktury kosztowej',
  );
  if (!invoice) return null;

  const issueDate = String(expense.issue_date);
  const trace = expense.ocr_source === null && expense.ocr_currency === null && expense.ocr_fx === null
    ? null
    : ({ source: text(expense.ocr_source), currency: text(expense.ocr_currency), fx: (expense.ocr_fx ?? null) as Json } as Json);
  return {
    eventId: webhookEventId('expense.ksef_received', invoiceId),
    type: 'expense.ksef_received',
    occurredAt: String(expense.created_at),
    data: {
      expense: {
        id: String(expense.id),
        document_number: text(expense.document_number),
        document_type: text(expense.document_type) ?? 'invoice',
        issue_date: issueDate,
        // Ta sama reguła co karta kosztu i `GET /api/v1/expenses`: bez potwierdzonej waluty `null`.
        currency: expenseAmountsCurrency({ source: 'ksef_inbox', issue_date: issueDate, ocr_extracted_data: trace }, text(invoice.currency)),
        net_amount: text(expense.net_amount) ?? '0.00',
        vat_amount: text(expense.vat_amount) ?? '0.00',
        gross_amount: text(expense.gross_amount) ?? '0.00',
        review_status: expense.is_reviewed === true ? 'reviewed' : 'unreviewed',
        source: 'ksef_inbox',
        invoice_id: invoiceId,
      },
      invoice: { id: invoiceId, ksef_number: text(invoice.ksef_number) },
    },
  };
}

async function paymentRecorded(db: SupabaseClient, tenantId: string, paymentId: string): Promise<WebhookEventDraft | null> {
  const payment = await one(
    db
      .from('payments')
      .select('id, invoice_id, amount::text, payment_date, payment_method, match_method, bank_import_id, created_at')
      .eq('id', paymentId)
      .eq('tenant_id', tenantId)
      .maybeSingle(),
    'wpłaty',
  );
  if (!payment) return null;
  const invoice = await one(
    db
      .from('invoices')
      .select('id, direction, internal_number, currency, gross_total::text, paid_amount::text, payment_status')
      .eq('id', String(payment.invoice_id))
      .eq('tenant_id', tenantId)
      .maybeSingle(),
    'faktury wpłaty',
  );
  if (!invoice || invoice.direction !== 'outgoing') return null;
  const source = payment.match_method === 'manual' ? 'manual' : payment.bank_import_id ? 'bank_statement' : 'other';
  return {
    eventId: webhookEventId('payment.recorded', paymentId),
    type: 'payment.recorded',
    occurredAt: String(payment.created_at),
    data: {
      payment: {
        id: String(payment.id),
        invoice_id: String(payment.invoice_id),
        amount: text(payment.amount),
        currency: text(invoice.currency)?.toUpperCase() ?? 'PLN',
        payment_date: String(payment.payment_date),
        method: text(payment.payment_method),
        source,
      },
      invoice: {
        id: String(invoice.id),
        number: text(invoice.internal_number),
        gross_total: text(invoice.gross_total),
        paid_amount: text(invoice.paid_amount) ?? '0.00',
        payment_status: text(invoice.payment_status) ?? 'unpaid',
      },
    },
  };
}

/** Treść zdarzenia albo `null`, gdy obiektu nie ma albo nie pasuje do zdarzenia. Błąd odczytu rzuca (ponowienie joba). */
export function buildWebhookEvent(
  db: SupabaseClient,
  input: { tenantId: string; type: WebhookEventType; entityId: string },
): Promise<WebhookEventDraft | null> {
  switch (input.type) {
    case 'invoice.ksef_accepted':
      return invoiceAccepted(db, input.tenantId, input.entityId);
    case 'expense.ksef_received':
      return expenseReceived(db, input.tenantId, input.entityId);
    case 'payment.recorded':
      return paymentRecorded(db, input.tenantId, input.entityId);
  }
}

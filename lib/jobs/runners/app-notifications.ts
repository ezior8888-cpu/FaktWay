import { AppNotificationInputError, writeAppNotification } from '@/lib/app-notifications/publish';
import {
  invoiceAcceptedNotification,
  invoiceRejectedNotification,
  paymentReceivedNotification,
} from '@/lib/app-notifications/texts';
import type { AppNotificationInput } from '@/lib/app-notifications/types';
import { outstandingOf } from '@/lib/invoices/amount-due';
import type { invoicePaymentReceived, invoiceSubmitFailed, invoiceSubmitSucceeded } from '@/lib/jobs/events';
import type { JobContext } from '@/lib/jobs/registry';
import { SEND_ERROR_CODES } from '@/lib/ksef/send-error-classes';
import { createAdminClient } from '@/lib/supabase/admin';
import { roundToCents } from '@/lib/xml/invoice-calculator';

import { NonRetriableError } from '../errors';
import { assertJobIdentity, InvoiceTenantMismatchError } from './tenant-boundary';

/**
 * Dzwonek w aplikacji (plan kompletnej aplikacji, krok 8.1, część 2, 00188):
 * trzecie kolejki zdarzeń wyniku wysyłki do KSeF, obok powiadomienia (mail,
 * push) i Offline24. Wzór: trzecia kolejka webhooków z #595. Wysyłka faktury
 * (`submit-invoice.ts`) i jej zdarzenia bez zmian.
 * Rejestracja pg-boss: `lib/jobs/handlers/app-notifications.ts`.
 *
 * O treści decyduje STAN FAKTURY w bazie, nie samo zdarzenie: „przyjęta” tylko
 * przy `accepted` z numerem KSeF, „odrzucona” tylko przy `rejected` (treść
 * odrzucona przez KSeF; przy błędzie schematu FA(3) przed wysyłką tekst mówi,
 * że faktura do KSeF nie trafiła). Błąd techniczny (`failed`, ponawia cron),
 * duplikat 440 czekający na decyzję klienta i blokada ROZ nie są odrzuceniem:
 * o nich mówią mail, push i lista faktur.
 *
 * PONOWIENIE OD ZERA (worker wykonuje cały handler jeszcze raz):
 * - odczyt faktury: tylko odczyt; błąd bazy rzuca, pg-boss ponawia;
 * - zapis: RPC z UNIQUE (odbiorca, firma, rodzaj, klucz obiektu) i ON CONFLICT
 *   DO NOTHING; ponowienie po zapisie trafia w ten sam klucz i zwraca 0;
 * - błąd zapisu rzuca (ponowienie), bo te kolejki nic innego nie robią.
 */

type SucceededData = Pick<Parameters<typeof invoiceSubmitSucceeded.create>[0], 'tenantId' | 'invoiceId'>;
type FailedData = Pick<
  Parameters<typeof invoiceSubmitFailed.create>[0],
  'tenantId' | 'invoiceId' | 'error' | 'manualReconciliationRequired'
>;

interface InvoiceState {
  internal_number: string | null;
  ksef_status: string | null;
  ksef_number: string | null;
  last_error_code: string | null;
}

async function readInvoice(invoiceId: string, tenantId: string): Promise<InvoiceState> {
  assertJobIdentity(invoiceId, tenantId);
  const { data, error } = await createAdminClient()
    .from('invoices')
    .select('id, tenant_id, internal_number, ksef_status, ksef_number, last_error_code')
    .eq('id', invoiceId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error) throw new Error(`Dzwonek: odczyt faktury nieudany (${error.message})`);
  if (!data || data.id !== invoiceId || data.tenant_id !== tenantId) throw new InvoiceTenantMismatchError();
  return data as InvoiceState;
}

async function write(input: AppNotificationInput): Promise<number> {
  try {
    return await writeAppNotification(input);
  } catch (error) {
    // Zły wpis to błąd kodu, nie chwilowa awaria: bez ponowień.
    if (error instanceof AppNotificationInputError) throw new NonRetriableError(error.message);
    throw error;
  }
}

/** `invoice.submit.succeeded.bell`: „Faktura przyjęta w KSeF”. */
export async function runAppNotificationInvoiceAccepted(data: SucceededData, _ctx: JobContext) {
  const invoice = await readInvoice(data.invoiceId, data.tenantId);
  if (invoice.ksef_status !== 'accepted' || !invoice.ksef_number) return { skipped: 'not-accepted' as const };
  const created = await write(
    invoiceAcceptedNotification({
      tenantId: data.tenantId,
      invoiceId: data.invoiceId,
      invoiceNumber: invoice.internal_number,
      ksefNumber: invoice.ksef_number,
    }),
  );
  return { created };
}

/** `invoice.submit.failed.bell`: „Faktura odrzucona w KSeF”. */
export async function runAppNotificationInvoiceRejected(data: FailedData, _ctx: JobContext) {
  // Lokalna blokada ROZ czeka na uzgodnienie; KSeF niczego nie odrzucił.
  if (data.manualReconciliationRequired) return { skipped: 'manual-reconciliation' as const };
  const invoice = await readInvoice(data.invoiceId, data.tenantId);
  if (invoice.ksef_status !== 'rejected') return { skipped: 'not-rejected' as const };
  const created = await write(
    invoiceRejectedNotification({
      tenantId: data.tenantId,
      invoiceId: data.invoiceId,
      invoiceNumber: invoice.internal_number,
      error: data.error,
      // Schemat FA(3) sprawdzany lokalnie przed wysyłką: plik do KSeF nie trafił.
      beforeKsef: invoice.last_error_code === SEND_ERROR_CODES.XSD_INVALID,
    }),
  );
  return { created };
}

// ─── Wpłata do faktury (krok 8.1, część 3, 00197) ───
//
// `invoice.payment.received.bell`: drugi odbiorca zdarzenia „wpłata zapisana”
// (obok pusha w `cancel-reminders-on-payment.ts`, który zostaje bez zmian).
// Zdarzenie wysyłają `recordInvoicePaymentAction` i `markInvoicePaidAction` tylko
// po wyniku „zapisano”; niesie fakturę i wpłatę, bez firmy. Firma pochodzi więc
// z wiersza wpłaty w bazie, a faktura musi być tą ze zdarzenia i należeć do tej
// samej firmy. Inaczej (para z dwóch firm albo dwóch faktur) błąd bez ponowień
// i bez wpisu.
//
// Stan PO tej wpłacie, nie stan w chwili zadania: suma wpłat liczonych tak jak
// w wyzwalaczu `recalculate_invoice_paid_amount` (00176: niecofnięte, bez
// niepotwierdzonych dopasowań z banku), zapisanych do tej wpłaty włącznie
// w kolejności zapisu. Zadanie, które ruszy po następnej wpłacie (np. worker
// wstaje po wdrożeniu), dalej opisuje swoją wpłatę jako częściową.
//
// PONOWIENIE OD ZERA: odczyty bez efektów; zapis z kluczem = wpłata (UNIQUE
// z 00188), więc ponowienie po zapisie zwraca 0. Błąd odczytu albo zapisu rzuca
// i pg-boss ponawia (2 razy). Wpłata cofnięta albo usunięta przed zadaniem:
// bez wpisu. Wpis zapisany przed cofnięciem zostaje (historia, jak push).

type PaymentReceivedData = Parameters<typeof invoicePaymentReceived.create>[0];

interface PaymentState {
  id: string;
  tenant_id: string;
  invoice_id: string;
  amount: number | string;
  voided_at: string | null;
  is_auto_matched: boolean;
  is_confirmed: boolean;
  created_at: string;
}

interface InvoiceForPayment {
  id: string;
  tenant_id: string;
  internal_number: string | null;
  invoice_kind: string | null;
  gross_total: number | string | null;
  payment_data: unknown;
  buyer_data: unknown;
  currency: string | null;
}

/** Wpłata liczy się do zapłaconej kwoty jak w `recalculate_invoice_paid_amount` (00176). */
function counts(payment: PaymentState): boolean {
  return payment.voided_at === null && (payment.is_auto_matched === false || payment.is_confirmed === true);
}

/** Kolejność zapisu: czas utworzenia, przy remisie identyfikator (ta sama przy każdym ponowieniu). */
function recordOrder(a: PaymentState, b: PaymentState): number {
  const byTime = Date.parse(a.created_at) - Date.parse(b.created_at);
  if (byTime !== 0 && Number.isFinite(byTime)) return byTime;
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function buyerNameOf(buyerData: unknown): string | null {
  if (typeof buyerData !== 'object' || buyerData === null || Array.isArray(buyerData)) return null;
  const name = (buyerData as Record<string, unknown>).name;
  return typeof name === 'string' && name.trim() !== '' ? name.trim() : null;
}

async function readPayment(paymentId: string): Promise<PaymentState | null> {
  // Kolumny wpisane wprost (nie ze stałej), żeby sprawdzał je strażnik `db-select-columns`.
  const { data, error } = await createAdminClient()
    .from('payments')
    .select('id, tenant_id, invoice_id, amount, voided_at, is_auto_matched, is_confirmed, created_at')
    .eq('id', paymentId)
    .maybeSingle();
  if (error) throw new Error(`Dzwonek: odczyt wpłaty nieudany (${error.message})`);
  return (data as PaymentState | null) ?? null;
}

async function readInvoiceForPayment(invoiceId: string, tenantId: string): Promise<InvoiceForPayment> {
  assertJobIdentity(invoiceId, tenantId);
  const { data, error } = await createAdminClient()
    .from('invoices')
    .select('id, tenant_id, internal_number, invoice_kind, gross_total, payment_data, buyer_data, currency')
    .eq('id', invoiceId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error) throw new Error(`Dzwonek: odczyt faktury nieudany (${error.message})`);
  if (!data || data.id !== invoiceId || data.tenant_id !== tenantId) throw new InvoiceTenantMismatchError();
  return data as InvoiceForPayment;
}

/** Wpłaty faktury w firmie wpłaty (także cofnięte: filtr liczenia jest w kodzie, jak w wyzwalaczu). */
async function readInvoicePayments(invoiceId: string, tenantId: string): Promise<PaymentState[]> {
  const { data, error } = await createAdminClient()
    .from('payments')
    .select('id, tenant_id, invoice_id, amount, voided_at, is_auto_matched, is_confirmed, created_at')
    .eq('tenant_id', tenantId)
    .eq('invoice_id', invoiceId);
  if (error) throw new Error(`Dzwonek: odczyt wpłat faktury nieudany (${error.message})`);
  return (data as PaymentState[] | null) ?? [];
}

/** `invoice.payment.received.bell`: „Otrzymana płatność” albo „Wpłata częściowa”. */
export async function runAppNotificationPaymentReceived(data: PaymentReceivedData, _ctx: JobContext) {
  // Zdarzenie sprzed kroku 8.1 nie mówi, której wpłaty dotyczy.
  if (!data.paymentId) return { skipped: 'no-payment-id' as const };
  const payment = await readPayment(data.paymentId);
  // „Cofnij” przy „Zapłacone” (undo_invoice_paid, 00158) usuwa wiersz wpłaty.
  if (!payment || payment.id !== data.paymentId) return { skipped: 'payment-not-found' as const };
  if (payment.invoice_id !== data.invoiceId) throw new NonRetriableError('Wpłata nie należy do faktury zadania');
  if (payment.voided_at !== null) return { skipped: 'payment-voided' as const };
  // Niepotwierdzone dopasowanie z banku nie jest zapłatą (wyzwalacz 00176 go nie liczy).
  if (!counts(payment)) return { skipped: 'payment-unconfirmed' as const };

  const invoice = await readInvoiceForPayment(data.invoiceId, payment.tenant_id);
  const payments = await readInvoicePayments(data.invoiceId, payment.tenant_id);
  const ordered = payments.filter((p) => p.tenant_id === payment.tenant_id && p.invoice_id === data.invoiceId).sort(recordOrder);
  const position = ordered.findIndex((p) => p.id === payment.id);
  // Wpłata zniknęła między odczytami (cofnięte „Zapłacone”): jak wyżej, bez wpisu.
  if (position < 0) return { skipped: 'payment-not-found' as const };
  const paidAfter = roundToCents(
    ordered.slice(0, position + 1).filter(counts).reduce((sum, p) => sum + Number(p.amount), 0),
  );
  const remaining = outstandingOf({
    invoice_kind: invoice.invoice_kind,
    gross_total: invoice.gross_total,
    payment_data: invoice.payment_data,
    paid_amount: paidAfter,
  });

  const created = await write(
    paymentReceivedNotification({
      tenantId: payment.tenant_id,
      invoiceId: data.invoiceId,
      paymentId: payment.id,
      invoiceNumber: invoice.internal_number,
      buyerName: buyerNameOf(invoice.buyer_data),
      amount: roundToCents(Number(payment.amount)),
      remaining,
      // Brak waluty to PLN, jak w `record_invoice_payment` (00176).
      currency: invoice.currency?.trim() || 'PLN',
    }),
  );
  return { created };
}

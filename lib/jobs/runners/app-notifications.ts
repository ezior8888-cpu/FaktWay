import { AppNotificationInputError, writeAppNotification } from '@/lib/app-notifications/publish';
import { invoiceAcceptedNotification, invoiceRejectedNotification } from '@/lib/app-notifications/texts';
import type { AppNotificationInput } from '@/lib/app-notifications/types';
import type { invoiceSubmitFailed, invoiceSubmitSucceeded } from '@/lib/jobs/events';
import type { JobContext } from '@/lib/jobs/registry';
import { SEND_ERROR_CODES } from '@/lib/ksef/send-error-classes';
import { createAdminClient } from '@/lib/supabase/admin';

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

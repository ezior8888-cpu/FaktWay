// Po wpłacie przy fakturze: push „Otrzymana płatność” / „Wpłata częściowa”
// (krok 8.1 planu kompletnej aplikacji).
// Decyzja: sam push. Nazwa runnera i kolejki zostaje (zmiana to ryzyko przy
// wdrożeniu), ale job NIE dotyka `payment_reminders`: anulowanie przypomnień
// po pełnej zapłacie robią funkcje bazy 00158 i 00176, a watchdog `pending`
// (wiersz > 30 min = „sprawdź, czy wiadomość wyszła”) zostaje nietknięty.
// Ponowienie: push idzie z tym samym `tag`, więc przeglądarka go zastępuje.

import { invoicePaymentReceived } from '@/lib/jobs/events';
import type { JobContext } from '@/lib/jobs/registry';
import { createAdminClient } from '@/lib/supabase/admin';
import { sendPushToTenant } from '@/lib/push/sender';
import { amountDueOf } from '@/lib/invoices/amount-due';
import { formatPlMoney } from '@/lib/format/pl';

/**
 * Runner joba (worker pg-boss).
 * Rejestracja pg-boss: lib/jobs/handlers/package-b.ts
 */
export async function runCancelRemindersOnPayment(data: Parameters<typeof invoicePaymentReceived.create>[0], { step }: JobContext) {
    const { invoiceId, paymentId } = data;
    const supabase = createAdminClient();

    const invoice = await step.run('check-invoice', async () => {
      const { data, error } = await supabase
        .from('invoices')
        .select('paid_amount, gross_total, tenant_id, internal_number, invoice_kind, payment_data, buyer_data')
        .eq('id', invoiceId)
        .maybeSingle();

      if (error) throw new Error(error.message);
      return data;
    });

    if (!invoice) {
      return { skipped: true as const, reason: 'invoice-not-found' as const };
    }

    const paid = Number(invoice.paid_amount ?? 0);
    const gross = Number(invoice.gross_total ?? 0);
    // ROZ: zapłacona w całości znaczy „paid >= payment_data.amountDue”, nie
    // „paid >= gross_total” — inaczej ROZ ze rozliczoną zaliczką nigdy nie
    // odwołałaby swoich przypomnień (C-16, 00145).
    const due = amountDueOf({
      invoice_kind: invoice.invoice_kind, gross_total: invoice.gross_total,
      payment_data: invoice.payment_data,
    });
    const isFullyPaid = paid >= due;

    if (gross <= 0) {
      return { skipped: true as const, reason: 'brak_kwoty_brutto' as const };
    }

    const pushResult = await step.run('push-payment-received', async () => {
      if (!invoice.tenant_id) {
        return { skipped: true as const, reason: 'no-tenant' as const };
      }
      // Bez `paymentId` (zdarzenie sprzed 8.1) nie mamy kwoty wpłaty: bez pusha.
      if (!paymentId) {
        return { skipped: true as const, reason: 'no-payment-id' as const };
      }
      const { data: payment, error } = await supabase
        .from('payments')
        .select('amount, voided_at')
        .eq('id', paymentId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      // Wpłatę cofnięto, zanim job ruszył: nie ma o czym powiadamiać.
      if (!payment || payment.voided_at) {
        return { skipped: true as const, reason: 'payment-voided' as const };
      }

      const label = invoice.internal_number?.trim()
        ? invoice.internal_number
        : invoiceId.slice(0, 8);
      const amount = `${formatPlMoney(Number(payment.amount))} zł`;
      const buyer = buyerNameOf(invoice.buyer_data);
      const tag = `payment-${paymentId}`;
      if (isFullyPaid) {
        return sendPushToTenant(invoice.tenant_id, 'payment_received', {
          title: 'Otrzymana płatność',
          body: `Otrzymana płatność: ${amount} za ${label}${buyer ? ` od ${buyer}` : ''}`,
          url: '/payments',
          tag,
        });
      }
      return sendPushToTenant(invoice.tenant_id, 'payment_received', {
        title: 'Wpłata częściowa',
        body: `Wpłata częściowa: ${amount} za ${label}, zostało ${formatPlMoney(Math.max(due - paid, 0))} zł`,
        url: '/payments',
        tag,
      });
    });

    return { push: pushResult };
}

function buyerNameOf(buyerData: unknown): string | null {
  if (typeof buyerData !== 'object' || buyerData === null) return null;
  const name = (buyerData as Record<string, unknown>).name;
  return typeof name === 'string' && name.trim() !== '' ? name.trim() : null;
}

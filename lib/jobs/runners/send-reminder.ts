import { NonRetriableError } from '../errors';
import { Resend } from 'resend';
import { z } from 'zod';
import { remindersSendRequested } from '@/lib/jobs/events';
import { requireApprovalId } from '@/lib/flo/approval';
import { isKindEnabledForTenant } from '@/lib/flo/kind-switch';
import { getGlobalFlagForExecution } from '@/lib/feature-flags/global-flags';
import { isKindEnabled } from '@/lib/flo/flags';
import type { JobContext } from '@/lib/jobs/registry';
import { createAdminClient } from '@/lib/supabase/admin';
import { assertDeliveryDeadline, readReminderDispatch, recordReminderReceipt } from '@/lib/reminders/delivery-consent';
import { assertReminderSendable } from '@/lib/reminders/delivery-safety';
import { ReminderConsentDenied } from '@/lib/reminders/delivery-errors';
import { deliveryHtml } from '@/lib/reminders/delivery-schema';
import { uploadToR2 } from '@/lib/storage/r2';
import { isEmailBlocked } from '@/lib/email/preferences';
import { REMINDER_TAG } from '@/lib/email/tags';

export async function runSendReminder(data: Parameters<typeof remindersSendRequested.create>[0], { step }: JobContext) {
  const { reminderId, approvalId } = data;
  try {
    requireApprovalId(approvalId, 'Wysyłka przypomnienia');
    if (!z.string().uuid().safeParse(reminderId).success || reminderId !== approvalId) throw new Error();
  } catch {
    throw new NonRetriableError('Brak zapisanej zgody na tę wysyłkę. Przygotuj nowy podgląd.');
  }
  const supabase = createAdminClient();
  // New step name intentionally invalidates the legacy sender's cached state.
  // All live authorization reads occur INSIDE the same callback as the send.
  // Inngest may restore a completed send; pg-boss reruns it with the SAME key.
  const outcome = await step.run('send-approved-reminder-v2', async () => {
    let dispatch;
    try { dispatch = await readReminderDispatch(approvalId); }
    catch (error) {
      if (error instanceof ReminderConsentDenied || error instanceof z.ZodError) throw new NonRetriableError('Nie można potwierdzić zapisanej zgody na tę wiadomość.');
      throw new Error('Odczyt zgody jest chwilowo niedostępny.');
    }
    const { approval, delivery } = dispatch;
    // Receipt is in the service-only ledger, not the client-writable reminder.
    // A confirmed delivery needs bookkeeping, not new sending permission.
    if (dispatch.receipt) return { skipped: false as const, delivery, ...dispatch.receipt };
    const loaded = await supabase.from('payment_reminders').select('id, tenant_id, invoice_id, stage, channel, status')
      .eq('id', reminderId).eq('tenant_id', delivery.tenantId).eq('invoice_id', delivery.invoiceId).maybeSingle();
    if (loaded.error) throw new Error('Odczyt przypomnienia jest chwilowo niedostępny.');
    if (!loaded.data || loaded.data.id !== reminderId || loaded.data.tenant_id !== delivery.tenantId ||
        loaded.data.invoice_id !== delivery.invoiceId || loaded.data.stage !== delivery.stage || loaded.data.channel !== 'email') {
      throw new NonRetriableError('Przypomnienie nie należy do zatwierdzonej organizacji i faktury.');
    }
    if (loaded.data.status !== 'pending') return { skipped: true as const, reason: 'already-' + loaded.data.status };
    try {
      if (!['executing', 'done', 'approved'].includes(dispatch.proposal.status)) throw new ReminderConsentDenied('Zgoda na wysyłkę została wycofana.');
      const member = await supabase.from('memberships').select('user_id')
        .eq('user_id', approval.user_id).eq('organization_id', delivery.tenantId).eq('status', 'active').maybeSingle();
      if (member.error) throw new Error('Nie można sprawdzić dostępu do organizacji.');
      if (!member.data) throw new ReminderConsentDenied('Osoba zatwierdzająca nie ma już dostępu do organizacji.');
      if (!isKindEnabled('payment.chase') || !(await isKindEnabledForTenant('payment.chase', delivery.tenantId, undefined, () => getGlobalFlagForExecution('killFloAgent'))).enabled) {
        throw new ReminderConsentDenied('Wysyłka przypomnień została wstrzymana.');
      }
      await assertReminderSendable(delivery);
      // Adres z twardym odbiciem albo skargą („to spam”) — nie wysyłamy,
      // reputacja domeny jest wspólna dla wszystkich klientów (AUD-80).
      const blocked = await isEmailBlocked(delivery.to);
      if (blocked.blocked) {
        throw new ReminderConsentDenied('Adres kontrahenta odrzuca naszą pocztę (odbicie albo zgłoszenie spamu). Wysyłka wstrzymana.');
      }
      // At most 30 minutes, strictly inside Resend's documented 24h key retention.
      // Do not reset this clock on retry, including after an ambiguous response.
      assertDeliveryDeadline(approval, delivery);
    } catch (error) {
      if (error instanceof ReminderConsentDenied || error instanceof z.ZodError) throw new NonRetriableError(error instanceof ReminderConsentDenied ? error.message : 'Nieprawidłowe dane zgody.');
      throw new Error('Weryfikacja warunków wysyłki jest chwilowo niedostępna.');
    }
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey || apiKey.startsWith('re_xxxx')) throw new NonRetriableError('Brak konfiguracji dostawcy poczty.');
    const result = await new Resend(apiKey).emails.send({
      from: delivery.from, to: delivery.to, replyTo: delivery.replyTo ?? undefined,
      subject: delivery.subject, text: delivery.text, html: deliveryHtml(delivery.text),
      attachments: delivery.attachment ? [{ filename: delivery.attachment.filename,
        content: delivery.attachment.contentBase64 }] : undefined,
      // Po tym znaczniku webhook Resend odróżnia skargę kontrahenta od skargi
      // użytkownika FaktWay i nie wypisuje użytkownika o tym samym adresie.
      tags: [{ name: REMINDER_TAG.name, value: REMINDER_TAG.value }],
    }, { idempotencyKey: 'reminder/' + approvalId });
    if (result.error || !result.data?.id) throw new Error('Nie można potwierdzić przyjęcia wiadomości przez dostawcę poczty.');
    const sentAt = new Date().toISOString();
    await recordReminderReceipt(approval, delivery, result.data.id, sentAt);
    return { skipped: false as const, messageId: result.data.id, delivery, sentAt };
  });
  if (outcome.skipped) return outcome;
  const { delivery, messageId, sentAt } = outcome;
  // Once delivery is confirmed, finish bookkeeping even if the consent expires.
  const pdfPath = await step.run('archive-approved-reminder-pdf-v2', async () => {
    if (!delivery.attachment) return null;
    const path = 'reminders/' + delivery.tenantId + '/' + reminderId + '.pdf';
    await uploadToR2(path, Buffer.from(delivery.attachment.contentBase64, 'base64'), 'application/pdf');
    return path;
  });
  await step.run('record-approved-reminder-v2', async () => {
    const written = await supabase.from('payment_reminders').update({
      status: 'sent', sent_at: sentAt, email_message_id: messageId,
      email_subject: delivery.subject, email_body: delivery.text,
      pdf_attachment_path: pdfPath, days_overdue_at_send: delivery.daysOverdue,
    }).eq('id', reminderId).eq('tenant_id', delivery.tenantId).eq('invoice_id', delivery.invoiceId)
      .eq('stage', delivery.stage).eq('channel', 'email').select('id').maybeSingle();
    if (written.error || !written.data) throw new Error('Nie udało się zapisać potwierdzenia wysyłki.');
  });
  return { success: true as const, messageId, stage: delivery.stage, hasPdf: !!pdfPath };
}


import 'server-only';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/admin';
import { DISCLAIMER } from '@/lib/flo/functions/payment-chase';
import { generateDemandLetterPdf } from './pdf-demand-letter';
import { DEFAULT_TEMPLATES, formatDatePl, formatPln } from './templates';
import { MAX_REMINDER_PDF_BYTES, REMINDER_DELIVERY_TTL_MS, reminderDeliverySchema, reminderInvoiceFingerprint, isReminderInvoiceChaseable } from './delivery-schema';
import { assertNoRelatedInvoice } from './reconciliation-guard';
import { outstandingOf } from '@/lib/invoices/amount-due';
import type { ReminderDelivery, ReminderDeliveryStage } from '@/types/reminder-delivery';
import type { Json } from '@/types/database';

function object(value: Json | null): Record<string, Json | undefined> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function text(value: unknown, maximum = 5000): string {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string' || value.length > maximum || /[\x00]/.test(value)) throw new Error('Nieprawidłowe dane podglądu.');
  return value.trim();
}
function address(value: Json | null | undefined): string {
  if (typeof value === 'string') return text(value);
  const row = object(value ?? null);
  return [text(row.addressLine1), text(row.addressLine2)].filter(Boolean).join(', ');
}
function date(iso: string | null): Date {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) throw new Error('Brak poprawnej daty faktury.');
  const value = new Date(iso + 'T00:00:00.000Z');
  if (!Number.isFinite(value.getTime()) || value.toISOString().slice(0, 10) !== iso) throw new Error('Nieprawidłowa data faktury.');
  return value;
}
/** Nasz nadawca: `RESEND_FROM_TRANSACTIONAL` („Nazwa <adres>”) albo `RESEND_FROM_EMAIL` — ta sama kolejność co `lib/email/send.ts`. */
function platformSenderAddress(): string {
  const raw = (process.env.RESEND_FROM_TRANSACTIONAL ?? process.env.RESEND_FROM_EMAIL ?? '').trim();
  return raw.match(/<([^<>]+)>\s*$/)?.[1] ?? raw;
}
function email(value: unknown): string {
  const result = z.email().max(254).safeParse(text(value, 254));
  if (!result.success) throw new Error('Brak poprawnego adresu email dla przypomnienia.');
  return result.data;
}

/** Read-only preparation. Its exact result is shown to the user before approval. */
export async function buildReminderDelivery(
  tenantId: string, invoiceId: string, stage: ReminderDeliveryStage, recipientEmail?: string,
): Promise<ReminderDelivery> {
  if (!z.uuid().safeParse(tenantId).success || !z.uuid().safeParse(invoiceId).success ||
      !['stage_1', 'stage_2', 'stage_3', 'stage_4'].includes(stage)) throw new Error('Nieprawidłowe dane przypomnienia.');
  const devTo = process.env.RESEND_DEV_TO_OVERRIDE?.trim();
  if (devTo && process.env.NODE_ENV === 'production') throw new Error('Przekierowanie testowych przypomnień jest niedozwolone na produkcji.');
  const client = createAdminClient();
  const invoiceResult = await client.from('invoices').select('*').eq('id', invoiceId).eq('tenant_id', tenantId).maybeSingle();
  const invoice = invoiceResult.data;
  if (invoiceResult.error || !invoice || invoice.id !== invoiceId || invoice.tenant_id !== tenantId) throw new Error('Nie udało się odczytać faktury tej organizacji.');
  if (!isReminderInvoiceChaseable(invoice)) throw new Error('Korekta, faktura rozliczeniowa lub faktura o niepotwierdzonym rodzaju nie może otrzymać przypomnienia.');
  const gross = Number(invoice.gross_total); const paid = Number(invoice.paid_amount);
  // ROZ: zaległość liczymy od `payment_data.amountDue` (reszta po
  // zaliczkach), nie od `gross_total` — inaczej ponaglenie żądałoby całego
  // zamówienia, choć część już rozliczono zaliczką (C-16, 00145).
  const outstanding = outstandingOf({
    invoice_kind: invoice.invoice_kind, gross_total: invoice.gross_total,
    payment_data: invoice.payment_data, paid_amount: invoice.paid_amount,
  });
  if (invoice.gross_total === null || invoice.paid_amount === null || !Number.isFinite(gross) || !Number.isFinite(paid) || gross <= 0 || paid < 0 || outstanding <= 0 ||
      invoice.reminders_paused || invoice.direction !== 'outgoing' || invoice.ksef_status !== 'accepted' || invoice.payment_status === 'paid') {
    throw new Error('Ta faktura nie wymaga przypomnienia albo przypomnienia są wstrzymane.');
  }
  // Existing demand-letter wording and formatter are specifically in PLN.
  if (invoice.currency !== null && invoice.currency !== 'PLN') throw new Error('Podgląd przypomnienia obsługuje obecnie faktury w PLN.');
  await assertNoRelatedInvoice(client, tenantId, invoiceId);
  const preparedAt = new Date(); const due = date(invoice.payment_due_date); date(invoice.issue_date);
  const today = Date.UTC(preparedAt.getUTCFullYear(), preparedAt.getUTCMonth(), preparedAt.getUTCDate());
  const daysOverdue = Math.floor((today - due.getTime()) / 86400000);
  if (daysOverdue < 0) throw new Error('Termin płatności jeszcze nie minął.');
  const tenantResult = await client.from('tenants').select('id, name, nip, address_json').eq('id', tenantId).maybeSingle();
  const settingsResult = await client.from('reminder_settings').select('tenant_id, sender_name, sender_email, reply_to_email').eq('tenant_id', tenantId).maybeSingle();
  const templateResult = await client.from('reminder_templates').select('tenant_id, stage, email_subject, email_body').eq('tenant_id', tenantId).eq('stage', stage).eq('is_default', false).maybeSingle();
  const tenant = tenantResult.data; const settings = settingsResult.data; const template = templateResult.data;
  if (tenantResult.error || !tenant || tenant.id !== tenantId || settingsResult.error || templateResult.error ||
      (settings && settings.tenant_id !== tenantId) || (template && (template.tenant_id !== tenantId || template.stage !== stage))) {
    throw new Error('Nie udało się przygotować wiadomości tej organizacji.');
  }
  const buyer = object(invoice.buyer_data); const payment = object(invoice.payment_data);
  const buyerEmail = email(recipientEmail ?? buyer.email); const to = devTo ? email(devTo) : buyerEmail;
  const senderName = text(settings?.sender_name, 200) || text(tenant.name, 200);
  if (!senderName || /[<>\r\n\x00-\x1f\x7f]/.test(senderName)) throw new Error('Nieprawidłowa nazwa nadawcy.');
  // „Od:” zawsze z NASZEJ zweryfikowanej domeny. Resend wysyła tylko z domen
  // zweryfikowanych na koncie FaktWay: adres firmy klienta (formularz
  // podpowiadał „faktury@twoja-firma.pl”) kończył się odmową dostawcy
  // i spaloną jednorazową zgodą na etap, a adres w naszej domenie pozwalał
  // firmie podszyć się pod FaktWay. Adres firmy idzie do Reply-To.
  const fromEmail = email(platformSenderAddress());
  const replyToRaw = text(settings?.reply_to_email, 254) || text(settings?.sender_email, 254);
  const replyTo = replyToRaw ? email(replyToRaw) : null;
  const invoiceLabel = text(invoice.internal_number, 150) || text(invoice.ksef_number, 150) || 'bez numeru';
  const bankAccount = text(payment.bankAccount, 100);
  const source = template ? { subject: text(template.email_subject, 998), body: text(template.email_body, 20000) } : DEFAULT_TEMPLATES[stage];
  if (!source.subject || !source.body) throw new Error('Szablon przypomnienia jest pusty.');
  const variables: Record<string, string | number> = {
    numerFaktury: invoiceLabel, kwota: formatPln(gross), kwotaDoZaplaty: formatPln(outstanding),
    dataWystawienia: formatDatePl(invoice.issue_date), terminPlatnosci: formatDatePl(invoice.payment_due_date!),
    dniPoTerminie: daysOverdue, nazwaFirmy: text(tenant.name), nazwaKontrahenta: text(buyer.name),
    rachunekBankowy: bankAccount, imieNadawcy: senderName, linkPlatnosci: '',
  };
  // Callback replacement preserves literal dollar signs and never interprets source data as markup.
  const substitute = (value: string) => value.replace(/\{([a-zA-Z]+)\}/g, (placeholder, key: string) =>
    Object.hasOwn(variables, key) ? String(variables[key]) : placeholder);
  const subject = substitute(source.subject);
  const plainBody = substitute(source.body);
  const body = plainBody.includes(DISCLAIMER) ? plainBody : plainBody + '\n\n' + DISCLAIMER;
  let attachment: ReminderDelivery['attachment'] = null;
  if (stage === 'stage_3' || stage === 'stage_4') {
    const sellerAddress = address(tenant.address_json);
    const buffer = await generateDemandLetterPdf({
      sellerName: text(tenant.name), sellerNip: text(tenant.nip), sellerAddress,
      buyerName: text(buyer.name), buyerNip: text(buyer.nip) || text(invoice.buyer_nip) || undefined,
      buyerAddress: address(buyer.address), invoiceNumber: invoiceLabel, issueDate: invoice.issue_date,
      dueDate: invoice.payment_due_date!, grossAmount: gross, paidAmount: paid, amountDue: outstanding,
      bankAccount, daysOverdue, senderName, senderEmail: replyTo ?? fromEmail,
      placeOfIssue: sellerAddress.match(/\d{2}-\d{3}\s+([^,]+)/)?.[1]?.trim() || 'Polska',
      letterDate: preparedAt.toISOString().slice(0, 10),
    });
    if (!Buffer.isBuffer(buffer) || buffer.length > MAX_REMINDER_PDF_BYTES) throw new Error('Załącznik przekracza limit podglądu.');
    const safeLabel = invoiceLabel.replace(/[\/\\\x00-\x1f\x7f]/g, '-');
    attachment = { filename: 'Wezwanie-' + safeLabel + '.pdf', contentBase64: buffer.toString('base64') };
  }
  return reminderDeliverySchema.parse({
    version: 1, tenantId, invoiceId, stage, preparedAt: preparedAt.toISOString(),
    expiresAt: new Date(preparedAt.getTime() + REMINDER_DELIVERY_TTL_MS).toISOString(),
    sourceFingerprint: reminderInvoiceFingerprint(invoice), from: senderName + ' <' + fromEmail + '>',
    to, replyTo, subject: devTo ? '[DEV → ' + buyerEmail + '] ' + subject : subject,
    text: body, attachment, daysOverdue,
  });
}

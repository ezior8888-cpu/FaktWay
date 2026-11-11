import 'server-only';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { isReceiptInvoiceColumns, isReceiptInvoiceFa3 } from '@/lib/invoices/receipt-invoice';
import type { ReminderDelivery, ReminderInvoiceSource } from '@/types/reminder-delivery';

export const MAX_REMINDER_PDF_BYTES = 512 * 1024;
export const REMINDER_DELIVERY_TTL_MS = 30 * 60 * 1000;
export const REMINDER_INVOICE_SELECT = 'id,tenant_id,gross_total,paid_amount,currency,payment_status,direction,ksef_status,origin,invoice_kind,invoice_type,payment_due_date,issue_date,internal_number,ksef_number,buyer_data,buyer_nip,payment_data,seller_data,reminders_paused';

/** Wiersz faktury z całym `fa3_data` (`select('*')`) albo z aliasami `receipt` i `ksef_fp`. */
export interface ReminderChaseCandidate {
  origin?: unknown;
  invoice_kind?: unknown;
  invoice_type?: unknown;
  internal_number?: unknown;
  fa3_data?: unknown;
  /** `fa3_data->receipt` */
  receipt?: unknown;
  /** `fa3_data->ksefMarkers->>fp` */
  ksef_fp?: unknown;
}

/** Faktura do paragonu (FaktWay albo import KSeF), rozpoznana funkcją z `lib/invoices/receipt-invoice.ts`. */
export function isReceiptInvoice(invoice: ReminderChaseCandidate): boolean {
  return isReceiptInvoiceFa3(invoice.fa3_data) || isReceiptInvoiceColumns(invoice.receipt, invoice.ksef_fp);
}

const NOT_CHASEABLE_MESSAGE =
  'Korekta, faktura rozliczeniowa lub faktura o niepotwierdzonym rodzaju nie może otrzymać przypomnienia.';

/**
 * Komunikat odmowy przypomnienia dla faktury, której `isReminderInvoiceChaseable` nie przepuszcza.
 * FP: z numerem dokumentu i tym, co zrobić (wyjście: Pomoc, gdy klient jednak nie zapłacił).
 */
export function reminderRefusalMessage(invoice: ReminderChaseCandidate): string {
  if (!isReceiptInvoice(invoice)) return NOT_CHASEABLE_MESSAGE;
  const number = typeof invoice.internal_number === 'string' && invoice.internal_number.trim()
    ? ` ${invoice.internal_number.trim()}` : '';
  return `Faktura do paragonu${number} jest zapłacona przy kasie, więc FaktWay nie wysyła do niej przypomnień o płatności. ` +
    'Jeśli klient jednak nie zapłacił, napisz do nas przez Pomoc.';
}

/** Imported corrections can have invoice_kind=regular, so both stored classifications must be safe.
 * Final/ROZ była wykluczona, dopóki do zapłaty liczyło się od gross_total
 * (kwota zaliczki wyglądała jak własny dług). Od C-16 (00145) wyzwalacz
 * i widok zaległości liczą ROZ od `payment_data.amountDue`, więc jest
 * ścigalna jak każda inna faktura.
 */
export function isReminderInvoiceChaseable(invoice: ReminderChaseCandidate): boolean {
  // Krok 1.2: sprzedaż z paragonu jest zapłacona przy kasie, a FP dostaje termin płatności
  // z formularza. Status płatności zostaje, ale FP nie jest zaległością ani celem przypomnienia.
  if (isReceiptInvoice(invoice)) return false;
  // Imported history has no trustworthy payment reconciliation.
  return invoice.origin === 'app' && (
    (invoice.invoice_kind === 'regular' && (invoice.invoice_type === 'VAT' || invoice.invoice_type === 'UPR')) ||
    (invoice.invoice_kind === 'advance' && invoice.invoice_type === 'ZAL') ||
    (invoice.invoice_kind === 'final' && invoice.invoice_type === 'ROZ')
  );
}

const email = z.string().min(3).max(254).email().refine((value) => value === value.trim());
const header = z.string().min(1).max(998).refine((value) => !/[\r\n\x00-\x1f\x7f]/.test(value));
const from = header.refine((value) => {
  const match = /^([^<>]+) <([^<>]+)>$/.exec(value);
  return !!match && match[1].trim().length > 0 && email.safeParse(match[2]).success;
});
const attachment = z.object({
  filename: z.string().min(5).max(200).regex(/^[^\/\\\x00-\x1f\x7f]+\.pdf$/i),
  contentBase64: z.string().min(8).max(4 * Math.ceil(MAX_REMINDER_PDF_BYTES / 3))
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
    .refine((value) => {
      const bytes = Buffer.from(value, 'base64');
      return bytes.length <= MAX_REMINDER_PDF_BYTES && bytes.subarray(0, 5).toString('ascii') === '%PDF-' && bytes.toString('base64') === value;
    }),
}).strict();

export const reminderDeliverySchema: z.ZodType<ReminderDelivery> = z.object({
  version: z.literal(1), tenantId: z.uuid(), invoiceId: z.uuid(),
  stage: z.enum(['stage_1', 'stage_2', 'stage_3', 'stage_4']),
  preparedAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
  sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  from, to: email, replyTo: email.nullable(), subject: header,
  text: z.string().min(1).max(20000).refine((value) => !value.includes('\0')),
  attachment: attachment.nullable(), daysOverdue: z.number().int().min(0).max(365000),
}).strict().refine((value) => {
  const interval = Date.parse(value.expiresAt) - Date.parse(value.preparedAt);
  return interval > 0 && interval <= REMINDER_DELIVERY_TTL_MS;
}, 'Nieprawidłowe okno ważności podglądu.').refine((value) =>
  (value.stage === 'stage_3' || value.stage === 'stage_4') === (value.attachment !== null),
'Załącznik nie odpowiada etapowi przypomnienia.');

/** Only escaped plaintext is rendered; template HTML never becomes executable markup. */
export function deliveryHtml(text: string): string {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  return '<p>' + escaped.replace(/\r\n|\r|\n/g, '<br>') + '</p>';
}
function canonical(value: unknown, depth = 0): string {
  if (depth > 30) throw new Error('Nieprawidłowe dane faktury.');
  if (value === null) return 'null';
  if (typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map((item) => canonical(item, depth + 1)).join(',') + ']';
  if (typeof value === 'object' && value && Object.getPrototypeOf(value) === Object.prototype) {
    return '{' + Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => JSON.stringify(key) + ':' + canonical(item, depth + 1)).join(',') + '}';
  }
  throw new Error('Nieprawidłowe dane faktury.');
}
/** Fresh reads use the same fields; changes to amounts, routing or invoice status invalidate consent. */
export function reminderInvoiceFingerprint(invoice: ReminderInvoiceSource): string {
  const facts = Object.fromEntries(REMINDER_INVOICE_SELECT.split(',').map((key) => {
    const value = invoice[key as keyof ReminderInvoiceSource];
    if (value === undefined) throw new Error('Niepełne dane faktury.');
    return [key, value];
  }));
  const serialized = canonical(facts);
  if (serialized.length > 250000) throw new Error('Dane faktury przekraczają limit podglądu.');
  return createHash('sha256').update(serialized).digest('hex');
}

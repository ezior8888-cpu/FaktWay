/**
 * Wysyłka emaili notyfikacyjnych przez Resend + React Email.
 *
 * Zachowanie:
 *   - `RESEND_API_KEY` nieustawiony / placeholder `re_xxxx...` → log do
 *     stdout + `{ sent: false, reason: 'not-configured' }` (DEV UX: nie
 *     wyrzucamy błędu, bo Inngest by retrywał w kółko przez 5 minut).
 *   - `RESEND_API_KEY` poprawny → prawdziwy send; błąd Resend = throw,
 *     żeby Inngest retryował (retries: 2 w notify-user jobach).
 *
 * Templatki żyją w `lib/email/templates/*.tsx` (React Email) i są
 * renderowane przez `@react-email/render` do stringa HTML.
 */
import { render } from '@react-email/render';
import { logger } from '@/lib/observability/logger';
import { isSensitiveDebugAllowed } from '@/lib/security/debug';
import { Resend } from 'resend';

import AccountDeletionConfirmation from './templates/AccountDeletionConfirmation';
import CertExpiry from './templates/CertExpiry';
import GdprDeletionScheduled from './templates/GdprDeletionScheduled';
import InvoiceAccepted from './templates/InvoiceAccepted';
import InvoiceDuplicateDecision, { duplicateDecisionSubject } from './templates/InvoiceDuplicateDecision';
import InvoiceFailed from './templates/InvoiceFailed';
import MagicImportCompleted from './templates/MagicImportCompleted';
import PaymentFailed from './templates/PaymentFailed';
import RefundIssued from './templates/RefundIssued';
import TrialEnding from './templates/TrialEnding';

// ═══════════════════════════════════════════════════════════════
// KONFIGURACJA
// ═══════════════════════════════════════════════════════════════

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
/**
 * Domyślny nadawca z domeny FaktWay (AUD-97). Do 02.10 był to
 * `onboarding@resend.dev` — domena dostawcy, którą Resend przyjmuje tylko na
 * koncie testowym. Produkcja ustawia RESEND_FROM_* jawnie.
 */
// Apeks domeny, bo tylko on ma DKIM w Resend — subdomena bez weryfikacji
// odrzuciłaby wysyłkę. Te same adresy co RESEND_FROM_* na produkcji.
const DEFAULT_FROM = 'FaktWay <powiadomienia@faktway.pl>';

/** Pusta zmienna to brak zmiennej — `??` przepuszczał pusty napis. */
function envSender(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

/**
 * DEV-only override: Resend na FREE planie (bez weryfikowanej domeny)
 * akceptuje tylko jeden adres odbiorcy - email właściciela konta Resend.
 * Jeśli ta zmienna jest ustawiona, KAŻDY notify trafia tam zamiast na
 * prawdziwego odbiorcę. W produkcji ZOSTAW PUSTĄ - inaczej wszyscy
 * klienci dostaną mail na Twój adres.
 */
const DEV_TO_OVERRIDE = isSensitiveDebugAllowed()
  ? process.env.RESEND_DEV_TO_OVERRIDE?.trim() || null
  : null;

// Cache klienta - `new Resend()` jest lightweight, ale nie chcemy tworzyć
// instancji na każdy email (jeden proces = jeden klient).
let cachedResend: Resend | null = null;

function isResendConfigured(): boolean {
  const key = process.env.RESEND_API_KEY;
  // `re_xxxx...` to placeholder z .env.example, NIE jest prawdziwym kluczem.
  return !!key && !key.startsWith('re_xxxx');
}

function getResend(): Resend {
  if (cachedResend) return cachedResend;
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY missing');
  cachedResend = new Resend(apiKey);
  return cachedResend;
}

/**
 * Faza 26: rozdzielenie reputacji transactional vs marketing przez różne
 * subdomeny `From:`. Bez tego marketing complaint zniszczyłby reputację
 * tej samej domeny używanej dla critical alerts (faktury, hasła).
 *
 * Konwencja (oba opcjonalne — fallback do single `RESEND_FROM_EMAIL`):
 *   RESEND_FROM_TRANSACTIONAL = `FaktWay <powiadomienia@faktway.pl>`
 *   RESEND_FROM_MARKETING     = `FaktWay <kontakt@faktway.pl>`
 * Osobne subdomeny (np. `app.`, `hello.`) dopiero po ich weryfikacji w Resend.
 */
function getFromEmail(category: 'transactional' | 'product_updates' | 'marketing'): string {
  if (category === 'transactional') {
    return envSender('RESEND_FROM_TRANSACTIONAL', 'RESEND_FROM_EMAIL') ?? DEFAULT_FROM;
  }
  return envSender('RESEND_FROM_MARKETING', 'RESEND_FROM_EMAIL') ?? DEFAULT_FROM;
}

// ═══════════════════════════════════════════════════════════════
// PUBLIC TYPES
// ═══════════════════════════════════════════════════════════════

export interface EmailStubResult {
  sent: boolean;
  /** Id wiadomości Resend (tylko przy `sent: true`). */
  messageId?: string;
  /** Powód pominięcia / niepowodzenia (tylko przy `sent: false`). */
  reason?: string;
}

interface InvoiceAcceptedPayload {
  ksefNumber: string;
  invoiceId: string;
}

interface InvoiceFailedPayload {
  invoiceId: string;
  errorMessage: string;
}

/** D-A4-1b-3 PR B: „Faktura … czeka na Twoją decyzję” (nierozstrzygnięty duplikat 440). */
export interface InvoiceDuplicateDecisionPayload {
  invoiceId: string;
  invoiceNumber: string;
  /** K — numer KSeF faktury, która ma już ten numer w KSeF. */
  ksefNumber: string;
  /** Przypomnienie operatora (inny temat). */
  reminder: boolean;
  /**
   * PR C (spec v3 5.7): wariant z tej samej oferty co panel (`duplicateNoticeVariant`) — `pair` (teksty PR B),
   * `record`, `released` albo `review` („sprawdzamy”). Brak = `pair`.
   */
  variant?: DuplicateNoticeVariant;
}

interface CertExpiryPayload {
  tenantName: string;
  daysRemaining: number;
  expiryDate: string | null;
}

// ═══════════════════════════════════════════════════════════════
// INTERNAL: wrapper nad `resend.emails.send`
// ═══════════════════════════════════════════════════════════════

import { canSendTo, type EmailCategory } from './preferences';
import {
  createUnsubscribeToken,
  isUnsubscribeConfigured,
} from './unsubscribe-token';
import { SUPPORT_EMAIL } from '@/lib/site';
import type { DuplicateNoticeVariant } from '@/lib/ksef/duplicate-decision';

async function sendViaResend(opts: {
  to: string;
  subject: string;
  html: string;
  /** Faza 26: kategoria emaila — domyślnie 'transactional' (zachowanie wsteczne). */
  category?: EmailCategory;
  /** User do którego należy email — używany do preferences check + unsubscribe token. */
  userId?: string;
  /** Faza 33: załączniki (np. PDF faktury). */
  attachments?: Array<{ filename: string; content: Buffer }>;
  /**
   * Klucz idempotencji Resend (nagłówek `Idempotency-Key`, ważny 24 h).
   * Ten sam klucz przy ponowieniu zadania = Resend nie wyśle drugi raz
   * (AUD-86). Klucz zależy od zdarzenia, nie od próby.
   */
  idempotencyKey?: string;
}): Promise<EmailStubResult> {
  const category: EmailCategory = opts.category ?? 'transactional';
  const finalTo = DEV_TO_OVERRIDE ?? opts.to;
  const finalSubject = DEV_TO_OVERRIDE
    ? `[DEV → ${opts.to}] ${opts.subject}`
    : opts.subject;

  // Faza 26 Layer 1: preferences + bounce check.
  // Skip dla DEV_TO_OVERRIDE (testy lokalne pomijają preferences).
  if (!DEV_TO_OVERRIDE) {
    const check = await canSendTo(opts.to, opts.userId ?? null, category);
    if (!check.ok) {
      return { sent: false, reason: check.reason };
    }
  }

  // Faza 26: List-Unsubscribe headers (RFC 8058). Tylko dla product_updates +
  // marketing — transactional MUSI zawsze dochodzić.
  const headers: Record<string, string> = {};
  if (
    opts.userId &&
    category !== 'transactional' &&
    isUnsubscribeConfigured()
  ) {
    try {
      const token = createUnsubscribeToken(opts.userId, category);
      const unsubUrl = `${APP_URL}/api/email/unsubscribe?t=${encodeURIComponent(token)}`;
      headers['List-Unsubscribe'] = `<${unsubUrl}>`;
      // RFC 8058: bez tego Gmail/Outlook nie pokażą one-click button.
      headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
    } catch {
      // EMAIL_UNSUBSCRIBE_SECRET missing → skip headers, ale wyślij email.
    }
  }

  const message = {
    from: getFromEmail(category),
    // Nadawca to no-reply@ — bez tego odpowiedź klienta ginie (MAN-18).
    replyTo: SUPPORT_EMAIL,
    to: [finalTo],
    subject: finalSubject,
    html: opts.html,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    attachments: opts.attachments?.map((a) => ({
      filename: a.filename,
      content: a.content,
    })),
  };
  // Bez klucza wywołanie jak dotąd — jeden argument.
  const { data, error } = opts.idempotencyKey
    ? await getResend().emails.send(message, { idempotencyKey: opts.idempotencyKey })
    : await getResend().emails.send(message);
  if (error) {
    // Inngest potrzebuje rzuconego błędu żeby ruszyć retry. Serializujemy
    // cały obiekt - Resend wpakowuje tam `name/message/statusCode`.
    throw new Error(`Resend error: ${JSON.stringify(error)}`);
  }
  return { sent: true, messageId: data?.id };
}

// ═══════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════

/** Opcje wysyłki z zadań, które mogą się powtórzyć (retry). */
export interface SendOptions {
  /** Zob. `idempotencyKey` w `sendViaResend`. */
  idempotencyKey?: string;
}

export async function sendInvoiceAcceptedEmail(
  email: string,
  payload: InvoiceAcceptedPayload,
  options: SendOptions = {},
): Promise<EmailStubResult> {
  if (!isResendConfigured()) {
    logger.debug(
      `[email:stub] sendInvoiceAcceptedEmail → ${email}:`,
      `faktura ${payload.invoiceId} zaakceptowana. Nr KSeF: ${payload.ksefNumber}`,
    );
    return { sent: false, reason: 'not-configured' };
  }
  const html = await render(
    InvoiceAccepted({ ...payload, appUrl: APP_URL }),
  );
  return sendViaResend({
    to: email,
    subject: `Faktura ${payload.ksefNumber} wysłana do KSeF`,
    html,
    idempotencyKey: options.idempotencyKey,
  });
}

export async function sendInvoiceFailedEmail(
  email: string,
  payload: InvoiceFailedPayload,
  options: SendOptions = {},
): Promise<EmailStubResult> {
  if (!isResendConfigured()) {
    logger.debug(
      `[email:stub] sendInvoiceFailedEmail → ${email}:`,
      `faktura ${payload.invoiceId} ODRZUCONA. Błąd: ${payload.errorMessage}`,
    );
    return { sent: false, reason: 'not-configured' };
  }
  const html = await render(InvoiceFailed({ ...payload, appUrl: APP_URL }));
  return sendViaResend({
    to: email,
    subject: 'Faktura odrzucona przez KSeF',
    html,
    idempotencyKey: options.idempotencyKey,
  });
}

/**
 * D-A4-1b-3 PR B (decyzja Bartosza 07.10.2026 (5), spec §2.8): „Faktura {nr}
 * czeka na Twoją decyzję” — raz na fakturę i numer KSeF oryginału (ślad
 * w `audit_logs`, klucz idempotencji z wywołującego); przypomnienie operatora
 * z tematem „Przypomnienie: …”. Teksty: `DUPLICATE_DECISION_TEXTS.NOTICE`
 * (przegląd prawnika przed KSeF PROD). Błąd Resend rzuca (`sendViaResend`).
 * PR C: `payload.variant` (`pair` / `record` / `released` / `review`) wybiera temat i treść.
 */
export async function sendInvoiceDuplicateDecisionEmail(
  email: string,
  payload: InvoiceDuplicateDecisionPayload,
  options: SendOptions = {},
): Promise<EmailStubResult> {
  const subject = duplicateDecisionSubject(payload.variant ?? 'pair', payload.reminder, payload.invoiceNumber);
  if (!isResendConfigured()) {
    logger.debug(`[email:stub] sendInvoiceDuplicateDecisionEmail → ${email}:`, `${subject} (numer KSeF ${payload.ksefNumber})`);
    return { sent: false, reason: 'not-configured' };
  }
  const html = await render(InvoiceDuplicateDecision({ ...payload, appUrl: APP_URL }));
  return sendViaResend({
    to: email,
    subject,
    html,
    idempotencyKey: options.idempotencyKey,
  });
}

/**
 * Generyczna wysyłka maila — używana przez moduły, które same komponują
 * HTML (np. zaproszenia do organizacji). Zachowuje tę samą semantykę
 * "fail-soft" jak pozostałe helpery: brak `RESEND_API_KEY` → log do stdout.
 *
 * Faza 26: opcjonalne `category` (default 'transactional') + `userId`
 * (do unsubscribe token + preferences check).
 */
export async function sendEmail(opts: {
  to: string;
  subject: string;
  html: string;
  category?: EmailCategory;
  userId?: string;
  /** Np. regulamin jako plik — potwierdzenie umowy na trwałym nośniku (lib/legal/record.ts). */
  attachments?: Array<{ filename: string; content: Buffer }>;
  idempotencyKey?: string;
}): Promise<EmailStubResult> {
  if (!isResendConfigured()) {
    logger.debug(`[email:stub] sendEmail → ${opts.to}: ${opts.subject}`);
    return { sent: false, reason: 'not-configured' };
  }
  return sendViaResend(opts);
}

export async function sendCertExpiryAlert(
  email: string,
  payload: CertExpiryPayload,
  options: SendOptions = {},
): Promise<EmailStubResult> {
  if (!isResendConfigured()) {
    logger.debug(
      `[email:stub] sendCertExpiryAlert → ${email}:`,
      `certyfikat KSeF dla '${payload.tenantName}' wygasa za ${payload.daysRemaining} dni (${payload.expiryDate ?? 'brak daty'})`,
    );
    return { sent: false, reason: 'not-configured' };
  }
  // CertExpiry template wymaga ISO string - jeśli DB zwróciła null, fallback
  // na "nieznana data" (rzadki case, ale lepszy niż crash templatki).
  const html = await render(
    CertExpiry({
      tenantName: payload.tenantName,
      daysRemaining: payload.daysRemaining,
      expiryDate: payload.expiryDate ?? 'nieznana',
    }),
  );
  return sendViaResend({
    to: email,
    subject: `⚠ Certyfikat KSeF wygasa za ${payload.daysRemaining} dni`,
    html,
    idempotencyKey: options.idempotencyKey,
  });
}

// ═══════════════════════════════════════════════════════════════
// FAZA 25 KROK 5 — BILLING EMAILS
// ═══════════════════════════════════════════════════════════════

export interface TrialEndingPayload {
  tenantName: string;
  daysRemaining: 14 | 7 | 3 | 1;
  trialEndDate: string;
  planLabel: string;
  monthlyPriceLabel: string;
}

export async function sendTrialEndingEmail(
  email: string,
  payload: TrialEndingPayload,
  options: SendOptions = {},
): Promise<EmailStubResult> {
  if (!isResendConfigured()) {
    logger.debug(
      `[email:stub] sendTrialEndingEmail → ${email}: trial kończy się za ${payload.daysRemaining} dni`,
    );
    return { sent: false, reason: 'not-configured' };
  }
  const html = await render(
    TrialEnding({
      ...payload,
      appUrl: APP_URL,
    }),
  );
  const isFinalDay = payload.daysRemaining === 1;
  const subject = isFinalDay
    ? '⏰ Twój trial FaktWay kończy się jutro'
    : `Twój trial FaktWay kończy się za ${payload.daysRemaining} dni`;
  return sendViaResend({ to: email, subject, html, idempotencyKey: options.idempotencyKey });
}

export interface PaymentFailedPayload {
  tenantName: string;
  amountLabel: string;
  failureReason: string | null;
}

export async function sendPaymentFailedEmail(
  email: string,
  payload: PaymentFailedPayload,
): Promise<EmailStubResult> {
  if (!isResendConfigured()) {
    logger.debug(
      `[email:stub] sendPaymentFailedEmail → ${email}: ${payload.amountLabel} (${payload.failureReason ?? 'unknown'})`,
    );
    return { sent: false, reason: 'not-configured' };
  }
  const html = await render(PaymentFailed({ ...payload, appUrl: APP_URL }));
  return sendViaResend({
    to: email,
    subject: 'Nie udało się pobrać płatności FaktWay',
    html,
  });
}

export interface RefundIssuedPayload {
  tenantName: string;
  amountLabel: string;
  reason: string | null;
}

export async function sendRefundIssuedEmail(
  email: string,
  payload: RefundIssuedPayload,
): Promise<EmailStubResult> {
  if (!isResendConfigured()) {
    logger.debug(
      `[email:stub] sendRefundIssuedEmail → ${email}: ${payload.amountLabel}`,
    );
    return { sent: false, reason: 'not-configured' };
  }
  const html = await render(RefundIssued(payload));
  return sendViaResend({
    to: email,
    subject: `Zwrot ${payload.amountLabel} przetworzony`,
    html,
  });
}

// ═══════════════════════════════════════════════════════════════
// FAZA 26 — NOWE TEMPLATES
// ═══════════════════════════════════════════════════════════════

export interface MagicImportCompletedPayload {
  tenantName: string;
  invoicesImported: number;
  contractorsImported: number;
  productsImported: number;
  warningsCount?: number;
  /** userId potrzebny do unsubscribe token (kategoria 'product_updates'). */
  userId?: string;
}

export async function sendMagicImportCompletedEmail(
  email: string,
  payload: MagicImportCompletedPayload,
): Promise<EmailStubResult> {
  if (!isResendConfigured()) {
    logger.debug(
      `[email:stub] sendMagicImportCompletedEmail → ${email}: ${payload.invoicesImported} faktur, ${payload.contractorsImported} kontrahentów`,
    );
    return { sent: false, reason: 'not-configured' };
  }
  const html = await render(
    MagicImportCompleted({ ...payload, appUrl: APP_URL }),
  );
  return sendViaResend({
    to: email,
    subject: '✨ Twoja historia z KSeF jest gotowa',
    html,
    category: 'product_updates',
    userId: payload.userId,
  });
}

export interface AccountDeletionConfirmationPayload {
  tenantName: string;
  hardDeleteDate: string;
  supportEmail?: string;
}

export async function sendAccountDeletionConfirmationEmail(
  email: string,
  payload: AccountDeletionConfirmationPayload,
): Promise<EmailStubResult> {
  if (!isResendConfigured()) {
    logger.debug(
      `[email:stub] sendAccountDeletionConfirmationEmail → ${email}: hard delete ${payload.hardDeleteDate}`,
    );
    return { sent: false, reason: 'not-configured' };
  }
  const html = await render(
    AccountDeletionConfirmation({
      ...payload,
      supportEmail: payload.supportEmail ?? SUPPORT_EMAIL,
    }),
  );
  return sendViaResend({
    to: email,
    subject: 'Potwierdzenie usunięcia konta FaktWay',
    html,
    category: 'transactional',
  });
}

export interface GdprDeletionScheduledPayload {
  userEmail: string;
  scheduledFor: string;
  cancelUrl: string;
  supportEmail?: string;
}

export async function sendGdprDeletionScheduledEmail(
  payload: GdprDeletionScheduledPayload,
): Promise<EmailStubResult> {
  if (!isResendConfigured()) {
    logger.debug(
      `[email:stub] sendGdprDeletionScheduledEmail → ${payload.userEmail}: ${payload.cancelUrl}`,
    );
    return { sent: false, reason: 'not-configured' };
  }
  const html = await render(
    GdprDeletionScheduled({
      ...payload,
      supportEmail: payload.supportEmail ?? SUPPORT_EMAIL,
    }),
  );
  return sendViaResend({
    to: payload.userEmail,
    subject: 'Żądanie usunięcia konta FaktWay — możesz cofnąć (RODO)',
    html,
    category: 'transactional',
  });
}

// ═══════════════════════════════════════════════════════════════
// Faza 33 — wysyłka faktury z PDF w załączniku
// ═══════════════════════════════════════════════════════════════

export interface InvoiceEmailPayload {
  to: string;
  invoiceNumber: string;
  sellerName: string;
  /** Opis kwoty — „Kwota brutto”, przy ROZ „Do zapłaty (po zaliczkach)”. */
  amountCaption: string;
  /** Kwota z walutą, ta sama co „Do zapłaty” na PDF (`amountDueOnPdf`). */
  amountLabel: string;
  dueDate: string;
  pdf: Buffer;
  pdfFilename: string;
}

/**
 * Stopka maila z fakturą do nabywcy. Do 15.10.2026: „Wiadomość wysłana przez
 * FaktWay” — nabywca nie wiedział, że nadawcą jest sprzedawca, a FaktWay
 * tylko przetwarza dane na jego zlecenie, ani że odpowiedź trafi do obsługi
 * FaktWay (Reply-To), nie do sprzedawcy. Art. 14 RODO jest obowiązkiem
 * sprzedawcy; stopka mówi nabywcy, do kogo się zwrócić.
 */
export function invoiceEmailFooter(sellerName: string): string {
  const seller = escapeHtml(sellerName);
  return (
    `Fakturę wysłał(a) ${seller} za pośrednictwem serwisu FaktWay, który przetwarza dane na zlecenie ${seller}. ` +
    `W sprawie faktury, płatności i Twoich danych osobowych skontaktuj się bezpośrednio z ${seller} — ` +
    `odpowiedź na tę wiadomość trafi do obsługi FaktWay, która przekaże ją nadawcy.`
  );
}

export async function sendInvoiceEmail(
  payload: InvoiceEmailPayload,
): Promise<EmailStubResult> {
  if (!isResendConfigured()) {
    logger.debug(
      `[email:stub] sendInvoiceEmail → ${payload.to}: faktura ${payload.invoiceNumber}`,
    );
    return { sent: false, reason: 'not-configured' };
  }

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:560px;margin:0 auto;color:#374151">
      <h1 style="font-size:20px;color:#111827">Faktura ${escapeHtml(payload.invoiceNumber)}</h1>
      <p>Dzień dobry,</p>
      <p>W załączniku przesyłamy fakturę <strong>${escapeHtml(payload.invoiceNumber)}</strong>
      od <strong>${escapeHtml(payload.sellerName)}</strong>.</p>
      <table style="margin:16px 0;font-size:14px">
        <tr><td style="color:#6b7280;padding-right:16px">${escapeHtml(payload.amountCaption)}</td><td><strong>${escapeHtml(payload.amountLabel)}</strong></td></tr>
        <tr><td style="color:#6b7280;padding-right:16px">Termin płatności</td><td>${escapeHtml(payload.dueDate)}</td></tr>
      </table>
      <p style="color:#9ca3af;font-size:12px">${invoiceEmailFooter(payload.sellerName)}</p>
    </div>
  `;

  return sendViaResend({
    to: payload.to,
    subject: `Faktura ${payload.invoiceNumber} od ${payload.sellerName}`,
    html,
    category: 'transactional',
    attachments: [{ filename: payload.pdfFilename, content: payload.pdf }],
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

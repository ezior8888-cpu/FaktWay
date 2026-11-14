import { createHash } from 'node:crypto';

import { formatIsoDatePl } from '@/lib/format/iso-date';
import { formatPlMoney } from '@/lib/format/pl';
import { QUOTE_KIND_ACCUSATIVE, QUOTE_KIND_LABELS, type QuoteKind } from '@/lib/proformy/model';
import { quoteNotInvoiceNotice } from '@/lib/proformy/teksty';

/**
 * Mail z proformą albo ofertą do kontrahenta (krok 2.4): temat, treść
 * i klucz idempotencji. Wysyłka idzie istniejącą drogą (`sendEmail`
 * z `lib/email/send.ts`, nagłówek `Idempotency-Key` w Resend, 24 h), tak jak
 * nota (`lib/noty/mail.ts`); adres odbiorcy normalizuje ta sama funkcja.
 */

export { normalizeNoteRecipient as normalizeQuoteRecipient } from '@/lib/noty/mail';

/**
 * Klucz zależy od zdarzenia, nie od próby (AUD-86): dokument, skrót adresu
 * i liczba wysyłek tego dokumentu na ten adres zapisanych już w historii.
 *  - Ponowienie po wysyłce, której nie zdążyliśmy zapisać, liczy tyle samo
 *    zapisanych wysyłek, więc daje ten sam klucz i Resend nie wyśle drugi raz.
 *  - Świadome „Wyślij ponownie” po zapisanej wysyłce daje nowy klucz.
 * Adres idzie do klucza tylko jako skrót: klucz trafia do dzienników dostawcy.
 * Przedrostek `sales-quote/<id>/` sprawdza RPC `record_sales_quote_email` (00198).
 */
export function quoteEmailIdempotencyKey(
  quoteId: string,
  recipient: string,
  previousSends: number,
  /**
   * Klucz logo firmy na PDF w załączniku (krok 2.2) albo `null` bez logo.
   * Resend przy tym samym kluczu porównuje treść, a logo zmienia PDF: inne
   * logo to inny klucz, więc ponowienie po zmianie logo nie utknie na 24 h.
   * Bez logo klucz jest taki jak przed tym krokiem.
   */
  logoKey: string | null = null,
): string {
  const hash = createHash('sha256').update(recipient.trim().toLowerCase()).digest('hex').slice(0, 16);
  const logo = logoKey ? `/${createHash('sha256').update(logoKey).digest('hex').slice(0, 16)}` : '';
  return `sales-quote/${quoteId}/${hash}/${previousSends}${logo}`;
}

export interface QuoteEmailContent {
  kind: QuoteKind;
  number: string;
  grossTotal: number;
  /** Proforma. */
  paymentDueDate: string | null;
  /** Oferta. */
  validUntil: string | null;
  issuerName: string;
}

export function quoteEmailSubject(quote: QuoteEmailContent): string {
  return `${QUOTE_KIND_LABELS[quote.kind]} ${quote.number} od ${quote.issuerName}`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Stopka jak przy fakturze i nocie: nadawcą jest wystawca dokumentu, FaktWay
 * tylko przetwarza dane na jego zlecenie, a odpowiedź trafi do obsługi
 * FaktWay (Reply-To), która przekaże ją nadawcy.
 */
export function quoteEmailFooter(issuerName: string): string {
  const issuer = escapeHtml(issuerName);
  return (
    `Dokument wysłał(a) ${issuer} za pośrednictwem serwisu FaktWay, który przetwarza dane na zlecenie ${issuer}. ` +
    `W sprawie dokumentu, płatności i Twoich danych osobowych skontaktuj się bezpośrednio z ${issuer}. ` +
    'Odpowiedź na tę wiadomość trafi do obsługi FaktWay, która przekaże ją nadawcy.'
  );
}

/** Treść HTML bez znaczników czasu: ten sam dokument daje tę samą treść (ponowienie z tym samym kluczem). */
export function quoteEmailHtml(quote: QuoteEmailContent): string {
  const label = QUOTE_KIND_LABELS[quote.kind];
  const rows = [
    ['Kwota brutto', `${formatPlMoney(quote.grossTotal)} PLN`],
    ...(quote.kind === 'proforma' && quote.paymentDueDate ? [['Termin zapłaty', formatIsoDatePl(quote.paymentDueDate)]] : []),
    ...(quote.kind === 'offer' && quote.validUntil ? [['Oferta ważna do', formatIsoDatePl(quote.validUntil)]] : []),
  ]
    .map(
      ([caption, value]) =>
        `<tr><td style="color:#6b7280;padding-right:16px">${escapeHtml(caption!)}</td><td><strong>${escapeHtml(value!)}</strong></td></tr>`,
    )
    .join('');
  return `
    <div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:560px;margin:0 auto;color:#374151">
      <h1 style="font-size:20px;color:#111827">${escapeHtml(label)} ${escapeHtml(quote.number)}</h1>
      <p>Dzień dobry,</p>
      <p>w załączniku przesyłamy ${QUOTE_KIND_ACCUSATIVE[quote.kind]} <strong>${escapeHtml(quote.number)}</strong>
      od <strong>${escapeHtml(quote.issuerName)}</strong>.</p>
      <table style="margin:16px 0;font-size:14px">${rows}</table>
      <p style="font-size:13px">${escapeHtml(quoteNotInvoiceNotice(quote.kind))}</p>
      <p style="color:#9ca3af;font-size:12px">${quoteEmailFooter(quote.issuerName)}</p>
    </div>
  `;
}

import { createHash } from 'node:crypto';

import { formatIsoDatePl } from '@/lib/format/iso-date';
import { formatPlMoney } from '@/lib/format/pl';
import { NOTE_KIND_LABELS, type NoteKind } from '@/lib/noty/model';
import { NOTE_NOT_INVOICE_NOTICE } from '@/lib/noty/teksty';

/**
 * Mail z notą do kontrahenta (krok 2.9, część 1): adres, temat, treść
 * i klucz idempotencji. Wysyłka idzie istniejącą drogą (`sendEmail`
 * z `lib/email/send.ts`, nagłówek `Idempotency-Key` w Resend, 24 h).
 */

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Małe litery, bez spacji na brzegach; adres spoza wzoru albo dłuższy niż 254 znaki to null. */
export function normalizeNoteRecipient(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  if (email.length > 254 || !EMAIL_RE.test(email)) return null;
  return email;
}

/**
 * Klucz zależy od zdarzenia, nie od próby (AUD-86): nota, skrót adresu
 * i liczba wysyłek tej noty na ten adres zapisanych już w historii.
 *  - Ponowienie po wysyłce, której nie zdążyliśmy zapisać, liczy tyle samo
 *    zapisanych wysyłek, więc daje ten sam klucz i Resend nie wyśle drugi raz.
 *  - Świadome „Wyślij ponownie” po zapisanej wysyłce daje nowy klucz.
 * Adres idzie do klucza tylko jako skrót: klucz trafia do dzienników dostawcy.
 * Przedrostek `nota/<id>/` sprawdza RPC `record_accounting_note_email` (00193).
 */
export function noteEmailIdempotencyKey(noteId: string, recipient: string, previousSends: number): string {
  const hash = createHash('sha256').update(recipient.trim().toLowerCase()).digest('hex').slice(0, 16);
  return `nota/${noteId}/${hash}/${previousSends}`;
}

export interface NoteEmailContent {
  kind: NoteKind;
  number: string;
  title: string;
  total: number;
  dueDate: string | null;
  issuerName: string;
}

export function noteEmailSubject(note: NoteEmailContent): string {
  return `${NOTE_KIND_LABELS[note.kind]} ${note.number} od ${note.issuerName}`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Stopka jak przy fakturze (`invoiceEmailFooter`): nadawcą jest wystawca noty,
 * FaktWay tylko przetwarza dane na jego zlecenie, a odpowiedź trafi do obsługi
 * FaktWay (Reply-To), która przekaże ją nadawcy.
 */
export function noteEmailFooter(issuerName: string): string {
  const issuer = escapeHtml(issuerName);
  return (
    `Notę wysłał(a) ${issuer} za pośrednictwem serwisu FaktWay, który przetwarza dane na zlecenie ${issuer}. ` +
    `W sprawie noty, płatności i Twoich danych osobowych skontaktuj się bezpośrednio z ${issuer}. ` +
    'Odpowiedź na tę wiadomość trafi do obsługi FaktWay, która przekaże ją nadawcy.'
  );
}

/** Treść HTML bez znaczników czasu: ta sama nota daje tę samą treść (ponowienie z tym samym kluczem). */
export function noteEmailHtml(note: NoteEmailContent): string {
  const label = NOTE_KIND_LABELS[note.kind];
  const article = note.kind === 'debit' ? 'notę obciążeniową' : 'notę uznaniową';
  const rows = [
    ['Tytuł', note.title],
    ['Kwota', `${formatPlMoney(note.total)} PLN`],
    ...(note.dueDate ? [['Termin zapłaty', formatIsoDatePl(note.dueDate)]] : []),
  ]
    .map(
      ([caption, value]) =>
        `<tr><td style="color:#6b7280;padding-right:16px">${escapeHtml(caption!)}</td><td><strong>${escapeHtml(value!)}</strong></td></tr>`,
    )
    .join('');
  return `
    <div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:560px;margin:0 auto;color:#374151">
      <h1 style="font-size:20px;color:#111827">${escapeHtml(label)} ${escapeHtml(note.number)}</h1>
      <p>Dzień dobry,</p>
      <p>w załączniku przesyłamy ${article} <strong>${escapeHtml(note.number)}</strong>
      od <strong>${escapeHtml(note.issuerName)}</strong>.</p>
      <table style="margin:16px 0;font-size:14px">${rows}</table>
      <p style="font-size:13px">${escapeHtml(NOTE_NOT_INVOICE_NOTICE)}</p>
      <p style="color:#9ca3af;font-size:12px">${noteEmailFooter(note.issuerName)}</p>
    </div>
  `;
}

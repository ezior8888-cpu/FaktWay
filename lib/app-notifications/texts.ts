import { createHash } from 'node:crypto';

import { formatPlMoney } from '@/lib/format/pl';

import type { AppNotificationInput } from './types';

/**
 * Treści i klucze wpisów w dzwonku (plan kompletnej aplikacji, krok 8.1,
 * część 2, 00188). Klucz obiektu jest STAŁY dla tego samego zdarzenia, więc
 * ponowienie joba trafia w UNIQUE i nie dubluje wpisu.
 *
 * Teksty bez trybu rozkazującego przy podatkach i bez długich myślników;
 * termin podatku bierze treść z modułu księgowości (ta sama co push i mail).
 */

/** Sprzedawca bez nazwy w metadanych KSeF ma w koszcie „Nieznany” (`auto-categorize-inbox.ts`). */
const UNKNOWN_SELLER = 'Nieznany';

/** Kwota z walutą; kwot w walutach obcych nie podpisujemy „zł” (plan Finora §2.4 pkt 6). */
function money(amount: number, currency: string): string {
  const code = currency.trim().toUpperCase();
  return `${formatPlMoney(amount)} ${code === 'PLN' ? 'zł' : code}`;
}

function invoiceLabel(invoiceNumber: string | null): string {
  return invoiceNumber?.trim() || 'Faktura bez numeru';
}

/** Nowa faktura zakupu ze skrzynki KSeF; link do kosztu, który z niej powstał. */
export function inboxNewNotification(input: {
  tenantId: string;
  invoiceId: string;
  expenseId: string;
  documentNumber: string;
  sellerName: string | null;
  grossAmount: number;
  currency: string;
}): AppNotificationInput {
  const seller = input.sellerName?.trim();
  const from = seller && seller !== UNKNOWN_SELLER ? ` od ${seller}` : '';
  const amount = Number.isFinite(input.grossAmount) ? `, ${money(input.grossAmount, input.currency)}` : '';
  return {
    tenantId: input.tenantId,
    kind: 'inbox_new',
    objectKey: input.invoiceId,
    title: 'Nowa faktura zakupu',
    body: `${input.documentNumber}${from}${amount}`,
    link: `/expenses/${input.expenseId}`,
  };
}

/** Faktura sprzedaży przyjęta w KSeF (raz na fakturę). */
export function invoiceAcceptedNotification(input: {
  tenantId: string;
  invoiceId: string;
  invoiceNumber: string | null;
  ksefNumber: string | null;
}): AppNotificationInput {
  const label = invoiceLabel(input.invoiceNumber);
  const ksef = input.ksefNumber?.trim();
  return {
    tenantId: input.tenantId,
    kind: 'invoice_accepted',
    objectKey: input.invoiceId,
    title: 'Faktura przyjęta w KSeF',
    body: ksef ? `${label}, numer KSeF ${ksef}` : label,
    link: `/invoices/${input.invoiceId}`,
  };
}

/**
 * Faktura odrzucona za treść. Klucz z faktury i skrótu powodu, jak klucz maila
 * o odrzuceniu (`notify-user.ts`): ponowienie tego samego zdarzenia trafia
 * w ten sam klucz, a odrzucenie z innym powodem dostaje własny wpis. Powodu nie
 * przepisujemy (bywa techniczny); strona faktury pokazuje go z podpowiedzią.
 *
 * `beforeKsef`: plik nie przeszedł sprawdzenia schematu FA(3) przed wysyłką
 * (`XSD_INVALID`), więc do KSeF nie trafił. Tekst mówi wtedy właśnie to, a nie
 * „odrzucona w KSeF”.
 */
export function invoiceRejectedNotification(input: {
  tenantId: string;
  invoiceId: string;
  invoiceNumber: string | null;
  error: string;
  beforeKsef?: boolean;
}): AppNotificationInput {
  const digest = createHash('sha256').update(input.error).digest('hex').slice(0, 16);
  const label = invoiceLabel(input.invoiceNumber);
  return {
    tenantId: input.tenantId,
    kind: 'invoice_rejected',
    objectKey: `${input.invoiceId}:${digest}`,
    title: input.beforeKsef ? 'Faktura nie trafiła do KSeF' : 'Faktura odrzucona w KSeF',
    body: input.beforeKsef
      ? `${label}: dane nie przeszły sprawdzenia przed wysyłką. Szczegóły są na stronie faktury.`
      : `${label}: powód odrzucenia jest na stronie faktury.`,
    link: `/invoices/${input.invoiceId}`,
  };
}

/**
 * Termin podatku albo składek z kalendarza modułu księgowości: tytuł, treść
 * i link przypomnienia (`trescTerminu`), klucz jak w `tax_notifications`
 * (rozliczenie i etap, np. `2026-10:termin-5:2026-11-20`).
 */
export function taxDeadlineNotification(input: {
  tenantId: string;
  miesiac: string;
  etap: string;
  tytul: string;
  tresc: string;
  adres: string;
}): AppNotificationInput {
  return {
    tenantId: input.tenantId,
    kind: 'tax_deadline',
    objectKey: `${input.miesiac}:${input.etap}`,
    title: input.tytul,
    body: input.tresc,
    link: input.adres,
  };
}

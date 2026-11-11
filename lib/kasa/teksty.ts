import { isRecordPaymentRefusal, recordPaymentRefusalText } from '@/lib/invoices/invoice-payments';
import { dayPl, formatCashMoney } from '@/lib/kasa/model';

/**
 * Teksty Kasy dla klienta (krok 3.7). Każda odmowa nazywa dokument i mówi, co
 * zrobić (protokół napraw, pkt 4). Bez długich myślników, bez porady
 * podatkowej: jak ująć dowody w księgach, ustala księgowa.
 */

export const CASH_ROLE_REFUSAL = 'Dowody kasowe wystawia właściciel, administrator albo członek firmy. Księgowa ma tu wgląd.';

export const CASH_INFO =
  'Dowody KP i KW potwierdzają przyjęcie i wydanie gotówki, a raport kasowy pokazuje stan kasy w wybranym okresie. To nie jest kasa fiskalna: paragonów tu nie ma.';

export const CASH_BOOKS_NOTICE = 'FaktWay nie ujmuje dowodów kasowych sam w KPiR ani w ewidencji. Jak je ująć, ustala księgowa.';

export const CASH_CORRECTION_INFO =
  'Wystawionego dowodu nie zmienia się. Błąd poprawia korekta: nowy dowód z kwotą ujemną, który znosi ten dowód w całości. '
  + 'Potem wystaw dowód z poprawnymi danymi. Zwrot gotówki to nie korekta, tylko nowy dowód KW.';

export const CASH_OPENING_INFO =
  'Wpisz, ile gotówki jest w kasie w dniu, od którego prowadzisz kasę w FaktWay. Stan początkowy zmienisz, dopóki nie wystawisz pierwszego dowodu.';

export const CASH_ISSUE_FAILED = 'Nie udało się wystawić dowodu. Sprawdź połączenie i spróbuj ponownie.';
export const CASH_CORRECT_FAILED = 'Nie udało się wystawić korekty. Sprawdź połączenie i spróbuj ponownie.';
export const CASH_OPEN_FAILED = 'Nie udało się zapisać stanu początkowego kasy. Sprawdź połączenie i spróbuj ponownie.';
export const CASH_LOAD_FAILED = 'Nie udało się wczytać kasy. Odśwież stronę. Jeśli błąd wróci, napisz do nas przez Pomoc.';
export const CASH_REGISTER_MISSING_PDF = 'Kasa nie jest jeszcze otwarta. Wpisz stan początkowy kasy na stronie Kasa.';

export function cashBelowZeroText(day: string, balance: number): string {
  return `Stan kasy w tym okresie spadł poniżej zera (koniec dnia ${dayPl(day)}: ${formatCashMoney(balance)}). `
    + 'FaktWay nie pozwala na to przy wystawianiu dowodów, więc to znak, że coś jest nie tak. Napisz do nas przez Pomoc, a sprawdzimy kasę.';
}

/** Kody odmowy `issue_cash_document` (00194). */
export type IssueRefusal =
  | 'invalid_request'
  | 'register_missing'
  | 'key_reused'
  | 'invalid_amount'
  | 'invalid_date'
  | 'future_date'
  | 'before_opening'
  | 'title_invalid'
  | 'related_invalid'
  | 'counterparty_invalid'
  | 'issuer_incomplete'
  | 'insufficient_cash'
  | 'payment_not_found'
  | 'payment_voided'
  | 'payment_not_linkable'
  | 'payment_linked'
  | 'payment_mismatch'
  | 'invoice_refused';

const ISSUE_REFUSALS: ReadonlySet<string> = new Set<IssueRefusal>([
  'invalid_request', 'register_missing', 'key_reused', 'invalid_amount', 'invalid_date', 'future_date', 'before_opening',
  'title_invalid', 'related_invalid', 'counterparty_invalid', 'issuer_incomplete', 'insufficient_cash', 'payment_not_found',
  'payment_voided', 'payment_not_linkable', 'payment_linked', 'payment_mismatch', 'invoice_refused',
]);

export function isIssueRefusal(code: unknown): code is IssueRefusal {
  return typeof code === 'string' && ISSUE_REFUSALS.has(code);
}

export interface IssueRefusalContext {
  available?: number | null;
  availableOn?: string | null;
  amount?: number | null;
  openingDate?: string | null;
  documentNumber?: string | null;
  invoiceNumber?: string | null;
  /** `payments.match_method` wpłaty, której KP nie obejmie. */
  source?: string | null;
  /** Kod odmowy `record_invoice_payment` (00176) przy KP do faktury. */
  invoiceCode?: string | null;
  remaining?: number | null;
  currency?: string | null;
  paidOn?: string | null;
}

const money = (value: number | null | undefined) => formatCashMoney(typeof value === 'number' && Number.isFinite(value) ? value : 0);
const faktura = (number: string | null | undefined) => (number ? `faktury ${number}` : 'tej faktury');
const dowodu = (number: string | null | undefined) => (number ? `dowodu ${number}` : 'tego dowodu');
const ISSUER_INCOMPLETE = 'Uzupełnij nazwę, NIP i adres firmy w Ustawieniach, w danych firmy. Dowód kasowy musi wskazywać wystawcę.';

/** Gdy faktura nie przyjmie wpłaty, gotówkę i tak można udokumentować (wyjście dla KP). */
const KP_WITHOUT_INVOICE = 'Jeśli gotówka już wpłynęła, wystaw KP jako „Inna wpłata” i wpisz numer faktury w polu „Dotyczy”.';

function invoiceRefusalText(ctx: IssueRefusalContext): string {
  const code = ctx.invoiceCode;
  if (!isRecordPaymentRefusal(code)) return CASH_ISSUE_FAILED;
  const base = recordPaymentRefusalText(code, { number: ctx.invoiceNumber, remaining: ctx.remaining, currency: ctx.currency });
  switch (code) {
    case 'not_accepted':
    case 'invoice_currency':
      return `${base} ${KP_WITHOUT_INVOICE}`;
    case 'already_paid':
      return `${base} Jeśli wpłatę zapisano przy fakturze, wybierz ją jako „Wpłata zapisana przy fakturze”.`;
    default:
      return base;
  }
}

export function issueRefusalText(code: IssueRefusal, ctx: IssueRefusalContext = {}): string {
  switch (code) {
    case 'invalid_request':
      return CASH_ISSUE_FAILED;
    case 'register_missing':
      return 'Kasa nie jest jeszcze otwarta. Wpisz stan początkowy kasy na stronie Kasa, potem wystaw dowód.';
    case 'key_reused':
      return 'Ten dowód był już wystawiony z innymi danymi. Odśwież stronę i wystaw go jeszcze raz.';
    case 'invalid_amount':
      return 'Kwota musi być większa od zera i mieć najwyżej dwa miejsca po przecinku.';
    case 'invalid_date':
      return 'Sprawdź rok w dacie operacji: wygląda na literówkę.';
    case 'future_date':
      return 'Data operacji nie może być z przyszłości. Wpisz dzisiejszą albo wcześniejszą datę.';
    case 'before_opening':
      return `Kasa działa w FaktWay od ${dayPl(ctx.openingDate) || 'dnia rozpoczęcia'}, więc data operacji nie może być wcześniejsza. Wpisz datę od tego dnia.`;
    case 'title_invalid':
      return 'Wpisz tytuł operacji (najwyżej 200 znaków), np. „Zapłata za fakturę FV/1/2026”.';
    case 'related_invalid':
      return 'Pole „Dotyczy” może mieć najwyżej 120 znaków.';
    case 'counterparty_invalid':
      return 'Wpisz nazwę firmy albo imię i nazwisko strony operacji (najwyżej 512 znaków).';
    case 'issuer_incomplete':
      return ISSUER_INCOMPLETE;
    case 'insufficient_cash':
      return `W kasie na koniec dnia ${dayPl(ctx.availableOn)} jest ${money(ctx.available)}, a wypłata to ${money(ctx.amount)}. `
        + 'Stan kasy nie może zejść poniżej zera. Jeśli gotówka wpłynęła do kasy, najpierw wystaw na nią KP z właściwą datą. '
        + 'Jeśli stan się nie zgadza od początku, sprawdź stan początkowy kasy.';
    case 'payment_not_found':
      return 'Nie znaleziono tej wpłaty w aktywnej firmie. Odśwież stronę albo przełącz firmę.';
    case 'payment_voided':
      return `Wpłata do ${faktura(ctx.invoiceNumber)} jest cofnięta, więc KP jej nie obejmie. Wybierz „Zapłata faktury”: wpłata zapisze się razem z dowodem.`;
    case 'payment_not_linkable':
      if (ctx.source === 'manual') {
        return `Wpłatę do ${faktura(ctx.invoiceNumber)} oznaczono przyciskiem „Zapłacone”, więc KP jej nie obejmie. `
          + 'Jeśli zapłacono gotówką, cofnij „Zapłacone” na fakturze i wystaw KP do faktury: wpłata zapisze się razem z dowodem.';
      }
      return `Wpłaty do ${faktura(ctx.invoiceNumber)} nie wpisano ręcznie, więc KP jej nie obejmie. Napisz do nas przez Pomoc, a sprawdzimy ją.`;
    case 'payment_linked':
      return `Ta wpłata ma już dowód ${ctx.documentNumber ?? 'KP'}. Znajdziesz go w Kasie.`;
    case 'payment_mismatch':
      return `Kwota i data KP muszą być takie jak we wpłacie: ${money(ctx.amount)} z ${dayPl(ctx.paidOn)}. Odśwież stronę i wybierz wpłatę jeszcze raz.`;
    case 'invoice_refused':
      return invoiceRefusalText(ctx);
  }
}

/** Pole formularza, którego dotyczy odmowa z bazy (komunikat stoi przy nim). */
export function issueRefusalField(code: IssueRefusal): 'amount' | 'operationDate' | 'title' | 'counterpartyName' | 'relatedDocument' | undefined {
  switch (code) {
    case 'invalid_amount':
    case 'insufficient_cash':
    case 'payment_mismatch':
      return 'amount';
    case 'invalid_date':
    case 'future_date':
    case 'before_opening':
      return 'operationDate';
    case 'title_invalid':
      return 'title';
    case 'counterparty_invalid':
      return 'counterpartyName';
    case 'related_invalid':
      return 'relatedDocument';
    default:
      return undefined;
  }
}

/** Kody odmowy `correct_cash_document` (00194). */
export type CorrectionRefusal =
  | 'invalid_request'
  | 'not_found'
  | 'key_reused'
  | 'is_correction'
  | 'already_corrected'
  | 'reason_required'
  | 'issuer_incomplete'
  | 'insufficient_cash'
  | 'payment_refused';

const CORRECTION_REFUSALS: ReadonlySet<string> = new Set<CorrectionRefusal>([
  'invalid_request', 'not_found', 'key_reused', 'is_correction', 'already_corrected', 'reason_required',
  'issuer_incomplete', 'insufficient_cash', 'payment_refused',
]);

export function isCorrectionRefusal(code: unknown): code is CorrectionRefusal {
  return typeof code === 'string' && CORRECTION_REFUSALS.has(code);
}

export interface CorrectionRefusalContext {
  number?: string | null;
  correctionNumber?: string | null;
  available?: number | null;
  availableOn?: string | null;
  amount?: number | null;
  /** Kod odmowy `void_invoice_payment` (00176). */
  paymentCode?: string | null;
  invoiceNumber?: string | null;
  manualPaidOn?: string | null;
  manualAmount?: number | null;
}

export function correctionRefusalText(code: CorrectionRefusal, ctx: CorrectionRefusalContext = {}): string {
  const dowod = ctx.number ? `Dowód ${ctx.number}` : 'Ten dowód';
  switch (code) {
    case 'invalid_request':
      return CASH_CORRECT_FAILED;
    case 'not_found':
      return 'Nie znaleziono tego dowodu w aktywnej firmie. Odśwież stronę albo przełącz firmę.';
    case 'key_reused':
      return 'Ta korekta była już wystawiona do innego dowodu. Odśwież stronę i wystaw ją jeszcze raz.';
    case 'is_correction':
      return `${dowod} jest korektą, a korekty się nie koryguje. Jeśli korekta była błędem, wystaw nowy dowód z poprawnymi danymi.`;
    case 'already_corrected':
      return `${dowod} ma już korektę${ctx.correctionNumber ? ` ${ctx.correctionNumber}` : ''}. Jeśli trzeba, wystaw nowy dowód z poprawnymi danymi.`;
    case 'reason_required':
      return 'Wpisz przyczynę korekty (najwyżej 300 znaków).';
    case 'issuer_incomplete':
      return ISSUER_INCOMPLETE;
    case 'insufficient_cash':
      return `Korekta ${dowodu(ctx.number)} zmniejszy stan kasy o ${money(ctx.amount)}, a na koniec dnia ${dayPl(ctx.availableOn)} w kasie jest ${money(ctx.available)}. `
        + 'Stan kasy nie może zejść poniżej zera. Najpierw skoryguj błędne wypłaty (KW) z tego okresu albo wystaw KP na gotówkę, która wpłynęła.';
    case 'payment_refused':
      if (ctx.paymentCode === 'manual_first') {
        return `${ctx.invoiceNumber ? `Faktura ${ctx.invoiceNumber}` : 'Faktura'} ma oznaczenie „Zapłacone” z ${dayPl(ctx.manualPaidOn)} na ${money(ctx.manualAmount)}, `
          + `policzone jako reszta po wpłacie z ${dowodu(ctx.number)}. Najpierw cofnij „Zapłacone” na fakturze, potem wystaw korektę.`;
      }
      return `Nie udało się cofnąć wpłaty do ${faktura(ctx.invoiceNumber)} razem z korektą ${dowodu(ctx.number)}. Napisz do nas przez Pomoc, a sprawdzimy ją.`;
  }
}

/** Kody odmowy `open_cash_register` (00194). */
export type OpeningRefusal = 'invalid_amount' | 'invalid_date' | 'future_date' | 'documents_exist';

const OPENING_REFUSALS: ReadonlySet<string> = new Set<OpeningRefusal>(['invalid_amount', 'invalid_date', 'future_date', 'documents_exist']);

export function isOpeningRefusal(code: unknown): code is OpeningRefusal {
  return typeof code === 'string' && OPENING_REFUSALS.has(code);
}

export function openingRefusalText(code: OpeningRefusal, ctx: { openingBalance?: number | null; openingDate?: string | null } = {}): string {
  switch (code) {
    case 'invalid_amount':
      return 'Stan początkowy to kwota od zera wzwyż, z najwyżej dwoma miejscami po przecinku.';
    case 'invalid_date':
      return 'Sprawdź rok w dacie rozpoczęcia: wygląda na literówkę.';
    case 'future_date':
      return 'Dzień rozpoczęcia nie może być z przyszłości.';
    case 'documents_exist':
      return `Stanu początkowego nie zmienia się po wystawieniu pierwszego dowodu. Kasa ma stan początkowy ${money(ctx.openingBalance)} na ${dayPl(ctx.openingDate)}. `
        + 'Różnicę między gotówką w kasie a stanem w FaktWay dokumentuje dowód KP albo KW, np. „Nadwyżka kasowa” albo „Niedobór kasowy”. Jak go ująć, ustala księgowa.';
  }
}

export function issuedToast(number: string, paymentRecorded: boolean, invoiceNumber: string | null): string {
  const base = `Wystawiono ${number}.`;
  return paymentRecorded ? `${base} Wpłata zapisana przy ${invoiceNumber ? `fakturze ${invoiceNumber}` : 'fakturze'}.` : base;
}

export function alreadyIssuedToast(number: string): string {
  return `Ten dowód jest już wystawiony: ${number}.`;
}

export function correctedToast(number: string, correctsNumber: string, paymentVoided: boolean, invoiceNumber: string | null): string {
  const base = `Wystawiono korektę ${number} do dowodu ${correctsNumber}.`;
  return paymentVoided ? `${base} Wpłata do ${faktura(invoiceNumber)} została cofnięta.` : base;
}

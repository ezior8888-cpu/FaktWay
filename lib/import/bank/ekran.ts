/**
 * Ekran „Bank” i jego akcje (plan kompletnej aplikacji, krok 3.2, część 1):
 * limity, typy wyników, teksty dla klienta i odczyt wyniku RPC
 * `bank_operations` (00180). Moduł bez importów serwerowych: biorą go akcje,
 * strona i komponent kliencki.
 */

import {
  formatPaymentMoney,
  isRecordPaymentRefusal,
  recordedPaymentToast,
  recordPaymentRefusalText,
  voidPaymentRefusalText,
} from '@/lib/invoices/invoice-payments';

import { MATCH_KINDS, type MatchKind } from './dopasowanie';
import type { BankFileFormat, BankParseErrorCode } from './typy';

/** Akcja serwerowa przyjmuje do 1 MB z nagłówkami formularza (Next.js), więc plik do 900 KB. */
export const MAX_BANK_FILE_BYTES = 900 * 1024;
/** Ta sama granica stoi w `import_bank_operations`. */
export const MAX_BANK_OPERATIONS = 2000;

export function isMatchKind(value: unknown): value is MatchKind {
  return typeof value === 'string' && (MATCH_KINDS as readonly string[]).includes(value);
}

export const BANK_ROLE_REFUSAL = 'Wyciąg wgrywa i wpłaty potwierdza właściciel, administrator albo członek firmy. Księgowa ma tu wgląd.';
export const IMPORT_FAILED = 'Nie udało się zapisać wyciągu. Sprawdź połączenie i spróbuj ponownie: operacje wgrane wcześniej nie wejdą drugi raz.';
export const DECISION_FAILED = 'Nie udało się zapisać decyzji. Sprawdź połączenie i spróbuj ponownie.';
export const BANK_LOAD_FAILED = 'Nie udało się wczytać operacji z wyciągów. Odśwież stronę, a jeśli to się powtórzy, napisz do nas przez Pomoc.';
export const CANDIDATES_LOAD_FAILED =
  'Nie udało się wczytać niezapłaconych faktur, więc nie pokazujemy propozycji. Odśwież stronę; operacje czekają bez zmian.';
export const FILE_EMPTY = 'Plik jest pusty. Wybierz plik wyciągu pobrany z banku.';
export const FILE_TOO_BIG =
  'Plik jest większy niż 900 KB. Pobierz z banku wyciąg za krótszy okres, np. za tydzień, i wgraj kolejne pliki: operacje wgrane wcześniej nie wejdą drugi raz.';
export const FILE_TOO_MANY = `W pliku jest ponad ${MAX_BANK_OPERATIONS} wpływów. Pobierz z banku wyciąg za krótszy okres i wgraj kolejne pliki.`;

export const FORMAT_LABELS: Record<BankFileFormat, string> = {
  mt940: 'MT940',
  camt053: 'CAMT.053',
  csv_pko_elixir: 'CSV PKO BP (Elixir)',
};

export function parseErrorText(code: BankParseErrorCode): string {
  switch (code) {
    case 'empty':
      return FILE_EMPTY;
    case 'unknown_format':
      return 'Nie rozpoznaliśmy formatu pliku. Wgraj wyciąg MT940 albo CAMT.053 (XML) z bankowości internetowej albo raport CSV PKO BP w formacie Elixir. Plików CSV innych banków jeszcze nie czytamy, bo banki nie publikują ich opisu.';
    case 'invalid_file':
      return 'Plik ma błąd w środku (kwotę, datę albo linię spoza formatu). Nic nie zapisaliśmy. Pobierz plik z banku jeszcze raz, a jeśli błąd się powtórzy, napisz do nas przez Pomoc.';
    case 'no_account':
      return 'W pliku nie ma numeru rachunku, więc nie wiemy, którego konta dotyczy. Nic nie zapisaliśmy. Pobierz z banku pełny wyciąg z numerem rachunku.';
  }
}

export type ImportBankStatementResult =
  | {
      success: true;
      format: BankFileFormat;
      /** Nowe wpływy do sprawdzenia. */
      inserted: number;
      /** Wpływy wgrane wcześniej (ten sam klucz duplikatu). */
      duplicates: number;
      /** Wypływy, których nie zapisujemy: wszystkie poza przelewami do ZUS i urzędu (dopasowanie wydatków przyjdzie później). */
      debitsSkipped: number;
      /** Wpływy w innej walucie niż PLN: wpłaty zapisujemy dziś tylko w złotych. */
      otherCurrencySkipped: number;
      /** Przelewy do ZUS i na mikrorachunek (moduł księgowości włączony, 00186): nowe i wgrane wcześniej. */
      tax?: { inserted: number; duplicates: number };
      /** Moduł włączony, ale rachunków firmy nie udało się odczytać: przelewów podatkowych nie rozpoznaliśmy. */
      taxUnavailable?: true;
    }
  | { success: false; error: string };

export type BankDecisionResult = { success: true; status: string; message: string } | { success: false; error: string };

function plural(n: number, one: string, few: string, many: string): string {
  if (n === 1) return one;
  const lastTwo = n % 100;
  const last = n % 10;
  return last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14) ? few : many;
}

const operacje = (n: number) => `${n} ${plural(n, 'operację', 'operacje', 'operacji')}`;

/** Podsumowanie wgrania: co weszło, co już było i czego nie zapisaliśmy. */
export function importSummaryText(result: Extract<ImportBankStatementResult, { success: true }>): string {
  const parts: string[] = [];
  parts.push(
    result.inserted > 0
      ? `Dodaliśmy do sprawdzenia ${operacje(result.inserted)} z pliku ${FORMAT_LABELS[result.format]}.`
      : `W pliku ${FORMAT_LABELS[result.format]} nie było nowych wpływów do sprawdzenia.`,
  );
  if (result.duplicates > 0) parts.push(`Pominęliśmy ${operacje(result.duplicates)} wgrane wcześniej.`);
  if (result.tax) {
    if (result.tax.inserted > 0) {
      parts.push(`Przelewy do ZUS i urzędu skarbowego (${result.tax.inserted}) czekają na potwierdzenie jako zapłaty rozliczeń.`);
    }
    if (result.tax.duplicates > 0) parts.push(`Przelewów do ZUS i urzędu wgranych wcześniej (${result.tax.duplicates}) nie dodaliśmy drugi raz.`);
  }
  if (result.taxUnavailable) {
    parts.push(
      'Przelewów do ZUS i urzędu skarbowego tym razem nie rozpoznaliśmy, bo nie udało się odczytać ustawień podatkowych firmy. Ten sam plik można wgrać jeszcze raz: dojdą tylko brakujące operacje.',
    );
  }
  if (result.debitsSkipped > 0) {
    parts.push(
      `${result.tax ? 'Pozostałych wypływów' : 'Wypływów'} (${result.debitsSkipped}) nie zapisujemy: dopasowanie wydatków do faktur kosztowych przyjdzie w kolejnym kroku.`,
    );
  }
  if (result.otherCurrencySkipped > 0) {
    parts.push(`Wpływów w innej walucie niż PLN (${result.otherCurrencySkipped}) nie zapisujemy: wpłaty przyjmujemy na razie tylko w złotych.`);
  }
  return parts.join(' ');
}

/** Odmowy samego importu i decyzji, które nie pochodzą z `record_invoice_payment`. */
const BANK_REFUSALS = new Set(['operation_not_found', 'operation_skipped', 'operation_confirmed', 'not_credit', 'manual_first', 'tax_payment_confirmed']);

export interface RefusalContext {
  number?: string | null;
  remaining?: number | null;
  currency?: string | null;
  manualPaidOn?: string | null;
  manualAmount?: number | null;
}

/** Tekst odmowy RPC ekranu Bank: nazwa dokumentu i co zrobić (protokół napraw, pkt 4). */
export function bankRefusalText(code: unknown, ctx: RefusalContext = {}): string {
  if (code === 'over_remaining') {
    // Kwotę wyznacza operacja z banku, więc zamiast „wpisz mniejszą kwotę” mówimy, co zrobić z nadpłatą.
    const where = ctx.number ? `na fakturze ${ctx.number}` : 'na tej fakturze';
    const rest = typeof ctx.remaining === 'number' && Number.isFinite(ctx.remaining) ? ` (${formatPaymentMoney(ctx.remaining)})` : '';
    return `Wpływ jest większy niż pozostało do zapłaty ${where}${rest}. FaktWay nie zapisuje nadpłat: wybierz inną fakturę albo zapisz przy fakturze wpłatę na kwotę reszty („Zapisz wpłatę”) i pomiń tę operację.`;
  }
  if (isRecordPaymentRefusal(code)) {
    return recordPaymentRefusalText(code, { number: ctx.number, remaining: ctx.remaining, currency: ctx.currency });
  }
  if (typeof code !== 'string' || !BANK_REFUSALS.has(code)) return DECISION_FAILED;
  switch (code) {
    case 'operation_not_found':
      return 'Nie znaleziono tej operacji w aktywnej firmie. Odśwież stronę albo przełącz firmę.';
    case 'operation_skipped':
      return 'Ta operacja jest pominięta, a jej dane usunęliśmy. Jeśli to była wpłata do faktury, zapisz ją przy fakturze przyciskiem „Zapisz wpłatę”.';
    case 'operation_confirmed':
      return `Ta operacja ma już zapisaną wpłatę${ctx.number ? ` do faktury ${ctx.number}` : ''}. Najpierw cofnij tę wpłatę przyciskiem „Cofnij”, potem zdecyduj jeszcze raz.`;
    case 'not_credit':
      return 'To nie jest wpływ na rachunek, więc nie zapiszemy go jako wpłaty do faktury sprzedaży.';
    case 'tax_payment_confirmed':
      return 'Ta operacja jest potwierdzona jako zapłata rozliczenia. Najpierw cofa się ją przyciskiem „Cofnij” w zapłatach do ZUS i urzędu skarbowego, potem można ją pominąć.';
    default:
      return voidPaymentRefusalText('manual_first', { number: ctx.number, manualPaidOn: ctx.manualPaidOn, manualAmount: ctx.manualAmount });
  }
}

export function confirmedText(status: string, amount: number | null, number: string | null, paidInFull: boolean): string {
  if (status === 'already_confirmed') return `Ta wpłata jest już zapisana${number ? ` do faktury ${number}` : ''}.`;
  return recordedPaymentToast(amount ?? 0, number, paidInFull);
}

export const SKIPPED_TEXT = 'Pominięto operację. Dane nadawcy i tytuł przelewu usunęliśmy.';
export const NOT_CONFIRMED_TEXT = 'Ta operacja nie ma już zapisanej wpłaty. Odśwież stronę.';

export function undoneText(amount: number | null): string {
  return amount === null ? 'Cofnięto wpłatę. Operacja wróciła do sprawdzenia.' : `Cofnięto wpłatę ${formatPaymentMoney(amount)}. Operacja wróciła do sprawdzenia.`;
}

// ─── Odczyt `bank_operations` (00180) ────────────────────────────────────

export interface PendingOperation {
  id: string;
  account: string;
  bookingDate: string;
  amountGrosze: number;
  currency: string;
  counterpartyName: string | null;
  counterpartyAccount: string | null;
  title: string | null;
}

export interface DecidedOperation {
  id: string;
  bookingDate: string;
  amountGrosze: number;
  state: 'confirmed' | 'skipped';
  decidedAt: string | null;
  invoiceId: string | null;
  invoiceNumber: string | null;
  /** Tylko przy potwierdzonych: dane pominiętych są usunięte. */
  counterpartyName: string | null;
  title: string | null;
}

export interface BankAccountSummary {
  account: string;
  operations: number;
  lastImportedAt: string | null;
}

export interface BankOperationsData {
  pending: PendingOperation[];
  /** Wszystkie wpływy do sprawdzenia (lista ma najwyżej 300). */
  pendingTotal: number;
  confirmedTotal: number;
  skippedTotal: number;
  decided: DecidedOperation[];
  accounts: BankAccountSummary[];
}

const isDay = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
const textOrNull = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
const count = (value: unknown): number | null => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null);

/** Kwota z bazy (NUMERIC z dwoma miejscami) w groszach; inna liczba to `null`. */
export function groszeZBazy(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
  if (!Number.isFinite(n)) return null;
  const grosze = Math.round(n * 100);
  return Number.isSafeInteger(grosze) && Math.abs(grosze - n * 100) < 1e-6 ? grosze : null;
}

function rows(value: unknown): Record<string, unknown>[] | null {
  if (!Array.isArray(value)) return null;
  return value.every((row) => typeof row === 'object' && row !== null && !Array.isArray(row)) ? (value as Record<string, unknown>[]) : null;
}

/**
 * Wynik RPC `bank_operations`. Kształt inny niż oczekiwany to `null`: ekran
 * mówi wtedy, że operacji nie udało się wczytać, zamiast pokazać pustą listę.
 */
export function parseBankOperationsRpc(data: unknown): BankOperationsData | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  const pendingRows = rows(d.pending);
  const decidedRows = rows(d.decided);
  const accountRows = rows(d.accounts);
  const pendingTotal = count(d.pending_total);
  const confirmedTotal = count(d.confirmed_total);
  const skippedTotal = count(d.skipped_total);
  if (!pendingRows || !decidedRows || !accountRows || pendingTotal === null || confirmedTotal === null || skippedTotal === null) return null;

  const pending: PendingOperation[] = [];
  for (const row of pendingRows) {
    const amountGrosze = groszeZBazy(row.amount);
    if (typeof row.id !== 'string' || typeof row.account !== 'string' || !isDay(row.booking_date) || amountGrosze === null || typeof row.currency !== 'string') {
      return null;
    }
    pending.push({
      id: row.id,
      account: row.account,
      bookingDate: row.booking_date,
      amountGrosze,
      currency: row.currency,
      counterpartyName: textOrNull(row.counterparty_name),
      counterpartyAccount: textOrNull(row.counterparty_account),
      title: textOrNull(row.title),
    });
  }

  const decided: DecidedOperation[] = [];
  for (const row of decidedRows) {
    const amountGrosze = groszeZBazy(row.amount);
    if (typeof row.id !== 'string' || !isDay(row.booking_date) || amountGrosze === null || (row.state !== 'confirmed' && row.state !== 'skipped')) {
      return null;
    }
    // Pominięty przelew do ZUS albo urzędu (00186) ma własną listę w zapłatach rozliczeń, nie przy wpłatach do faktur.
    if (amountGrosze < 0) continue;
    decided.push({
      id: row.id,
      bookingDate: row.booking_date,
      amountGrosze,
      state: row.state,
      decidedAt: textOrNull(row.decided_at),
      invoiceId: textOrNull(row.invoice_id),
      invoiceNumber: textOrNull(row.internal_number),
      counterpartyName: textOrNull(row.counterparty_name),
      title: textOrNull(row.title),
    });
  }

  const accounts: BankAccountSummary[] = [];
  for (const row of accountRows) {
    const operations = count(row.operations);
    if (typeof row.account !== 'string' || operations === null) return null;
    accounts.push({ account: row.account, operations, lastImportedAt: textOrNull(row.last_imported_at) });
  }

  return { pending, pendingTotal, confirmedTotal, skippedTotal, decided, accounts };
}

/** Rachunek do wyświetlenia: „PL61 1090 1014 …”, grupy po cztery znaki. */
export function formatAccount(account: string | null): string {
  if (!account) return '';
  return account.replace(/(.{4})(?=.)/g, '$1 ');
}

export const MATCH_KIND_LABELS: Record<MatchKind, string> = {
  ksef_number: 'Numer KSeF w tytule',
  invoice_number: 'Numer faktury w tytule',
  amount_name: 'Kwota i nazwa nabywcy',
  manual: 'Faktura wybrana ręcznie',
};

export const CONFIDENCE_LABELS = { high: 'pewne', medium: 'prawdopodobne', low: 'do sprawdzenia' } as const;

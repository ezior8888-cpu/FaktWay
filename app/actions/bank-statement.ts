'use server';

import type { SupabaseClient } from '@supabase/supabase-js';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { invalidateTenantDashboard } from '@/lib/cache/invalidation';
import type { ZapisanyIdentyfikator } from '@/lib/expenses/identyfikator-zbiorczy';
import { EXPENSE_PAYMENT_ROLES } from '@/lib/expenses/zaplata-kosztu';
import { todayInWarsaw } from '@/lib/format/warsaw-date';
import { parseBankFile, type BankOperation } from '@/lib/import/bank';
import {
  BANK_ROLE_REFUSAL,
  DECISION_FAILED,
  FILE_EMPTY,
  FILE_TOO_BIG,
  FILE_TOO_MANY,
  IMPORT_FAILED,
  MAX_BANK_FILE_BYTES,
  MAX_BANK_OPERATIONS,
  NOT_CONFIRMED_TEXT,
  SKIPPED_TEXT,
  bankRefusalText,
  confirmedText,
  groszeZBazy,
  isMatchKind,
  parseErrorText,
  undoneText,
  type BankDecisionResult,
  type ImportBankStatementResult,
} from '@/lib/import/bank/ekran';
import { operationKeys } from '@/lib/import/bank/klucz';
import {
  EXPENSE_BANK_ROLE_REFUSAL,
  EXPENSE_MATCH_FAILED,
  EXPENSE_NOT_CONFIRMED_TEXT,
  EXPENSE_SKIPPED_TEXT,
  RODZAJE_DOPASOWANIA_KOSZTU,
  bankExpenseConfirmedText,
  bankExpenseRefusalText,
  bankExpenseUndoneText,
  dopasujKoszty,
  type KosztDoPrzelewu,
  type PrzelewZPropozycja,
  type ProposeBankExpensesResult,
} from '@/lib/import/bank/koszty';
import { czytajKosztyNaRachunki, czytajZapisaneDlaTytulow, czytajZnaneOperacje } from '@/lib/import/bank/koszty-dane';
import { kwotaZGroszy } from '@/lib/import/bank/kwoty';
import { BANK_FILE_FORMATS } from '@/lib/import/bank/typy';
import type { MatchKind } from '@/lib/import/bank/dopasowanie';
import {
  RODZAJE_DOPASOWANIA_PODATKU,
  RODZAJE_PRZELEWU,
  TAX_NOT_CONFIRMED_TEXT,
  TAX_ROLE_REFUSAL,
  TAX_UNAVAILABLE,
  rodzajPrzelewu,
  taxConfirmedText,
  taxRefusalText,
  taxUndoneText,
  type KontaPodatkowe,
  type RodzajPrzelewu,
} from '@/lib/import/bank/podatki';
import { czytajKontaPodatkowe, zaplatyZWyciaguWlaczone } from '@/lib/import/bank/podatki-dane';
import { INVOICE_PAYMENT_ROLES } from '@/lib/invoices/manual-payment';
import { configuredKsefEnvironment } from '@/lib/ksef/claim-environment';
import { RODZAJE_ROZLICZEN, type RodzajRozliczenia } from '@/lib/ksiegowosc/ten-miesiac';
import { ActionAuthError, requireOrgRole, type AuthContext } from '@/lib/supabase/auth-context';

/**
 * Ekran „Bank” (plan kompletnej aplikacji, krok 3.2, część 1): wgranie wyciągu,
 * potwierdzenie, pominięcie i cofnięcie dopasowania. Akcje na kliencie sesji,
 * bez klucza serwisowego: `payment_imports` i `payments` są zamknięte dla sesji
 * (00074), więc jedyną drogą są RPC z 00180, które firmę i rolę biorą z sesji
 * i same zapisują audyt w transakcji ze zmianą.
 *
 * Wgranie: plik czyta parser po stronie serwera (czyste funkcje
 * `lib/import/bank/`), do bazy idą wpływy w złotych z kluczem duplikatu,
 * a przy włączonym module księgowości także przelewy do ZUS (rachunek
 * składkowy z ustawień podatkowych) i na mikrorachunek z NIP firmy (krok 3.2,
 * część 2, 00189). Innych wypływów i innych walut nie zapisujemy (RODO:
 * przechowujemy tylko operacje potrzebne do dopasowania).
 *
 * Przelewy do dostawców (krok 3.2, część 3, 00196) nie wchodzą do bazy przy
 * wgraniu: `proposeBankExpensePaymentsAction` liczy z tego samego pliku
 * propozycje kosztów z listy „Do zapłaty” i oddaje je klientowi, a operacja
 * zapisuje się dopiero przy „Potwierdź” albo wyborze kosztów
 * (`confirm_bank_expense_payment`: `mark_expense_paid` z 00177 z dniem
 * księgowania) albo jako znacznik bez danych osób trzecich przy „Pomiń”.
 *
 * Zapłata rozliczenia z wyciągu (`confirmBankTaxPaymentAction`) idzie tą samą
 * drogą co „Zapłacone” w „Ten miesiąc”: owner/admin, obszar `ten_miesiac`
 * wyłącznika, w bazie status i dzień zapłaty w `tax_settlements` (wyzwalacz
 * z 00168), tylko w jednej transakcji RPC z operacją z wyciągu.
 *
 * Ponowienie od zera: ten sam plik wysłany drugi raz daje te same klucze, więc
 * `ON CONFLICT DO NOTHING` nie doda żadnej operacji (RPC zwraca liczbę
 * duplikatów). Potwierdzenie to jedna transakcja RPC z blokadą wiersza
 * operacji; drugie potwierdzenie zwraca `already_confirmed` bez drugiej wpłaty,
 * a klucz idempotencji wpłaty pochodzi z operacji. Pominięcie i cofnięcie są
 * idempotentne (`already_skipped`, `not_confirmed`). Zapłata rozliczenia
 * z wyciągu: blokada wiersza operacji i rozliczeń w jednej transakcji, drugie
 * potwierdzenie zwraca `already_confirmed` bez zmian, a rozliczenia nie
 * potwierdzi drugi przelew (`settlement_linked`). Pamięć i widoki odświeżamy
 * przy każdym sukcesie, bo pierwsza próba mogła paść po zapisie.
 */

type RpcResult = PromiseLike<{ data: unknown; error: { code?: string; message: string } | null }>;
/** Funkcje z 00180 i 00189; do czasu typów z produkcji (`types/database.ts`) przez ten kształt. */
interface BankRpc {
  rpc(fn: 'import_bank_operations', args: { p_file_format: string; p_operations: BankOperationRow[] }): RpcResult;
  rpc(fn: 'confirm_bank_operation', args: { p_operation_id: string; p_invoice_id: string; p_match_kind: MatchKind }): RpcResult;
  rpc(fn: 'skip_bank_operation', args: { p_operation_id: string }): RpcResult;
  rpc(fn: 'undo_bank_operation', args: { p_operation_id: string }): RpcResult;
  rpc(fn: 'confirm_bank_tax_payment', args: { p_operation_id: string; p_settlement_ids: string[]; p_match_kind: string }): RpcResult;
  rpc(fn: 'undo_bank_tax_payment', args: { p_operation_id: string }): RpcResult;
  rpc(
    fn: 'confirm_bank_expense_payment',
    args: { p_file_format: string; p_operation: ExpenseOperationRow; p_expense_ids: string[]; p_match_kind: string },
  ): RpcResult;
  rpc(fn: 'skip_bank_expense_operation', args: { p_file_format: string; p_operation: SkippedExpenseOperationRow }): RpcResult;
  rpc(fn: 'undo_bank_expense_payment', args: { p_operation_id: string }): RpcResult;
}

interface BankOperationRow {
  key: string;
  account: string;
  booking_date: string;
  /** Kwota w złotych jako napis z kropką, liczona z groszy (bez liczb zmiennoprzecinkowych); wypływ z minusem. */
  amount: string;
  currency: string;
  counterparty_name: string | null;
  counterparty_account: string | null;
  title: string | null;
  reference: string | null;
  /** Tylko przy przelewie do ZUS albo urzędu (00189); wpływ nie ma tego pola. */
  tax_kind?: RodzajPrzelewu;
}

function operationRow(op: BankOperation, key: string): BankOperationRow {
  return {
    key,
    account: op.account,
    booking_date: op.bookingDate,
    amount: kwotaZGroszy(op.amountGrosze),
    currency: op.currency,
    counterparty_name: op.counterpartyName,
    counterparty_account: op.counterpartyAccount,
    title: op.title,
    reference: op.bankReference,
  };
}

/**
 * Wypływy w złotych do ZUS i urzędu: tylko przy włączonym module dla firmy.
 * Rachunków nie udało się odczytać: żadnego wypływu nie zapisujemy (bez
 * zgadywania), a wgranie tego samego pliku później je doda (klucz duplikatu
 * pomija to, co już weszło).
 */
async function taxDebits(
  client: SupabaseClient,
  tenantId: string,
  debits: readonly BankOperation[],
): Promise<{ ops: Array<{ op: BankOperation; kind: RodzajPrzelewu }>; unavailable: boolean }> {
  const pln = debits.filter((op) => op.currency === 'PLN');
  if (pln.length === 0 || !(await zaplatyZWyciaguWlaczone(client, tenantId))) return { ops: [], unavailable: false };
  let konta: KontaPodatkowe;
  try {
    konta = await czytajKontaPodatkowe(client, tenantId);
  } catch (error) {
    console.error('[bank-statement] rachunki podatkowe', error instanceof Error ? error.message : 'błąd');
    return { ops: [], unavailable: true };
  }
  const ops = pln.flatMap((op) => {
    const kind = rodzajPrzelewu(op.counterpartyAccount, konta);
    return kind ? [{ op, kind }] : [];
  });
  return { ops, unavailable: false };
}

const uuid = z.string().uuid();

async function authorized(): Promise<{ ctx: AuthContext } | { error: string }> {
  try {
    return { ctx: await requireOrgRole([...INVOICE_PAYMENT_ROLES]) };
  } catch (e) {
    if (e instanceof ActionAuthError) {
      return { error: e.message === 'Niewystarczające uprawnienia' ? BANK_ROLE_REFUSAL : e.message };
    }
    throw e;
  }
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function money(value: unknown): number | null {
  const grosze = groszeZBazy(value);
  return grosze === null ? null : grosze / 100;
}

/** Strony, na których zmienia się stan płatności faktury albo lista operacji. */
function revalidateBankViews(invoiceId: string | null): void {
  revalidatePath('/bank');
  revalidatePath('/invoices');
  if (invoiceId) revalidatePath(`/invoices/${invoiceId}`);
  revalidatePath('/payments/overdue');
  revalidatePath('/dashboard');
  revalidatePath('/przeplywy');
  revalidatePath('/analizy/sprzedaz');
}

export async function importBankStatementAction(formData: FormData): Promise<ImportBankStatementResult> {
  const file = formData.get('file');
  if (!(file instanceof File)) return { success: false, error: FILE_EMPTY };
  if (file.size === 0) return { success: false, error: FILE_EMPTY };
  if (file.size > MAX_BANK_FILE_BYTES) return { success: false, error: FILE_TOO_BIG };

  const auth = await authorized();
  if ('error' in auth) return { success: false, error: auth.error };
  const { supabase, tenantId } = auth.ctx;

  const parsed = parseBankFile(new Uint8Array(await file.arrayBuffer()));
  if (!parsed.ok) return { success: false, error: parseErrorText(parsed.code) };

  const credits = parsed.operations.filter((op) => op.amountGrosze > 0 && op.currency === 'PLN');
  const debits = parsed.operations.filter((op) => op.amountGrosze < 0);
  const otherCurrencySkipped = parsed.operations.filter((op) => op.amountGrosze > 0 && op.currency !== 'PLN').length;
  const tax = await taxDebits(supabase as unknown as SupabaseClient, tenantId, debits);
  const summary = {
    success: true as const,
    format: parsed.format,
    debitsSkipped: debits.length - tax.ops.length,
    otherCurrencySkipped,
    ...(tax.unavailable ? { taxUnavailable: true as const } : {}),
  };
  if (credits.length === 0 && tax.ops.length === 0) return { ...summary, inserted: 0, duplicates: 0 };
  if (credits.length + tax.ops.length > MAX_BANK_OPERATIONS) return { success: false, error: FILE_TOO_MANY };

  // Klucz liczony osobno dla wpływów i przelewów podatkowych: znak kwoty i tak je rozdziela.
  const keys = operationKeys(credits);
  const taxKeys = operationKeys(tax.ops.map((t) => t.op));
  const operations: BankOperationRow[] = [
    ...credits.map((op, i) => operationRow(op, keys[i]!)),
    ...tax.ops.map((t, i) => ({ ...operationRow(t.op, taxKeys[i]!), tax_kind: t.kind })),
  ];

  const { data, error } = await (supabase as unknown as BankRpc).rpc('import_bank_operations', {
    p_file_format: parsed.format,
    p_operations: operations,
  });
  if (error || typeof data !== 'object' || data === null) {
    console.error('[bank-statement] import_bank_operations', error?.code);
    return { success: false, error: IMPORT_FAILED };
  }
  const result = data as Record<string, unknown>;
  const taxInserted = typeof result.tax_inserted === 'number' ? result.tax_inserted : 0;
  if (result.status !== 'imported' || typeof result.inserted !== 'number' || typeof result.duplicates !== 'number' ||
      taxInserted < 0 || taxInserted > tax.ops.length || result.inserted - taxInserted > credits.length || result.inserted < taxInserted) {
    console.error('[bank-statement] import_bank_operations odmowa', text(result.code));
    return { success: false, error: IMPORT_FAILED };
  }
  revalidatePath('/bank');
  const inserted = result.inserted - taxInserted;
  return {
    ...summary,
    inserted,
    duplicates: credits.length - inserted,
    ...(tax.ops.length > 0 ? { tax: { inserted: taxInserted, duplicates: tax.ops.length - taxInserted } } : {}),
  };
}

export async function confirmBankOperationAction(input: {
  operationId: string;
  invoiceId: string;
  matchKind: MatchKind;
}): Promise<BankDecisionResult> {
  if (!uuid.safeParse(input?.operationId).success || !uuid.safeParse(input?.invoiceId).success || !isMatchKind(input?.matchKind)) {
    return { success: false, error: DECISION_FAILED };
  }
  const auth = await authorized();
  if ('error' in auth) return { success: false, error: auth.error };
  const { supabase, tenantId } = auth.ctx;

  const { data, error } = await (supabase as unknown as BankRpc).rpc('confirm_bank_operation', {
    p_operation_id: input.operationId,
    p_invoice_id: input.invoiceId,
    p_match_kind: input.matchKind,
  });
  if (error || typeof data !== 'object' || data === null) {
    console.error('[bank-statement] confirm_bank_operation', error?.code);
    return { success: false, error: DECISION_FAILED };
  }
  const result = data as Record<string, unknown>;
  const number = text(result.internal_number);
  if (result.status === 'refused') {
    return {
      success: false,
      error: bankRefusalText(result.code, { number, remaining: money(result.remaining), currency: text(result.currency) }),
    };
  }
  if (result.status !== 'confirmed' && result.status !== 'already_confirmed') return { success: false, error: DECISION_FAILED };

  await invalidateTenantDashboard(tenantId);
  revalidateBankViews(input.invoiceId);
  return {
    success: true,
    status: result.status,
    message: confirmedText(result.status, money(result.amount), number, result.payment_status === 'paid'),
  };
}

export async function skipBankOperationAction(operationId: string): Promise<BankDecisionResult> {
  if (!uuid.safeParse(operationId).success) return { success: false, error: DECISION_FAILED };
  const auth = await authorized();
  if ('error' in auth) return { success: false, error: auth.error };

  const { data, error } = await (auth.ctx.supabase as unknown as BankRpc).rpc('skip_bank_operation', { p_operation_id: operationId });
  if (error || typeof data !== 'object' || data === null) {
    console.error('[bank-statement] skip_bank_operation', error?.code);
    return { success: false, error: DECISION_FAILED };
  }
  const result = data as Record<string, unknown>;
  if (result.status === 'refused') {
    return { success: false, error: bankRefusalText(result.code, { number: text(result.internal_number) }) };
  }
  if (result.status !== 'skipped' && result.status !== 'already_skipped') return { success: false, error: DECISION_FAILED };
  revalidatePath('/bank');
  return { success: true, status: result.status, message: SKIPPED_TEXT };
}

export async function undoBankOperationAction(operationId: string): Promise<BankDecisionResult> {
  if (!uuid.safeParse(operationId).success) return { success: false, error: DECISION_FAILED };
  const auth = await authorized();
  if ('error' in auth) return { success: false, error: auth.error };
  const { supabase, tenantId } = auth.ctx;

  const { data, error } = await (supabase as unknown as BankRpc).rpc('undo_bank_operation', { p_operation_id: operationId });
  if (error || typeof data !== 'object' || data === null) {
    console.error('[bank-statement] undo_bank_operation', error?.code);
    return { success: false, error: DECISION_FAILED };
  }
  const result = data as Record<string, unknown>;
  if (result.status === 'refused') {
    return {
      success: false,
      error: bankRefusalText(result.code, {
        number: text(result.internal_number),
        manualPaidOn: text(result.manual_paid_on),
        manualAmount: money(result.manual_amount),
      }),
    };
  }
  if (result.status === 'not_confirmed') {
    revalidatePath('/bank');
    return { success: true, status: 'not_confirmed', message: NOT_CONFIRMED_TEXT };
  }
  if (result.status !== 'undone') return { success: false, error: DECISION_FAILED };

  await invalidateTenantDashboard(tenantId);
  revalidateBankViews(text(result.invoice_id));
  return { success: true, status: 'undone', message: undoneText(money(result.amount)) };
}

// ─── Przelewy do ZUS i urzędu jako zapłaty rozliczeń (00189) ─────────────

/** Zapłaty rozliczeń oznacza owner/admin, jak „Zapłacone” w „Ten miesiąc” (polityka UPDATE z 00168). */
async function authorizedTax(): Promise<{ ctx: AuthContext } | { error: string }> {
  try {
    return { ctx: await requireOrgRole(['owner', 'admin']) };
  } catch (e) {
    if (e instanceof ActionAuthError) {
      return { error: e.message === 'Niewystarczające uprawnienia' ? TAX_ROLE_REFUSAL : e.message };
    }
    throw e;
  }
}

/** Strony, na których widać zapłatę rozliczenia: „Bank”, „Ten miesiąc” i księga (składki jako koszt w KPiR). */
function revalidateTaxViews(): void {
  revalidatePath('/bank');
  revalidatePath('/reports/ten-miesiac');
  revalidatePath('/reports/ewidencja');
}

const taxConfirmSchema = z.object({
  operationId: uuid,
  settlementIds: z
    .array(uuid)
    .min(1)
    .max(2)
    .refine((ids) => new Set(ids).size === ids.length),
  matchKind: z.enum(RODZAJE_DOPASOWANIA_PODATKU),
});

const isTaxKind = (value: unknown): value is RodzajPrzelewu => typeof value === 'string' && (RODZAJE_PRZELEWU as readonly string[]).includes(value);
const isSettlementKind = (value: unknown): value is RodzajRozliczenia =>
  typeof value === 'string' && (RODZAJE_ROZLICZEN as readonly string[]).includes(value);
const integer = (value: unknown): number | null => (typeof value === 'number' && Number.isSafeInteger(value) ? value : null);

/**
 * Potwierdzenie przelewu do ZUS albo urzędu jako zapłaty rozliczenia (krok 3.2,
 * część 2). RPC `confirm_bank_tax_payment` w jednej transakcji: blokada
 * operacji i rozliczeń, status „zapłacone” z dniem księgowania z wyciągu
 * (tylko dla rozliczeń jeszcze niezapłaconych), połączenie z operacją, audyt.
 * Kwota z banku zostaje przy operacji; wyliczenie rozliczenia się nie zmienia.
 */
export async function confirmBankTaxPaymentAction(input: {
  operationId: string;
  settlementIds: string[];
  matchKind: (typeof RODZAJE_DOPASOWANIA_PODATKU)[number];
}): Promise<BankDecisionResult> {
  const parsed = taxConfirmSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: DECISION_FAILED };
  const auth = await authorizedTax();
  if ('error' in auth) return { success: false, error: auth.error };
  const { supabase, tenantId } = auth.ctx;
  if (!(await zaplatyZWyciaguWlaczone(supabase as unknown as SupabaseClient, tenantId))) return { success: false, error: TAX_UNAVAILABLE };

  const { data, error } = await (supabase as unknown as BankRpc).rpc('confirm_bank_tax_payment', {
    p_operation_id: parsed.data.operationId,
    p_settlement_ids: parsed.data.settlementIds,
    p_match_kind: parsed.data.matchKind,
  });
  if (error || typeof data !== 'object' || data === null) {
    console.error('[bank-statement] confirm_bank_tax_payment', error?.code);
    return { success: false, error: DECISION_FAILED };
  }
  const result = data as Record<string, unknown>;
  if (result.status === 'refused') {
    return { success: false, error: taxRefusalText(result.code, { linkedOn: text(result.linked_on), okres: text(result.okres) }) };
  }
  if (result.status !== 'confirmed' && result.status !== 'already_confirmed') return { success: false, error: DECISION_FAILED };

  revalidateTaxViews();
  return {
    success: true,
    status: result.status,
    message: taxConfirmedText({
      status: result.status,
      rodzaj: isTaxKind(result.tax_kind) ? result.tax_kind : null,
      okres: text(result.okres),
      rodzaje: Array.isArray(result.rodzaje) ? result.rodzaje.filter(isSettlementKind) : [],
      paidOn: text(result.paid_on),
      computedGr: integer(result.computed_gr),
      differenceGr: integer(result.difference_gr),
      marked: integer(result.marked),
    }),
  };
}

/**
 * Cofnięcie potwierdzenia: rozliczenia, które to potwierdzenie oznaczyło jako
 * zapłacone, wracają do „zatwierdzone”, chyba że ktoś zmienił je później
 * (wtedy zostają); operacja wraca do sprawdzenia. Drugie cofnięcie to
 * `not_confirmed` bez zmian.
 */
export async function undoBankTaxPaymentAction(operationId: string): Promise<BankDecisionResult> {
  if (!uuid.safeParse(operationId).success) return { success: false, error: DECISION_FAILED };
  const auth = await authorizedTax();
  if ('error' in auth) return { success: false, error: auth.error };
  const { supabase, tenantId } = auth.ctx;
  if (!(await zaplatyZWyciaguWlaczone(supabase as unknown as SupabaseClient, tenantId))) return { success: false, error: TAX_UNAVAILABLE };

  const { data, error } = await (supabase as unknown as BankRpc).rpc('undo_bank_tax_payment', { p_operation_id: operationId });
  if (error || typeof data !== 'object' || data === null) {
    console.error('[bank-statement] undo_bank_tax_payment', error?.code);
    return { success: false, error: DECISION_FAILED };
  }
  const result = data as Record<string, unknown>;
  if (result.status === 'refused') return { success: false, error: taxRefusalText(result.code) };
  if (result.status === 'not_confirmed') {
    revalidatePath('/bank');
    return { success: true, status: 'not_confirmed', message: TAX_NOT_CONFIRMED_TEXT };
  }
  if (result.status !== 'undone') return { success: false, error: DECISION_FAILED };

  revalidateTaxViews();
  return { success: true, status: 'undone', message: taxUndoneText(integer(result.reverted) ?? 0, integer(result.kept) ?? 0) };
}

// ─── Przelewy do dostawców jako zapłaty kosztów (00196) ──────────────────

/** Operacja dla `confirm_bank_expense_payment`: dane z banku zostają przy zapłacie jako dowód. */
interface ExpenseOperationRow {
  key: string;
  account: string;
  booking_date: string;
  /** Kwota w złotych jako napis z kropką i minusem, liczona z groszy. */
  amount: string;
  currency: 'PLN';
  counterparty_name: string | null;
  counterparty_account: string;
  title: string | null;
  reference: string | null;
}

/** Operacja dla `skip_bank_expense_operation`: bez tytułu, nazwy i referencji (RODO). */
type SkippedExpenseOperationRow = Pick<ExpenseOperationRow, 'key' | 'account' | 'booking_date' | 'amount' | 'currency' | 'counterparty_account'>;

/** Zapłatę kosztu oznacza owner, admin albo member, jak „Oznacz jako zapłacone” (00177); księgowa ma wgląd. */
async function authorizedExpense(): Promise<{ ctx: AuthContext } | { error: string }> {
  try {
    return { ctx: await requireOrgRole([...EXPENSE_PAYMENT_ROLES]) };
  } catch (e) {
    if (e instanceof ActionAuthError) {
      return { error: e.message === 'Niewystarczające uprawnienia' ? EXPENSE_BANK_ROLE_REFUSAL : e.message };
    }
    throw e;
  }
}

const validDay = (value: string) => {
  const parsed = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

/** Wypływ odesłany przez ekran: te same granice co w 00196, sprawdzone przed RPC. */
const expenseTransferSchema = z.object({
  key: z.string().regex(/^v1:[0-9a-f]{64}$/),
  account: z.string().regex(/^[A-Z]{2}[0-9]{2}[A-Z0-9]{8,30}$/),
  bookingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(validDay),
  amountGrosze: z.number().int().negative(),
  counterpartyName: z.string().max(500).nullable(),
  counterpartyAccount: z.string().min(1).max(64),
  title: z.string().max(1000).nullable(),
  reference: z.string().max(100).nullable(),
});
type ExpenseTransfer = z.infer<typeof expenseTransferSchema>;

const fileFormatSchema = z.enum(BANK_FILE_FORMATS);

const expenseConfirmSchema = z.object({
  fileFormat: fileFormatSchema,
  przelew: expenseTransferSchema,
  expenseIds: z
    .array(uuid)
    .min(1)
    .max(500)
    .refine((ids) => new Set(ids).size === ids.length),
  matchKind: z.enum(RODZAJE_DOPASOWANIA_KOSZTU),
});

const expenseSkipSchema = z.object({ fileFormat: fileFormatSchema, przelew: expenseTransferSchema });

function expenseOperationRow(p: ExpenseTransfer): ExpenseOperationRow {
  return {
    key: p.key,
    account: p.account,
    booking_date: p.bookingDate,
    amount: kwotaZGroszy(p.amountGrosze),
    currency: 'PLN',
    counterparty_name: p.counterpartyName,
    counterparty_account: p.counterpartyAccount,
    title: p.title,
    reference: p.reference,
  };
}

/** Strony, na których widać zapłatę kosztu: „Bank”, Wydatki („Do zapłaty”) i karta kosztu. */
function revalidateExpenseBankViews(expenseIds: readonly string[]): void {
  revalidatePath('/bank');
  revalidatePath('/expenses');
  for (const id of expenseIds) revalidatePath(`/expenses/${id}`);
}

const uuidList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && uuid.safeParse(v).success) : [];

/**
 * Propozycje kosztów dla przelewów z wgranego wyciągu (krok 3.2, część 3). Nic
 * nie zapisuje: wypływy wracają do klienta tylko wtedy, gdy rachunek odbiorcy
 * jest rachunkiem z faktury kosztu z listy „Do zapłaty”; pozostałe (prywatne
 * wydatki, wynagrodzenia, inne waluty) zostają w pliku. Przelewy rozstrzygnięte
 * wcześniej (ten sam klucz duplikatu w bazie) nie wracają. Każdy błąd odczytu
 * to brak propozycji z komunikatem, nie pusta lista (fail-closed).
 */
export async function proposeBankExpensePaymentsAction(formData: FormData): Promise<ProposeBankExpensesResult> {
  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) return { success: false, error: FILE_EMPTY };
  if (file.size > MAX_BANK_FILE_BYTES) return { success: false, error: FILE_TOO_BIG };

  const auth = await authorizedExpense();
  if ('error' in auth) return { success: false, error: auth.error };
  const { supabase, tenantId } = auth.ctx;

  const parsed = parseBankFile(new Uint8Array(await file.arrayBuffer()));
  if (!parsed.ok) return { success: false, error: parseErrorText(parsed.code) };

  // Klucz liczony po wszystkich wypływach w złotych z pliku, więc nie zależy od tego, które pasują do kosztów.
  const debits = parsed.operations.filter((op) => op.amountGrosze < 0 && op.currency === 'PLN');
  if (debits.length === 0) return { success: true, fileFormat: parsed.format, przelewy: [], koszty: [], znane: 0 };
  const srodowisko = configuredKsefEnvironment();
  if (!srodowisko) {
    console.error('[bank-statement] koszty do przelewów: brak środowiska KSeF aplikacji');
    return { success: false, error: EXPENSE_MATCH_FAILED };
  }
  const keys = operationKeys(debits);
  const client = supabase as unknown as SupabaseClient;

  let koszty: KosztDoPrzelewu[];
  let zapisane: ZapisanyIdentyfikator[];
  try {
    koszty = await czytajKosztyNaRachunki(client, tenantId, srodowisko, debits.map((op) => op.counterpartyAccount), todayInWarsaw());
    zapisane = koszty.length > 0 ? await czytajZapisaneDlaTytulow(client, tenantId, srodowisko, debits.map((op) => op.title)) : [];
  } catch (error) {
    console.error('[bank-statement] koszty do przelewów', error instanceof Error ? error.message : 'błąd');
    return { success: false, error: EXPENSE_MATCH_FAILED };
  }

  const pasujace: PrzelewZPropozycja[] = [];
  debits.forEach((op, i) => {
    const dopasowanie = dopasujKoszty(op, koszty, zapisane);
    if (!dopasowanie) return;
    pasujace.push({
      key: keys[i]!,
      account: op.account,
      bookingDate: op.bookingDate,
      amountGrosze: op.amountGrosze,
      counterpartyName: op.counterpartyName,
      counterpartyAccount: op.counterpartyAccount,
      title: op.title,
      reference: op.bankReference,
      ...dopasowanie,
    });
  });
  if (pasujace.length === 0) return { success: true, fileFormat: parsed.format, przelewy: [], koszty: [], znane: 0 };

  let znane: Map<string, string>;
  try {
    znane = await czytajZnaneOperacje(client, pasujace.map((p) => p.key));
  } catch (error) {
    console.error('[bank-statement] znane operacje', error instanceof Error ? error.message : 'błąd');
    return { success: false, error: EXPENSE_MATCH_FAILED };
  }
  const przelewy = pasujace.filter((p) => !znane.has(p.key));
  const uzyte = new Set(przelewy.flatMap((p) => p.kandydaci));
  return {
    success: true,
    fileFormat: parsed.format,
    przelewy,
    koszty: koszty.filter((k) => uzyte.has(k.id)),
    znane: pasujace.length - przelewy.length,
  };
}

/**
 * Potwierdzenie przelewu jako zapłaty kosztów (jedno kliknięcie przy pewnym
 * dopasowaniu albo wybór klienta). RPC `confirm_bank_expense_payment` w jednej
 * transakcji: blokada klucza operacji i kosztów, granice (rachunek z faktury,
 * kwota równa sumie do zapłaty, złote, koszt niezapłacony), `mark_expense_paid`
 * z dniem księgowania, operacja jako dowód zapłaty, audyt. Ponowienie z tym
 * samym wyborem to `already_confirmed` bez zmian.
 */
export async function confirmBankExpensePaymentAction(input: {
  fileFormat: string;
  przelew: ExpenseTransfer;
  expenseIds: string[];
  matchKind: string;
}): Promise<BankDecisionResult> {
  const parsed = expenseConfirmSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: DECISION_FAILED };
  const auth = await authorizedExpense();
  if ('error' in auth) return { success: false, error: auth.error };

  const { data, error } = await (auth.ctx.supabase as unknown as BankRpc).rpc('confirm_bank_expense_payment', {
    p_file_format: parsed.data.fileFormat,
    p_operation: expenseOperationRow(parsed.data.przelew),
    p_expense_ids: parsed.data.expenseIds,
    p_match_kind: parsed.data.matchKind,
  });
  if (error || typeof data !== 'object' || data === null) {
    console.error('[bank-statement] confirm_bank_expense_payment', error?.code);
    return { success: false, error: DECISION_FAILED };
  }
  const result = data as Record<string, unknown>;
  if (result.status === 'refused') {
    return {
      success: false,
      error: bankExpenseRefusalText(result.code, {
        documentNumber: text(result.document_number),
        dueGr: integer(result.due_gr),
        amountGr: integer(result.amount_gr),
      }),
    };
  }
  if (result.status !== 'confirmed' && result.status !== 'already_confirmed') return { success: false, error: DECISION_FAILED };

  revalidateExpenseBankViews(parsed.data.expenseIds);
  const documents = Array.isArray(result.documents)
    ? result.documents
        .filter((d): d is Record<string, unknown> => typeof d === 'object' && d !== null)
        .map((d) => ({ numer: text(d.document_number), sprzedawca: text(d.seller_name) }))
    : [];
  return {
    success: true,
    status: result.status,
    message: bankExpenseConfirmedText({ status: result.status, paidOn: text(result.paid_on), documents }),
  };
}

/**
 * „Pomiń” przy przelewie do dostawcy: w bazie zostaje znacznik bez danych osób
 * trzecich (kwota, dzień, rachunek firmy, klucz), żeby przelew nie wrócił przy
 * kolejnym wgraniu. Do RPC nie idą tytuł, nazwa ani referencja; rachunek
 * odbiorcy tylko do sprawdzenia, że to rachunek z kosztów firmy (nie zapisuje się).
 */
export async function skipBankExpenseOperationAction(input: { fileFormat: string; przelew: ExpenseTransfer }): Promise<BankDecisionResult> {
  const parsed = expenseSkipSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: DECISION_FAILED };
  const auth = await authorizedExpense();
  if ('error' in auth) return { success: false, error: auth.error };

  const row = expenseOperationRow(parsed.data.przelew);
  const { data, error } = await (auth.ctx.supabase as unknown as BankRpc).rpc('skip_bank_expense_operation', {
    p_file_format: parsed.data.fileFormat,
    p_operation: {
      key: row.key,
      account: row.account,
      booking_date: row.booking_date,
      amount: row.amount,
      currency: row.currency,
      counterparty_account: row.counterparty_account,
    },
  });
  if (error || typeof data !== 'object' || data === null) {
    console.error('[bank-statement] skip_bank_expense_operation', error?.code);
    return { success: false, error: DECISION_FAILED };
  }
  const result = data as Record<string, unknown>;
  if (result.status === 'refused') return { success: false, error: bankExpenseRefusalText(result.code) };
  if (result.status !== 'skipped' && result.status !== 'already_skipped') return { success: false, error: DECISION_FAILED };
  revalidatePath('/bank');
  return { success: true, status: result.status, message: EXPENSE_SKIPPED_TEXT };
}

/**
 * „Cofnij” zapłaty kosztów z przelewu: koszty, które to potwierdzenie oznaczyło
 * i których nikt potem nie zmienił, wracają na listę „Do zapłaty” przez
 * `undo_expense_paid` (00177); operacja znika z bazy (niepotwierdzony wypływ nie
 * zostaje), więc przypisuje się ją od nowa po ponownym wgraniu wyciągu. Drugie
 * cofnięcie nic nie zmienia.
 */
export async function undoBankExpensePaymentAction(operationId: string): Promise<BankDecisionResult> {
  if (!uuid.safeParse(operationId).success) return { success: false, error: DECISION_FAILED };
  const auth = await authorizedExpense();
  if ('error' in auth) return { success: false, error: auth.error };

  const { data, error } = await (auth.ctx.supabase as unknown as BankRpc).rpc('undo_bank_expense_payment', { p_operation_id: operationId });
  if (error || typeof data !== 'object' || data === null) {
    console.error('[bank-statement] undo_bank_expense_payment', error?.code);
    return { success: false, error: DECISION_FAILED };
  }
  const result = data as Record<string, unknown>;
  if (result.status === 'not_confirmed' || (result.status === 'refused' && result.code === 'operation_not_found')) {
    revalidatePath('/bank');
    return { success: true, status: 'not_confirmed', message: EXPENSE_NOT_CONFIRMED_TEXT };
  }
  if (result.status === 'refused') return { success: false, error: bankExpenseRefusalText(result.code) };
  if (result.status !== 'undone') return { success: false, error: DECISION_FAILED };

  revalidateExpenseBankViews(uuidList(result.expense_ids));
  const kept = Array.isArray(result.kept_documents) ? result.kept_documents.filter((n): n is string => typeof n === 'string' && n !== '') : [];
  return { success: true, status: 'undone', message: bankExpenseUndoneText(integer(result.reverted) ?? 0, kept) };
}

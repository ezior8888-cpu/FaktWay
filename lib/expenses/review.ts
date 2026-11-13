import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { learnFromCorrection } from '@/lib/categorization';
import { deductibleAfterVatChange } from '@/lib/categorization/vat-deduction';
import { hasKsefCurrencyRate } from '@/lib/expenses/ksef-currency-review';
import {
  ocrAmountsAwaitingPln,
  ocrForeignCurrency,
  withPlnConfirmation,
} from '@/lib/expenses/ocr-currency-review';
import { createAdminClient } from '@/lib/supabase/admin';
import type { Database } from '@/types/database';

/**
 * Zatwierdzenie albo poprawka kosztu (opis, kwoty, kolumna KPiR, kategoria,
 * KPiR tak albo nie). Do M9 planu aplikacji mobilnej to było ciało
 * `reviewExpenseAction` (`app/actions/expenses.ts`); teraz woła je akcja
 * strony i trasa `POST /api/mobile/v1/wydatki/{id}/zatwierdzenie`, obie po
 * swojej bramce (sesja, 2FA, członkostwo w firmie `tenantId`). Zmiana
 * kategorii uczy regułę dla sprzedawcy (`learnFromCorrection`).
 *
 * NIE eksportuj tego z pliku `'use server'`: `tenantId` i `userId` przychodzą
 * z argumentu, a koszt KSeF zapisuje się kluczem serwisowym (RPC).
 *
 * Wynik odmowy ma `reason` dla tras telefonu (kod HTTP i kod błędu); akcja
 * strony oddaje samo `error`, jak przed wydzieleniem (test zgodności
 * `tests/unit/wydatki-lib-zgodnosc.test.ts`).
 */

export type ExpenseReviewUpdates = {
  kpir_column?: string;
  category_label?: string;
  is_deductible?: boolean;
  notes?: string;
  seller_name?: string;
  seller_nip?: string | null;
  document_number?: string;
  issue_date?: string;
  net_amount?: number;
  vat_amount?: number;
  gross_amount?: number;
  /** Potwierdzenie porównania walutowej faktury KSeF z XML i kwotami PLN. */
  confirmForeignCurrencyReview?: boolean;
  /**
   * Koszt OCR w walucie bez kursu NBP: klient potwierdza, że wpisane kwoty
   * są już w złotych (`lib/expenses/ocr-currency-review.ts`). Nie dla KSeF:
   * ścisły schemat KSeF odrzuca to pole.
   */
  confirmPlnAmounts?: boolean;
};

export interface ExpenseReviewContext {
  /** Klient z sesji użytkownika (RLS): z ciasteczek na stronie, z tokenu w telefonie. */
  supabase: SupabaseClient<Database>;
  userId: string;
  /** Firma po sprawdzeniu członkostwa przez bramkę wołającego. */
  tenantId: string;
}

export interface ExpenseReviewOptions {
  /**
   * Telefon (M9) opisuje tylko koszty spoza KSeF: koszt z KSeF wymaga
   * porównania z XML i kursem, które ma tylko strona. Odmowa przed zapisem.
   */
  refuseKsef?: boolean;
}

/**
 * - `not_found`: wydatku nie ma w tej firmie (albo zniknął przed zapisem);
 * - `read_failed`: odczyt wydatku nieudany (strona mówi wtedy „nie istnieje”, jak dotąd);
 * - `invalid`: dane spoza schematu kosztu KSeF;
 * - `refused`: zasada zapisu (waluta, kurs, niespójne powiązanie z KSeF), `error` mówi co zrobić;
 * - `conflict`: koszt KSeF zmienił się w międzyczasie;
 * - `write_failed`: zapis w bazie nieudany;
 * - `ksef`: koszt z KSeF przy `refuseKsef`.
 */
export type ExpenseReviewRefusal = 'not_found' | 'read_failed' | 'invalid' | 'refused' | 'conflict' | 'write_failed' | 'ksef';

export type ExpenseReviewResult = { success: true } | { success: false; error: string; reason: ExpenseReviewRefusal };

// Argumenty akcji i treść żądania telefonu są niezaufane. Ten schemat działa
// przed każdym zapisem kosztu KSeF kluczem serwisowym; zwykła ścieżka RLS bez zmian.
const moneySchema = z.number().finite().min(-999_999_999_999.99).max(999_999_999_999.99);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((date) => {
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
});
const ksefReviewSchema = z.strictObject({
  kpir_column: z.enum(['col_7', 'col_8', 'col_10', 'col_11', 'col_12', 'col_13', 'col_15', 'col_16']).optional(),
  category_label: z.string().max(200).optional(),
  is_deductible: z.boolean().optional(),
  notes: z.string().max(10_000).optional(),
  seller_name: z.string().trim().min(1).max(500).optional(),
  seller_nip: z.string().max(32).nullable().optional(),
  document_number: z.string().max(200).optional(),
  issue_date: dateSchema.optional(),
  net_amount: moneySchema.optional(),
  vat_amount: moneySchema.optional(),
  gross_amount: moneySchema.optional(),
  confirmForeignCurrencyReview: z.boolean().optional(),
});

function buildExpenseUpdatePatch(
  updates: ExpenseReviewUpdates,
  categoryChanged: boolean,
): Database['public']['Tables']['expenses']['Update'] {
  const patch: Database['public']['Tables']['expenses']['Update'] = {
    is_reviewed: true,
  };

  if (updates.kpir_column !== undefined) {
    patch.kpir_column = updates.kpir_column as Database['public']['Enums']['kpir_column'];
  }
  if (updates.category_label !== undefined) {
    patch.category_label = updates.category_label;
  }
  if (updates.is_deductible !== undefined) {
    patch.is_deductible = updates.is_deductible;
  }
  if (updates.notes !== undefined) {
    patch.notes = updates.notes;
  }
  if (updates.seller_name !== undefined) {
    patch.seller_name = updates.seller_name;
  }
  if (updates.seller_nip !== undefined) {
    patch.seller_nip = updates.seller_nip;
  }
  if (updates.document_number !== undefined) {
    patch.document_number = updates.document_number;
  }
  if (updates.issue_date !== undefined) {
    patch.issue_date = updates.issue_date;
  }
  if (updates.net_amount !== undefined) {
    patch.net_amount = updates.net_amount;
  }
  if (updates.vat_amount !== undefined) {
    patch.vat_amount = updates.vat_amount;
  }
  if (updates.gross_amount !== undefined) {
    patch.gross_amount = updates.gross_amount;
  }
  if (categoryChanged) {
    patch.categorization_method = 'manual';
  }

  return patch;
}

const refuse = (reason: ExpenseReviewRefusal, error: string): ExpenseReviewResult => ({ success: false, error, reason });

const MISSING = 'Wydatek nie istnieje';

export async function reviewExpense(
  { supabase, userId, tenantId }: ExpenseReviewContext,
  expenseId: string,
  updates: ExpenseReviewUpdates,
  options: ExpenseReviewOptions = {},
): Promise<ExpenseReviewResult> {
  const { data: existing, error: readError } = await supabase
    .from('expenses')
    .select('seller_nip, seller_name, kpir_column, category_label, vat_amount, vat_deductible_amount, is_deductible, source, ksef_invoice_id, issue_date, ocr_extracted_data, updated_at')
    .eq('id', expenseId)
    .eq('tenant_id', tenantId)
    .maybeSingle();

  if (!existing) {
    return refuse(readError ? 'read_failed' : 'not_found', MISSING);
  }

  const isKsefExpense = existing.source === 'ksef_inbox' || existing.ksef_invoice_id != null;
  if (isKsefExpense && options.refuseKsef) {
    return refuse('ksef', 'Wydatek z KSeF opiszesz na faktway.pl: tam porównasz go z fakturą z KSeF.');
  }
  if (isKsefExpense) {
    const parsed = ksefReviewSchema.safeParse(updates);
    if (!parsed.success) {
      return refuse('invalid', 'Nieprawidłowe dane wydatku KSeF');
    }
    updates = parsed.data;
    if (existing.source !== 'ksef_inbox') {
      return refuse('refused', 'Niespójne powiązanie kosztu KSeF. Wymagane uzgodnienie przez operatora.');
    }
  }

  // Dotyczy także historycznych kosztów bez nowego śladu FX: źródłem prawdy
  // jest waluta powiązanej faktury, a nie opcjonalny JSON przy wydatku.
  let excludedWithoutCurrencyReview = false;
  let missingKsefFxRate = false;
  if (existing.source === 'ksef_inbox') {
    const { data: invoice, error: invoiceError } = existing.ksef_invoice_id
      ? await supabase
        .from('invoices')
        .select('currency')
        .eq('id', existing.ksef_invoice_id)
        .eq('tenant_id', tenantId)
        .maybeSingle()
      : { data: null, error: null };
    const currency = invoice?.currency?.trim().toUpperCase();
    if (invoiceError || !currency || !/^[A-Z]{3}$/.test(currency)) {
      // Bez źródłowej waluty dopuszczamy wyłącznie bezpieczne wyłączenie
      // historycznego kosztu z KPiR; dalsze zatwierdzanie czeka na operatora.
      if (updates.is_deductible !== false) {
        return refuse('refused', 'Nie można potwierdzić waluty faktury KSeF');
      }
      excludedWithoutCurrencyReview = true;
    } else if (currency !== 'PLN') {
      missingKsefFxRate = !hasKsefCurrencyRate(
        existing.ocr_extracted_data,
        currency,
        updates.issue_date ?? existing.issue_date,
      );
      excludedWithoutCurrencyReview = updates.is_deductible === false
        && (missingKsefFxRate || updates.confirmForeignCurrencyReview !== true);
      if (!excludedWithoutCurrencyReview && updates.confirmForeignCurrencyReview !== true) {
        return refuse(
          'refused',
          'Przed zatwierdzeniem wydatku walutowego sprawdź XML, kurs i kwoty PLN oraz potwierdź to w formularzu',
        );
      }
      if ((updates.is_deductible ?? existing.is_deductible) === true && missingKsefFxRate) {
        return refuse(
          'refused',
          'Brak potwierdzonego kursu przy tym koszcie KSeF. Nie można włączyć kwot w walucie obcej do KPiR.',
        );
      }
    }
  }

  // E17b: koszt OCR w walucie bez kursu NBP ma kwoty w walucie dokumentu.
  // Do KPiR wejdzie dopiero po jawnym potwierdzeniu, że klient wpisał złote;
  // bez niego KPiR liczyłaby np. 100 AED jako 100 zł. Ścieżka KSeF wyżej.
  const awaitingPlnCurrency = isKsefExpense ? null : ocrAmountsAwaitingPln(existing.ocr_extracted_data);
  const plnConfirmed = awaitingPlnCurrency !== null && updates.confirmPlnAmounts === true;
  if (
    awaitingPlnCurrency !== null &&
    !plnConfirmed &&
    (updates.is_deductible ?? existing.is_deductible) === true
  ) {
    return refuse(
      'refused',
      `Kwoty tego wydatku są w ${awaitingPlnCurrency}. Wpisz je w złotych i zaznacz w formularzu, że są w złotych. Dopiero wtedy wydatek wejdzie do KPiR.`,
    );
  }

  const kpirChanged =
    updates.kpir_column !== undefined &&
    updates.kpir_column !== existing.kpir_column;
  const labelChanged =
    updates.category_label !== undefined &&
    updates.category_label !== existing.category_label;
  const categoryChanged = kpirChanged || labelChanged;

  const patch = buildExpenseUpdatePatch(updates, categoryChanged);
  if (excludedWithoutCurrencyReview || missingKsefFxRate) patch.is_reviewed = false;

  if (awaitingPlnCurrency !== null) {
    if (plnConfirmed) {
      // Potwierdzenie złotych sam włącza koszt do KPiR (karta FLO i notatka
      // OCR obiecują: „wejdzie z kwotą w złotych”), chyba że klient świadomie
      // odznaczył KPiR. Ślad potwierdzenia dochodzi obok oryginału z dokumentu.
      patch.is_deductible = updates.is_deductible ?? true;
      patch.ocr_extracted_data = withPlnConfirmation(
        existing.ocr_extracted_data,
        userId,
        new Date().toISOString(),
      );
    } else {
      // Zapis poza KPiR bez potwierdzenia: kwoty dalej w walucie, koszt
      // zostaje „do opisania” (jak koszt KSeF bez potwierdzonego kursu).
      patch.is_reviewed = false;
    }
  }

  // Formularz wysyła VAT zawsze: odliczenie liczymy od nowa tylko przy
  // faktycznej zmianie, inaczej JPK_V7M odliczałby odczyt OCR.
  const vatBefore = Number(existing.vat_amount ?? 0);
  if (updates.vat_amount !== undefined && updates.vat_amount !== vatBefore) {
    // Dokument OCR w walucie obcej: VAT nie idzie do odliczenia automatycznie
    // (`lib/ocr/currency.ts`, `vatDeductible: 0`), także po ręcznej poprawce.
    // Bez tego poprawka z 0 dawała pełne odliczenie (`before.vat === 0`).
    patch.vat_deductible_amount = !isKsefExpense && ocrForeignCurrency(existing.ocr_extracted_data) !== null
      ? 0
      : deductibleAfterVatChange(
        { vat: vatBefore, deductible: Number(existing.vat_deductible_amount ?? 0) },
        updates.vat_amount,
      );
  }

  if (isKsefExpense) {
    // The only privileged write path for a KSeF expense. The service-role-only
    // RPC repeats membership and tenant checks, compares updated_at, and writes
    // the audit row in the same database transaction as the expense update.
    const { data: updatedId, error } = await createAdminClient().rpc('review_ksef_expense', {
      p_tenant_id: tenantId,
      p_expense_id: expenseId,
      p_actor_user_id: userId,
      p_expected_updated_at: existing.updated_at,
      p_patch: patch,
    });
    if (error) {
      return refuse('write_failed', 'Nie udało się bezpiecznie zapisać kosztu KSeF');
    }
    if (updatedId !== expenseId) {
      return refuse('conflict', 'Wydatek zmienił się w międzyczasie. Odśwież stronę.');
    }
  } else {
    const { data: updated, error } = await supabase
      .from('expenses')
      .update(patch)
      .eq('id', expenseId)
      .eq('tenant_id', tenantId)
      .select('id')
      .maybeSingle();

    // Strona pokazuje treść błędu bazy jak dotąd; telefon dostaje z `reason` własne zdanie.
    if (error) return refuse('write_failed', error.message);
    if (!updated) {
      return refuse('not_found', MISSING);
    }
  }

  const resolvedKpir = updates.kpir_column ?? existing.kpir_column;
  const resolvedLabel = updates.category_label ?? existing.category_label;

  if (
    categoryChanged &&
    resolvedKpir != null &&
    resolvedLabel != null &&
    resolvedLabel !== ''
  ) {
    try {
      await learnFromCorrection(tenantId, {
        seller_nip: updates.seller_nip ?? existing.seller_nip,
        seller_name: updates.seller_name ?? existing.seller_name,
        kpir_column: resolvedKpir,
        category_label: resolvedLabel,
      });
    } catch {
      // Wyjątek może zawierać dane formularza lub odpowiedź bazy.
      console.error('[expenses] learnFromCorrection failed');
    }
  }

  revalidatePath('/expenses');
  revalidatePath(`/expenses/${expenseId}`);
  revalidatePath('/reports/kpir');
  return { success: true };
}

'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { learnFromCorrection } from '@/lib/categorization';
import { deductibleAfterVatChange } from '@/lib/categorization/vat-deduction';
import { hasKsefCurrencyRate } from '@/lib/expenses/ksef-currency-review';
import { isUuid } from '@/lib/supabase/active-org';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import { requireUserAndActiveOrg } from '@/lib/supabase/auth-context';
import type { Database } from '@/types/database';

type ExpenseReviewUpdates = {
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
};

// Server Action arguments are untrusted at runtime. This schema is applied
// before any service-role KSeF write; the ordinary RLS expense path is unchanged.
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

/**
 * Sprawdź status OCR joba (do pollowania z UI).
 *
 * Trzy wyniki, bo UI musi odróżnić „zadania nie ma” od „nie wiem”:
 *  - zadanie jest → `success: true` z wierszem;
 *  - brak wiersza (albo RLS go nie pokazuje — dla użytkownika to to samo)
 *    → `retryable: false`: dalsze pytanie nic nie zmieni, UI kończy czekanie;
 *  - błąd odczytu (chwilowa awaria bazy, sieci, PostgREST) → `retryable: true`:
 *    stan zadania jest nieznany, więc UI pyta dalej. Wcześniej błąd ginął
 *    i wyglądał jak brak zadania — UI pokazywał porażkę, klient wgrywał
 *    zdjęcie drugi raz i powstawał drugi wydatek.
 * Treść błędu bazy nie trafia ani do klienta, ani do logu serwera (tam
 * sam kod).
 *
 * Każdy błąd odczytu traktujemy jako chwilowy — także trwałe jak 42501
 * (brak uprawnień). Uproszczenie świadome: rozróżnianie kodów nic by nie
 * dało, bo UI i tak przestaje pytać po 60 s, a pomyłka w drugą stronę
 * (chwilowy uznany za trwały) to znów drugi wydatek z tego samego zdjęcia.
 */
export async function getOcrJobStatusAction(ocrJobId: string) {
  // Argument akcji przychodzi z przeglądarki. Nie-UUID to nie chwilowy błąd,
  // tylko zadanie, którego nie ma — odpowiadamy bez zapytania do bazy.
  if (!isUuid(ocrJobId)) {
    return { success: false as const, retryable: false as const, error: 'Job nie istnieje' };
  }

  const supabase = await createClient();
  const { data: job, error } = await supabase
    .from('ocr_jobs')
    .select('id, status, error_message, expense_id, extracted_data')
    .eq('id', ocrJobId)
    .maybeSingle();

  if (error) {
    console.error('[getOcrJobStatusAction] odczyt ocr_jobs nieudany', { code: error.code });
    return {
      success: false as const,
      retryable: true as const,
      error: 'Nie mogę teraz sprawdzić stanu odczytu',
    };
  }

  if (!job) {
    return { success: false as const, retryable: false as const, error: 'Job nie istnieje' };
  }

  return { success: true as const, job };
}

/**
 * Zaakceptuj/popraw expense — jeśli user zmienił kategorię, ucz się.
 */
export async function reviewExpenseAction(
  expenseId: string,
  updates: ExpenseReviewUpdates,
) {
  let auth;
  try {
    auth = await requireUserAndActiveOrg();
  } catch {
    return { success: false as const, error: 'Brak autoryzacji' };
  }
  const { supabase, user, tenantId } = auth;

  const { data: existing } = await supabase
    .from('expenses')
    .select('seller_nip, seller_name, kpir_column, category_label, vat_amount, vat_deductible_amount, is_deductible, source, ksef_invoice_id, issue_date, ocr_extracted_data, updated_at')
    .eq('id', expenseId)
    .eq('tenant_id', tenantId)
    .maybeSingle();

  if (!existing) {
    return { success: false as const, error: 'Wydatek nie istnieje' };
  }

  const isKsefExpense = existing.source === 'ksef_inbox' || existing.ksef_invoice_id != null;
  if (isKsefExpense) {
    const parsed = ksefReviewSchema.safeParse(updates);
    if (!parsed.success) {
      return { success: false as const, error: 'Nieprawidłowe dane wydatku KSeF' };
    }
    updates = parsed.data;
    if (existing.source !== 'ksef_inbox') {
      return { success: false as const, error: 'Niespójne powiązanie kosztu KSeF. Wymagane uzgodnienie przez operatora.' };
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
        return { success: false as const, error: 'Nie można potwierdzić waluty faktury KSeF' };
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
        return {
          success: false as const,
          error: 'Przed zatwierdzeniem wydatku walutowego sprawdź XML, kurs i kwoty PLN oraz potwierdź to w formularzu',
        };
      }
      if ((updates.is_deductible ?? existing.is_deductible) === true && missingKsefFxRate) {
        return {
          success: false as const,
          error: 'Brak potwierdzonego kursu przy tym koszcie KSeF. Nie można włączyć kwot w walucie obcej do KPiR.',
        };
      }
    }
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

  // Formularz wysyła VAT zawsze — odliczenie liczymy od nowa tylko przy
  // faktycznej zmianie, inaczej JPK_V7M odliczałby odczyt OCR.
  const vatBefore = Number(existing.vat_amount ?? 0);
  if (updates.vat_amount !== undefined && updates.vat_amount !== vatBefore) {
    patch.vat_deductible_amount = deductibleAfterVatChange(
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
      p_actor_user_id: user.id,
      p_expected_updated_at: existing.updated_at,
      p_patch: patch,
    });
    if (error) {
      return { success: false as const, error: 'Nie udało się bezpiecznie zapisać kosztu KSeF' };
    }
    if (updatedId !== expenseId) {
      return { success: false as const, error: 'Wydatek zmienił się w międzyczasie. Odśwież stronę.' };
    }
  } else {
    const { data: updated, error } = await supabase
      .from('expenses')
      .update(patch)
      .eq('id', expenseId)
      .eq('tenant_id', tenantId)
      .select('id')
      .maybeSingle();

    if (error) return { success: false as const, error: error.message };
    if (!updated) {
      return { success: false as const, error: 'Wydatek nie istnieje' };
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
  return { success: true as const };
}

export async function deleteExpenseAction(expenseId: string) {
  // Sesja po drugim kroku MFA i potwierdzone członkostwo, nie sam `getUser()`
  // z firmą z ciasteczka (AUD-58).
  let auth;
  try {
    auth = await requireUserAndActiveOrg();
  } catch {
    return { success: false as const, error: 'Brak autoryzacji' };
  }
  const { supabase, tenantId } = auth;

  const { error, count } = await supabase
    .from('expenses')
    .delete({ count: 'exact' })
    .eq('id', expenseId)
    .eq('tenant_id', tenantId);

  if (error) {
    return {
      success: false as const,
      error: error.code === '42501'
        ? 'Koszt powiązany z KSeF pozostaje jako ślad faktury. Możesz wyłączyć go z KPiR.'
        : error.message,
    };
  }
  if (count === 0) {
    return { success: false as const, error: 'Wydatek nie istnieje' };
  }

  revalidatePath('/expenses');
  return { success: true as const };
}

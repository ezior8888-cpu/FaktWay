import { requireTenantMember } from './tenant-boundary';
/**
 * Job OCR zdjęcia wydatku (R2 → Claude Vision → kategoria KPiR → `expenses`).
 */

import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';

import { NonRetriableError } from '../errors';
import type { JobContext } from '@/lib/jobs/registry';

import { categorizeExpense } from '@/lib/categorization';
import { createProposal } from '@/lib/flo/proposals';
import {
  buildExpenseReviewProposal,
  buildOcrFailedProposal,
  readSellerHistory,
  type OcrFacts,
} from '@/lib/flo/functions/expense-review';
import { extractInvoiceFromImage } from '@/lib/ocr/engine';
import { checkTenantAiBudget, recordTenantAiUsage } from '@/lib/ai/tenant-ai-budget';
import {
  extractedInvoiceSchema,
  type ExtractedInvoice,
} from '@/lib/ocr/schema';
import type { RateStamp } from '@/lib/flo/nbp';
import { nbpRateForCost } from '@/lib/nbp/client';
import { costInPln, documentCurrency, HOME_CURRENCY } from '@/lib/ocr/currency';
import { sendPushToUser } from '@/lib/push/sender';
import { isSubjectiveVatExemption, readTenantVatExemption } from '@/lib/invoices/vat-exemption';
import { createAdminClient } from '@/lib/supabase/admin';
import { downloadExpensePhoto } from '@/lib/storage/expenses';
import type { Database, Json } from '@/types/database';

import { ocrProcessPhotoRequested } from '../events';

type OcrJobRow = Database['public']['Tables']['ocr_jobs']['Row'];

function extractedInvoiceToJson(data: ExtractedInvoice, fx: RateStamp | null = null): Json {
  return JSON.parse(JSON.stringify(fx ? { ...data, fx } : data)) as Json;
}

/** Kolumny zapisanego wydatku, z których job kończy zadanie bez ponownego OCR. */
const SAVED_EXPENSE_COLUMNS =
  'id, seller_name, seller_nip, net_amount, vat_amount, gross_amount, issue_date, kpir_column, category_label, is_reviewed, ocr_extracted_data' as const;

type SavedExpense = Pick<
  Database['public']['Tables']['expenses']['Row'],
  | 'id'
  | 'seller_name'
  | 'seller_nip'
  | 'net_amount'
  | 'vat_amount'
  | 'gross_amount'
  | 'issue_date'
  | 'kpir_column'
  | 'category_label'
  | 'is_reviewed'
  | 'ocr_extracted_data'
>;

/**
 * Wydatek zapisany już z tego zadania OCR w tej firmie (albo `null`).
 * Błąd odczytu rzuca — job nie może wtedy zapisać ani ogłosić porażki
 * „w ciemno”. `limit(1)`: dawne duble (sprzed B4) nie mogą zablokować joba.
 */
async function findOcrJobExpense(
  supabase: ReturnType<typeof createAdminClient>,
  tenantId: string,
  ocrJobId: string,
): Promise<SavedExpense | null> {
  const { data, error } = await supabase
    .from('expenses')
    .select(SAVED_EXPENSE_COLUMNS)
    .eq('tenant_id', tenantId)
    .eq('ocr_job_id', ocrJobId)
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new Error(`Nie można sprawdzić, czy wydatek już istnieje: ${error.message}`);
  }
  return data;
}

/** Treść karty przeglądu i powiadomienia o rozpoznanym wydatku. */
interface ExpenseReviewSource {
  facts: OcrFacts;
  applied: { kpirColumn: string | null; categoryLabel: string | null };
  /** Kwota do powiadomienia: „123.00 PLN” albo „100.00 EUR (bez kursu)”. */
  amountLabel: string;
}

// Wąski odczyt śladu OCR zapisanego przy wydatku — pełny schemat odczytu
// mógł się zmienić od zapisu (ponowienie po wdrożeniu).
const savedOcrTraceSchema = z.object({
  currency: z.string().nullish(),
  ocr_confidence: z.number().nullish(),
  fx: z.unknown().optional(),
});

/**
 * Karta i powiadomienie z ZAPISANEGO wydatku (E15): ponowienie i przegrany
 * wyścig nie mogą pokazać klientowi innego odczytu modelu niż ten, który
 * trafił do KPiR — ani `undo` cofać do wartości, których wiersz nie miał.
 * Zgodne z pierwszym przebiegiem: kwoty w złotych albo w walucie dokumentu
 * (bez kursu NBP), pewność odczytu ze śladu OCR, kategoria z wiersza.
 */
function reviewSourceFromSaved(expense: SavedExpense): ExpenseReviewSource {
  const trace = savedOcrTraceSchema.safeParse(expense.ocr_extracted_data);
  const currency = documentCurrency({ currency: trace.success ? trace.data.currency : null });
  const withoutRate = currency !== HOME_CURRENCY && !(trace.success && trace.data.fx);
  return {
    facts: {
      sellerName: expense.seller_name,
      sellerNip: expense.seller_nip,
      netAmount: expense.net_amount,
      vatAmount: expense.vat_amount,
      grossAmount: expense.gross_amount,
      issueDate: expense.issue_date,
      // Nieczytelny ślad (nie powinien się zdarzyć): pewność 0 daje kartę-pytanie,
      // nie meldunek „zaksięgowałem”.
      confidence: trace.success ? (trace.data.ocr_confidence ?? null) : 0,
      categoryLabel: expense.category_label,
    },
    applied: { kpirColumn: expense.kpir_column, categoryLabel: expense.category_label },
    amountLabel: withoutRate
      ? `${expense.gross_amount.toFixed(2)} ${currency} (bez kursu)`
      : `${expense.gross_amount.toFixed(2)} PLN`,
  };
}

/**
 * Obsługa po wyczerpaniu prób (pg-boss `onExhausted`, `lib/jobs/run-job.ts`):
 * zadanie OCR dostaje wynik, żeby UI przestało pokazywać „przetwarzanie”.
 *
 * Nie przy każdym wyczerpaniu: ponowienia samego pg-boss (utrata heartbeatu,
 * zamknięcie workera) tej funkcji nie wołają — zadanie zostaje wtedy
 * „processing” (strażnik `findStuckOcrJobs` nie jest podpięty, E15).
 */
export async function onProcessOcrExhausted(
  error: Error,
  data: { ocrJobId: string; tenantId: string },
): Promise<void> {
  const { ocrJobId, tenantId } = data;
  const supabase = createAdminClient();

  // Wydatek mógł już powstać, a na stałe padł dopiero krok po zapisie (karta
  // agenta, powiadomienie — np. autor zdjęcia odszedł z firmy). „Nieudane”
  // kazałoby klientowi wpisać paragon ręcznie, czyli drugi raz do KPiR.
  // Wtedy zadanie kończy się wskazaniem na zapisany wydatek. Gdy nie da się
  // tego sprawdzić, odczyt rzuca: zadanie zostaje „pending” albo „processing”
  // (run-job zapisze błąd), zamiast ogłaszać porażkę w ciemno.
  const saved = await findOcrJobExpense(supabase, tenantId, ocrJobId);
  if (saved) {
    const { error: updateError } = await supabase
      .from('ocr_jobs')
      .update({ status: 'completed', expense_id: saved.id, completed_at: new Date().toISOString() })
      .eq('id', ocrJobId)
      .eq('tenant_id', tenantId);
    if (updateError) throw new Error(`Nie można oznaczyć zadania OCR: ${updateError.message}`);
    return;
  }

  const { error: updateError } = await supabase
    .from('ocr_jobs')
    .update({
      status: 'failed',
      error_message:
        error.message?.slice(0, 500) ||
        'Nie udało się rozpoznać paragonu. Spróbuj ponownie lub wprowadź dane ręcznie.',
      completed_at: new Date().toISOString(),
    })
    .eq('id', ocrJobId)
    .eq('tenant_id', tenantId);
  if (updateError) throw new Error(`Nie można oznaczyć zadania OCR: ${updateError.message}`);
}

/**
 * Runner joba (worker pg-boss).
 * Rejestracja pg-boss: lib/jobs/handlers/package-c.ts
 */
export async function runProcessOcr(data: Parameters<typeof ocrProcessPhotoRequested.create>[0], { step, logger }: JobContext) {
    const { ocrJobId, tenantId } = ocrProcessPhotoRequested.parse(data);
    const supabase = createAdminClient();

    const job = await step.run('load-job', async () => {
      const { data: row, error } = await supabase
        .from('ocr_jobs')
        .select('*')
        .eq('id', ocrJobId)
        .eq('tenant_id', tenantId)
        .single();

      if (error || !row) {
        throw new NonRetriableError('Job nie istnieje lub niewłaściwy tenant');
      }

      const jobRow = row as OcrJobRow;
      // Autor usunął konto (AUD-41: created_by = NULL) — koszt nie ma autora.
      const createdBy = jobRow.created_by;
      if (!createdBy) throw new NonRetriableError('Autor zadania OCR usunął konto');
      await requireTenantMember(createdBy, tenantId);
      const sourceFilePath = jobRow.source_file_path;
      if (!sourceFilePath || sourceFilePath === 'pending') {
        throw new NonRetriableError('Brak pliku źródłowego dla joba OCR');
      }
      return { ...jobRow, created_by: createdBy, source_file_path: sourceFilePath };
    });

    /**
     * Wspólny koniec joba, gdy wydatek z tego zadania jest w bazie: oznaczenie
     * zadania, karta przeglądu i powiadomienie. `fresh` — wydatek zapisał ten
     * przebieg (jak dotąd, ze śladem odczytu i tokenami). `saved` — zapisał go
     * wcześniejszy albo równoległy przebieg: bez nadpisywania śladu odczytu,
     * a karty nie tworzymy ponownie, gdy klient już na nią zareagował
     * (`createProposal` widzi tylko karty otwarte i zatwierdzone, więc po
     * „Zgadza się” albo „Nie teraz” otworzyłby nową).
     */
    const finish = async (
      expenseId: string,
      source: ExpenseReviewSource,
      mode:
        | { kind: 'fresh'; trace: Database['public']['Tables']['ocr_jobs']['Update'] }
        | { kind: 'saved'; isReviewed: boolean },
    ) => {
      await step.run('mark-completed', async () => {
        const { error } = await supabase
          .from('ocr_jobs')
          .update({
            ...(mode.kind === 'fresh' ? mode.trace : {}),
            status: 'completed',
            expense_id: expenseId,
            completed_at: new Date().toISOString(),
          })
          .eq('id', ocrJobId)
          .eq('tenant_id', tenantId);

        if (error) throw new Error(error.message);
      });

      // Klient już przejrzał koszt (karta albo formularz) — karta i powiadomienie
      // byłyby szumem, a `undo` nowej karty cofnęłoby jego decyzję.
      if (mode.kind === 'saved' && mode.isReviewed) return { success: true as const, expenseId };

      // Karta agenta. Decyduje o tym, czy klient zobaczy meldunek („zaksięgowałem"),
      // czy pytanie („do sprawdzenia") — reguły w lib/flo/functions/expense-review.ts.
      const card = await step.run('flo-review-card', async () => {
        const history = await readSellerHistory(tenantId, source.facts.sellerName);
        const proposal = buildExpenseReviewProposal({
          tenantId,
          expenseId,
          facts: source.facts,
          history,
          applied: source.applied,
        });
        if (mode.kind === 'saved') {
          const { data: existing, error } = await supabase
            .from('flo_proposals')
            .select('status')
            .eq('tenant_id', tenantId)
            .eq('topic_key', proposal.topicKey)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();
          if (error) throw new Error(`Nie można sprawdzić karty przeglądu: ${error.message}`);
          if (existing) return existing.status;
        }
        await createProposal(proposal);
        return 'created';
      });
      // Karta otwarta: pierwszy przebieg doszedł do karty, a powiadomienie
      // (krok po niej) najpewniej nie wyszło. Inny status: klient zareagował.
      if (card !== 'created' && card !== 'open') return { success: true as const, expenseId };

      await step.run('notify-user', async () => {
        await requireTenantMember(job.created_by, tenantId);
        await sendPushToUser(job.created_by, 'invoice_accepted', {
          title: '📸 Wydatek rozpoznany',
          body: `${source.facts.sellerName} • ${source.amountLabel}`,
          url: `/expenses/${expenseId}`,
          tag: `ocr-${ocrJobId}`,
        });
      });

      return { success: true as const, expenseId };
    };

    const finishSaved = (expense: SavedExpense) =>
      finish(expense.id, reviewSourceFromSaved(expense), { kind: 'saved', isReviewed: expense.is_reviewed });

    // Ponowienie (pg-boss powtarza cały job) po zapisie wydatku: koniec od razu,
    // bez pobierania zdjęcia, budżetu AI, płatnego OCR i kategoryzacji (E15).
    // Przed `mark-processing`, żeby nie cofać zadania z „completed”.
    const saved = await step.run('find-saved-expense', () =>
      findOcrJobExpense(supabase, tenantId, ocrJobId),
    );
    if (saved) return finishSaved(saved);

    await step.run('mark-processing', async () => {
      const { error } = await supabase
        .from('ocr_jobs')
        .update({ status: 'processing' })
        .eq('id', ocrJobId)
        .eq('tenant_id', tenantId);

      if (error) throw new Error(error.message);
    });

    const { imageBase64, mimeType } = await step.run('fetch-photo', async () => {
      const { buffer, mimeType: mt } = await downloadExpensePhoto(job.source_file_path, tenantId);
      return { imageBase64: buffer.toString('base64'), mimeType: mt };
    });

    // AUD-107: budżet AI firmy PRZED wywołaniem modelu — po fakcie limit
    // byłby tylko statystyką.
    const aiBudget = await step.run('ai-budget', () => checkTenantAiBudget(tenantId, 'ocr'));
    const ocrResult = aiBudget.allowed
      ? await step.run('claude-vision-ocr', async () => {
          return extractInvoiceFromImage(imageBase64, mimeType);
        })
      : { success: false as const, error: aiBudget.message, inputTokens: 0, outputTokens: 0, processingTimeMs: 0 };
    if (aiBudget.allowed) {
      await step.run('ai-usage', () =>
        recordTenantAiUsage(tenantId, { inputTokens: ocrResult.inputTokens, outputTokens: ocrResult.outputTokens }),
      );
    }

    if (!ocrResult.success || !ocrResult.data) {
      // Równoległy przebieg tego samego zadania (wyścig pg-boss) mógł zapisać
      // wydatek po wczesnym sprawdzeniu. „Nie rozpoznano” z kartą „wpisz
      // ręcznie” skończyłoby się drugim kosztem w KPiR (B4).
      const concurrent = await step.run('find-saved-expense-after-ocr', () =>
        findOcrJobExpense(supabase, tenantId, ocrJobId),
      );
      if (concurrent) return finishSaved(concurrent);

      await step.run('mark-failed', async () => {
        const { error } = await supabase
          .from('ocr_jobs')
          .update({
            status: 'failed',
            error_message: ocrResult.error ?? 'OCR failed',
            ai_input_tokens: ocrResult.inputTokens,
            ai_output_tokens: ocrResult.outputTokens,
            processing_time_ms: ocrResult.processingTimeMs,
            completed_at: new Date().toISOString(),
          })
          .eq('id', ocrJobId)
          .eq('tenant_id', tenantId);

        if (error) throw new Error(error.message);
      });

      await requireTenantMember(job.created_by, tenantId);
      // „Nieudane” już zapisane, karta niżej zostaje — push jest dodatkiem.
      // Błąd (np. PushReadError: awaria bazy) nie może ponowić joba: ponowienie
      // od zera zapłaciłoby drugi raz za OCR i mogło nie dojść do karty.
      try {
        await sendPushToUser(job.created_by, 'invoice_rejected', {
          title: '❌ Nie udało się rozpoznać paragonu',
          body:
            ocrResult.error?.slice(0, 80) ??
            'Spróbuj ponownie z lepszym zdjęciem',
          url: '/expenses',
          tag: `ocr-${ocrJobId}`,
        });
      } catch (e) {
        logger.warn('OCR: push „nie rozpoznano” nieudany — karta i status zadania zostają', {
          ocrJobId,
          tenantId,
          error: e instanceof Error ? e.message : String(e),
        });
        Sentry.captureException(e, { tags: { job: 'process-ocr', step: 'push-failed' }, extra: { ocrJobId, tenantId } });
      }

      // Karta agenta zamiast samego powiadomienia: powiadomienie znika,
      // a klient musi wiedzieć, że zdjęcie ZOSTAŁO w archiwum. Bez tego
      // wyrzuca paragon i po miesiącu nie ma czego odtwarzać.
      await step.run('flo-failed-card', async () => {
        await createProposal(buildOcrFailedProposal(tenantId, ocrJobId));
      });

      return { success: false as const };
    }

    const extractedData = extractedInvoiceSchema.parse(ocrResult.data);

    // Dokument w walucie obcej → kurs średni NBP z ostatniego dnia roboczego
    // PRZED datą dokumentu (art. 11a ust. 2 PIT). Błąd sieci rzuca (ponowienie);
    // brak tabeli albo nieznana waluta to wynik — koszt nie wejdzie do KPiR.
    const currency = documentCurrency(extractedData);
    const fxLookup =
      currency === HOME_CURRENCY
        ? null
        : await step.run('nbp-rate', () => nbpRateForCost(currency, extractedData.issue_date));
    const cost = costInPln(extractedData, extractedData.issue_date, fxLookup);
    const plnOrDocument =
      cost.kind === 'pln'
        ? { net: cost.net, vat: cost.vat, gross: cost.gross }
        : { net: extractedData.net_amount, vat: extractedData.vat_amount, gross: extractedData.gross_amount };

    const categorization = await step.run('categorize', async () => {
      return categorizeExpense(tenantId, extractedData);
    });

    const created = await step.run(
      'create-expense',
      async (): Promise<{ fresh: true; id: string } | { fresh: false; expense: SavedExpense }> => {
        // Równoległy przebieg mógł zapisać wydatek po wczesnym sprawdzeniu
        // (wyścig pg-boss) — wtedy jego wydatek, nie drugi.
        const existing = await findOcrJobExpense(supabase, tenantId, ocrJobId);
        if (existing) return { fresh: false, expense: existing };

        const data = extractedData;
        const docType =
          data.document_type === 'simplified_invoice' ? 'invoice' : data.document_type;
        // Firma zwolniona z VAT (#60) nie odlicza VAT-u: koszt w KPiR wychodzi
        // wtedy brutto (#65), a JPK nic nie odlicza. Odczyt odporny przed 00091.
        // Tylko zwolnienie podmiotowe (art. 113) odbiera odliczenie — I2, AUD-68.
        const vatExempt = isSubjectiveVatExemption(await readTenantVatExemption(supabase, tenantId));

        const { data: expense, error } = await supabase
          .from('expenses')
          .insert({
            tenant_id: tenantId,
            created_by: job.created_by,
            source: 'ocr_photo',
            ocr_job_id: ocrJobId,
            seller_name: data.seller_name,
            seller_nip: data.seller_nip,
            seller_address: data.seller_address,
            document_number: data.document_number,
            document_type: docType,
            issue_date: data.issue_date,
            // Złote: z dokumentu albo przeliczone kursem NBP (`costInPln`).
            net_amount: plnOrDocument.net,
            vat_amount: plnOrDocument.vat,
            gross_amount: plnOrDocument.gross,
            vat_rate: data.vat_rate,
            // Waluta obca: VAT z dokumentu nie idzie do odliczenia automatycznie.
            vat_deductible_amount:
              cost.kind === 'missing_rate' ? 0 : (cost.vatDeductible ?? (vatExempt ? 0 : data.vat_amount)),
            // Bez kursu kwoty są w walucie dokumentu — nie wolno ich liczyć do KPiR.
            ...(cost.kind === 'missing_rate' ? { is_deductible: false } : {}),
            notes: cost.note,
            kpir_column: categorization.kpir_column,
            category_label: categorization.category_label,
            categorization_method: categorization.method,
            categorization_confidence: categorization.confidence,
            source_file_path: job.source_file_path,
            source_file_mime: job.source_file_mime,
            // Oryginał z dokumentu + ślad kursu (tabela, data) — do obrony przy kontroli.
            ocr_extracted_data: extractedInvoiceToJson(data, cost.kind === 'pln' ? cost.fx : null),
            is_reviewed: false,
          })
          .select('id')
          .single();

        // Odczyt wyżej nie rozstrzyga wyścigu dwóch równoczesnych przebiegów
        // (wygaśnięcie / utrata heartbeatu w pg-boss). Rozstrzyga go indeks
        // `uq_expenses_tenant_ocr_job` (B4, migracja do wgrania; bez niego 23505
        // nie występuje), a 23505 wymaga ponownego odczytu dokładnie tego
        // zadania w tej firmie.
        if (error?.code === '23505') {
          const concurrent = await findOcrJobExpense(supabase, tenantId, ocrJobId);
          if (!concurrent) {
            throw new Error(`Konflikt UNIQUE nie dotyczy wydatku z tego zadania OCR: ${error.message}`);
          }
          return { fresh: false, expense: concurrent };
        }
        if (error || !expense) {
          throw new Error(error?.message ?? 'Insert failed');
        }
        return { fresh: true, id: expense.id };
      },
    );

    if (!created.fresh) return finishSaved(created.expense);

    return finish(
      created.id,
      {
        facts: {
          sellerName: extractedData.seller_name,
          sellerNip: extractedData.seller_nip,
          netAmount: plnOrDocument.net,
          vatAmount: plnOrDocument.vat,
          grossAmount: plnOrDocument.gross,
          issueDate: extractedData.issue_date,
          confidence: extractedData.ocr_confidence,
          categoryLabel: categorization.category_label,
        },
        applied: {
          kpirColumn: categorization.kpir_column,
          categoryLabel: categorization.category_label,
        },
        amountLabel:
          cost.kind === 'pln'
            ? `${cost.gross.toFixed(2)} PLN`
            : `${extractedData.gross_amount.toFixed(2)} ${currency} (bez kursu)`,
      },
      {
        kind: 'fresh',
        trace: {
          extracted_data: extractedInvoiceToJson(extractedData),
          ai_model_used: ocrResult.modelUsed,
          ai_input_tokens: ocrResult.inputTokens,
          ai_output_tokens: ocrResult.outputTokens,
          processing_time_ms: ocrResult.processingTimeMs,
        },
      },
    );
}

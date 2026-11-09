/**
 * Po zapisaniu faktury przychodzącej z inbox KSeF — tworzymy `expenses` z kategoryzacją KPiR.
 */

import * as Sentry from '@sentry/nextjs';

import { NonRetriableError } from '../errors';
import type { JobContext } from '@/lib/jobs/registry';

import { categorizeExpense } from '@/lib/categorization';
import {
  extractedInvoiceSchema,
  type ExtractedInvoice,
} from '@/lib/ocr/schema';
import { isSubjectiveVatExemption, readTenantVatExemption } from '@/lib/invoices/vat-exemption';
import { nbpRateForCost } from '@/lib/nbp/client';
import { costInPln, documentCurrency, HOME_CURRENCY } from '@/lib/ocr/currency';
import { createAdminClient } from '@/lib/supabase/admin';
import { archiveInboxInvoiceXml } from '@/lib/ksef/inbox-xml';
import {
  fa3Record,
  INBOX_BACKFILL_ATTEMPTS_FIELD,
  INBOX_PENDING_FLAG,
  inboxBackfillAttempts,
  markInboxInvoiceProcessed,
} from '@/lib/ksef/inbox-pending';
import { requireConfiguredKsefEnvironment } from '@/lib/ksef/claim-environment';
import type { Database, Json } from '@/types/database';

import { inboxInvoiceReceivedAutoCategorize } from '../events';

type InvoiceRow = Database['public']['Tables']['invoices']['Row'];
type LineItemRow = Database['public']['Tables']['invoice_line_items']['Row'];

type InvoiceWithLines = InvoiceRow & {
  invoice_line_items: LineItemRow[] | null;
};

function readSellerFromFa3(fa3: Json): { name?: string; nip?: string } {
  if (!fa3 || typeof fa3 !== 'object' || Array.isArray(fa3)) {
    return {};
  }
  const seller = (fa3 as Record<string, unknown>).seller;
  if (!seller || typeof seller !== 'object' || Array.isArray(seller)) {
    return {};
  }
  const s = seller as Record<string, unknown>;
  const name = typeof s.name === 'string' ? s.name : undefined;
  const nip = typeof s.nip === 'string' ? s.nip : undefined;
  return { name, nip };
}

function readSellerFromSellerData(data: Json | null): { name?: string; nip?: string } {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return {};
  }
  const o = data as Record<string, unknown>;
  const name = typeof o.name === 'string' ? o.name : undefined;
  const nip = typeof o.nip === 'string' ? o.nip : undefined;
  return { name, nip };
}

function normalizeNip10(raw: string | null): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  return digits.length === 10 ? digits : null;
}

function resolveSellerName(invoice: InvoiceWithLines): string {
  const fromRow = readSellerFromSellerData(invoice.seller_data);
  if (fromRow.name) return fromRow.name;
  const fromFa3 = readSellerFromFa3(invoice.fa3_data);
  if (fromFa3.name) return fromFa3.name;
  return 'Nieznany';
}

function resolveSellerNip(invoice: InvoiceWithLines): string | null {
  const fromColumn = normalizeNip10(invoice.seller_nip);
  if (fromColumn) return fromColumn;
  const fromRow = normalizeNip10(readSellerFromSellerData(invoice.seller_data).nip ?? null);
  if (fromRow) return fromRow;
  return normalizeNip10(readSellerFromFa3(invoice.fa3_data).nip ?? null);
}

function inferVatRate(invoice: InvoiceWithLines): ExtractedInvoice['vat_rate'] {
  const lines = invoice.invoice_line_items ?? [];
  const rates = [
    ...new Set(
      lines
        .map((l) => l.vat_rate)
        .filter((r): r is string => typeof r === 'string' && r.length > 0),
    ),
  ];

  if (rates.length > 1) return 'mixed';
  if (rates.length === 1) {
    const r = rates[0];
    if (
      r === '23' ||
      r === '8' ||
      r === '5' ||
      r === '0' ||
      r === 'zw' ||
      r === 'oo' ||
      r === 'np' ||
      r === 'mixed'
    ) {
      return r;
    }
  }

  // Bez znaku: korekta „in minus” ma ujemne netto i VAT, a stawka ta sama.
  const net = Math.abs(Number(invoice.net_total ?? 0));
  // Kontrakt KSeF: vatAmount w metadanych jest ZAWSZE w PLN, ale netto/brutto
  // w walucie faktury. Stawkę z metadanych bez pozycji wolno szacować tylko
  // z kwot w tej samej jednostce.
  const vat = invoice.currency?.trim().toUpperCase() === HOME_CURRENCY
    ? Math.abs(Number(invoice.vat_total ?? 0))
    : Math.abs(Number(invoice.gross_total ?? 0) - Number(invoice.net_total ?? 0));
  if (net <= 0 && vat <= 0) return '0';
  if (vat <= 0) return '0';
  const ratio = vat / net;
  if (ratio >= 0.22 && ratio <= 0.24) return '23';
  if (ratio >= 0.07 && ratio <= 0.09) return '8';
  if (ratio >= 0.04 && ratio <= 0.06) return '5';
  return 'mixed';
}

function buildLineItems(
  lines: LineItemRow[] | null,
): ExtractedInvoice['line_items'] {
  if (!lines?.length) return null;
  return lines.map((l) => ({
    name: l.name?.trim() ? l.name : 'Pozycja',
    quantity: l.quantity != null ? Number(l.quantity) : null,
    unit_price: l.unit_price_net != null ? Number(l.unit_price_net) : null,
    gross: l.gross_amount != null ? Number(l.gross_amount) : null,
  }));
}

function invoiceToExtracted(invoice: InvoiceWithLines): ExtractedInvoice {
  const gross = Number(invoice.gross_total ?? 0);
  const net = Number(invoice.net_total ?? 0);
  const vatAmountPln = Number(invoice.vat_total);
  // Metadane skrzynki KSeF zawierają walutę. Brak/niepoprawna wartość nie
  // może oznaczać PLN — to zamieniłoby np. 100 EUR w 100 zł w KPiR.
  const currency = invoice.currency?.trim().toUpperCase();
  if (!currency || !/^[A-Z]{3}$/.test(currency)) {
    throw new NonRetriableError('Brak poprawnej waluty faktury KSeF — nie tworzę kosztu');
  }
  if (invoice.vat_total === null || !Number.isFinite(vatAmountPln)) {
    throw new NonRetriableError('Brak poprawnej kwoty VAT w metadanych KSeF');
  }
  const vatInDocumentCurrency = currency === HOME_CURRENCY
    ? vatAmountPln
    : gross - net;
  if (vatInDocumentCurrency !== 0 && Math.sign(vatInDocumentCurrency) !== Math.sign(gross)) {
    throw new NonRetriableError('Niespójne kwoty netto i brutto faktury KSeF');
  }

  // Korekta „in minus” (dostawca obniża cenę) ma ujemne kwoty. Zwykła faktura
  // ich mieć nie może, więc sam znak wystarcza — bez zgadywania typu z KSeF.
  // Do 27.09 taka korekta była pomijana: koszt w KPiR i VAT do odliczenia
  // zostawały zawyżone.
  if (!Number.isFinite(gross) || gross === 0) {
    throw new NonRetriableError('Brak kwoty brutto — pomijam expense');
  }

  const docNo =
    invoice.internal_number?.trim() ||
    invoice.ksef_number?.trim() ||
    'brak';

  const draft = {
    seller_name: resolveSellerName(invoice),
    seller_nip: resolveSellerNip(invoice),
    seller_address: null,
    document_number: docNo,
    document_type: 'invoice' as const,
    issue_date: invoice.issue_date,
    currency,
    // Schemat OCR przyjmuje kwoty nieujemne — walidujemy bez znaku, znak
    // wraca niżej.
    net_amount: Math.abs(net),
    vat_amount: Math.abs(vatInDocumentCurrency),
    gross_amount: Math.abs(gross),
    vat_rate: inferVatRate(invoice),
    line_items: buildLineItems(invoice.invoice_line_items),
    ocr_confidence: 1,
    notes: null,
  };

  const parsed = extractedInvoiceSchema.parse(draft);
  return gross < 0
    ? { ...parsed, net_amount: net, vat_amount: vatInDocumentCurrency, gross_amount: gross }
    : parsed;
}

/**
 * Kwoty bez znaku do kategoryzacji: reguły mają progi kwotowe, a korekta ma
 * trafić do tej samej kategorii co faktura, którą poprawia.
 */
export function unsignedForCategorization(extracted: ExtractedInvoice): ExtractedInvoice {
  return {
    ...extracted,
    net_amount: Math.abs(extracted.net_amount),
    vat_amount: Math.abs(extracted.vat_amount),
    gross_amount: Math.abs(extracted.gross_amount),
  };
}

/**
 * Runner joba (worker pg-boss).
 * Rejestracja pg-boss: lib/jobs/handlers/package-c.ts
 */
export async function runAutoCategorizeInbox(data: Parameters<typeof inboxInvoiceReceivedAutoCategorize.create>[0], { step, logger }: JobContext) {
    const { invoiceId, tenantId, environment } = inboxInvoiceReceivedAutoCategorize.parse(
      data,
    );
    if (environment !== requireConfiguredKsefEnvironment()) {
      throw new NonRetriableError('KSeF expense event environment requires reconciliation');
    }
    const supabase = createAdminClient();

    // Sesja 17 planu skalowania: to samo zadanie może przyjść drugi raz (skrzynka
    // i cron uzupełniający; `singletonKey` na tej kolejce nie deduplikuje).
    // Jeden odczyt rozstrzyga, zanim pójdzie pobranie XML albo zapytanie do AI.
    const current = await step.run('check-already-processed', async () => {
      const { data: row, error } = await supabase
        .from('invoices')
        .select('fa3_data, expenses!expenses_ksef_invoice_id_fkey(id)')
        .eq('id', invoiceId)
        .eq('tenant_id', tenantId)
        .maybeSingle();
      // Błąd odczytu nie jest powodem do pominięcia: pełna droga sama zapyta o stan.
      if (error || !row) return { processed: false, hasExpense: false };
      const fa3 = fa3Record(row.fa3_data);
      const expenses = (row as unknown as { expenses: unknown }).expenses;
      return {
        processed: fa3[INBOX_PENDING_FLAG] === false,
        hasExpense: Array.isArray(expenses) ? expenses.length > 0 : Boolean(expenses),
      };
    });
    if (current.processed) {
      logger.info('Skrzynka: faktura już domknięta, zadanie zbędne', { invoiceId });
      return { success: true as const, skipped: 'already-processed' as const };
    }

    // #122 część B: oryginał XML faktury otrzymanej (KOD I, „Pobierz XML”).
    // Przed kategoryzacją, więc działa także, gdy koszt zostanie pominięty;
    // błąd nie przerywa joba — PDF zostaje podglądem (B14).
    const xml = await step.run('archive-ksef-xml', () =>
      archiveInboxInvoiceXml({ tenantId, invoiceId, environment }));

    // L1a: XML odłożony przez pauzę firmy po 429 to nie nieudana próba.
    // Znacznik zostaje (niżej), a próbę doliczoną przy emisji z crona oddajemy.
    if (!xml.archived && xml.reason === 'rate_limited') {
      logger.info('Skrzynka: XML odłożony — firma w pauzie po 429 z KSeF, cron uzupełniający dobierze po pauzie', {
        invoiceId,
      });
      await releaseRateLimitedBackfillAttempt({ supabase, tenantId, invoiceId, step, logger });
    }

    // Koszt już jest, brakowało tylko XML: bez drugiego liczenia kategorii i bez AI.
    if (current.hasExpense) {
      if (xml.archived || xml.reason === 'has-xml' || xml.reason === 'not-applicable') {
        await closeInboxInvoice({ supabase, tenantId, invoiceId, step, logger });
      }
      return { success: true as const, skipped: 'expense-exists' as const };
    }

    // Nowa nazwa kroku wymusza ponowny odczyt waluty także przy wznowieniu
    // starszego przebiegu Inngest z zapamiętanym wynikiem `fetch-invoice`.
    const { extracted, vatAmountPln } = await step.run('fetch-invoice-with-currency', async () => {
      const { data, error } = await supabase
        .from('invoices')
        .select(
          `
          id,
          tenant_id,
          direction,
          ksef_number,
          internal_number,
          issue_date,
          seller_data,
          seller_nip,
          gross_total,
          net_total,
          vat_total,
          currency,
          fa3_data,
          invoice_line_items (*)
        `,
        )
        .eq('id', invoiceId)
        .single();

      if (error || !data) {
        throw new NonRetriableError('Faktura nie istnieje');
      }

      const row = data as InvoiceWithLines;

      if (row.tenant_id !== tenantId) {
        throw new NonRetriableError('Niezgodność tenanta');
      }
      if (row.direction !== 'incoming') {
        throw new NonRetriableError('Tylko faktury incoming z inbox');
      }

      return {
        extracted: invoiceToExtracted(row),
        vatAmountPln: Number(row.vat_total),
      };
    });

    const currency = documentCurrency(extracted);
    const fxLookup = currency === HOME_CURRENCY
      ? null
      : await step.run('nbp-rate', () => nbpRateForCost(currency, extracted.issue_date));
    const cost = costInPln(extracted, extracted.issue_date, fxLookup);
    const needsCurrencyReview = currency !== HOME_CURRENCY;
    const note = needsCurrencyReview
      ? `${cost.note ?? ''} VAT z metadanych KSeF: ${vatAmountPln.toFixed(2)} PLN. Sprawdź oryginalny XML i kwoty przed włączeniem kosztu do KPiR.`.trim()
      : cost.note;
    const categorization = await step.run('categorize-pln', async () => {
      // Klasyfikator (także prompt AI) zakłada PLN. Bez kursu nie przekazujemy
      // mu liczby EUR opisanej jako złotówki ani nie wysyłamy danych dostawcy.
      if (cost.kind === 'missing_rate') {
        return {
          kpir_column: 'col_13' as const,
          category_label: 'Do weryfikacji waluty',
          confidence: 0,
          method: 'manual' as const,
        };
      }
      const amountsForCategory = {
        ...extracted,
        net_amount: cost.net,
        vat_amount: cost.vat,
        gross_amount: cost.gross,
      };
      return categorizeExpense(tenantId, unsignedForCategorization(amountsForCategory));
    });

    await step.run('create-expense', async () => {
      // fetch-invoice may have been memoized before a deployment switched the
      // KSeF environment. Recheck the actual invoice before the financial write.
      if (environment !== requireConfiguredKsefEnvironment()) {
        throw new NonRetriableError('KSeF expense event environment requires reconciliation');
      }
      const { data: current, error: currentError } = await supabase
        .from('invoices')
        .select('id')
        .eq('id', invoiceId)
        .eq('tenant_id', tenantId)
        .eq('direction', 'incoming')
        .eq('origin', 'ksef_inbox')
        .eq('ksef_status', 'accepted')
        .eq('ksef_environment', environment)
        .maybeSingle();
      if (currentError) throw new Error('Cannot verify current KSeF expense invoice');
      if (!current) {
        throw new NonRetriableError('KSeF expense invoice identity requires reconciliation');
      }

      // Odczyt oszczędza ponownego insertu, ale nie rozstrzyga wyścigu.
      // Indeks 00121 gwarantuje jeden koszt na fakturę, a 23505 wymaga
      // ponownego odczytu dokładnie w tym tenancie.
      const { data: existing, error: existingErr } = await supabase
        .from('expenses')
        .select('id')
        .eq('tenant_id', tenantId)
        .eq('ksef_invoice_id', invoiceId)
        .maybeSingle();

      if (existingErr) {
        throw new Error(`Nie można sprawdzić, czy wydatek już istnieje: ${existingErr.message}`);
      }
      if (existing) {
        return { skipped: true as const, expenseId: existing.id };
      }

      const { data: ownerMembership } = await supabase
        .from('memberships')
        .select('user_id')
        .eq('organization_id', tenantId)
        .eq('role', 'owner')
        .eq('status', 'active')
        .limit(1)
        .maybeSingle();

      let createdById = ownerMembership?.user_id;
      if (!createdById) {
        const { data: anyMembership } = await supabase
          .from('memberships')
          .select('user_id')
          .eq('organization_id', tenantId)
          .eq('status', 'active')
          .limit(1)
          .maybeSingle();
        createdById = anyMembership?.user_id;
      }

      if (!createdById) {
        throw new NonRetriableError('Brak użytkownika w tenancie — nie tworzę expense');
      }

      // Firma zwolniona z VAT (#60) nie odlicza VAT-u: koszt w KPiR wychodzi
      // wtedy brutto (#65), a JPK nic nie odlicza. Odczyt odporny przed 00091.
      // Tylko zwolnienie podmiotowe (art. 113) odbiera odliczenie — I2, AUD-68.
      const vatExempt = isSubjectiveVatExemption(await readTenantVatExemption(supabase, tenantId));

      const { data: expense, error } = await supabase
        .from('expenses')
        .insert({
          tenant_id: tenantId,
          created_by: createdById,
          source: 'ksef_inbox',
          ksef_invoice_id: invoiceId,
          seller_name: extracted.seller_name,
          seller_nip: extracted.seller_nip,
          document_number: extracted.document_number,
          document_type: 'invoice',
          issue_date: extracted.issue_date,
          net_amount: cost.kind === 'pln' ? cost.net : extracted.net_amount,
          // KSeF vatAmount to PLN. Bez kursu nie mieszamy PLN z kwotami
          // źródłowymi w jednej kolumnie: VAT zostaje w śladzie metadanych.
          vat_amount: needsCurrencyReview
            ? (cost.kind === 'pln' ? vatAmountPln : 0)
            : extracted.vat_amount,
          gross_amount: cost.kind === 'pln' ? cost.gross : extracted.gross_amount,
          vat_rate: extracted.vat_rate,
          vat_deductible_amount: cost.kind === 'missing_rate'
            ? 0
            : (cost.vatDeductible ?? (vatExempt ? 0 : extracted.vat_amount)),
          // Sam kurs NBP nie potwierdza kwot VAT z XML. Faktura walutowa
          // czeka poza KPiR na ręczny przegląd także wtedy, gdy kurs znaleziono.
          ...(needsCurrencyReview ? { is_deductible: false } : {}),
          notes: note,
          // Oryginał z KSeF i identyfikowalny kurs zostają przy koszcie.
          ...(currency !== HOME_CURRENCY ? {
            ocr_extracted_data: {
              source: 'ksef_inbox',
              currency,
              net_amount: extracted.net_amount,
              vat_amount_pln_metadata: vatAmountPln,
              gross_amount: extracted.gross_amount,
              fx: cost.kind === 'pln' ? cost.fx : null,
            } as Json,
          } : {}),
          kpir_column: categorization.kpir_column,
          category_label: categorization.category_label,
          categorization_method: categorization.method,
          categorization_confidence: categorization.confidence,
          is_reviewed: !needsCurrencyReview && categorization.confidence > 0.9,
        })
        .select('id')
        .single();

      if (error?.code === '23505') {
        const { data: concurrent, error: concurrentError } = await supabase
          .from('expenses')
          .select('id')
          .eq('tenant_id', tenantId)
          .eq('ksef_invoice_id', invoiceId)
          .maybeSingle();
        if (concurrentError || !concurrent) {
          throw new Error('Konflikt UNIQUE nie dotyczy tego kosztu KSeF');
        }
        return { skipped: true as const, expenseId: concurrent.id };
      }
      if (error || !expense) {
        throw new Error(error?.message ?? 'Insert expense failed');
      }

      return { skipped: false as const, expenseId: expense.id };
    });

    // K2 (rewizja 03.10.2026): domknięcie przebiegu. Odbiór skrzynki zapala
    // `fa3_data._pendingFullFetch`; cron `inbox-backfill` emituje zdarzenie
    // ponownie dla faktur, które tu nie doszły. Znacznik gaśnie dopiero, gdy
    // koszt istnieje (utworzony albo zastany wyżej) i XML jest w archiwum albo
    // nie jest potrzebny. Błąd pobrania XML zostawia znacznik — cron spróbuje
    // ponownie, a koszt już jest.
    const xmlSettled = xml.archived || xml.reason === 'has-xml' || xml.reason === 'not-applicable';
    if (xmlSettled) {
      await closeInboxInvoice({ supabase, tenantId, invoiceId, step, logger });
    }

    return { success: true as const };
}

/** Przy próbie crona: chwila emisji, za którą próbę już oddano (`_backfillAt` z `bumpInboxBackfillAttempt`). */
const INBOX_BACKFILL_RELEASED_FIELD = '_backfillReleasedAt';

/**
 * L1a: oddaje próbę crona `inbox-backfill`, gdy XML nie przyszedł przez pauzę
 * firmy po 429 (`rate_limited`). Cron pomija firmy w pauzie, ale pauza mogła
 * zacząć się po emisji. Bez tego seria pauz wyczerpałaby
 * `INBOX_BACKFILL_MAX_ATTEMPTS` i faktura zostałaby bez XML na stałe.
 *
 * Ponowienie od zera i dubel zadania: kluczem jest `_backfillAt` (chwila
 * emisji zapisana przy próbie). Za jedną emisję próba wraca najwyżej raz
 * (`_backfillReleasedAt` = `_backfillAt`), a UPDATE przechodzi tylko, gdy od
 * odczytu nie doszła nowa próba ani domknięcie faktury (warunki na
 * `_backfillAt` i `_pendingFullFetch`). Pierwsze zdarzenie ze skrzynki (bez
 * próby crona) nie ma czego oddać. Błąd zapisu nie wywraca joba: kosztuje
 * najwyżej jedną zużytą próbę.
 */
async function releaseRateLimitedBackfillAttempt(input: {
  supabase: ReturnType<typeof createAdminClient>;
  tenantId: string;
  invoiceId: string;
  step: JobContext['step'];
  logger: JobContext['logger'];
}): Promise<void> {
  const { supabase, tenantId, invoiceId, step, logger } = input;
  try {
    await step.run('release-backfill-attempt', async () => {
      const { data: row, error } = await supabase
        .from('invoices')
        .select('fa3_data')
        .eq('id', invoiceId)
        .eq('tenant_id', tenantId)
        .maybeSingle();
      if (error || !row) {
        throw new Error(error?.message ?? 'Nie można odczytać faktury skrzynki do oddania próby');
      }
      const fa3 = fa3Record(row.fa3_data);
      const attempts = inboxBackfillAttempts(fa3);
      const emittedAt = typeof fa3._backfillAt === 'string' ? fa3._backfillAt : null;
      if (
        attempts === 0
        || !emittedAt
        || fa3[INBOX_BACKFILL_RELEASED_FIELD] === emittedAt
        || fa3[INBOX_PENDING_FLAG] !== true
      ) {
        return { released: false };
      }
      const { error: updateError } = await supabase
        .from('invoices')
        .update({
          fa3_data: {
            ...fa3,
            [INBOX_BACKFILL_ATTEMPTS_FIELD]: attempts - 1,
            [INBOX_BACKFILL_RELEASED_FIELD]: emittedAt,
          },
        })
        .eq('id', invoiceId)
        .eq('tenant_id', tenantId)
        .eq('fa3_data->>_backfillAt', emittedAt)
        .eq(`fa3_data->>${INBOX_PENDING_FLAG}`, 'true');
      if (updateError) throw new Error(updateError.message);
      return { released: true };
    });
  } catch (e) {
    logger.warn('Skrzynka: nie udało się oddać próby uzupełnienia po pauzie 429', {
      invoiceId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * Praca jest zrobiona; nieudane zgaszenie znacznika kosztuje najwyżej jedną zbędną
 * emisję z crona (idempotentną), więc nie wywraca joba.
 */
async function closeInboxInvoice(input: {
  supabase: ReturnType<typeof createAdminClient>;
  tenantId: string;
  invoiceId: string;
  step: JobContext['step'];
  logger: JobContext['logger'];
}): Promise<void> {
  const { supabase, tenantId, invoiceId, step, logger } = input;
  try {
    await step.run('mark-inbox-processed', () =>
      markInboxInvoiceProcessed(supabase, { tenantId, invoiceId }));
  } catch (e) {
    logger.warn('Skrzynka: nie udało się zgasić znacznika _pendingFullFetch — cron uzupełniający ponowi', {
      invoiceId,
      error: e instanceof Error ? e.message : String(e),
    });
    Sentry.captureException(e, {
      tags: { job: 'auto-categorize-inbox', step: 'mark-inbox-processed' },
      extra: { tenantId, invoiceId },
    });
  }
}


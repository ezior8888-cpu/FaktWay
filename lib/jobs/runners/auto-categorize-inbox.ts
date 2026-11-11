/**
 * Po zapisaniu faktury przychodzącej z inbox KSeF — tworzymy `expenses` z kategoryzacją KPiR.
 */

import * as Sentry from '@sentry/nextjs';

import { NonRetriableError } from '../errors';
import type { JobContext } from '@/lib/jobs/registry';

import { categorizeExpense } from '@/lib/categorization';
import {
  fpInvoiceFacts,
  fpMarkerFromXml,
  isSureReceiptMatch,
  RECEIPT_MATCH_LIMIT,
  receiptCandidates,
  receiptMatchWindow,
  type FpMarker,
  type ReceiptCandidateRow,
} from '@/lib/expenses/receipt-invoice-match';
import { downloadFromR2 } from '@/lib/storage/r2';
import {
  extractedInvoiceSchema,
  type ExtractedInvoice,
} from '@/lib/ocr/schema';
import { isSubjectiveVatExemption, readTenantVatExemption } from '@/lib/invoices/vat-exemption';
import { nbpRateForCost } from '@/lib/nbp/client';
import { costInPln, documentCurrency, HOME_CURRENCY } from '@/lib/ocr/currency';
import { createAdminClient } from '@/lib/supabase/admin';
import { archiveInboxInvoiceXml } from '@/lib/ksef/inbox-xml';
import { kolumnyPlatnosci } from '@/lib/expenses/platnosc-kosztu';
import { wczytajWarunkiPlatnosciKsef, zapiszWarunkiNaKoszcie } from '@/lib/expenses/platnosc-kosztu-ksef';
import { fa3Record, INBOX_PENDING_FLAG, markInboxInvoiceProcessed } from '@/lib/ksef/inbox-pending';
import { requireConfiguredKsefEnvironment } from '@/lib/ksef/claim-environment';
import { emitWebhookEvent } from '@/lib/webhooks/emit';
import { publishAppNotification } from '@/lib/app-notifications/publish';
import { inboxNewNotification } from '@/lib/app-notifications/texts';
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
      if (error || !row) return { processed: false, hasExpense: false, expenseId: null };
      const fa3 = fa3Record(row.fa3_data);
      const expenses = (row as unknown as { expenses: unknown }).expenses;
      const first = Array.isArray(expenses) ? expenses[0] : expenses;
      const expenseId = first && typeof first === 'object' && typeof (first as { id?: unknown }).id === 'string'
        ? (first as { id: string }).id
        : null;
      return {
        processed: fa3[INBOX_PENDING_FLAG] === false,
        hasExpense: Array.isArray(expenses) ? expenses.length > 0 : Boolean(expenses),
        expenseId,
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

    // Krok 3.4 (koszty do zapłaty): termin, rachunek sprzedawcy i MPP z pliku
    // w archiwum. Metadane skrzynki ich nie mają. Chwilowy błąd odczytu nie
    // blokuje kosztu, ale zostawia znacznik: cron uzupełniający ponowi.
    const platnosc = xml.archived || xml.reason === 'has-xml'
      ? await step.run('read-payment-terms', () => wczytajWarunkiPlatnosciKsef(supabase, { tenantId, invoiceId }))
      : null;
    const xmlSettled = xml.archived || xml.reason === 'has-xml' || xml.reason === 'not-applicable';
    const settled = xmlSettled && platnosc?.stan !== 'blad';

    // Koszt już jest, brakowało tylko XML albo warunków płatności: bez drugiego
    // liczenia kategorii i bez AI. Warunki dochodzą raz (`payment_terms IS NULL`).
    if (current.hasExpense) {
      // Webhook (krok 7.1, część 3): ponowienie po awarii między zapisem kosztu
      // a zleceniem przechodzi tędy. Druga emisja tego samego zdarzenia nie
      // wysyła drugi raz (stały identyfikator, UNIQUE dostawy w 00187).
      await emitWebhookEvent({ tenantId, type: 'expense.ksef_received', entityId: invoiceId });
      if (platnosc?.stan === 'odczytano') {
        const { warunki } = platnosc;
        await step.run('apply-payment-terms', () =>
          zapiszWarunkiNaKoszcie(supabase, { tenantId, invoiceId, warunki }));
      }
      // Ponowienie po awarii między zapisem kosztu a dopasowaniem paragonu:
      // RPC 00175 zapisuje dopasowanie faktury raz, więc to jest bezpieczne.
      if (current.expenseId) {
        await matchReceiptForFpInvoice({ supabase, tenantId, invoiceId, expenseId: current.expenseId, step, logger });
      }
      if (settled) {
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

    const created = await step.run('create-expense', async () => {
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
          // Kolumny 00177 (typy bazy dojdą po wgraniu migracji, AGENTS.md).
          ...(platnosc?.stan === 'odczytano' ? kolumnyPlatnosci(platnosc.warunki, new Date().toISOString()) : {}),
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

    // Webhook „nowa faktura kosztowa ze skrzynki” (krok 7.1, część 3). Fail-open:
    // awaria kolejki nie cofa kosztu i nie ponawia joba; przy wyłączonej fladze
    // `publicApiEnabled` nic się nie zleca.
    await emitWebhookEvent({ tenantId, type: 'expense.ksef_received', entityId: invoiceId });
    // Dzwonek (plan kompletnej aplikacji, krok 8.1, część 2, 00188): „Nowa
    // faktura zakupu” z linkiem do kosztu, tylko gdy ten przebieg go utworzył.
    // Fail-open: błąd zapisu idzie do logu i Sentry, koszt i domknięcie
    // skrzynki bez zmian. Ponowienie od zera widzi koszt (`hasExpense`) i tu nie
    // dochodzi; ten sam klucz (faktura) i tak nie doda drugiego wpisu (UNIQUE).
    if (!created.skipped) {
      await publishAppNotification(
        inboxNewNotification({
          tenantId,
          invoiceId,
          expenseId: String(created.expenseId),
          documentNumber: extracted.document_number,
          sellerName: extracted.seller_name,
          grossAmount: extracted.gross_amount,
          currency,
        }),
        { db: supabase, logger },
      );
    }
    // Krok 1.3: faktura do paragonu łączy się z wgranym paragonem z NIP przed
    // domknięciem, więc awaria tutaj zostawia znacznik i ponowienie wraca.
    await matchReceiptForFpInvoice({ supabase, tenantId, invoiceId, expenseId: created.expenseId, step, logger });

    // K2 (rewizja 03.10.2026): domknięcie przebiegu. Odbiór skrzynki zapala
    // `fa3_data._pendingFullFetch`; cron `inbox-backfill` emituje zdarzenie
    // ponownie dla faktur, które tu nie doszły. Znacznik gaśnie dopiero, gdy
    // koszt istnieje (utworzony albo zastany wyżej) i XML jest w archiwum albo
    // nie jest potrzebny. Błąd pobrania XML zostawia znacznik — cron spróbuje
    // ponownie, a koszt już jest. Tak samo chwilowy błąd odczytu warunków płatności.
    if (settled) {
      await closeInboxInvoice({ supabase, tenantId, invoiceId, step, logger });
    }

    return { success: true as const };
}

/**
 * Krok 1.3 (część 2): faktura do paragonu (FP) ze skrzynki a paragon z NIP
 * wgrany wcześniej (`lib/expenses/receipt-invoice-match.ts`). Bez kandydata
 * nic się nie zmienia i XML nie jest pobierany. Z kandydatami odczyt `Fa/FP`
 * z archiwum XML rozstrzyga: zwykła faktura jak dziś, FP z jednym pewnym
 * kandydatem łączy się, reszta (kilku kandydatów, niepewna data, brak XML)
 * to ostrzeżenie na obu dokumentach do decyzji klienta.
 *
 * Ponowienie od zera: odczyty bez efektów; RPC 00175 w jednej transakcji
 * zapisuje dopasowanie faktury raz (blokada wiersza kosztu i warunek „brak
 * zapisu dla tej faktury”), więc drugie wykonanie zwraca `already_recorded`.
 */
async function matchReceiptForFpInvoice(input: {
  supabase: ReturnType<typeof createAdminClient>;
  tenantId: string;
  invoiceId: string;
  expenseId: string;
  step: JobContext['step'];
  logger: JobContext['logger'];
}): Promise<void> {
  const { supabase, tenantId, invoiceId, expenseId, step, logger } = input;

  const found = await step.run('find-receipt-for-fp', async () => {
    const { data: invoice, error } = await supabase
      .from('invoices')
      .select('id, issue_date, currency, gross_total, seller_nip, seller_data, fa3_data, xml_storage_path')
      .eq('id', invoiceId)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (error) throw new Error('Nie można odczytać faktury do dopasowania paragonu');
    if (!invoice) return null;
    const facts = fpInvoiceFacts(invoice, resolveSellerNip(invoice as unknown as InvoiceWithLines));
    if (!facts) return null;

    const window = receiptMatchWindow(facts.issueDay);
    const { data: rows, error: rowsError } = await supabase
      .from('expenses')
      .select('id, issue_date, gross_amount, seller_nip, document_type, source, ksef_invoice_id, ocr_extracted_data')
      .eq('tenant_id', tenantId)
      .is('ksef_invoice_id', null)
      .neq('source', 'ksef_inbox')
      .eq('gross_amount', facts.grossGr / 100)
      .gte('issue_date', window.from)
      .lte('issue_date', window.to)
      .order('id', { ascending: true })
      .limit(RECEIPT_MATCH_LIMIT);
    if (rowsError) throw new Error('Nie można sprawdzić paragonów do faktury');
    const candidates = receiptCandidates(facts, (rows ?? []) as ReceiptCandidateRow[]);
    if (candidates.length === 0) return null;
    return {
      issueDay: facts.issueDay,
      candidates,
      xmlStoragePath: typeof invoice.xml_storage_path === 'string' ? invoice.xml_storage_path : null,
    };
  });
  if (!found) return;

  const fp = await step.run('read-fp-marker', () => readFpMarker(tenantId, invoiceId, found.xmlStoragePath, logger));
  if (fp === false) return;

  const autoLink = isSureReceiptMatch(fp, found.issueDay, found.candidates);
  const result = await step.run('record-receipt-match', async () => {
    const { data, error } = await supabase.rpc('match_receipt_to_ksef_invoice', {
      p_tenant_id: tenantId,
      p_invoice_expense_id: expenseId,
      p_receipt_expense_ids: found.candidates.map((c) => c.id),
      p_auto_link: autoLink,
    });
    if (error) throw new Error(`Nie udało się zapisać dopasowania paragonu: ${error.message}`);
    return data;
  });
  logger.info('Skrzynka: faktura do paragonu a paragon z NIP', {
    invoiceId, expenseId, fp, candidates: found.candidates.length, autoLink, result,
  });
}

/**
 * `Fa/FP` z archiwum XML. Brak pliku albo błąd odczytu to „nie wiadomo”:
 * wtedy nic nie łączy się samo, a kandydaci dostają ostrzeżenie.
 */
async function readFpMarker(
  tenantId: string,
  invoiceId: string,
  storagePath: string | null,
  logger: JobContext['logger'],
): Promise<FpMarker> {
  if (!storagePath) return null;
  try {
    const bytes = await downloadFromR2(storagePath, tenantId);
    return fpMarkerFromXml(bytes.toString('utf8'));
  } catch (e) {
    logger.warn('Skrzynka: nie udało się odczytać XML faktury do sprawdzenia FP', {
      invoiceId,
      error: e instanceof Error ? e.message : String(e),
    });
    Sentry.captureException(e, {
      tags: { job: 'auto-categorize-inbox', step: 'read-fp-marker' },
      extra: { tenantId, invoiceId },
    });
    return null;
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


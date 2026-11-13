import 'server-only';

import { logAudit } from '@/lib/audit/log';
import {
  buildInvoiceFromForm,
  draftInvoiceRow,
  draftLineRows,
  type TenantAddressSnapshot,
  type TenantSnapshot,
} from '@/lib/invoices/build-from-form';
import { readTenantCashMethodForIssuance } from '@/lib/invoices/cash-method';
import { issueDateNotTodayError } from '@/lib/invoices/issue-date';
import { enqueueKsefSubmitAfterDraft, type TokenSessionSendActor } from '@/lib/invoices/ksef-submit-enqueue';
import {
  advanceRecurringRunDate,
  findInvoiceForPeriod,
  isRecurringPeriodConflict,
  loadRecurringIssueLink,
  periodTakenMessage,
  RECURRING_CHANGED_MESSAGE,
  RECURRING_DRAFT_LEFT_NOTE,
  withRecurringColumns,
  type RecurringIssueLink,
} from '@/lib/invoices/recurring/issue';
import { readTenantVatExemption } from '@/lib/invoices/vat-exemption';
import {
  salesQuoteConflictMessage,
  salesQuoteConvertedAudit,
  salesQuoteLinkForSave,
  withSalesQuoteColumns,
  type SalesQuoteIssueLink,
} from '@/lib/proformy/powiazanie';
import { invoiceFormSchema, type InvoiceFormValues } from '@/lib/schemas/invoice-form';
import type { createClient } from '@/lib/supabase/server';
import { ZW_WITHOUT_BASIS_MESSAGE } from '@/lib/xml/invoice-calculator';
import type { Invoice } from '@/types/invoice';

/**
 * Wystawienie zwykłej faktury VAT z wartości formularza: szkic albo szkic
 * i kolejka wysyłki do KSeF (plan aplikacji mobilnej 4.3, etap M8).
 *
 * Do M8 ta logika siedziała w akcjach `saveDraftAction` i
 * `saveAndSendInvoiceAction` (`components/invoices/actions.ts`), które czytają
 * sesję z ciasteczek. Aplikacja na telefon ich nie wywoła, więc logika jest
 * tutaj, a akcje strony i trasa `POST /api/mobile/v1/faktury` wołają te same
 * funkcje. Wołający odpowiada za: sesję i firmę (`RegularIssueContext`),
 * walidację schematem (`parseRegularInvoiceForm`) przed wywołaniem i
 * odświeżenie widoków strony (`revalidatePath`).
 *
 * Kolejność i komunikaty są dokładnie takie jak w akcjach przed wydzieleniem
 * (pilnuje `tests/unit/wystawienie-faktury-lib.test.ts`).
 */

type SessionDb = Awaited<ReturnType<typeof createClient>>;

export interface RegularIssueContext {
  /** Klient z sesją klienta (ciasteczka strony albo token telefonu): RLS jak na stronie. */
  supabase: SessionDb;
  userId: string;
  tenant: TenantSnapshot;
  /** Telefon: 2FA i znacznik KSeF z tokenu zamiast z ciasteczek (`ksef-submit-enqueue.ts`). */
  tokenSession?: TokenSessionSendActor;
}

export type RegularIssueResult =
  | { success: true; invoiceId: string; offline?: boolean }
  /** `invoiceId`: zapisany szkic (np. brak certyfikatu KSeF; klient może do niego wrócić). */
  | { success: false; error: string; invoiceId?: string };

/**
 * Krok między zapisem szkicu a kolejką KSeF (telefon: klucz idempotencji
 * żądania). Odmowa zostawia szkic i nie zleca wysyłki.
 */
export type AfterDraftSaved = (invoiceId: string) => Promise<{ ok: true } | { ok: false; error: string }>;

/** Ten sam schemat co formularz strony (AGENTS.md: walidacja klient i serwer); pierwszy błąd jako zdanie. */
export function parseRegularInvoiceForm(
  values: unknown,
): { ok: true; values: InvoiceFormValues } | { ok: false; error: string; path: ReadonlyArray<PropertyKey> } {
  const parsed = invoiceFormSchema.safeParse(values);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: issue?.message ?? 'Nieprawidłowe dane faktury', path: issue?.path ?? [] };
  }
  return { ok: true, values: parsed.data };
}

/** Dane firmy do faktury (sprzedawca); błąd odczytu albo brak firmy rzuca. */
export async function readTenantSnapshot(supabase: SessionDb, tenantId: string): Promise<TenantSnapshot> {
  const { data: raw, error } = await supabase
    .from('tenants')
    .select('id, nip, name, address_json')
    .eq('id', tenantId)
    .maybeSingle();

  if (error || !raw) throw new Error('Brak danych firmy');

  return {
    id: raw.id as string,
    nip: raw.nip as string,
    name: raw.name as string,
    address: (raw.address_json as TenantAddressSnapshot | null) ?? null,
  };
}

/** Wspólna ścieżka zapisu: INSERT invoices + line_items w transakcji
 *  "best-effort" (Supabase nie daje klienckich transakcji; w razie błędu
 *  linii usuwamy fakturę-matkę żeby nie zostawiać sierot).
 *
 *  `recurring` (plan Finora N1): faktura z pozycji cyklicznej. Powiązanie
 *  i okres idą w TYM SAMYM INSERT — unikalny indeks `uq_invoices_recurring_period`
 *  przepuszcza jedną fakturę na okres. Po udanym zapisie (z pozycjami)
 *  warunkowy UPDATE przesuwa `next_run_date`; jego błąd nie psuje zapisu.
 *  Oba zdarzenia — zajęcie okresu i samonaprawa daty po 23505 — idą do
 *  `audit_logs` (K3). Bez `recurring` wiersz i zachowanie są takie jak przed N1. */
export async function insertInvoiceAndLines(
  supabase: SessionDb,
  tenantId: string,
  invoice: Invoice,
  formValues?: InvoiceFormValues,
  recurringIssue?: { link: RecurringIssueLink; userId: string },
  salesQuoteIssue?: { link: SalesQuoteIssueLink; userId: string },
): Promise<RegularIssueResult> {
  const recurring = recurringIssue?.link;
  const recurringUserId = recurringIssue?.userId ?? null;
  // Krok 2.4: faktura z proformy albo oferty niesie powiązanie w tym samym INSERT
  // (`uq_invoices_sales_quote_seq`, 00198); zwykła faktura ma wiersz bez zmian.
  const salesQuote = salesQuoteIssue?.link;

  const { data: inserted, error: invErr } = await supabase
    .from('invoices')
    // N1: tylko faktura z pozycji cyklicznej niesie dwie nowe kolumny —
    // zwykła faktura ma wiersz bez zmian (bez tych kluczy, nie z NULL-ami).
    .insert(withSalesQuoteColumns(withRecurringColumns(draftInvoiceRow(tenantId, invoice, formValues), recurring), salesQuote))
    .select('id')
    .single();

  if (invErr || !inserted) {
    // N1: za ten okres jest już faktura — komunikat z jej numerem i samonaprawa
    // `next_run_date` (gdy przesunięcie po tamtym zapisie się nie udało).
    // Sprawdzamy przy KAŻDYM 23505: przy podwójnym kliknięciu z tym samym
    // numerem Postgres zgłasza indeks numeru, choć zajęty jest i okres.
    if (recurring && invErr?.code === '23505') {
      const existing = await findInvoiceForPeriod(supabase, tenantId, recurring);
      if (existing) {
        const repaired = await advanceRecurringRunDate(supabase, tenantId, recurring);
        if (repaired) {
          await logAudit({
            action: 'recurring_invoice.run_date_repaired',
            tenantId,
            userId: recurringUserId,
            entityType: 'recurring_invoice',
            entityId: recurring.recurringInvoiceId,
            metadata: {
              recurringPeriod: recurring.period,
              existingInvoiceId: existing.id,
              existingInternalNumber: existing.internal_number,
              fromNextRunDate: recurring.runDate,
              toNextRunDate: recurring.nextRunDate,
            },
          });
        }
        return { success: false, error: periodTakenMessage(existing) };
      }
      if (isRecurringPeriodConflict(invErr)) {
        // Indeks okresu odrzucił zapis, ale faktury nie widać (np. usunięta
        // między zapisem a odczytem) — bez numeru, bez przesuwania daty.
        return {
          success: false,
          error: 'Faktura za ten okres jest już wystawiona. Sprawdź listę faktur.',
        };
      }
    }
    // Krok 2.4: numer zamiany dokumentu zajęła inna faktura (dwa zapisy naraz albo
    // ponowienie). Sprawdzamy przy każdym 23505, jak przy okresie faktury cyklicznej:
    // Postgres zgłasza jeden z indeksów, a klient ma dostać numer tamtej faktury.
    if (salesQuote) {
      const taken = await salesQuoteConflictMessage(supabase, tenantId, salesQuote, invErr);
      if (taken) return { success: false, error: taken };
    }
    // Postgres 23505 = unique_violation. Po migracji 00028 to oznacza duplikat
    // `internal_number` w obrębie tego tenanta — najczęściej double-click "Wystaw
    // i wyślij" lub równoległa próba zapisu z innej karty. Friendly message
    // zamiast technicznego "duplicate key value violates unique constraint
    // \"uq_invoices_tenant_internal_number\"".
    if (invErr?.code === '23505') {
      return {
        success: false,
        error: `Faktura o numerze "${invoice.internalNumber}" już istnieje. Sprawdź listę faktur lub wybierz inny numer.`,
      };
    }
    return {
      success: false,
      error: invErr?.message ?? 'Nie udało się zapisać faktury',
    };
  }

  const { error: linesErr } = await supabase.from('invoice_line_items').insert(
    draftLineRows(invoice).map((line) => ({ invoice_id: inserted.id, ...line }))
  );

  if (linesErr) {
    // Rollback best-effort. Nawet jeśli się nie uda - faktura bez linii jest
    // w stanie 'draft' i user może ją edytować/usunąć ręcznie.
    await supabase.from('invoices').delete().eq('id', inserted.id);
    return {
      success: false,
      error: `Błąd zapisu pozycji: ${linesErr.message}`,
    };
  }

  if (recurring) {
    const advanced = await advanceRecurringRunDate(supabase, tenantId, recurring);
    await logAudit({
      action: 'recurring_invoice.issued',
      tenantId,
      userId: recurringUserId,
      entityType: 'recurring_invoice',
      entityId: recurring.recurringInvoiceId,
      metadata: {
        invoiceId: inserted.id as string,
        internalNumber: invoice.internalNumber,
        recurringPeriod: recurring.period,
        fromNextRunDate: recurring.runDate,
        toNextRunDate: recurring.nextRunDate,
        // false: przesunięcie nie wyszło (albo ktoś zmienił datę) — naprawi je następna próba po 23505.
        nextRunDateAdvanced: advanced,
      },
    });
  }

  if (salesQuote) {
    await logAudit(
      salesQuoteConvertedAudit(salesQuote, tenantId, salesQuoteIssue?.userId ?? null, {
        invoiceId: inserted.id as string,
        internalNumber: invoice.internalNumber,
        invoiceKind: 'regular',
      }),
    );
  }

  return { success: true, invoiceId: inserted.id as string };
}

/**
 * N1: pozycja cykliczna z formularza (`?cykliczna=`) — odczyt PRZED zapisem;
 * zwykła faktura: `link` pusty. C3: okres z formularza (pokazany w banerze)
 * musi być okresem pozycji teraz — inaczej nic nie zapisujemy. Jeśli za
 * okres z formularza jest już faktura, klient dostaje jej numer (a nie radę
 * „wybierz inny numer”, która prowadziła do drugiej faktury za ten sam
 * miesiąc); jeśli nie — prośbę o ponowne otwarcie „Wystaw teraz”.
 */
async function recurringLinkForForm(
  supabase: SessionDb,
  tenantId: string,
  values: InvoiceFormValues,
): Promise<{ ok: true; link: RecurringIssueLink | undefined } | { ok: false; error: string }> {
  if (!values.recurringInvoiceId) return { ok: true, link: undefined };
  const loaded = await loadRecurringIssueLink(supabase, tenantId, values.recurringInvoiceId);
  if (!loaded.ok) return loaded;
  const formPeriod = values.recurringPeriod;
  if (formPeriod && formPeriod !== loaded.link.period) {
    const existing = await findInvoiceForPeriod(supabase, tenantId, {
      recurringInvoiceId: loaded.link.recurringInvoiceId,
      period: formPeriod,
    });
    return { ok: false, error: existing ? periodTakenMessage(existing) : RECURRING_CHANGED_MESSAGE };
  }
  return { ok: true, link: loaded.link };
}

/**
 * Szkic zwykłej faktury (`saveDraftAction`). Wołający odmawia wcześniej
 * szkicu z pozycji cyklicznej (C2) i sprawdza schemat.
 */
export async function saveRegularDraft(ctx: RegularIssueContext, values: InvoiceFormValues): Promise<RegularIssueResult> {
  const { supabase, tenant, userId } = ctx;
  // Odpornie: przed wgraniem 00091 kolumny nie ma — zwykła faktura nie może
  // od niej zależeć.
  const vatExemptionBasis = await readTenantVatExemption(supabase, tenant.id);
  // Bez 00094 nie znamy prawnej adnotacji P_16; nie zapisujemy dokumentu.
  const cashMethod = await readTenantCashMethodForIssuance(supabase, tenant.id);
  const invoice = buildInvoiceFromForm(values, tenant, vatExemptionBasis, cashMethod);

  // Krok 2.4: dokument (proforma, oferta) z formularza sprawdzony przed zapisem.
  const salesQuote = await salesQuoteLinkForSave(supabase, tenant.id, values.salesQuoteId, values.salesQuoteSeq);
  if (!salesQuote.ok) return { success: false, error: salesQuote.error };
  // Zwykły szkic — bez pozycji cyklicznej (odmowa u wołającego).
  const result = await insertInvoiceAndLines(
    supabase,
    tenant.id,
    invoice,
    values,
    undefined,
    salesQuote.link ? { link: salesQuote.link, userId } : undefined,
  );
  if (result.success && result.invoiceId) {
    await logAudit({
      action: 'invoice.draft_created',
      tenantId: tenant.id,
      userId,
      entityType: 'invoice',
      entityId: result.invoiceId,
      metadata: {
        internalNumber: invoice.internalNumber,
        grossTotal: invoice.grossTotal,
      },
    });
  }
  return result;
}

/**
 * „Wystaw i wyślij do KSeF” (`saveAndSendInvoiceAction`): szkic, potem ta sama
 * kolejka wysyłki co każdy dokument (`enqueueKsefSubmitAfterDraft`). Wołający
 * sprawdza schemat. `afterSaved` (telefon) biegnie między zapisem szkicu
 * a kolejką; strona go nie podaje.
 */
export async function saveAndSendRegularInvoice(
  ctx: RegularIssueContext,
  values: InvoiceFormValues,
  afterSaved?: AfterDraftSaved,
): Promise<RegularIssueResult> {
  const { supabase, tenant, userId } = ctx;
  // Faktura w KSeF jest wystawiona w dniu przesłania (F-092, A1) — ta sama
  // reguła dla wszystkich dokumentów. Inną datę można zapisać jako szkic.
  const notToday = issueDateNotTodayError(values.issueDate, 'form');
  if (notToday) return { success: false, error: notToday };
  // Odpornie: przed wgraniem 00091 kolumny nie ma — zwykła faktura nie może
  // od niej zależeć.
  const vatExemptionBasis = await readTenantVatExemption(supabase, tenant.id);
  // Bez 00094 nie znamy prawnej adnotacji P_16; nie zapisujemy dokumentu.
  const cashMethod = await readTenantCashMethodForIssuance(supabase, tenant.id);
  const invoice = buildInvoiceFromForm(values, tenant, vatExemptionBasis, cashMethod);
  // 0) „zw” bez podstawy zwolnienia: mówimy od razu, zanim faktura pójdzie do
  //    kolejki KSeF i wróci jako odrzucona. Szkic da się zapisać bez tego.
  if (invoice.lines.some((l) => l.vatRate === 'zw') && !invoice.annotations?.vatExemptionBasis) {
    return { success: false, error: ZW_WITHOUT_BASIS_MESSAGE };
  }
  // N1: pozycja wstrzymana, usunięta albo obca — odmowa przed zapisem.
  const recurring = await recurringLinkForForm(supabase, tenant.id, values);
  if (!recurring.ok) return { success: false, error: recurring.error };
  // Krok 2.4: proforma albo oferta z formularza: wystawiona, tej firmy, numer zamiany wolny.
  const salesQuote = await salesQuoteLinkForSave(supabase, tenant.id, values.salesQuoteId, values.salesQuoteSeq);
  if (!salesQuote.ok) return { success: false, error: salesQuote.error };
  // 1) Najpierw draft - jeśli DB padnie, nie publikujemy eventu-sieroty.
  const saved = await insertInvoiceAndLines(
    supabase,
    tenant.id,
    invoice,
    values,
    recurring.link ? { link: recurring.link, userId } : undefined,
    salesQuote.link ? { link: salesQuote.link, userId } : undefined,
  );
  if (!saved.success) return saved;

  if (afterSaved) {
    const after = await afterSaved(saved.invoiceId);
    if (!after.ok) return { success: false, error: after.error, invoiceId: saved.invoiceId };
  }

  const enq = await enqueueKsefSubmitAfterDraft({
    supabase,
    tenantId: tenant.id,
    userId,
    invoiceId: saved.invoiceId,
    nip: tenant.nip,
    invoice,
    auditKind: 'regular',
    internalNumberForAudit: invoice.internalNumber,
    ...(ctx.tokenSession ? { tokenSession: ctx.tokenSession } : {}),
  });

  if (!enq.ok) {
    if (saved.invoiceId) {
      const isSettingsRead = enq.error.startsWith('Nie można sprawdzić ustawień');
      const isNoCert =
        enq.error.includes('Najpierw wgraj certyfikat') ||
        enq.error.includes('Brak certyfikatu KSeF');
      if (isSettingsRead || isNoCert) {
        await logAudit({
          action: 'invoice.draft_created',
          tenantId: tenant.id,
          userId,
          entityType: 'invoice',
          entityId: saved.invoiceId,
          metadata: {
            internalNumber: invoice.internalNumber,
            note: isSettingsRead ? 'submit_aborted_tenant_read_error' : 'submit_blocked_no_ksef_cert',
            ...(recurring.link
              ? { recurringInvoiceId: recurring.link.recurringInvoiceId, recurringPeriod: recurring.link.period }
              : {}),
          },
        });
      }
    }
    return {
      success: false,
      // C4: szkic z okresem został — klient ma wiedzieć, że okres wróci po usunięciu szkicu.
      error: recurring.link && saved.invoiceId ? `${enq.error} ${RECURRING_DRAFT_LEFT_NOTE}` : enq.error,
      invoiceId: saved.invoiceId,
    };
  }

  if (!saved.invoiceId) {
    return { success: false, error: 'Brak invoiceId po zapisie szkicu' };
  }

  return {
    success: true,
    invoiceId: saved.invoiceId,
    offline: false,
  };
}

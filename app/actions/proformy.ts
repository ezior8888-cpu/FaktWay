'use server';

import type { SupabaseClient } from '@supabase/supabase-js';
import { revalidatePath } from 'next/cache';

import { lookupBuyerAction } from '@/components/invoices/actions';
import { logAudit } from '@/lib/audit/log';
import { sendEmail, type EmailStubResult } from '@/lib/email/send';
import { todayInWarsaw } from '@/lib/format/warsaw-date';
import { countQuoteEmailsTo, counterpartyFromContractor, getQuote, quotesTable } from '@/lib/proformy/baza';
import { normalizeQuoteRecipient, quoteEmailHtml, quoteEmailIdempotencyKey, quoteEmailSubject } from '@/lib/proformy/mail';
import { canWriteQuotes, isQuoteKind, quoteItems, quoteTotals, type QuoteContractorOption } from '@/lib/proformy/model';
import { quotePdfFilename, quotePdfInput, renderQuotePdf } from '@/lib/proformy/pdf';
import { quoteDraftSchema, quoteIssueDateError, type QuoteDraftInput } from '@/lib/proformy/schemat';
import { QUOTE_TEXTS, quoteEmailLimitMessage, quoteIssuedLockedMessage } from '@/lib/proformy/teksty';
import { checkRateLimit } from '@/lib/rate-limit';
import { ActionAuthError, requireUserAndActiveOrg, type AuthContext } from '@/lib/supabase/auth-context';

/**
 * Proforma i oferta (plan kompletnej aplikacji, krok 2.4): szkic, wystawienie,
 * usunięcie szkicu i wysyłka mailem.
 *
 * Firma i rola z sesji; zapis i odczyt klientem z sesji, więc te same reguły
 * egzekwuje baza (RLS, granty kolumnowe, wyzwalacz, CHECK-i i funkcje 00198).
 * Numer nadaje wyłącznie RPC `issue_sales_quote`. Każdy aktywny członek firmy
 * może to samo co przy fakturze (`canWriteQuotes`). Kwoty pozycji i sumy liczą
 * funkcje faktury (`quoteItems`, `quoteTotals`), nigdy formularz.
 *
 * Ponowienie od zera (protokół, pkt 5), wysyłka mailem:
 *  1. odczyt dokumentu i liczby zapisanych wysyłek na ten adres: bez skutków;
 *  2. PDF: powtarzalny (ten sam dokument, te same bajty);
 *  3. mail z kluczem `sales-quote/<id>/<skrót adresu>/<liczba zapisanych wysyłek>`:
 *     ponowienie po wysyłce bez zapisu historii daje ten sam klucz i tę samą
 *     treść, więc Resend nie wyśle drugi raz (klucz ważny 24 h);
 *  4. zapis historii RPC `record_sales_quote_email`: raz na klucz, audyt
 *     tylko przy nowym wpisie. Świadome „Wyślij ponownie” po zapisanej
 *     wysyłce ma nowy klucz.
 */

type Failure = { success: false; error: string };
export type AddQuoteContractorResult = { success: true; contractor: QuoteContractorOption } | Failure;
export type SaveQuoteDraftResult = { success: true; id: string } | Failure;
export type IssueQuoteResult = { success: true; number: string; alreadyIssued: boolean } | Failure;
export type DeleteQuoteDraftResult = { success: true } | Failure;
export type SendQuoteEmailResult = { success: true; recipient: string } | Failure;

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ile proform i ofert firma może wysłać mailem w godzinie (jak faktury i noty, AUD-102). */
const QUOTE_EMAILS_PER_HOUR = 30;

/** Funkcje 00198 nie są jeszcze w `types/database.ts` (typy z produkcji po wgraniu migracji). */
function rpcClient(supabase: AuthContext['supabase']): SupabaseClient {
  return supabase as unknown as SupabaseClient;
}

async function writerContext(): Promise<{ ok: true; ctx: AuthContext } | { ok: false; error: string }> {
  try {
    const ctx = await requireUserAndActiveOrg();
    if (!canWriteQuotes(ctx.role)) return { ok: false, error: QUOTE_TEXTS.role };
    return { ok: true, ctx };
  } catch (err) {
    if (err instanceof ActionAuthError) return { ok: false, error: err.message };
    throw err;
  }
}

/** Czemu zapis albo usunięcie nie trafiło w szkic: dokument wystawiony (z numerem) albo go nie ma. */
async function whyNotDraft(supabase: AuthContext['supabase'], tenantId: string, quoteId: string): Promise<string> {
  const current = await getQuote(supabase, tenantId, quoteId).catch(() => null);
  return current?.status === 'issued' ? quoteIssuedLockedMessage(current.kind, current.number) : QUOTE_TEXTS.notFound;
}

/**
 * Kontrahent po NIP, gdy nie ma go jeszcze w bazie: ta sama droga co
 * w formularzu faktury (`lookupBuyerAction`: baza kontrahentów firmy, a bez
 * trafienia GUS z zapisem do bazy). Dokument dalej bierze kontrahenta
 * wyłącznie z bazy firmy, więc identyfikator czytamy z bazy klientem z sesji.
 */
export async function addQuoteContractorAction(nip: string): Promise<AddQuoteContractorResult> {
  const clean = (typeof nip === 'string' ? nip : '').replace(/\D/g, '');
  const auth = await writerContext();
  if (!auth.ok) return { success: false, error: auth.error };
  const lookup = await lookupBuyerAction(clean);
  if (!lookup.success) return { success: false, error: lookup.error };

  const { supabase, tenantId } = auth.ctx;
  const { data, error } = await supabase
    .from('contractors')
    .select('id, name, nip, email')
    .eq('tenant_id', tenantId)
    .eq('nip', lookup.data.nip)
    .maybeSingle();
  if (error || !data) return { success: false, error: QUOTE_TEXTS.contractorAddFailed };
  return { success: true, contractor: { id: data.id, name: data.name, nip: data.nip, email: data.email ?? null } };
}

/**
 * Zapis szkicu: nowy (`quoteId` null) albo zmiana istniejącego. Formularz
 * odsyła firmę, dla której go wyrenderowano (UX-01): dokument z formularza
 * firmy A nie powstanie w firmie B. Kontrahent wyłącznie z bazy kontrahentów
 * tej firmy; jego dane idą do dokumentu jako migawka.
 */
export async function saveQuoteDraftAction(
  input: QuoteDraftInput,
  expectedTenantId: string,
  quoteId: string | null = null,
): Promise<SaveQuoteDraftResult> {
  if (quoteId !== null && !UUID_SHAPE.test(quoteId)) return { success: false, error: QUOTE_TEXTS.notFound };

  let ctx: AuthContext;
  try {
    ctx = await requireUserAndActiveOrg({ expectedTenantId });
  } catch (err) {
    if (err instanceof ActionAuthError) return { success: false, error: err.message };
    throw err;
  }
  if (!canWriteQuotes(ctx.role)) return { success: false, error: QUOTE_TEXTS.role };

  const parsed = quoteDraftSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? QUOTE_TEXTS.saveFailed };
  }
  const draft = parsed.data;
  const dateError = quoteIssueDateError(draft.issueDate, todayInWarsaw());
  if (dateError) return { success: false, error: dateError };

  const { supabase, tenantId, user } = ctx;
  const { data: contractor, error: contractorError } = await supabase
    .from('contractors')
    .select('id, name, nip, address, email')
    .eq('tenant_id', tenantId)
    .eq('id', draft.contractorId)
    .maybeSingle();
  if (contractorError) return { success: false, error: QUOTE_TEXTS.saveFailed };
  if (!contractor) return { success: false, error: QUOTE_TEXTS.contractorMissing };
  const counterparty = counterpartyFromContractor(contractor);
  if (!counterparty) return { success: false, error: QUOTE_TEXTS.contractorIncomplete };

  const items = quoteItems(draft.items);
  const totals = quoteTotals(items);
  const content = {
    kind: draft.kind,
    issue_date: draft.issueDate,
    valid_until: draft.validUntil,
    items,
    net_total: totals.netTotal,
    vat_total: totals.vatTotal,
    gross_total: totals.grossTotal,
    currency: draft.currency,
    contractor_id: contractor.id,
    counterparty,
    payment_method: draft.paymentMethod,
    payment_due_date: draft.paymentDueDate,
    bank_account: draft.bankAccount,
    notes: draft.notes,
  };
  const metadata = { kind: draft.kind, grossTotal: totals.grossTotal, itemCount: items.length };

  let id: string;
  if (quoteId === null) {
    const { data, error } = await quotesTable(supabase).insert({ tenant_id: tenantId, ...content }).select('id').single();
    if (error || !data) {
      // 23503: kontrahent usunięty między odczytem a zapisem (klucz złożony z firmą).
      return { success: false, error: error?.code === '23503' ? QUOTE_TEXTS.contractorMissing : QUOTE_TEXTS.saveFailed };
    }
    id = (data as { id: string }).id;
    await logAudit({
      action: 'sales_quote.draft_created',
      tenantId,
      userId: user.id,
      entityType: 'sales_quote',
      entityId: id,
      metadata,
    });
  } else {
    // Tylko szkic (RLS i ten filtr): wystawionego dokumentu nie zmienia nikt.
    const { data, error } = await quotesTable(supabase)
      .update(content)
      .eq('tenant_id', tenantId)
      .eq('id', quoteId)
      .eq('status', 'draft')
      .select('id');
    if (error) {
      return { success: false, error: error.code === '23503' ? QUOTE_TEXTS.contractorMissing : QUOTE_TEXTS.saveFailed };
    }
    if (!data || data.length === 0) return { success: false, error: await whyNotDraft(supabase, tenantId, quoteId) };
    id = quoteId;
    await logAudit({
      action: 'sales_quote.draft_updated',
      tenantId,
      userId: user.id,
      entityType: 'sales_quote',
      entityId: id,
      metadata,
    });
  }

  revalidatePath('/proformy');
  revalidatePath(`/proformy/${id}`);
  return { success: true, id };
}

function issueRefusal(code: unknown): string {
  switch (code) {
    case 'not_found':
      return QUOTE_TEXTS.notFound;
    case 'future_date':
      return QUOTE_TEXTS.futureDate;
    case 'valid_until_past':
      return QUOTE_TEXTS.validUntilPast;
    case 'contractor_missing':
      return QUOTE_TEXTS.contractorRemoved;
    case 'issuer_incomplete':
      return QUOTE_TEXTS.issuerIncomplete;
    default:
      return QUOTE_TEXTS.issueFailed;
  }
}

/**
 * Wystawienie szkicu: numer, dane wystawcy i audyt w jednej transakcji bazy
 * (RPC `issue_sales_quote`). Drugie kliknięcie oddaje ten sam numer.
 */
export async function issueQuoteAction(quoteId: string): Promise<IssueQuoteResult> {
  if (!UUID_SHAPE.test(quoteId)) return { success: false, error: QUOTE_TEXTS.notFound };
  const auth = await writerContext();
  if (!auth.ok) return { success: false, error: auth.error };

  const { data, error } = await rpcClient(auth.ctx.supabase).rpc('issue_sales_quote', { p_quote_id: quoteId });
  if (error) {
    return { success: false, error: error.code === '42501' ? QUOTE_TEXTS.issueRole : QUOTE_TEXTS.issueFailed };
  }
  const result = (data ?? null) as { status?: unknown; number?: unknown; code?: unknown } | null;
  if ((result?.status === 'issued' || result?.status === 'already_issued') && typeof result.number === 'string') {
    revalidatePath('/proformy');
    revalidatePath(`/proformy/${quoteId}`);
    return { success: true, number: result.number, alreadyIssued: result.status === 'already_issued' };
  }
  return { success: false, error: issueRefusal(result?.code) };
}

/** Usunięcie szkicu (bez numeru, więc bez luki w serii). Wystawionego nie usuwa nikt. */
export async function deleteQuoteDraftAction(quoteId: string): Promise<DeleteQuoteDraftResult> {
  if (!UUID_SHAPE.test(quoteId)) return { success: false, error: QUOTE_TEXTS.notFound };
  const auth = await writerContext();
  if (!auth.ok) return { success: false, error: auth.error };
  const { supabase, tenantId, user } = auth.ctx;

  const { data, error } = await quotesTable(supabase)
    .delete()
    .eq('tenant_id', tenantId)
    .eq('id', quoteId)
    .eq('status', 'draft')
    .select('id, kind');
  if (error) return { success: false, error: QUOTE_TEXTS.deleteFailed };
  if (!data || data.length === 0) return { success: false, error: await whyNotDraft(supabase, tenantId, quoteId) };

  const kind = (data[0] as { kind?: unknown }).kind;
  await logAudit({
    action: 'sales_quote.draft_deleted',
    tenantId,
    userId: user.id,
    entityType: 'sales_quote',
    entityId: quoteId,
    metadata: { kind: isQuoteKind(kind) ? kind : null },
  });
  revalidatePath('/proformy');
  return { success: true };
}

function sendRefusal(result: EmailStubResult): string {
  if (result.reason === 'not-configured') return QUOTE_TEXTS.emailNotConfigured;
  if (result.reason === 'hard_bounce' || result.reason === 'complaint') return QUOTE_TEXTS.emailBlocked;
  return QUOTE_TEXTS.emailFailed;
}

/** Wysyłka wystawionego dokumentu mailem z PDF do kontrahenta (opis ponowienia w nagłówku pliku). */
export async function sendQuoteEmailAction(quoteId: string, recipientEmail: string): Promise<SendQuoteEmailResult> {
  const recipient = normalizeQuoteRecipient(typeof recipientEmail === 'string' ? recipientEmail : '');
  if (!recipient) return { success: false, error: QUOTE_TEXTS.emailInvalid };
  if (!UUID_SHAPE.test(quoteId)) return { success: false, error: QUOTE_TEXTS.notFound };
  const auth = await writerContext();
  if (!auth.ok) return { success: false, error: auth.error };
  const { supabase, tenantId } = auth.ctx;

  // Limit na firmę przed PDF i wysyłką: mail idzie z domeny FaktWay na dowolny adres.
  const quota = await checkRateLimit({
    bucket: 'sales_quote_email',
    identifier: tenantId,
    limit: QUOTE_EMAILS_PER_HOUR,
    windowSeconds: 3600,
  });
  if (!quota.allowed) return { success: false, error: quoteEmailLimitMessage(QUOTE_EMAILS_PER_HOUR) };

  let quote;
  let previousSends: number;
  try {
    quote = await getQuote(supabase, tenantId, quoteId);
    if (quote?.status === 'issued') previousSends = await countQuoteEmailsTo(supabase, tenantId, quoteId, recipient);
    else previousSends = 0;
  } catch {
    return { success: false, error: QUOTE_TEXTS.readFailed };
  }
  if (!quote) return { success: false, error: QUOTE_TEXTS.notFound };
  const pdfInput = quotePdfInput(quote);
  if (!pdfInput) return { success: false, error: QUOTE_TEXTS.emailDraft };

  const pdf = await renderQuotePdf(pdfInput);
  const content = {
    kind: pdfInput.kind,
    number: pdfInput.number,
    grossTotal: pdfInput.grossTotal,
    paymentDueDate: pdfInput.paymentDueDate,
    validUntil: pdfInput.validUntil,
    issuerName: pdfInput.issuer.name,
  };
  const idempotencyKey = quoteEmailIdempotencyKey(quote.id, recipient, previousSends);

  let sent: EmailStubResult;
  try {
    sent = await sendEmail({
      to: recipient,
      subject: quoteEmailSubject(content),
      html: quoteEmailHtml(content),
      category: 'transactional',
      attachments: [{ filename: quotePdfFilename(pdfInput.kind, pdfInput.number), content: pdf }],
      idempotencyKey,
    });
  } catch (err) {
    // Dwa kliknięcia naraz: Resend odrzuca drugie żądanie z tym samym kluczem (409).
    const message = err instanceof Error ? err.message : '';
    return {
      success: false,
      error: /concurrent_idempotent_requests/.test(message) ? QUOTE_TEXTS.emailInProgress : QUOTE_TEXTS.emailFailed,
    };
  }
  if (!sent.sent) return { success: false, error: sendRefusal(sent) };

  const { data, error } = await rpcClient(supabase).rpc('record_sales_quote_email', {
    p_quote_id: quote.id,
    p_recipient: recipient,
    p_idempotency_key: idempotencyKey,
    p_provider_message_id: sent.messageId ?? null,
  });
  const status = (data as { status?: unknown } | null)?.status;
  if (error || (status !== 'recorded' && status !== 'already_recorded')) {
    return { success: false, error: QUOTE_TEXTS.emailNotRecorded };
  }

  revalidatePath(`/proformy/${quote.id}`);
  return { success: true, recipient };
}

'use server';

import type { SupabaseClient } from '@supabase/supabase-js';
import { revalidatePath } from 'next/cache';

import { lookupBuyerAction } from '@/components/invoices/actions';
import { logAudit } from '@/lib/audit/log';
import { sendEmail, type EmailStubResult } from '@/lib/email/send';
import { todayInWarsaw } from '@/lib/format/warsaw-date';
import { countNoteEmailsTo, counterpartyFromContractor, getNote, notesTable } from '@/lib/noty/baza';
import { normalizeNoteRecipient, noteEmailHtml, noteEmailIdempotencyKey, noteEmailSubject } from '@/lib/noty/mail';
import { canWriteNotes, noteTotal, type NoteContractorOption } from '@/lib/noty/model';
import { notePdfFilename, notePdfInput, renderNotePdf } from '@/lib/noty/pdf';
import { noteDraftSchema, noteIssueDateError, type NoteDraftInput } from '@/lib/noty/schemat';
import { NOTE_TEXTS, noteEmailLimitMessage, noteIssuedLockedMessage } from '@/lib/noty/teksty';
import { checkRateLimit } from '@/lib/rate-limit';
import { ActionAuthError, requireUserAndActiveOrg, type AuthContext } from '@/lib/supabase/auth-context';

/**
 * Noty obciążeniowe i uznaniowe (plan kompletnej aplikacji, krok 2.9,
 * część 1): szkic, wystawienie, usunięcie szkicu i wysyłka mailem.
 *
 * Firma i rola z sesji; zapis i odczyt klientem z sesji, więc te same reguły
 * egzekwuje baza (RLS, granty kolumnowe, wyzwalacz i funkcje 00193). Numer
 * nadaje wyłącznie RPC `issue_accounting_note`. Każdy aktywny członek firmy
 * może to samo co przy fakturze (`canWriteNotes`).
 *
 * Ponowienie od zera (protokół, pkt 5), wysyłka mailem:
 *  1. odczyt noty i liczby zapisanych wysyłek na ten adres: bez skutków;
 *  2. PDF: powtarzalny (ta sama nota, te same bajty);
 *  3. mail z kluczem `nota/<id>/<skrót adresu>/<liczba zapisanych wysyłek>`:
 *     ponowienie po wysyłce bez zapisu historii daje ten sam klucz i tę samą
 *     treść, więc Resend nie wyśle drugi raz (klucz ważny 24 h);
 *  4. zapis historii RPC `record_accounting_note_email`: raz na klucz, audyt
 *     tylko przy nowym wpisie. Świadome „Wyślij ponownie” po zapisanej
 *     wysyłce ma nowy klucz.
 */

type Failure = { success: false; error: string };
export type AddNoteContractorResult = { success: true; contractor: NoteContractorOption } | Failure;
export type SaveNoteDraftResult = { success: true; id: string } | Failure;
export type IssueNoteResult = { success: true; number: string; alreadyIssued: boolean } | Failure;
export type DeleteNoteDraftResult = { success: true } | Failure;
export type SendNoteEmailResult = { success: true; recipient: string } | Failure;

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ile not firma może wysłać mailem w godzinie (jak faktury, AUD-102). */
const NOTE_EMAILS_PER_HOUR = 30;

/** Funkcje 00193 nie są jeszcze w `types/database.ts` (typy z produkcji po wgraniu migracji). */
function rpcClient(supabase: AuthContext['supabase']): SupabaseClient {
  return supabase as unknown as SupabaseClient;
}

async function writerContext(): Promise<{ ok: true; ctx: AuthContext } | { ok: false; error: string }> {
  try {
    const ctx = await requireUserAndActiveOrg();
    if (!canWriteNotes(ctx.role)) return { ok: false, error: NOTE_TEXTS.role };
    return { ok: true, ctx };
  } catch (err) {
    if (err instanceof ActionAuthError) return { ok: false, error: err.message };
    throw err;
  }
}

/** Czemu zapis albo usunięcie nie trafiło w szkic: nota wystawiona (z numerem) albo jej nie ma. */
async function whyNotDraft(supabase: AuthContext['supabase'], tenantId: string, noteId: string): Promise<string> {
  const current = await getNote(supabase, tenantId, noteId).catch(() => null);
  return current?.status === 'issued' ? noteIssuedLockedMessage(current.number) : NOTE_TEXTS.notFound;
}

/**
 * Kontrahent do noty po NIP, gdy nie ma go jeszcze w bazie: ta sama droga co
 * w formularzu faktury (`lookupBuyerAction`: baza kontrahentów firmy, a bez
 * trafienia GUS z zapisem do bazy). Nota dalej bierze kontrahenta wyłącznie
 * z bazy firmy, więc identyfikator czytamy z bazy klientem z sesji.
 */
export async function addNoteContractorAction(nip: string): Promise<AddNoteContractorResult> {
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
  if (error || !data) return { success: false, error: NOTE_TEXTS.contractorAddFailed };
  return { success: true, contractor: { id: data.id, name: data.name, nip: data.nip, email: data.email ?? null } };
}

/**
 * Zapis szkicu: nowy (`noteId` null) albo zmiana istniejącego. Formularz
 * odsyła firmę, dla której go wyrenderowano (UX-01): nota z formularza firmy A
 * nie powstanie w firmie B. Kontrahent wyłącznie z bazy kontrahentów tej
 * firmy; jego dane idą do noty jako migawka.
 */
export async function saveNoteDraftAction(
  input: NoteDraftInput,
  expectedTenantId: string,
  noteId: string | null = null,
): Promise<SaveNoteDraftResult> {
  if (noteId !== null && !UUID_SHAPE.test(noteId)) return { success: false, error: NOTE_TEXTS.notFound };

  let ctx: AuthContext;
  try {
    ctx = await requireUserAndActiveOrg({ expectedTenantId });
  } catch (err) {
    if (err instanceof ActionAuthError) return { success: false, error: err.message };
    throw err;
  }
  if (!canWriteNotes(ctx.role)) return { success: false, error: NOTE_TEXTS.role };

  const parsed = noteDraftSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? NOTE_TEXTS.saveFailed };
  }
  const draft = parsed.data;
  const dateError = noteIssueDateError(draft.issueDate, todayInWarsaw());
  if (dateError) return { success: false, error: dateError };

  const { supabase, tenantId, user } = ctx;
  const { data: contractor, error: contractorError } = await supabase
    .from('contractors')
    .select('id, name, nip, address, email')
    .eq('tenant_id', tenantId)
    .eq('id', draft.contractorId)
    .maybeSingle();
  if (contractorError) return { success: false, error: NOTE_TEXTS.saveFailed };
  if (!contractor) return { success: false, error: NOTE_TEXTS.contractorMissing };
  const counterparty = counterpartyFromContractor(contractor);
  if (!counterparty) return { success: false, error: NOTE_TEXTS.contractorIncomplete };

  const total = noteTotal(draft.items);
  const content = {
    kind: draft.kind,
    issue_date: draft.issueDate,
    title: draft.title,
    items: draft.items,
    total,
    currency: draft.currency,
    contractor_id: contractor.id,
    counterparty,
    related_document: draft.relatedDocument,
    due_date: draft.dueDate,
    bank_account: draft.bankAccount,
  };
  const metadata = { kind: draft.kind, total, itemCount: draft.items.length };

  let id: string;
  if (noteId === null) {
    const { data, error } = await notesTable(supabase).insert({ tenant_id: tenantId, ...content }).select('id').single();
    if (error || !data) {
      // 23503: kontrahent usunięty między odczytem a zapisem (klucz złożony z firmą).
      return { success: false, error: error?.code === '23503' ? NOTE_TEXTS.contractorMissing : NOTE_TEXTS.saveFailed };
    }
    id = (data as { id: string }).id;
    await logAudit({
      action: 'accounting_note.draft_created',
      tenantId,
      userId: user.id,
      entityType: 'accounting_note',
      entityId: id,
      metadata,
    });
  } else {
    // Tylko szkic (RLS i ten filtr): wystawionej noty nie zmienia nikt.
    const { data, error } = await notesTable(supabase)
      .update(content)
      .eq('tenant_id', tenantId)
      .eq('id', noteId)
      .eq('status', 'draft')
      .select('id');
    if (error) {
      return { success: false, error: error.code === '23503' ? NOTE_TEXTS.contractorMissing : NOTE_TEXTS.saveFailed };
    }
    if (!data || data.length === 0) return { success: false, error: await whyNotDraft(supabase, tenantId, noteId) };
    id = noteId;
    await logAudit({
      action: 'accounting_note.draft_updated',
      tenantId,
      userId: user.id,
      entityType: 'accounting_note',
      entityId: id,
      metadata,
    });
  }

  revalidatePath('/noty');
  revalidatePath(`/noty/${id}`);
  return { success: true, id };
}

function issueRefusal(code: unknown): string {
  switch (code) {
    case 'not_found':
      return NOTE_TEXTS.notFound;
    case 'future_date':
      return NOTE_TEXTS.futureDate;
    case 'contractor_missing':
      return NOTE_TEXTS.contractorRemoved;
    case 'issuer_incomplete':
      return NOTE_TEXTS.issuerIncomplete;
    default:
      return NOTE_TEXTS.issueFailed;
  }
}

/**
 * Wystawienie szkicu: numer, dane wystawcy i audyt w jednej transakcji bazy
 * (RPC `issue_accounting_note`). Drugie kliknięcie oddaje ten sam numer.
 */
export async function issueNoteAction(noteId: string): Promise<IssueNoteResult> {
  if (!UUID_SHAPE.test(noteId)) return { success: false, error: NOTE_TEXTS.notFound };
  const auth = await writerContext();
  if (!auth.ok) return { success: false, error: auth.error };

  const { data, error } = await rpcClient(auth.ctx.supabase).rpc('issue_accounting_note', { p_note_id: noteId });
  if (error) {
    return { success: false, error: error.code === '42501' ? NOTE_TEXTS.issueRole : NOTE_TEXTS.issueFailed };
  }
  const result = (data ?? null) as { status?: unknown; number?: unknown; code?: unknown } | null;
  if ((result?.status === 'issued' || result?.status === 'already_issued') && typeof result.number === 'string') {
    revalidatePath('/noty');
    revalidatePath(`/noty/${noteId}`);
    return { success: true, number: result.number, alreadyIssued: result.status === 'already_issued' };
  }
  return { success: false, error: issueRefusal(result?.code) };
}

/** Usunięcie szkicu (bez numeru, więc bez luki w serii). Wystawionej nie usuwa nikt. */
export async function deleteNoteDraftAction(noteId: string): Promise<DeleteNoteDraftResult> {
  if (!UUID_SHAPE.test(noteId)) return { success: false, error: NOTE_TEXTS.notFound };
  const auth = await writerContext();
  if (!auth.ok) return { success: false, error: auth.error };
  const { supabase, tenantId, user } = auth.ctx;

  const { data, error } = await notesTable(supabase)
    .delete()
    .eq('tenant_id', tenantId)
    .eq('id', noteId)
    .eq('status', 'draft')
    .select('id, kind');
  if (error) return { success: false, error: NOTE_TEXTS.deleteFailed };
  if (!data || data.length === 0) return { success: false, error: await whyNotDraft(supabase, tenantId, noteId) };

  await logAudit({
    action: 'accounting_note.draft_deleted',
    tenantId,
    userId: user.id,
    entityType: 'accounting_note',
    entityId: noteId,
    metadata: { kind: (data[0] as { kind?: unknown }).kind ?? null },
  });
  revalidatePath('/noty');
  return { success: true };
}

function sendRefusal(result: EmailStubResult): string {
  if (result.reason === 'not-configured') return NOTE_TEXTS.emailNotConfigured;
  if (result.reason === 'hard_bounce' || result.reason === 'complaint') return NOTE_TEXTS.emailBlocked;
  return NOTE_TEXTS.emailFailed;
}

/** Wysyłka wystawionej noty mailem z PDF do kontrahenta (opis ponowienia w nagłówku pliku). */
export async function sendNoteEmailAction(noteId: string, recipientEmail: string): Promise<SendNoteEmailResult> {
  const recipient = normalizeNoteRecipient(typeof recipientEmail === 'string' ? recipientEmail : '');
  if (!recipient) return { success: false, error: NOTE_TEXTS.emailInvalid };
  if (!UUID_SHAPE.test(noteId)) return { success: false, error: NOTE_TEXTS.notFound };
  const auth = await writerContext();
  if (!auth.ok) return { success: false, error: auth.error };
  const { supabase, tenantId } = auth.ctx;

  // Limit na firmę przed PDF i wysyłką: mail idzie z domeny FaktWay na dowolny adres.
  const quota = await checkRateLimit({
    bucket: 'accounting_note_email',
    identifier: tenantId,
    limit: NOTE_EMAILS_PER_HOUR,
    windowSeconds: 3600,
  });
  if (!quota.allowed) return { success: false, error: noteEmailLimitMessage(NOTE_EMAILS_PER_HOUR) };

  let note;
  let previousSends: number;
  try {
    note = await getNote(supabase, tenantId, noteId);
    if (note?.status === 'issued') previousSends = await countNoteEmailsTo(supabase, tenantId, noteId, recipient);
    else previousSends = 0;
  } catch {
    return { success: false, error: NOTE_TEXTS.readFailed };
  }
  if (!note) return { success: false, error: NOTE_TEXTS.notFound };
  const pdfInput = notePdfInput(note);
  if (!pdfInput) return { success: false, error: NOTE_TEXTS.emailDraft };

  const pdf = await renderNotePdf(pdfInput);
  const content = {
    kind: pdfInput.kind,
    number: pdfInput.number,
    title: pdfInput.title,
    total: pdfInput.total,
    dueDate: pdfInput.dueDate,
    issuerName: pdfInput.issuer.name,
  };
  const idempotencyKey = noteEmailIdempotencyKey(note.id, recipient, previousSends);

  let sent: EmailStubResult;
  try {
    sent = await sendEmail({
      to: recipient,
      subject: noteEmailSubject(content),
      html: noteEmailHtml(content),
      category: 'transactional',
      attachments: [{ filename: notePdfFilename(pdfInput.number), content: pdf }],
      idempotencyKey,
    });
  } catch (err) {
    // Dwa kliknięcia naraz: Resend odrzuca drugie żądanie z tym samym kluczem (409).
    const message = err instanceof Error ? err.message : '';
    return {
      success: false,
      error: /concurrent_idempotent_requests/.test(message) ? NOTE_TEXTS.emailInProgress : NOTE_TEXTS.emailFailed,
    };
  }
  if (!sent.sent) return { success: false, error: sendRefusal(sent) };

  const { data, error } = await rpcClient(supabase).rpc('record_accounting_note_email', {
    p_note_id: note.id,
    p_recipient: recipient,
    p_idempotency_key: idempotencyKey,
    p_provider_message_id: sent.messageId ?? null,
  });
  const status = (data as { status?: unknown } | null)?.status;
  if (error || (status !== 'recorded' && status !== 'already_recorded')) {
    return { success: false, error: NOTE_TEXTS.emailNotRecorded };
  }

  revalidatePath(`/noty/${note.id}`);
  return { success: true, recipient };
}

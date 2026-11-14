import 'server-only';

import { issueDateNotTodayError } from '@/lib/invoices/issue-date';
import { enqueueKsefSubmitAfterDraft, type TokenSessionSendActor } from '@/lib/invoices/ksef-submit-enqueue';
import {
  DUPLICATE_DECISION_TEXTS,
  retiredDraftSendRefusal,
  type DuplicateDecisionSubmissionRow,
} from '@/lib/ksef/duplicate-decision';
import type { createClient } from '@/lib/supabase/server';
import { validateInvoice } from '@/lib/xml/invoice-calculator';
import type { Invoice } from '@/types/invoice';

/**
 * Wysyłka szkicu zwykłej faktury VAT do KSeF (plan aplikacji mobilnej 4.3,
 * etap M8): logika z `sendDraftInvoiceAction` (`components/invoices/draft-actions.ts`),
 * którą woła też trasa `POST /api/mobile/v1/faktury/{id}/wysylka`. Opis zasad
 * (wycofany szkic, tylko zwykła faktura, dzień wysyłki) w nagłówku tamtego pliku.
 *
 * Wołający daje sesję i firmę oraz odświeża widoki strony. Ponowienie jest
 * bezpieczne: kolejkę przejmuje RPC `enqueue_ksef_send` tylko ze stanu `draft`,
 * więc drugie wywołanie dostaje `not_draft` albo odmowę RPC, a nie drugą wysyłkę.
 */

type SessionDb = Awaited<ReturnType<typeof createClient>>;

export interface DraftSendContext {
  supabase: SessionDb;
  userId: string;
  tenantId: string;
  /** Telefon: 2FA i znacznik KSeF z tokenu zamiast z ciasteczek. */
  tokenSession?: TokenSessionSendActor;
}

/** Powód odmowy dla API telefonu; strona pokazuje tylko `error`. */
export type DraftSendRefusal = 'not_found' | 'not_draft' | 'refused';

export type DraftSendResult =
  | { success: true; offline: boolean }
  | { success: false; error: string; reason: DraftSendRefusal };

interface DraftRow {
  id: string;
  ksef_status: string | null;
  direction: string | null;
  invoice_kind: string | null;
  invoice_type: string | null;
  internal_number: string | null;
  fa3_data: unknown;
}

export type NumberTakenRow = Pick<DuplicateDecisionSubmissionRow, 'id' | 'status' | 'original_ksef_number' | 'original_check' | 'completed_at'>;

export const DRAFT_NOT_FOUND = 'Nie znaleziono faktury w tej organizacji.';
export const ONLY_DRAFT_CAN_BE_SENT = 'Do KSeF można wysłać tylko szkic.';

/**
 * Wpisy `number_taken` szkicu (sesja klienta, RLS; same `.eq` — wybór wpisu
 * robi polityka w tym samym porządku co wyzwalacz). `null` = błąd odczytu:
 * „nie wiem” to nie „szkic zwykły” (fail-closed).
 */
export async function readNumberTakenRows(supabase: SessionDb, tenantId: string, invoiceId: string): Promise<NumberTakenRow[] | null> {
  const { data, error } = await supabase
    .from('ksef_submissions')
    // `original_check` z 00144 — typy bazy dogenerujemy z produkcji po wgraniu.
    .select('id, status, original_ksef_number, original_check, completed_at')
    .eq('invoice_id', invoiceId)
    .eq('tenant_id', tenantId)
    .eq('status', 'number_taken');
  if (error) return null;
  return (data ?? []) as unknown as NumberTakenRow[];
}

const refused = (error: string, reason: DraftSendRefusal = 'refused'): DraftSendResult => ({ success: false, error, reason });

export async function sendRegularDraft(ctx: DraftSendContext, invoiceId: string): Promise<DraftSendResult> {
  const { supabase, userId, tenantId } = ctx;

  const { data: row, error } = await supabase
    .from('invoices')
    .select('id, ksef_status, direction, invoice_kind, invoice_type, internal_number, fa3_data')
    .eq('id', invoiceId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error || !row) return refused(DRAFT_NOT_FOUND, 'not_found');

  const draft = row as DraftRow;
  if (draft.ksef_status !== 'draft') return refused(ONLY_DRAFT_CAN_BE_SENT, 'not_draft');
  // Szkic wycofany (wpis number_taken) — przed rodzajem i datą: klient ma
  // usłyszeć, że numer jest zajęty, a nie „wystaw od nowa z dzisiejszą datą”.
  const taken = await readNumberTakenRows(supabase, tenantId, invoiceId);
  if (!taken) return refused(DUPLICATE_DECISION_TEXTS.HISTORY_READ_FAILED);
  const retired = retiredDraftSendRefusal(draft.internal_number, taken);
  if (retired) return refused(retired);

  const kind = draft.invoice_kind ?? 'regular';
  if (draft.direction !== 'outgoing' || kind !== 'regular' || (draft.invoice_type ?? 'VAT') !== 'VAT') {
    return refused('Ze szkicu można wysłać tylko zwykłą fakturę VAT. Korektę, zaliczkę i fakturę końcową usuń i wystaw ponownie.');
  }

  const invoice = draft.fa3_data as Invoice | null;
  if (!invoice || typeof invoice !== 'object' || !Array.isArray(invoice.lines)) {
    return refused('Szkic nie ma kompletnych danych faktury. Usuń go i wystaw fakturę ponownie.');
  }

  // Faktura w KSeF jest wystawiona w dniu przesłania (art. 106na ust. 1, A1).
  // Szkic z inną datą trzeba wystawić od nowa.
  const notToday = issueDateNotTodayError(invoice.issueDate, 'draft');
  if (notToday) return refused(notToday);

  // Ta sama walidacja co w jobie wysyłki — błąd tutaj, zanim faktura
  // trafi do kolejki i wróci jako odrzucona.
  const errors = validateInvoice(invoice);
  if (errors.length > 0) return refused(errors[0]!);

  const { data: tenant } = await supabase
    .from('tenants')
    .select('nip')
    .eq('id', tenantId)
    .maybeSingle();
  const nip = (tenant?.nip as string | null | undefined) ?? invoice.seller?.nip;
  if (!nip) return refused('Brak NIP firmy.');

  // Przejęcie szkicu robi serwer: RPC `enqueue_ksef_send` (warunek `draft`)
  // w jednej transakcji ze zleceniem pg-boss. Podwójne kliknięcie albo druga
  // karta dostają odmowę RPC („już wysyłana”), a sesja klienta nie pisze
  // `ksef_status` (cykl życia faktury, PR 3 — W2).
  const enq = await enqueueKsefSubmitAfterDraft({
    supabase,
    tenantId,
    userId,
    invoiceId,
    nip,
    invoice,
    auditKind: 'regular',
    internalNumberForAudit: invoice.internalNumber,
    ...(ctx.tokenSession ? { tokenSession: ctx.tokenSession } : {}),
  });

  // Kolejka odmówiła (brak certyfikatu, pauza operatora, błąd kolejki) —
  // status nie został zmieniony, faktura jest nadal szkicem.
  if (!enq.ok) return refused(enq.error);
  return { success: true, offline: enq.mode === 'offline_queued' };
}

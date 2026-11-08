'use server';

import { revalidatePath } from 'next/cache';

import { logAudit } from '@/lib/audit/log';
import { issueDateNotTodayError } from '@/lib/invoices/issue-date';
import { enqueueKsefSubmitAfterDraft } from '@/lib/invoices/ksef-submit-enqueue';
import { recurringDb } from '@/lib/invoices/recurring/db';
import { restoreRunDateAfterDraftDelete } from '@/lib/invoices/recurring/issue';
import {
  DUPLICATE_DECISION_TEXTS,
  retiredDraftSendRefusal,
  retiredDraftView,
  type DuplicateDecisionSubmissionRow,
} from '@/lib/ksef/duplicate-decision';
import { ActionAuthError, requireUserAndActiveOrg } from '@/lib/supabase/auth-context';
import { validateInvoice } from '@/lib/xml/invoice-calculator';
import type { Invoice } from '@/types/invoice';

/**
 * Szkic faktury — wysyłka do KSeF i usunięcie (F-001 w raporcie audytu bloku 1).
 *
 * Do 02.10.2026 szkic był ślepą uliczką: kolejkę wysyłki wołały tylko akcje
 * tworzące nowy dokument, a szkicu nie dało się ani wysłać, ani usunąć —
 * jego numer zostawał zajęty (unikat numeru w organizacji), więc klient
 * wystawiał fakturę pod nowym numerem i zostawiał dziurę w serii.
 *
 * Wysyłka obejmuje tylko zwykłe faktury VAT: korekta, zaliczka i faktura
 * końcowa potrzebują danych specjalnych, których szkic nie przechowuje —
 * takie szkice można usunąć i wystawić ponownie.
 *
 * D-A4-1b-3 PR B (decyzje Bartosza 07.10.2026: 2, 3, 9): szkic z wpisem
 * `number_taken` w historii wysyłki — po decyzji klienta przy 440 albo po
 * automatycznym „numer zajęty” i „Wróć do szkicu” — jest WYCOFANY. Nie
 * wysyła się (każdy rodzaj: KSeF odpowiedziałby znowu 440), a zwykła faktura
 * i zaliczka nie usuwają się (numer zostałby podpowiedziany ponownie, a ślad
 * decyzji zniknąłby kaskadą). Korekta i faktura rozliczeniowa zostają
 * usuwalne — to ich wyjście (00133/00135, 00125). Obie akcje czytają historię
 * sesją klienta przed kolejką i przed DELETE; te same odmowy trzymają
 * wyzwalacze 00148 w bazie (wyścig: P0001 z komunikatem dla klienta).
 *
 * Plan Finora E9 (C2/C4): szkic z pozycji cyklicznej (zostaje, gdy kolejka
 * KSeF odmówi po „Wystaw i wyślij”) zajmuje okres, a `next_run_date` jest już
 * przesunięta. Po jego usunięciu cofamy datę o jeden okres —
 * `restoreRunDateAfterDraftDelete`, warunkowo — żeby okres wrócił do „Do
 * wystawienia”, zamiast zniknąć z harmonogramu.
 */

export type DraftActionResult =
  | { success: true; offline?: boolean }
  | { success: false; error: string };

interface DraftRow {
  id: string;
  ksef_status: string | null;
  direction: string | null;
  invoice_kind: string | null;
  invoice_type: string | null;
  internal_number: string | null;
  fa3_data: unknown;
}

const NOT_FOUND = 'Nie znaleziono faktury w tej organizacji.';
const DELETE_FAILED = 'Nie udało się usunąć szkicu. Spróbuj ponownie.';

function authError(err: unknown): DraftActionResult | null {
  return err instanceof ActionAuthError ? { success: false, error: err.message } : null;
}

type SessionClient = Awaited<ReturnType<typeof requireUserAndActiveOrg>>['supabase'];
type NumberTakenRow = Pick<DuplicateDecisionSubmissionRow, 'id' | 'status' | 'original_ksef_number' | 'original_check' | 'completed_at'>;

/** Kody „brak kolumny/tabeli” — przed wgraniem 00154 szkic nie ma powiązania z pozycją. */
const SCHEMA_PENDING = new Set(['42703', 'PGRST204', '42P01', 'PGRST205']);

type RecurringLinkRead =
  | { ok: true; link: { recurringInvoiceId: string; period: string } | null }
  | { ok: false };

/**
 * Powiązanie szkicu z okresem pozycji cyklicznej (00154), sesją klienta (RLS).
 * Osobny odczyt, żeby usuwanie szkiców działało też przed wgraniem 00154.
 * Błąd odczytu (inny niż brak kolumny) → `ok: false`: bez tej wiedzy
 * usunięcie zgubiłoby okres po cichu, więc odmawiamy.
 */
async function readRecurringLink(supabase: SessionClient, tenantId: string, invoiceId: string): Promise<RecurringLinkRead> {
  const { data, error } = await recurringDb(supabase)
    .from('invoices')
    .select('recurring_invoice_id, recurring_period')
    .eq('id', invoiceId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error) return SCHEMA_PENDING.has(error.code ?? '') ? { ok: true, link: null } : { ok: false };
  if (!data?.recurring_invoice_id || !data.recurring_period) return { ok: true, link: null };
  return { ok: true, link: { recurringInvoiceId: data.recurring_invoice_id, period: data.recurring_period } };
}

/**
 * Wpisy `number_taken` szkicu (sesja klienta, RLS; same `.eq` — wybór wpisu
 * robi polityka w tym samym porządku co wyzwalacz). `null` = błąd odczytu:
 * „nie wiem” to nie „szkic zwykły” (fail-closed).
 */
async function readNumberTakenRows(supabase: SessionClient, tenantId: string, invoiceId: string): Promise<NumberTakenRow[] | null> {
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

export async function sendDraftInvoiceAction(invoiceId: string): Promise<DraftActionResult> {
  try {
    const { supabase, user, tenantId } = await requireUserAndActiveOrg();

    const { data: row, error } = await supabase
      .from('invoices')
      .select('id, ksef_status, direction, invoice_kind, invoice_type, internal_number, fa3_data')
      .eq('id', invoiceId)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (error || !row) return { success: false, error: NOT_FOUND };

    const draft = row as DraftRow;
    if (draft.ksef_status !== 'draft') {
      return { success: false, error: 'Do KSeF można wysłać tylko szkic.' };
    }
    // Szkic wycofany (wpis number_taken) — przed rodzajem i datą: klient ma
    // usłyszeć, że numer jest zajęty, a nie „wystaw od nowa z dzisiejszą datą”.
    const taken = await readNumberTakenRows(supabase, tenantId, invoiceId);
    if (!taken) return { success: false, error: DUPLICATE_DECISION_TEXTS.HISTORY_READ_FAILED };
    const retired = retiredDraftSendRefusal(draft.internal_number, taken);
    if (retired) return { success: false, error: retired };

    const kind = draft.invoice_kind ?? 'regular';
    if (draft.direction !== 'outgoing' || kind !== 'regular' || (draft.invoice_type ?? 'VAT') !== 'VAT') {
      return {
        success: false,
        error: 'Ze szkicu można wysłać tylko zwykłą fakturę VAT. Korektę, zaliczkę i fakturę końcową usuń i wystaw ponownie.',
      };
    }

    const invoice = draft.fa3_data as Invoice | null;
    if (!invoice || typeof invoice !== 'object' || !Array.isArray(invoice.lines)) {
      return { success: false, error: 'Szkic nie ma kompletnych danych faktury. Usuń go i wystaw fakturę ponownie.' };
    }

    // Faktura w KSeF jest wystawiona w dniu przesłania (art. 106na ust. 1, A1).
    // Szkic z inną datą trzeba wystawić od nowa.
    const notToday = issueDateNotTodayError(invoice.issueDate, 'draft');
    if (notToday) return { success: false, error: notToday };

    // Ta sama walidacja co w jobie wysyłki — błąd tutaj, zanim faktura
    // trafi do kolejki i wróci jako odrzucona.
    const errors = validateInvoice(invoice);
    if (errors.length > 0) {
      return { success: false, error: errors[0]! };
    }

    const { data: tenant } = await supabase
      .from('tenants')
      .select('nip')
      .eq('id', tenantId)
      .maybeSingle();
    const nip = (tenant?.nip as string | null | undefined) ?? invoice.seller?.nip;
    if (!nip) return { success: false, error: 'Brak NIP firmy.' };

    // Przejęcie szkicu robi serwer: RPC `enqueue_ksef_send` (warunek `draft`)
    // w jednej transakcji ze zleceniem pg-boss. Podwójne kliknięcie albo druga
    // karta dostają odmowę RPC („już wysyłana”), a sesja klienta nie pisze
    // `ksef_status` (cykl życia faktury, PR 3 — W2).
    const enq = await enqueueKsefSubmitAfterDraft({
      supabase,
      tenantId,
      userId: user.id,
      invoiceId,
      nip,
      invoice,
      auditKind: 'regular',
      internalNumberForAudit: invoice.internalNumber,
    });

    if (!enq.ok) {
      // Kolejka odmówiła (brak certyfikatu, pauza operatora, błąd kolejki) —
      // status nie został zmieniony, faktura jest nadal szkicem.
      return { success: false, error: enq.error };
    }

    revalidatePath('/invoices');
    revalidatePath(`/invoices/${invoiceId}`);
    return { success: true, offline: enq.mode === 'offline_queued' };
  } catch (err) {
    return authError(err) ?? { success: false, error: 'Nie udało się wysłać szkicu. Spróbuj ponownie.' };
  }
}

export async function deleteDraftInvoiceAction(invoiceId: string): Promise<DraftActionResult> {
  try {
    const { supabase, user, tenantId } = await requireUserAndActiveOrg();

    // Szkic wycofany zwykłej faktury i zaliczki zostaje (decyzje 2, 3, 9):
    // trzyma numer i ślad decyzji. Korekta i faktura rozliczeniowa — usuwalne.
    const { data: current, error: readError } = await supabase
      .from('invoices')
      .select('id, ksef_status, invoice_kind, internal_number')
      .eq('id', invoiceId)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (readError) return { success: false, error: DUPLICATE_DECISION_TEXTS.HISTORY_READ_FAILED };
    const row = current as Pick<DraftRow, 'id' | 'ksef_status' | 'invoice_kind' | 'internal_number'> | null;
    if (row && row.ksef_status === 'draft') {
      const taken = await readNumberTakenRows(supabase, tenantId, invoiceId);
      if (!taken) return { success: false, error: DUPLICATE_DECISION_TEXTS.HISTORY_READ_FAILED };
      const retired = retiredDraftView({
        invoiceNumber: row.internal_number,
        invoiceKind: row.invoice_kind,
        submissions: taken,
        // Baner nie jest tu potrzebny — tylko `deletable` i `deleteRefusal`, które od blokady rodzaju nie zależą.
        kindHeld: false,
      });
      if (retired && !retired.deletable && retired.deleteRefusal) {
        return { success: false, error: retired.deleteRefusal };
      }
    }

    const recurring: RecurringLinkRead =
      row && row.ksef_status === 'draft' ? await readRecurringLink(supabase, tenantId, invoiceId) : { ok: true, link: null };
    if (!recurring.ok) return { success: false, error: DELETE_FAILED };

    // Pozycje znikają kaskadowo (invoice_line_items ON DELETE CASCADE).
    // Warunek na status w samym zapytaniu: szkic, który właśnie poszedł do
    // kolejki, nie zostanie usunięty.
    const { data: deleted, error } = await supabase
      .from('invoices')
      .delete()
      .eq('id', invoiceId)
      .eq('tenant_id', tenantId)
      .eq('ksef_status', 'draft')
      .select('id, internal_number');
    if (error) {
      // Wyzwalacz 00148 (`c_guard_ksef_retired_draft_delete`) w wyścigu z decyzją:
      // jego komunikat P0001 nazywa dokument i mówi, co zrobić.
      if (error.code === 'P0001' && error.message) return { success: false, error: error.message };
      return { success: false, error: DELETE_FAILED };
    }
    if (!deleted || deleted.length === 0) {
      return { success: false, error: 'Usunąć można tylko szkic, który nie został wysłany do KSeF.' };
    }

    await logAudit({
      action: 'invoice.draft_deleted',
      tenantId,
      userId: user.id,
      entityType: 'invoice',
      entityId: invoiceId,
      metadata: {
        internalNumber: (deleted[0] as { internal_number?: string | null }).internal_number ?? null,
        ...(recurring.link
          ? { recurringInvoiceId: recurring.link.recurringInvoiceId, recurringPeriod: recurring.link.period }
          : {}),
      },
    });

    // Okres szkicu jest już wolny (indeks), więc cofamy harmonogram — tylko
    // gdy poprzedni termin pozycji to ten okres (warunkowy UPDATE). Inaczej
    // (pozycja zmieniona, przesunięta dalej, usunięta) nic nie ruszamy.
    if (recurring.link) {
      const restore = await restoreRunDateAfterDraftDelete(supabase, tenantId, recurring.link);
      if (restore.restored) {
        await logAudit({
          action: 'recurring_invoice.run_date_restored',
          tenantId,
          userId: user.id,
          entityType: 'recurring_invoice',
          entityId: recurring.link.recurringInvoiceId,
          metadata: {
            deletedDraftId: invoiceId,
            recurringPeriod: recurring.link.period,
            fromNextRunDate: restore.fromNextRunDate,
            toNextRunDate: restore.toNextRunDate,
          },
        });
        revalidatePath('/invoices/recurring');
      } else {
        console.warn('[recurring-invoices] restore_skipped', { reason: restore.reason });
      }
    }

    revalidatePath('/invoices');
    return { success: true };
  } catch (err) {
    return authError(err) ?? { success: false, error: DELETE_FAILED };
  }
}

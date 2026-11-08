/**
 * Zapis faktury z pozycji cyklicznej — zajęcie okresu (plan Finora N1,
 * „Idempotencja”).
 *
 * 1. PRZED zapisem `loadRecurringIssueLink` czyta pozycję (klient sesji, RLS)
 *    i liczy okres z jej `next_run_date` w tej chwili. Pozycja wstrzymana,
 *    usunięta albo z innej firmy → odmowa z komunikatem, bez zapisu: faktura
 *    poza harmonogramem nie powstaje bez wiedzy klienta. Okres z formularza
 *    (ten, który klient widział w banerze) musi być równy okresowi z odczytu
 *    — inaczej odmowa: `periodTakenMessage` (za okres z formularza jest już
 *    faktura) albo `RECURRING_CHANGED_MESSAGE` (C3: druga karta, powrót
 *    wstecz w przeglądarce, zmiana pozycji w międzyczasie).
 * 2. INSERT faktury niesie `recurring_invoice_id` i `recurring_period`
 *    (`insertInvoiceAndLines` w components/invoices/actions.ts). Unikalny
 *    indeks `uq_invoices_recurring_period` (00154) przepuszcza najwyżej jedną
 *    fakturę na okres — także przy dwóch równoległych kliknięciach.
 * 3. Po udanym zapisie `advanceRecurringRunDate`: warunkowy UPDATE
 *    `next_run_date = <następna> WHERE id AND tenant_id AND next_run_date =
 *    <stara>`. Błąd nie psuje zapisu faktury — następna próba trafi w 23505.
 * 4. 23505 (dowolny z dwóch indeksów — numer też, bo przy podwójnym kliknięciu
 *    z tym samym numerem Postgres zgłasza pierwszy naruszony): jeśli za ten
 *    okres jest już faktura, komunikat z jej numerem i samonaprawa — ten sam
 *    warunkowy UPDATE co w pkt 3.
 *
 * Ponowienie od zera (AGENTS.md, protokół pkt 5): każdy krok da się powtórzyć.
 * Odczyt pozycji nie ma efektów; INSERT drugi raz za ten sam okres kończy się
 * 23505; UPDATE jest warunkowy, więc drugi raz nie przesunie daty o kolejny
 * okres.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '@/types/database';
import type { RecurringFrequency } from '@/types/recurring-invoice';

import { recurringDb, type InvoiceRecurringColumns } from './db';
import { nextRunDate, previousRunDate, recurringPeriodKey } from './schedule';

type AnyClient = SupabaseClient<Database> | SupabaseClient;

/** Nazwa indeksu z 00154 — po niej odróżniamy zajęty okres od zajętego numeru. */
export const RECURRING_PERIOD_INDEX = 'uq_invoices_recurring_period';

export const RECURRING_PAUSED_MESSAGE =
  'Ta faktura cykliczna jest wstrzymana — wznów ją albo wystaw zwykłą fakturę.';
export const RECURRING_NOT_FOUND_MESSAGE =
  'Nie znaleziono tej faktury cyklicznej — mogła zostać usunięta. Wystaw zwykłą fakturę.';
export const RECURRING_READ_ERROR_MESSAGE =
  'Nie udało się odczytać faktury cyklicznej. Spróbuj ponownie za chwilę.';
export const RECURRING_CHANGED_MESSAGE =
  'Faktura cykliczna zmieniła się od otwarcia formularza — otwórz „Wystaw teraz” ponownie.';
/** Szkic z pozycji — tylko „Wystaw i wyślij” zajmuje okres (C2). */
export const RECURRING_DRAFT_REFUSED_MESSAGE =
  'Fakturę cykliczną wystaw przyciskiem „Wystaw i wyślij do KSeF”.';
/** Dopisek, gdy kolejka KSeF odmówiła, a szkic z okresem został (protokół pkt 4). */
export const RECURRING_DRAFT_LEFT_NOTE =
  'Szkic zajmuje okres faktury cyklicznej — wyślij go do KSeF dziś albo usuń, a okres wróci do „Do wystawienia”.';

/** Powiązanie zapisywanej faktury z okresem pozycji cyklicznej. */
export interface RecurringIssueLink {
  recurringInvoiceId: string;
  /** Klucz okresu do `invoices.recurring_period` (np. `2026-11`). */
  period: string;
  /** `next_run_date` pozycji w chwili odczytu — warunek przesunięcia. */
  runDate: string;
  /** Data po tym okresie. */
  nextRunDate: string;
}

export type RecurringIssueLinkResult =
  | { ok: true; link: RecurringIssueLink }
  | { ok: false; error: string };

interface PostgrestLikeError {
  code?: string;
  message?: string;
  details?: string | null;
}

export async function loadRecurringIssueLink(
  supabase: AnyClient,
  tenantId: string,
  recurringInvoiceId: string,
): Promise<RecurringIssueLinkResult> {
  const { data, error } = await recurringDb(supabase)
    .from('recurring_invoices')
    .select('id, active, next_run_date, frequency, day_of_month')
    .eq('id', recurringInvoiceId)
    .eq('tenant_id', tenantId)
    .maybeSingle();

  if (error) return { ok: false, error: RECURRING_READ_ERROR_MESSAGE };
  if (!data) return { ok: false, error: RECURRING_NOT_FOUND_MESSAGE };
  if (!data.active) return { ok: false, error: RECURRING_PAUSED_MESSAGE };

  const frequency = data.frequency as RecurringFrequency;
  return {
    ok: true,
    link: {
      recurringInvoiceId: data.id,
      period: recurringPeriodKey(data.next_run_date, frequency),
      runDate: data.next_run_date,
      nextRunDate: nextRunDate(data.next_run_date, frequency, data.day_of_month),
    },
  };
}

/**
 * Wiersz INSERT faktury z kolumnami 00154, gdy jest powiązanie; bez niego
 * ten sam zestaw kluczy co przed N1 (żadnych `recurring_*: null`).
 */
export function withRecurringColumns<T extends object>(
  row: T,
  link: RecurringIssueLink | undefined,
): T & Partial<InvoiceRecurringColumns> {
  const extra: Partial<InvoiceRecurringColumns> = link
    ? { recurring_invoice_id: link.recurringInvoiceId, recurring_period: link.period }
    : {};
  return { ...row, ...extra };
}

/** 23505 na indeksie okresu (po nazwie z komunikatu albo z opisu klucza PostgREST). */
export function isRecurringPeriodConflict(error: PostgrestLikeError | null | undefined): boolean {
  if (error?.code !== '23505') return false;
  return (
    (error.message ?? '').includes(RECURRING_PERIOD_INDEX) ||
    (error.details ?? '').includes('recurring_period')
  );
}

export interface InvoiceForPeriod {
  id: string;
  internal_number: string | null;
  ksef_status: string | null;
}

/** Faktura już zapisana za ten okres pozycji (RLS: tylko tej firmy). */
export async function findInvoiceForPeriod(
  supabase: AnyClient,
  tenantId: string,
  link: Pick<RecurringIssueLink, 'recurringInvoiceId' | 'period'>,
): Promise<InvoiceForPeriod | null> {
  const { data, error } = await recurringDb(supabase)
    .from('invoices')
    .select('id, internal_number, ksef_status')
    .eq('tenant_id', tenantId)
    .eq('recurring_invoice_id', link.recurringInvoiceId)
    .eq('recurring_period', link.period)
    .maybeSingle();
  if (error || !data) return null;
  return { id: data.id, internal_number: data.internal_number, ksef_status: data.ksef_status };
}

/**
 * Komunikat dla klienta, gdy za okres jest już faktura. Jeden tekst także dla
 * szkicu: przy dwóch równoległych kliknięciach zwycięzca jest przez chwilę
 * szkicem (zapis przed kolejką KSeF), więc stan nie odróżnia „szkicu
 * porzuconego” od „właśnie wysyłanej”. Numer wystarcza, żeby ją znaleźć.
 */
export function periodTakenMessage(existing: InvoiceForPeriod): string {
  const numer = existing.internal_number?.trim() || 'bez numeru';
  return `Faktura za ten okres jest już wystawiona: ${numer}`;
}

/**
 * Przesuwa `next_run_date` o jeden okres, tylko jeśli pozycja wciąż ma datę
 * z chwili odczytu (`runDate`). Nie rzuca: błąd zapisuje w logu serwera, bo
 * faktura jest już zapisana, a kolejna próba sama przesunie datę po 23505.
 * Zwraca `true`, gdy ten wywołujący przesunął datę.
 */
export async function advanceRecurringRunDate(
  supabase: AnyClient,
  tenantId: string,
  link: RecurringIssueLink,
): Promise<boolean> {
  try {
    const { data, error } = await recurringDb(supabase)
      .from('recurring_invoices')
      .update({ next_run_date: link.nextRunDate })
      .eq('id', link.recurringInvoiceId)
      .eq('tenant_id', tenantId)
      .eq('next_run_date', link.runDate)
      .select('id');
    if (error) {
      console.error('[recurring-invoices] advance_failed', { code: error.code ?? null });
      return false;
    }
    return Array.isArray(data) && data.length > 0;
  } catch {
    console.error('[recurring-invoices] advance_failed');
    return false;
  }
}

export type RestoreRunDateResult =
  | { restored: true; fromNextRunDate: string; toNextRunDate: string }
  | { restored: false; reason: 'read_failed' | 'not_found' | 'period_mismatch' | 'changed' | 'update_failed' };

/**
 * Po usunięciu szkicu, który zajmował okres pozycji (C2/C4): cofa
 * `next_run_date` o jeden okres, ale tylko gdy poprzedni termin to właśnie
 * okres szkicu (`recurringPeriodKey(previousRunDate(bieżąca)) === period`)
 * i tylko warunkowym UPDATE na bieżącej dacie z odczytu. Pozycja zmieniona
 * (inny dzień w tym samym okresie też jest w porządku — liczy się okres),
 * przesunięta dalej albo usunięta → nic nie zmieniamy.
 *
 * Ponowienie: drugi raz po udanym cofnięciu poprzedni termin to już okres
 * wcześniejszy niż szkic → `period_mismatch`, data bez zmian. Nie rzuca.
 */
export async function restoreRunDateAfterDraftDelete(
  supabase: AnyClient,
  tenantId: string,
  draft: Pick<RecurringIssueLink, 'recurringInvoiceId' | 'period'>,
): Promise<RestoreRunDateResult> {
  try {
    const db = recurringDb(supabase);
    const { data, error } = await db
      .from('recurring_invoices')
      .select('id, next_run_date, frequency, day_of_month')
      .eq('id', draft.recurringInvoiceId)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (error) return { restored: false, reason: 'read_failed' };
    if (!data) return { restored: false, reason: 'not_found' };
    const frequency = data.frequency as RecurringFrequency;
    const current = data.next_run_date;
    const previous = previousRunDate(current, frequency, data.day_of_month);
    if (recurringPeriodKey(previous, frequency) !== draft.period) return { restored: false, reason: 'period_mismatch' };

    const { data: updated, error: updateError } = await db
      .from('recurring_invoices')
      .update({ next_run_date: previous })
      .eq('id', data.id)
      .eq('tenant_id', tenantId)
      .eq('next_run_date', current)
      .select('id');
    if (updateError) return { restored: false, reason: 'update_failed' };
    if (!Array.isArray(updated) || updated.length === 0) return { restored: false, reason: 'changed' };
    return { restored: true, fromNextRunDate: current, toNextRunDate: previous };
  } catch {
    return { restored: false, reason: 'update_failed' };
  }
}

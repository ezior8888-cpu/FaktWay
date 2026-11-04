'use server';

import { revalidatePath } from 'next/cache';

import { logAudit } from '@/lib/audit/log';
import { todayInWarsaw } from '@/lib/format/warsaw-date';
import { recurringDb, toRecurringRow } from '@/lib/invoices/recurring/db';
import { getRecurringInvoice, readCoveredThrough } from '@/lib/invoices/recurring/queries';
import { catchUpRunDate, editedRunDate, firstRunDateAfter } from '@/lib/invoices/recurring/schedule';
import { templateRejection } from '@/lib/invoices/recurring/template';
import {
  recurringInvoiceIdSchema,
  recurringInvoiceSchema,
  type RecurringInvoiceFormValues,
} from '@/lib/schemas/recurring-invoice';
import { ActionAuthError, requireUserAndActiveOrg, type AuthContext } from '@/lib/supabase/auth-context';
import type { RecurringInvoiceRow } from '@/types/recurring-invoice';

/**
 * Akcje faktur cyklicznych (plan Finora N1, P6). Klient z sesji (RLS), rola
 * jak przy wystawianiu faktur: każdy aktywny członek firmy
 * (`requireUserAndActiveOrg`, jak `getTenantContext` w
 * components/invoices/actions.ts). Każda zmiana trafia do `audit_logs`.
 *
 * Żadna z tych akcji nie tworzy faktury ani szkicu. Fakturę wystawia
 * człowiek w formularzu `/invoices/new/regular?cykliczna=<id>`.
 */

export type RecurringInvoiceActionResult =
  | { success: true; recurringInvoice: RecurringInvoiceRow }
  | { success: false; error: string };

export type RecurringInvoiceDeleteResult = { success: true } | { success: false; error: string };

const RECURRING_COLUMNS =
  'id, tenant_id, template_invoice_id, name, frequency, day_of_month, next_run_date, active, created_by, created_at, updated_at';

const NOT_FOUND = 'Nie znaleziono tej faktury cyklicznej — mogła zostać usunięta. Odśwież stronę.';
const CHANGED_MEANWHILE = 'Faktura cykliczna zmieniła się w międzyczasie. Odśwież stronę i spróbuj ponownie.';
const SAVE_FAILED = 'Nie udało się zapisać faktury cyklicznej. Spróbuj ponownie za chwilę.';
const DB_PENDING = 'Faktury cykliczne czekają jeszcze na aktualizację bazy danych. Spróbuj ponownie później.';
const TEMPLATE_IN_USE_UNNAMED =
  'Ta faktura jest już wzorem innej faktury cyklicznej — zmień ją na liście faktur cyklicznych.';

/** Indeks z 00154: jedna pozycja na fakturę-wzór w firmie (K2). */
const TEMPLATE_UNIQUE = 'recurring_invoices_template_unique';

function templateInUseMessage(name: string | null): string {
  return name
    ? `Ta faktura jest już wzorem faktury cyklicznej „${name}” — zmień ją na liście faktur cyklicznych.`
    : TEMPLATE_IN_USE_UNNAMED;
}

function isTemplateUniqueConflict(error: { code?: string; message?: string } | null | undefined): boolean {
  return error?.code === '23505' && (error.message ?? '').includes(TEMPLATE_UNIQUE);
}

/**
 * Pozycja tej firmy, która już używa wzoru (poza `exceptId`). `undefined` —
 * błąd odczytu (o duplikacie i tak rozstrzyga indeks unikalny przy zapisie).
 */
async function itemUsingTemplate(
  ctx: AuthContext,
  templateInvoiceId: string,
  exceptId?: string,
): Promise<{ id: string; name: string } | null | undefined> {
  const { data, error } = await recurringDb(ctx.supabase)
    .from('recurring_invoices')
    .select('id, name')
    .eq('tenant_id', ctx.tenantId)
    .eq('template_invoice_id', templateInvoiceId);
  if (error) return undefined;
  return (data ?? []).find((r) => r.id !== exceptId) ?? null;
}

/** Brak tabeli albo kolumny z 00154 (przed wgraniem migracji). */
function isSchemaPending(code: string | undefined): boolean {
  return code === '42P01' || code === 'PGRST205' || code === '42703' || code === 'PGRST204';
}

function saveError(code: string | undefined): string {
  return isSchemaPending(code) ? DB_PENDING : SAVE_FAILED;
}

async function context(): Promise<{ ok: true; ctx: AuthContext } | { ok: false; error: string }> {
  try {
    return { ok: true, ctx: await requireUserAndActiveOrg() };
  } catch (e) {
    if (e instanceof ActionAuthError) return { ok: false, error: e.message };
    throw e;
  }
}

/**
 * Sprawdza fakturę-wzór tej firmy: komunikat po polsku albo data wystawienia
 * wzoru (pierwszy termin nie może wypaść w okresie, który wzór już pokrywa).
 */
async function checkTemplate(
  ctx: AuthContext,
  templateInvoiceId: string,
): Promise<{ ok: true; issueDate: string | null } | { ok: false; error: string }> {
  const { data, error } = await recurringDb(ctx.supabase)
    .from('invoices')
    .select('id, direction, origin, invoice_kind, invoice_type, ksef_status, currency, issue_date')
    .eq('id', templateInvoiceId)
    .eq('tenant_id', ctx.tenantId)
    .maybeSingle();
  if (error) return { ok: false, error: 'Nie udało się sprawdzić faktury-wzoru. Spróbuj ponownie za chwilę.' };
  if (!data) return { ok: false, error: 'Nie znaleziono faktury-wzoru w tej firmie.' };
  const rejected = templateRejection(data);
  return rejected ? { ok: false, error: rejected } : { ok: true, issueDate: data.issue_date ?? null };
}

function revalidate(): void {
  revalidatePath('/invoices/recurring');
  revalidatePath('/invoices');
}

/**
 * Nowa faktura cykliczna z istniejącej faktury. Pierwsze wystawienie:
 * najbliższy dzień `dayOfMonth` od dziś (Europe/Warsaw), którego okres jest
 * późniejszy niż okres faktury-wzoru (`firstRunDateAfter`) — wzór z 20.10
 * nie każe od razu wystawić drugiej faktury za październik (C5, C6).
 *
 * Jedna pozycja na wzór (K2): odczyt przed zapisem daje komunikat z nazwą
 * istniejącej pozycji, a indeks `recurring_invoices_template_unique` (00154)
 * rozstrzyga wyścig dwóch arkuszy.
 *
 * Ponowienie od zera: odczyty bez efektów; drugi INSERT dla tego samego
 * wzoru kończy się odmową „już jest wzorem” (indeks), więc druga pozycja
 * nie powstaje; audyt zapisuje się tylko po udanym INSERT.
 */
export async function createRecurringInvoiceAction(
  input: RecurringInvoiceFormValues,
): Promise<RecurringInvoiceActionResult> {
  const parsed = recurringInvoiceSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? 'Nieprawidłowe dane faktury cyklicznej.' };
  }
  const auth = await context();
  if (!auth.ok) return { success: false, error: auth.error };
  const { ctx } = auth;
  const values = parsed.data;

  const template = await checkTemplate(ctx, values.templateInvoiceId);
  if (!template.ok) return { success: false, error: template.error };
  const existing = await itemUsingTemplate(ctx, values.templateInvoiceId);
  if (existing) return { success: false, error: templateInUseMessage(existing.name) };

  const { data, error } = await recurringDb(ctx.supabase)
    .from('recurring_invoices')
    .insert({
      tenant_id: ctx.tenantId,
      template_invoice_id: values.templateInvoiceId,
      name: values.name,
      frequency: values.frequency,
      day_of_month: values.dayOfMonth,
      next_run_date: firstRunDateAfter(todayInWarsaw(), template.issueDate, values.frequency, values.dayOfMonth),
      active: true,
      created_by: ctx.user.id,
    })
    .select(RECURRING_COLUMNS)
    .single();
  if (isTemplateUniqueConflict(error)) {
    const winner = await itemUsingTemplate(ctx, values.templateInvoiceId);
    return { success: false, error: templateInUseMessage(winner?.name ?? null) };
  }
  if (error || !data) return { success: false, error: saveError(error?.code) };

  await logAudit({
    action: 'recurring_invoice.created',
    tenantId: ctx.tenantId,
    userId: ctx.user.id,
    entityType: 'recurring_invoice',
    entityId: data.id,
    metadata: {
      templateInvoiceId: data.template_invoice_id,
      frequency: data.frequency,
      dayOfMonth: data.day_of_month,
      nextRunDate: data.next_run_date,
    },
  });
  revalidate();
  return { success: true, recurringInvoice: toRecurringRow(data) };
}

/**
 * Edycja: nazwa, częstotliwość, dzień i faktura-wzór — nigdy treść wzoru.
 * Nowa `next_run_date` z `editedRunDate` (ta sama funkcja co podgląd
 * w arkuszu): zmiana samego dnia zostawia miesiąc, ale nie okres pokryty
 * fakturą; zmiana częstotliwości liczy od okresu pokrytego wzorem albo
 * fakturami z tej pozycji (`readCoveredThrough`), więc co miesiąc → co
 * kwartał po fakturze za październik daje styczeń, nie „IV kwartał” (K1).
 * Zapis warunkowy na `next_run_date` z odczytu: jeśli w międzyczasie ktoś
 * wystawił fakturę (data się przesunęła), odmowa zamiast cofnięcia
 * harmonogramu. Ponowienie od zera: drugi UPDATE z tą samą datą z odczytu
 * nie trafi (data już nowa) → „zmieniła się w międzyczasie”, bez szkody.
 */
export async function updateRecurringInvoiceAction(
  id: string,
  input: RecurringInvoiceFormValues,
): Promise<RecurringInvoiceActionResult> {
  const idOk = recurringInvoiceIdSchema.safeParse(id);
  if (!idOk.success) return { success: false, error: NOT_FOUND };
  const parsed = recurringInvoiceSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? 'Nieprawidłowe dane faktury cyklicznej.' };
  }
  const auth = await context();
  if (!auth.ok) return { success: false, error: auth.error };
  const { ctx } = auth;
  const values = parsed.data;

  const current = await getRecurringInvoice(ctx.supabase, ctx.tenantId, idOk.data);
  if (!current) return { success: false, error: NOT_FOUND };

  const templateChanged = values.templateInvoiceId !== current.template_invoice_id;
  if (templateChanged) {
    const template = await checkTemplate(ctx, values.templateInvoiceId);
    if (!template.ok) return { success: false, error: template.error };
    const existing = await itemUsingTemplate(ctx, values.templateInvoiceId, current.id);
    if (existing) return { success: false, error: templateInUseMessage(existing.name) };
  }

  const scheduleChanged =
    values.frequency !== current.frequency || values.dayOfMonth !== current.day_of_month;
  let coveredThrough: string | null = null;
  if (scheduleChanged || templateChanged) {
    // Okres pokryty liczymy z wzoru, który zostaje po zapisie.
    const covered = await readCoveredThrough(ctx.supabase, ctx.tenantId, {
      id: current.id,
      template_invoice_id: values.templateInvoiceId,
    });
    if (!covered.ok) return { success: false, error: SAVE_FAILED };
    coveredThrough = covered.coveredThrough;
  }
  const nextRun = editedRunDate({
    current,
    frequency: values.frequency,
    dayOfMonth: values.dayOfMonth,
    today: todayInWarsaw(),
    coveredThrough,
    templateChanged,
  });

  const { data, error } = await recurringDb(ctx.supabase)
    .from('recurring_invoices')
    .update({
      name: values.name,
      frequency: values.frequency,
      day_of_month: values.dayOfMonth,
      template_invoice_id: values.templateInvoiceId,
      next_run_date: nextRun,
    })
    .eq('id', current.id)
    .eq('tenant_id', ctx.tenantId)
    .eq('next_run_date', current.next_run_date)
    .select(RECURRING_COLUMNS)
    .maybeSingle();
  if (isTemplateUniqueConflict(error)) {
    const winner = await itemUsingTemplate(ctx, values.templateInvoiceId, current.id);
    return { success: false, error: templateInUseMessage(winner?.name ?? null) };
  }
  if (error) return { success: false, error: saveError(error.code) };
  if (!data) return { success: false, error: CHANGED_MEANWHILE };

  await logAudit({
    action: 'recurring_invoice.updated',
    tenantId: ctx.tenantId,
    userId: ctx.user.id,
    entityType: 'recurring_invoice',
    entityId: data.id,
    metadata: {
      from: {
        name: current.name,
        frequency: current.frequency,
        dayOfMonth: current.day_of_month,
        templateInvoiceId: current.template_invoice_id,
        nextRunDate: current.next_run_date,
      },
      to: {
        name: data.name,
        frequency: data.frequency,
        dayOfMonth: data.day_of_month,
        templateInvoiceId: data.template_invoice_id,
        nextRunDate: data.next_run_date,
      },
    },
  });
  revalidate();
  return { success: true, recurringInvoice: toRecurringRow(data) };
}

/** Wstrzymanie: pozycja zostaje, nie przypomina i nie da się z niej wystawić faktury. */
export async function pauseRecurringInvoiceAction(id: string): Promise<RecurringInvoiceActionResult> {
  return setActive(id, false);
}

/**
 * Wznowienie: okresy, które w całości minęły w czasie wstrzymania, pomijamy;
 * ostatni okres, którego dzień już nadszedł, zostaje „Do wystawienia”
 * (`catchUpRunDate`).
 */
export async function resumeRecurringInvoiceAction(id: string): Promise<RecurringInvoiceActionResult> {
  return setActive(id, true);
}

async function setActive(id: string, active: boolean): Promise<RecurringInvoiceActionResult> {
  const idOk = recurringInvoiceIdSchema.safeParse(id);
  if (!idOk.success) return { success: false, error: NOT_FOUND };
  const auth = await context();
  if (!auth.ok) return { success: false, error: auth.error };
  const { ctx } = auth;

  const current = await getRecurringInvoice(ctx.supabase, ctx.tenantId, idOk.data);
  if (!current) return { success: false, error: NOT_FOUND };
  if (current.active === active) return { success: true, recurringInvoice: current };

  const nextRun = active
    ? catchUpRunDate(current.next_run_date, current.frequency, current.day_of_month, todayInWarsaw())
    : current.next_run_date;

  const { data, error } = await recurringDb(ctx.supabase)
    .from('recurring_invoices')
    .update({ active, next_run_date: nextRun })
    .eq('id', current.id)
    .eq('tenant_id', ctx.tenantId)
    .eq('active', current.active)
    .eq('next_run_date', current.next_run_date)
    .select(RECURRING_COLUMNS)
    .maybeSingle();
  if (error) return { success: false, error: saveError(error.code) };
  if (!data) return { success: false, error: CHANGED_MEANWHILE };

  await logAudit({
    action: active ? 'recurring_invoice.resumed' : 'recurring_invoice.paused',
    tenantId: ctx.tenantId,
    userId: ctx.user.id,
    entityType: 'recurring_invoice',
    entityId: data.id,
    metadata: { fromNextRunDate: current.next_run_date, toNextRunDate: data.next_run_date },
  });
  revalidate();
  return { success: true, recurringInvoice: toRecurringRow(data) };
}

/**
 * Usunięcie pozycji. Wystawione z niej faktury zostają bez zmian
 * (00154: `ON DELETE SET NULL (recurring_invoice_id)` zeruje samo powiązanie,
 * okres `recurring_period` zostaje jako ślad).
 */
export async function deleteRecurringInvoiceAction(id: string): Promise<RecurringInvoiceDeleteResult> {
  const idOk = recurringInvoiceIdSchema.safeParse(id);
  if (!idOk.success) return { success: false, error: NOT_FOUND };
  const auth = await context();
  if (!auth.ok) return { success: false, error: auth.error };
  const { ctx } = auth;

  const { data, error } = await recurringDb(ctx.supabase)
    .from('recurring_invoices')
    .delete()
    .eq('id', idOk.data)
    .eq('tenant_id', ctx.tenantId)
    .select('id, name, template_invoice_id');
  if (error) {
    return {
      success: false,
      error: isSchemaPending(error.code) ? DB_PENDING : 'Nie udało się usunąć faktury cyklicznej. Spróbuj ponownie za chwilę.',
    };
  }
  const deleted = data?.[0];
  if (!deleted) return { success: false, error: NOT_FOUND };

  await logAudit({
    action: 'recurring_invoice.deleted',
    tenantId: ctx.tenantId,
    userId: ctx.user.id,
    entityType: 'recurring_invoice',
    entityId: deleted.id,
    metadata: { name: deleted.name, templateInvoiceId: deleted.template_invoice_id },
  });
  revalidate();
  return { success: true };
}

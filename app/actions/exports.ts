'use server';

import { revalidatePath } from 'next/cache';
import { sendJobEvent } from '@/lib/jobs/enqueue';

import {
  exportsCoPilotSendPackage,
  exportsGenerateRequested,
  } from '@/lib/jobs/events';
import { formatJobSendError } from '@/lib/jobs/error-message';
import {
  ActionAuthError,
  requireOrgRole,
  requireUserAndTenant,
} from '@/lib/supabase/auth-context';
import { downloadFromR2 } from '@/lib/storage/r2';
import { exportIncludesFor } from '@/lib/exports/export-scope';
import { isExportFormatSuspended, SUSPENDED_EXPORT_FORMATS } from '@/lib/exports/suspended-formats';
import type { Database } from '@/types/database';

export type ExportFormatParam =
  | 'jpk_fa'
  | 'jpk_v7m'
  | 'kpir_excel'
  | 'comarch_optima'
  | 'insert_subiekt'
  | 'symfonia'
  | 'wapro';

// `jpk_v7m` doszło migracją 00056; `types/database.ts` regenerujemy przed
// Fazą 35, więc lista jest jawna (nie z `export_format_enum`).
const EXPORT_FORMATS: string[] = [
  'jpk_fa',
  'jpk_v7m',
  'kpir_excel',
  'comarch_optima',
  'insert_subiekt',
  'symfonia',
  'wapro',
  'csv_universal',
];

function isExportDbFormat(
  v: string,
): v is Database['public']['Enums']['export_format_enum'] {
  return EXPORT_FORMATS.includes(v);
}

function parsePreferredFormats(formats: string[]) {
  const out = formats.filter(isExportDbFormat).filter((f) => !isExportFormatSuspended(f));
  return [...new Set(out)];
}

function inngestEventIdFromSendResult(result: unknown): string {
  if (
    typeof result === 'object' &&
    result !== null &&
    'ids' in result &&
    Array.isArray((result as { ids: unknown }).ids)
  ) {
    const ids = (result as { ids: unknown[] }).ids;
    const first = ids[0];
    return typeof first === 'string' ? first : '';
  }
  return '';
}

// ============================================================================
// Manual export trigger
// ============================================================================

export async function startExportAction(params: {
  format: ExportFormatParam | 'csv_universal';
  periodStart: string;
  periodEnd: string;
  includeIssued?: boolean;
  includeReceived?: boolean;
  includeCorrections?: boolean;
}): Promise<
  | { success: true; jobId: string }
  | { success: false; error: string }
> {
  let ctx;
  try {
    ctx = await requireUserAndTenant();
  } catch (e) {
    if (e instanceof ActionAuthError) {
      return { success: false, error: e.message };
    }
    throw e;
  }
  const { supabase, user, tenantId } = ctx;

  if (!isExportDbFormat(params.format)) {
    return { success: false, error: 'Nieobsługiwany format eksportu' };
  }
  // Przed zapisem joba: wstrzymany format nie może powstać także z pominięciem
  // interfejsu.
  if (isExportFormatSuspended(params.format)) {
    return { success: false, error: SUSPENDED_EXPORT_FORMATS[params.format]! };
  }

  const startDay = params.periodStart.trim().slice(0, 10);
  const endDay = params.periodEnd.trim().slice(0, 10);
  const dateRx = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRx.test(startDay) || !dateRx.test(endDay)) {
    return { success: false, error: 'Niepoprawny format dat (YYYY-MM-DD)' };
  }
  if (endDay < startDay) {
    return { success: false, error: 'Data końcowa < początkowa' };
  }

  // Zakres z reguły formatu (FIR-01) — nie wprost z tego, co przysłał klient.
  const scope = exportIncludesFor(params.format, params);

  const { data: job, error } = await supabase
    .from('export_jobs')
    .insert({
      tenant_id: tenantId,
      triggered_by: user.id,
      format: params.format,
      trigger_source: 'manual',
      period_start: startDay,
      period_end: endDay,
      include_issued: scope.includeIssued,
      include_received: scope.includeReceived,
      include_corrections: scope.includeCorrections,
      status: 'pending',
    })
    .select('id')
    .single();

  if (error || !job) {
    return { success: false, error: error?.message ?? 'Błąd tworzenia jobu' };
  }

  try {
    await sendJobEvent(
      exportsGenerateRequested.create({ exportJobId: job.id }),
    );
  } catch (e) {
    // Cleanup z `tenant_id` jako defense-in-depth — nawet jeśli RLS by zawiodł,
    // nie usuniemy joba innego tenanta.
    await supabase
      .from('export_jobs')
      .delete()
      .eq('id', job.id)
      .eq('tenant_id', tenantId);
    return { success: false, error: formatJobSendError(e) };
  }

  revalidatePath('/dashboard');
  revalidatePath('/reports/exports');
  return { success: true, jobId: job.id };
}

// ============================================================================
// Pobierz wygenerowany plik
// ============================================================================

type ExportFileJobRel = Pick<
  Database['public']['Tables']['export_jobs']['Row'],
  'status'
>;

export async function downloadExportFileAction(
  fileId: string,
): Promise<
  | { success: true; base64: string; filename: string; mimeType: string }
  | { success: false; error: string }
> {
  let ctx;
  try {
    ctx = await requireUserAndTenant();
  } catch (e) {
    if (e instanceof ActionAuthError) {
      return { success: false, error: e.message };
    }
    throw e;
  }
  const { supabase, user, tenantId } = ctx;

  // `.eq('tenant_id', tenantId)` jako defense-in-depth obok RLS:
  // pojedyncza linia chroni przed pobraniem cudzego pliku, nawet
  // jeśli polityka RLS zostanie kiedyś zmieniona / zawiedzie.
  const { data: fileRow, error: fileErr } = await supabase
    .from('export_files')
    .select(
      `
      *,
      export_jobs(status)
      `,
    )
    .eq('id', fileId)
    .eq('tenant_id', tenantId)
    .maybeSingle();

  if (fileErr || !fileRow) {
    return { success: false, error: 'Plik nie znaleziony' };
  }

  type FileWithJob = Database['public']['Tables']['export_files']['Row'] & {
    export_jobs: ExportFileJobRel | ExportFileJobRel[] | null;
  };
  const file = fileRow as FileWithJob;
  const relation = file.export_jobs;
  const jobStatus =
    Array.isArray(relation) ? relation[0]?.status : relation?.status;

  if (jobStatus !== 'completed') {
    return { success: false, error: 'Plik nie jest gotowy' };
  }

  try {
    const buffer = await downloadFromR2(file.r2_path, tenantId);

    // Atomowy increment przez RPC `increment_export_file_download` (00030).
    //
    // PRZED: read-then-write race — dwa równoległe pobrania odczytywały tę samą
    // wartość download_count i nadpisywały się nawzajem (utracony increment).
    // PO: jedno UPDATE w bazie, atomowe na poziomie wiersza Postgresa.
    // Funkcja sama waliduje `tenant_id = get_current_tenant_id()` w WHERE,
    // więc service-side nie ma jak pomylić tenanta — defense-in-depth.
    const { error: rpcError } = await supabase.rpc(
      'increment_export_file_download',
      { p_file_id: fileId, p_user_id: user.id },
    );
    if (rpcError) {
      // Increment licznika to nie blocker dla samego pobrania — logujemy,
      // ale nie wywalamy responsu klienta (plik jest już w buforze).
      console.error('[downloadExportFileAction] increment failed', rpcError);
    }

    return {
      success: true,
      base64: buffer.toString('base64'),
      filename: file.filename,
      mimeType: file.mime_type,
    };
  } catch {
    return { success: false, error: 'Błąd pobierania z storage' };
  }
}

// ============================================================================
// Co-Pilot settings update
// ============================================================================

export type AccountantSettingsUpsertPayload = Pick<
  Database['public']['Tables']['accountant_settings']['Insert'],
  | 'tenant_id'
  | 'co_pilot_enabled'
  | 'accountant_email'
  | 'accountant_name'
  | 'preferred_formats'
  | 'send_day_of_month'
  | 'include_issued_invoices'
  | 'include_received_invoices'
  | 'include_corrections'
> &
  Partial<
    Pick<
      Database['public']['Tables']['accountant_settings']['Insert'],
      'accountant_company' | 'cc_emails'
    >
  >;

export async function updateAccountantSettingsAction(settings: {
  co_pilot_enabled: boolean;
  accountant_email: string;
  accountant_name: string;
  accountant_company?: string;
  preferred_formats: string[];
  send_day_of_month: number;
  include_issued_invoices: boolean;
  include_received_invoices: boolean;
  include_corrections: boolean;
  cc_emails?: string[];
}): Promise<{ success: true } | { success: false; error: string }> {
  let ctx;
  try {
    ctx = await requireOrgRole(['owner', 'admin']);
  } catch (e) {
    if (e instanceof ActionAuthError) {
      return { success: false, error: e.message };
    }
    throw e;
  }
  const { supabase, tenantId } = ctx;

  if (settings.co_pilot_enabled && !settings.accountant_email?.trim()) {
    return { success: false, error: 'Email księgowego wymagany' };
  }

  const trimmedEmail = settings.accountant_email.trim();
  if (trimmedEmail.length > 0 && !isValidEmail(trimmedEmail)) {
    return { success: false, error: 'Nieprawidłowy email' };
  }

  if (
    settings.send_day_of_month < 1 ||
    settings.send_day_of_month > 28
  ) {
    return {
      success: false,
      error: 'Dzień miesiąca musi być między 1 a 28',
    };
  }

  const parsedFormats = parsePreferredFormats(settings.preferred_formats ?? []);
  if (
    settings.co_pilot_enabled &&
    parsedFormats.length === 0
  ) {
    return {
      success: false,
      error: 'Wybierz co najmniej jeden rozpoznawalny format eksportu',
    };
  }

  const upsertPayload: AccountantSettingsUpsertPayload = {
    tenant_id: tenantId,
    co_pilot_enabled: settings.co_pilot_enabled,
    accountant_email: trimmedEmail.length > 0 ? trimmedEmail : null,
    accountant_name: settings.accountant_name.trim() || null,
    preferred_formats:
      parsedFormats.length > 0 ? parsedFormats : ['jpk_fa', 'kpir_excel'],
    send_day_of_month: settings.send_day_of_month,
    include_issued_invoices: settings.include_issued_invoices,
    include_received_invoices: settings.include_received_invoices,
    include_corrections: settings.include_corrections,
    accountant_company:
      settings.accountant_company?.trim() || undefined,
    cc_emails: settings.cc_emails ?? undefined,
  };

  const { error } = await supabase
    .from('accountant_settings')
    .upsert(pickDefined(upsertPayload), { onConflict: 'tenant_id' });

  if (error) return { success: false, error: error.message };

  revalidatePath('/settings/accountant');
  return { success: true };
}

// ============================================================================
// Manual trigger Co-Pilota (dla teraz)
// ============================================================================

export async function triggerCoPilotNowAction(
  periodMonth: number,
  periodYear: number,
): Promise<{ success: true; jobId: string } | { success: false; error: string }> {
  if (
    !Number.isInteger(periodMonth) ||
    periodMonth < 1 ||
    periodMonth > 12 ||
    !Number.isInteger(periodYear) ||
    periodYear < 1970 ||
    periodYear > 2100
  ) {
    return { success: false, error: 'Niepoprawny okres' };
  }

  let ctx;
  try {
    ctx = await requireOrgRole(['owner', 'admin']);
  } catch (e) {
    if (e instanceof ActionAuthError) {
      return { success: false, error: e.message };
    }
    throw e;
  }
  const { supabase, tenantId } = ctx;

  const periodStart = dateToIsoDate(
    new Date(Date.UTC(periodYear, periodMonth - 1, 1)),
  );
  const periodEnd = dateToIsoDate(new Date(Date.UTC(periodYear, periodMonth, 0)));

  const { data: settings } = await supabase
    .from('accountant_settings')
    .select('*')
    .eq('tenant_id', tenantId)
    .maybeSingle();

  if (!settings?.accountant_email?.trim()) {
    return {
      success: false,
      error: 'Skonfiguruj księgową w Ustawienia → Księgowa',
    };
  }

  if (!settings.co_pilot_enabled) {
    return {
      success: false,
      error: 'Włącz Co-Pilota w ustawieniach księgowej',
    };
  }

  const formats = parsePreferredFormats(settings.preferred_formats ?? []);
  if (formats.length === 0) {
    return {
      success: false,
      error: 'Ustaw co najmniej jeden preferowany format eksportu',
    };
  }

  try {
    const sent = await sendJobEvent(
      exportsCoPilotSendPackage.create({
        tenantId,
        periodStart,
        periodEnd,
        formats,
        accountantEmail: settings.accountant_email.trim(),
        accountantName: settings.accountant_name,
        manual: true,
      }),
    );
    return {
      success: true,
      jobId: inngestEventIdFromSendResult(sent),
    };
  } catch (e) {
    return { success: false, error: formatJobSendError(e) };
  }
}

// ============================================================================
// Helpers
// ============================================================================

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * Usuwa pola z `undefined` zachowując wnioskowanie typów. Zamiast podwójnego
 * castu (`as Record<string, unknown>` → `as TPayload`), generic zwraca
 * `Partial<T>` ze wszystkimi propami z oryginalnego typu — Supabase'owy
 * `.upsert(...)` dostaje akceptowalny shape bez utraty bezpieczeństwa typów.
 *
 * Specjalnie nie używamy `Pick`/`Omit` na kluczach, bo runtime nie wie, które
 * pola są undefined w tym konkretnym wywołaniu — `Partial<T>` to najwęższy
 * typ pasujący do każdej możliwej kombinacji.
 */
function pickDefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== undefined) {
      out[key] = obj[key];
    }
  }
  return out;
}

/** Data w UTC jako YYYY-MM-DD (bez przesunięcia strefy lokalnej). */
function dateToIsoDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

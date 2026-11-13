'use server';

import type { SupabaseClient } from '@supabase/supabase-js';
import { revalidatePath } from 'next/cache';

import { todayInWarsaw } from '@/lib/format/warsaw-date';
import { suggestNextInvoiceNumberForKind } from '@/lib/invoices/next-number';
import { readInvoiceSeries, type InvoiceSeries } from '@/lib/numeracja/baza';
import { nextSeriesNumber } from '@/lib/numeracja/nadanie';
import { seriesRefusalText, SERIES_TEXTS } from '@/lib/numeracja/teksty';
import {
  isInvoiceKind,
  MAX_FIRST_NUMBER,
  MAX_SERIES_NAME_LENGTH,
  patternProblem,
  patternProblemMessage,
  type InvoiceKind,
} from '@/lib/numeracja/wzor';
import { ActionAuthError, requireUserAndActiveOrg, type AuthContext } from '@/lib/supabase/auth-context';

/**
 * Numeracja faktur (plan kompletnej aplikacji, krok 2.5, migracja 00199):
 * podpowiedź numeru w formularzu po zmianie serii albo daty i zarządzanie
 * seriami w ustawieniach.
 *
 * Firma i rola z sesji; zapis wyłącznie przez RPC 00199, które jeszcze raz
 * sprawdzają firmę, rolę (właściciel, administrator) i dane w jednej
 * transakcji z audytem (`invoice_number_series.*`), więc akcja go nie
 * dubluje. Ponowienie: założenie serii drugi raz kończy się odmową „nazwa
 * zajęta”, a zmiana domyślnych i ukrycie są idempotentne (ten sam stan).
 */

type Failure = { success: false; error: string };
export type SeriesListResult = { success: true; series: InvoiceSeries[] } | Failure;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Funkcje 00199 nie są jeszcze w `types/database.ts` (typy z produkcji po wgraniu migracji). */
function rpcClient(supabase: AuthContext['supabase']): SupabaseClient {
  return supabase as unknown as SupabaseClient;
}

async function sessionContext(): Promise<AuthContext | null> {
  try {
    return await requireUserAndActiveOrg();
  } catch (e) {
    if (e instanceof ActionAuthError) return null;
    throw e;
  }
}

/**
 * Podpowiedź numeru serii `seriesId` dla rodzaju `kind` i dnia wystawienia
 * (formularz po zmianie serii albo daty). Tylko odczyt; `null`: bez
 * podpowiedzi (pole zostaje do wpisania ręcznie).
 */
export async function invoiceNumberPreviewAction(
  kind: string,
  seriesId: string,
  issueDate: string,
): Promise<{ preview: string | null } | null> {
  if (!isInvoiceKind(kind) || !UUID.test(seriesId) || !ISO_DAY.test(issueDate)) return null;
  const ctx = await sessionContext();
  if (!ctx) return null;
  const db = rpcClient(ctx.supabase);
  const next = await nextSeriesNumber(db, seriesId, issueDate);
  if (next.ok) return { preview: next.number };
  if (next.code !== 'no_pattern') return { preview: null };
  // Seria „jak dotąd”: kolejny numer po ostatnim dokumencie tego rodzaju w tej serii.
  const preview = await suggestNextInvoiceNumberForKind(db, ctx.tenantId, kind, todayInWarsaw(), { seriesId }).catch(() => null);
  return { preview };
}

async function managerContext(): Promise<{ ok: true; ctx: AuthContext } | { ok: false; error: string }> {
  const ctx = await sessionContext();
  if (!ctx) return { ok: false, error: SERIES_TEXTS.session };
  if (ctx.role !== 'owner' && ctx.role !== 'admin') return { ok: false, error: SERIES_TEXTS.role };
  return { ok: true, ctx };
}

async function freshList(ctx: AuthContext): Promise<SeriesListResult> {
  const series = await readInvoiceSeries(rpcClient(ctx.supabase), todayInWarsaw());
  revalidatePath('/settings');
  return series ? { success: true, series } : { success: false, error: SERIES_TEXTS.unavailable };
}

function rpcStatus(data: unknown): { status: string; code?: string; problem?: string } {
  if (!data || typeof data !== 'object') return { status: 'error' };
  const out = data as Record<string, unknown>;
  return {
    status: typeof out.status === 'string' ? out.status : 'error',
    ...(typeof out.code === 'string' ? { code: out.code } : {}),
    ...(typeof out.problem === 'string' ? { problem: out.problem } : {}),
  };
}

function rpcFailure(error: { code?: string } | null, data: unknown): Failure {
  if (error?.code === '42501') return { success: false, error: SERIES_TEXTS.role };
  if (error) return { success: false, error: SERIES_TEXTS.unavailable };
  const out = rpcStatus(data);
  return { success: false, error: seriesRefusalText(out.code, out.problem) };
}

function kindsOf(input: unknown): InvoiceKind[] | null {
  if (!Array.isArray(input)) return null;
  return input.every(isInvoiceKind) ? [...new Set(input)] : null;
}

export interface CreateSeriesInput {
  name: string;
  pattern: string;
  firstNumber: number;
  defaultKinds: string[];
}

/** Nowa seria (właściciel, administrator); rodzaje z `defaultKinds` przechodzą na nią. */
export async function createInvoiceSeriesAction(input: CreateSeriesInput): Promise<SeriesListResult> {
  const auth = await managerContext();
  if (!auth.ok) return { success: false, error: auth.error };
  const name = typeof input?.name === 'string' ? input.name.trim() : '';
  const pattern = typeof input?.pattern === 'string' ? input.pattern.trim() : '';
  if (name.length < 1 || name.length > MAX_SERIES_NAME_LENGTH) return { success: false, error: SERIES_TEXTS.name };
  const problem = patternProblem(pattern);
  if (problem) return { success: false, error: patternProblemMessage(problem) };
  const firstNumber = Number(input?.firstNumber);
  if (!Number.isInteger(firstNumber) || firstNumber < 1 || firstNumber > MAX_FIRST_NUMBER) {
    return { success: false, error: SERIES_TEXTS.firstNumber };
  }
  const kinds = kindsOf(input?.defaultKinds);
  if (!kinds) return { success: false, error: SERIES_TEXTS.kinds };

  const { data, error } = await rpcClient(auth.ctx.supabase).rpc('invoice_number_series_create', {
    p_name: name,
    p_pattern: pattern,
    p_first_number: firstNumber,
    p_default_kinds: kinds,
  });
  if (error || rpcStatus(data).status !== 'created') return rpcFailure(error, data);
  return freshList(auth.ctx);
}

/** Seria domyślna rodzaju: rodzaj przechodzi na wskazaną serię (z innej serii). */
export async function setDefaultInvoiceSeriesAction(seriesId: string, kind: string): Promise<SeriesListResult> {
  const auth = await managerContext();
  if (!auth.ok) return { success: false, error: auth.error };
  if (!UUID.test(seriesId) || !isInvoiceKind(kind)) return { success: false, error: SERIES_TEXTS.notFound };
  const series = (await readInvoiceSeries(rpcClient(auth.ctx.supabase), todayInWarsaw()))?.find((s) => s.id === seriesId);
  if (!series) return { success: false, error: SERIES_TEXTS.notFound };
  if (series.defaultKinds.includes(kind)) return freshList(auth.ctx);

  const { data, error } = await rpcClient(auth.ctx.supabase).rpc('invoice_number_series_update', {
    p_series_id: seriesId,
    p_name: series.name,
    p_default_kinds: [...series.defaultKinds, kind],
  });
  if (error || rpcStatus(data).status !== 'updated') return rpcFailure(error, data);
  return freshList(auth.ctx);
}

/** Ukrycie (nie jest proponowana i nie nadaje numerów) albo przywrócenie serii. */
export async function setInvoiceSeriesActiveAction(seriesId: string, active: boolean): Promise<SeriesListResult> {
  const auth = await managerContext();
  if (!auth.ok) return { success: false, error: auth.error };
  if (!UUID.test(seriesId) || typeof active !== 'boolean') return { success: false, error: SERIES_TEXTS.notFound };
  const { data, error } = await rpcClient(auth.ctx.supabase).rpc('invoice_number_series_set_active', {
    p_series_id: seriesId,
    p_active: active,
  });
  if (error || rpcStatus(data).status !== 'updated') return rpcFailure(error, data);
  return freshList(auth.ctx);
}

/** Usunięcie serii bez faktur (pomyłka przy zakładaniu). */
export async function deleteInvoiceSeriesAction(seriesId: string): Promise<SeriesListResult> {
  const auth = await managerContext();
  if (!auth.ok) return { success: false, error: auth.error };
  if (!UUID.test(seriesId)) return { success: false, error: SERIES_TEXTS.notFound };
  const { data, error } = await rpcClient(auth.ctx.supabase).rpc('invoice_number_series_delete', { p_series_id: seriesId });
  if (error || rpcStatus(data).status !== 'deleted') return rpcFailure(error, data);
  return freshList(auth.ctx);
}

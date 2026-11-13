/**
 * Serie numeracji faktur w bazie (plan kompletnej aplikacji, krok 2.5,
 * migracja 00199): odczyt serii z kolejnym numerem i podpowiedź numeru dla
 * formularza każdego rodzaju dokumentu.
 *
 * Firma bez serii (każda istniejąca firma po wgraniu 00199, dopóki nie zmieni
 * numeracji) dostaje dokładnie dzisiejszą podpowiedź: kolejny numer po
 * ostatniej fakturze (`suggestNextInvoiceNumberForTenant`), a pozostałe
 * rodzaje kolejny po ostatnim dokumencie tego rodzaju. Błąd odczytu serii
 * (np. przed wgraniem migracji) to ta sama numeracja jak dotąd: podpowiedź
 * nie blokuje formularza, a zapis i tak sprawdza baza.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { suggestNextInvoiceNumberForKind, suggestNextInvoiceNumberForTenant } from '@/lib/invoices/next-number';
import type { InvoiceNumbering, NumberingOption } from '@/lib/numeracja/model';
import { isInvoiceKind, type InvoiceKind } from '@/lib/numeracja/wzor';

export type { InvoiceNumbering, NumberingOption } from '@/lib/numeracja/model';

export interface InvoiceSeries {
  id: string;
  name: string;
  /** `null`: seria podstawowa „jak dotąd” (numer z pola, podpowiedź po ostatniej fakturze). */
  pattern: string | null;
  defaultKinds: InvoiceKind[];
  active: boolean;
  /** Ma choć jedną fakturę (wtedy serię tylko się ukrywa). */
  used: boolean;
  /** Kolejny numer z licznika na dany dzień (seria ze wzorem, aktywna). */
  next: { number: string; counter: number; period: string } | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseNext(value: unknown): InvoiceSeries['next'] {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  return typeof v.number === 'string' && typeof v.counter === 'number' && typeof v.period === 'string'
    ? { number: v.number, counter: v.counter, period: v.period }
    : null;
}

function parseSeries(value: unknown): InvoiceSeries | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || !UUID.test(v.id) || typeof v.name !== 'string') return null;
  return {
    id: v.id,
    name: v.name,
    pattern: typeof v.pattern === 'string' ? v.pattern : null,
    defaultKinds: Array.isArray(v.default_kinds) ? v.default_kinds.filter(isInvoiceKind) : [],
    active: v.active !== false,
    used: v.used === true,
    next: parseNext(v.next),
  };
}

/**
 * Serie aktywnej firmy z kolejnym numerem na dzień `issueDate` (RPC 00199,
 * firma z sesji). `null`: nie udało się odczytać (brak migracji, błąd sieci),
 * wtedy formularz numeruje jak dotąd.
 */
export async function readInvoiceSeries(db: SupabaseClient, issueDate: string): Promise<InvoiceSeries[] | null> {
  try {
    const { data, error } = await db.rpc('invoice_number_series_overview', { p_issue_date: issueDate });
    if (error || !data || typeof data !== 'object') return null;
    const list = (data as { series?: unknown }).series;
    if (!Array.isArray(list)) return null;
    return list.map(parseSeries).filter((s): s is InvoiceSeries => s !== null);
  } catch {
    return null;
  }
}

export const LEGACY_OPTION_NAME = 'Numeracja jak dotąd';


async function legacyPreview(
  db: SupabaseClient,
  tenantId: string,
  kind: InvoiceKind,
  todayIso: string,
  seriesId: string | null,
): Promise<string | null> {
  try {
    if (!seriesId && kind === 'regular') return await suggestNextInvoiceNumberForTenant(db, tenantId, todayIso);
    return await suggestNextInvoiceNumberForKind(db, tenantId, kind, todayIso, seriesId ? { seriesId } : null);
  } catch {
    return null;
  }
}

/**
 * Serie i podpowiedź numeru dla formularza rodzaju `kind`: aktywne serie
 * firmy, wybrana seria domyślna rodzaju, przy serii ze wzorem kolejny numer
 * z licznika, przy serii „jak dotąd” kolejny numer po ostatnim dokumencie.
 */
export async function loadInvoiceNumbering(
  db: SupabaseClient,
  tenantId: string,
  kind: InvoiceKind,
  todayIso: string,
): Promise<InvoiceNumbering> {
  const all = await readInvoiceSeries(db, todayIso);
  if (all === null) {
    // Bez odczytu serii (np. przed wgraniem 00199, błąd sieci): dokładnie jak
    // dotąd, czyli podpowiedź tylko dla zwykłej faktury.
    return {
      kind,
      selectedId: null,
      options: [{
        id: null,
        name: LEGACY_OPTION_NAME,
        pattern: null,
        preview: kind === 'regular' ? await legacyPreview(db, tenantId, kind, todayIso, null) : null,
      }],
    };
  }
  const series = all.filter((s) => s.active);
  if (series.length === 0) {
    return {
      kind,
      selectedId: null,
      options: [{ id: null, name: LEGACY_OPTION_NAME, pattern: null, preview: await legacyPreview(db, tenantId, kind, todayIso, null) }],
    };
  }
  const options = await Promise.all(
    series.map(async (s): Promise<NumberingOption> => ({
      id: s.id,
      name: s.name,
      pattern: s.pattern,
      preview: s.pattern ? s.next?.number ?? null : await legacyPreview(db, tenantId, kind, todayIso, s.id),
    })),
  );
  const selected = series.find((s) => s.defaultKinds.includes(kind)) ?? series[0]!;
  return { kind, options, selectedId: selected.id };
}

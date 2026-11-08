/**
 * Wybór faktury pierwotnej na stronie korekty (F-005 w raporcie audytu
 * bloku 1). Do 17.10.2026 strona brała 50 najnowszych przyjętych faktur
 * i 500 korekt firmy: starszej faktury nie dało się skorygować (formularz
 * po cichu ignorował jej `?parentId`), a przy ponad 500 korektach reguła K4
 * liczyła się na uciętej liście.
 *
 * Teraz:
 * - lista to 50 najnowszych kandydatów, a starsze znajdzie wyszukiwanie
 *   (`searchOrFilter` jak na liście faktur);
 * - `?parentId` spoza listy czytamy osobno i dokładamy, jeśli przyjmie
 *   korektę — a jeśli nie, zwracamy komunikat z numerem faktury
 *   (`correctionParentRefusal`, K4: `openCorrectionMessage`);
 * - korekty czytamy w całości (`readCompletePages`), tylko dla
 *   kandydatów z listy.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { readCompletePages } from '@/lib/accounting/read-complete-pages';
import { searchOrFilter } from '@/lib/invoices/list-query';
import {
  correctionParentRefusal,
  excludeParentsWithOpenCorrection,
  isInFlightCorrectionStatus,
  openCorrectionMessage,
  type CorrectionParentFacts,
  type CorrectionRef,
} from '@/lib/invoices/correction-parents';

/** Ile najnowszych kandydatów pokazuje lista bez wyszukiwania. */
export const CORRECTION_PICKER_SIZE = 50;

export interface CorrectionParentInvoiceRow {
  id: string;
  internal_number: string | null;
  ksef_number: string | null;
  issue_date: string;
  gross_total: number | null;
  buyer_data: unknown;
}

export interface CorrectionPicker {
  parentInvoices: CorrectionParentInvoiceRow[];
  /** Kandydatów jest więcej niż na liście — starsze znajdzie wyszukiwanie. */
  truncated: boolean;
  /** Dlaczego faktura z `?parentId` nie przyjmie korekty; `null` = przyjmie albo brak `parentId`. */
  preselectRefusal: string | null;
}

const PARENT_COLUMNS = 'id, internal_number, ksef_number, issue_date, gross_total, buyer_data';
// Lokalnie, nie `isUuid` z `active-org`: ten moduł importuje formularz
// kliencki (stała, typ wiersza), a `active-org` ciągnie `next/headers`.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface CorrectionOfParent extends CorrectionRef {
  id: string;
  internal_number: string | null;
}

export async function loadCorrectionPicker(
  supabase: SupabaseClient,
  { tenantId, environment, parentId, q }: {
    tenantId: string;
    environment: string;
    parentId?: string;
    q?: string;
  },
): Promise<CorrectionPicker> {
  let candidates = supabase
    .from('invoices')
    .select(PARENT_COLUMNS)
    .eq('tenant_id', tenantId)
    .eq('direction', 'outgoing')
    .eq('ksef_status', 'accepted')
    .eq('invoice_kind', 'regular')
    .eq('ksef_environment', environment)
    .not('ksef_number', 'is', null);
  const search = searchOrFilter(q ?? '');
  if (search) candidates = candidates.or(search);
  // Jeden wiersz ponad listę mówi, czy są starsze.
  const { data, error } = await candidates
    .order('issue_date', { ascending: false })
    .order('id', { ascending: false })
    .limit(CORRECTION_PICKER_SIZE + 1);
  if (error) throw new Error(`Nie można pobrać faktur do korekty: ${error.message}`);
  const rows = (data ?? []) as CorrectionParentInvoiceRow[];
  const parents = rows.slice(0, CORRECTION_PICKER_SIZE);

  const wanted = parentId?.trim() || null;
  let preselectRefusal: string | null = null;
  if (wanted && !parents.some((p) => p.id === wanted)) {
    const target = await readWantedParent(supabase, tenantId, wanted);
    preselectRefusal = correctionParentRefusal(target, environment);
    if (!preselectRefusal && target) {
      const { id, internal_number, ksef_number, issue_date, gross_total, buyer_data } = target;
      parents.push({ id, internal_number, ksef_number, issue_date, gross_total, buyer_data });
    }
  }

  // K4: rodzic z otwartą korektą (każdą poza odrzuconą przez KSeF) nie dostaje
  // drugiej — akcja i wyzwalacz 00133 i tak odmówią, lista nie ma go kusić.
  const corrections = parents.length === 0 ? [] : await readCompletePages<CorrectionOfParent>(
    'Korekty faktur do wyboru',
    (from, to) => supabase
      .from('invoices')
      .select('id, parent_invoice_id, internal_number, ksef_status', { count: 'exact' })
      .eq('tenant_id', tenantId)
      .eq('invoice_kind', 'correction')
      .in('parent_invoice_id', parents.map((p) => p.id))
      .order('id', { ascending: true })
      .range(from, to),
  );

  if (wanted && !preselectRefusal) {
    const open = corrections.find((c) => c.parent_invoice_id === wanted && isInFlightCorrectionStatus(c.ksef_status));
    const parent = parents.find((p) => p.id === wanted);
    if (open && parent) preselectRefusal = openCorrectionMessage(parent.internal_number, open);
  }

  return {
    parentInvoices: excludeParentsWithOpenCorrection(parents, corrections),
    truncated: rows.length > CORRECTION_PICKER_SIZE,
    preselectRefusal,
  };
}

/** Faktura z `?parentId` w tej firmie (RLS i `tenant_id`) albo `null`; o tym, czy przyjmie korektę, decyduje `correctionParentRefusal`. */
async function readWantedParent(
  supabase: SupabaseClient,
  tenantId: string,
  parentId: string,
): Promise<(CorrectionParentInvoiceRow & CorrectionParentFacts) | null> {
  // Zły identyfikator to błąd 22P02 Postgresa, nie „brak faktury”.
  if (!UUID_RE.test(parentId)) return null;
  const { data, error } = await supabase
    .from('invoices')
    .select(`${PARENT_COLUMNS}, direction, invoice_kind, ksef_status, ksef_environment`)
    .eq('id', parentId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error) throw new Error(`Nie można pobrać faktury do korekty: ${error.message}`);
  return (data ?? null) as (CorrectionParentInvoiceRow & CorrectionParentFacts) | null;
}

import { shortCompanyName } from '@/lib/format/company-name';
import {
  LIST_ROW_FACT_COLUMNS,
  loadInvoiceListRowFacts,
  type InvoicePaymentState,
} from '@/lib/invoices/list-row-facts';
import type { PageContext } from '@/lib/supabase/page-context';

/**
 * Karta „Ostatnie faktury” (PLAN-FINORA §5 P1). Ten sam zbiór i ta sama
 * kolejność co domyślna lista `/invoices` bez filtrów
 * (`app/(dashboard)/invoices/page.tsx`): faktury sprzedaży tej firmy ze
 * wszystkich statusów i środowisk (decyzja po E3 nr 1), od najnowszej
 * według `created_at`, potem `id`. Płatność jak w kolumnie listy —
 * `loadInvoiceListRowFacts`, które liczy ją tylko dla faktur z §2.4 pkt 11
 * w aktywnym środowisku; reszta dostaje `null` („—”).
 */

/** Kolumny faktów wiersza listy + to, co pokazuje karta. */
const RECENT_COLUMNS = `${LIST_ROW_FACT_COLUMNS}, internal_number, buyer_data` as const;

export interface RecentInvoice {
  id: string;
  internalNumber: string | null;
  /** Nazwa nabywcy z formą prawną skróconą. */
  buyerName: string | null;
  gross: number;
  currency: string | null;
  paymentDueDate: string | null;
  /** null = faktura spoza §2.4 pkt 11 (szkic, import, korekta…) → „—”. */
  payment: InvoicePaymentState | null;
  ksefStatus: string | null;
}

function buyerNameOf(buyerData: unknown): string | null {
  if (typeof buyerData !== 'object' || buyerData === null || Array.isArray(buyerData)) return null;
  const name = (buyerData as Record<string, unknown>).name;
  return typeof name === 'string' && name.trim() !== '' ? shortCompanyName(name) : null;
}

export async function getRecentInvoices(
  supabase: PageContext['supabase'],
  tenantId: string,
  now: Date = new Date(),
  limit = 5,
): Promise<RecentInvoice[]> {
  const { data, error } = await supabase
    .from('invoices')
    .select(RECENT_COLUMNS)
    .eq('tenant_id', tenantId)
    .eq('direction', 'outgoing')
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(0, limit - 1);
  if (error) throw new Error(`Nie można odczytać ostatnich faktur: ${error.message}`);
  const rows = data ?? [];
  if (rows.length === 0) return [];

  const facts = await loadInvoiceListRowFacts(supabase, tenantId, rows, now);
  return rows.map((row) => {
    const gross = Number(row.gross_total ?? 0);
    return {
      id: row.id,
      internalNumber: row.internal_number,
      buyerName: buyerNameOf(row.buyer_data),
      gross: Number.isFinite(gross) ? gross : 0,
      currency: row.currency,
      paymentDueDate: row.payment_due_date,
      payment: facts.get(row.id)?.payment ?? null,
      ksefStatus: row.ksef_status,
    };
  });
}

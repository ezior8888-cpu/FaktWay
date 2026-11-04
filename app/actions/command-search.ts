'use server';

import { normalizeSearchQuery } from '@/lib/command-palette';
import { contractorSearchFilter } from '@/lib/contractors/edit';
import { formatPlMoney } from '@/lib/format/pl';
import { searchOrFilter } from '@/lib/invoices/list-query';
import { ActionAuthError, requireUserAndActiveOrg } from '@/lib/supabase/auth-context';

export type CommandSearchInvoice = { id: string; number: string; buyer: string; grossLabel: string };
export type CommandSearchContractor = { id: string; name: string; nip: string };

export type CommandSearchResult =
  | { success: true; invoices: CommandSearchInvoice[]; contractors: CommandSearchContractor[] }
  | { success: false; error: string };

const LIMIT = 5;
const DB_ERROR = 'Nie udało się wyszukać. Spróbuj ponownie.';

/**
 * Wyszukiwanie w palecie ⌘K: faktury wystawione i kontrahenci aktywnej
 * organizacji. Klient sesji (RLS) + jawny filtr `tenant_id`.
 */
export async function searchCommandPaletteAction(query: string): Promise<CommandSearchResult> {
  const q = normalizeSearchQuery(typeof query === 'string' ? query : '');
  if (!q) return { success: true, invoices: [], contractors: [] };

  let ctx;
  try {
    ctx = await requireUserAndActiveOrg();
  } catch (e) {
    if (e instanceof ActionAuthError) return { success: false, error: e.message };
    throw e;
  }
  const { supabase, tenantId } = ctx;

  let invoiceQuery = supabase
    .from('invoices')
    .select('id, internal_number, buyer_data, gross_total, currency')
    .eq('tenant_id', tenantId)
    .eq('direction', 'outgoing');
  const invoiceFilter = searchOrFilter(q);
  if (invoiceFilter) invoiceQuery = invoiceQuery.or(invoiceFilter);

  let contractorQuery = supabase.from('contractors').select('id, name, nip').eq('tenant_id', tenantId);
  const contractorFilter = contractorSearchFilter(q);
  if (contractorFilter) contractorQuery = contractorQuery.or(contractorFilter);

  try {
    const [inv, con] = await Promise.all([
      invoiceQuery
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(LIMIT),
      contractorQuery.order('last_used_at', { ascending: false, nullsFirst: false }).limit(LIMIT),
    ]);
    if (inv.error || con.error) return { success: false, error: DB_ERROR };

    const invoices = (inv.data ?? []).map((row) => {
      const buyer = (row.buyer_data as { name?: string } | null)?.name ?? '';
      const gross = row.gross_total === null ? null : Number(row.gross_total);
      // Kwot w różnych walutach nie podpisujemy „zł” (plan Finora §2.4 pkt 6).
      const currency = (row.currency as string | null) ?? 'PLN';
      const unit = currency === 'PLN' ? 'zł' : currency;
      return {
        id: String(row.id),
        number: (row.internal_number as string | null) ?? 'Szkic bez numeru',
        buyer,
        grossLabel: gross !== null && Number.isFinite(gross) ? `${formatPlMoney(gross)} ${unit}` : '',
      };
    });
    const contractors = (con.data ?? []).map((row) => ({
      id: String(row.id),
      name: (row.name as string | null) ?? '',
      nip: (row.nip as string | null) ?? '',
    }));
    return { success: true, invoices, contractors };
  } catch {
    return { success: false, error: DB_ERROR };
  }
}

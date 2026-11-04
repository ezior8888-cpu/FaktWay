import { readCompletePages } from '@/lib/accounting/read-complete-pages';
import { assertAcceptedEnvironmentKnown } from '@/lib/dashboard/monthly-figures';
import type { Receivables } from '@/lib/dashboard/receivables';
import { addDaysToIsoDate, todayInWarsaw } from '@/lib/format/warsaw-date';
import { requireConfiguredKsefEnvironment } from '@/lib/ksef/claim-environment';
import type { PageContext } from '@/lib/supabase/page-context';
import { roundToCents } from '@/lib/xml/invoice-calculator';

/**
 * Kafle i kolumny `/contractors` (P13, PLAN-FINORA §5): Kontrahenci, Aktywni
 * (90 dni), Z zaległościami, Status VAT do sprawdzenia; Należności i Po
 * terminie per kontrahent.
 *
 * Należności i zaległości to WYŁĄCZNIE `getReceivables` (§2.4 pkt 11),
 * rozłożone po NIP nabywcy — tu nie ma drugiego sposobu liczenia. „Aktywni”
 * to faktury przyjęte w aktywnym środowisku KSeF (§2.4 pkt 2), a nie
 * `last_used_at` (to data ostatniego wyszukania w formularzu, nie sprzedaży).
 *
 * Kafle liczą kontrahentów z kartoteki (`contractors`), więc każda liczba
 * jest podzbiorem kafla „Kontrahenci”: nabywca bez NIP albo usunięty
 * z kartoteki nie jest kontrahentem w tym rozumieniu.
 */

/** Okno kafla „Aktywni”: dziś i 89 dni wstecz (90 dni kalendarzowych, Europe/Warsaw). */
export const ACTIVE_WINDOW_DAYS = 90;

/** NIP do porównań: bez spacji i myślników, wielkie litery (NIP UE ma prefiks kraju). */
export function normalizeNip(nip: string | null | undefined): string | null {
  if (typeof nip !== 'string') return null;
  const normalized = nip.replace(/[\s-]/g, '').toUpperCase();
  return normalized === '' ? null : normalized;
}

export interface ContractorReceivables {
  /** Suma `outstanding` otwartych należności kontrahenta, PLN. */
  outstanding: number;
  /** Ile z nich jest po terminie (z daty, nie ze statusu). */
  overdueCount: number;
}

/** `getReceivables().byInvoice` rozłożone po NIP nabywcy. Nabywca bez NIP pominięty. */
export function receivablesByNip(receivables: Pick<Receivables, 'byInvoice'>): Map<string, ContractorReceivables> {
  const byNip = new Map<string, ContractorReceivables>();
  for (const invoice of receivables.byInvoice) {
    const nip = normalizeNip(invoice.buyerNip);
    if (!nip) continue;
    const current = byNip.get(nip) ?? { outstanding: 0, overdueCount: 0 };
    current.outstanding = roundToCents(current.outstanding + invoice.outstanding);
    if (invoice.daysOverdue > 0) current.overdueCount += 1;
    byNip.set(nip, current);
  }
  return byNip;
}

export interface ContractorKey {
  id: string;
  nip: string | null;
}

/** Kafel „Z zaległościami”: kontrahenci z kartoteki z co najmniej jedną fakturą po terminie. */
export function countContractorsWithOverdue(
  contractors: readonly ContractorKey[],
  receivables: Pick<Receivables, 'byInvoice'>,
): number {
  const byNip = receivablesByNip(receivables);
  return countMatching(contractors, (nip) => (byNip.get(nip)?.overdueCount ?? 0) > 0);
}

function countMatching(contractors: readonly ContractorKey[], test: (nip: string) => boolean): number {
  const seen = new Set<string>();
  let count = 0;
  for (const contractor of contractors) {
    const nip = normalizeNip(contractor.nip);
    if (!nip || seen.has(nip)) continue;
    seen.add(nip);
    if (test(nip)) count += 1;
  }
  return count;
}

export interface ContractorVatRow extends ContractorKey {
  vat_status: string | null;
  validation_warning: string | null;
}

/**
 * „Status VAT do sprawdzenia”: niezweryfikowany (brak statusu, `unknown`),
 * wykreślony (`inactive`) albo czynny z ostrzeżeniem walidacji — te same
 * stany, które `VatStatusBadge` pokazuje jako „Niezweryfikowany”,
 * „Wykreślony” i „Wymaga uwagi”.
 */
export function needsVatCheck(row: Pick<ContractorVatRow, 'vat_status' | 'validation_warning'>): boolean {
  if (row.vat_status === 'active') return Boolean(row.validation_warning);
  return row.vat_status !== 'exempt';
}

/** Cała kartoteka (id, NIP, status VAT) — przez `readCompletePages`, bez obcięcia po 1000. */
export async function readContractorKeys(
  supabase: PageContext['supabase'],
  tenantId: string,
): Promise<ContractorVatRow[]> {
  return readCompletePages('Nie można odczytać kontrahentów', (from, to) => supabase
    .from('contractors')
    .select('id, nip, vat_status, validation_warning', { count: 'exact' })
    .eq('tenant_id', tenantId)
    .order('id', { ascending: true })
    .range(from, to));
}

/**
 * Kafel „Aktywni (90 dni)”: kontrahenci z kartoteki, którym w ostatnich 90
 * dniach wystawiono fakturę przyjętą w aktywnym środowisku KSeF (§2.4 pkt 2),
 * po `buyer_nip` (a bez niego `buyer_data.nip`). Przyjęta faktura bez
 * środowiska w tym oknie zatrzymuje kafel (jak `getMonthlyFigures`).
 */
export async function countActiveContractors(
  supabase: PageContext['supabase'],
  tenantId: string,
  contractors: readonly ContractorKey[],
  now: Date = new Date(),
): Promise<number> {
  const environment = requireConfiguredKsefEnvironment();
  const today = todayInWarsaw(now);
  const start = addDaysToIsoDate(today, -(ACTIVE_WINDOW_DAYS - 1))!;
  const endExclusive = addDaysToIsoDate(today, 1)!;
  await assertAcceptedEnvironmentKnown(supabase, tenantId, start, endExclusive);
  const invoices = await readCompletePages('Nie można odczytać faktur kontrahentów', (from, to) => supabase
    .from('invoices')
    .select('id, buyer_nip, buyer_data', { count: 'exact' })
    .eq('tenant_id', tenantId)
    .eq('direction', 'outgoing')
    .eq('ksef_status', 'accepted')
    .eq('ksef_environment', environment)
    .gte('issue_date', start)
    .lt('issue_date', endExclusive)
    .order('id', { ascending: true })
    .range(from, to));
  const activeNips = new Set<string>();
  for (const invoice of invoices) {
    const fromData = typeof invoice.buyer_data === 'object' && invoice.buyer_data !== null && !Array.isArray(invoice.buyer_data)
      ? (invoice.buyer_data as Record<string, unknown>).nip
      : null;
    const nip = normalizeNip(invoice.buyer_nip) ?? normalizeNip(typeof fromData === 'string' ? fromData : null);
    if (nip) activeNips.add(nip);
  }
  return countMatching(contractors, (nip) => activeNips.has(nip));
}

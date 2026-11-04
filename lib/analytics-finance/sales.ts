import { readCompletePages } from '@/lib/accounting/read-complete-pages';
import { assertAcceptedEnvironmentKnown } from '@/lib/dashboard/monthly-figures';
import { assertOutgoingInvoicesInPln } from '@/lib/exports/currency-guard';
import { fetchSettledAdvancesTotals } from '@/lib/invoices/settled-advances';
import { requireConfiguredKsefEnvironment } from '@/lib/ksef/claim-environment';
import type { PageContext } from '@/lib/supabase/page-context';
import { roundToCents } from '@/lib/xml/invoice-calculator';

import { changePct, sumBy } from './breakdown';
import { clientTotals } from './clients';
import type { TrendPoint } from './costs';
import { monthShortLabel } from './months';

/**
 * Analiza sprzedaży `/analizy/sprzedaz` (plan Finora P11, N2).
 *
 * JEDEN odczyt faktur sprzedaży dla wszystkich kart strony, z filtrami 1:1
 * jak `getTopClients` / `getSalesSeries` (§2.4 pkt 2, 4, 5, 6, 7):
 * `direction = 'outgoing'`, `ksef_status = 'accepted'`, środowisko aktywne
 * (przyjęta faktura bez środowiska zatrzymuje kartę), wszystkie rodzaje
 * faktur — korekta to RÓŻNICA w swoim miesiącu, ROZ bez rozliczonych zaliczek
 * (także sprzed okna) — tylko PLN, komplet stron przez `readCompletePages`.
 * Szkice i faktury z innego środowiska nie wchodzą nigdy.
 */

export interface SaleInvoice {
  id: string;
  /** RRRR-MM-DD */
  issueDate: string;
  number: string | null;
  kind: string | null;
  /** Netto do sum: korekta jako różnica, ROZ jako reszta po zaliczkach. */
  net: number;
  /** Brutto dokumentu bez zmian (lista „Ostatnie faktury”). */
  documentGross: number;
  buyer_nip: string | null;
  buyer_data: unknown;
  is_b2c: boolean | null;
  /**
   * N1: skąd faktura (`app` = wystawiona w FaktWay) i jej typ — tylko po to,
   * by „Stali klienci” wiedzieli, która faktura może być wzorem faktury
   * cyklicznej. Opcjonalne: fabryki w testach ich nie podają.
   */
  origin?: string | null;
  invoiceType?: string | null;
}

const SALES_COLUMNS =
  'id, issue_date, internal_number, net_total, gross_total, invoice_kind, advance_invoice_ids, currency, buyer_nip, buyer_data, is_b2c, origin, invoice_type';

function amount(value: number | string | null | undefined): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** Etykieta błędu odczytu faktur sprzedaży (Analizy, karta „Średnia faktura”). */
export const SALES_INVOICES_READ_ERROR = 'Nie można odczytać faktur sprzedaży';

/** Wiersz faktury, z którego `saleInvoicesOf` składa `SaleInvoice`. */
export interface SaleInvoiceRow {
  id: string;
  issue_date: string;
  internal_number?: string | null;
  net_total: number | string | null;
  gross_total: number | string | null;
  invoice_kind?: string | null;
  buyer_nip?: string | null;
  buyer_data: unknown;
  is_b2c?: boolean | null;
  origin?: string | null;
  invoice_type?: string | null;
}

/** Faktury sprzedaży z zakresu `[from, toExclusive)` po `issue_date`, po dacie i id. */
export async function getSalesInvoices(
  supabase: PageContext['supabase'],
  tenantId: string,
  range: { from: string; toExclusive: string },
): Promise<SaleInvoice[]> {
  const environment = requireConfiguredKsefEnvironment();
  await assertAcceptedEnvironmentKnown(supabase, tenantId, range.from, range.toExclusive);
  const rows = await readCompletePages(SALES_INVOICES_READ_ERROR, (start, end) => supabase
    .from('invoices')
    .select(SALES_COLUMNS, { count: 'exact' })
    .eq('tenant_id', tenantId)
    .eq('direction', 'outgoing')
    .eq('ksef_status', 'accepted')
    .eq('ksef_environment', environment)
    .gte('issue_date', range.from)
    .lt('issue_date', range.toExclusive)
    .order('id', { ascending: true })
    .range(start, end));
  assertOutgoingInvoicesInPln(rows);
  if (rows.length === 0) return [];

  const settled = await fetchSettledAdvancesTotals(supabase, tenantId, rows);
  return saleInvoicesOf(rows, settled);
}

/**
 * Wiersze faktur (już po strażnikach środowiska i waluty) jako `SaleInvoice`,
 * ROZ bez rozliczonych zaliczek, po dacie i id. Wspólne dla
 * `getSalesInvoices` i wspólnego odczytu Pulpitu.
 */
export function saleInvoicesOf(
  rows: readonly SaleInvoiceRow[],
  settled: ReadonlyMap<string, { net: number }>,
): SaleInvoice[] {
  return rows
    .map((row): SaleInvoice => ({
      id: row.id,
      issueDate: row.issue_date,
      number: row.internal_number ?? null,
      kind: row.invoice_kind ?? null,
      net: amount(row.net_total) - (settled.get(row.id)?.net ?? 0),
      documentGross: amount(row.gross_total),
      buyer_nip: row.buyer_nip ?? null,
      buyer_data: row.buyer_data,
      is_b2c: row.is_b2c ?? null,
      origin: row.origin ?? null,
      invoiceType: row.invoice_type ?? null,
    }))
    .sort((a, b) => a.issueDate.localeCompare(b.issueDate) || a.id.localeCompare(b.id));
}

const inMonth = (inv: SaleInvoice, monthKey: string) => inv.issueDate.slice(0, 7) === monthKey;

function sumNet(invoices: readonly SaleInvoice[]): number {
  return roundToCents(invoices.reduce((total, inv) => total + inv.net, 0)) || 0;
}

/** Netto miesiąca — „Przychody” w karcie „Przychody a koszty”. */
export function salesOfMonth(invoices: readonly SaleInvoice[], monthKey: string): number {
  return sumNet(invoices.filter((inv) => inMonth(inv, monthKey)));
}

export interface SalesMonthStats {
  /** Netto miesiąca. */
  total: number;
  /** Faktury miesiąca bez korekt (korekta nie jest nową sprzedażą). */
  invoiceCount: number;
  /** `total / invoiceCount`; `null` bez faktur. */
  avgPerInvoice: number | null;
  changePct: number | null;
  /** Klient z największym netto miesiąca; `null` bez sprzedaży. */
  bestClient: string | null;
}

export function salesMonthStats(
  invoices: readonly SaleInvoice[],
  monthKey: string,
  prevMonthKey: string,
): SalesMonthStats {
  const current = invoices.filter((inv) => inMonth(inv, monthKey));
  const total = sumNet(current);
  const invoiceCount = current.filter((inv) => inv.kind !== 'correction').length;
  const best = clientTotals(current)[0];
  return {
    total,
    invoiceCount,
    avgPerInvoice: invoiceCount > 0 ? roundToCents(total / invoiceCount) || 0 : null,
    changePct: changePct(total, salesOfMonth(invoices, prevMonthKey)),
    bestClient: best?.name ?? null,
  };
}

/** Netto per miesiąc z `monthKeys` (Finora „Spend Trend”). */
export function salesTrend(invoices: readonly SaleInvoice[], monthKeys: readonly string[]): TrendPoint[] {
  const byMonth = sumBy(invoices, (inv) => inv.issueDate.slice(0, 7), (inv) => inv.net);
  return monthKeys.map((key) => ({ key, label: monthShortLabel(key), amount: byMonth.get(key) ?? 0 }));
}

export interface RecentSale {
  id: string;
  date: string;
  name: string;
  number: string | null;
  /** `invoice_kind` — korekta dostaje podpis „Korekta” na liście. */
  kind: string | null;
  /** Brutto dokumentu (korekta: różnica, może być ujemna). */
  amount: number;
}

/** Najnowsze faktury miesiąca (data, potem id malejąco). */
export function recentSales(
  invoices: readonly SaleInvoice[],
  monthKey: string,
  nameOf: (inv: SaleInvoice) => string,
  limit = 5,
): RecentSale[] {
  return invoices
    .filter((inv) => inMonth(inv, monthKey))
    .slice()
    .sort((a, b) => b.issueDate.localeCompare(a.issueDate) || b.id.localeCompare(a.id))
    .slice(0, limit)
    .map((inv) => ({
      id: inv.id,
      date: inv.issueDate,
      name: nameOf(inv),
      number: inv.number,
      kind: inv.kind,
      amount: inv.documentGross,
    }));
}

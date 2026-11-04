/**
 * Część KPiR bez zapytań — typy wierszy i sumy kolumn. Osobny moduł, bo
 * używa go komponent kliencki `KpirView`, a `kpir-data.ts` ciągnie kod
 * serwerowy (środowisko KSeF, `next/headers`); webpack nie zbuduje takiego
 * importu w komponencie klienckim.
 */
import { kpirCostAmount } from '@/lib/categorization/kpir-cost';
import { kpirRevenueNet } from '@/lib/categorization/kpir-revenue';
import type { Database } from '@/types/database';

export type KpirExpenseRow = Database['public']['Tables']['expenses']['Row'];

export type KpirInvoiceRow = Pick<
  Database['public']['Tables']['invoices']['Row'],
  'id' | 'internal_number' | 'issue_date' | 'sale_date' | 'gross_total' | 'net_total' | 'buyer_data' | 'invoice_kind'
> & {
  /** ROZ: suma netto zaliczek, które KPiR już liczy (`fetchSettledAdvancesNet`). */
  settled_advances_net?: number | null;
};

/** Przychód KPiR jednej faktury (ROZ: reszta ponad zaliczki). */
export function kpirInvoiceRevenue(inv: KpirInvoiceRow): number {
  return kpirRevenueNet({
    kind: inv.invoice_kind,
    net: inv.net_total,
    settledAdvancesNet: inv.settled_advances_net,
  });
}

export interface KpirTotals {
  col_7: number;
  col_8: number;
  col_10: number;
  col_11: number;
  col_12: number;
  col_13: number;
  col_15: number;
  totalRevenue: number;
  /** Razem kol. 14 (kol. 10–13 + 15). */
  totalExpenses: number;
  profit: number;
}

/** Sumy kolumn KPiR okresu — ta sama reguła co dotąd w `KpirView`. */
export function kpirTotals(expenses: readonly KpirExpenseRow[], invoices: readonly KpirInvoiceRow[]): KpirTotals {
  const column = (col: string) => expenses
    .filter((e) => e.kpir_column === col)
    .reduce((s, e) => s + kpirCostAmount(e), 0);
  const sums = {
    col_7: invoices.reduce((s, i) => s + kpirInvoiceRevenue(i), 0),
    col_8: 0,
    col_10: column('col_10'),
    col_11: column('col_11'),
    col_12: column('col_12'),
    col_13: column('col_13'),
    col_15: column('col_15'),
  };
  const totalRevenue = sums.col_7 + sums.col_8;
  const totalExpenses = sums.col_10 + sums.col_11 + sums.col_12 + sums.col_13 + sums.col_15;
  return { ...sums, totalRevenue, totalExpenses, profit: totalRevenue - totalExpenses };
}

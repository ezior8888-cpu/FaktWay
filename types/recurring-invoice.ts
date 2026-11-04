/**
 * Faktury cykliczne (plan Finora N1, migracja 00154).
 *
 * Pozycja cykliczna tylko przypomina i wypełnia formularz z faktury-wzoru —
 * fakturę wystawia zawsze człowiek. Stan „Do wystawienia” nie jest zapisany
 * w bazie; liczy go `statusOf` z `lib/invoices/recurring/schedule.ts`.
 */

export const RECURRING_FREQUENCIES = ['monthly', 'quarterly', 'yearly'] as const;

export type RecurringFrequency = (typeof RECURRING_FREQUENCIES)[number];

/** `paused` — wstrzymana; `due` — aktywna i `next_run_date <= dziś` (Europe/Warsaw); `active` — czeka na swój dzień. */
export type RecurringStatus = 'active' | 'paused' | 'due';

/** Wiersz `public.recurring_invoices` (kolumny z 00154). */
export interface RecurringInvoiceRow {
  id: string;
  tenant_id: string;
  template_invoice_id: string;
  name: string;
  frequency: RecurringFrequency;
  /** 1–28. */
  day_of_month: number;
  /** RRRR-MM-DD. */
  next_run_date: string;
  active: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/** Podpisy w interfejsie (§6 słownika planu Finora). */
export const RECURRING_FREQUENCY_LABELS: Record<RecurringFrequency, string> = {
  monthly: 'Co miesiąc',
  quarterly: 'Co kwartał',
  yearly: 'Co rok',
};

export const RECURRING_STATUS_LABELS: Record<RecurringStatus, string> = {
  active: 'Aktywna',
  paused: 'Wstrzymana',
  due: 'Do wystawienia',
};

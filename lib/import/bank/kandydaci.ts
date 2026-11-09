import { readCompletePages } from '@/lib/accounting/read-complete-pages';
import { outstandingOf } from '@/lib/invoices/amount-due';

import type { MatchCandidate } from './dopasowanie';

/**
 * Niezapłacone faktury sprzedaży aktywnej firmy jako kandydaci do dopasowania
 * wpływów z wyciągu (krok 3.2). Te same warunki co zapis wpłaty
 * (`record_invoice_payment`, 00176): sprzedaż przyjęta w KSeF w tym środowisku,
 * w złotych, bez daty zapłaty z FA(3), z resztą do zapłaty większą od zera
 * (`outstandingOf`: ROZ płaci resztę po zaliczkach). Odczyt klientem sesji
 * (RLS), w całości albo błąd (`readCompletePages`): niepełna lista dałaby
 * fałszywe „brak propozycji” albo złą propozycję przy kilku fakturach na tę
 * samą kwotę.
 */

export interface BankInvoiceOption extends MatchCandidate {
  issueDate: string | null;
  dueDate: string | null;
}

interface InvoiceRow {
  id: string;
  internal_number: string | null;
  ksef_number: string | null;
  gross_total: number | string | null;
  paid_amount: number | string | null;
  invoice_kind: string | null;
  payment_data: unknown;
  currency: string | null;
  buyer_data: unknown;
  issue_date: string | null;
  payment_due_date: string | null;
  fa3_paid_date: string | null;
}

type Page = { data: InvoiceRow[] | null; count: number | null; error: { message: string } | null };

/** Wąski kształt klienta: zapytanie z aliasem kolumny JSON (jak w `lib/dashboard/inflows.ts`). */
interface InvoiceQuery {
  from(table: 'invoices'): {
    select(columns: string, options: { count: 'exact' }): {
      eq(column: string, value: string): InvoiceFilter;
    };
  };
}
interface InvoiceFilter {
  eq(column: string, value: string): InvoiceFilter;
  in(column: string, values: string[]): InvoiceFilter;
  order(column: string, options: { ascending: boolean }): InvoiceFilter;
  range(from: number, to: number): PromiseLike<Page>;
}

const COLUMNS =
  'id, internal_number, ksef_number, gross_total, paid_amount, invoice_kind, payment_data, currency, buyer_data, issue_date, payment_due_date, fa3_paid_date:fa3_data->parsed->>paidDate';

function buyerName(data: unknown): string | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const name = (data as Record<string, unknown>).name;
  return typeof name === 'string' && name.trim() !== '' ? name.trim() : null;
}

export function toBankInvoiceOption(row: InvoiceRow): BankInvoiceOption | null {
  if (row.currency !== null && row.currency.trim().toUpperCase() !== 'PLN') return null;
  if (typeof row.fa3_paid_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.fa3_paid_date)) return null;
  // `outstandingOf` zwraca złote z groszami (`roundToCents`), więc mnożenie daje całe grosze.
  const outstandingGrosze = Math.round(outstandingOf(row) * 100);
  if (!Number.isSafeInteger(outstandingGrosze) || outstandingGrosze <= 0) return null;
  return {
    id: row.id,
    number: row.internal_number,
    ksefNumber: row.ksef_number,
    outstandingGrosze,
    buyerName: buyerName(row.buyer_data),
    issueDate: row.issue_date,
    dueDate: row.payment_due_date,
  };
}

export async function loadOpenSalesInvoices(client: unknown, tenantId: string, environment: string): Promise<BankInvoiceOption[]> {
  const supabase = client as InvoiceQuery;
  const rows = await readCompletePages<InvoiceRow>('Faktury do dopasowania wpłat', (from, to) =>
    supabase
      .from('invoices')
      .select(COLUMNS, { count: 'exact' })
      .eq('tenant_id', tenantId)
      .eq('direction', 'outgoing')
      .eq('ksef_status', 'accepted')
      .eq('ksef_environment', environment)
      .in('payment_status', ['unpaid', 'overdue', 'partial'])
      .order('id', { ascending: true })
      .range(from, to),
  );
  return rows.map(toBankInvoiceOption).filter((option): option is BankInvoiceOption => option !== null);
}

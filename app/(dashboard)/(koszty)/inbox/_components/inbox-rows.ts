import type { PageContext } from '@/lib/supabase/page-context';

/**
 * Wiersze Skrzynki KSeF (P9) — dane bez JSX, wspólne dla tabeli od `lg`
 * i kart na telefonie. Sprzedawca jak dotąd: `seller_data`, potem
 * `fa3_data.seller`, potem kolumna `seller_nip`.
 *
 * Status „Nowa / Opisana” to `is_reviewed` wydatku powiązanego z fakturą
 * (`expenses.ksef_invoice_id`, jedna faktura = jeden koszt, 00121). Faktura
 * bez wydatku (kategoryzacja jeszcze trwa) ma status `null` i „—”.
 *
 * Decyzja Bartosza 22.10.2026: zakupy z historii KSeF (`origin =
 * 'ksef_import'`, synchronizacja historii) to archiwum — nie tworzymy z nich
 * kosztów. Taki wiersz bez wydatku dostaje plakietkę „Historia z KSeF”
 * zamiast „—”, żeby nie wyglądał na koszt, który „jeszcze powstaje”.
 */

export const INBOX_COLUMNS =
  'id, internal_number, ksef_number, issue_date, seller_nip, seller_data, fa3_data, gross_total, currency, ksef_accepted_at, origin';

export type InboxInvoiceRow = {
  id: string;
  internal_number: string | null;
  ksef_number: string | null;
  issue_date: string | null;
  seller_nip: string | null;
  seller_data: unknown;
  fa3_data: unknown;
  gross_total: string | number | null;
  currency: string | null;
  ksef_accepted_at: string | null;
  origin: string | null;
};

export type InboxStatus = 'new' | 'reviewed';

export const INBOX_STATUS_LABELS: Record<InboxStatus, string> = {
  new: 'Nowa',
  reviewed: 'Opisana',
};

export type InboxRow = {
  id: string;
  number: string | null;
  ksefNumber: string | null;
  issueDate: string | null;
  acceptedAt: string | null;
  sellerName: string;
  sellerNip: string;
  gross: number;
  currency: string;
  /** Wydatek powiązany z fakturą (`/expenses/[id]`), gdy już powstał. */
  expenseId: string | null;
  status: InboxStatus | null;
  /** Faktura z historii KSeF (archiwum, bez kosztu) — decyzja Bartosza 22.10.2026. */
  fromKsefHistory: boolean;
};

export function sellerDisplay(row: Pick<InboxInvoiceRow, 'seller_data' | 'fa3_data' | 'seller_nip'>): { name: string; nip: string } {
  const sd = row.seller_data as { name?: string; nip?: string } | null;
  const fa3 = row.fa3_data as { seller?: { name?: string; nip?: string } } | null;
  const name = sd?.name?.trim() || fa3?.seller?.name?.trim() || '—';
  const nip = sd?.nip?.trim() || fa3?.seller?.nip?.trim() || row.seller_nip?.trim() || '—';
  return { name, nip };
}

export type ExpenseLink = { id: string; ksef_invoice_id: string | null; is_reviewed: boolean };

export function buildInboxRows(
  invoices: readonly InboxInvoiceRow[],
  expenses: readonly ExpenseLink[] | null,
): InboxRow[] {
  const byInvoice = new Map<string, ExpenseLink>();
  for (const expense of expenses ?? []) {
    if (expense.ksef_invoice_id && !byInvoice.has(expense.ksef_invoice_id)) byInvoice.set(expense.ksef_invoice_id, expense);
  }
  return invoices.map((invoice) => {
    const seller = sellerDisplay(invoice);
    const expense = byInvoice.get(invoice.id) ?? null;
    return {
      id: invoice.id,
      number: invoice.internal_number?.trim() || null,
      ksefNumber: invoice.ksef_number,
      issueDate: invoice.issue_date,
      acceptedAt: invoice.ksef_accepted_at,
      sellerName: seller.name,
      sellerNip: seller.nip,
      gross: Number(invoice.gross_total ?? 0),
      currency: invoice.currency?.trim() || 'PLN',
      expenseId: expense?.id ?? null,
      status: expenses === null || !expense ? null : expense.is_reviewed ? 'reviewed' : 'new',
      fromKsefHistory: invoice.origin === 'ksef_import',
    };
  });
}

/** Kawałki listy id do filtra `in` — adres zapytania PostgREST-a ma limit długości. */
const ID_CHUNK = 100;

/**
 * Wydatki powiązane z fakturami ze strony (≤ 200 id, po 100 w zapytaniu).
 * Błąd odczytu → `null`: tabela zostaje, status pokazuje „—”.
 */
export async function loadInboxExpenseLinks(
  supabase: PageContext['supabase'],
  tenantId: string,
  invoiceIds: readonly string[],
): Promise<ExpenseLink[] | null> {
  const links: ExpenseLink[] = [];
  for (let i = 0; i < invoiceIds.length; i += ID_CHUNK) {
    const { data, error } = await supabase
      .from('expenses')
      .select('id, ksef_invoice_id, is_reviewed')
      .eq('tenant_id', tenantId)
      .in('ksef_invoice_id', invoiceIds.slice(i, i + ID_CHUNK));
    if (error) {
      console.error('[inbox] odczyt wydatków powiązanych z fakturami', error);
      return null;
    }
    links.push(...((data ?? []) as ExpenseLink[]));
  }
  return links;
}

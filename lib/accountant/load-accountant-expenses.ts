import 'server-only';

import { expenseFileKind, type ExpenseFileKind, type LinkedInvoiceFile } from '@/lib/accountant/expense-file';
import {
  portalPage,
  publicPortalAccess,
  recordPortalVisit,
  resolvePortalAccess,
  type PortalAccess,
  type PortalPage,
} from '@/lib/accountant/portal-access';
import { expenseAmountsCurrency } from '@/lib/expenses/amount-currency';
import { monthRange, parseExpenseMonth } from '@/lib/expenses/month';
import { createAdminClient } from '@/lib/supabase/server';
import type { Json } from '@/types/database';

/** Wiersz listy kosztów w portalu: bez ścieżek magazynu, plik tylko jako rodzaj. */
export interface AccountantExpenseRow {
  id: string;
  issue_date: string;
  seller_name: string;
  seller_nip: string | null;
  document_type: string;
  document_number: string | null;
  /** Numer KSeF faktury zakupu, z której powstał koszt (tylko faktura tej firmy). */
  ksef_number: string | null;
  net_amount: number;
  vat_amount: number;
  gross_amount: number;
  /**
   * Waluta kwot: `'PLN'`, kod waluty obcej (koszt bez przeliczenia na złote)
   * albo `null`, gdy nie wiadomo (`expenseAmountsCurrency`). Tylko `'PLN'` to „zł”.
   */
  amount_currency: string | null;
  kpir_column: string | null;
  is_reviewed: boolean;
  /** `null`: koszt bez pliku w FaktWay (np. wpisany bez zdjęcia albo XML nie dotarł z KSeF). */
  file_kind: ExpenseFileKind | null;
}

export type AccountantExpensesList =
  | { status: 'ok'; rows: AccountantExpenseRow[]; page: PortalPage }
  | { status: 'error' };

export interface AccountantExpensesData {
  access: PortalAccess;
  tenant: { name: string; nip: string };
  /** Miesiąc listy RRRR-MM (zły albo przyszły z adresu to bieżący). */
  month: string;
  expenses: AccountantExpensesList;
}

const EXPENSE_COLUMNS =
  'id, issue_date, seller_name, seller_nip, document_type, document_number, net_amount, vat_amount, gross_amount, ' +
  'kpir_column, is_reviewed, is_deductible, source, source_file_path, source_file_mime, ksef_invoice_id, ocr_extracted_data';

interface ExpenseDbRow {
  id: string;
  issue_date: string;
  seller_name: string;
  seller_nip: string | null;
  document_type: string;
  document_number: string | null;
  net_amount: number | string;
  vat_amount: number | string;
  gross_amount: number | string;
  kpir_column: string | null;
  is_reviewed: boolean;
  is_deductible: boolean | null;
  source: string;
  source_file_path: string | null;
  source_file_mime: string | null;
  ksef_invoice_id: string | null;
  /** Ślad odczytu i kursu: tylko do ustalenia waluty kwot, nie trafia do widoku. */
  ocr_extracted_data: Json | null;
}

interface LinkedInvoiceRow extends LinkedInvoiceFile {
  tenant_id: string;
  ksef_number: string | null;
  currency: string | null;
}

type AdminClient = ReturnType<typeof createAdminClient>;

/**
 * Koszty firmy z tokenu za miesiąc, strona po stronie (krok 6.2 planu
 * kompletnej aplikacji). Najpierw liczba pozycji, potem strona (strona za
 * końcem listy to ostatnia strona), potem numery KSeF i pliki faktur zakupu
 * z tej strony. Błąd odczytu to `status: 'error'`, nigdy pusta lista.
 */
async function readExpensesPage(
  admin: AdminClient,
  tenantId: string,
  month: string,
  requestedPage: number,
): Promise<AccountantExpensesList> {
  const { from, to } = monthRange(month);

  const counted = await admin
    .from('expenses')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .gte('issue_date', from)
    .lte('issue_date', to);
  if (counted.error || counted.count == null) return { status: 'error' };

  const page = portalPage(counted.count, requestedPage);
  const { data, error } = await admin
    .from('expenses')
    .select(EXPENSE_COLUMNS)
    .eq('tenant_id', tenantId)
    .gte('issue_date', from)
    .lte('issue_date', to)
    .order('issue_date', { ascending: false })
    .order('created_at', { ascending: false })
    .order('id', { ascending: true })
    .range(page.from, page.to);
  if (error || !data) return { status: 'error' };
  const rows = data as unknown as ExpenseDbRow[];

  const invoiceIds = [...new Set(rows.map((row) => row.ksef_invoice_id).filter((id): id is string => !!id))];
  const invoices = new Map<string, LinkedInvoiceRow>();
  if (invoiceIds.length > 0) {
    const linked = await admin
      .from('invoices')
      .select('id, tenant_id, ksef_number, xml_storage_path, currency')
      .eq('tenant_id', tenantId)
      .in('id', invoiceIds);
    if (linked.error) return { status: 'error' };
    for (const invoice of (linked.data ?? []) as LinkedInvoiceRow[]) {
      if (invoice.tenant_id === tenantId) invoices.set(invoice.id, invoice);
    }
  }

  return {
    status: 'ok',
    page: { page: page.page, pages: page.pages, total: page.total, pageSize: page.pageSize },
    rows: rows.map((row) => {
      const invoice = row.ksef_invoice_id ? invoices.get(row.ksef_invoice_id) ?? null : null;
      return {
        id: row.id,
        issue_date: row.issue_date,
        seller_name: row.seller_name,
        seller_nip: row.seller_nip,
        document_type: row.document_type,
        document_number: row.document_number,
        ksef_number: invoice?.ksef_number ?? null,
        // NUMERIC z PostgREST bywa napisem; kwoty tylko do wyświetlenia, bez liczenia.
        net_amount: Number(row.net_amount),
        vat_amount: Number(row.vat_amount),
        gross_amount: Number(row.gross_amount),
        amount_currency: expenseAmountsCurrency(row, invoice?.currency),
        kpir_column: row.kpir_column,
        is_reviewed: row.is_reviewed,
        file_kind: expenseFileKind(row, invoice, tenantId),
      };
    }),
  };
}

/**
 * Lista kosztów dla strony „Koszty” portalu księgowej. Token sprawdza
 * `resolvePortalAccess` (cofnięty, wygasły, nieznany to `null`); firma
 * tylko z wiersza dostępu. Wejście liczy się jak wejście do portalu
 * (licznik linku i wpis w audycie z widokiem i miesiącem).
 */
export async function loadAccountantExpenses(
  rawToken: string,
  options: { month: string; page: number },
): Promise<AccountantExpensesData | null> {
  const admin = createAdminClient();
  const access = await resolvePortalAccess(admin, rawToken);
  if (!access) return null;

  const { data: tenant } = await admin
    .from('tenants')
    .select('name, nip')
    .eq('id', access.tenant_id)
    .maybeSingle();
  if (!tenant?.nip) return null;

  const month = parseExpenseMonth(options.month);
  const expenses = await readExpensesPage(admin, access.tenant_id, month, options.page);
  await recordPortalVisit(admin, access, { view: 'expenses', month });

  return {
    access: publicPortalAccess(access),
    tenant: { name: tenant.name as string, nip: tenant.nip as string },
    month,
    expenses,
  };
}

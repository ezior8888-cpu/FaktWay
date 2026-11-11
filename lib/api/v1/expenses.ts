import type { SupabaseClient } from '@supabase/supabase-js';

import {
  afterCursorFilter,
  decodeCursor,
  encodeCursor,
  isCalendarDate,
  parseLimit,
  readKnownParams,
  type PageCursor,
  type ParsedQuery,
} from '@/lib/api/v1/pagination';
import type { ApiPage, ApiParty } from '@/lib/api/v1/invoices';
import { ApiUpstreamError } from '@/lib/api/v1/responses';
import { expenseAmountsCurrency } from '@/lib/expenses/amounts-currency';
import type { Json } from '@/types/database';

/**
 * Koszty w publicznym API (`GET /api/v1/expenses`): lista z kwotami i statusem
 * przeglądu. Kwoty jako tekst dziesiętny z bazy (`::text`), waluta kwot jak
 * w karcie kosztu (`expenseAmountsCurrency`). Klient bazy to token klucza:
 * RLS z 00181 wpuszcza tylko koszty firmy klucza z zakresem `expenses:read`.
 */

export const EXPENSE_REVIEW_STATUSES = ['unreviewed', 'reviewed'] as const;
export const EXPENSE_LIST_PARAMS = ['review_status', 'issue_date_from', 'issue_date_to', 'limit', 'cursor'] as const;

export interface ExpenseListQuery {
  reviewStatus: (typeof EXPENSE_REVIEW_STATUSES)[number] | null;
  issueDateFrom: string | null;
  issueDateTo: string | null;
  limit: number;
  cursor: PageCursor | null;
}

export interface ApiExpense {
  id: string;
  document_number: string | null;
  document_type: string;
  issue_date: string;
  seller: ApiParty;
  currency: string | null;
  net_amount: string;
  vat_amount: string;
  gross_amount: string;
  vat_deductible_amount: string;
  vat_rate: string | null;
  deductible: boolean;
  review_status: (typeof EXPENSE_REVIEW_STATUSES)[number];
  category: string | null;
  kpir_column: string | null;
  source: string;
  invoice_id: string | null;
  created_at: string;
  updated_at: string;
}

/** Tylko kolumny z grantu `api_key_client`; z odczytu OCR wyłącznie ślad waluty. */
const EXPENSE_SELECT = [
  'id', 'document_number', 'document_type', 'issue_date', 'seller_name', 'seller_nip',
  'net_amount::text', 'vat_amount::text', 'gross_amount::text', 'vat_deductible_amount::text', 'vat_rate',
  'is_deductible', 'is_reviewed', 'category_label', 'kpir_column', 'source', 'ksef_invoice_id',
  'ocr_source:ocr_extracted_data->>source', 'ocr_currency:ocr_extracted_data->>currency', 'ocr_fx:ocr_extracted_data->fx',
  'created_at', 'updated_at',
].join(',');

type Row = Record<string, unknown>;

const text = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

/** Ślad waluty w kształcie, który czyta `hasKsefCurrencyRate`. */
function currencyTrace(row: Row): Json | null {
  if (row.ocr_source === null && row.ocr_currency === null && row.ocr_fx === null) return null;
  return { source: text(row.ocr_source), currency: text(row.ocr_currency), fx: (row.ocr_fx ?? null) as Json };
}

export function toApiExpense(row: Row, ksefInvoiceCurrency: string | null | undefined): ApiExpense {
  const issueDate = String(row.issue_date);
  return {
    id: String(row.id),
    document_number: text(row.document_number),
    document_type: text(row.document_type) ?? 'invoice',
    issue_date: issueDate,
    seller: { name: text(row.seller_name), nip: text(row.seller_nip) },
    currency: expenseAmountsCurrency(
      { source: text(row.source), issue_date: issueDate, ocr_extracted_data: currencyTrace(row) },
      ksefInvoiceCurrency,
    ),
    net_amount: text(row.net_amount) ?? '0.00',
    vat_amount: text(row.vat_amount) ?? '0.00',
    gross_amount: text(row.gross_amount) ?? '0.00',
    vat_deductible_amount: text(row.vat_deductible_amount) ?? '0.00',
    vat_rate: text(row.vat_rate),
    deductible: row.is_deductible === true,
    review_status: row.is_reviewed === true ? 'reviewed' : 'unreviewed',
    category: text(row.category_label),
    kpir_column: text(row.kpir_column),
    source: String(row.source),
    invoice_id: text(row.ksef_invoice_id),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

export function parseExpenseListQuery(params: URLSearchParams): ParsedQuery<ExpenseListQuery> {
  const known = readKnownParams(params, EXPENSE_LIST_PARAMS);
  if (!known.ok) return known;
  const get = (name: string) => known.values.get(name);
  const bad = (param: string, message: string) => ({ ok: false as const, param, message });

  const statusRaw = get('review_status');
  const reviewStatus = statusRaw === undefined
    ? null
    : (EXPENSE_REVIEW_STATUSES as readonly string[]).includes(statusRaw)
      ? (statusRaw as ExpenseListQuery['reviewStatus'])
      : undefined;
  if (reviewStatus === undefined) {
    return bad('review_status', `Parametr review_status przyjmuje: ${EXPENSE_REVIEW_STATUSES.join(', ')}.`);
  }
  for (const name of ['issue_date_from', 'issue_date_to'] as const) {
    const value = get(name);
    if (value !== undefined && !isCalendarDate(value)) return bad(name, `Parametr ${name} to data w formacie RRRR-MM-DD.`);
  }
  const limit = parseLimit(get('limit'));
  if (limit === null) return bad('limit', 'Parametr limit to liczba całkowita od 1 do 100.');
  const cursorRaw = get('cursor');
  const cursor = cursorRaw === undefined ? null : decodeCursor(cursorRaw);
  if (cursorRaw !== undefined && !cursor) return bad('cursor', 'Parametr cursor jest nieprawidłowy. Użyj wartości next_cursor z poprzedniej strony.');

  return {
    ok: true,
    value: {
      reviewStatus,
      issueDateFrom: get('issue_date_from') ?? null,
      issueDateTo: get('issue_date_to') ?? null,
      limit,
      cursor,
    },
  };
}

/** Waluta faktury KSeF dla kosztów ze skrzynki (RPC sprawdza firmę i zakres klucza). */
async function ksefInvoiceCurrencies(db: SupabaseClient, rows: Row[]): Promise<Map<string, string | null>> {
  const ids = rows.filter((row) => row.source === 'ksef_inbox').map((row) => String(row.id));
  const out = new Map<string, string | null>();
  if (ids.length === 0) return out;
  const { data, error } = await db.rpc('api_expense_invoice_currencies', { p_expense_ids: ids });
  if (error) throw new ApiUpstreamError('expenses.currencies');
  for (const entry of (data ?? []) as { expense_id: unknown; currency: unknown }[]) {
    out.set(String(entry.expense_id), typeof entry.currency === 'string' ? entry.currency : null);
  }
  return out;
}

export async function listExpenses(db: SupabaseClient, tenantId: string, query: ExpenseListQuery): Promise<ApiPage<ApiExpense>> {
  let request = db.from('expenses').select(EXPENSE_SELECT).eq('tenant_id', tenantId);
  if (query.reviewStatus) request = request.eq('is_reviewed', query.reviewStatus === 'reviewed');
  if (query.issueDateFrom) request = request.gte('issue_date', query.issueDateFrom);
  if (query.issueDateTo) request = request.lte('issue_date', query.issueDateTo);
  if (query.cursor) request = request.or(afterCursorFilter(query.cursor));
  const { data, error } = await request
    .order('issue_date', { ascending: false })
    .order('id', { ascending: false })
    .limit(query.limit + 1);
  if (error) throw new ApiUpstreamError('expenses.list');

  const rows = (data ?? []) as unknown as Row[];
  const page = rows.slice(0, query.limit);
  const currencies = await ksefInvoiceCurrencies(db, page);
  const items = page.map((row) => toApiExpense(row, currencies.get(String(row.id))));
  const last = items.at(-1);
  return {
    data: items,
    next_cursor: rows.length > query.limit && last ? encodeCursor({ issueDate: last.issue_date, id: last.id }) : null,
  };
}

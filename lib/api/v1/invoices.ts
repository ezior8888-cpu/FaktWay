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
import { ApiUpstreamError } from '@/lib/api/v1/responses';

/**
 * Faktury w publicznym API (`GET /api/v1/invoices`, `GET /api/v1/invoices/{id}`).
 *
 * Pola po angielsku i stabilne (opis: `lib/api/v1/openapi.json`). Kwoty jako
 * tekst dziesiętny prosto z bazy (`::text`), bez liczb zmiennoprzecinkowych
 * po drodze. Klient bazy to token klucza (`lib/api/v1/auth.ts`), więc RLS
 * wpuszcza tylko firmę klucza; filtr `tenant_id` jest drugą warstwą.
 */

export const INVOICE_DIRECTIONS = ['outgoing', 'incoming'] as const;
/** Statusy KSeF z CHECK `invoices_ksef_status_check` (00018). */
export const INVOICE_KSEF_STATUSES = [
  'draft', 'queued', 'sending', 'accepted', 'rejected', 'received', 'failed', 'offline_queued',
] as const;

export const INVOICE_LIST_PARAMS = ['direction', 'ksef_status', 'issue_date_from', 'issue_date_to', 'limit', 'cursor'] as const;

export interface InvoiceListQuery {
  direction: (typeof INVOICE_DIRECTIONS)[number] | null;
  ksefStatus: (typeof INVOICE_KSEF_STATUSES)[number] | null;
  issueDateFrom: string | null;
  issueDateTo: string | null;
  limit: number;
  cursor: PageCursor | null;
}

export interface ApiParty {
  name: string | null;
  nip: string | null;
}

export interface ApiInvoice {
  id: string;
  direction: string;
  number: string | null;
  kind: string;
  issue_date: string;
  sale_date: string | null;
  payment_due_date: string | null;
  currency: string;
  net_total: string | null;
  vat_total: string | null;
  gross_total: string | null;
  paid_amount: string;
  payment_status: string;
  seller: ApiParty;
  buyer: ApiParty;
  ksef_status: string | null;
  ksef_number: string | null;
  ksef_accepted_at: string | null;
  ksef_environment: string | null;
  corrected_invoice_id: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface ApiInvoiceItem {
  position: number;
  name: string | null;
  quantity: string | null;
  unit: string | null;
  unit_price_net: string | null;
  net_amount: string | null;
  vat_rate: string | null;
  vat_amount: string | null;
  gross_amount: string | null;
}

export interface ApiInvoiceDetail extends ApiInvoice {
  items: ApiInvoiceItem[];
}

export interface ApiPage<T> {
  data: T[];
  next_cursor: string | null;
}

/**
 * Tylko kolumny z grantu `api_key_client` (00181). Nazwa i NIP stron ze
 * ścieżek JSON: najpierw `seller_data`/`buyer_data`, potem `fa3_data`
 * (faktury ze skrzynki KSeF), jak w Skrzynce (`sellerDisplay`).
 */
const INVOICE_SELECT = [
  'id', 'direction', 'internal_number', 'invoice_kind', 'issue_date', 'sale_date', 'payment_due_date', 'currency',
  'net_total::text', 'vat_total::text', 'gross_total::text', 'paid_amount::text', 'payment_status',
  'seller_nip', 'seller_name:seller_data->>name', 'seller_data_nip:seller_data->>nip',
  'fa3_seller_name:fa3_data->seller->>name', 'fa3_seller_nip:fa3_data->seller->>nip',
  'buyer_nip', 'buyer_name:buyer_data->>name', 'buyer_data_nip:buyer_data->>nip',
  'fa3_buyer_name:fa3_data->buyer->>name', 'fa3_buyer_nip:fa3_data->buyer->>nip',
  'ksef_status', 'ksef_number', 'ksef_accepted_at', 'ksef_environment', 'parent_invoice_id', 'created_at', 'updated_at',
].join(',');

const ITEM_SELECT = 'ordinal,name,quantity::text,unit,unit_price_net::text,net_amount::text,vat_rate,vat_amount::text,gross_amount::text';

type Row = Record<string, unknown>;

const text = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

function party(row: Row, side: 'seller' | 'buyer'): ApiParty {
  return {
    name: text(row[`${side}_name`]) ?? text(row[`fa3_${side}_name`]),
    nip: text(row[`${side}_data_nip`]) ?? text(row[`fa3_${side}_nip`]) ?? text(row[`${side}_nip`]),
  };
}

export function toApiInvoice(row: Row): ApiInvoice {
  return {
    id: String(row.id),
    direction: String(row.direction),
    number: text(row.internal_number),
    kind: text(row.invoice_kind) ?? 'regular',
    issue_date: String(row.issue_date),
    sale_date: text(row.sale_date),
    payment_due_date: text(row.payment_due_date),
    currency: text(row.currency)?.toUpperCase() ?? 'PLN',
    net_total: text(row.net_total),
    vat_total: text(row.vat_total),
    gross_total: text(row.gross_total),
    paid_amount: text(row.paid_amount) ?? '0.00',
    payment_status: text(row.payment_status) ?? 'unpaid',
    seller: party(row, 'seller'),
    buyer: party(row, 'buyer'),
    ksef_status: text(row.ksef_status),
    ksef_number: text(row.ksef_number),
    ksef_accepted_at: text(row.ksef_accepted_at),
    ksef_environment: text(row.ksef_environment),
    corrected_invoice_id: text(row.parent_invoice_id),
    created_at: text(row.created_at),
    updated_at: text(row.updated_at),
  };
}

export function toApiItem(row: Row): ApiInvoiceItem {
  return {
    position: Number(row.ordinal),
    name: text(row.name),
    quantity: text(row.quantity),
    unit: text(row.unit),
    unit_price_net: text(row.unit_price_net),
    net_amount: text(row.net_amount),
    vat_rate: text(row.vat_rate),
    vat_amount: text(row.vat_amount),
    gross_amount: text(row.gross_amount),
  };
}

function oneOf<T extends string>(allowed: readonly T[], value: string): T | null {
  return (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

export function parseInvoiceListQuery(params: URLSearchParams): ParsedQuery<InvoiceListQuery> {
  const known = readKnownParams(params, INVOICE_LIST_PARAMS);
  if (!known.ok) return known;
  const get = (name: string) => known.values.get(name);
  const bad = (param: string, message: string) => ({ ok: false as const, param, message });

  const directionRaw = get('direction');
  const direction = directionRaw === undefined ? null : oneOf(INVOICE_DIRECTIONS, directionRaw);
  if (directionRaw !== undefined && !direction) {
    return bad('direction', `Parametr direction przyjmuje: ${INVOICE_DIRECTIONS.join(', ')}.`);
  }
  const statusRaw = get('ksef_status');
  const ksefStatus = statusRaw === undefined ? null : oneOf(INVOICE_KSEF_STATUSES, statusRaw);
  if (statusRaw !== undefined && !ksefStatus) {
    return bad('ksef_status', `Parametr ksef_status przyjmuje: ${INVOICE_KSEF_STATUSES.join(', ')}.`);
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
      direction,
      ksefStatus,
      issueDateFrom: get('issue_date_from') ?? null,
      issueDateTo: get('issue_date_to') ?? null,
      limit,
      cursor,
    },
  };
}

export async function listInvoices(db: SupabaseClient, tenantId: string, query: InvoiceListQuery): Promise<ApiPage<ApiInvoice>> {
  let request = db.from('invoices').select(INVOICE_SELECT).eq('tenant_id', tenantId);
  if (query.direction) request = request.eq('direction', query.direction);
  if (query.ksefStatus) request = request.eq('ksef_status', query.ksefStatus);
  if (query.issueDateFrom) request = request.gte('issue_date', query.issueDateFrom);
  if (query.issueDateTo) request = request.lte('issue_date', query.issueDateTo);
  if (query.cursor) request = request.or(afterCursorFilter(query.cursor));
  const { data, error } = await request
    .order('issue_date', { ascending: false })
    .order('id', { ascending: false })
    .limit(query.limit + 1);
  if (error) throw new ApiUpstreamError('invoices.list');

  const rows = ((data ?? []) as unknown as Row[]).map(toApiInvoice);
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return {
    data: page,
    next_cursor: rows.length > query.limit && last ? encodeCursor({ issueDate: last.issue_date, id: last.id }) : null,
  };
}

/** Faktura z pozycjami albo `null`, gdy nie istnieje albo należy do innej firmy (RLS). */
export async function readInvoice(db: SupabaseClient, tenantId: string, id: string): Promise<ApiInvoiceDetail | null> {
  const { data, error } = await db
    .from('invoices')
    .select(INVOICE_SELECT)
    .eq('tenant_id', tenantId)
    .eq('id', id)
    .maybeSingle();
  if (error) throw new ApiUpstreamError('invoices.read');
  if (!data) return null;

  const { data: items, error: itemsError } = await db
    .from('invoice_line_items')
    .select(ITEM_SELECT)
    .eq('invoice_id', id)
    .order('ordinal', { ascending: true })
    .limit(1000);
  if (itemsError) throw new ApiUpstreamError('invoice_line_items.read');

  return {
    ...toApiInvoice(data as unknown as Row),
    items: ((items ?? []) as unknown as Row[]).map(toApiItem),
  };
}

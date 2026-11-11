import type { SupabaseClient } from '@supabase/supabase-js';

import { partyFromJson } from '@/lib/noty/baza';
import {
  isQuoteKind,
  isQuotePaymentMethod,
  isQuoteVatRate,
  QUOTE_CURRENCY,
  type QuoteEmailRecord,
  type QuoteInvoiceLink,
  type QuoteItem,
  type QuoteListItem,
  type SalesQuote,
} from '@/lib/proformy/model';

/**
 * Odczyty proform i ofert (00198) klientem z sesji: RLS zawęża do aktywnej
 * firmy, a każde zapytanie filtruje jeszcze `tenant_id` firmy z sesji, więc
 * dokument innej firmy to „nie znaleziono”. Błąd bazy rzuca: „nie wiem” to
 * nie „brak dokumentu”.
 *
 * Kontrahenci firmy, dane wystawcy do podglądu szkicu i migawka kontrahenta:
 * te same funkcje co przy nocie (`lib/noty/baza.ts`), bo to te same tabele
 * (`contractors`, `tenants`) i ten sam kształt migawki.
 *
 * Tabele 00198 i nowe kolumny `invoices` nie są jeszcze w `types/database.ts`
 * (typy z produkcji po wgraniu migracji), stąd klient bez typów bazy. Ten
 * plik tylko czyta: zapis dokumentu robią akcje, zapis faktury formularz faktury.
 */

export { counterpartyFromContractor, listContractorOptions, loadIssuerPreview } from '@/lib/noty/baza';

function untyped(client: unknown): SupabaseClient {
  return client as SupabaseClient;
}

export function quotesTable(client: unknown) {
  return untyped(client).from('sales_quotes');
}

export function quoteEmailsTable(client: unknown) {
  return untyped(client).from('sales_quote_emails');
}

export const QUOTE_COLUMNS =
  'id, tenant_id, kind, status, number, issue_date, valid_until, items, net_total, vat_total, gross_total, currency, contractor_id, counterparty, issuer, payment_method, payment_due_date, bank_account, notes, issued_at, created_at';

const QUOTE_LIST_COLUMNS = 'id, kind, status, number, issue_date, valid_until, counterparty, gross_total, created_at';

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function money(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

function itemsFromJson(value: unknown): QuoteItem[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const items: QuoteItem[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const name = text(r.name);
    const unit = text(r.unit);
    const quantity = money(r.quantity);
    const unitPriceNet = money(r.unitPriceNet);
    const netAmount = money(r.netAmount);
    const vatAmount = money(r.vatAmount);
    const grossAmount = money(r.grossAmount);
    if (
      name === null || unit === null || !isQuoteVatRate(r.vatRate) || quantity === null || unitPriceNet === null
      || netAmount === null || vatAmount === null || grossAmount === null
    ) {
      return null;
    }
    items.push({ name, unit, quantity, unitPriceNet, vatRate: r.vatRate, netAmount, vatAmount, grossAmount });
  }
  return items;
}

/** Wiersz bazy → dokument; wiersz w nieznanym kształcie to null (nie zgadujemy treści dokumentu). */
export function quoteFromRow(row: unknown): SalesQuote | null {
  if (!row || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  const id = text(r.id);
  const tenantId = text(r.tenant_id);
  const status = r.status === 'draft' || r.status === 'issued' ? r.status : null;
  const items = itemsFromJson(r.items);
  const netTotal = money(r.net_total);
  const vatTotal = money(r.vat_total);
  const grossTotal = money(r.gross_total);
  const counterparty = partyFromJson(r.counterparty);
  const issueDate = text(r.issue_date);
  if (
    !id || !tenantId || !isQuoteKind(r.kind) || !status || !items || netTotal === null || vatTotal === null
    || grossTotal === null || !counterparty || !issueDate
  ) {
    return null;
  }
  if (r.currency !== QUOTE_CURRENCY) return null;
  const number = text(r.number);
  const issuer = partyFromJson(r.issuer);
  const issuedAt = text(r.issued_at);
  if (status === 'issued' && (!number || !issuer || !issuedAt)) return null;
  return {
    id,
    tenantId,
    kind: r.kind,
    status,
    number: status === 'issued' ? number : null,
    issueDate,
    validUntil: text(r.valid_until),
    items,
    netTotal,
    vatTotal,
    grossTotal,
    currency: QUOTE_CURRENCY,
    contractorId: text(r.contractor_id),
    counterparty,
    issuer: status === 'issued' ? issuer : null,
    paymentMethod: isQuotePaymentMethod(r.payment_method) ? r.payment_method : null,
    paymentDueDate: text(r.payment_due_date),
    bankAccount: text(r.bank_account),
    notes: text(r.notes),
    issuedAt: status === 'issued' ? issuedAt : null,
    createdAt: text(r.created_at) ?? '',
  };
}

export async function getQuote(client: unknown, tenantId: string, id: string): Promise<SalesQuote | null> {
  const { data, error } = await quotesTable(client).select(QUOTE_COLUMNS).eq('tenant_id', tenantId).eq('id', id).maybeSingle();
  if (error) throw new Error(`sales_quotes: ${error.message}`);
  return data ? quoteFromRow(data) : null;
}

/** Najnowsze dokumenty firmy (do 200, jak lista not). */
export async function listQuotes(client: unknown, tenantId: string, limit = 200): Promise<QuoteListItem[]> {
  const { data, error } = await quotesTable(client)
    .select(QUOTE_LIST_COLUMNS)
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`sales_quotes: ${error.message}`);
  const rows: QuoteListItem[] = [];
  for (const raw of (data ?? []) as Array<Record<string, unknown>>) {
    const grossTotal = money(raw.gross_total);
    const status = raw.status === 'draft' || raw.status === 'issued' ? raw.status : null;
    const id = text(raw.id);
    if (!id || !isQuoteKind(raw.kind) || !status || grossTotal === null) continue;
    rows.push({
      id,
      kind: raw.kind,
      status,
      number: status === 'issued' ? text(raw.number) : null,
      issueDate: text(raw.issue_date) ?? '',
      validUntil: text(raw.valid_until),
      counterpartyName: partyFromJson(raw.counterparty)?.name ?? '',
      grossTotal,
    });
  }
  return rows;
}

/** Historia wysyłek dokumentu mailem, od najstarszej. */
export async function listQuoteEmails(client: unknown, tenantId: string, quoteId: string): Promise<QuoteEmailRecord[]> {
  const { data, error } = await quoteEmailsTable(client)
    .select('id, recipient, sent_at')
    .eq('tenant_id', tenantId)
    .eq('quote_id', quoteId)
    .order('sent_at', { ascending: true });
  if (error) throw new Error(`sales_quote_emails: ${error.message}`);
  return ((data ?? []) as Array<Record<string, unknown>>).flatMap((raw) => {
    const id = text(raw.id);
    const recipient = text(raw.recipient);
    const sentAt = text(raw.sent_at);
    return id && recipient && sentAt ? [{ id, recipient, sentAt }] : [];
  });
}

/** Ile wysyłek tego dokumentu na ten adres jest już w historii (część klucza idempotencji maila). */
export async function countQuoteEmailsTo(client: unknown, tenantId: string, quoteId: string, recipient: string): Promise<number> {
  const { count, error } = await quoteEmailsTable(client)
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('quote_id', quoteId)
    .eq('recipient', recipient);
  if (error) throw new Error(`sales_quote_emails: ${error.message}`);
  return count ?? 0;
}

/**
 * Faktury utworzone z dokumentu (`invoices.sales_quote_id`, 00198), po numerze
 * zamiany. Wszystkie naraz i sortowanie tutaj: z jednego dokumentu powstaje
 * kilka faktur, a numer kolejnej zamiany to największy numer + 1.
 */
export async function listQuoteInvoices(client: unknown, tenantId: string, quoteId: string): Promise<QuoteInvoiceLink[]> {
  const { data, error } = await untyped(client)
    .from('invoices')
    .select('id, internal_number, invoice_kind, ksef_status, sales_quote_seq')
    .eq('tenant_id', tenantId)
    .eq('sales_quote_id', quoteId);
  if (error) throw new Error(`invoices (sales_quote_id): ${error.message}`);
  return ((data ?? []) as Array<Record<string, unknown>>)
    .flatMap((raw) => {
      const invoiceId = text(raw.id);
      const seq = money(raw.sales_quote_seq);
      if (!invoiceId || seq === null) return [];
      return [{
        invoiceId,
        internalNumber: text(raw.internal_number),
        invoiceKind: text(raw.invoice_kind) ?? 'regular',
        ksefStatus: text(raw.ksef_status),
        seq,
      }];
    })
    .sort((a, b) => a.seq - b.seq);
}

/** Rachunek z ostatniej proformy firmy: podpowiedź w nowym dokumencie (błąd odczytu to brak podpowiedzi). */
export async function lastQuoteBankAccount(client: unknown, tenantId: string): Promise<string | null> {
  const { data, error } = await quotesTable(client)
    .select('bank_account')
    .eq('tenant_id', tenantId)
    .eq('kind', 'proforma')
    .not('bank_account', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return text((data as Record<string, unknown>).bank_account);
}

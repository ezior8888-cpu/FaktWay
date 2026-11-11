import type { SupabaseClient } from '@supabase/supabase-js';

import { listQuoteInvoices } from '@/lib/proformy/baza';
import { isQuoteKind, type QuoteKind } from '@/lib/proformy/model';
import {
  CONVERSION_TEXTS,
  conversionSeqTakenMessage,
  conversionSeqTakenUnknownMessage,
  invoiceNumbersSentence,
} from '@/lib/proformy/teksty';

/**
 * Faktura z proformy albo oferty (krok 2.4, 00198): powiązanie, które zapis
 * faktury wpisuje w TYM SAMYM INSERT co szkic (`invoices.sales_quote_id`,
 * `invoices.sales_quote_seq`). Wołają to akcje zapisu formularza faktury
 * (`components/invoices/actions.ts`, `components/invoices/advance-actions.ts`)
 * tylko wtedy, gdy formularz otwarto z dokumentu (ukryte pola); zwykła faktura
 * ma wiersz bez zmian.
 *
 * Druga faktura z tego samego dokumentu tylko po potwierdzeniu: formularz
 * niesie numer kolejnej zamiany, który strona nadała po potwierdzeniu na
 * ekranie dokumentu (`loadQuoteSource`). Zapis odmawia, gdy ten numer albo
 * wyższy zajęła już inna faktura (formularz otwarty przed nią, drugie
 * kliknięcie, druga karta), a unikalny indeks `uq_invoices_sales_quote_seq`
 * łapie dwa zapisy naraz. Ten plik tylko czyta faktury.
 */

export interface SalesQuoteIssueLink {
  quoteId: string;
  /** Numer kolejnej zamiany (1 = pierwsza faktura z dokumentu). */
  seq: number;
  quoteKind: QuoteKind;
  quoteNumber: string;
}

export interface InvoiceSalesQuoteColumns {
  sales_quote_id: string;
  sales_quote_seq: number;
}

/** Nazwa indeksu z 00198, po której rozpoznajemy zajęty numer zamiany. */
export const SALES_QUOTE_SEQ_INDEX = 'uq_invoices_sales_quote_seq';

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Kolumny powiązania tylko przy fakturze z dokumentu; zwykła faktura bez tych kluczy (nie z NULL-ami). */
export function withSalesQuoteColumns<T extends object>(
  row: T,
  link: SalesQuoteIssueLink | undefined,
): T & Partial<InvoiceSalesQuoteColumns> {
  return link ? { ...row, sales_quote_id: link.quoteId, sales_quote_seq: link.seq } : row;
}

interface PostgrestLikeError {
  code?: string | null;
  message?: string | null;
  details?: string | null;
}

/** 23505 na indeksie numeru zamiany (po nazwie z komunikatu albo z opisu klucza PostgREST). */
export function isSalesQuoteConflict(error: PostgrestLikeError | null | undefined): boolean {
  if (error?.code !== '23505') return false;
  return (error.message ?? '').includes(SALES_QUOTE_SEQ_INDEX) || (error.details ?? '').includes('sales_quote_seq');
}

/**
 * Powiązanie z formularza sprawdzone PRZED zapisem faktury. Bez dokumentu:
 * `link` pusty (zwykła faktura). Dokument obcej firmy, usunięty albo szkic:
 * odmowa bez zapisu. Numer zamiany zajęty: odmowa z numerami faktur, które
 * już powstały z dokumentu.
 */
export async function salesQuoteLinkForSave(
  client: unknown,
  tenantId: string,
  salesQuoteId: string | undefined,
  salesQuoteSeq: string | undefined,
): Promise<{ ok: true; link: SalesQuoteIssueLink | undefined } | { ok: false; error: string }> {
  if (!salesQuoteId) return { ok: true, link: undefined };
  const seq = Number(salesQuoteSeq);
  if (!UUID_SHAPE.test(salesQuoteId) || !Number.isInteger(seq) || seq < 1) {
    return { ok: false, error: CONVERSION_TEXTS.linkMissing };
  }

  let quote: Record<string, unknown> | null;
  try {
    const { data, error } = await (client as SupabaseClient)
      .from('sales_quotes')
      .select('id, kind, status, number')
      .eq('tenant_id', tenantId)
      .eq('id', salesQuoteId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    quote = (data as Record<string, unknown> | null) ?? null;
  } catch {
    return { ok: false, error: CONVERSION_TEXTS.linkReadFailed };
  }
  if (!quote || !isQuoteKind(quote.kind)) return { ok: false, error: CONVERSION_TEXTS.linkMissing };
  if (quote.status !== 'issued' || typeof quote.number !== 'string') return { ok: false, error: CONVERSION_TEXTS.linkDraft };

  const link: SalesQuoteIssueLink = { quoteId: salesQuoteId, seq, quoteKind: quote.kind, quoteNumber: quote.number };
  const taken = await takenMessage(client, tenantId, link);
  if (taken.readFailed) return { ok: false, error: CONVERSION_TEXTS.linkReadFailed };
  if (taken.message) return { ok: false, error: taken.message };
  return { ok: true, link };
}

/** Faktury z dokumentu z numerem zamiany równym albo wyższym niż numer formularza. */
async function takenMessage(
  client: unknown,
  tenantId: string,
  link: SalesQuoteIssueLink,
): Promise<{ readFailed: boolean; message: string | null }> {
  try {
    const invoices = await listQuoteInvoices(client, tenantId, link.quoteId);
    const later = invoices.filter((invoice) => invoice.seq >= link.seq);
    if (later.length === 0) return { readFailed: false, message: null };
    return {
      readFailed: false,
      message: conversionSeqTakenMessage(link.quoteKind, link.quoteNumber, invoiceNumbersSentence(later)),
    };
  } catch {
    return { readFailed: true, message: null };
  }
}

/**
 * Komunikat po 23505 przy zapisie faktury z dokumentu: gdy numer zamiany zajęła
 * inna faktura (dwa zapisy naraz, także przy zajętym numerze faktury, bo
 * Postgres zgłasza jeden z indeksów), klient dostaje jej numer; inaczej null
 * i zostaje komunikat o numerze faktury.
 */
export async function salesQuoteConflictMessage(
  client: unknown,
  tenantId: string,
  link: SalesQuoteIssueLink,
  error: PostgrestLikeError | null | undefined,
): Promise<string | null> {
  if (error?.code !== '23505') return null;
  const taken = await takenMessage(client, tenantId, link);
  if (taken.message) return taken.message;
  return isSalesQuoteConflict(error) ? conversionSeqTakenUnknownMessage(link.quoteKind, link.quoteNumber) : null;
}

/** Wpis audytu zamiany (po zapisie faktury z powiązaniem). */
export function salesQuoteConvertedAudit(
  link: SalesQuoteIssueLink,
  tenantId: string,
  userId: string | null,
  invoice: { invoiceId: string; internalNumber: string; invoiceKind: 'regular' | 'advance' },
) {
  return {
    action: 'sales_quote.converted' as const,
    tenantId,
    userId,
    entityType: 'sales_quote',
    entityId: link.quoteId,
    metadata: {
      invoiceId: invoice.invoiceId,
      internalNumber: invoice.internalNumber,
      invoiceKind: invoice.invoiceKind,
      seq: link.seq,
      quoteKind: link.quoteKind,
      quoteNumber: link.quoteNumber,
    },
  };
}

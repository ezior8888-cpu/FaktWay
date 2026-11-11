import type { SupabaseClient } from '@supabase/supabase-js';

import { outstandingOf } from '@/lib/invoices/amount-due';
import {
  isRealDay,
  parseCashDocumentRow,
  parseCashReportRpc,
  partyFromJson,
  type CashDocument,
  type CashParty,
  type CashRegister,
  type CashReportData,
} from '@/lib/kasa/model';

/**
 * Odczyty Kasy (00194) klientem z sesji: RLS zawęża do aktywnej firmy, a każde
 * zapytanie filtruje jeszcze `tenant_id` firmy z sesji, więc dowód innej
 * firmy to „nie znaleziono”. Błąd bazy rzuca: „nie wiem” to nie „brak
 * dowodu”. Wiersz w nieznanym kształcie też rzuca (nie zgadujemy dokumentu).
 *
 * Tabele i RPC 00194 nie są jeszcze w `types/database.ts` (typy z produkcji
 * po wgraniu migracji), stąd klient bez typów bazy.
 */

function untyped(client: unknown): SupabaseClient {
  return client as SupabaseClient;
}

const DOCUMENT_COLUMNS =
  'id, tenant_id, kind, number, issue_date, operation_date, amount, title, counterparty, issuer, issued_by_name, issued_at, invoice_id, invoice_number, payment_id, related_document, corrects_id, corrects_number, correction_reason';

function finite(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
  return Number.isFinite(n) ? n : null;
}

export async function getCashRegister(client: unknown, tenantId: string): Promise<CashRegister | null> {
  const { data, error } = await untyped(client)
    .from('cash_registers')
    .select('id, opening_date, opening_balance')
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as Record<string, unknown>;
  const balance = finite(row.opening_balance);
  if (typeof row.id !== 'string' || !isRealDay(row.opening_date) || balance === null) {
    throw new Error('cash_register_shape');
  }
  return { id: row.id, openingDate: row.opening_date, openingBalance: balance };
}

/** Czy kasa ma już jakiś dowód (stan początkowy jest wtedy zablokowany). */
export async function hasCashDocuments(client: unknown, tenantId: string): Promise<boolean> {
  const { count, error } = await untyped(client)
    .from('cash_documents')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId);
  if (error) throw error;
  return (count ?? 0) > 0;
}

/** Raport z RPC `cash_report` (stan przed okresem i dowody okresu). */
export async function getCashReportData(client: unknown, from: string, to: string): Promise<CashReportData> {
  const { data, error } = await untyped(client).rpc('cash_report', { p_from: from, p_to: to });
  if (error) throw error;
  const parsed = parseCashReportRpc(data);
  if (!parsed) throw new Error('cash_report_shape');
  return parsed;
}

export async function getCashDocument(client: unknown, tenantId: string, id: string): Promise<CashDocument | null> {
  const { data, error } = await untyped(client)
    .from('cash_documents')
    .select(DOCUMENT_COLUMNS)
    .eq('tenant_id', tenantId)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const doc = parseCashDocumentRow(data);
  if (!doc) throw new Error('cash_document_shape');
  return doc;
}

/** Korekta, która znosi ten dowód (najwyżej jedna, indeks unikalny w 00194). */
export async function getCorrectionOf(client: unknown, tenantId: string, id: string): Promise<{ id: string; number: string } | null> {
  const { data, error } = await untyped(client)
    .from('cash_documents')
    .select('id, number')
    .eq('tenant_id', tenantId)
    .eq('corrects_id', id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as Record<string, unknown>;
  return typeof row.id === 'string' && typeof row.number === 'string' ? { id: row.id, number: row.number } : null;
}

/** Nabywca z `invoices.buyer_data` jako strona KP (nazwa, NIP, adres). */
export function partyFromBuyerData(value: unknown): CashParty | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const address = v.address && typeof v.address === 'object' && !Array.isArray(v.address) ? (v.address as Record<string, unknown>) : {};
  return partyFromJson({
    name: v.name,
    nip: typeof v.nip === 'string' ? v.nip : null,
    countryCode: address.countryCode,
    addressLine1: address.addressLine1,
    addressLine2: address.addressLine2,
  });
}

export interface CashInvoiceOption {
  id: string;
  number: string;
  buyer: CashParty | null;
  /** Pozostało do zapłaty (`outstandingOf`); RPC i tak liczy resztę jeszcze raz. */
  remaining: number;
}

/**
 * Faktury sprzedaży do „Zapłata faktury” w KP: przyjęte w KSeF, w złotych,
 * z resztą do zapłaty. Ostatnie 200 po dacie wystawienia.
 */
export async function listReceivableInvoices(client: unknown, tenantId: string): Promise<CashInvoiceOption[]> {
  const { data, error } = await untyped(client)
    .from('invoices')
    .select('id, internal_number, ksef_number, buyer_data, gross_total, paid_amount, invoice_kind, payment_data, currency')
    .eq('tenant_id', tenantId)
    .eq('direction', 'outgoing')
    .eq('ksef_status', 'accepted')
    .in('payment_status', ['unpaid', 'partial', 'overdue'])
    .order('issue_date', { ascending: false })
    .limit(200);
  if (error) throw error;
  const options: CashInvoiceOption[] = [];
  for (const raw of (data ?? []) as Array<Record<string, unknown>>) {
    const currency = typeof raw.currency === 'string' ? raw.currency.trim().toUpperCase() : 'PLN';
    const number = typeof raw.internal_number === 'string' && raw.internal_number ? raw.internal_number : typeof raw.ksef_number === 'string' ? raw.ksef_number : '';
    const remaining = outstandingOf({
      invoice_kind: raw.invoice_kind,
      gross_total: raw.gross_total,
      payment_data: raw.payment_data,
      paid_amount: raw.paid_amount,
    });
    if (typeof raw.id !== 'string' || !number || currency !== 'PLN' || remaining <= 0) continue;
    options.push({ id: raw.id, number, buyer: partyFromBuyerData(raw.buyer_data), remaining });
  }
  return options;
}

export interface CashPaymentOption {
  paymentId: string;
  invoiceId: string;
  invoiceNumber: string;
  buyer: CashParty | null;
  amount: number;
  paidOn: string;
}

/** Wpłaty wpisane ręcznie przy fakturach, które nie mają jeszcze KP (RPC `cash_receipt_payments`). */
export async function listReceiptPayments(client: unknown): Promise<CashPaymentOption[]> {
  const { data, error } = await untyped(client).rpc('cash_receipt_payments');
  if (error) throw error;
  if (!Array.isArray(data)) throw new Error('cash_receipt_payments_shape');
  const options: CashPaymentOption[] = [];
  for (const raw of data as Array<Record<string, unknown>>) {
    const amount = finite(raw.amount);
    if (typeof raw.payment_id !== 'string' || typeof raw.invoice_id !== 'string' || amount === null || !isRealDay(raw.paid_on)) {
      throw new Error('cash_receipt_payments_shape');
    }
    options.push({
      paymentId: raw.payment_id,
      invoiceId: raw.invoice_id,
      invoiceNumber: typeof raw.invoice_number === 'string' ? raw.invoice_number : '',
      buyer: partyFromBuyerData(raw.buyer),
      amount,
      paidOn: raw.paid_on,
    });
  }
  return options;
}

/** Dane firmy do nagłówka raportu i podpowiedzi przy formularzu; brak nazwy albo NIP-u to null. */
export async function getCompanyParty(client: unknown, tenantId: string): Promise<CashParty | null> {
  const { data, error } = await untyped(client)
    .from('tenants')
    .select('name, nip, address_json')
    .eq('id', tenantId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as Record<string, unknown>;
  const address = row.address_json && typeof row.address_json === 'object' && !Array.isArray(row.address_json)
    ? (row.address_json as Record<string, unknown>)
    : {};
  return partyFromJson(
    { name: row.name, nip: row.nip, countryCode: address.countryCode, addressLine1: address.addressLine1, addressLine2: address.addressLine2 },
    true,
  );
}

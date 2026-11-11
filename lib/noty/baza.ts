import type { SupabaseClient } from '@supabase/supabase-js';

import {
  isNoteKind,
  NOTE_CURRENCY,
  type AccountingNote,
  type NoteContractorOption,
  type NoteEmailRecord,
  type NoteItem,
  type NoteListItem,
  type NoteParty,
} from '@/lib/noty/model';

/**
 * Odczyty not (00193) klientem z sesji: RLS zawęża do aktywnej firmy,
 * a każde zapytanie filtruje jeszcze `tenant_id` firmy z sesji, więc nota
 * innej firmy to „nie znaleziono”. Błąd bazy rzuca: „nie wiem” to nie
 * „brak noty”.
 *
 * Tabele 00193 nie są jeszcze w `types/database.ts` (typy z produkcji po
 * wgraniu migracji), stąd klient bez typów bazy.
 */

function untyped(client: unknown): SupabaseClient {
  return client as SupabaseClient;
}

export function notesTable(client: unknown) {
  return untyped(client).from('accounting_notes');
}

export function noteEmailsTable(client: unknown) {
  return untyped(client).from('accounting_note_emails');
}

export const NOTE_COLUMNS =
  'id, tenant_id, kind, status, number, issue_date, title, items, total, currency, contractor_id, counterparty, issuer, related_document, due_date, bank_account, issued_at, created_at';

const NOTE_LIST_COLUMNS = 'id, kind, status, number, issue_date, title, counterparty, total, created_at';

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function money(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** Migawka strony z JSONB; bez nazwy albo NIP to null. */
export function partyFromJson(value: unknown): NoteParty | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const name = text(v.name)?.trim() ?? '';
  const nip = text(v.nip)?.trim() ?? '';
  if (!name || !nip) return null;
  return {
    name,
    nip,
    countryCode: text(v.countryCode)?.trim() || 'PL',
    addressLine1: text(v.addressLine1)?.trim() ?? '',
    addressLine2: text(v.addressLine2)?.trim() ?? '',
    email: text(v.email)?.trim() || null,
  };
}

function itemsFromJson(value: unknown): NoteItem[] | null {
  if (!Array.isArray(value)) return null;
  const items: NoteItem[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') return null;
    const description = text((raw as Record<string, unknown>).description);
    const amount = money((raw as Record<string, unknown>).amount);
    if (description === null || amount === null) return null;
    items.push({ description, amount });
  }
  return items;
}

/** Wiersz bazy → nota; wiersz w nieznanym kształcie to null (nie zgadujemy treści dokumentu). */
export function noteFromRow(row: unknown): AccountingNote | null {
  if (!row || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  const id = text(r.id);
  const tenantId = text(r.tenant_id);
  const status = r.status === 'draft' || r.status === 'issued' ? r.status : null;
  const items = itemsFromJson(r.items);
  const total = money(r.total);
  const counterparty = partyFromJson(r.counterparty);
  const issueDate = text(r.issue_date);
  const title = text(r.title);
  if (!id || !tenantId || !isNoteKind(r.kind) || !status || !items || total === null || !counterparty || !issueDate || title === null) {
    return null;
  }
  if (r.currency !== NOTE_CURRENCY) return null;
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
    title,
    items,
    total,
    currency: NOTE_CURRENCY,
    contractorId: text(r.contractor_id),
    counterparty,
    issuer: status === 'issued' ? issuer : null,
    relatedDocument: text(r.related_document),
    dueDate: text(r.due_date),
    bankAccount: text(r.bank_account),
    issuedAt: status === 'issued' ? issuedAt : null,
    createdAt: text(r.created_at) ?? '',
  };
}

export async function getNote(client: unknown, tenantId: string, id: string): Promise<AccountingNote | null> {
  const { data, error } = await notesTable(client).select(NOTE_COLUMNS).eq('tenant_id', tenantId).eq('id', id).maybeSingle();
  if (error) throw new Error(`accounting_notes: ${error.message}`);
  return data ? noteFromRow(data) : null;
}

/** Najnowsze noty firmy (do 200, jak lista kontrahentów). */
export async function listNotes(client: unknown, tenantId: string, limit = 200): Promise<NoteListItem[]> {
  const { data, error } = await notesTable(client)
    .select(NOTE_LIST_COLUMNS)
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`accounting_notes: ${error.message}`);
  const rows: NoteListItem[] = [];
  for (const raw of (data ?? []) as Array<Record<string, unknown>>) {
    const total = money(raw.total);
    const status = raw.status === 'draft' || raw.status === 'issued' ? raw.status : null;
    const id = text(raw.id);
    if (!id || !isNoteKind(raw.kind) || !status || total === null) continue;
    rows.push({
      id,
      kind: raw.kind,
      status,
      number: status === 'issued' ? text(raw.number) : null,
      issueDate: text(raw.issue_date) ?? '',
      title: text(raw.title) ?? '',
      counterpartyName: partyFromJson(raw.counterparty)?.name ?? '',
      total,
    });
  }
  return rows;
}

/** Historia wysyłek noty mailem, od najstarszej. */
export async function listNoteEmails(client: unknown, tenantId: string, noteId: string): Promise<NoteEmailRecord[]> {
  const { data, error } = await noteEmailsTable(client)
    .select('id, recipient, sent_at')
    .eq('tenant_id', tenantId)
    .eq('note_id', noteId)
    .order('sent_at', { ascending: true });
  if (error) throw new Error(`accounting_note_emails: ${error.message}`);
  return ((data ?? []) as Array<Record<string, unknown>>).flatMap((raw) => {
    const id = text(raw.id);
    const recipient = text(raw.recipient);
    const sentAt = text(raw.sent_at);
    return id && recipient && sentAt ? [{ id, recipient, sentAt }] : [];
  });
}

/** Ile wysyłek tej noty na ten adres jest już w historii (część klucza idempotencji maila). */
export async function countNoteEmailsTo(client: unknown, tenantId: string, noteId: string, recipient: string): Promise<number> {
  const { count, error } = await noteEmailsTable(client)
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('note_id', noteId)
    .eq('recipient', recipient);
  if (error) throw new Error(`accounting_note_emails: ${error.message}`);
  return count ?? 0;
}

/** Kontrahenci firmy do wyboru w formularzu noty, alfabetycznie (do 500). */
export async function listContractorOptions(client: unknown, tenantId: string): Promise<NoteContractorOption[]> {
  const { data, error } = await untyped(client)
    .from('contractors')
    .select('id, name, nip, email')
    .eq('tenant_id', tenantId)
    .order('name', { ascending: true })
    .limit(500);
  if (error) throw new Error(`contractors: ${error.message}`);
  return ((data ?? []) as Array<Record<string, unknown>>).flatMap((raw) => {
    const id = text(raw.id);
    const name = text(raw.name)?.trim();
    const nip = text(raw.nip)?.trim();
    return id && name && nip ? [{ id, name, nip, email: text(raw.email) }] : [];
  });
}

/** Rachunek z ostatniej noty obciążeniowej firmy: podpowiedź w nowej nocie (błąd odczytu to brak podpowiedzi). */
export async function lastDebitBankAccount(client: unknown, tenantId: string): Promise<string | null> {
  const { data, error } = await notesTable(client)
    .select('bank_account')
    .eq('tenant_id', tenantId)
    .eq('kind', 'debit')
    .not('bank_account', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return text((data as Record<string, unknown>).bank_account);
}

/**
 * Dane firmy do podglądu szkicu (te same pola, które RPC wystawienia zapisze
 * jako wystawcę). Brak nazwy, NIP albo adresu to null: podgląd prosi
 * o uzupełnienie Ustawień, a wystawienie odmówi z tym samym komunikatem.
 */
export async function loadIssuerPreview(client: unknown, tenantId: string): Promise<NoteParty | null> {
  const { data, error } = await untyped(client).from('tenants').select('name, nip, address_json').eq('id', tenantId).maybeSingle();
  if (error || !data) return null;
  const row = data as Record<string, unknown>;
  const address = row.address_json && typeof row.address_json === 'object' && !Array.isArray(row.address_json)
    ? (row.address_json as Record<string, unknown>)
    : {};
  const party = partyFromJson({
    name: row.name,
    nip: row.nip,
    countryCode: address.countryCode,
    addressLine1: address.addressLine1,
    addressLine2: address.addressLine2,
  });
  return party && party.addressLine1 && party.addressLine2 ? party : null;
}

/** Migawka kontrahenta z bazy kontrahentów firmy; bez nazwy albo NIP to null. */
export function counterpartyFromContractor(row: {
  name: unknown;
  nip: unknown;
  address: unknown;
  email: unknown;
}): NoteParty | null {
  const address = row.address && typeof row.address === 'object' && !Array.isArray(row.address)
    ? (row.address as Record<string, unknown>)
    : {};
  return partyFromJson({
    name: row.name,
    nip: row.nip,
    countryCode: address.countryCode,
    addressLine1: address.addressLine1,
    addressLine2: address.addressLine2,
    email: row.email,
  });
}

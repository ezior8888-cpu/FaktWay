'use server';

import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

import { generateAccountantToken } from '@/lib/accountant/tokens';
import { logAudit } from '@/lib/audit/log';
import {
  BUYER_LINK_TEXTS,
  buyerInvoicePath,
  buyerLinkRefusal,
  buyerLinkStatus,
  canManageBuyerLinks,
  type BuyerLinkInvoiceFacts,
  type BuyerLinkState,
} from '@/lib/invoice-share/policy';
import { configuredKsefEnvironment } from '@/lib/ksef/claim-environment';
import { siteUrl } from '@/lib/site';
import { ActionAuthError, requireUserAndActiveOrg, type AuthContext } from '@/lib/supabase/auth-context';

/**
 * „Link dla nabywcy” w karcie faktury (plan kompletnej aplikacji, krok 2.10).
 *
 * Firma i rola pochodzą z sesji (`requireUserAndActiveOrg`), zapis i odczyt
 * idą klientem sesji, więc te same reguły egzekwuje baza (RLS i granty 00179).
 * Token powstaje jak w portalu księgowej (`generateAccountantToken`: 32 losowe
 * bajty): do bazy idzie tylko skrót, a adres z tokenem wraca do przeglądarki
 * raz, w odpowiedzi tej akcji. Audyt zapisuje identyfikator linku, nigdy token.
 *
 * Bez ponowień w tle: dwa kliknięcia „Utwórz link” dają dwa linki, z których
 * działa tylko ostatni (pierwszy cofa drugie wywołanie); wyścig dwóch okien
 * kończy UNIQUE żywego linku w bazie z komunikatem dla klienta.
 */

export type GetBuyerLinkResult = { success: true; link: BuyerLinkState | null } | { success: false; error: string };
export type CreateBuyerLinkResult = { success: true; url: string; link: BuyerLinkState } | { success: false; error: string };
export type RevokeBuyerLinkResult = { success: true } | { success: false; error: string };

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const idSchema = z.string().regex(UUID_SHAPE);

const LINK_COLUMNS = 'id, created_at, expires_at, revoked_at, open_count, last_opened_at';
const INVOICE_COLUMNS = 'id, internal_number, direction, origin, ksef_status, invoice_kind, ksef_number, ksef_environment, xml_storage_path';

interface LinkRow {
  id: string;
  created_at: string;
  expires_at: string;
  revoked_at?: string | null;
  open_count?: number | null;
  last_opened_at?: string | null;
}

/** Tabela 00179 nie jest jeszcze w `types/database.ts` (typy z produkcji po wgraniu migracji). */
function links(supabase: AuthContext['supabase']) {
  return (supabase as unknown as SupabaseClient).from('invoice_share_links');
}

function toState(row: LinkRow): BuyerLinkState {
  const revokedAt = row.revoked_at ?? null;
  return {
    id: row.id,
    status: buyerLinkStatus({ revoked_at: revokedAt, expires_at: row.expires_at }),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt,
    openCount: Number(row.open_count ?? 0),
    lastOpenedAt: row.last_opened_at ?? null,
  };
}

async function editorContext(): Promise<{ ok: true; ctx: AuthContext } | { ok: false; error: string }> {
  try {
    const ctx = await requireUserAndActiveOrg();
    if (!canManageBuyerLinks(ctx.role)) return { ok: false, error: BUYER_LINK_TEXTS.ROLE };
    return { ok: true, ctx };
  } catch (err) {
    if (err instanceof ActionAuthError) return { ok: false, error: err.message };
    throw err;
  }
}

/** Ostatni link faktury (aktywny, wygasły albo cofnięty) do panelu w karcie faktury. */
export async function getBuyerLinkAction(invoiceId: string): Promise<GetBuyerLinkResult> {
  if (!idSchema.safeParse(invoiceId).success) return { success: false, error: BUYER_LINK_TEXTS.NOT_FOUND };
  const auth = await editorContext();
  if (!auth.ok) return { success: false, error: auth.error };
  const { supabase, tenantId } = auth.ctx;

  const { data, error } = await links(supabase)
    .select(LINK_COLUMNS)
    .eq('tenant_id', tenantId)
    .eq('invoice_id', invoiceId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return { success: false, error: BUYER_LINK_TEXTS.READ_FAILED };
  return { success: true, link: data ? toState(data as LinkRow) : null };
}

/**
 * Nowy link do faktury. Poprzedni żywy link tej faktury najpierw przestaje
 * działać (na fakturę jeden link niecofnięty, indeks w 00179), z audytem.
 */
export async function createBuyerLinkAction(invoiceId: string): Promise<CreateBuyerLinkResult> {
  if (!idSchema.safeParse(invoiceId).success) return { success: false, error: BUYER_LINK_TEXTS.NOT_FOUND };
  const auth = await editorContext();
  if (!auth.ok) return { success: false, error: auth.error };
  const { supabase, tenantId, user } = auth.ctx;

  const { data: invoice, error: invoiceError } = await supabase
    .from('invoices')
    .select(INVOICE_COLUMNS)
    .eq('id', invoiceId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (invoiceError) return { success: false, error: BUYER_LINK_TEXTS.READ_FAILED };
  if (!invoice) return { success: false, error: BUYER_LINK_TEXTS.NOT_FOUND };
  const facts = invoice as unknown as BuyerLinkInvoiceFacts;

  // Skrót pliku wysłanego do KSeF: bez niego PDF nie ma kodu QR, a nabywca nie dostanie XML.
  let xmlHash = false;
  if (facts.xml_storage_path) {
    const { data: xml, error: xmlError } = await supabase
      .from('xml_documents')
      .select('sha256_hash')
      .eq('tenant_id', tenantId)
      .eq('invoice_id', invoiceId)
      .eq('storage_path', facts.xml_storage_path)
      .maybeSingle();
    if (xmlError) return { success: false, error: BUYER_LINK_TEXTS.READ_FAILED };
    xmlHash = /^[0-9a-f]{64}$/i.test((xml as { sha256_hash?: string | null } | null)?.sha256_hash ?? '');
  }

  const environment = configuredKsefEnvironment();
  if (!environment) return { success: false, error: BUYER_LINK_TEXTS.ENVIRONMENT_MISSING };
  const refusal = buyerLinkRefusal(facts, environment, { xmlHash });
  if (refusal) return { success: false, error: refusal };

  const { data: replaced, error: replaceError } = await links(supabase)
    .update({ revoked_at: new Date().toISOString() })
    .eq('tenant_id', tenantId)
    .eq('invoice_id', invoiceId)
    .is('revoked_at', null)
    .select('id');
  if (replaceError) return { success: false, error: BUYER_LINK_TEXTS.CREATE_FAILED };
  for (const row of (replaced ?? []) as Array<{ id: string }>) {
    await logAudit({
      action: 'invoice.share_link_revoked',
      tenantId,
      userId: user.id,
      entityType: 'invoice',
      entityId: invoiceId,
      metadata: { linkId: row.id, reason: 'replaced', internalNumber: facts.internal_number },
    });
  }

  const { token, hash } = generateAccountantToken();
  const { data: created, error: insertError } = await links(supabase)
    .insert({ tenant_id: tenantId, invoice_id: invoiceId, token_hash: hash })
    .select(LINK_COLUMNS)
    .single();
  if (insertError || !created) {
    return {
      success: false,
      error: insertError?.code === '23505' ? BUYER_LINK_TEXTS.CREATE_RACE : BUYER_LINK_TEXTS.CREATE_FAILED,
    };
  }

  const link = toState(created as LinkRow);
  await logAudit({
    action: 'invoice.share_link_created',
    tenantId,
    userId: user.id,
    entityType: 'invoice',
    entityId: invoiceId,
    metadata: { linkId: link.id, expiresAt: link.expiresAt, internalNumber: facts.internal_number },
  });

  return { success: true, url: `${siteUrl()}${buyerInvoicePath(token)}`, link };
}

/** Cofnięcie linku: od tej chwili nabywca widzi „link nie działa”. */
export async function revokeBuyerLinkAction(linkId: string): Promise<RevokeBuyerLinkResult> {
  if (!idSchema.safeParse(linkId).success) return { success: false, error: BUYER_LINK_TEXTS.REVOKE_GONE };
  const auth = await editorContext();
  if (!auth.ok) return { success: false, error: auth.error };
  const { supabase, tenantId, user } = auth.ctx;

  const { data, error } = await links(supabase)
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', linkId)
    .eq('tenant_id', tenantId)
    .is('revoked_at', null)
    .select('id, invoice_id');
  if (error) return { success: false, error: BUYER_LINK_TEXTS.REVOKE_FAILED };
  const row = ((data ?? []) as Array<{ id: string; invoice_id: string }>)[0];
  if (!row) return { success: false, error: BUYER_LINK_TEXTS.REVOKE_GONE };

  await logAudit({
    action: 'invoice.share_link_revoked',
    tenantId,
    userId: user.id,
    entityType: 'invoice',
    entityId: row.invoice_id,
    metadata: { linkId: row.id, reason: 'manual' },
  });
  return { success: true };
}

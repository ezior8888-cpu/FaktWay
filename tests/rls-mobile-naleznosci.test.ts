import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { createMobileDbClient } from '@/lib/api/mobile/db';
import { markInvoicePaid, undoInvoicePaid } from '@/lib/invoices/mark-paid';
import { loadOverdueOverview } from '@/lib/overdue/load-overdue';
import { setInvoiceRemindersPaused } from '@/lib/reminders/pause';
import type { Database } from '@/types/database';

import { getRlsTestEnvironment } from './helpers/rls-environment';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/cache/invalidation', () => ({ invalidateTenantDashboard: vi.fn() }));
vi.mock('@/lib/analytics/server', () => ({ trackServer: vi.fn() }));
vi.mock('@/lib/jobs/enqueue', () => ({ sendJobEvent: vi.fn(async () => ({ ids: [] })) }));
vi.mock('@/lib/webhooks/emit', () => ({ emitWebhookEvent: vi.fn() }));

/**
 * Plan aplikacji mobilnej, M10a (bez migracji) na prawdziwym GoTrue i PostgREST.
 *
 * Telefon woła te same funkcje z `lib/` co strona, ale klientem z tokenem sesji
 * i nagłówkiem `x-active-org` (jak trasy `/api/mobile/v1`), bez ciasteczek:
 *  1. zapłata i cofnięcie (RPC 00158): członek firmy oznacza i cofa,
 *     ponowienie nic nie dopisuje; księgowa i konto spoza firmy dostają
 *     odmowę w bazie, także gdyby trasa jej nie sprawdziła;
 *  2. wstrzymanie przypomnień (RPC z 00074) w aktywnej firmie tokenu;
 *  3. lista „Po terminie” (`loadOverdueOverview`, widok `invoices_overdue`
 *     z `security_invoker`) widzi tylko faktury firmy z nagłówka.
 */

const hasDatabase = Boolean(
  process.env.RLS_TEST_SUPABASE_URL?.trim() &&
    process.env.RLS_TEST_SUPABASE_ANON_KEY?.trim() &&
    process.env.RLS_TEST_SUPABASE_SERVICE_ROLE_KEY?.trim(),
);
const environment = hasDatabase ? getRlsTestEnvironment() : null;
const admin: SupabaseClient = environment
  ? createClient(environment.url, environment.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })
  : (null as unknown as SupabaseClient);
const target = environment ? { url: environment.url, anonKey: environment.anonKey } : {};

const RUN = Date.now().toString(36);
const EMAILS = {
  member: `rls-m10-czlonek-${RUN}@ksef-saas.test`,
  accountant: `rls-m10-ksiegowa-${RUN}@ksef-saas.test`,
  stranger: `rls-m10-obcy-${RUN}@ksef-saas.test`,
};
const PASS = 'RlsMobileM10Pass2026Aa!';
const NIP = '1234567890';

const ORG_A = '000a1000-0000-4000-8000-000000000001';
const ORG_B = '000a1000-0000-4000-8000-000000000002';
const INV_A = '000a1000-1000-4000-8000-000000000001';
const INV_A2 = '000a1000-1000-4000-8000-000000000002';
const INV_B = '000a1000-1000-4000-8000-000000000003';

function warsawToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw' }).format(new Date());
}
function daysAgo(days: number): string {
  const d = new Date(`${warsawToday()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

async function createUser(email: string): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASS, email_confirm: true });
  if (error || !data.user) throw error ?? new Error('createUser');
  return data.user.id;
}

async function tokenOf(email: string): Promise<string> {
  const client = createClient(environment!.url, environment!.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data, error } = await client.auth.signInWithPassword({ email, password: PASS });
  if (error || !data.session) throw error ?? new Error('signIn');
  return data.session.access_token;
}

/** Faktura sprzedaży przyjęta w KSeF TEST, 12 dni po terminie, 1230 zł brutto. */
function invoice(id: string, tenantId: string, n: number) {
  const number = `FV/M10/${RUN}/${n}`;
  return {
    id, tenant_id: tenantId, direction: 'outgoing', origin: 'app', internal_number: number,
    invoice_type: 'VAT', invoice_kind: 'regular', issue_date: daysAgo(30), payment_due_date: daysAgo(12),
    seller_nip: NIP, buyer_nip: NIP, gross_total: 1230, net_total: 1000, vat_total: 230, currency: 'PLN',
    fa3_data: { internalNumber: number, type: 'VAT' }, seller_data: { nip: NIP },
    buyer_data: { nip: NIP, name: 'Nabywca M10', email: 'nabywca@example.test' },
    ksef_status: 'accepted', ksef_environment: 'test', xml_storage_path: 'x.xml',
    ksef_number: `${NIP}-20261001-${String(n).padStart(12, '0')}-0${n}`,
  };
}

async function invoiceState(id: string) {
  const { data, error } = await admin.from('invoices').select('payment_status, paid_amount, reminders_paused').eq('id', id).single();
  if (error) throw error;
  return data as { payment_status: string; paid_amount: number; reminders_paused: boolean };
}

async function paymentsOf(id: string): Promise<number> {
  const { count, error } = await admin.from('payments').select('id', { count: 'exact', head: true }).eq('invoice_id', id).is('voided_at', null);
  if (error) throw error;
  return count ?? 0;
}

describe.skipIf(!hasDatabase)('M10a: należności z telefonu na bazie (token i x-active-org)', () => {
  const ids = { member: '', accountant: '', stranger: '' };
  let member: SupabaseClient;
  let accountant: SupabaseClient;
  let strangerInA: SupabaseClient;

  beforeAll(async () => {
    ids.member = await createUser(EMAILS.member);
    ids.accountant = await createUser(EMAILS.accountant);
    ids.stranger = await createUser(EMAILS.stranger);
    const { error: tenantsError } = await admin.from('tenants').upsert([
      { id: ORG_A, nip: NIP, name: 'Firma M10 A', address_json: { countryCode: 'PL', addressLine1: 'ul. A 1', addressLine2: '00-001 Warszawa' } },
      { id: ORG_B, nip: NIP, name: 'Firma M10 B', address_json: { countryCode: 'PL', addressLine1: 'ul. B 2', addressLine2: '00-002 Warszawa' } },
    ], { onConflict: 'id' });
    if (tenantsError) throw tenantsError;
    await admin.from('users').upsert([
      { id: ids.member, name: 'Członek' }, { id: ids.accountant, name: 'Księgowa' }, { id: ids.stranger, name: 'Obcy' },
    ], { onConflict: 'id' });
    const { error: membershipsError } = await admin.from('memberships').insert([
      { organization_id: ORG_A, user_id: ids.member, role: 'member', status: 'active' },
      { organization_id: ORG_A, user_id: ids.accountant, role: 'accountant', status: 'active' },
      { organization_id: ORG_B, user_id: ids.stranger, role: 'owner', status: 'active' },
    ]);
    if (membershipsError) throw membershipsError;
    const { error: invoicesError } = await admin.from('invoices').insert([invoice(INV_A, ORG_A, 1), invoice(INV_A2, ORG_A, 2), invoice(INV_B, ORG_B, 3)]);
    if (invoicesError) throw invoicesError;

    const [tMember, tAccountant, tStranger] = await Promise.all([tokenOf(EMAILS.member), tokenOf(EMAILS.accountant), tokenOf(EMAILS.stranger)]);
    member = createMobileDbClient(tMember, { activeOrg: ORG_A, target });
    accountant = createMobileDbClient(tAccountant, { activeOrg: ORG_A, target });
    // Konto obcej firmy z nagłówkiem firmy A: bramka da 403, ale baza też nie może przepuścić.
    strangerInA = createMobileDbClient(tStranger, { activeOrg: ORG_A, target });
  });

  afterAll(async () => {
    await admin.from('payments').delete().in('invoice_id', [INV_A, INV_A2, INV_B]);
    await admin.from('invoices').delete().in('tenant_id', [ORG_A, ORG_B]);
    await admin.from('memberships').delete().in('organization_id', [ORG_A, ORG_B]);
    for (const id of Object.values(ids)) if (id) await admin.auth.admin.deleteUser(id).catch(() => null);
  });

  it('lista „Po terminie” klientem z tokenem: faktury firmy z nagłówka, bez faktur innej firmy', async () => {
    const overview = await loadOverdueOverview(member as unknown as SupabaseClient<Database>, ORG_A, 'test');
    expect(overview.ok).toBe(true);
    if (!overview.ok) return;
    const visible = overview.invoices.map((i) => i.id).sort();
    expect(visible).toEqual([INV_A, INV_A2].sort());
    expect(overview.invoices.find((i) => i.id === INV_A)).toMatchObject({ amount_due: 1230, days_overdue: 12, reminders_paused: false, reminder_status: 'none' });
  });

  it('członek firmy: zapłata, ponowienie bez drugiej wpłaty, cofnięcie i drugie cofnięcie bez zmian', async () => {
    const actor = { supabase: member, tenantId: ORG_A, userId: ids.member, role: 'member' as const };
    expect(await markInvoicePaid(actor, INV_A)).toMatchObject({ success: true, status: 'marked', amount: 1230 });
    expect(await invoiceState(INV_A)).toMatchObject({ payment_status: 'paid' });
    expect(await markInvoicePaid(actor, INV_A)).toMatchObject({ success: true, status: 'already_paid' });
    expect(await paymentsOf(INV_A)).toBe(1);

    expect(await undoInvoicePaid(actor, INV_A)).toEqual({ success: true, status: 'undone' });
    expect(await undoInvoicePaid(actor, INV_A)).toEqual({ success: true, status: 'nothing_to_undo' });
    expect(await invoiceState(INV_A)).toMatchObject({ payment_status: 'overdue', paid_amount: 0 });
  });

  it('księgowa: baza odmawia zapłaty, nawet gdy trasa by jej nie zatrzymała', async () => {
    const result = await markInvoicePaid({ supabase: accountant, tenantId: ORG_A, userId: ids.accountant, role: 'accountant' }, INV_A2);
    expect(result.success).toBe(false);
    expect(await invoiceState(INV_A2)).toMatchObject({ payment_status: 'overdue', paid_amount: 0 });
    expect(await paymentsOf(INV_A2)).toBe(0);
  });

  it('konto spoza firmy z jej nagłówkiem: zapłata i wstrzymanie nie przechodzą', async () => {
    const result = await markInvoicePaid({ supabase: strangerInA, tenantId: ORG_A, userId: ids.stranger, role: 'owner' }, INV_A2);
    expect(result.success).toBe(false);
    expect(await setInvoiceRemindersPaused(strangerInA, INV_A2, true)).toMatchObject({ success: false });
    expect(await invoiceState(INV_A2)).toMatchObject({ payment_status: 'overdue', paid_amount: 0, reminders_paused: false });
  });

  it('wstrzymanie i wznowienie przypomnień w aktywnej firmie tokenu', async () => {
    expect(await setInvoiceRemindersPaused(member, INV_A2, true)).toEqual({ success: true });
    expect(await invoiceState(INV_A2)).toMatchObject({ reminders_paused: true });
    // Ponowienie ustawia ten sam stan.
    expect(await setInvoiceRemindersPaused(member, INV_A2, true)).toEqual({ success: true });
    expect(await setInvoiceRemindersPaused(member, INV_A2, false)).toEqual({ success: true });
    expect(await invoiceState(INV_A2)).toMatchObject({ reminders_paused: false });
    // Faktura innej firmy z nagłówkiem firmy A: RPC jej nie widzi.
    expect(await setInvoiceRemindersPaused(member, INV_B, true)).toMatchObject({ success: false });
    expect(await invoiceState(INV_B)).toMatchObject({ reminders_paused: false });
  });
});

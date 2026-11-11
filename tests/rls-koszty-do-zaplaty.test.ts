import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { getRlsTestEnvironment } from './helpers/rls-environment';

/**
 * Koszty do zapłaty (00177, plan kompletnej aplikacji, krok 3.4, część 1) na
 * prawdziwym Postgresie i PostgREST: RPC `mark_expense_paid`
 * i `undo_expense_paid` (idempotencja, blokada wiersza, dzień w Warszawie,
 * role, obca firma, audyt w tej samej transakcji), wyzwalacz
 * `a_guard_expense_payment` (sesja nie zmienia kolumn płatności wprost)
 * i odczyt listy „Do zapłaty” przez RLS.
 */

const hasDatabase = Boolean(
  process.env.RLS_TEST_SUPABASE_URL?.trim() &&
    process.env.RLS_TEST_SUPABASE_ANON_KEY?.trim() &&
    process.env.RLS_TEST_SUPABASE_SERVICE_ROLE_KEY?.trim(),
);
const environment = hasDatabase ? getRlsTestEnvironment() : null;
const admin: SupabaseClient = environment
  ? createClient(environment.url, environment.serviceRoleKey)
  : (null as unknown as SupabaseClient);

const ORG_A = '00177177-0000-4000-8000-00000000000a';
const ORG_B = '00177177-0000-4000-8000-00000000000b';
const EMAILS = {
  owner: 'rls-koszty-zaplata-owner@ksef-saas.test',
  member: 'rls-koszty-zaplata-member@ksef-saas.test',
  accountant: 'rls-koszty-zaplata-ksiegowa@ksef-saas.test',
  obcy: 'rls-koszty-zaplata-obcy@ksef-saas.test',
} as const;
const PASS = 'RlsKosztyZaplata2026Aa!';
const NIP = '1234567890';

const users: Record<keyof typeof EMAILS, string> = { owner: '', member: '', accountant: '', obcy: '' };
let counter = 0;

function warsawToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw' }).format(new Date());
}

function shiftDays(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function anonClient(activeOrg?: string) {
  return createClient(environment!.url, environment!.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: activeOrg ? { headers: { 'x-active-org': activeOrg } } : undefined,
  });
}

async function userId(email: string): Promise<string> {
  for (let page = 1; page < 50; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const hit = data.users.find((u) => u.email?.toLowerCase() === email);
    if (hit) return hit.id;
    if (data.users.length < 1000) break;
  }
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASS, email_confirm: true });
  if (error || !data.user) throw error ?? new Error('createUser');
  return data.user.id;
}

async function signedIn(who: keyof typeof EMAILS, activeOrg: string = ORG_A): Promise<SupabaseClient> {
  const c = anonClient(activeOrg);
  const { error } = await c.auth.signInWithPassword({ email: EMAILS[who], password: PASS });
  if (error) throw error;
  return c;
}

/** Zwykły koszt (bez KSeF, żeby wiersz wstawił klucz serwisowy bez faktury), termin za 10 dni. */
async function koszt(fields: Record<string, unknown> = {}, org: string = ORG_A): Promise<string> {
  counter += 1;
  const id = `00177177-1111-4000-8000-${String(counter).padStart(12, '0')}`;
  const { error } = await admin.from('expenses').insert({
    id,
    tenant_id: org,
    created_by: org === ORG_A ? users.owner : users.obcy,
    source: 'manual',
    seller_name: `Dostawca ${counter}`,
    seller_nip: NIP,
    document_number: `FV/177/${counter}`,
    document_type: 'invoice',
    issue_date: '2026-11-01',
    net_amount: 1000,
    vat_amount: 230,
    gross_amount: 1230,
    payment_due_date: shiftDays(warsawToday(), 10),
    payment_account: '61109010140000071219812874',
    payment_split: false,
    payment_terms: { zrodlo: 'ksef_xml', odczytano: new Date().toISOString(), problemy: [] },
    ...fields,
  });
  if (error) throw new Error(`insert koszt ${counter}: ${error.message}`);
  return id;
}

async function stan(id: string) {
  const { data, error } = await admin.from('expenses').select('paid_at, payment_due_date, notes').eq('id', id).single();
  if (error) throw error;
  return data as { paid_at: string | null; payment_due_date: string | null; notes: string | null };
}

async function audyt(id: string) {
  const { data, error } = await admin
    .from('audit_logs')
    .select('tenant_id, user_id, action, entity_type, entity_id, metadata')
    .eq('entity_id', id)
    .in('action', ['expense.marked_paid', 'expense.paid_undone'])
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

async function cleanup() {
  for (const org of [ORG_A, ORG_B]) {
    await admin.from('expenses').delete().eq('tenant_id', org);
  }
}

describe.skipIf(!hasDatabase)('koszty do zapłaty (00177)', () => {
  beforeAll(async () => {
    for (const who of Object.keys(EMAILS) as Array<keyof typeof EMAILS>) {
      users[who] = await userId(EMAILS[who]);
    }
    await cleanup();
    await admin.from('memberships').delete().in('organization_id', [ORG_A, ORG_B]);
    // Wpisy audytu zostają po przebiegu (00052), więc firma też: upsert zamiast kasowania.
    const tenants = await admin.from('tenants').upsert([
      { id: ORG_A, nip: NIP, name: 'Firma A Koszty' },
      { id: ORG_B, nip: NIP, name: 'Firma B Koszty' },
    ], { onConflict: 'id' });
    if (tenants.error) throw tenants.error;
    const profiles = await admin.from('users').upsert(
      (Object.keys(users) as Array<keyof typeof EMAILS>).map((who) => ({ id: users[who], name: who })),
      { onConflict: 'id' },
    );
    if (profiles.error) throw profiles.error;
    const memberships = await admin.from('memberships').insert([
      { organization_id: ORG_A, user_id: users.owner, role: 'owner', status: 'active' },
      { organization_id: ORG_A, user_id: users.member, role: 'member', status: 'active' },
      { organization_id: ORG_A, user_id: users.accountant, role: 'accountant', status: 'active' },
      { organization_id: ORG_B, user_id: users.obcy, role: 'owner', status: 'active' },
    ]);
    if (memberships.error) throw memberships.error;
  });

  beforeEach(async () => {
    await cleanup();
  });

  afterAll(async () => {
    if (!hasDatabase) return;
    await cleanup();
    await admin.from('memberships').delete().in('organization_id', [ORG_A, ORG_B]);
  });

  it('oznaczenie: dzień dziś w Warszawie i jeden wpis audytu z kwotą i terminem', async () => {
    const id = await koszt();
    const c = await signedIn('owner');

    const { data, error } = await c.rpc('mark_expense_paid', { p_expense_id: id });

    expect(error).toBeNull();
    expect(data).toMatchObject({ status: 'marked', paid_on: warsawToday() });
    expect((await stan(id)).paid_at).toBe(warsawToday());
    const wpisy = await audyt(id);
    expect(wpisy).toHaveLength(1);
    expect(wpisy[0]).toMatchObject({
      tenant_id: ORG_A, user_id: users.owner, action: 'expense.marked_paid', entity_type: 'expense',
      metadata: expect.objectContaining({ paidOn: warsawToday(), customDate: false, amount: 1230 }),
    });
  });

  it('drugie wywołanie: „już zapłacony” bez zmiany dnia i bez drugiego wpisu audytu', async () => {
    const id = await koszt();
    const c = await signedIn('owner');
    const wczoraj = shiftDays(warsawToday(), -1);
    await c.rpc('mark_expense_paid', { p_expense_id: id, p_paid_on: wczoraj });

    const second = await c.rpc('mark_expense_paid', { p_expense_id: id });

    expect(second.error).toBeNull();
    expect(second.data).toMatchObject({ status: 'already_paid', paid_on: wczoraj });
    expect((await stan(id)).paid_at).toBe(wczoraj);
    expect(await audyt(id)).toHaveLength(1);
  });

  it('dwa dotknięcia naraz: jedno oznaczenie, jeden wpis audytu (blokada wiersza)', async () => {
    const id = await koszt();
    const c = await signedIn('owner');

    const results = await Promise.all([
      c.rpc('mark_expense_paid', { p_expense_id: id }),
      c.rpc('mark_expense_paid', { p_expense_id: id }),
    ]);

    expect(results.map((r) => (r.data as { status: string }).status).sort()).toEqual(['already_paid', 'marked']);
    expect(await audyt(id)).toHaveLength(1);
  });

  it('dzień z przyszłości i literówka w roku: odmowa bez zapisu', async () => {
    const id = await koszt();
    const c = await signedIn('owner');

    const jutro = await c.rpc('mark_expense_paid', { p_expense_id: id, p_paid_on: shiftDays(warsawToday(), 1) });
    const rok = await c.rpc('mark_expense_paid', { p_expense_id: id, p_paid_on: '0202-11-09' });

    expect(jutro.data).toMatchObject({ status: 'refused', code: 'future_date' });
    expect(rok.data).toMatchObject({ status: 'refused', code: 'invalid_date' });
    expect((await stan(id)).paid_at).toBeNull();
    expect(await audyt(id)).toEqual([]);
  });

  it('korekta na minus: nic do zapłaty', async () => {
    const id = await koszt({ gross_amount: -123, net_amount: -100, vat_amount: -23 });
    const c = await signedIn('owner');

    const { data } = await c.rpc('mark_expense_paid', { p_expense_id: id });

    expect(data).toMatchObject({ status: 'refused', code: 'nothing_to_pay' });
    expect((await stan(id)).paid_at).toBeNull();
  });

  it('cofnięcie: dzień znika, wpis audytu; drugie cofnięcie bez zmian', async () => {
    const id = await koszt();
    const c = await signedIn('member');
    await c.rpc('mark_expense_paid', { p_expense_id: id });

    const undo = await c.rpc('undo_expense_paid', { p_expense_id: id });
    const again = await c.rpc('undo_expense_paid', { p_expense_id: id });

    expect(undo.data).toMatchObject({ status: 'undone', paid_on: warsawToday() });
    expect(again.data).toMatchObject({ status: 'nothing_to_undo' });
    expect((await stan(id)).paid_at).toBeNull();
    expect((await audyt(id)).map((w) => w.action)).toEqual(['expense.marked_paid', 'expense.paid_undone']);
  });

  it('księgowa: odmowa (42501); obca firma: koszt wygląda jak brak kosztu', async () => {
    const id = await koszt();
    const ksiegowa = await signedIn('accountant');
    const obcy = await signedIn('obcy', ORG_B);

    const k = await ksiegowa.rpc('mark_expense_paid', { p_expense_id: id });
    const o = await obcy.rpc('mark_expense_paid', { p_expense_id: id });
    const ou = await obcy.rpc('undo_expense_paid', { p_expense_id: id });

    expect(k.error?.code).toBe('42501');
    expect(o.data).toMatchObject({ status: 'refused', code: 'not_found' });
    expect(ou.data).toMatchObject({ status: 'refused', code: 'not_found' });
    expect((await stan(id)).paid_at).toBeNull();
  });

  it('sesja nie zmienia kolumn płatności wprost (wyzwalacz), a zwykła edycja kosztu działa dalej', async () => {
    const id = await koszt();
    const c = await signedIn('owner');

    const paid = await c.from('expenses').update({ paid_at: warsawToday() }).eq('id', id);
    const due = await c.from('expenses').update({ payment_due_date: '2026-01-01' }).eq('id', id);
    const notes = await c.from('expenses').update({ notes: 'opisany' }).eq('id', id);

    expect(paid.error?.code).toBe('42501');
    expect(due.error?.code).toBe('42501');
    expect(notes.error).toBeNull();
    expect(await stan(id)).toMatchObject({ paid_at: null, notes: 'opisany' });
  });

  it('lista „Do zapłaty” przez RLS: tylko niezapłacone z terminem własnej firmy, od najbliższego terminu', async () => {
    const pozniej = await koszt({ payment_due_date: shiftDays(warsawToday(), 20) });
    const wczesniej = await koszt({ payment_due_date: shiftDays(warsawToday(), -3) });
    await koszt({ payment_due_date: null });
    await koszt({ paid_at: shiftDays(warsawToday(), -1) });
    await koszt({}, ORG_B);
    const c = await signedIn('owner');

    const { data, error } = await c
      .from('expenses')
      .select('id, payment_due_date, paid_at')
      .eq('tenant_id', ORG_A)
      .is('paid_at', null)
      .not('payment_due_date', 'is', null)
      .order('payment_due_date', { ascending: true });

    expect(error).toBeNull();
    expect((data ?? []).map((r) => r.id)).toEqual([wczesniej, pozniej]);
  });
});

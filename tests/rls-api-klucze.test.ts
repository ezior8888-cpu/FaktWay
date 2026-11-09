import { createHmac } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { createApiKeyDbClient } from '@/lib/api/v1/db';
import { listExpenses, parseExpenseListQuery } from '@/lib/api/v1/expenses';
import { listInvoices, parseInvoiceListQuery, readInvoice } from '@/lib/api/v1/invoices';
import { generateApiKey } from '@/lib/api/v1/keys';
import { mintApiKeyToken } from '@/lib/api/v1/token';

import { getRlsTestEnvironment } from './helpers/rls-environment';

/**
 * 00181 na prawdziwym PostgREST: klucze API firmy (krok 7.1 planu kompletnej
 * aplikacji, część 1).
 *
 * - `api_keys`: tworzą i odwołują tylko właściciel i administrator swojej firmy,
 *   autor i daty z bazy, skrót niewidoczny dla klienta, odwołanie nieodwracalne,
 *   każda zmiana w `audit_logs` (wyzwalacz).
 * - Rola `api_key_client` (token z aplikacji ze skrótem klucza): widzi wiersze
 *   tylko firmy klucza, tylko w jego zakresie i tylko do odwołania; nie widzi
 *   innych tabel ani kolumn spoza listy i niczego nie zapisuje.
 * - `api_key_session()` zapisuje użycie klucza w `audit_logs`.
 *
 * Token podpisuje sekret JWT lokalnej bazy z `supabase status` (scripts/ci/rls-local.sh).
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
const JWT_SECRET = process.env.RLS_TEST_SUPABASE_JWT_SECRET?.trim() ?? '';

const ORG = '00181181-0000-4000-8000-000000000001';
const OTHER_ORG = '00181181-0000-4000-8000-000000000002';
const OWNER_EMAIL = 'rls-api-owner@ksef-saas.test';
const ADMIN_EMAIL = 'rls-api-admin@ksef-saas.test';
const MEMBER_EMAIL = 'rls-api-member@ksef-saas.test';
const OTHER_EMAIL = 'rls-api-other@ksef-saas.test';
const PASS = 'RlsApiKluczePass2026Aa!';

const INV_OUT = '00181181-1000-4000-8000-000000000001';
const INV_IN = '00181181-1000-4000-8000-000000000002';
const INV_DRAFT = '00181181-1000-4000-8000-000000000003';
const INV_OTHER = '00181181-1000-4000-8000-000000000004';
const EXP_KSEF = '00181181-2000-4000-8000-000000000001';
const EXP_MANUAL = '00181181-2000-4000-8000-000000000002';
const EXP_OTHER = '00181181-2000-4000-8000-000000000003';

let ownerId = '';
let adminId = '';
let otherId = '';

const keys = {
  all: generateApiKey(),
  invoicesOnly: generateApiKey(),
  expensesOnly: generateApiKey(),
  other: generateApiKey(),
};
const keyIds: Record<keyof typeof keys, string> = { all: '', invoicesOnly: '', expensesOnly: '', other: '' };

function sessionClient(activeOrg: string) {
  return createClient(environment!.url, environment!.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { 'x-active-org': activeOrg } },
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

/** Jedna sesja na (konto, firmę) w całym pliku: mniej logowań do GoTrue. */
const sessions = new Map<string, Promise<SupabaseClient>>();
function signedIn(email: string, org: string): Promise<SupabaseClient> {
  const cacheKey = `${email}|${org}`;
  let session = sessions.get(cacheKey);
  if (!session) {
    session = (async () => {
      const client = sessionClient(org);
      const { error } = await client.auth.signInWithPassword({ email, password: PASS });
      if (error) throw error;
      return client;
    })();
    sessions.set(cacheKey, session);
  }
  return session;
}

/** Klient bazy tak jak w trasie `/api/v1`: token z aplikacji dla skrótu klucza. */
function apiDb(keyHash: string): SupabaseClient {
  return createApiKeyDbClient(mintApiKeyToken(keyHash, JWT_SECRET), {
    url: environment!.url,
    anonKey: environment!.anonKey,
  });
}

/** Dowolny token HS256 (podróbki: inna rola, brak skrótu, zły sekret, wygasły). */
function forgedDb(claims: Record<string, unknown>, secret = JWT_SECRET): SupabaseClient {
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const head = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ aud: 'authenticated', iat: now, exp: now + 60, ...claims })}`;
  const token = `${head}.${createHmac('sha256', secret).update(head).digest('base64url')}`;
  return createApiKeyDbClient(token, { url: environment!.url, anonKey: environment!.anonKey });
}

async function ids(query: PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<string[]> {
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return ((data ?? []) as { id: string }[]).map((row) => row.id).sort();
}

const baseInvoice = {
  invoice_type: 'VAT', invoice_kind: 'regular', seller_nip: '1234567890', buyer_nip: '1234567890',
  payment_due_date: '2026-11-30', currency: 'PLN',
};

async function sprzataj() {
  for (const org of [ORG, OTHER_ORG]) {
    await admin.from('api_keys').delete().eq('tenant_id', org);
    await admin.from('expenses').delete().eq('tenant_id', org);
    await admin.from('invoice_line_items').delete().in('invoice_id', [INV_OUT, INV_IN, INV_DRAFT, INV_OTHER]);
    await admin.from('invoices').delete().eq('tenant_id', org);
    await admin.from('memberships').delete().eq('organization_id', org);
  }
}

describe.skipIf(!hasDatabase)('00181: klucze API i rola api_key_client na prawdziwym PostgREST', () => {
  beforeAll(async () => {
    if (!JWT_SECRET) throw new Error('RLS_TEST_SUPABASE_JWT_SECRET: brak sekretu JWT lokalnej bazy (scripts/ci/rls-local.sh)');
    ownerId = await userId(OWNER_EMAIL);
    adminId = await userId(ADMIN_EMAIL);
    const memberId = await userId(MEMBER_EMAIL);
    otherId = await userId(OTHER_EMAIL);
    await sprzataj();
    const { error: tErr } = await admin.from('tenants').upsert([
      { id: ORG, nip: '1234567890', name: 'Firma API 00181' },
      { id: OTHER_ORG, nip: '1234567890', name: 'Inna firma API 00181' },
    ], { onConflict: 'id' });
    if (tErr) throw tErr;
    await admin.from('users').upsert(
      [{ id: ownerId, name: 'Owner' }, { id: adminId, name: 'Admin' }, { id: memberId, name: 'Member' }, { id: otherId, name: 'Other' }],
      { onConflict: 'id' },
    );
    const { error: mErr } = await admin.from('memberships').insert([
      { organization_id: ORG, user_id: ownerId, role: 'owner', status: 'active' },
      { organization_id: ORG, user_id: adminId, role: 'admin', status: 'active' },
      { organization_id: ORG, user_id: memberId, role: 'member', status: 'active' },
      { organization_id: OTHER_ORG, user_id: otherId, role: 'owner', status: 'active' },
    ]);
    if (mErr) throw mErr;

    const { error: iErr } = await admin.from('invoices').insert([
      {
        ...baseInvoice, id: INV_OUT, tenant_id: ORG, direction: 'outgoing', internal_number: 'FV/1/11/2026',
        issue_date: '2026-11-02', sale_date: '2026-11-02', net_total: 1000, vat_total: 230.5, gross_total: 1230.5,
        ksef_status: 'accepted', ksef_environment: 'test', xml_storage_path: 'x.xml',
        ksef_number: '1234567890-20261102-018118100001-01',
        fa3_data: { internalNumber: 'FV/1/11/2026' },
        seller_data: { nip: '1234567890', name: 'Firma API 00181' },
        buyer_data: { nip: '1234567890', name: 'Nabywca 00181' },
      },
      {
        ...baseInvoice, id: INV_IN, tenant_id: ORG, direction: 'incoming', origin: 'ksef_inbox', internal_number: 'ZEW/7/2026',
        issue_date: '2026-11-01', net_total: 100, vat_total: 0, gross_total: 100, currency: 'EUR',
        ksef_status: 'received', ksef_environment: 'test', ksef_number: '1234567890-20261101-018118100002-02',
        fa3_data: { seller: { name: 'Dostawca z KSeF', nip: '1234567890' } },
      },
      {
        ...baseInvoice, id: INV_DRAFT, tenant_id: ORG, direction: 'outgoing', internal_number: 'FV/2/10/2026',
        issue_date: '2026-10-15', net_total: 10, vat_total: 2.3, gross_total: 12.3, ksef_status: 'draft',
        fa3_data: { internalNumber: 'FV/2/10/2026' }, buyer_data: { name: 'Nabywca szkicu', pesel: '99999999999' },
      },
      {
        ...baseInvoice, id: INV_OTHER, tenant_id: OTHER_ORG, direction: 'outgoing', internal_number: 'FV/OBCA/2026',
        issue_date: '2026-11-02', net_total: 1, vat_total: 0.23, gross_total: 1.23, ksef_status: 'draft',
        fa3_data: { internalNumber: 'FV/OBCA/2026' },
      },
    ]);
    if (iErr) throw new Error(`invoices: ${iErr.message}`);
    const { error: lErr } = await admin.from('invoice_line_items').insert([
      { invoice_id: INV_DRAFT, ordinal: 1, name: 'Pozycja szkicu', quantity: 2, unit: 'szt.', unit_price_net: 5, net_amount: 10, vat_rate: '23', vat_amount: 2.3, gross_amount: 12.3 },
      { invoice_id: INV_OTHER, ordinal: 1, name: 'Cudza pozycja', quantity: 1, unit: 'szt.', unit_price_net: 1, net_amount: 1, vat_rate: '23', vat_amount: 0.23, gross_amount: 1.23 },
    ]);
    if (lErr) throw new Error(`invoice_line_items: ${lErr.message}`);
    const { error: eErr } = await admin.from('expenses').insert([
      {
        id: EXP_KSEF, tenant_id: ORG, created_by: ownerId, source: 'ksef_inbox', ksef_invoice_id: INV_IN,
        seller_name: 'Dostawca z KSeF', issue_date: '2026-11-01', net_amount: 100, vat_amount: 0, gross_amount: 100,
        is_deductible: false, is_reviewed: false,
        ocr_extracted_data: { source: 'ksef_inbox', currency: 'EUR', net_amount: 100, gross_amount: 100, fx: null },
      },
      {
        id: EXP_MANUAL, tenant_id: ORG, created_by: ownerId, source: 'manual', seller_name: 'Sklep',
        issue_date: '2026-11-05', net_amount: 100, vat_amount: 23, gross_amount: 123, vat_deductible_amount: 23, is_reviewed: true,
      },
      {
        id: EXP_OTHER, tenant_id: OTHER_ORG, created_by: otherId, source: 'manual', seller_name: 'Obcy sklep',
        issue_date: '2026-11-05', net_amount: 1, vat_amount: 0, gross_amount: 1,
      },
    ]);
    if (eErr) throw new Error(`expenses: ${eErr.message}`);
  });

  afterAll(async () => {
    if (!hasDatabase) return;
    // Wpisy audytu zostają (append-only, 00052); firmy z nimi też, `upsert` je przyjmie.
    await sprzataj();
  });

  const row = (key: ReturnType<typeof generateApiKey>, tenantId: string, scopes: string[], name: string) => ({
    tenant_id: tenantId, name, key_prefix: key.prefix, key_hash: key.hash, scopes,
  });

  it('właściciel i administrator tworzą klucz; autor i daty z bazy, audyt api_key.created', async () => {
    const owner = await signedIn(OWNER_EMAIL, ORG);
    const created = await owner.from('api_keys').insert(row(keys.all, ORG, ['invoices:read', 'expenses:read'], 'Program')).select('id').single();
    expect(created.error).toBeNull();
    keyIds.all = created.data!.id as string;
    const expensesOnly = await owner.from('api_keys').insert(row(keys.expensesOnly, ORG, ['expenses:read'], 'Koszty')).select('id').single();
    expect(expensesOnly.error).toBeNull();
    keyIds.expensesOnly = expensesOnly.data!.id as string;

    const adminClient = await signedIn(ADMIN_EMAIL, ORG);
    const byAdmin = await adminClient.from('api_keys').insert(row(keys.invoicesOnly, ORG, ['invoices:read'], 'Faktury')).select('id').single();
    expect(byAdmin.error).toBeNull();
    keyIds.invoicesOnly = byAdmin.data!.id as string;

    const other = await signedIn(OTHER_EMAIL, OTHER_ORG);
    const otherKey = await other.from('api_keys').insert(row(keys.other, OTHER_ORG, ['invoices:read', 'expenses:read'], 'Obcy')).select('id').single();
    expect(otherKey.error).toBeNull();
    keyIds.other = otherKey.data!.id as string;

    const stored = await admin.from('api_keys').select('created_by, created_at, last_used_at, revoked_at, revoked_by, key_hash').eq('id', keyIds.all).single();
    expect(stored.data).toMatchObject({ created_by: ownerId, last_used_at: null, revoked_at: null, revoked_by: null, key_hash: keys.all.hash });

    const audit = await admin.from('audit_logs').select('user_id, metadata').eq('action', 'api_key.created').eq('entity_id', keyIds.all);
    expect(audit.data).toEqual([{ user_id: ownerId, metadata: expect.objectContaining({ name: 'Program', key_prefix: keys.all.prefix, scopes: ['invoices:read', 'expenses:read'] }) }]);
  });

  it('członek i obca firma nie tworzą klucza; autora, dat i odwołania nie podstawi klient; CHECK-i', async () => {
    const extra = generateApiKey();
    const member = await signedIn(MEMBER_EMAIL, ORG);
    expect((await member.from('api_keys').insert(row(extra, ORG, ['invoices:read'], 'X'))).error?.message).toMatch(/row-level security/);
    const other = await signedIn(OTHER_EMAIL, OTHER_ORG);
    expect((await other.from('api_keys').insert(row(extra, ORG, ['invoices:read'], 'X'))).error?.message).toMatch(/row-level security/);
    const otherAsOrg = await signedIn(OTHER_EMAIL, ORG);
    expect((await otherAsOrg.from('api_keys').insert(row(extra, ORG, ['invoices:read'], 'X'))).error?.message).toMatch(/row-level security/);

    const owner = await signedIn(OWNER_EMAIL, ORG);
    for (const forged of [{ created_by: otherId }, { last_used_at: '2026-01-01T00:00:00Z' }, { revoked_at: '2026-01-01T00:00:00Z' }, { created_at: '2020-01-01T00:00:00Z' }]) {
      expect((await owner.from('api_keys').insert({ ...row(generateApiKey(), ORG, ['invoices:read'], 'X'), ...forged })).error?.message).toMatch(/permission denied/);
    }
    expect((await owner.from('api_keys').insert(row(generateApiKey(), ORG, ['invoices:write'], 'X'))).error?.message).toMatch(/api_keys_scopes_check/);
    expect((await owner.from('api_keys').insert(row(generateApiKey(), ORG, [], 'X'))).error?.message).toMatch(/api_keys_scopes_check/);
    expect((await owner.from('api_keys').insert({ ...row(generateApiKey(), ORG, ['invoices:read'], 'X'), key_hash: 'abc' })).error?.message).toMatch(/api_keys_key_hash_check/);
    expect((await owner.from('api_keys').insert(row(generateApiKey(), ORG, ['invoices:read'], '  '))).error?.message).toMatch(/api_keys_name_check/);
    // Ten sam skrót drugi raz: UNIQUE.
    expect((await owner.from('api_keys').insert(row(keys.all, ORG, ['invoices:read'], 'Duplikat'))).error?.code).toBe('23505');
  });

  it('listę kluczy czytają właściciel i administrator, bez skrótu; członek i obca firma nic', async () => {
    const owner = await signedIn(OWNER_EMAIL, ORG);
    expect(await ids(owner.from('api_keys').select('id').eq('tenant_id', ORG))).toEqual([keyIds.all, keyIds.expensesOnly, keyIds.invoicesOnly].sort());
    expect((await owner.from('api_keys').select('key_hash').eq('tenant_id', ORG)).error?.message).toMatch(/permission denied/);
    const adminClient = await signedIn(ADMIN_EMAIL, ORG);
    expect((await ids(adminClient.from('api_keys').select('id').eq('tenant_id', ORG))).length).toBe(3);
    const member = await signedIn(MEMBER_EMAIL, ORG);
    expect(await ids(member.from('api_keys').select('id'))).toEqual([]);
    const otherAsOrg = await signedIn(OTHER_EMAIL, ORG);
    expect(await ids(otherAsOrg.from('api_keys').select('id').eq('tenant_id', ORG))).toEqual([]);
  });

  it('klucz czyta tylko swoją firmę: faktury, pozycje i koszty, nawet z jawnym filtrem obcej firmy', async () => {
    const db = apiDb(keys.all.hash);
    const session = await db.rpc('api_key_session', { p_endpoint: 'GET /api/v1/invoices', p_request_id: 'rls-00181', p_ip: '203.0.113.7', p_user_agent: 'rls-test' });
    expect(session.error).toBeNull();
    expect(session.data).toEqual({ key_id: keyIds.all, tenant_id: ORG, scopes: ['invoices:read', 'expenses:read'], key_prefix: keys.all.prefix });

    expect(await ids(db.from('invoices').select('id'))).toEqual([INV_OUT, INV_IN, INV_DRAFT].sort());
    expect(await ids(db.from('invoices').select('id').eq('tenant_id', OTHER_ORG))).toEqual([]);
    expect(await ids(db.from('invoices').select('id').eq('id', INV_OTHER))).toEqual([]);
    expect(((await db.from('invoice_line_items').select('invoice_id')).data ?? []).map((r) => r.invoice_id)).toEqual([INV_DRAFT]);
    expect(await ids(db.from('expenses').select('id'))).toEqual([EXP_KSEF, EXP_MANUAL].sort());
    expect(await ids(db.from('expenses').select('id').eq('tenant_id', OTHER_ORG))).toEqual([]);

    const query = parseInvoiceListQuery(new URLSearchParams());
    if (!query.ok) throw new Error(query.message);
    const page = await listInvoices(db, ORG, query.value);
    expect(page.data.map((i) => i.id)).toEqual([INV_OUT, INV_IN, INV_DRAFT]);
    expect(page.data[0]).toMatchObject({ gross_total: '1230.50', vat_total: '230.50', net_total: '1000.00', paid_amount: '0.00', currency: 'PLN', seller: { name: 'Firma API 00181', nip: '1234567890' } });
    expect(page.data[1]).toMatchObject({ direction: 'incoming', currency: 'EUR', seller: { name: 'Dostawca z KSeF', nip: '1234567890' } });
    expect(JSON.stringify(page)).not.toContain('99999999999');
    expect((await listInvoices(db, OTHER_ORG, query.value)).data).toEqual([]);

    const detail = await readInvoice(db, ORG, INV_DRAFT);
    expect(detail?.items).toEqual([expect.objectContaining({ position: 1, name: 'Pozycja szkicu', net_amount: '10.00', vat_amount: '2.30', gross_amount: '12.30' })]);
    expect(await readInvoice(db, ORG, INV_OTHER)).toBeNull();
    expect(await readInvoice(db, OTHER_ORG, INV_OTHER)).toBeNull();

    const expensesQuery = parseExpenseListQuery(new URLSearchParams());
    if (!expensesQuery.ok) throw new Error(expensesQuery.message);
    const expenses = await listExpenses(db, ORG, expensesQuery.value);
    const byId = new Map(expenses.data.map((e) => [e.id, e]));
    expect(byId.get(EXP_KSEF)).toMatchObject({ currency: 'EUR', gross_amount: '100.00', review_status: 'unreviewed', invoice_id: INV_IN });
    expect(byId.get(EXP_MANUAL)).toMatchObject({ currency: 'PLN', gross_amount: '123.00', vat_amount: '23.00', review_status: 'reviewed' });
    const currencies = await db.rpc('api_expense_invoice_currencies', { p_expense_ids: [EXP_KSEF, EXP_OTHER] });
    expect(currencies.data).toEqual([{ expense_id: EXP_KSEF, currency: 'EUR' }]);

    const audit = await admin.from('audit_logs').select('tenant_id, user_id, ip_address, user_agent, metadata').eq('action', 'api_key.used').eq('entity_id', keyIds.all);
    expect(audit.data).toEqual([expect.objectContaining({
      tenant_id: ORG, user_id: null, ip_address: '203.0.113.7', user_agent: 'rls-test',
      metadata: expect.objectContaining({ endpoint: 'GET /api/v1/invoices', request_id: 'rls-00181', key_prefix: keys.all.prefix }),
    })]);
    const used = await admin.from('api_keys').select('last_used_at').eq('id', keyIds.all).single();
    expect(used.data?.last_used_at).not.toBeNull();

    // Obca firma swoim kluczem widzi tylko siebie.
    const otherDb = apiDb(keys.other.hash);
    expect(await ids(otherDb.from('invoices').select('id'))).toEqual([INV_OTHER]);
    expect(await ids(otherDb.from('expenses').select('id'))).toEqual([EXP_OTHER]);
    expect((await otherDb.rpc('api_expense_invoice_currencies', { p_expense_ids: [EXP_KSEF] })).data).toEqual([]);
  });

  it('zakres klucza: tylko faktury albo tylko koszty', async () => {
    const invoicesOnly = apiDb(keys.invoicesOnly.hash);
    expect((await ids(invoicesOnly.from('invoices').select('id'))).length).toBe(3);
    expect(await ids(invoicesOnly.from('expenses').select('id'))).toEqual([]);
    expect((await invoicesOnly.rpc('api_expense_invoice_currencies', { p_expense_ids: [EXP_KSEF] })).data).toEqual([]);

    const expensesOnly = apiDb(keys.expensesOnly.hash);
    expect(await ids(expensesOnly.from('invoices').select('id'))).toEqual([]);
    expect((await expensesOnly.from('invoice_line_items').select('invoice_id')).data).toEqual([]);
    expect(await ids(expensesOnly.from('expenses').select('id'))).toEqual([EXP_KSEF, EXP_MANUAL].sort());
  });

  it('strony kursorem i filtry działają na prawdziwym PostgREST', async () => {
    const db = apiDb(keys.all.hash);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 4; i += 1) {
      const params = new URLSearchParams({ limit: '1', ...(cursor ? { cursor } : {}) });
      const query = parseInvoiceListQuery(params);
      if (!query.ok) throw new Error(query.message);
      const page = await listInvoices(db, ORG, query.value);
      seen.push(...page.data.map((inv) => inv.id));
      cursor = page.next_cursor;
      if (!cursor) break;
    }
    expect(seen).toEqual([INV_OUT, INV_IN, INV_DRAFT]);
    expect(cursor).toBeNull();

    const filtered = async (search: string) => {
      const query = parseInvoiceListQuery(new URLSearchParams(search));
      if (!query.ok) throw new Error(query.message);
      return (await listInvoices(db, ORG, query.value)).data.map((inv) => inv.id);
    };
    expect(await filtered('direction=incoming')).toEqual([INV_IN]);
    expect(await filtered('ksef_status=draft')).toEqual([INV_DRAFT]);
    expect(await filtered('issue_date_from=2026-11-01&issue_date_to=2026-11-01')).toEqual([INV_IN]);

    const expensesQuery = parseExpenseListQuery(new URLSearchParams('review_status=unreviewed'));
    if (!expensesQuery.ok) throw new Error(expensesQuery.message);
    expect((await listExpenses(db, ORG, expensesQuery.value)).data.map((e) => e.id)).toEqual([EXP_KSEF]);
  });

  it('rola api_key_client nie widzi innych tabel i kolumn i niczego nie zapisuje', async () => {
    const db = apiDb(keys.all.hash);
    for (const table of ['api_keys', 'audit_logs', 'tenants', 'memberships', 'users', 'xml_documents', 'accountant_access']) {
      expect((await db.from(table).select('*').limit(1)).error?.message, table).toMatch(/permission denied/);
    }
    for (const column of ['buyer_pesel', 'special_data', 'notes', 'payment_data', 'last_error']) {
      expect((await db.from('invoices').select(column).limit(1)).error?.message, column).toMatch(/permission denied/);
    }
    expect((await db.from('invoices').update({ notes: 'x' }).eq('id', INV_OUT)).error?.message).toMatch(/permission denied/);
    expect((await db.from('invoices').delete().eq('id', INV_DRAFT)).error?.message).toMatch(/permission denied/);
    expect((await db.from('expenses').insert({ tenant_id: ORG, source: 'manual', seller_name: 'X', issue_date: '2026-11-01', net_amount: 1, gross_amount: 1 })).error?.message).toMatch(/permission denied/);
    expect((await db.from('expenses').delete().eq('id', EXP_MANUAL)).error?.message).toMatch(/permission denied/);
  });

  it('podróbki tokenu: bez skrótu, nieznany skrót, inna rola, zły sekret, wygasły', async () => {
    const noHash = forgedDb({ role: 'api_key_client' });
    expect((await noHash.rpc('api_key_session', { p_endpoint: 'x', p_request_id: 'x' })).data).toBeNull();
    expect(await ids(noHash.from('invoices').select('id'))).toEqual([]);

    const unknown = apiDb('f'.repeat(64));
    expect((await unknown.rpc('api_key_session', { p_endpoint: 'x', p_request_id: 'x' })).data).toBeNull();
    expect(await ids(unknown.from('invoices').select('id'))).toEqual([]);

    // Zwykła rola z doklejonym skrótem nie korzysta z polityk klucza i nie woła jego funkcji.
    const asAuthenticated = forgedDb({ role: 'authenticated', api_key_hash: keys.all.hash });
    expect(await ids(asAuthenticated.from('invoices').select('id'))).toEqual([]);
    expect((await asAuthenticated.rpc('api_key_session', { p_endpoint: 'x', p_request_id: 'x' })).error?.message).toMatch(/permission denied/);

    expect((await forgedDb({ role: 'api_key_client', api_key_hash: keys.all.hash }, 'x'.repeat(40)).from('invoices').select('id')).error).not.toBeNull();
    expect((await forgedDb({ role: 'api_key_client', api_key_hash: keys.all.hash, exp: Math.floor(Date.now() / 1000) - 120 }).from('invoices').select('id')).error).not.toBeNull();

    const anon = sessionClient(ORG);
    expect((await anon.rpc('api_key_session', { p_endpoint: 'x', p_request_id: 'x' })).error?.message).toMatch(/permission denied/);
    expect((await anon.rpc('api_expense_invoice_currencies', { p_expense_ids: [EXP_KSEF] })).error?.message).toMatch(/permission denied/);
    const owner = await signedIn(OWNER_EMAIL, ORG);
    expect((await owner.rpc('api_key_session', { p_endpoint: 'x', p_request_id: 'x' })).error?.message).toMatch(/permission denied/);
  });

  it('odwołanie: właściciel albo administrator, nieodwracalne, z audytem; odwołany klucz nic nie widzi', async () => {
    const member = await signedIn(MEMBER_EMAIL, ORG);
    const byMember = await member.from('api_keys').update({ revoked_at: new Date().toISOString() }).eq('id', keyIds.invoicesOnly).select('id');
    expect(byMember.data ?? []).toEqual([]);
    expect((await ids(apiDb(keys.invoicesOnly.hash).from('invoices').select('id'))).length).toBe(3);

    const owner = await signedIn(OWNER_EMAIL, ORG);
    expect((await owner.from('api_keys').update({ name: 'Inna nazwa' }).eq('id', keyIds.invoicesOnly)).error?.message).toMatch(/permission denied/);

    const adminClient = await signedIn(ADMIN_EMAIL, ORG);
    const revoked = await adminClient.from('api_keys').update({ revoked_at: '2000-01-01T00:00:00Z' }).eq('id', keyIds.invoicesOnly).is('revoked_at', null).select('id');
    expect(revoked.error).toBeNull();
    expect(revoked.data).toEqual([{ id: keyIds.invoicesOnly }]);

    const stored = await admin.from('api_keys').select('revoked_at, revoked_by').eq('id', keyIds.invoicesOnly).single();
    expect(stored.data?.revoked_by).toBe(adminId);
    // Czas odwołania z bazy, nie z formularza.
    expect(new Date(String(stored.data?.revoked_at)).getFullYear()).toBeGreaterThanOrEqual(2026);

    const audit = await admin.from('audit_logs').select('user_id, metadata').eq('action', 'api_key.revoked').eq('entity_id', keyIds.invoicesOnly);
    expect(audit.data).toEqual([{ user_id: adminId, metadata: expect.objectContaining({ name: 'Faktury', key_prefix: keys.invoicesOnly.prefix }) }]);

    const db = apiDb(keys.invoicesOnly.hash);
    expect((await db.rpc('api_key_session', { p_endpoint: 'x', p_request_id: 'x' })).data).toBeNull();
    expect(await ids(db.from('invoices').select('id'))).toEqual([]);

    // Przywrócenie: klient nie widzi już wiersza do zmiany, serwis dostaje odmowę wyzwalacza.
    const back = await owner.from('api_keys').update({ revoked_at: null }).eq('id', keyIds.invoicesOnly).select('id');
    expect(back.data ?? []).toEqual([]);
    expect((await admin.from('api_keys').update({ revoked_at: null }).eq('id', keyIds.invoicesOnly)).error?.message).toMatch(/api_key_already_revoked/);
    expect((await admin.from('api_keys').update({ scopes: ['expenses:read'] }).eq('id', keyIds.all)).error?.message).toMatch(/api_key_immutable/);
  });

  it('flaga publicApiEnabled istnieje i jest wyłączona (udostępnienie po regulaminie i teście zabezpieczeń)', async () => {
    const { data } = await admin.from('global_feature_flags').select('enabled').eq('flag', 'publicApiEnabled').single();
    expect(data?.enabled).toBe(false);
  });
});

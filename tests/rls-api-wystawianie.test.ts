import { createHmac } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { createApiKeyDbClient } from '@/lib/api/v1/db';
import { createInvoiceFromApi, parseInvoiceCreateBody } from '@/lib/api/v1/invoice-create';
import { readInvoice } from '@/lib/api/v1/invoices';
import { generateCompanyKey } from '@/lib/api/v1/keys';
import { mintApiKeyToken } from '@/lib/api/v1/token';
import { buildInvoiceFromForm, draftInvoiceRow, draftLineRows } from '@/lib/invoices/build-from-form';
import { addDaysToIsoDate, todayInWarsaw } from '@/lib/format/warsaw-date';
import type { InvoiceFormValues } from '@/lib/schemas/invoice-form';

import { getRlsTestEnvironment } from './helpers/rls-environment';

/**
 * 00184 na prawdziwym PostgREST: wystawianie faktur przez publiczne API (krok
 * 7.1 planu kompletnej aplikacji, część 2).
 *
 * - Zakres `invoices:write` w `api_keys`; rola `api_key_client` dalej nie pisze
 *   do tabel: jedyna droga zapisu to `api_create_invoice()` (SECURITY DEFINER),
 *   które samo ustala klucz, zakres i firmę ze skrótu w tokenie.
 * - Idempotencja: UNIQUE (firma, klucz API, klucz idempotencji) w transakcji
 *   z fakturą: ta sama treść zwraca tę samą fakturę, inna `conflict`,
 *   odmowa zapisu (zajęty numer) nie zostawia klucza.
 * - Faktura ma autora: `audit_logs` z identyfikatorem klucza API.
 * - Izolacja firm: obca firma nie widzi ani nie powtarza cudzych żądań,
 *   dane firmy do wystawienia czyta tylko klucz z `invoices:write` swojej firmy.
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

const ORG = '00184184-0000-4000-8000-000000000001';
const OTHER_ORG = '00184184-0000-4000-8000-000000000002';
// Fikcyjne NIP-y z poprawną sumą kontrolną (powtórzona cyfra).
const NIP = '1111111111';
const OTHER_NIP = '2222222222';
const BUYER_NIP = '3333333333';
const OWNER_EMAIL = 'rls-api-write-owner@ksef-saas.test';
const PASS = 'RlsApiWystawianiePass2026Aa!';
const IBAN = 'PL61109010140000071219812874';
const TODAY = todayInWarsaw();

const keys = {
  writer: generateCompanyKey(),
  full: generateCompanyKey(),
  reader: generateCompanyKey(),
  revoked: generateCompanyKey(),
  other: generateCompanyKey(),
};
const keyIds: Record<keyof typeof keys, string> = { writer: '', full: '', reader: '', revoked: '', other: '' };
let ownerId = '';

function apiDb(keyHash: string): SupabaseClient {
  return createApiKeyDbClient(mintApiKeyToken(keyHash, JWT_SECRET), {
    url: environment!.url,
    anonKey: environment!.anonKey,
  });
}

function forgedDb(claims: Record<string, unknown>): SupabaseClient {
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const head = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ aud: 'authenticated', iat: now, exp: now + 60, ...claims })}`;
  const token = `${head}.${createHmac('sha256', JWT_SECRET).update(head).digest('base64url')}`;
  return createApiKeyDbClient(token, { url: environment!.url, anonKey: environment!.anonKey });
}

function identity(name: keyof typeof keys, tenantId = ORG, scopes = ['invoices:write']) {
  return { id: keyIds[name], tenantId, scopes: scopes as ('invoices:write' | 'invoices:read')[], prefix: keys[name].prefix };
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

async function ownerSession(): Promise<SupabaseClient> {
  const client = createClient(environment!.url, environment!.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { 'x-active-org': ORG } },
  });
  const { error } = await client.auth.signInWithPassword({ email: OWNER_EMAIL, password: PASS });
  if (error) throw error;
  return client;
}

function body(overrides: Record<string, unknown> = {}) {
  return {
    number: 'FV/RLS/1',
    issue_date: TODAY,
    payment_due_date: addDaysToIsoDate(TODAY, 14),
    payment_method: 'transfer',
    bank_account: IBAN,
    buyer: { type: 'company', nip: BUYER_NIP, name: 'Nabywca 00184', address_line1: 'ul. Kupiecka 2', address_line2: '00-002 Warszawa' },
    items: [{ name: 'Usługa 00184', unit: 'szt.', quantity: '2', unit_price_net: '615.25', vat_rate: '23' }],
    ...overrides,
  };
}

function parsed(overrides: Record<string, unknown> = {}) {
  const result = parseInvoiceCreateBody(body(overrides));
  if (!result.ok) throw new Error(`treść testu odrzucona: ${result.message}`);
  return result;
}

/** Wiersz faktury i pozycje tak, jak buduje je aplikacja (te same funkcje co formularz). */
function rpcPayload(number: string, tenant: { id: string; nip: string; name: string }) {
  const values: InvoiceFormValues = {
    internalNumber: number, issueDate: TODAY, saleDate: '', buyerNip: BUYER_NIP, buyerName: 'Nabywca 00184',
    buyerAddressLine1: 'ul. Kupiecka 2', buyerAddressLine2: '00-002 Warszawa', buyerEmail: '', buyerIsConsumer: false,
    buyerPesel: '', buyerIdDocument: '', paymentMethod: 'transfer', paymentDueDate: addDaysToIsoDate(TODAY, 14)!,
    bankAccount: IBAN, lines: [{ name: 'Usługa', unit: 'szt.', quantity: 1, unitPriceNet: 100, vatRate: '23' }],
  };
  const invoice = buildInvoiceFromForm(values, { ...tenant, address: null }, null, false);
  const { tenant_id: _ignored, ...row } = draftInvoiceRow(tenant.id, invoice, values);
  return { p_invoice: row, p_lines: draftLineRows(invoice) };
}

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

async function sprzataj() {
  for (const org of [ORG, OTHER_ORG]) {
    await admin.from('api_idempotency_keys').delete().eq('tenant_id', org);
    const { data } = await admin.from('invoices').select('id').eq('tenant_id', org);
    const ids = (data ?? []).map((r) => r.id as string);
    if (ids.length > 0) {
      await admin.from('invoices').update({ ksef_status: 'draft' }).in('id', ids).neq('ksef_status', 'draft');
      await admin.from('invoice_line_items').delete().in('invoice_id', ids);
      await admin.from('invoices').delete().in('id', ids);
    }
    await admin.from('api_keys').delete().eq('tenant_id', org);
    await admin.from('memberships').delete().eq('organization_id', org);
  }
}

describe.skipIf(!hasDatabase)('00184: wystawianie faktur kluczem API na prawdziwym PostgREST', () => {
  beforeAll(async () => {
    if (!JWT_SECRET) throw new Error('RLS_TEST_SUPABASE_JWT_SECRET: brak sekretu JWT lokalnej bazy (scripts/ci/rls-local.sh)');
    ownerId = await userId(OWNER_EMAIL);
    await sprzataj();
    // Wstawianie tablicą: każdy wiersz ma te same klucze (PostgREST wpisuje NULL w brakujące).
    const { error: tErr } = await admin.from('tenants').upsert([
      { id: ORG, nip: NIP, name: 'Firma API 00184', address_json: { countryCode: 'PL', addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa' }, vat_exemption_basis: null, vat_cash_method: false },
      { id: OTHER_ORG, nip: OTHER_NIP, name: 'Inna firma API 00184', address_json: { countryCode: 'PL', addressLine1: 'ul. Obca 9', addressLine2: '30-001 Kraków' }, vat_exemption_basis: null, vat_cash_method: false },
    ], { onConflict: 'id' });
    if (tErr) throw tErr;
    await admin.from('users').upsert([{ id: ownerId, name: 'Owner 00184' }], { onConflict: 'id' });
    const { error: mErr } = await admin.from('memberships').insert([
      { organization_id: ORG, user_id: ownerId, role: 'owner', status: 'active' },
    ]);
    if (mErr) throw mErr;

    const row = (key: ReturnType<typeof generateCompanyKey>, tenantId: string, scopes: string[], name: string) => ({
      tenant_id: tenantId, name, key_prefix: key.prefix, key_hash: key.hash, scopes,
    });
    const { data: created, error: kErr } = await admin.from('api_keys').insert([
      row(keys.writer, ORG, ['invoices:write'], 'Sklep'),
      row(keys.full, ORG, ['invoices:read', 'invoices:write'], 'Sklep z odczytem'),
      row(keys.reader, ORG, ['invoices:read', 'expenses:read'], 'Odczyt'),
      row(keys.revoked, ORG, ['invoices:write'], 'Odwołany'),
      row(keys.other, OTHER_ORG, ['invoices:write'], 'Obcy sklep'),
    ]).select('id, key_hash');
    if (kErr) throw kErr;
    for (const name of Object.keys(keys) as (keyof typeof keys)[]) {
      keyIds[name] = String(created!.find((k) => k.key_hash === keys[name].hash)!.id);
    }
    const { error: rErr } = await admin.from('api_keys').update({ revoked_at: new Date().toISOString() }).eq('id', keyIds.revoked);
    if (rErr) throw rErr;
  });

  afterAll(async () => {
    if (!hasDatabase) return;
    // Wpisy audytu zostają (append-only, 00052).
    await sprzataj();
  });

  it('zakres invoices:write przyjmuje CHECK kluczy; nieznany zakres dalej nie', async () => {
    const stored = await admin.from('api_keys').select('scopes').eq('id', keyIds.full).single();
    expect(stored.data?.scopes).toEqual(['invoices:read', 'invoices:write']);
    const bad = generateCompanyKey();
    const { error } = await admin.from('api_keys').insert({ tenant_id: ORG, name: 'Zły', key_prefix: bad.prefix, key_hash: bad.hash, scopes: ['expenses:write'] });
    expect(error?.message).toMatch(/api_keys_scopes_check/);
  });

  it('klucz z invoices:write tworzy szkic tą samą drogą co formularz; autor w audit_logs', async () => {
    const request = parsed();
    const outcome = await createInvoiceFromApi(
      { db: apiDb(keys.writer.hash), key: identity('writer'), requestId: 'rls-00184-create' },
      { idempotencyKey: 'rls-zam-1', input: request.value, requestHash: request.requestHash },
    );
    if (!outcome.ok) throw new Error(`${outcome.code}: ${outcome.message}`);
    expect(outcome.replayed).toBe(false);
    expect(outcome.invoice).toMatchObject({
      number: 'FV/RLS/1', direction: 'outgoing', kind: 'regular', currency: 'PLN', ksef_status: 'draft',
      net_total: '1230.50', vat_total: '283.02', gross_total: '1513.52',
      seller: { name: 'Firma API 00184', nip: NIP }, buyer: { name: 'Nabywca 00184', nip: BUYER_NIP },
    });
    expect(outcome.invoice.items).toEqual([expect.objectContaining({ position: 1, quantity: '2.0000', net_amount: '1230.50', vat_amount: '283.02', gross_amount: '1513.52' })]);
    expect(outcome.submission).toEqual({ requested: false, status: 'not_requested', message: null });

    const row = await admin.from('invoices').select('tenant_id, origin, ksef_status, direction, seller_nip, internal_number').eq('id', outcome.invoice.id).single();
    expect(row.data).toEqual({ tenant_id: ORG, origin: 'app', ksef_status: 'draft', direction: 'outgoing', seller_nip: NIP, internal_number: 'FV/RLS/1' });

    const claim = await admin.from('api_idempotency_keys').select('tenant_id, api_key_id, invoice_id, request_hash, send_requested, request_id').eq('idempotency_key', 'rls-zam-1');
    expect(claim.data).toEqual([{ tenant_id: ORG, api_key_id: keyIds.writer, invoice_id: outcome.invoice.id, request_hash: request.requestHash, send_requested: false, request_id: 'rls-00184-create' }]);

    const audit = await admin.from('audit_logs').select('tenant_id, user_id, metadata').eq('action', 'invoice.draft_created').eq('entity_id', outcome.invoice.id);
    expect(audit.data).toEqual([{
      tenant_id: ORG, user_id: null,
      metadata: expect.objectContaining({ source: 'api_v1', api_key_id: keyIds.writer, key_prefix: keys.writer.prefix, request_id: 'rls-00184-create', internalNumber: 'FV/RLS/1' }),
    }]);

    // Klucz z odczytem widzi tę samą fakturę przez GET: ten sam kształt i te same wartości.
    expect(await readInvoice(apiDb(keys.full.hash), ORG, outcome.invoice.id)).toEqual(outcome.invoice);
  });

  it('idempotencja: ta sama treść zwraca tę samą fakturę, inna treść daje konflikt, bez drugiej faktury', async () => {
    const request = parsed({ number: 'FV/RLS/2' });
    const ctx = { db: apiDb(keys.writer.hash), key: identity('writer'), requestId: 'rls-00184-idem' };
    const first = await createInvoiceFromApi(ctx, { idempotencyKey: 'rls-zam-2', input: request.value, requestHash: request.requestHash });
    const second = await createInvoiceFromApi(ctx, { idempotencyKey: 'rls-zam-2', input: request.value, requestHash: request.requestHash });
    if (!first.ok || !second.ok) throw new Error('odmowa przy idempotencji');
    expect(second.replayed).toBe(true);
    expect(second.invoice.id).toBe(first.invoice.id);

    const changed = parsed({ number: 'FV/RLS/3' });
    const conflict = await createInvoiceFromApi(ctx, { idempotencyKey: 'rls-zam-2', input: changed.value, requestHash: changed.requestHash });
    expect(conflict).toMatchObject({ ok: false, status: 409, code: 'idempotency_conflict' });

    const count = await admin.from('invoices').select('id', { count: 'exact', head: true }).eq('tenant_id', ORG).in('internal_number', ['FV/RLS/2', 'FV/RLS/3']);
    expect(count.count).toBe(1);
  });

  it('dwa równoległe żądania z tym samym kluczem: jedna faktura, drugie dostaje ją jako powtórzenie', async () => {
    const db = apiDb(keys.writer.hash);
    const payload = rpcPayload('FV/RLS/RACE', { id: ORG, nip: NIP, name: 'Firma API 00184' });
    const call = () => db.rpc('api_create_invoice', {
      p_idempotency_key: 'rls-race', p_request_hash: HASH_A, p_request_id: 'rls-race', p_send: false,
      p_invoice: payload.p_invoice, p_lines: payload.p_lines,
    });
    const [x, y] = await Promise.all([call(), call()]);
    expect(x.error).toBeNull();
    expect(y.error).toBeNull();
    expect([x.data.status, y.data.status].sort()).toEqual(['created', 'replayed']);
    expect(x.data.invoice.id).toBe(y.data.invoice.id);
    const count = await admin.from('invoices').select('id', { count: 'exact', head: true }).eq('tenant_id', ORG).eq('internal_number', 'FV/RLS/RACE');
    expect(count.count).toBe(1);
  });

  it('zajęty numer: odmowa bez śladu klucza idempotencji; ten sam klucz z wolnym numerem tworzy fakturę', async () => {
    const db = apiDb(keys.writer.hash);
    const taken = rpcPayload('FV/RLS/1', { id: ORG, nip: NIP, name: 'Firma API 00184' });
    const refused = await db.rpc('api_create_invoice', {
      p_idempotency_key: 'rls-taken', p_request_hash: HASH_A, p_request_id: 'rls-taken', p_send: false,
      p_invoice: taken.p_invoice, p_lines: taken.p_lines,
    });
    expect(refused.error?.message).toBe('api_invoice_number_taken');
    expect((await admin.from('api_idempotency_keys').select('id').eq('idempotency_key', 'rls-taken')).data).toEqual([]);

    const free = rpcPayload('FV/RLS/4', { id: ORG, nip: NIP, name: 'Firma API 00184' });
    const created = await db.rpc('api_create_invoice', {
      p_idempotency_key: 'rls-taken', p_request_hash: HASH_B, p_request_id: 'rls-taken', p_send: false,
      p_invoice: free.p_invoice, p_lines: free.p_lines,
    });
    expect(created.error).toBeNull();
    expect(created.data.status).toBe('created');
  });

  it('sprzedawca i rodzaj z bazy: obca firma, korekta i waluta odmowa bez zapisu', async () => {
    const db = apiDb(keys.writer.hash);
    const foreign = rpcPayload('FV/RLS/OBCY', { id: OTHER_ORG, nip: OTHER_NIP, name: 'Inna firma API 00184' });
    const seller = await db.rpc('api_create_invoice', {
      p_idempotency_key: 'rls-seller', p_request_hash: HASH_A, p_request_id: 'x', p_send: false, ...foreign,
    });
    expect(seller.error?.message).toBe('api_invoice_seller_mismatch');

    const own = rpcPayload('FV/RLS/KOR', { id: ORG, nip: NIP, name: 'Firma API 00184' });
    const correction = { ...own.p_invoice, fa3_data: { ...own.p_invoice.fa3_data, type: 'KOR' } };
    const kor = await db.rpc('api_create_invoice', {
      p_idempotency_key: 'rls-kor', p_request_hash: HASH_A, p_request_id: 'x', p_send: false, p_invoice: correction, p_lines: own.p_lines,
    });
    expect(kor.error?.message).toBe('api_invoice_unsupported');
    const eur = { ...own.p_invoice, currency: 'EUR' };
    expect((await db.rpc('api_create_invoice', {
      p_idempotency_key: 'rls-eur', p_request_hash: HASH_A, p_request_id: 'x', p_send: false, p_invoice: eur, p_lines: own.p_lines,
    })).error?.message).toBe('api_invoice_unsupported');

    // Stan, kierunek i firma z bazy, nie z wiersza aplikacji.
    const forged = { ...own.p_invoice, ksef_status: 'accepted', ksef_number: '1111111111-20261110-0000000000AA-01', direction: 'incoming', tenant_id: OTHER_ORG };
    const made = await db.rpc('api_create_invoice', {
      p_idempotency_key: 'rls-forged', p_request_hash: HASH_A, p_request_id: 'x', p_send: false, p_invoice: forged, p_lines: own.p_lines,
    });
    expect(made.error).toBeNull();
    const stored = await admin.from('invoices').select('tenant_id, ksef_status, ksef_number, direction').eq('id', made.data.invoice.id).single();
    expect(stored.data).toEqual({ tenant_id: ORG, ksef_status: 'draft', ksef_number: null, direction: 'outgoing' });
    expect((await admin.from('api_idempotency_keys').select('id').in('idempotency_key', ['rls-seller', 'rls-kor', 'rls-eur'])).data).toEqual([]);
  });

  it('izolacja firm: obca firma nie powtarza cudzego żądania i czyta tylko swoje dane do wystawienia', async () => {
    const db = apiDb(keys.other.hash);
    // Ten sam klucz idempotencji co firma ORG: osobne żądanie obcej firmy.
    const lookup = await db.rpc('api_invoice_idempotent_result', { p_idempotency_key: 'rls-zam-1', p_request_hash: HASH_A });
    expect(lookup.data).toEqual({ status: 'new' });
    expect((await db.from('tenants').select('id, nip, name')).data).toEqual([{ id: OTHER_ORG, nip: OTHER_NIP, name: 'Inna firma API 00184' }]);
    expect((await db.from('tenants').select('id').eq('id', ORG)).data).toEqual([]);

    const numbers = await db.rpc('api_invoice_numbers_taken', { p_numbers: ['FV/RLS/1', 'FV/RLS/2'] });
    expect(numbers.data).toEqual([]);
    const own = await apiDb(keys.writer.hash).rpc('api_invoice_numbers_taken', { p_numbers: ['FV/RLS/1', 'FV/RLS/NIE'] });
    expect(own.data).toEqual(['FV/RLS/1']);

    const context = await apiDb(keys.writer.hash).rpc('api_invoice_number_context');
    expect(context.error).toBeNull();
    expect(context.data.last_app).toMatchObject({ issue_date: TODAY });
    expect((await db.rpc('api_invoice_number_context')).data).toEqual({ last_app: null, last_any: null });
  });

  it('bez invoices:write (odczyt, odwołany, podróbka): odmowa funkcji i brak danych firmy', async () => {
    const payload = rpcPayload('FV/RLS/X', { id: ORG, nip: NIP, name: 'Firma API 00184' });
    for (const db of [apiDb(keys.reader.hash), apiDb(keys.revoked.hash), forgedDb({ role: 'api_key_client' }), apiDb('f'.repeat(64))]) {
      const create = await db.rpc('api_create_invoice', {
        p_idempotency_key: 'rls-denied', p_request_hash: HASH_A, p_request_id: 'x', p_send: false, ...payload,
      });
      expect(create.error?.message).toBe('api_key_forbidden');
      expect((await db.rpc('api_invoice_idempotent_result', { p_idempotency_key: 'rls-zam-1', p_request_hash: HASH_A })).error?.message).toBe('api_key_forbidden');
      expect((await db.rpc('api_invoice_number_context')).error?.message).toBe('api_key_forbidden');
      expect((await db.from('tenants').select('id')).data ?? []).toEqual([]);
    }
    expect((await admin.from('api_idempotency_keys').select('id').eq('idempotency_key', 'rls-denied')).data).toEqual([]);
  });

  it('rola api_key_client dalej nie pisze do tabel; klucze idempotencji i dane KSeF firmy niewidoczne', async () => {
    const db = apiDb(keys.full.hash);
    const payload = rpcPayload('FV/RLS/WPROST', { id: ORG, nip: NIP, name: 'Firma API 00184' });
    expect((await db.from('invoices').insert({ ...payload.p_invoice, tenant_id: ORG })).error?.message).toMatch(/permission denied/);
    expect((await db.from('invoice_line_items').insert({ invoice_id: ORG, ordinal: 1 })).error?.message).toMatch(/permission denied/);
    expect((await db.from('api_idempotency_keys').select('id')).error?.message).toMatch(/permission denied/);
    expect((await db.from('tenants').select('ksef_credentials_encrypted')).error?.message).toMatch(/permission denied/);
    expect((await db.from('tenants').update({ name: 'x' }).eq('id', ORG)).error?.message).toMatch(/permission denied/);

    // Zalogowany użytkownik i anon nie wołają funkcji API ani nie widzą kluczy idempotencji.
    const owner = await ownerSession();
    expect((await owner.from('api_idempotency_keys').select('id')).error?.message).toMatch(/permission denied/);
    expect((await owner.rpc('api_create_invoice', {
      p_idempotency_key: 'x', p_request_hash: HASH_A, p_request_id: 'x', p_send: false, ...payload,
    })).error?.message).toMatch(/permission denied/);
    const asAuthenticated = forgedDb({ role: 'authenticated', api_key_hash: keys.writer.hash });
    expect((await asAuthenticated.rpc('api_invoice_number_context')).error?.message).toMatch(/permission denied/);
  });

  it('send: true: wysyłka dozwolona tylko dla niezmienionego szkicu (ponowienie nie wysyła cudzej zmiany ani drugi raz)', async () => {
    const db = apiDb(keys.writer.hash);
    const payload = rpcPayload('FV/RLS/SEND', { id: ORG, nip: NIP, name: 'Firma API 00184' });
    const args = { p_idempotency_key: 'rls-send', p_request_hash: HASH_A, p_request_id: 'rls-send', p_send: true, ...payload };
    const created = await db.rpc('api_create_invoice', args);
    expect(created.error).toBeNull();
    expect(created.data).toMatchObject({ status: 'created', send_requested: true, send_allowed: true });
    expect(created.data.fa3_data).toMatchObject({ internalNumber: 'FV/RLS/SEND', type: 'VAT' });

    const replay = await db.rpc('api_invoice_idempotent_result', { p_idempotency_key: 'rls-send', p_request_hash: HASH_A });
    expect(replay.data).toMatchObject({ status: 'replayed', send_allowed: true });

    // Szkic zmieniony w aplikacji: ponowienie go nie wyśle.
    await admin.from('invoices').update({ notes: 'Zmiana w aplikacji' }).eq('id', created.data.invoice.id);
    const changed = await db.rpc('api_invoice_idempotent_result', { p_idempotency_key: 'rls-send', p_request_hash: HASH_A });
    expect(changed.data).toMatchObject({ status: 'replayed', send_requested: true, send_allowed: false });

    // Wysłany (queued): ponowienie nie zleca drugi raz.
    await admin.from('invoices').update({ ksef_status: 'queued' }).eq('id', created.data.invoice.id);
    const queued = await db.rpc('api_create_invoice', args);
    expect(queued.data).toMatchObject({ status: 'replayed', send_allowed: false, fa3_data: null });
    expect(queued.data.invoice.ksef_status).toBe('queued');
  });
});

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { createMobileDbClient } from '@/lib/api/mobile/db';
import { doWartosciFormularza } from '@/lib/api/mobile/schematy';
import { readTenantSnapshot, saveRegularDraft, type RegularIssueContext } from '@/lib/invoices/issue-regular';

import { getRlsTestEnvironment } from './helpers/rls-environment';

vi.mock('@/lib/audit/log', () => ({ logAudit: vi.fn(), logAuditWithResult: vi.fn() }));

/**
 * Plan aplikacji mobilnej, M8 (00201) na prawdziwym GoTrue i PostgREST.
 *
 * 1. Szkic faktury z telefonu: `saveRegularDraft` (ta sama funkcja co akcja
 *    strony) na kliencie z tokenem sesji i `x-active-org`, tak jak trasa
 *    `POST /api/mobile/v1/faktury`. Wiersz, pozycje i RLS faktur bez ciasteczek.
 * 2. `mobile_idempotency_keys`: konto dopisuje i czyta tylko własne klucze
 *    w aktywnej firmie; UNIQUE (firma, konto, klucz) łapie ponowienie; klucz
 *    nie wskaże faktury innej firmy (klucz złożony); bez UPDATE i DELETE dla
 *    klienta; usunięcie szkicu usuwa klucz.
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
const A_EMAIL = `rls-m8-a-${RUN}@ksef-saas.test`;
const A2_EMAIL = `rls-m8-a2-${RUN}@ksef-saas.test`;
const B_EMAIL = `rls-m8-b-${RUN}@ksef-saas.test`;
const PASS = 'RlsMobileM8Pass2026Aa!';

const ORG_A = '000a8000-0000-4000-8000-000000000001';
const ORG_B = '000a8000-0000-4000-8000-000000000002';
const INV_B = '000a8000-1000-4000-8000-000000000002';
const KEY_1 = '000a8000-2000-4000-8000-000000000001';
const KEY_2 = '000a8000-2000-4000-8000-000000000002';
const HASH = 'a'.repeat(64);
const ENDPOINT = 'POST /api/mobile/v1/faktury';

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

describe.skipIf(!hasDatabase)('M8: faktura z telefonu i klucze idempotencji na bazie', () => {
  let aId = '';
  let a2Id = '';
  let bId = '';
  let dbA: SupabaseClient;
  let dbA2: SupabaseClient;
  let dbAInB: SupabaseClient;
  let dbB: SupabaseClient;
  let draftId = '';
  const createdUsers: string[] = [];

  beforeAll(async () => {
    aId = await createUser(A_EMAIL);
    a2Id = await createUser(A2_EMAIL);
    bId = await createUser(B_EMAIL);
    createdUsers.push(aId, a2Id, bId);

    const { error: tenantsError } = await admin.from('tenants').upsert([
      { id: ORG_A, nip: '1234567890', name: 'Firma M8 A', address_json: { countryCode: 'PL', addressLine1: 'ul. A 1', addressLine2: '00-001 Warszawa' } },
      { id: ORG_B, nip: '1234567890', name: 'Firma M8 B', address_json: { countryCode: 'PL', addressLine1: 'ul. B 2', addressLine2: '00-002 Warszawa' } },
    ], { onConflict: 'id' });
    if (tenantsError) throw tenantsError;
    await admin.from('users').upsert([{ id: aId, name: 'A' }, { id: a2Id, name: 'A2' }, { id: bId, name: 'B' }], { onConflict: 'id' });
    const { error: membershipsError } = await admin.from('memberships').insert([
      { organization_id: ORG_A, user_id: aId, role: 'owner', status: 'active', joined_at: '2026-01-02T00:00:00Z' },
      { organization_id: ORG_A, user_id: a2Id, role: 'member', status: 'active', joined_at: '2026-01-03T00:00:00Z' },
      { organization_id: ORG_B, user_id: bId, role: 'owner', status: 'active', joined_at: '2026-01-02T00:00:00Z' },
    ]);
    if (membershipsError) throw membershipsError;
    const { error: invoiceError } = await admin.from('invoices').insert({
      id: INV_B, tenant_id: ORG_B, invoice_type: 'VAT', invoice_kind: 'regular', origin: 'app', seller_nip: '1234567890',
      buyer_nip: '1234567890', internal_number: `FV/B/${RUN}`, payment_due_date: '2026-11-30', currency: 'PLN',
      direction: 'outgoing', issue_date: '2026-11-02', net_total: 10, vat_total: 2.3, gross_total: 12.3, ksef_status: 'draft',
      fa3_data: {},
    });
    if (invoiceError) throw invoiceError;

    const [tokenA, tokenA2, tokenB] = await Promise.all([tokenOf(A_EMAIL), tokenOf(A2_EMAIL), tokenOf(B_EMAIL)]);
    dbA = createMobileDbClient(tokenA, { activeOrg: ORG_A, target });
    dbA2 = createMobileDbClient(tokenA2, { activeOrg: ORG_A, target });
    dbAInB = createMobileDbClient(tokenA, { activeOrg: ORG_B, target });
    dbB = createMobileDbClient(tokenB, { activeOrg: ORG_B, target });
  });

  afterAll(async () => {
    await admin.from('invoices').delete().in('tenant_id', [ORG_A, ORG_B]);
    await admin.from('memberships').delete().in('organization_id', [ORG_A, ORG_B]);
    for (const id of createdUsers) await admin.auth.admin.deleteUser(id).catch(() => null);
  });

  it('szkic z telefonu: ta sama funkcja co strona, klientem z tokenem i x-active-org', async () => {
    const db = dbA as unknown as RegularIssueContext['supabase'];
    const values = doWartosciFormularza({
      internalNumber: `FV/M8/${RUN}`, issueDate: '2026-11-20', saleDate: '', buyerNip: '5252241585',
      buyerName: 'Klient M8', buyerAddressLine1: 'ul. C 3', buyerAddressLine2: '00-003 Warszawa', buyerEmail: '',
      buyerIsConsumer: false, lines: [{ name: 'Usługa', unit: 'szt', quantity: 2, unitPriceNet: 150, vatRate: '23' }],
      paymentMethod: 'transfer', paymentDueDate: '2026-12-04', bankAccount: 'PL61109010140000071219812874', notes: '', splitPayment: false,
      numberSeriesId: '', numberPreview: '',
    });
    const result = await saveRegularDraft({ supabase: db, userId: aId, tenant: await readTenantSnapshot(db, ORG_A) }, values);
    expect(result.success).toBe(true);
    if (!result.success) return;
    draftId = result.invoiceId;

    const { data: row } = await admin.from('invoices').select('tenant_id, ksef_status, internal_number, gross_total, direction').eq('id', draftId).single();
    expect(row).toEqual({ tenant_id: ORG_A, ksef_status: 'draft', internal_number: `FV/M8/${RUN}`, gross_total: 369, direction: 'outgoing' });
    const { data: items } = await admin.from('invoice_line_items').select('name, quantity').eq('invoice_id', draftId);
    expect(items).toEqual([{ name: 'Usługa', quantity: 2 }]);
  });

  it('klucz żądania jako klucz zapisu (00199): drugi szkic z nim nie powstaje, pierwszy widać po kluczu', async () => {
    const db = dbA as unknown as RegularIssueContext['supabase'];
    const KLUCZ = '000a8000-3000-4000-8000-000000000001';
    const values = {
      ...doWartosciFormularza({
        internalNumber: `FV/M8K/${RUN}`, issueDate: '2026-11-20', saleDate: '', buyerNip: '5252241585',
        buyerName: 'Klient M8', buyerAddressLine1: 'ul. C 3', buyerAddressLine2: '00-003 Warszawa', buyerEmail: '',
        buyerIsConsumer: false, lines: [{ name: 'Usługa', unit: 'szt', quantity: 1, unitPriceNet: 10, vatRate: '23' }],
        paymentMethod: 'transfer', paymentDueDate: '2026-12-04', bankAccount: 'PL61109010140000071219812874', notes: '', splitPayment: false,
        numberSeriesId: '', numberPreview: '',
      }),
      numberRequestKey: KLUCZ,
    };
    const ctx = { supabase: db, userId: aId, tenant: await readTenantSnapshot(db, ORG_A) };
    const first = await saveRegularDraft(ctx, values);
    expect(first.success).toBe(true);
    const again = await saveRegularDraft(ctx, { ...values, internalNumber: `FV/M8K2/${RUN}` });
    expect(again).toMatchObject({ success: false, invoiceId: first.success ? first.invoiceId : 'x' });
    const { data } = await dbA.from('invoices').select('id').eq('tenant_id', ORG_A).eq('number_request_key', KLUCZ);
    expect(data).toEqual([{ id: first.success ? first.invoiceId : 'x' }]);
  });

  it('konto dopisuje swój klucz w aktywnej firmie i widzi go', async () => {
    const { error } = await dbA.from('mobile_idempotency_keys').insert({
      tenant_id: ORG_A, user_id: aId, idempotency_key: KEY_1, request_hash: HASH, endpoint: ENDPOINT, invoice_id: draftId,
    });
    expect(error).toBeNull();
    const { data } = await dbA.from('mobile_idempotency_keys').select('invoice_id, request_hash').eq('idempotency_key', KEY_1);
    expect(data).toEqual([{ invoice_id: draftId, request_hash: HASH }]);
  });

  it('ten sam klucz drugi raz: 23505 (ponowienie nie zapisze drugiego wiersza)', async () => {
    const { error } = await dbA.from('mobile_idempotency_keys').insert({
      tenant_id: ORG_A, user_id: aId, idempotency_key: KEY_1, request_hash: HASH, endpoint: ENDPOINT, invoice_id: draftId,
    });
    expect(error?.code).toBe('23505');
  });

  it('klucz za inne konto albo w firmie spoza nagłówka: odmowa RLS', async () => {
    const zaInnego = await dbA.from('mobile_idempotency_keys').insert({
      tenant_id: ORG_A, user_id: a2Id, idempotency_key: KEY_2, request_hash: HASH, endpoint: ENDPOINT, invoice_id: draftId,
    });
    expect(zaInnego.error?.code).toBe('42501');
    const obcaFirma = await dbAInB.from('mobile_idempotency_keys').insert({
      tenant_id: ORG_B, user_id: aId, idempotency_key: KEY_2, request_hash: HASH, endpoint: ENDPOINT, invoice_id: INV_B,
    });
    expect(obcaFirma.error?.code).toBe('42501');
  });

  it('klucz nie wskaże faktury innej firmy (klucz złożony z firmą)', async () => {
    const { error } = await dbA.from('mobile_idempotency_keys').insert({
      tenant_id: ORG_A, user_id: aId, idempotency_key: KEY_2, request_hash: HASH, endpoint: ENDPOINT, invoice_id: INV_B,
    });
    expect(error?.code).toBe('23503');
  });

  it('zły skrót albo inna trasa: CHECK', async () => {
    const skrot = await dbA.from('mobile_idempotency_keys').insert({
      tenant_id: ORG_A, user_id: aId, idempotency_key: KEY_2, request_hash: 'nie-skrot', endpoint: ENDPOINT, invoice_id: draftId,
    });
    expect(skrot.error?.code).toBe('23514');
    const trasa = await dbA.from('mobile_idempotency_keys').insert({
      tenant_id: ORG_A, user_id: aId, idempotency_key: KEY_2, request_hash: HASH, endpoint: 'POST /api/v1/invoices', invoice_id: draftId,
    });
    expect(trasa.error?.code).toBe('23514');
  });

  it('klucze widzi tylko ich konto w aktywnej firmie', async () => {
    const drugiCzlonek = await dbA2.from('mobile_idempotency_keys').select('id');
    expect(drugiCzlonek.data).toEqual([]);
    const innaFirma = await dbB.from('mobile_idempotency_keys').select('id');
    expect(innaFirma.data).toEqual([]);
    const naglowekObcejFirmy = await dbAInB.from('mobile_idempotency_keys').select('id');
    expect(naglowekObcejFirmy.data).toEqual([]);
  });

  it('klient nie zmienia ani nie usuwa klucza', async () => {
    const zmiana = await dbA.from('mobile_idempotency_keys').update({ request_hash: 'b'.repeat(64) }).eq('idempotency_key', KEY_1);
    expect(zmiana.error?.code).toBe('42501');
    const usuniecie = await dbA.from('mobile_idempotency_keys').delete().eq('idempotency_key', KEY_1).select('id');
    // Bez uprawnienia DELETE: odmowa albo zero wierszy, klucz zostaje.
    expect(usuniecie.error?.code ?? 'brak-wierszy').toMatch(/42501|brak-wierszy/);
    const { count } = await admin.from('mobile_idempotency_keys').select('id', { count: 'exact', head: true }).eq('idempotency_key', KEY_1);
    expect(count).toBe(1);
  });

  it('usunięcie szkicu usuwa jego klucz (ponowienie wystawi od nowa)', async () => {
    const { error } = await dbA.from('invoices').delete().eq('id', draftId).eq('ksef_status', 'draft');
    expect(error).toBeNull();
    const { count } = await admin.from('mobile_idempotency_keys').select('id', { count: 'exact', head: true }).eq('idempotency_key', KEY_1);
    expect(count).toBe(0);
  });
});

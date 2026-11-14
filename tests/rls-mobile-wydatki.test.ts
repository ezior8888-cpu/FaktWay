import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { createMobileDbClient } from '@/lib/api/mobile/db';

import { getRlsTestEnvironment } from './helpers/rls-environment';

/**
 * Plan aplikacji mobilnej, M9 (00202) na prawdziwym GoTrue i PostgREST.
 *
 * `mobile_idempotency_keys` z kluczem wgrania zdjęcia kosztu (`POST
 * /api/mobile/v1/wydatki/zdjecie`): cel to zadanie OCR (`ocr_job_id`), nie
 * faktura. Sprawdzamy, że:
 *  - konto dopisuje klucz wgrania wskazujący zadanie OCR swojej firmy, a drugi
 *    ten sam klucz odbija UNIQUE (ponowienie nie zapisze drugiego wiersza);
 *  - klucz nie wskaże zadania OCR innej firmy (klucz złożony z 00202);
 *  - CHECK wiąże trasę z celem (wgranie bez zadania, z fakturą, faktura z zadaniem);
 *  - wiersze faktur z 00201 dalej przechodzą;
 *  - usunięcie zadania OCR (wgranie, które padło po kluczu) usuwa klucz.
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
const A_EMAIL = `rls-m9-a-${RUN}@ksef-saas.test`;
const B_EMAIL = `rls-m9-b-${RUN}@ksef-saas.test`;
const PASS = 'RlsMobileM9Pass2026Aa!';

const ORG_A = '000a9000-0000-4000-8000-000000000001';
const ORG_B = '000a9000-0000-4000-8000-000000000002';
const JOB_A = '000a9000-1000-4000-8000-000000000001';
const JOB_A2 = '000a9000-1000-4000-8000-000000000003';
const JOB_B = '000a9000-1000-4000-8000-000000000002';
const INV_A = '000a9000-3000-4000-8000-000000000001';
const KEY_1 = '000a9000-2000-4000-8000-000000000001';
const KEY_2 = '000a9000-2000-4000-8000-000000000002';
const KEY_3 = '000a9000-2000-4000-8000-000000000003';
const HASH = 'c'.repeat(64);
const UPLOAD = 'POST /api/mobile/v1/wydatki/zdjecie';
const INVOICES = 'POST /api/mobile/v1/faktury';

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

const job = (id: string, tenantId: string, createdBy: string) => ({
  id,
  tenant_id: tenantId,
  created_by: createdBy,
  status: 'pending',
  source_file_path: 'pending',
  source_file_mime: 'image/jpeg',
  source_file_size_bytes: 1000,
});

describe.skipIf(!hasDatabase)('M9: klucz wgrania zdjęcia kosztu na bazie (00202)', () => {
  let aId = '';
  let bId = '';
  let dbA: SupabaseClient;
  const createdUsers: string[] = [];

  beforeAll(async () => {
    aId = await createUser(A_EMAIL);
    bId = await createUser(B_EMAIL);
    createdUsers.push(aId, bId);
    const { error: tenantsError } = await admin.from('tenants').upsert([
      { id: ORG_A, nip: '1234567890', name: 'Firma M9 A', address_json: { countryCode: 'PL', addressLine1: 'ul. A 1', addressLine2: '00-001 Warszawa' } },
      { id: ORG_B, nip: '1234567890', name: 'Firma M9 B', address_json: { countryCode: 'PL', addressLine1: 'ul. B 2', addressLine2: '00-002 Warszawa' } },
    ], { onConflict: 'id' });
    if (tenantsError) throw tenantsError;
    await admin.from('users').upsert([{ id: aId, name: 'A' }, { id: bId, name: 'B' }], { onConflict: 'id' });
    const { error: membershipsError } = await admin.from('memberships').insert([
      { organization_id: ORG_A, user_id: aId, role: 'owner', status: 'active', joined_at: '2026-01-02T00:00:00Z' },
      { organization_id: ORG_B, user_id: bId, role: 'owner', status: 'active', joined_at: '2026-01-02T00:00:00Z' },
    ]);
    if (membershipsError) throw membershipsError;
    const { error: jobsError } = await admin.from('ocr_jobs').insert([job(JOB_A, ORG_A, aId), job(JOB_A2, ORG_A, aId), job(JOB_B, ORG_B, bId)]);
    if (jobsError) throw jobsError;
    const { error: invoiceError } = await admin.from('invoices').insert({
      id: INV_A, tenant_id: ORG_A, invoice_type: 'VAT', invoice_kind: 'regular', origin: 'app', seller_nip: '1234567890',
      buyer_nip: '1234567890', internal_number: `FV/M9/${RUN}`, payment_due_date: '2026-11-30', currency: 'PLN',
      direction: 'outgoing', issue_date: '2026-11-02', net_total: 10, vat_total: 2.3, gross_total: 12.3, ksef_status: 'draft',
      fa3_data: {},
    });
    if (invoiceError) throw invoiceError;

    dbA = createMobileDbClient(await tokenOf(A_EMAIL), { activeOrg: ORG_A, target });
  });

  afterAll(async () => {
    await admin.from('mobile_idempotency_keys').delete().in('tenant_id', [ORG_A, ORG_B]);
    await admin.from('ocr_jobs').delete().in('tenant_id', [ORG_A, ORG_B]);
    await admin.from('invoices').delete().in('tenant_id', [ORG_A, ORG_B]);
    await admin.from('memberships').delete().in('organization_id', [ORG_A, ORG_B]);
    for (const id of createdUsers) await admin.auth.admin.deleteUser(id).catch(() => null);
  });

  it('konto dopisuje klucz wgrania wskazujący zadanie OCR swojej firmy i widzi go', async () => {
    const { error } = await dbA.from('mobile_idempotency_keys').insert({
      tenant_id: ORG_A, user_id: aId, idempotency_key: KEY_1, request_hash: HASH, endpoint: UPLOAD, ocr_job_id: JOB_A,
    });
    expect(error).toBeNull();
    const { data } = await dbA.from('mobile_idempotency_keys').select('ocr_job_id, invoice_id, endpoint').eq('idempotency_key', KEY_1);
    expect(data).toEqual([{ ocr_job_id: JOB_A, invoice_id: null, endpoint: UPLOAD }]);
  });

  it('ten sam klucz drugi raz: 23505 (ponowione wgranie nie zapisze drugiego wiersza)', async () => {
    const { error } = await dbA.from('mobile_idempotency_keys').insert({
      tenant_id: ORG_A, user_id: aId, idempotency_key: KEY_1, request_hash: HASH, endpoint: UPLOAD, ocr_job_id: JOB_A2,
    });
    expect(error?.code).toBe('23505');
  });

  it('klucz nie wskaże zadania OCR innej firmy (klucz złożony z firmą)', async () => {
    const { error } = await dbA.from('mobile_idempotency_keys').insert({
      tenant_id: ORG_A, user_id: aId, idempotency_key: KEY_2, request_hash: HASH, endpoint: UPLOAD, ocr_job_id: JOB_B,
    });
    expect(error?.code).toBe('23503');
  });

  it('CHECK wiąże trasę z celem', async () => {
    const bezCelu = await dbA.from('mobile_idempotency_keys').insert({
      tenant_id: ORG_A, user_id: aId, idempotency_key: KEY_2, request_hash: HASH, endpoint: UPLOAD,
    });
    expect(bezCelu.error?.code).toBe('23514');
    const wgranieZFaktura = await dbA.from('mobile_idempotency_keys').insert({
      tenant_id: ORG_A, user_id: aId, idempotency_key: KEY_2, request_hash: HASH, endpoint: UPLOAD, ocr_job_id: JOB_A2, invoice_id: INV_A,
    });
    expect(wgranieZFaktura.error?.code).toBe('23514');
    const fakturaZZadaniem = await dbA.from('mobile_idempotency_keys').insert({
      tenant_id: ORG_A, user_id: aId, idempotency_key: KEY_2, request_hash: HASH, endpoint: INVOICES, ocr_job_id: JOB_A2, invoice_id: INV_A,
    });
    expect(fakturaZZadaniem.error?.code).toBe('23514');
    const fakturaBezFaktury = await dbA.from('mobile_idempotency_keys').insert({
      tenant_id: ORG_A, user_id: aId, idempotency_key: KEY_2, request_hash: HASH, endpoint: INVOICES,
    });
    expect(fakturaBezFaktury.error?.code).toBe('23514');
  });

  it('wiersz faktury z 00201 dalej przechodzi', async () => {
    const { error } = await dbA.from('mobile_idempotency_keys').insert({
      tenant_id: ORG_A, user_id: aId, idempotency_key: KEY_3, request_hash: HASH, endpoint: INVOICES, invoice_id: INV_A,
    });
    expect(error).toBeNull();
  });

  it('usunięcie zadania OCR (wgranie padło po kluczu) usuwa klucz: ponowienie wgra od nowa', async () => {
    const { error } = await admin.from('ocr_jobs').delete().eq('id', JOB_A);
    expect(error).toBeNull();
    const { count } = await admin.from('mobile_idempotency_keys').select('id', { count: 'exact', head: true }).eq('idempotency_key', KEY_1);
    expect(count).toBe(0);
  });
});

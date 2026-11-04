import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { getRlsTestEnvironment } from './helpers/rls-environment';

/**
 * A5 (00150) na prawdziwej bazie: dziennik prób wysyłki `ksef_send_attempts`.
 *
 *   - zapis i odczyt wyłącznie kluczem serwisowym; serwis nie kasuje wierszy
 *     (historia prób zostaje), klient i anon nie widzą nic,
 *   - CHECK statusu i długości treści błędu; brak CHECK kolejności zegarów
 *     (zapis wyniku nie może paść przez różnicę zegara piszącego i bazy),
 *   - dziennik nie jest dowodem kontaktu z KSeF (`ksef_has_contact_evidence`):
 *     porażka sprzed POST nie blokuje powrotu do szkicu,
 *   - usunięcie faktury usuwa jej wiersze (CASCADE), mimo braku DELETE.
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

const ORG = 'a5a5a5a5-0000-4000-8000-000000000001';
const INVOICE = 'a5a5a5a5-0000-4000-8000-000000000002';
const ATTEMPT = 'a5a5a5a5-0000-4000-8000-000000000003';
const OWNER_EMAIL = 'rls-dziennik-prob-owner@ksef-saas.test';
const PASS = 'RlsDziennikProbPass2026Aa!';

let owner: SupabaseClient;

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

async function signedIn(email: string): Promise<SupabaseClient> {
  const c = createClient(environment!.url, environment!.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { 'x-active-org': ORG } },
  });
  const { error } = await c.auth.signInWithPassword({ email, password: PASS });
  if (error) throw error;
  return c;
}

async function insertInvoice(): Promise<void> {
  const { error } = await admin.from('invoices').insert({
    id: INVOICE, tenant_id: ORG, direction: 'outgoing', internal_number: 'FV/A5/1', invoice_type: 'VAT',
    invoice_kind: 'regular', issue_date: '2026-10-13', seller_nip: '9480000014', buyer_nip: '1234567890',
    gross_total: 123, net_total: 100, vat_total: 23, ksef_status: 'failed', ksef_environment: 'test',
    last_error_code: 'NO_CERTIFICATE', fa3_data: { internalNumber: 'FV/A5/1', type: 'VAT' },
    seller_data: { nip: '9480000014' }, buyer_data: { nip: '1234567890' },
  });
  if (error) throw new Error(`insert invoice: ${error.message}`);
}

/** Wiersz porażki; oba znaczniki z jednego zegara (jak worker), nie z bazy i z klienta naraz. */
const failedRow = (extra: Record<string, unknown> = {}) => ({
  started_at: new Date(Date.now() - 5000).toISOString(),
  tenant_id: ORG,
  invoice_id: INVOICE,
  send_attempt_id: ATTEMPT,
  job_id: 'a5a5a5a5-0000-4000-8000-000000000004',
  execution: 0,
  ksef_environment: 'test',
  status: 'failed',
  stage: 'credentials',
  error_code: 'NO_CERTIFICATE',
  error_class: 'setup',
  error_message: 'NonRetriableError: Nie można użyć credentials KSeF',
  retryable: false,
  finished_at: new Date().toISOString(),
  ...extra,
});

async function cleanup(): Promise<void> {
  // Serwis nie ma DELETE na dzienniku — wiersze znikają z fakturą (CASCADE).
  await admin.from('invoices').delete().eq('tenant_id', ORG);
}

describe.skipIf(!hasDatabase)('A5 (00150): dziennik prób wysyłki — uprawnienia, CHECK, dowód kontaktu', () => {
  beforeAll(async () => {
    const ownerId = await userId(OWNER_EMAIL);
    await cleanup();
    await admin.from('memberships').delete().eq('organization_id', ORG);
    await admin.from('tenants').delete().eq('id', ORG);
    const { error: tErr } = await admin.from('tenants').insert({ id: ORG, nip: '9480000014', name: 'Firma Dziennik Prób' });
    if (tErr) throw tErr;
    await admin.from('users').upsert([{ id: ownerId, name: 'Owner Dziennik Prób' }], { onConflict: 'id' });
    const { error: mErr } = await admin.from('memberships').insert([
      { organization_id: ORG, user_id: ownerId, role: 'owner', status: 'active' },
    ]);
    if (mErr) throw mErr;
    owner = await signedIn(OWNER_EMAIL);
  });

  beforeEach(async () => {
    await cleanup();
    await insertInvoice();
  });

  afterAll(async () => {
    if (!hasDatabase) return;
    await cleanup();
    await admin.from('memberships').delete().eq('organization_id', ORG);
    await admin.from('tenants').delete().eq('id', ORG);
  });

  it('serwis zapisuje, uzupełnia i czyta wiersz próby', async () => {
    const { data: started, error } = await admin
      .from('ksef_send_attempts')
      .insert({ tenant_id: ORG, invoice_id: INVOICE, send_attempt_id: ATTEMPT, status: 'started', stage: 'start' })
      .select('id')
      .single();
    expect(error).toBeNull();
    const { error: updateError } = await admin
      .from('ksef_send_attempts')
      .update({ status: 'failed', stage: 'credentials', error_code: 'NO_CERTIFICATE', finished_at: new Date().toISOString() })
      .eq('id', started!.id);
    expect(updateError).toBeNull();
    const { data } = await admin.from('ksef_send_attempts').select('status, stage, error_code').eq('id', started!.id).single();
    expect(data).toEqual({ status: 'failed', stage: 'credentials', error_code: 'NO_CERTIFICATE' });
  });

  it('zapis wyniku nie zależy od kolejności zegarów (finished_at wcześniejszy niż started_at z bazy)', async () => {
    // Zegar piszącego o sekundę za bazą: wynik i tak musi się zapisać.
    const { error } = await admin
      .from('ksef_send_attempts')
      .insert({ ...failedRow(), started_at: undefined, finished_at: new Date(Date.now() - 60_000).toISOString() });
    expect(error).toBeNull();
  });

  it('serwis nie kasuje historii prób', async () => {
    const { data: row, error: insertError } = await admin.from('ksef_send_attempts').insert(failedRow()).select('id').single();
    expect(insertError).toBeNull();
    const { error } = await admin.from('ksef_send_attempts').delete().eq('id', row!.id);
    expect(error?.code).toBe('42501');
    const { count } = await admin.from('ksef_send_attempts').select('id', { count: 'exact', head: true }).eq('invoice_id', INVOICE);
    expect(count).toBe(1);
  });

  it('klient firmy nie czyta i nie zapisuje dziennika', async () => {
    expect((await admin.from('ksef_send_attempts').insert(failedRow())).error).toBeNull();
    const read = await owner.from('ksef_send_attempts').select('id').eq('invoice_id', INVOICE);
    expect(read.error?.code).toBe('42501');
    const write = await owner.from('ksef_send_attempts').insert(failedRow());
    expect(write.error?.code).toBe('42501');
  });

  it('CHECK: nieznany status i treść ponad 500 znaków są odrzucane', async () => {
    const badStatus = await admin.from('ksef_send_attempts').insert(failedRow({ status: 'unknown' }));
    expect(badStatus.error?.code).toBe('23514');
    const longMessage = await admin.from('ksef_send_attempts').insert(failedRow({ error_message: 'x'.repeat(501) }));
    expect(longMessage.error?.code).toBe('23514');
  });

  it('porażka sprzed POST w dzienniku nie jest dowodem kontaktu z KSeF', async () => {
    expect((await admin.from('ksef_send_attempts').insert(failedRow())).error).toBeNull();
    const { data, error } = await admin.rpc('ksef_has_contact_evidence', { p_invoice_id: INVOICE, p_tenant_id: ORG });
    expect(error).toBeNull();
    expect(data).toBe(false);
  });

  it('usunięcie faktury usuwa jej wiersze dziennika (CASCADE)', async () => {
    expect((await admin.from('ksef_send_attempts').insert(failedRow())).error).toBeNull();
    const before = await admin.from('ksef_send_attempts').select('id', { count: 'exact', head: true }).eq('tenant_id', ORG);
    expect(before.count).toBe(1);
    await admin.from('invoices').delete().eq('id', INVOICE);
    const { count } = await admin.from('ksef_send_attempts').select('id', { count: 'exact', head: true }).eq('tenant_id', ORG);
    expect(count).toBe(0);
  });
});

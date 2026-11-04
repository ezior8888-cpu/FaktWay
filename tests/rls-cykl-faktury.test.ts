import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { getRlsTestEnvironment } from './helpers/rls-environment';

/**
 * Cykl życia faktury wychodzącej — PR 1 (migracja 00131) na prawdziwej bazie
 * z wyzwalaczami 00073/00117/00119/00122/00124. Jak rls-uprawnienia: tylko na
 * osobnej bazie testowej (`RLS_TEST_*`), w CI job „RLS isolation”.
 *
 * Projekt: docs/architecture/cykl-zycia-faktury-ksef.md
 *   - przejścia wykonuje wyłącznie serwer (RPC dla service_role),
 *   - dowód kontaktu z KSeF = numer KSeF albo wpis ksef_submissions
 *     sent/accepted/duplicate; z dowodem nie ma powrotu do szkicu,
 *   - katalog kodów błędu decyduje o wyjściach,
 *   - strażnik widzi naruszenia inwariantów.
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

const ORG = '55555555-5555-4555-8555-555555555555';
const OWNER_EMAIL = 'rls-cykl-owner@ksef-saas.test';
const PASS = 'RlsCyklPass2026Aa!';
const ATTEMPT = 'proba-00131';

let ownerId = '';
let counter = 0;

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

async function signedIn(email: string): Promise<SupabaseClient> {
  const c = anonClient(ORG);
  const { error } = await c.auth.signInWithPassword({ email, password: PASS });
  if (error) throw error;
  return c;
}

type InvoicePatch = Record<string, unknown>;

/** Faktura wychodząca firmy ORG w zadanym stanie; zwraca id. */
async function invoice(patch: InvoicePatch): Promise<string> {
  counter += 1;
  const id = `5555aaaa-0000-4000-8000-${String(counter).padStart(12, '0')}`;
  const number = `CYKL/${counter}`;
  const { error } = await admin.from('invoices').insert({
    id, tenant_id: ORG, direction: 'outgoing', internal_number: number, invoice_type: 'VAT',
    issue_date: '2026-10-01', seller_nip: '9480000014', buyer_nip: '1234567890',
    gross_total: 123, net_total: 100, vat_total: 23, ksef_status: 'draft',
    fa3_data: { internalNumber: number, type: 'VAT' }, seller_data: { nip: '9480000014' }, buyer_data: { nip: '1234567890' },
    ...patch,
  });
  if (error) throw new Error(`insert invoices: ${error.message}`);
  return id;
}

async function row(id: string) {
  const { data, error } = await admin
    .from('invoices')
    .select('ksef_status, ksef_send_owner, submitted_to_ksef_at, xml_storage_path, xml_generated_at, last_attempt_at, submission_attempts, last_error, last_error_code, ksef_number')
    .eq('id', id)
    .single();
  if (error) throw error;
  return data;
}

async function auditRows(invoiceId: string, action: string) {
  const { data, error } = await admin
    .from('audit_logs')
    .select('action, user_id, details_json')
    .eq('tenant_id', ORG)
    .eq('entity_id', invoiceId)
    .eq('action', action);
  if (error) throw error;
  return data ?? [];
}

async function sentSubmission(invoiceId: string, status: 'sent' | 'accepted' | 'rejected' | 'duplicate', attemptedAt?: string) {
  const { error } = await admin.from('ksef_submissions').insert({
    tenant_id: ORG, invoice_id: invoiceId, submission_type: 'online', status,
    session_reference_number: `SES-${counter}`, invoice_reference_number: `REF-${counter}`,
    ...(attemptedAt ? { attempted_at: attemptedAt } : {}),
  });
  if (error) throw new Error(`insert ksef_submissions: ${error.message}`);
}

/**
 * Wpis zamiaru wysyłki (A2, 00136): numer sesji jest, numeru referencyjnego
 * faktury jeszcze nie — tak wygląda próba, w której odpowiedź na POST zginęła.
 */
async function intentSubmission(invoiceId: string, status: 'intent' | 'abandoned', attemptedAt?: string) {
  const { error } = await admin.from('ksef_submissions').insert({
    tenant_id: ORG, invoice_id: invoiceId, submission_type: 'online', status,
    session_reference_number: `SES-${counter}`, invoice_reference_number: null,
    ...(attemptedAt ? { attempted_at: attemptedAt } : {}),
  });
  if (error) throw new Error(`insert ksef_submissions: ${error.message}`);
}

/** Wyzwalacze 00119 blokują DELETE poza szkicem bez śladu wysyłki — najpierw powrót do szkicu. */
async function cleanupInvoices() {
  await admin.from('upo_receipts').delete().eq('tenant_id', ORG);
  await admin.from('ksef_submissions').delete().eq('tenant_id', ORG);
  await admin.from('invoices').update({
    ksef_status: 'draft', ksef_send_owner: null, submitted_to_ksef_at: null, last_attempt_at: null,
    ksef_number: null, ksef_accepted_at: null, xml_storage_path: null,
  }).eq('tenant_id', ORG).neq('ksef_status', 'accepted');
  await admin.from('invoices').delete().eq('tenant_id', ORG);
  await admin.from('audit_logs').delete().eq('tenant_id', ORG);
}

describe.skipIf(!hasDatabase)('cykl życia faktury KSeF — RPC i dowód kontaktu (00131)', () => {
  beforeAll(async () => {
    ownerId = await userId(OWNER_EMAIL);
    await cleanupInvoices();
    await admin.from('memberships').delete().eq('organization_id', ORG);
    await admin.from('tenants').delete().eq('id', ORG);
    const { error: tErr } = await admin.from('tenants').insert({ id: ORG, nip: '9480000014', name: 'Firma Cykl Życia' });
    if (tErr) throw tErr;
    await admin.from('users').upsert([{ id: ownerId, name: 'Owner Cykl' }], { onConflict: 'id' });
    const { error: mErr } = await admin.from('memberships').insert([
      { organization_id: ORG, user_id: ownerId, role: 'owner', status: 'active' },
    ]);
    if (mErr) throw mErr;
  });

  beforeEach(async () => {
    await cleanupInvoices();
  });

  afterAll(async () => {
    if (!hasDatabase) return;
    await cleanupInvoices();
    await admin.from('memberships').delete().eq('organization_id', ORG);
    await admin.from('tenants').delete().eq('id', ORG);
  });

  it('katalog kodów: klient czyta, klasy są z zamkniętej listy', async () => {
    const c = await signedIn(OWNER_EMAIL);
    const { data, error } = await c.from('ksef_error_codes').select('code, class, auto_requeue');
    expect(error).toBeNull();
    const byCode = new Map((data ?? []).map((r) => [r.code, r]));
    expect(byCode.get('XSD_INVALID')?.class).toBe('terminal');
    expect(byCode.get('KSEF_UNAVAILABLE')).toMatchObject({ class: 'transient', auto_requeue: true });
    expect(byCode.get('KSEF_PAUSED')?.class).toBe('hold');
    expect(byCode.get('KSEF_DUPLICATE_RECONCILE')?.class).toBe('reconcile');
    expect(byCode.get('NO_CERTIFICATE')?.class).toBe('setup');
    expect(byCode.get('NOT_IN_KSEF')).toMatchObject({ class: 'transient', auto_requeue: false });
    expect(byCode.get('KSEF_NUMBER_TAKEN')).toMatchObject({ class: 'terminal', auto_requeue: false });
    expect(byCode.get('ENV_MISMATCH')).toMatchObject({ class: 'terminal', auto_requeue: false });
    // 00147: dokument specjalny z datą wystawienia sprzed dzisiaj — tylko szkic.
    expect(byCode.get('ISSUE_DATE_PASSED')).toMatchObject({ class: 'terminal', auto_requeue: false });
  });

  it('00147: ISSUE_DATE_PASSED bez dowodu wraca do szkicu; ponowienie odmówione; strażnik I4 kodu nie zgłasza', async () => {
    const toDraft = await invoice({ ksef_status: 'failed', last_error_code: 'ISSUE_DATE_PASSED' });
    const reset = await admin.rpc('reset_ksef_send', { p_invoice_id: toDraft, p_tenant_id: ORG, p_actor_user_id: ownerId });
    expect(reset.error).toBeNull();
    expect((await row(toDraft)).ksef_status).toBe('draft');

    const noResend = await invoice({ ksef_status: 'failed', last_error_code: 'ISSUE_DATE_PASSED' });
    const requeue = await admin.rpc('requeue_ksef_send', {
      p_invoice_id: noResend, p_tenant_id: ORG, p_attempt_id: ATTEMPT, p_actor_user_id: ownerId,
    });
    expect(requeue.error?.code).toBe('P0001');
    expect((await row(noResend)).ksef_status).toBe('failed');

    const { data } = await admin.rpc('ksef_lifecycle_violations');
    const flagged = ((data ?? []) as Array<{ invoice_id: string }>).filter((v) => v.invoice_id === noResend);
    expect(flagged).toEqual([]);
  });

  it('D-A4-2 (00143): ENV_MISMATCH bez dowodu wraca do szkicu; ponowienie w bieżącym środowisku odmówione; „tylko uzgodnij” przy otwartym wpisie działa', async () => {
    const toDraft = await invoice({ ksef_status: 'failed', last_error_code: 'ENV_MISMATCH' });
    const reset = await admin.rpc('reset_ksef_send', { p_invoice_id: toDraft, p_tenant_id: ORG, p_actor_user_id: ownerId });
    expect(reset.error).toBeNull();
    expect(await row(toDraft)).toMatchObject({ ksef_status: 'draft', last_error_code: null });

    // Ponowienie wysłałoby fakturę zleconą w innym środowisku tam, gdzie
    // jesteśmy teraz (np. dokument z TEST na PROD) — baza odmawia, nie tylko przycisk.
    const noResend = await invoice({ ksef_status: 'failed', last_error_code: 'ENV_MISMATCH' });
    const requeue = await admin.rpc('requeue_ksef_send', {
      p_invoice_id: noResend, p_tenant_id: ORG, p_attempt_id: ATTEMPT, p_actor_user_id: ownerId,
    });
    expect(requeue.error?.code).toBe('P0001');
    expect((await row(noResend)).ksef_status).toBe('failed');

    // Wcześniejsza próba mogła dotrzeć do KSeF: bez szkicu, uzgodnienie po referencji.
    const contacted = await invoice({ ksef_status: 'failed', last_error_code: 'ENV_MISMATCH' });
    await sentSubmission(contacted, 'sent');
    expect((await admin.rpc('reset_ksef_send', { p_invoice_id: contacted, p_tenant_id: ORG, p_actor_user_id: ownerId })).error?.code).toBe('P0001');
    const reconcile = await admin.rpc('requeue_ksef_send', {
      p_invoice_id: contacted, p_tenant_id: ORG, p_attempt_id: ATTEMPT, p_actor_user_id: ownerId, p_reconcile_only: true,
    });
    expect(reconcile.error).toBeNull();
    expect((await row(contacted)).ksef_status).toBe('queued');
  });

  it('D-A4-1 (00142): wpisy number_taken (numer zajęty przez inną fakturę) nie są dowodem kontaktu — klient wraca do szkicu', async () => {
    const taken = await invoice({ ksef_status: 'failed', last_error_code: 'KSEF_NUMBER_TAKEN' });
    for (const session of ['SES-NT-1', 'SES-NT-2']) {
      const { error } = await admin.from('ksef_submissions').insert({
        tenant_id: ORG, invoice_id: taken, submission_type: 'online', status: 'number_taken',
        session_reference_number: session, invoice_reference_number: `${session}-REF`,
        // Znacznik 440 z 00142 — kolumny muszą istnieć.
        original_ksef_number: '9480000014-20261001-000000000099-00', original_session_reference_number: 'SES-ORYGINAL',
      });
      if (error) throw new Error(`insert ksef_submissions: ${error.message}`);
    }
    expect((await admin.rpc('ksef_has_contact_evidence', { p_invoice_id: taken, p_tenant_id: ORG })).data).toBe(false);
    const reset = await admin.rpc('reset_ksef_send', { p_invoice_id: taken, p_tenant_id: ORG, p_actor_user_id: ownerId });
    expect(reset.error).toBeNull();
    expect((await row(taken)).ksef_status).toBe('draft');
  });

  it('D-A4-1b-3 (00144): dane oryginału 440 na wpisie próby — klient firmy je czyta, nie może ich zmienić', async () => {
    const id = await invoice({ ksef_status: 'failed', last_error_code: 'KSEF_DUPLICATE_RECONCILE' });
    const check = { v: 1, env: 'test', reason: 'faktflow-original', summary: { number: 'CYKL/x', gross: '123.00' } };
    const { error } = await admin.from('ksef_submissions').insert({
      tenant_id: ORG, invoice_id: id, submission_type: 'online', status: 'sent', error_code: '440',
      session_reference_number: 'SES-440', original_ksef_number: '9480000014-20261001-000000000077-00',
      original_check: check,
    });
    expect(error, `insert ksef_submissions: ${error?.message}`).toBeNull();

    const c = await signedIn(OWNER_EMAIL);
    const read = await c.from('ksef_submissions').select('original_ksef_number, original_check').eq('invoice_id', id);
    expect(read.error).toBeNull();
    expect(read.data).toEqual([{ original_ksef_number: '9480000014-20261001-000000000077-00', original_check: check }]);

    const forged = await c.from('ksef_submissions').update({ original_check: { v: 1, reason: 'podrobione' } }).eq('invoice_id', id).select('id');
    expect(forged.error?.code ?? (forged.data?.length === 0 ? 'brak' : 'zmienione')).not.toBe('zmienione');
    const after = await admin.from('ksef_submissions').select('original_check').eq('invoice_id', id).single();
    expect(after.data?.original_check).toEqual(check);
  });

  it('A2b: NOT_IN_KSEF bez dowodu kontaktu — powrót do szkicu i ponowna wysyłka działają (nie ślepa uliczka)', async () => {
    const toDraft = await invoice({ ksef_status: 'failed', last_error_code: 'NOT_IN_KSEF' });
    await intentSubmission(toDraft, 'abandoned');
    const reset = await admin.rpc('reset_ksef_send', { p_invoice_id: toDraft, p_tenant_id: ORG, p_actor_user_id: ownerId });
    expect(reset.error).toBeNull();
    expect((await row(toDraft)).ksef_status).toBe('draft');

    const toQueue = await invoice({ ksef_status: 'failed', last_error_code: 'NOT_IN_KSEF' });
    const requeue = await admin.rpc('requeue_ksef_send', { p_invoice_id: toQueue, p_tenant_id: ORG, p_attempt_id: ATTEMPT, p_actor_user_id: ownerId });
    expect(requeue.error).toBeNull();
    expect((await row(toQueue)).ksef_status).toBe('queued');

    // Kod jest w katalogu — strażnik I4 go nie zgłasza.
    const { data } = await admin.rpc('ksef_lifecycle_violations');
    const flagged = ((data ?? []) as Array<{ invariant: string; invoice_id: string }>).filter((v) => v.invoice_id === toDraft || v.invoice_id === toQueue);
    expect(flagged).toEqual([]);
  });

  it('przejścia są tylko dla serwisu: anon i zalogowany dostają 42501', async () => {
    const id = await invoice({});
    const clients = [anonClient(), await signedIn(OWNER_EMAIL)];
    for (const c of clients) {
      expect((await c.rpc('enqueue_ksef_send', { p_invoice_id: id, p_tenant_id: ORG, p_attempt_id: ATTEMPT })).error?.code).toBe('42501');
      expect((await c.rpc('release_ksef_enqueue', { p_invoice_id: id, p_tenant_id: ORG, p_reason: 'test' })).error?.code).toBe('42501');
      expect((await c.rpc('requeue_ksef_send', { p_invoice_id: id, p_tenant_id: ORG, p_attempt_id: ATTEMPT, p_actor_user_id: ownerId })).error?.code).toBe('42501');
      expect((await c.rpc('reset_ksef_send', { p_invoice_id: id, p_tenant_id: ORG, p_actor_user_id: ownerId })).error?.code).toBe('42501');
    }
    // Zalogowany członek może zapytać o dowód kontaktu (interfejs pokazuje przyciski).
    const member = await signedIn(OWNER_EMAIL);
    const evidence = await member.rpc('ksef_has_contact_evidence', { p_invoice_id: id, p_tenant_id: ORG });
    expect(evidence.error).toBeNull();
    expect(evidence.data).toBe(false);
  });

  it('dowód kontaktu: numer KSeF albo wpis sent/accepted/duplicate; samo rejected nie jest dowodem', async () => {
    const evidence = (id: string) => admin.rpc('ksef_has_contact_evidence', { p_invoice_id: id, p_tenant_id: ORG });

    const clean = await invoice({ ksef_status: 'failed', last_error_code: 'INFRA' });
    expect((await evidence(clean)).data).toBe(false);

    const rejectedOnly = await invoice({ ksef_status: 'rejected', last_error_code: 'KSEF_REJECTED' });
    await sentSubmission(rejectedOnly, 'rejected');
    expect((await evidence(rejectedOnly)).data).toBe(false);

    const sent = await invoice({ ksef_status: 'failed', last_error_code: 'RESULT_UNCERTAIN' });
    await sentSubmission(sent, 'sent');
    expect((await evidence(sent)).data).toBe(true);

    const duplicate = await invoice({ ksef_status: 'failed', last_error_code: 'KSEF_DUPLICATE_RECONCILE' });
    await sentSubmission(duplicate, 'duplicate');
    expect((await evidence(duplicate)).data).toBe(true);

    const numbered = await invoice({ ksef_status: 'accepted', ksef_number: '9480000014-20261001-000000000001-00', ksef_environment: 'test', xml_storage_path: 'x.xml' });
    expect((await evidence(numbered)).data).toBe(true);
  });

  it('A2 (00136): zamiar wysyłki jest dowodem kontaktu i blokuje powrót do szkicu; porzucony nie; stary zamiar widzi strażnik (I5)', async () => {
    const evidence = (id: string) => admin.rpc('ksef_has_contact_evidence', { p_invoice_id: id, p_tenant_id: ORG });
    const reset = (id: string) => admin.rpc('reset_ksef_send', { p_invoice_id: id, p_tenant_id: ORG, p_actor_user_id: ownerId });

    // Odpowiedź na POST zginęła: KSeF mógł dostać fakturę — treści nie wolno zmienić.
    const intent = await invoice({ ksef_status: 'failed', last_error_code: 'INFRA' });
    await intentSubmission(intent, 'intent');
    expect((await evidence(intent)).data).toBe(true);
    expect((await reset(intent)).error?.code).toBe('P0001');
    expect((await row(intent)).ksef_status).toBe('failed');

    // Runner sprawdził sesję w KSeF: pusta — faktura z tej próby nie dotarła.
    const abandoned = await invoice({ ksef_status: 'failed', last_error_code: 'INFRA' });
    await intentSubmission(abandoned, 'abandoned');
    expect((await evidence(abandoned)).data).toBe(false);
    expect((await reset(abandoned)).error).toBeNull();
    expect((await row(abandoned)).ksef_status).toBe('draft');

    const staleIntent = await invoice({ ksef_status: 'failed', last_error_code: 'RESULT_UNCERTAIN' });
    await intentSubmission(staleIntent, 'intent', '2026-09-01T10:00:00Z');
    const { data, error } = await admin.rpc('ksef_lifecycle_violations');
    expect(error).toBeNull();
    const invariants = ((data ?? []) as Array<{ invariant: string; invoice_id: string }>)
      .filter((v) => v.invoice_id === staleIntent)
      .map((v) => v.invariant);
    expect(invariants).toEqual(['I5']);
  });

  it('A3: audyt „tylko uzgodnij” z crona — filtr crona (aktor NULL, details_json->>reconcile_only = true) liczy tylko uzgodnienia', async () => {
    const reconciled = await invoice({ ksef_status: 'failed', last_error_code: 'RESULT_UNCERTAIN' });
    await sentSubmission(reconciled, 'sent', '2026-09-01T10:00:00Z');
    const plain = await invoice({ ksef_status: 'failed', last_error_code: 'KSEF_UNAVAILABLE' });
    expect((await admin.rpc('requeue_ksef_send', {
      p_invoice_id: reconciled, p_tenant_id: ORG, p_attempt_id: ATTEMPT, p_actor_user_id: null, p_reconcile_only: true,
    })).error).toBeNull();
    expect((await admin.rpc('requeue_ksef_send', {
      p_invoice_id: plain, p_tenant_id: ORG, p_attempt_id: ATTEMPT, p_actor_user_id: null,
    })).error).toBeNull();

    const { data, error } = await admin
      .from('audit_logs')
      .select('entity_id')
      .eq('action', 'invoice.send_requeued')
      .is('user_id', null)
      .eq('details_json->>reconcile_only', 'true')
      .in('entity_id', [reconciled, plain]);
    expect(error).toBeNull();
    expect((data ?? []).map((r) => r.entity_id)).toEqual([reconciled]);
    expect((await row(reconciled)).ksef_status).toBe('queued');
  });

  it('enqueue: tylko szkic przechodzi do queued, drugi raz i z failed — odmowa', async () => {
    const id = await invoice({});
    const first = await admin.rpc('enqueue_ksef_send', { p_invoice_id: id, p_tenant_id: ORG, p_attempt_id: ATTEMPT });
    expect(first.error).toBeNull();
    expect(first.data).toMatchObject({ id, ksef_status: 'queued', ksef_send_owner: null });

    const again = await admin.rpc('enqueue_ksef_send', { p_invoice_id: id, p_tenant_id: ORG, p_attempt_id: ATTEMPT });
    expect(again.error?.code).toBe('P0002');

    const failed = await invoice({ ksef_status: 'failed', last_error_code: 'INFRA' });
    expect((await admin.rpc('enqueue_ksef_send', { p_invoice_id: failed, p_tenant_id: ORG, p_attempt_id: ATTEMPT })).error?.code).toBe('P0002');

    const audit = await auditRows(id, 'invoice.send_enqueued');
    expect(audit).toHaveLength(1);
    expect(audit[0]!.details_json).toMatchObject({ attempt_id: ATTEMPT });
  });

  it('release: queued bez dowodu wraca do szkicu z audytem; z wpisem sent — nie', async () => {
    const lost = await invoice({ ksef_status: 'queued' });
    const released = await admin.rpc('release_ksef_enqueue', { p_invoice_id: lost, p_tenant_id: ORG, p_reason: 'brak joba' });
    expect(released.error).toBeNull();
    expect(released.data).toBe(true);
    expect(await row(lost)).toMatchObject({ ksef_status: 'draft', ksef_send_owner: null, submitted_to_ksef_at: null });
    expect(await auditRows(lost, 'invoice.enqueue_released')).toHaveLength(1);

    const contacted = await invoice({ ksef_status: 'queued' });
    await sentSubmission(contacted, 'sent');
    const kept = await admin.rpc('release_ksef_enqueue', { p_invoice_id: contacted, p_tenant_id: ORG, p_reason: 'brak joba' });
    expect(kept.error).toBeNull();
    expect(kept.data).toBe(false);
    expect((await row(contacted)).ksef_status).toBe('queued');
  });

  it('requeue: failed z kodem przejściowym wraca do kolejki; kod treści, rejected bez trybu uzgodnienia — odmowa', async () => {
    const transient = await invoice({
      ksef_status: 'failed', last_error_code: 'KSEF_UNAVAILABLE', last_error: 'KSeF HTTP 503',
      ksef_send_owner: 'stara-proba', submitted_to_ksef_at: '2026-10-01T10:00:00Z', submission_attempts: 6,
    });
    const requeued = await admin.rpc('requeue_ksef_send', {
      p_invoice_id: transient, p_tenant_id: ORG, p_attempt_id: 'proba-2', p_actor_user_id: ownerId,
    });
    expect(requeued.error).toBeNull();
    expect(requeued.data).toMatchObject({ ksef_status: 'queued', ksef_send_owner: null, submission_attempts: 7, last_error_code: null, last_error: null });
    const audit = await auditRows(transient, 'invoice.send_requeued');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ user_id: ownerId });
    expect(audit[0]!.details_json).toMatchObject({ previous_code: 'KSEF_UNAVAILABLE', previous_status: 'failed', attempt_id: 'proba-2' });

    const terminal = await invoice({ ksef_status: 'failed', last_error_code: 'XSD_INVALID' });
    const refused = await admin.rpc('requeue_ksef_send', {
      p_invoice_id: terminal, p_tenant_id: ORG, p_attempt_id: 'proba-3', p_actor_user_id: ownerId,
    });
    expect(refused.error?.code).toBe('P0001');
    expect((await row(terminal)).ksef_status).toBe('failed');

    const rejected = await invoice({ ksef_status: 'rejected', last_error_code: 'KSEF_REJECTED' });
    expect((await admin.rpc('requeue_ksef_send', {
      p_invoice_id: rejected, p_tenant_id: ORG, p_attempt_id: 'proba-4', p_actor_user_id: ownerId,
    })).error?.code).toBe('P0001');
    const reconcile = await admin.rpc('requeue_ksef_send', {
      p_invoice_id: rejected, p_tenant_id: ORG, p_attempt_id: 'proba-5', p_actor_user_id: ownerId, p_reconcile_only: true,
    });
    expect(reconcile.error).toBeNull();
    expect(reconcile.data).toMatchObject({ ksef_status: 'queued' });

    // Kod historyczny (NULL) nie blokuje — decyduje człowiek.
    const legacy = await invoice({ ksef_status: 'failed' });
    expect((await admin.rpc('requeue_ksef_send', {
      p_invoice_id: legacy, p_tenant_id: ORG, p_attempt_id: 'proba-6', p_actor_user_id: ownerId,
    })).error).toBeNull();
  });

  it('reset: failed bez dowodu wraca do szkicu z wyczyszczonymi polami wysyłki i audytem poprzednich wartości', async () => {
    const id = await invoice({
      ksef_status: 'failed', last_error_code: 'INFRA', last_error: 'PostgREST 503',
      ksef_send_owner: 'proba-A', submitted_to_ksef_at: '2026-10-01T10:00:00Z', last_attempt_at: '2026-10-01T10:00:00Z',
      submission_attempts: 6, xml_storage_path: 'invoices/x.xml', xml_generated_at: '2026-10-01T09:59:00Z',
    });
    const reset = await admin.rpc('reset_ksef_send', { p_invoice_id: id, p_tenant_id: ORG, p_actor_user_id: ownerId });
    expect(reset.error).toBeNull();
    expect(await row(id)).toMatchObject({
      ksef_status: 'draft', ksef_send_owner: null, submitted_to_ksef_at: null, xml_storage_path: null,
      xml_generated_at: null, last_attempt_at: null, submission_attempts: 0, last_error: null, last_error_code: null,
    });
    const audit = await auditRows(id, 'invoice.send_reset');
    expect(audit).toHaveLength(1);
    expect(audit[0]!.details_json).toMatchObject({
      previous_status: 'failed', previous_code: 'INFRA', previous_attempts: 6, previous_xml_storage_path: 'invoices/x.xml',
    });

    // Po powrocie do szkicu klient może fakturę usunąć (00119/00122 widzą czysty szkic).
    const c = await signedIn(OWNER_EMAIL);
    const del = await c.from('invoices').delete().eq('id', id).select('id');
    expect(del.error).toBeNull();
    expect(del.data).toHaveLength(1);
  });

  it('reset: odmowa przy dowodzie kontaktu i przy kodzie do uzgodnienia; rejected z zamkniętym wpisem wraca do szkicu', async () => {
    const contacted = await invoice({ ksef_status: 'failed', last_error_code: 'INFRA' });
    await sentSubmission(contacted, 'sent');
    expect((await admin.rpc('reset_ksef_send', { p_invoice_id: contacted, p_tenant_id: ORG, p_actor_user_id: ownerId })).error?.code).toBe('P0001');
    expect((await row(contacted)).ksef_status).toBe('failed');

    // Klasa reconcile (ENV_MISMATCH od 00143 jest terminal — D-A4-2).
    const reconcile = await invoice({ ksef_status: 'failed', last_error_code: 'INVALID_EVENT' });
    expect((await admin.rpc('reset_ksef_send', { p_invoice_id: reconcile, p_tenant_id: ORG, p_actor_user_id: ownerId })).error?.code).toBe('P0001');

    const rejected = await invoice({ ksef_status: 'rejected', last_error_code: 'KSEF_REJECTED', submitted_to_ksef_at: '2026-10-01T10:00:00Z' });
    await sentSubmission(rejected, 'rejected');
    const reset = await admin.rpc('reset_ksef_send', { p_invoice_id: rejected, p_tenant_id: ORG, p_actor_user_id: ownerId });
    expect(reset.error).toBeNull();
    expect((await row(rejected)).ksef_status).toBe('draft');
    const { count } = await admin.from('ksef_submissions').select('id', { count: 'exact', head: true }).eq('invoice_id', rejected);
    expect(count).toBe(1);

    const accepted = await invoice({ ksef_status: 'accepted', ksef_number: '9480000014-20261001-000000000002-00', ksef_environment: 'test', xml_storage_path: 'x.xml' });
    expect((await admin.rpc('reset_ksef_send', { p_invoice_id: accepted, p_tenant_id: ORG, p_actor_user_id: ownerId })).error?.code).toBe('P0001');
  });

  it('strażnik: widzi I2, I3, I4, I5 i I9; zdrowe wiersze pomija; tylko dla serwisu', async () => {
    const sendingNoClaim = await invoice({ ksef_status: 'sending' });
    const acceptedNoUpo = await invoice({ ksef_status: 'accepted', ksef_number: '9480000014-20261001-000000000003-00', ksef_environment: 'test', xml_storage_path: 'x.xml' });
    const acceptedOk = await invoice({ ksef_status: 'accepted', ksef_number: '9480000014-20261001-000000000004-00', ksef_environment: 'test', xml_storage_path: 'y.xml' });
    // 00117: UPO przyjętej faktury niesie środowisko KSeF; bez niego wyzwalacz
    // odrzuca INSERT, a faktura „zdrowa” wyglądałaby jak bez UPO (I3).
    const upo = await admin.from('upo_receipts').insert({
      tenant_id: ORG, invoice_id: acceptedOk, ksef_number: '9480000014-20261001-000000000004-00',
      ksef_environment: 'test', status: 'downloaded',
      // NOT NULL w schemacie (moment przyjęcia przez KSeF).
      ksef_acceptance_timestamp: '2026-10-01T10:00:00Z',
    });
    expect(upo.error, `upo_receipts: ${upo.error?.message}`).toBeNull();
    const failedOwner = await invoice({ ksef_status: 'failed', last_error_code: 'INFRA', ksef_send_owner: 'wisząca' });
    const failedUnknownCode = await invoice({ ksef_status: 'failed', last_error_code: 'COS_DZIWNEGO' });
    const failedOk = await invoice({ ksef_status: 'failed', last_error_code: 'KSEF_UNAVAILABLE' });
    const staleSent = await invoice({ ksef_status: 'failed', last_error_code: 'RESULT_UNCERTAIN' });
    await sentSubmission(staleSent, 'sent', '2026-09-01T10:00:00Z');
    const failedWithNumber = await invoice({ ksef_status: 'failed', last_error_code: 'INFRA', ksef_number: '9480000014-20261001-000000000005-00' });
    const freshQueued = await invoice({ ksef_status: 'queued' });

    const { data, error } = await admin.rpc('ksef_lifecycle_violations');
    expect(error).toBeNull();
    const byInvoice = new Map<string, string[]>();
    for (const v of (data ?? []) as Array<{ invariant: string; invoice_id: string }>) {
      byInvoice.set(v.invoice_id, [...(byInvoice.get(v.invoice_id) ?? []), v.invariant]);
    }
    expect(byInvoice.get(sendingNoClaim)).toEqual(['I2']);
    expect(byInvoice.get(acceptedNoUpo)).toEqual(['I3']);
    expect(byInvoice.get(acceptedOk)).toBeUndefined();
    expect(byInvoice.get(failedOwner)).toEqual(['I4']);
    expect(byInvoice.get(failedUnknownCode)).toEqual(['I4']);
    expect(byInvoice.get(failedOk)).toBeUndefined();
    expect(byInvoice.get(staleSent)).toEqual(['I5']);
    expect(byInvoice.get(failedWithNumber)).toEqual(['I9']);
    expect(byInvoice.get(freshQueued)).toBeUndefined();

    expect((await anonClient().rpc('ksef_lifecycle_violations')).error?.code).toBe('42501');
    expect((await (await signedIn(OWNER_EMAIL)).rpc('ksef_lifecycle_violations')).error?.code).toBe('42501');
  });

  // 00155 (decyzja Bartosza 22.10.2026): UPO istnieje tylko dla faktur wysłanych
  // sesją FaktWay. Historia pobrana z KSeF (`origin = ksef_import`) bez związku
  // z naszą wysyłką nie ma UPO — I3 jej nie zgłasza (przed 00155: zgłaszał każdą).
  it('strażnik I3 (00155): historia z KSeF bez UPO pominięta; bez XML, z oryginałem 440 i z FaktWay — zgłaszane', async () => {
    const historyNoUpo = await invoice({ origin: 'ksef_import', ksef_status: 'accepted', ksef_number: '9480000014-20261001-000000000155-00', ksef_environment: 'test', xml_storage_path: 'h.xml' });
    const historyNoXml = await invoice({ origin: 'ksef_import', ksef_status: 'accepted', ksef_number: '9480000014-20261001-000000000156-00', ksef_environment: 'test' });
    const historyLinked = await invoice({ origin: 'ksef_import', ksef_status: 'accepted', ksef_number: '9480000014-20261001-000000000157-00', ksef_environment: 'test', xml_storage_path: 'l.xml' });
    const appNoUpo = await invoice({ ksef_status: 'accepted', ksef_number: '9480000014-20261001-000000000158-00', ksef_environment: 'test', xml_storage_path: 'a.xml' });
    // Oryginał 440 (PR C): nasza próba wysyłki szkicu wskazuje numer KSeF tej faktury.
    const draft = await invoice({});
    const { error: subError } = await admin.from('ksef_submissions').insert({
      tenant_id: ORG, invoice_id: draft, submission_type: 'online', status: 'duplicate',
      session_reference_number: `SES-${counter}`, invoice_reference_number: `REF-${counter}`,
      original_ksef_number: '9480000014-20261001-000000000157-00',
    });
    expect(subError).toBeNull();

    const { data, error } = await admin.rpc('ksef_lifecycle_violations');
    expect(error).toBeNull();
    const i3 = new Set(((data ?? []) as Array<{ invariant: string; invoice_id: string }>)
      .filter((v) => v.invariant === 'I3').map((v) => v.invoice_id));
    expect(i3.has(historyNoUpo)).toBe(false);
    expect(i3.has(historyNoXml)).toBe(true);
    expect(i3.has(historyLinked)).toBe(true);
    expect(i3.has(appNoUpo)).toBe(true);
  });
});

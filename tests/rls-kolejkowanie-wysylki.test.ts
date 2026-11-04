import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { getRlsTestDatabaseUrl, getRlsTestEnvironment } from './helpers/rls-environment';

/**
 * Cykl życia faktury, PR 3 (W16/W2 z rewizji 03.10.2026) — na prawdziwej bazie,
 * prawdziwym pg-boss i prawdziwych wyzwalaczach:
 *
 *   - zmiana `draft → queued` (RPC `enqueue_ksef_send`, 00131) i zapis zlecenia
 *     są jedną transakcją: gdy zapis zlecenia pada, faktura zostaje szkicem
 *     (do 03.10.2026 zostawała w `queued` na zawsze — W2),
 *   - drugie kolejkowanie tej samej faktury odbija się od warunku `draft`
 *     w RPC (P0002) i nie tworzy drugiego zlecenia,
 *   - ponowna wysyłka (`requeue_ksef_send`) działa tylko dla kodów spoza
 *     klasy terminal i tylko z `failed` (z `rejected` w trybie uzgodnienia),
 *   - rola połączenia pg-boss (`DATABASE_URL`) ma prawo wykonać RPC.
 *
 * Wymaga `RLS_TEST_DATABASE_URL` (ta sama lokalna baza, połączenie Postgres).
 */

const hasDatabase = Boolean(
  process.env.RLS_TEST_SUPABASE_URL?.trim() &&
    process.env.RLS_TEST_SUPABASE_ANON_KEY?.trim() &&
    process.env.RLS_TEST_SUPABASE_SERVICE_ROLE_KEY?.trim() &&
    process.env.RLS_TEST_DATABASE_URL?.trim(),
);
const environment = hasDatabase ? getRlsTestEnvironment() : null;
const databaseUrl = hasDatabase ? getRlsTestDatabaseUrl() : null;
const admin: SupabaseClient = environment
  ? createClient(environment.url, environment.serviceRoleKey)
  : (null as unknown as SupabaseClient);

const ORG = '66666666-6666-4666-8666-666666666666';
const OWNER_EMAIL = 'rls-kolejka-owner@ksef-saas.test';
const PASS = 'RlsKolejkaPass2026Aa!';
const QUEUE = 'invoice.submit.requested';

let ownerId = '';
let counter = 0;
let boss: import('pg-boss').PgBoss;
let sendJobEvent: typeof import('@/lib/jobs/enqueue').sendJobEvent;
let ksefSendTransactionStep: typeof import('@/lib/invoices/ksef-send-step').ksefSendTransactionStep;
let stopBoss: typeof import('@/lib/jobs/boss').stopBoss;

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

/** Faktura wychodząca firmy ORG w zadanym stanie; zwraca id. */
async function invoice(patch: Record<string, unknown>): Promise<string> {
  counter += 1;
  const id = `6666aaaa-0000-4000-8000-${String(counter).padStart(12, '0')}`;
  const number = `KOL/${counter}`;
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
    .select('ksef_status, ksef_send_owner, last_error_code')
    .eq('id', id)
    .single();
  if (error) throw error;
  return data;
}

async function jobsFor(invoiceId: string) {
  const { rows } = await boss.getDb().executeSql(
    `SELECT id, state, singleton_key, data FROM pgboss.job WHERE name = $1 AND data->>'invoiceId' = $2 ORDER BY created_on`,
    [QUEUE, invoiceId],
  );
  return rows as Array<{ id: string; state: string; singleton_key: string | null; data: { sendAttemptId?: string } }>;
}

async function auditCount(invoiceId: string, action: string): Promise<number> {
  const { count, error } = await admin
    .from('audit_logs')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', ORG)
    .eq('entity_id', invoiceId)
    .eq('action', action);
  if (error) throw error;
  return count ?? 0;
}

/** Skrót bajtów oryginału 440 (`original_check.sha256`) — fikcyjny, poprawny kształt. */
const ORIGINAL_SHA = 'bb'.repeat(32);

/** Fikcyjny numer KSeF oryginału w formacie KSeF. */
function originalNumber(n: number): string {
  return `9480000014-20260915-${String(n).padStart(12, '0')}-00`;
}

/** Dane oryginału z PR B: powód no-own-file, komplet danych, środowisko test. */
function originalCheck(invoiceNumber: string, k: string): Record<string, unknown> {
  return {
    v: 1, env: 'test', checkedAt: '2026-09-01T10:05:00Z', reason: 'no-own-file', sha256: ORIGINAL_SHA,
    archivePath: `${ORG}/ksef-import/${k}.xml`, sizeBytes: 2048,
    summary: {
      systemInfo: 'Inny Program 1.0', number: invoiceNumber, issueDate: '2026-10-01', buyerNip: '1234567890',
      buyerName: 'Nabywca Kolejka', gross: '123.00', currency: 'PLN',
    },
    sameContentExceptHeader: null, ownHistory: false, acquiredAt: '2026-08-31T09:00:00Z',
    httpStatus: null, knownInvoice: null, recheck: null,
  };
}

async function internalNumber(id: string): Promise<string> {
  const { data, error } = await admin.from('invoices').select('internal_number').eq('id', id).single();
  if (error) throw error;
  return data.internal_number as string;
}

/**
 * Nierozstrzygnięty 440, na który klient może odpowiedzieć decyzją: faktura
 * failed KSEF_DUPLICATE_RECONCILE i otwarty wpis `sent` ze znacznikiem 440.
 */
async function pendingDuplicate(patch: Record<string, unknown> = {}): Promise<{ id: string; number: string; k: string }> {
  const id = await invoice({
    ksef_status: 'failed', last_error_code: 'KSEF_DUPLICATE_RECONCILE',
    last_error: 'KSeF ma już fakturę o tym numerze — do rozstrzygnięcia na karcie faktury.',
    submitted_to_ksef_at: '2026-10-01T10:00:00Z', submission_attempts: 6, ...patch,
  });
  const number = await internalNumber(id);
  const k = originalNumber(counter);
  const { error } = await admin.from('ksef_submissions').insert({
    tenant_id: ORG, invoice_id: id, submission_type: 'online', status: 'sent', error_code: '440',
    session_reference_number: `SES-KOL-${counter}`, invoice_reference_number: `REF-KOL-${counter}`,
    request_payload_hash: 'aa'.repeat(32), original_ksef_number: k,
    original_session_reference_number: `SES-ORIG-KOL-${counter}`, original_check: originalCheck(number, k),
    attempted_at: '2026-09-01T10:00:00Z',
  });
  if (error) throw new Error(`insert ksef_submissions: ${error.message}`);
  return { id, number, k };
}

/** Szkic wycofany automatycznym „numer zajęty” (KSEF_NUMBER_TAKEN → szkic): wpis number_taken z numerem oryginału. */
async function retire(invoiceId: string, k: string): Promise<void> {
  const { error } = await admin.from('ksef_submissions').insert({
    tenant_id: ORG, invoice_id: invoiceId, submission_type: 'online', status: 'number_taken',
    error_code: 'NUMBER_TAKEN', error_message: `Numer zajęty w KSeF przez fakturę ${k}`,
    session_reference_number: `SES-NT-KOL-${counter}`, original_ksef_number: k,
    original_session_reference_number: `SES-ORIG-KOL-${counter}`,
    attempted_at: '2026-10-02T10:00:00Z', completed_at: '2026-10-02T10:00:05Z',
  });
  if (error) throw new Error(`insert ksef_submissions: ${error.message}`);
}

async function submissionsOf(invoiceId: string) {
  const { data, error } = await admin
    .from('ksef_submissions')
    .select('id, status, original_ksef_number, original_check, attempted_at, completed_at')
    .eq('invoice_id', invoiceId)
    .order('attempted_at');
  if (error) throw error;
  return data ?? [];
}

/**
 * Faktura abonamentu FaktWay (`stripe_invoice_id`) — powstaje tylko jako
 * właściciel bazy: 00079 odmawia serwisowi zapisu tożsamości, a 00080 wymaga
 * wiersza `stripe_payments` z referencją płatności. Od 00115 wpłata musi mieć
 * potwierdzoną pełną parę PaymentIntent/Charge (`stripe_payment_refs_verified`,
 * CHECK `stripe_payments_verified_ref_pair`) — inaczej `zz_guard_billing_
 * invoice_financial_case` odmawia („Stripe financial case requires VAT
 * reconciliation”). Zwraca id i numer.
 */
async function billingInvoice(patch: { ksef_status: string; last_error_code: string }): Promise<{ id: string; number: string }> {
  counter += 1;
  const id = `6666aaaa-0000-4000-8000-${String(counter).padStart(12, '0')}`;
  const number = `KOL/ABO/${counter}`;
  const stripeInvoice = `in_KolejkaAbo${counter}`;
  await boss.getDb().executeSql(
    `INSERT INTO public.stripe_payments (tenant_id, stripe_payment_intent_id, stripe_charge_id, stripe_payment_refs_verified,
       stripe_invoice_id, status, amount_cents, currency)
     VALUES ($1::uuid, $2, $3, true, $4, 'succeeded', 12300, 'PLN')`,
    [ORG, `pi_KolejkaAbo${counter}`, `ch_KolejkaAbo${counter}`, stripeInvoice],
  );
  await boss.getDb().executeSql(
    `INSERT INTO public.invoices (id, tenant_id, direction, internal_number, invoice_type, issue_date, seller_nip, buyer_nip,
       gross_total, net_total, vat_total, ksef_status, last_error_code, last_error, submission_attempts,
       fa3_data, seller_data, buyer_data, stripe_invoice_id)
     VALUES ($1::uuid, $2::uuid, 'outgoing', $3, 'VAT', '2026-10-01', '9480000014', '1234567890',
       123, 100, 23, $4, $5, 'KSeF ma już fakturę o tym numerze.', 6,
       $6::jsonb, '{"nip":"9480000014"}'::jsonb, '{"nip":"1234567890"}'::jsonb, $7)`,
    [id, ORG, number, patch.ksef_status, patch.last_error_code, JSON.stringify({ internalNumber: number, type: 'VAT' }), stripeInvoice],
  );
  return { id, number };
}

function submitEvent(invoiceId: string, attemptId: string) {
  return {
    name: 'invoice/submit.requested',
    groupId: ORG,
    singletonKey: invoiceId,
    data: {
      tenantId: ORG,
      invoiceId,
      nip: '9480000014',
      environment: 'test',
      invoice: { internalNumber: 'KOL', type: 'VAT' },
      sendAttemptId: attemptId,
    },
  };
}

async function cleanup() {
  await boss?.getDb().executeSql(`DELETE FROM pgboss.job WHERE data->>'tenantId' = $1`, [ORG]);
  await admin.from('ksef_submissions').delete().eq('tenant_id', ORG);
  await admin.from('invoices').update({
    ksef_status: 'draft', ksef_send_owner: null, submitted_to_ksef_at: null, last_attempt_at: null,
  }).eq('tenant_id', ORG).neq('ksef_status', 'accepted');
  // Faktura abonamentu: 00079 nie pozwala jej usunąć serwisowi — sprząta właściciel bazy.
  await boss?.getDb().executeSql(`DELETE FROM public.invoices WHERE tenant_id = $1 AND stripe_invoice_id IS NOT NULL`, [ORG]);
  await boss?.getDb().executeSql(`DELETE FROM public.stripe_payments WHERE tenant_id = $1`, [ORG]);
  await admin.from('invoices').delete().eq('tenant_id', ORG);
  await admin.from('audit_logs').delete().eq('tenant_id', ORG);
}

describe.skipIf(!hasDatabase)('kolejkowanie wysyłki KSeF — RPC w transakcji ze zleceniem pg-boss (00131, PR 3)', () => {
  beforeAll(async () => {
    // Moduł kolejki czyta DATABASE_URL przy pierwszym użyciu — ta sama lokalna baza.
    process.env.DATABASE_URL = databaseUrl!;
    process.env.JOBS_BACKEND = 'pgboss';
    const bossModule = await import('@/lib/jobs/boss');
    stopBoss = bossModule.stopBoss;
    boss = await bossModule.startBoss();
    await boss.createQueue(QUEUE);
    ({ sendJobEvent } = await import('@/lib/jobs/enqueue'));
    ({ ksefSendTransactionStep } = await import('@/lib/invoices/ksef-send-step'));

    ownerId = await userId(OWNER_EMAIL);
    await cleanup();
    await admin.from('memberships').delete().eq('organization_id', ORG);
    await admin.from('tenants').delete().eq('id', ORG);
    const { error: tErr } = await admin.from('tenants').insert({ id: ORG, nip: '9480000014', name: 'Firma Kolejka' });
    if (tErr) throw tErr;
    await admin.from('users').upsert([{ id: ownerId, name: 'Owner Kolejka' }], { onConflict: 'id' });
    const { error: mErr } = await admin.from('memberships').insert([
      { organization_id: ORG, user_id: ownerId, role: 'owner', status: 'active' },
    ]);
    if (mErr) throw mErr;
  });

  beforeEach(async () => {
    await cleanup();
  });

  afterAll(async () => {
    if (!hasDatabase) return;
    await cleanup();
    await admin.from('memberships').delete().eq('organization_id', ORG);
    await admin.from('tenants').delete().eq('id', ORG);
    await stopBoss?.();
  });

  it('W2: gdy zapis zlecenia pada, przejście draft → queued jest wycofane', async () => {
    const id = await invoice({});
    // Zdarzenie zmapowane na kolejkę, której w tej bazie nie ma: pg-boss odmawia
    // zapisu zlecenia PO wykonaniu RPC — transakcja musi cofnąć zmianę statusu.
    const event = { ...submitEvent(id, 'proba-w2'), name: 'invoice/upo.requested' };

    await expect(
      sendJobEvent(event, { inTransaction: ksefSendTransactionStep({ kind: 'enqueue' }, { invoiceId: id, tenantId: ORG, attemptId: 'proba-w2' }) }),
    ).rejects.toThrow(/does not exist/);

    expect((await row(id)).ksef_status).toBe('draft');
    expect(await auditCount(id, 'invoice.send_enqueued')).toBe(0);
  });

  it('kolejkowanie: faktura queued, jedno zlecenie z singletonKey i sendAttemptId, audyt serwera', async () => {
    const id = await invoice({});

    const { ids } = await sendJobEvent(
      submitEvent(id, 'proba-ok'),
      { inTransaction: ksefSendTransactionStep({ kind: 'enqueue' }, { invoiceId: id, tenantId: ORG, attemptId: 'proba-ok' }) },
    );

    expect(ids).toHaveLength(1);
    expect(await row(id)).toMatchObject({ ksef_status: 'queued', ksef_send_owner: null });
    const jobs = await jobsFor(id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ state: 'created', singleton_key: id });
    expect(jobs[0]!.data.sendAttemptId).toBe('proba-ok');
    expect(await auditCount(id, 'invoice.send_enqueued')).toBe(1);
  });

  it('podwójne kliknięcie: drugie kolejkowanie dostaje P0002, zlecenie zostaje jedno', async () => {
    const id = await invoice({});
    const step = (attempt: string) => ksefSendTransactionStep({ kind: 'enqueue' }, { invoiceId: id, tenantId: ORG, attemptId: attempt });

    await sendJobEvent(submitEvent(id, 'proba-1'), { inTransaction: step('proba-1') });
    await expect(
      sendJobEvent(submitEvent(id, 'proba-2'), { inTransaction: step('proba-2') }),
    ).rejects.toMatchObject({ code: 'P0002' });

    expect((await row(id)).ksef_status).toBe('queued');
    expect(await jobsFor(id)).toHaveLength(1);
  });

  it('ponowna wysyłka: failed INFRA → queued ze zleceniem; błąd treści i rejected bez uzgodnienia odmawiają', async () => {
    const infra = await invoice({ ksef_status: 'failed', last_error_code: 'INFRA', ksef_send_owner: 'stara-proba' });
    const xsd = await invoice({ ksef_status: 'failed', last_error_code: 'XSD_INVALID' });
    const rejected = await invoice({ ksef_status: 'rejected', last_error_code: 'KSEF_REJECTED' });
    const requeue = (id: string, attempt: string, reconcileOnly = false) =>
      sendJobEvent(submitEvent(id, attempt), {
        inTransaction: ksefSendTransactionStep(
          { kind: 'requeue', actorUserId: ownerId, reconcileOnly },
          { invoiceId: id, tenantId: ORG, attemptId: attempt },
        ),
      });

    await requeue(infra, 'ponow-1');
    expect(await row(infra)).toMatchObject({ ksef_status: 'queued', ksef_send_owner: null, last_error_code: null });
    expect(await jobsFor(infra)).toHaveLength(1);
    expect(await auditCount(infra, 'invoice.send_requeued')).toBe(1);

    await expect(requeue(xsd, 'ponow-2')).rejects.toMatchObject({ code: 'P0001' });
    expect((await row(xsd)).ksef_status).toBe('failed');
    expect(await jobsFor(xsd)).toHaveLength(0);

    await expect(requeue(rejected, 'ponow-3')).rejects.toMatchObject({ code: 'P0001' });
    expect(await jobsFor(rejected)).toHaveLength(0);
    // Tryb „tylko uzgodnij” jest dla rejected dozwolony: job zaczyna od uzgodnienia po referencji.
    await requeue(rejected, 'ponow-4', true);
    expect((await row(rejected)).ksef_status).toBe('queued');
    expect(await jobsFor(rejected)).toHaveLength(1);
  });

  /**
   * D-A4-1b-3 PR B (00148), część na połączeniu Postgres (rola `postgres`
   * puli pg-boss): kolejkowanie szkicu wycofanego w transakcji ze zleceniem,
   * wyścig decyzji z przejęciem wysyłki (EvalPlanQual), literał `v:1.0`,
   * którego supabase-js nie przeniesie, i faktura abonamentu, której serwis
   * nie założy (00079/00080). Teksty i polityka TS ładowane dopiero po
   * asercji zachowania — przed naprawą przypadek pada na zachowaniu bazy.
   */
  describe('D-A4-1b-3 PR B (00148): szkic wycofany, wyścig decyzji z przejęciem', () => {
    type DecisionModule = typeof import('@/lib/ksef/duplicate-decision');
    const decisionPolicy = (): Promise<DecisionModule> => import('@/lib/ksef/duplicate-decision');

    it('R8: kolejkowanie szkicu wycofanego — P0001 z tekstem wyzwalacza, zlecenie nie powstaje, szkic zostaje', async () => {
      const id = await invoice({});
      const number = await internalNumber(id);
      const k = originalNumber(counter);
      await retire(id, k);

      let refusal: unknown = null;
      try {
        await sendJobEvent(
          submitEvent(id, 'proba-r8'),
          { inTransaction: ksefSendTransactionStep({ kind: 'enqueue' }, { invoiceId: id, tenantId: ORG, attemptId: 'proba-r8' }) },
        );
      } catch (e) {
        refusal = e;
      }

      // Dziś enqueue_ksef_send przyjmuje każdy szkic (00131:164-171): faktura idzie do queued ze zleceniem.
      expect(refusal).toMatchObject({ code: 'P0001' });
      expect(await jobsFor(id)).toHaveLength(0);
      expect((await row(id)).ksef_status).toBe('draft');
      expect(await auditCount(id, 'invoice.send_enqueued')).toBe(0);

      const { DUPLICATE_DECISION_SQL_TEXTS, fillSqlText, retiredDraftSendRefusal } = await decisionPolicy();
      const message = (refusal as { message?: string }).message;
      expect(message).toBe(fillSqlText(DUPLICATE_DECISION_SQL_TEXTS.TRIGGER_AUTO.template, number, `fakturę ${k}`));
      expect(message).toContain('poza FaktWay'); // marka od 00151
      // Wiersze z bazy w typie parametru polityki (spec nie przypina typu wiersza).
      const rows = (await submissionsOf(id)) as unknown as Parameters<typeof retiredDraftSendRefusal>[1];
      expect(message).toBe(retiredDraftSendRefusal(number, rows));
      // Klient dostaje tekst wyzwalacza bez zmian (ksef-send-step: P0001 przechodzi dosłownie).
      const { describeKsefSendError } = await import('@/lib/invoices/ksef-send-step');
      expect(describeKsefSendError(refusal, { kind: 'enqueue' })).toBe(message);
    });

    it('R9: wyścig — przejęcie czekające na blokadę wiersza decyzji odbija się od wyzwalacza (EvalPlanQual), szkic bez znacznika przejęcia', async () => {
      const p = await pendingDuplicate();
      // Jedno zapytanie z dwiema instrukcjami = jedna niejawna transakcja (blokada
      // wiersza z decyzji trzyma się do końca pg_sleep). Bez jawnego BEGIN: przy
      // błędzie Postgres sam ją wycofuje i połączenie wraca do puli czyste.
      const decisionSql = `SELECT public.decide_ksef_duplicate('${p.id}'::uuid, '${ORG}'::uuid, '${ownerId}'::uuid, `
        + `'other_sale', 'client', '${p.k}', '${ORIGINAL_SHA}', 'test', NULL); SELECT pg_sleep(1.5);`;
      let settled = false;
      const decision = boss.getDb().executeSql(decisionSql)
        .then(() => null, (e: unknown) => e)
        .finally(() => { settled = true; });
      // Zamiast zgadywać opóźnienie (spec: 300 ms) czekamy, aż transakcja decyzji
      // dojdzie do pg_sleep — wtedy RPC jest wykonane i trzyma blokadę wiersza.
      // Tekst zapytania sondy nie zawiera id (parametr), więc liczy tylko decyzję.
      let sawSleep = false;
      for (let i = 0; i < 40 && !settled; i += 1) {
        const { rows } = await boss.getDb().executeSql(
          `SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event = 'PgSleep' AND query LIKE $1`,
          [`%${p.id}%`],
        );
        if ((rows as Array<{ n: number }>)[0]!.n > 0) {
          sawSleep = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      // Przejęcie czeka na blokadę wiersza; po zatwierdzeniu decyzji WHERE jest
      // sprawdzany ponownie na nowej wersji (draft, submitted_to_ksef_at NULL) i
      // przechodzi — zatrzymać go może tylko wyzwalacz ze świeżą migawką.
      // Rewizja PR B #6: bez tych dwóch asercji przejęcie po zatwierdzeniu decyzji
      // (sonda nie zobaczyła pg_sleep) też daje P0001 i R9 przechodzi bez wyścigu.
      const settledAtClaim = settled;
      const claim = await admin.rpc('claim_ksef_send', {
        p_invoice_id: p.id, p_tenant_id: ORG, p_owner: 'stara-proba-r9', p_lease_seconds: 900,
      });

      expect(await decision).toBeNull();
      expect(sawSleep, 'sonda nie zobaczyła decyzji w pg_sleep — wyścig nie został sprawdzony').toBe(true);
      expect(settledAtClaim, 'decyzja była już zatwierdzona przed przejęciem — wyścig nie został sprawdzony').toBe(false);
      expect(claim.error?.code).toBe('P0001');
      expect(claim.data).toBeNull();
      const { data: after, error } = await admin.from('invoices')
        .select('ksef_status, submitted_to_ksef_at, ksef_send_owner').eq('id', p.id).single();
      expect(error).toBeNull();
      expect(after).toEqual({ ksef_status: 'draft', submitted_to_ksef_at: null, ksef_send_owner: null });
      const rows = await submissionsOf(p.id);
      expect(rows.map((r) => r.status)).toEqual(['number_taken']);
      expect(rows[0]!.original_check).toMatchObject({ decision: { choice: 'other_sale', via: 'client' } });

      const { DUPLICATE_DECISION_SQL_TEXTS, fillSqlText } = await decisionPolicy();
      expect(claim.error?.message).toBe(fillSqlText(DUPLICATE_DECISION_SQL_TEXTS.TRIGGER_OTHER.template, p.number, p.k));
    });

    it('R6b: `"v":1.0` jako literał SQL — jsonb porównuje liczby po wartości, JSON.parse daje 1; obie strony true', async () => {
      const text = JSON.stringify(originalCheck('KOL/R6B', originalNumber(9999))).replace('"v":1,', '"v":1.0,');
      expect(text.startsWith('{"v":1.0,')).toBe(true);

      const { rows } = await boss.getDb().executeSql(
        'SELECT public.ksef_duplicate_check_allows($1::jsonb, NULL) AS ok',
        [text],
      );
      const sql = (rows as Array<{ ok: boolean | null }>)[0]?.ok;
      expect(sql).toBe(true);

      const { duplicateCheckAllows } = await decisionPolicy();
      expect(duplicateCheckAllows(JSON.parse(text), null)).toBe(sql);
    });

    it('R3 (billing, tylko jako właściciel bazy): faktura abonamentu FaktWay z 440 — odmowa billing z numerem dokumentu, stan bez zmian', async () => {
      const b = await billingInvoice({ ksef_status: 'failed', last_error_code: 'KSEF_DUPLICATE_RECONCILE' });
      const k = originalNumber(counter);
      const { error: markerError } = await admin.from('ksef_submissions').insert({
        tenant_id: ORG, invoice_id: b.id, submission_type: 'online', status: 'sent', error_code: '440',
        session_reference_number: `SES-ABO-${counter}`, request_payload_hash: 'aa'.repeat(32),
        original_ksef_number: k, original_session_reference_number: `SES-ORIG-ABO-${counter}`,
        original_check: originalCheck(b.number, k), attempted_at: '2026-09-01T10:00:00Z',
      });
      if (markerError) throw new Error(`insert ksef_submissions: ${markerError.message}`);

      const { error } = await admin.rpc('decide_ksef_duplicate', {
        p_invoice_id: b.id, p_tenant_id: ORG, p_actor_user_id: ownerId, p_choice: 'other_sale', p_via: 'client',
        p_original_ksef_number: k, p_original_sha256: ORIGINAL_SHA, p_env: 'test', p_note: null,
      });

      expect(error?.code).toBe('P0001');
      expect(await row(b.id)).toMatchObject({ ksef_status: 'failed', last_error_code: 'KSEF_DUPLICATE_RECONCILE' });
      const rows = await submissionsOf(b.id);
      expect(rows.map((r) => r.status)).toEqual(['sent']);
      expect(rows[0]!.original_check).not.toHaveProperty('decision');

      const { DUPLICATE_DECISION_SQL_TEXTS, fillSqlText } = await decisionPolicy();
      expect(error?.message).toBe(fillSqlText(DUPLICATE_DECISION_SQL_TEXTS.billing.template, b.number));
      expect(error?.message).not.toMatch(/faktflow/i); // marka od 00151
    });
  });
});

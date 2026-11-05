import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getRlsTestEnvironment } from './helpers/rls-environment';

/**
 * Test izolacji RLS w modelu multi-org (memberships).
 *
 * Sprawdzamy:
 *   - User z aktywną org A nie widzi danych org B (nawet po podaniu cudzej
 *     wartości w nagłówku `x-active-org` — `get_current_tenant_id()` ją
 *     zwaliduje przez `is_member_of()`).
 *   - Revoked membership traci dostęp do danych org natychmiast.
 *   - Duplikat NIP-u w 2 orgs — userzy widzą tylko swoje.
 *   - Sfałszowany nagłówek `x-active-org` z UUID innej org NIE daje dostępu.
 *
 * Setup / teardown — service_role (bypass RLS).
 * Asercje — anon JWT po `signInWithPassword` + nagłówek `x-active-org`,
 * tak jak robi to runtime aplikacji.
 */

/**
 * TEN TEST WYMAGA OSOBNEJ BAZY TESTOWEJ — zakłada konta, loguje się i pisze
 * przez `service_role`. Dlatego bierze zmienne `RLS_TEST_*`, a NIE tych,
 * których używa aplikacja: pomyłka w konfiguracji nie może skończyć się
 * przebiegiem destrukcyjnego testu na bazie, na której pracują ludzie.
 *
 * Bez tych zmiennych zestaw jest POMIJANY — widocznie, jako „skipped", a nie
 * cicho wycięty. Wcześniej cały plik wywalał się już przy imporcie
 * („supabaseUrl is required") i barwił CI na czerwono niezależnie od tego,
 * co ktoś zmienił w kodzie; czerwone CI, które jest czerwone zawsze,
 * przestaje cokolwiek znaczyć. Gdy zmienne są, zestaw uruchomi się sam.
 * Osobno woła go `pnpm test:rls`.
 */
const hasDatabase = Boolean(
  process.env.RLS_TEST_SUPABASE_URL?.trim() &&
    process.env.RLS_TEST_SUPABASE_ANON_KEY?.trim() &&
    process.env.RLS_TEST_SUPABASE_SERVICE_ROLE_KEY?.trim(),
);

// `getRlsTestEnvironment()` waliduje adres i RZUCA przy brakach, więc wołamy
// je dopiero wtedy, gdy wiadomo, że jest co walidować.
const environment = hasDatabase ? getRlsTestEnvironment() : null;

const url = environment?.url ?? '';
const anonKey = environment?.anonKey ?? '';

const admin: SupabaseClient = environment
  ? createClient(environment.url, environment.serviceRoleKey)
  : (null as unknown as SupabaseClient);

const TENANT_A_ID = '11111111-1111-1111-1111-111111111111';
const TENANT_B_ID = '22222222-2222-2222-2222-222222222222';
// Trzecia org z tym samym NIP-em co A — sprawdzamy izolację po duplikacie.
const TENANT_DUP_ID = '33333333-3333-3333-3333-333333333333';

const NIP_A = '9460000012';
const NIP_B = '9470000019';

const INVOICE_A_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-111111111111';
const INVOICE_B_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-222222222222';
const INVOICE_DUP_ID = 'cccccccc-cccc-cccc-cccc-333333333333';

const EMAIL_A = 'rls-isolation-a@ksef-saas.test';
const EMAIL_B = 'rls-isolation-b@ksef-saas.test';
const EMAIL_DUP = 'rls-isolation-dup@ksef-saas.test';
const PASS = 'RlsTestPass2026Aa!';

let userAId = '';
let userBId = '';
let userDupId = '';
let clientA: SupabaseClient;
let clientB: SupabaseClient;

function createFreshAnonClient(activeOrgId: string | null = null) {
  return createClient(url, anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: activeOrgId
      ? { headers: { 'x-active-org': activeOrgId } }
      : undefined,
  });
}

async function findOrCreateAuthUser(email: string, password: string): Promise<string> {
  const { data: page, error: listErr } = await admin.auth.admin.listUsers({
    page: 1,
    perPage: 200,
  });
  if (listErr) throw listErr;
  const hit = page.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
  if (hit) return hit.id;

  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) throw error;
  if (!data.user) throw new Error(`createUser returned no user for ${email}`);
  return data.user.id;
}

async function signInClient(
  email: string,
  password: string,
  activeOrgId: string,
): Promise<SupabaseClient> {
  const c = createFreshAnonClient(activeOrgId);
  const { error } = await c.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return c;
}

describe.skipIf(!hasDatabase)('RLS isolation in multi-org model', () => {
  beforeAll(async () => {
    if (!anonKey) {
      throw new Error('Brak RLS_TEST_SUPABASE_ANON_KEY — potrzebne do logowania w teście RLS.');
    }

    userAId = await findOrCreateAuthUser(EMAIL_A, PASS);
    userBId = await findOrCreateAuthUser(EMAIL_B, PASS);
    userDupId = await findOrCreateAuthUser(EMAIL_DUP, PASS);

    // Czyszczenie — kolejność ważna (FK).
    await admin
      .from('invoices')
      .delete()
      .in('id', [INVOICE_A_ID, INVOICE_B_ID, INVOICE_DUP_ID]);
    await admin
      .from('memberships')
      .delete()
      .in('organization_id', [TENANT_A_ID, TENANT_B_ID, TENANT_DUP_ID]);
    await admin
      .from('tenants')
      .delete()
      .in('id', [TENANT_A_ID, TENANT_B_ID, TENANT_DUP_ID]);

    // 3 organizacje: A i B z różnymi NIP-ami; DUP z tym samym NIP-em co A
    // (multi-org dopuszcza ten sam NIP — kolizja jest informacją w UI, nie
    // ograniczeniem schematu).
    const { error: tErr } = await admin.from('tenants').upsert(
      [
        { id: TENANT_A_ID, nip: NIP_A, name: 'Firma Alfa RLS' },
        { id: TENANT_B_ID, nip: NIP_B, name: 'Firma Beta RLS' },
        { id: TENANT_DUP_ID, nip: NIP_A, name: 'Firma Alfa-Duplikat RLS' },
      ],
      { onConflict: 'id' },
    );
    if (tErr) throw tErr;

    // Backfill profili (handle_new_user trigger może być włączony lub nie).
    await admin
      .from('users')
      .upsert(
        [
          { id: userAId, name: 'Tester A' },
          { id: userBId, name: 'Tester B' },
          { id: userDupId, name: 'Tester DUP' },
        ],
        { onConflict: 'id' },
      );

    const { error: mErr } = await admin.from('memberships').insert([
      {
        organization_id: TENANT_A_ID,
        user_id: userAId,
        role: 'owner',
        status: 'active',
      },
      {
        organization_id: TENANT_B_ID,
        user_id: userBId,
        role: 'owner',
        status: 'active',
      },
      {
        organization_id: TENANT_DUP_ID,
        user_id: userDupId,
        role: 'owner',
        status: 'active',
      },
    ]);
    if (mErr) throw mErr;

    const minimalFa3 = { internalNumber: 'TEST', type: 'VAT' };

    const { error: invErr } = await admin.from('invoices').upsert(
      [
        {
          id: INVOICE_A_ID,
          tenant_id: TENANT_A_ID,
          direction: 'outgoing',
          internal_number: 'A/001',
          invoice_type: 'VAT',
          issue_date: '2026-04-01',
          seller_nip: NIP_A,
          buyer_nip: NIP_B,
          gross_total: 1000,
          net_total: 812.77,
          vat_total: 187.23,
          ksef_status: 'draft',
          fa3_data: minimalFa3,
          seller_data: { nip: NIP_A },
          buyer_data: { nip: NIP_B },
        },
        {
          id: INVOICE_B_ID,
          tenant_id: TENANT_B_ID,
          direction: 'outgoing',
          internal_number: 'B/001',
          invoice_type: 'VAT',
          issue_date: '2026-04-01',
          seller_nip: NIP_B,
          buyer_nip: NIP_A,
          gross_total: 2000,
          net_total: 1626.02,
          vat_total: 373.98,
          ksef_status: 'draft',
          fa3_data: minimalFa3,
          seller_data: { nip: NIP_B },
          buyer_data: { nip: NIP_A },
        },
        {
          id: INVOICE_DUP_ID,
          tenant_id: TENANT_DUP_ID,
          direction: 'outgoing',
          internal_number: 'DUP/001',
          invoice_type: 'VAT',
          issue_date: '2026-04-01',
          seller_nip: NIP_A,
          buyer_nip: NIP_B,
          gross_total: 500,
          net_total: 406.50,
          vat_total: 93.50,
          ksef_status: 'draft',
          fa3_data: minimalFa3,
          seller_data: { nip: NIP_A },
          buyer_data: { nip: NIP_B },
        },
      ],
      { onConflict: 'id' },
    );
    if (invErr) throw invErr;

    clientA = await signInClient(EMAIL_A, PASS, TENANT_A_ID);
    clientB = await signInClient(EMAIL_B, PASS, TENANT_B_ID);
    await signInClient(EMAIL_DUP, PASS, TENANT_DUP_ID);
  });

  afterAll(async () => {
    await admin
      .from('invoices')
      .delete()
      .in('id', [INVOICE_A_ID, INVOICE_B_ID, INVOICE_DUP_ID]);
    await admin
      .from('memberships')
      .delete()
      .in('organization_id', [TENANT_A_ID, TENANT_B_ID, TENANT_DUP_ID]);
    await admin
      .from('tenants')
      .delete()
      .in('id', [TENANT_A_ID, TENANT_B_ID, TENANT_DUP_ID]);

    const userIds = [userAId, userBId, userDupId].filter(Boolean);
    for (const id of userIds) {
      await admin.auth.admin.deleteUser(id).catch(() => null);
    }
  });

  it('User A widzi TYLKO faktury swojej org A', async () => {
    const { data, error } = await clientA
      .from('invoices')
      .select('internal_number')
      .eq('direction', 'outgoing');
    if (error) throw error;
    const numbers = (data ?? []).map((r) => r.internal_number).sort();
    expect(numbers).toEqual(['A/001']);
  });

  it('User B widzi TYLKO fakturę org B', async () => {
    const { data, error } = await clientB
      .from('invoices')
      .select('internal_number');
    if (error) throw error;
    expect(data ?? []).toHaveLength(1);
    expect(data![0].internal_number).toBe('B/001');
  });

  it('Sfałszowany x-active-org wskazujący cudzą org NIE daje dostępu', async () => {
    // Klient zalogowany jako A, ale podaje header z org B w którym nie jest
    // członkiem. `get_current_tenant_id()` zwróci NULL → 0 wyników.
    const sneaky = await signInClient(EMAIL_A, PASS, TENANT_B_ID);
    const { data, error } = await sneaky.from('invoices').select('id');
    if (error) throw error;
    expect(data ?? []).toHaveLength(0);
  });

  it('User A NIE widzi org-duplikatu mimo identycznego NIP-u', async () => {
    // DUP ma ten sam NIP co A, ale to inna org (TENANT_DUP_ID). User A nie
    // jest jej członkiem → nie widzi jej faktur.
    const { data, error } = await clientA
      .from('tenants')
      .select('id, name')
      .eq('nip', NIP_A);
    if (error) throw error;
    const ids = (data ?? []).map((r) => r.id);
    expect(ids).toContain(TENANT_A_ID);
    expect(ids).not.toContain(TENANT_DUP_ID);
  });

  it('User A NIE może UPDATE faktury org B', async () => {
    const { data, error } = await clientA
      .from('invoices')
      .update({ notes: 'hacked' })
      .eq('id', INVOICE_B_ID)
      .select('id');
    if (error) throw error;
    expect(data ?? []).toHaveLength(0);
  });

  it('Revoked membership traci dostęp natychmiast', async () => {
    // Suspend membershipu A — powinien stracić dostęp do faktur org A.
    const { error: revErr } = await admin
      .from('memberships')
      .update({ status: 'revoked', revoked_at: new Date().toISOString() })
      .eq('organization_id', TENANT_A_ID)
      .eq('user_id', userAId);
    if (revErr) throw revErr;

    try {
      // Użyjemy świeżego klienta — wcześniejsze cache JWT może być nieaktualne.
      const stale = await signInClient(EMAIL_A, PASS, TENANT_A_ID);
      const { data, error } = await stale.from('invoices').select('id');
      if (error) throw error;
      expect(data ?? []).toHaveLength(0);
    } finally {
      // Przywróć membership, by inne testy się nie sypały.
      await admin
        .from('memberships')
        .update({ status: 'active', revoked_at: null })
        .eq('organization_id', TENANT_A_ID)
        .eq('user_id', userAId);
    }
  });

  it('Akceptacja zaproszenia obcym kontem mailowym jest blokowana', async () => {
    // Owner B wysyła zaproszenie na adres EMAIL_DUP.
    // User A próbuje je zaakceptować (zalogowany jako A) — RPC powinno
    // odrzucić z `invitation_email_mismatch`.
    const { createHash, randomBytes } = await import('crypto');
    const token = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(token).digest('hex');

    const { error: insErr } = await admin
      .from('organization_invitations')
      .insert({
        organization_id: TENANT_B_ID,
        email: EMAIL_DUP.toLowerCase(),
        role: 'member',
        token_hash: tokenHash,
        invited_by: userBId,
      });
    if (insErr) throw insErr;

    try {
      const { error } = await clientA.rpc('accept_organization_invitation', {
        p_token_hash: tokenHash,
      });
      expect(error).toBeTruthy();
      expect(String(error?.message)).toContain('invitation_email_mismatch');
    } finally {
      await admin
        .from('organization_invitations')
        .delete()
        .eq('token_hash', tokenHash);
    }
  });
  it('chroni dowody wpłaty i pauzę przypomnień przez PostgREST w dwóch firmach', async () => {
    const { randomUUID } = await import('node:crypto');
    const ids = { payA: randomUUID(), payB: randomUUID(), clientPay: randomUUID(),
      reminder: randomUUID(), clientReminder: randomUUID(), crossReminder: randomUUID(),
      crossPay: randomUUID(), import: randomUUID(), clientImport: randomUUID(),
      crossImport: randomUUID() };
    try {
      const ownPayment = { tenant_id: TENANT_A_ID, invoice_id: INVOICE_A_ID,
        amount: 1000, payment_date: '2026-09-24' };
      expect((await clientA.from('payments').insert({ ...ownPayment, id: ids.clientPay }))
        .error?.code).toBe('42501');
      expect((await clientA.from('payment_imports').insert({
        id: ids.clientImport, tenant_id: TENANT_A_ID, account_iban: 'PLTEST',
        transaction_id: randomUUID(), transaction_date: '2026-09-24', amount: 1,
      })).error?.code).toBe('42501');
      expect((await clientA.from('payment_reminders').insert({
        id: ids.clientReminder, tenant_id: TENANT_A_ID, invoice_id: INVOICE_A_ID,
        stage: 'stage_2', scheduled_for: new Date().toISOString(),
      })).error?.code).toBe('42501');

      expect((await admin.from('payments').insert({ ...ownPayment,
        id: ids.crossPay, invoice_id: INVOICE_B_ID,
      })).error?.code).toBe('23503');
      expect((await admin.from('payment_reminders').insert({
        id: ids.crossReminder, tenant_id: TENANT_A_ID, invoice_id: INVOICE_B_ID,
        stage: 'stage_2', scheduled_for: new Date().toISOString(),
      })).error?.code).toBe('23503');

      const payB = await admin.from('payments').insert({
        id: ids.payB, tenant_id: TENANT_B_ID, invoice_id: INVOICE_B_ID,
        amount: 1, payment_date: '2026-09-24', is_confirmed: true,
      });
      if (payB.error) throw payB.error;
      expect((await admin.from('payment_imports').insert({
        id: ids.crossImport, tenant_id: TENANT_A_ID, account_iban: 'PLTEST',
        transaction_id: randomUUID(), transaction_date: '2026-09-24',
        amount: 1, matched_payment_id: ids.payB,
      })).error?.code).toBe('23503');

      const payA = await admin.from('payments').insert({ ...ownPayment,
        id: ids.payA, is_auto_matched: true, is_confirmed: false,
      });
      if (payA.error) throw payA.error;
      const before = await admin.from('invoices').select('paid_amount')
        .eq('id', INVOICE_A_ID).single();
      if (before.error) throw before.error;
      expect(Number(before.data.paid_amount)).toBe(0);

      const confirmed = await admin.from('payments')
        .update({ is_auto_matched: false }).eq('id', ids.payA);
      if (confirmed.error) throw confirmed.error;
      const paid = await admin.from('invoices').select('paid_amount, payment_status, paid_at')
        .eq('id', INVOICE_A_ID).single();
      if (paid.error) throw paid.error;
      expect(Number(paid.data.paid_amount)).toBe(1000);
      expect(paid.data.payment_status).toBe('paid');
      expect(paid.data.paid_at).not.toBeNull();

      expect((await clientA.from('payments').update({ amount: 1 })
        .eq('id', ids.payA)).error?.code).toBe('42501');
      expect((await clientA.from('payments').delete()
        .eq('id', ids.payA)).error?.code).toBe('42501');
      expect((await clientA.from('payments').select('id')).error?.code).toBe('42501');
      expect((await clientA.from('invoices').update({ paid_amount: 0 })
        .eq('id', INVOICE_A_ID)).error?.code).toBe('42501');
      expect((await clientA.from('invoices').update({ payment_status: 'overdue' })
        .eq('id', INVOICE_A_ID)).error?.code).toBe('42501');
      expect((await clientA.from('invoices').update({ paid_at: null })
        .eq('id', INVOICE_A_ID)).error?.code).toBe('42501');

      const bankImport = await admin.from('payment_imports').insert({
        id: ids.import, tenant_id: TENANT_A_ID, account_iban: 'PLTEST',
        transaction_id: randomUUID(), transaction_date: '2026-09-24', amount: 1,
      });
      if (bankImport.error) throw bankImport.error;
      expect((await clientA.from('payment_imports').update({ ignored: true })
        .eq('id', ids.import)).error?.code).toBe('42501');
      expect((await clientA.from('payment_imports').delete()
        .eq('id', ids.import)).error?.code).toBe('42501');
      expect((await clientA.from('payment_imports').select('id')).error?.code).toBe('42501');

      const reminder = await admin.from('payment_reminders').insert({
        id: ids.reminder, tenant_id: TENANT_A_ID, invoice_id: INVOICE_A_ID,
        stage: 'stage_1', scheduled_for: new Date().toISOString(),
      });
      if (reminder.error) throw reminder.error;
      expect((await clientA.from('payment_reminders').update({ status: 'sent' })
        .eq('id', ids.reminder)).error?.code).toBe('42501');
      expect((await clientA.from('payment_reminders').delete()
        .eq('id', ids.reminder)).error?.code).toBe('42501');
      const ownRead = await clientA.from('payment_reminders').select('id')
        .eq('id', ids.reminder);
      if (ownRead.error) throw ownRead.error;
      expect(ownRead.data).toEqual([{ id: ids.reminder }]);
      const foreignRead = await clientB.from('payment_reminders').select('id')
        .eq('id', ids.reminder);
      if (foreignRead.error) throw foreignRead.error;
      expect(foreignRead.data).toEqual([]);

      const foreignPause = await clientB.rpc('set_invoice_reminders_paused', {
        p_invoice_id: INVOICE_A_ID, p_paused: true, p_reason: null,
      });
      expect(foreignPause.error).toBeNull();
      expect(foreignPause.data).toBe(false);
      const pause = await clientA.rpc('set_invoice_reminders_paused', {
        p_invoice_id: INVOICE_A_ID, p_paused: true, p_reason: 'test',
      });
      if (pause.error) throw pause.error;
      expect(pause.data).toBe(true);
      const paused = await admin.from('payment_reminders').select('status')
        .eq('id', ids.reminder).single();
      if (paused.error) throw paused.error;
      expect(paused.data.status).toBe('cancelled');
      const resume = await clientA.rpc('set_invoice_reminders_paused', {
        p_invoice_id: INVOICE_A_ID, p_paused: false, p_reason: null,
      });
      if (resume.error) throw resume.error;
      expect(resume.data).toBe(true);

      // Przyjęta faktura wymaga środowiska KSeF (00117, #63).
      const accepted = await admin.from('invoices').update({ ksef_status: 'accepted', ksef_environment: 'test' })
        .eq('id', INVOICE_A_ID);
      if (accepted.error) throw accepted.error;
      expect((await clientA.from('invoices').update({ buyer_nip: NIP_A })
        .eq('id', INVOICE_A_ID)).error?.code).toBe('42501');
      expect((await clientA.from('invoices').update({
        payment_data: { bankAccount: 'PL-ATTACKER-TEST' },
      }).eq('id', INVOICE_A_ID)).error?.code).toBe('42501');

      const reversed = await admin.from('payments').update({ is_auto_matched: true })
        .eq('id', ids.payA);
      if (reversed.error) throw reversed.error;
      const unpaid = await admin.from('invoices')
        .select('paid_amount, payment_status, paid_at').eq('id', INVOICE_A_ID).single();
      if (unpaid.error) throw unpaid.error;
      expect(Number(unpaid.data.paid_amount)).toBe(0);
      expect(unpaid.data.payment_status).not.toBe('paid');
      expect(unpaid.data.paid_at).toBeNull();
    } finally {
      await admin.from('payment_imports').delete().in('id',
        [ids.import, ids.clientImport, ids.crossImport]);
      await admin.from('payment_reminders').delete().in('id',
        [ids.reminder, ids.clientReminder, ids.crossReminder]);
      await admin.from('payments').delete().in('id',
        [ids.payA, ids.payB, ids.clientPay, ids.crossPay]);
      await admin.from('invoices').update({ ksef_status: 'draft',
        reminders_paused: false, reminders_paused_reason: null }).eq('id', INVOICE_A_ID);
    }
  });

});

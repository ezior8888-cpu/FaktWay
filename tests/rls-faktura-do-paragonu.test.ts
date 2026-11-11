import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { getRlsTestEnvironment } from './helpers/rls-environment';

/**
 * 00175 na prawdziwej bazie: faktura do paragonu (FP) ze skrzynki KSeF
 * i paragon z NIP spoza KSeF w `expense_receipt_matches` (krok 1.3 planu
 * kompletnej aplikacji, część 2).
 *
 * - runner (service_role): jeden pewny kandydat łączy się, paragon wypada
 *   z KPiR (`is_deductible = false`); kilku kandydatów to ostrzeżenie;
 *   drugie wykonanie nic nie zmienia; obca firma i koszt z KSeF odpadają;
 * - klient: czyta tylko swoją firmę, nie pisze do tabeli i nie woła RPC,
 *   nie wliczy połączonego paragonu z powrotem do KPiR (wyzwalacz);
 * - decyzja klienta (service_role z członkostwem): wybór kandydata,
 *   rozłączenie z przywróceniem paragonu, obcy członek odmawia.
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

const ORG_A = '00175175-0000-4000-8000-00000000000a';
const ORG_B = '00175175-0000-4000-8000-00000000000b';
const EMAILS = {
  owner: 'rls-fp-owner@ksef-saas.test',
  obcy: 'rls-fp-obcy@ksef-saas.test',
} as const;
const PASS = 'RlsFakturaDoParagonu2026Aa!';
const NIP_FIRMY = '1234567890';
const NIP_SKLEPU = '5260001246';
const users: Record<keyof typeof EMAILS, string> = { owner: '', obcy: '' };

let counter = 0;
const nextId = (kind: string) => {
  counter += 1;
  return `00175175-${kind}-4000-8000-${String(counter).padStart(12, '0')}`;
};

function anonClient(activeOrg: string) {
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

async function signedIn(who: keyof typeof EMAILS, org: string): Promise<SupabaseClient> {
  const client = anonClient(org);
  const { error } = await client.auth.signInWithPassword({ email: EMAILS[who], password: PASS });
  if (error) throw error;
  return client;
}

/** Koszt z faktury do paragonu, tak jak zapisuje go runner skrzynki. */
async function kosztFp(org: string = ORG_A, who: keyof typeof EMAILS = 'owner'): Promise<string> {
  const invoiceId = nextId('1111');
  const number = `FP/175/${counter}`;
  const invoice = await admin.from('invoices').insert({
    id: invoiceId, tenant_id: org, direction: 'incoming', origin: 'ksef_inbox', internal_number: number,
    invoice_type: 'VAT', invoice_kind: 'regular', issue_date: '2027-02-05', seller_nip: NIP_SKLEPU, buyer_nip: NIP_FIRMY,
    gross_total: 123, net_total: 100, vat_total: 23, currency: 'PLN', ksef_status: 'accepted', ksef_environment: 'test',
    ksef_number: `${NIP_SKLEPU}-20270205-${String(counter).padStart(12, '0')}-00`, xml_storage_path: 'x.xml',
    fa3_data: { _source: 'inbox-metadata', _pendingFullFetch: false },
  });
  if (invoice.error) throw new Error(`faktura ${number}: ${invoice.error.message}`);
  const id = nextId('2222');
  const expense = await admin.from('expenses').insert({
    id, tenant_id: org, created_by: users[who], source: 'ksef_inbox', ksef_invoice_id: invoiceId,
    seller_name: 'Sklep Przykład', seller_nip: NIP_SKLEPU, document_number: number, document_type: 'invoice',
    issue_date: '2027-02-05', net_amount: 100, vat_amount: 23, gross_amount: 123, vat_deductible_amount: 23,
    is_reviewed: true,
  });
  if (expense.error) throw new Error(`koszt ${number}: ${expense.error.message}`);
  return id;
}

/** Paragon z NIP ze zdjęcia (OCR zapisuje go jako `invoice`, rodzaj w odczycie). */
async function paragon(org: string = ORG_A, who: keyof typeof EMAILS = 'owner', fields: Record<string, unknown> = {}): Promise<string> {
  const id = nextId('3333');
  const { error } = await admin.from('expenses').insert({
    id, tenant_id: org, created_by: users[who], source: 'ocr_photo', seller_name: 'Sklep Przykład',
    seller_nip: NIP_SKLEPU, document_number: `PAR ${counter}`, document_type: 'invoice', issue_date: '2027-01-20',
    net_amount: 100, vat_amount: 23, gross_amount: 123, ocr_extracted_data: { document_type: 'simplified_invoice' },
    ...fields,
  });
  if (error) throw new Error(`paragon: ${error.message}`);
  return id;
}

const match = (invoiceExpenseId: string, receiptIds: string[], autoLink: boolean) =>
  admin.rpc('match_receipt_to_ksef_invoice', {
    p_tenant_id: ORG_A, p_invoice_expense_id: invoiceExpenseId, p_receipt_expense_ids: receiptIds, p_auto_link: autoLink,
  });

const decide = (invoiceExpenseId: string, receiptId: string | null, actor: string = users.owner, org: string = ORG_A) =>
  admin.rpc('decide_receipt_invoice_match', {
    p_tenant_id: org, p_invoice_expense_id: invoiceExpenseId, p_actor_user_id: actor, p_receipt_expense_id: receiptId,
  });

async function stan(invoiceExpenseId: string) {
  const { data, error } = await admin.from('expense_receipt_matches')
    .select('receipt_expense_id, status, receipt_was_deductible')
    .eq('invoice_expense_id', invoiceExpenseId)
    .order('receipt_expense_id', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

async function koszt(id: string) {
  const { data, error } = await admin.from('expenses').select('is_deductible, is_reviewed').eq('id', id).single();
  if (error) throw error;
  return data;
}

async function cleanup() {
  for (const org of [ORG_A, ORG_B]) {
    await admin.from('expense_receipt_matches').delete().eq('tenant_id', org);
    await admin.from('expenses').delete().eq('tenant_id', org);
    await admin.from('invoices').delete().eq('tenant_id', org);
  }
}

describe.skipIf(!hasDatabase)('00175: faktura do paragonu i paragon z NIP na prawdziwym PostgREST', () => {
  beforeAll(async () => {
    users.owner = await userId(EMAILS.owner);
    users.obcy = await userId(EMAILS.obcy);
    await cleanup();
    await admin.from('memberships').delete().in('organization_id', [ORG_A, ORG_B]);
    // Wpisy audytu zostają po przebiegu (00052) i blokują kaskadę z firmą: kolejny przebieg dopisuje się do firmy.
    const tenants = await admin.from('tenants').upsert([
      { id: ORG_A, nip: NIP_FIRMY, name: 'Firma A 00175' },
      { id: ORG_B, nip: '9480000120', name: 'Firma B 00175' },
    ], { onConflict: 'id' });
    if (tenants.error) throw tenants.error;
    const profiles = await admin.from('users').upsert(
      [{ id: users.owner, name: 'Owner' }, { id: users.obcy, name: 'Obcy' }],
      { onConflict: 'id' },
    );
    if (profiles.error) throw profiles.error;
    const memberships = await admin.from('memberships').insert([
      { organization_id: ORG_A, user_id: users.owner, role: 'owner', status: 'active' },
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
    await admin.from('tenants').delete().in('id', [ORG_A, ORG_B]);
  });

  describe('runner skrzynki (service_role)', () => {
    it('jeden pewny kandydat: połączenie, paragon poza KPiR, drugie wykonanie nic nie zmienia', async () => {
      const fp = await kosztFp();
      const par = await paragon();

      const first = await match(fp, [par], true);
      expect(first.error).toBeNull();
      expect(first.data).toBe('linked');
      expect(await stan(fp)).toEqual([{ receipt_expense_id: par, status: 'linked', receipt_was_deductible: true }]);
      expect(await koszt(par)).toMatchObject({ is_deductible: false });
      expect(await koszt(fp)).toMatchObject({ is_deductible: true, is_reviewed: true });

      const again = await match(fp, [par], true);
      expect(again.data).toBe('already_recorded');
      expect(await stan(fp)).toEqual([{ receipt_expense_id: par, status: 'linked', receipt_was_deductible: true }]);
    });

    it('dwóch kandydatów: bez połączenia, ostrzeżenie i faktura „Nowa”', async () => {
      const fp = await kosztFp();
      const [a, b] = [await paragon(), await paragon()].sort();

      const { data, error } = await match(fp, [a!, b!], false);
      expect(error).toBeNull();
      expect(data).toBe('candidates');
      expect(await stan(fp)).toEqual([
        { receipt_expense_id: a, status: 'candidate', receipt_was_deductible: null },
        { receipt_expense_id: b, status: 'candidate', receipt_was_deductible: null },
      ]);
      expect(await koszt(a!)).toMatchObject({ is_deductible: true });
      expect(await koszt(fp)).toMatchObject({ is_reviewed: false });
    });

    it('paragon obcej firmy i koszt z KSeF nie są kandydatami; paragon połączony z inną fakturą też nie', async () => {
      const fp = await kosztFp();
      const obcy = await paragon(ORG_B, 'obcy');
      const innaFp = await kosztFp();
      expect((await match(fp, [obcy, innaFp], true)).data).toBe('no_candidates');

      const par = await paragon();
      expect((await match(innaFp, [par], true)).data).toBe('linked');
      expect((await match(fp, [par], true)).data).toBe('no_candidates');
      expect(await stan(fp)).toEqual([]);
    });

    it('kandydat czekający na decyzję przy innej fakturze nie łączy się sam', async () => {
      const fp1 = await kosztFp();
      const fp2 = await kosztFp();
      const par = await paragon();
      expect((await match(fp1, [par], false)).data).toBe('candidates');
      expect((await match(fp2, [par], true)).data).toBe('candidates');
      expect(await koszt(par)).toMatchObject({ is_deductible: true });
    });

    it('wywołanie z kosztem spoza skrzynki jako fakturą: nic się nie dzieje', async () => {
      const par = await paragon();
      const drugi = await paragon();
      expect((await match(par, [drugi], true)).data).toBe('not_applicable');
      expect(await koszt(drugi)).toMatchObject({ is_deductible: true });
    });
  });

  describe('klient (authenticated)', () => {
    it('czyta tylko swoją firmę i nie zapisuje do tabeli', async () => {
      const fp = await kosztFp();
      const par = await paragon();
      await match(fp, [par], true);

      const owner = await signedIn('owner', ORG_A);
      const own = await owner.from('expense_receipt_matches').select('invoice_expense_id, status');
      expect(own.error).toBeNull();
      expect(own.data).toEqual([{ invoice_expense_id: fp, status: 'linked' }]);

      const obcy = await signedIn('obcy', ORG_B);
      expect((await obcy.from('expense_receipt_matches').select('id')).data).toEqual([]);

      const insert = await owner.from('expense_receipt_matches')
        .insert({ tenant_id: ORG_A, invoice_expense_id: fp, receipt_expense_id: par, status: 'dismissed' });
      expect(insert.error?.code).toBe('42501');
      const update = await owner.from('expense_receipt_matches').update({ status: 'dismissed' }).eq('invoice_expense_id', fp).select('id');
      expect(update.error?.code).toBe('42501');
      const del = await owner.from('expense_receipt_matches').delete().eq('invoice_expense_id', fp).select('id');
      expect(del.error?.code).toBe('42501');
      expect(await stan(fp)).toEqual([{ receipt_expense_id: par, status: 'linked', receipt_was_deductible: true }]);
    });

    it('nie woła RPC runnera ani decyzji', async () => {
      const fp = await kosztFp();
      const par = await paragon();
      const owner = await signedIn('owner', ORG_A);
      const viaClient = await owner.rpc('match_receipt_to_ksef_invoice', {
        p_tenant_id: ORG_A, p_invoice_expense_id: fp, p_receipt_expense_ids: [par], p_auto_link: true,
      });
      expect(viaClient.error?.code).toBe('42501');
      const decision = await owner.rpc('decide_receipt_invoice_match', {
        p_tenant_id: ORG_A, p_invoice_expense_id: fp, p_actor_user_id: users.owner, p_receipt_expense_id: par,
      });
      expect(decision.error?.code).toBe('42501');
      expect(await stan(fp)).toEqual([]);
    });

    it('połączony paragon nie wraca do KPiR edycją klienta; inne pola wolno zmienić', async () => {
      const fp = await kosztFp();
      const par = await paragon();
      await match(fp, [par], true);
      const owner = await signedIn('owner', ORG_A);

      const back = await owner.from('expenses').update({ is_deductible: true }).eq('id', par).select('id');
      expect(back.error?.code).toBe('42501');
      expect(back.error?.message).toMatch(/rozłącz dokumenty na stronie faktury/);
      expect(await koszt(par)).toMatchObject({ is_deductible: false });

      const notes = await owner.from('expenses').update({ notes: 'zakup biurowy' }).eq('id', par).select('notes');
      expect(notes.error).toBeNull();
      expect(notes.data).toEqual([{ notes: 'zakup biurowy' }]);
    });
  });

  describe('decyzja klienta (akcja serwerowa)', () => {
    it('wybór kandydata łączy go, reszta odpada; „osobne koszty” rozłącza i przywraca paragon', async () => {
      const fp = await kosztFp();
      const [a, b] = [await paragon(), await paragon()].sort();
      await match(fp, [a!, b!], false);

      const linked = await decide(fp, a!);
      expect(linked.error).toBeNull();
      expect(linked.data).toBe('linked');
      expect(await stan(fp)).toEqual([
        { receipt_expense_id: a, status: 'linked', receipt_was_deductible: true },
        { receipt_expense_id: b, status: 'dismissed', receipt_was_deductible: null },
      ]);
      expect(await koszt(a!)).toMatchObject({ is_deductible: false });
      expect((await decide(fp, b!)).data).toBe('stale');

      const separated = await decide(fp, null);
      expect(separated.data).toBe('separated');
      expect(await koszt(a!)).toMatchObject({ is_deductible: true });
      expect((await stan(fp)).map((m) => m.status)).toEqual(['dismissed', 'dismissed']);
      expect((await decide(fp, null)).data).toBe('stale');
      // Ponowienie runnera nie odtwarza ani ostrzeżenia, ani połączenia.
      expect((await match(fp, [a!], true)).data).toBe('already_recorded');
    });

    it('członek innej firmy odmawia; paragon zostaje połączony', async () => {
      const fp = await kosztFp();
      const par = await paragon();
      await match(fp, [par], true);
      const foreign = await decide(fp, null, users.obcy);
      expect(foreign.error?.code).toBe('42501');
      expect(await koszt(par)).toMatchObject({ is_deductible: false });
    });
  });
});

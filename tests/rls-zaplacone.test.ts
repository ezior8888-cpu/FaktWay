import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { receivedInflows, upcomingInflows } from '@/lib/dashboard/cash-movements';
import { getInflows } from '@/lib/dashboard/inflows';
import { getReceivables, settledFilterOps } from '@/lib/dashboard/receivables';
import { orFilterString, type PaymentFilterOp } from '@/lib/invoices/list-query';

import { getRlsTestEnvironment } from './helpers/rls-environment';

/**
 * „Zapłacone” jednym dotknięciem (00158, FaktWay 1.0 §3 pkt 3) na prawdziwym
 * Postgresie i PostgREST: RPC `mark_invoice_paid`, `undo_invoice_paid`
 * i `invoice_manual_payment` razem z wyzwalaczami, które naprawdę przeliczają
 * `paid_amount`, `paid_at` i `payment_status` (00014, 00073, 00145). Tych
 * przejść nie sprawdzi żadna atrapa bazy w pamięci.
 *
 * Tabela `payments` zostaje zablokowana dla klienta (00074): jedyna droga
 * zapisu z sesji to te RPC.
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

const ORG_A = '00158158-0000-4000-8000-00000000000a';
const ORG_B = '00158158-0000-4000-8000-00000000000b';
const EMAILS = {
  owner: 'rls-zaplacone-owner@ksef-saas.test',
  member: 'rls-zaplacone-member@ksef-saas.test',
  accountant: 'rls-zaplacone-ksiegowa@ksef-saas.test',
  obcy: 'rls-zaplacone-obcy@ksef-saas.test',
} as const;
const PASS = 'RlsZaplacone2026Aa!';
const NIP = '1234567890';

const users: Record<keyof typeof EMAILS, string> = { owner: '', member: '', accountant: '', obcy: '' };
let counter = 0;

function warsawToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw' }).format(new Date());
}

function warsawDay(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw' }).format(new Date(iso));
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

type Extra = Record<string, unknown>;

function accepted(): Extra {
  return {
    ksef_status: 'accepted',
    ksef_environment: 'test',
    xml_storage_path: 'x.xml',
    ksef_number: `${NIP}-20261001-${String(counter + 1).padStart(12, '0')}-00`,
  };
}

/** Faktura sprzedaży przyjęta w KSeF, termin minął 5 dni temu (bez granicy doby UTC i Warszawy w wyzwalaczu): 1230 zł brutto, nic nie wpłacono. */
async function faktura(fields: Extra = {}, org: string = ORG_A): Promise<string> {
  const base = accepted();
  counter += 1;
  const id = `00158158-1111-4000-8000-${String(counter).padStart(12, '0')}`;
  const number = `FV/158/${counter}`;
  const { error } = await admin.from('invoices').insert({
    id,
    tenant_id: org,
    direction: 'outgoing',
    origin: 'app',
    internal_number: number,
    invoice_type: 'VAT',
    invoice_kind: 'regular',
    issue_date: '2026-10-01',
    payment_due_date: shiftDays(warsawToday(), -5),
    seller_nip: NIP,
    buyer_nip: NIP,
    gross_total: 1230,
    net_total: 1000,
    vat_total: 230,
    fa3_data: { internalNumber: number, type: 'VAT' },
    seller_data: { nip: NIP },
    buyer_data: { nip: NIP, name: 'Nabywca Testowy' },
    ...base,
    ...fields,
  });
  if (error) throw new Error(`insert ${number}: ${error.message}`);
  return id;
}

async function stanFaktury(id: string) {
  const { data, error } = await admin
    .from('invoices')
    .select('paid_amount, paid_at, payment_status')
    .eq('id', id)
    .single();
  if (error) throw error;
  return { ...data, paid_amount: Number(data.paid_amount) };
}

async function wplaty(id: string) {
  const { data, error } = await admin
    .from('payments')
    .select('amount, payment_date, is_confirmed, is_auto_matched, match_method, payment_method, notes')
    .eq('invoice_id', id)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []).map((row) => ({ ...row, amount: Number(row.amount) }));
}

/**
 * Wpisy audytu oznaczenia i cofnięcia. `audit_logs` jest tylko do dopisywania (00052): wpisy z wcześniejszych
 * przebiegów na tej samej bazie zostają, więc testy porównują stan przed i po wywołaniu (`nowyAudyt`).
 */
async function audyt(id: string) {
  const { data, error } = await admin
    .from('audit_logs')
    .select('tenant_id, user_id, action, entity_type, entity_id, metadata')
    .eq('entity_id', id)
    .in('action', ['invoice.marked_paid', 'invoice.paid_undone'])
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

async function nowyAudyt(id: string, wywolanie: () => PromiseLike<unknown>) {
  const przed = (await audyt(id)).length;
  await wywolanie();
  return (await audyt(id)).slice(przed);
}

async function cleanup() {
  for (const org of [ORG_A, ORG_B]) {
    await admin.from('flo_proposals').delete().eq('tenant_id', org);
    await admin.from('payment_reminders').delete().eq('tenant_id', org);
    await admin.from('payments').delete().eq('tenant_id', org);
    await admin.from('invoices').delete().eq('tenant_id', org).eq('invoice_kind', 'correction');
    await admin.from('invoices').delete().eq('tenant_id', org).eq('invoice_kind', 'final');
    await admin.from('invoices').delete().eq('tenant_id', org);
  }
}

describe.skipIf(!hasDatabase)('„Zapłacone” jednym dotknięciem (00158)', () => {
  beforeAll(async () => {
    for (const who of Object.keys(EMAILS) as Array<keyof typeof EMAILS>) {
      users[who] = await userId(EMAILS[who]);
    }
    await cleanup();
    await admin.from('memberships').delete().in('organization_id', [ORG_A, ORG_B]);
    await admin.from('tenants').delete().in('id', [ORG_A, ORG_B]);
    // Wpisy audytu firmy testowej zostają po przebiegu (00052), a kasowanie firmy kaskadą jest wtedy blokowane:
    // kolejny przebieg na tej samej bazie dopisuje się do istniejącej firmy.
    const tenants = await admin.from('tenants').upsert([
      { id: ORG_A, nip: NIP, name: 'Firma A Zapłacone' },
      { id: ORG_B, nip: NIP, name: 'Firma B Zapłacone' },
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
    await admin.from('tenants').delete().in('id', [ORG_A, ORG_B]);
  });

  describe('oznaczenie', () => {
    it('wstawia wpłatę na całą kwotę, a wyzwalacze ustawiają paid_amount, paid_at i payment_status', async () => {
      const id = await faktura();
      const c = await signedIn('owner');

      const { data, error } = await c.rpc('mark_invoice_paid', { p_invoice_id: id });

      expect(error).toBeNull();
      expect(data).toMatchObject({ status: 'marked', amount: 1230, paid_on: warsawToday() });
      const stan = await stanFaktury(id);
      expect(stan).toMatchObject({ paid_amount: 1230, payment_status: 'paid' });
      expect(warsawDay(stan.paid_at!)).toBe(warsawToday());
      expect(await wplaty(id)).toEqual([
        {
          amount: 1230,
          payment_date: warsawToday(),
          is_confirmed: true,
          is_auto_matched: false,
          match_method: 'manual',
          payment_method: 'other',
          notes: expect.stringMatching(/klient/i),
        },
      ]);
    });

    it('drugie dotknięcie zwraca „już zapłacona” bez nowego wiersza', async () => {
      const id = await faktura();
      const c = await signedIn('owner');
      await c.rpc('mark_invoice_paid', { p_invoice_id: id });

      const second = await c.rpc('mark_invoice_paid', { p_invoice_id: id });

      expect(second.error).toBeNull();
      expect(second.data).toMatchObject({ status: 'already_paid' });
      expect(await wplaty(id)).toHaveLength(1);
    });

    it('dwa dotknięcia naraz dają jedną wpłatę (blokada wiersza)', async () => {
      const id = await faktura();
      const c = await signedIn('owner');

      const results = await Promise.all([
        c.rpc('mark_invoice_paid', { p_invoice_id: id }),
        c.rpc('mark_invoice_paid', { p_invoice_id: id }),
      ]);

      expect(results.map((r) => r.error)).toEqual([null, null]);
      expect(results.map((r) => (r.data as { status: string }).status).sort()).toEqual(['already_paid', 'marked']);
      expect(await wplaty(id)).toHaveLength(1);
    });

    it('częściowo zapłacona: dopłaca tylko resztę', async () => {
      const id = await faktura();
      const bank = await admin.from('payments').insert({
        tenant_id: ORG_A, invoice_id: id, amount: 300, payment_date: '2026-10-05',
        is_confirmed: true, match_method: 'bank_import',
      });
      if (bank.error) throw bank.error;
      expect(await stanFaktury(id)).toMatchObject({ paid_amount: 300, payment_status: 'partial', paid_at: null });
      const c = await signedIn('owner');

      const { data } = await c.rpc('mark_invoice_paid', { p_invoice_id: id });

      expect(data).toMatchObject({ status: 'marked', amount: 930 });
      expect(await stanFaktury(id)).toMatchObject({ paid_amount: 1230, payment_status: 'paid' });
      expect((await wplaty(id)).map((p) => p.amount)).toEqual([300, 930]);
    });

    it('ROZ: płaci resztę po zaliczkach z payment_data.amountDue, nie całe brutto', async () => {
      const zaliczka = await faktura({ invoice_type: 'ZAL', invoice_kind: 'advance', advance_amount: 1230 });
      const id = await faktura({
        invoice_type: 'ROZ', invoice_kind: 'final', advance_invoice_ids: [zaliczka],
        gross_total: 10000, net_total: 8130.08, vat_total: 1869.92, payment_data: { amountDue: 6000 },
      });
      const c = await signedIn('owner');

      const { data } = await c.rpc('mark_invoice_paid', { p_invoice_id: id });

      expect(data).toMatchObject({ status: 'marked', amount: 6000 });
      expect(await stanFaktury(id)).toMatchObject({ paid_amount: 6000, payment_status: 'paid' });
    });

    it.each(['file_import', 'ksef_import', 'ksef_inbox'])('pochodzenie %s: wolno oznaczyć', async (origin) => {
      const id = await faktura({ origin });
      const c = await signedIn('owner');

      const { data } = await c.rpc('mark_invoice_paid', { p_invoice_id: id });

      expect(data).toMatchObject({ status: 'marked', amount: 1230 });
      expect(await stanFaktury(id)).toMatchObject({ payment_status: 'paid' });
    });

    it('faktura z datą zapłaty w FA(3) jest już zapłacona: bez wpłaty', async () => {
      const id = await faktura({
        origin: 'file_import',
        fa3_data: { parsed: { paidDate: '2026-09-20' } },
      });
      const c = await signedIn('owner');

      const { data, error } = await c.rpc('mark_invoice_paid', { p_invoice_id: id });

      expect(error).toBeNull();
      expect(data).toMatchObject({ status: 'already_paid' });
      expect(await wplaty(id)).toEqual([]);
    });

    it('korekta in plus ma własną resztę, korekta in minus i korekta do zera nie mają czego opłacić', async () => {
      const f1 = await faktura();
      const plus = await faktura({
        invoice_type: 'KOR', invoice_kind: 'correction', parent_invoice_id: f1,
        correction_reason: 'test', correction_type: 'before_after',
        gross_total: 123, net_total: 100, vat_total: 23,
      });
      const f2 = await faktura();
      const minus = await faktura({
        invoice_type: 'KOR', invoice_kind: 'correction', parent_invoice_id: f2,
        correction_reason: 'test', correction_type: 'before_after',
        gross_total: -123, net_total: -100, vat_total: -23,
      });
      const f3 = await faktura();
      await faktura({
        invoice_type: 'KOR', invoice_kind: 'correction', parent_invoice_id: f3,
        correction_reason: 'test', correction_type: 'before_after',
        gross_total: -1230, net_total: -1000, vat_total: -230,
      });
      const c = await signedIn('owner');

      expect((await c.rpc('mark_invoice_paid', { p_invoice_id: plus })).data).toMatchObject({ status: 'marked', amount: 123 });
      expect((await c.rpc('mark_invoice_paid', { p_invoice_id: minus })).data).toMatchObject({
        status: 'refused', code: 'nothing_to_pay',
      });
      expect((await c.rpc('mark_invoice_paid', { p_invoice_id: f3 })).data).toMatchObject({
        status: 'refused', code: 'corrected_to_zero',
      });
      expect(await wplaty(minus)).toEqual([]);
      expect(await wplaty(f3)).toEqual([]);

      // Faktura pierwotna z korektą częściową: płaci swoją resztę, korekta to osobny ruch.
      expect((await c.rpc('mark_invoice_paid', { p_invoice_id: f2 })).data).toMatchObject({ status: 'marked', amount: 1230 });
    });
  });

  describe('data zapłaty', () => {
    it('wcześniejsza data: payment_date i dzień paid_at w Warszawie to wybrany dzień', async () => {
      const id = await faktura();
      const day = shiftDays(warsawToday(), -12);
      const c = await signedIn('owner');

      const { data } = await c.rpc('mark_invoice_paid', { p_invoice_id: id, p_paid_on: day });

      expect(data).toMatchObject({ status: 'marked', paid_on: day });
      expect((await wplaty(id))[0]?.payment_date).toBe(day);
      expect(warsawDay((await stanFaktury(id)).paid_at!)).toBe(day);
    });

    it('data z przyszłości to odmowa bez zapisu', async () => {
      const id = await faktura();
      const c = await signedIn('owner');

      const { data, error } = await c.rpc('mark_invoice_paid', {
        p_invoice_id: id,
        p_paid_on: shiftDays(warsawToday(), 1),
      });

      expect(error).toBeNull();
      expect(data).toMatchObject({ status: 'refused', code: 'future_date' });
      expect(await wplaty(id)).toEqual([]);
      expect(await stanFaktury(id)).toMatchObject({ paid_amount: 0, paid_at: null });
    });

    it('rok z literówki (przed 2000) to odmowa bez zapisu', async () => {
      const id = await faktura();
      const c = await signedIn('owner');

      const { data } = await c.rpc('mark_invoice_paid', { p_invoice_id: id, p_paid_on: '0202-10-01' });

      expect(data).toMatchObject({ status: 'refused', code: 'invalid_date' });
      expect(await wplaty(id)).toEqual([]);
    });
  });

  describe('odmowy', () => {
    it('szkic: odmowa', async () => {
      const id = await faktura({
        ksef_status: 'draft', ksef_environment: null, xml_storage_path: null, ksef_number: null,
      });
      const c = await signedIn('owner');

      const { data } = await c.rpc('mark_invoice_paid', { p_invoice_id: id });

      expect(data).toMatchObject({ status: 'refused', code: 'not_accepted' });
      expect(await wplaty(id)).toEqual([]);
    });

    it('faktura zakupu: odmowa', async () => {
      const id = await faktura({ direction: 'incoming', origin: 'ksef_inbox' });
      const c = await signedIn('owner');

      const { data } = await c.rpc('mark_invoice_paid', { p_invoice_id: id });

      expect(data).toMatchObject({ status: 'refused', code: 'not_sales' });
      expect(await wplaty(id)).toEqual([]);
    });

    it('obca firma: odmowa jak przy braku faktury, bez zapisu', async () => {
      const id = await faktura();
      const c = await signedIn('obcy', ORG_B);

      const mark = await c.rpc('mark_invoice_paid', { p_invoice_id: id });
      const undo = await c.rpc('undo_invoice_paid', { p_invoice_id: id });

      expect(mark.data).toMatchObject({ status: 'refused', code: 'not_found' });
      expect(undo.data).toMatchObject({ status: 'refused', code: 'not_found' });
      expect(await wplaty(id)).toEqual([]);
    });

    it('nagłówek obcej firmy bez członkostwa: odmowa 42501', async () => {
      const id = await faktura();
      const c = await signedIn('obcy', ORG_A);

      const { error } = await c.rpc('mark_invoice_paid', { p_invoice_id: id });

      expect(error?.code).toBe('42501');
      expect(await wplaty(id)).toEqual([]);
    });

    it('księgowa ma wgląd, nie oznacza i nie cofa: 42501', async () => {
      const id = await faktura();
      const c = await signedIn('accountant');

      const mark = await c.rpc('mark_invoice_paid', { p_invoice_id: id });
      expect(mark.error?.code).toBe('42501');
      expect(await wplaty(id)).toEqual([]);

      const owner = await signedIn('owner');
      await owner.rpc('mark_invoice_paid', { p_invoice_id: id });
      const undo = await c.rpc('undo_invoice_paid', { p_invoice_id: id });
      expect(undo.error?.code).toBe('42501');
      expect(await wplaty(id)).toHaveLength(1);
    });

    it('członek firmy oznacza i cofa', async () => {
      const id = await faktura();
      const c = await signedIn('member');

      expect((await c.rpc('mark_invoice_paid', { p_invoice_id: id })).data).toMatchObject({ status: 'marked' });
      expect((await c.rpc('undo_invoice_paid', { p_invoice_id: id })).data).toMatchObject({ status: 'undone' });
    });

    it('anon nie woła żadnej z funkcji', async () => {
      const id = await faktura();
      for (const fn of ['mark_invoice_paid', 'undo_invoice_paid', 'invoice_manual_payment']) {
        const { error } = await anonClient().rpc(fn, { p_invoice_id: id });
        expect(error?.code).toBe('42501');
      }
    });

    it('sesja dalej nie zapisuje do payments wprost (00074)', async () => {
      const id = await faktura();
      const c = await signedIn('owner');

      const { error } = await c.from('payments').insert({
        tenant_id: ORG_A, invoice_id: id, amount: 1, payment_date: warsawToday(),
      });

      expect(error?.code).toBe('42501');
    });
  });

  describe('cofnięcie', () => {
    it('usuwa ręczną wpłatę i wraca do stanu sprzed oznaczenia: termin minął → overdue', async () => {
      const id = await faktura();
      const c = await signedIn('owner');
      await c.rpc('mark_invoice_paid', { p_invoice_id: id });

      const { data } = await c.rpc('undo_invoice_paid', { p_invoice_id: id });

      expect(data).toMatchObject({ status: 'undone', amount: 1230 });
      expect(await wplaty(id)).toEqual([]);
      expect(await stanFaktury(id)).toEqual({ paid_amount: 0, paid_at: null, payment_status: 'overdue' });
    });

    it('termin w przyszłości → unpaid', async () => {
      const id = await faktura({ payment_due_date: shiftDays(warsawToday(), 10) });
      const c = await signedIn('owner');
      await c.rpc('mark_invoice_paid', { p_invoice_id: id });

      await c.rpc('undo_invoice_paid', { p_invoice_id: id });

      expect(await stanFaktury(id)).toEqual({ paid_amount: 0, paid_at: null, payment_status: 'unpaid' });
    });

    it('zostawia wpłatę z banku, faktura wraca do „partial”', async () => {
      const id = await faktura();
      await admin.from('payments').insert({
        tenant_id: ORG_A, invoice_id: id, amount: 300, payment_date: '2026-10-05',
        is_confirmed: true, match_method: 'bank_import',
      });
      const c = await signedIn('owner');
      await c.rpc('mark_invoice_paid', { p_invoice_id: id });

      await c.rpc('undo_invoice_paid', { p_invoice_id: id });

      expect((await wplaty(id)).map((p) => p.match_method)).toEqual(['bank_import']);
      expect(await stanFaktury(id)).toEqual({ paid_amount: 300, paid_at: null, payment_status: 'partial' });
    });

    it.each(['flo_confirmation', 'bank_import'])('nie rusza wpłaty %s: „nie ma czego cofnąć”', async (method) => {
      const id = await faktura();
      await admin.from('payments').insert({
        tenant_id: ORG_A, invoice_id: id, amount: 1230, payment_date: '2026-10-05',
        is_confirmed: true, match_method: method,
      });
      const c = await signedIn('owner');

      const { data } = await c.rpc('undo_invoice_paid', { p_invoice_id: id });

      expect(data).toMatchObject({ status: 'nothing_to_undo' });
      expect(await wplaty(id)).toHaveLength(1);
      expect(await stanFaktury(id)).toMatchObject({ paid_amount: 1230, payment_status: 'paid' });
    });

    it('drugie cofnięcie: „nie ma czego cofnąć”, bez zmian', async () => {
      const id = await faktura();
      const c = await signedIn('owner');
      await c.rpc('mark_invoice_paid', { p_invoice_id: id });
      await c.rpc('undo_invoice_paid', { p_invoice_id: id });

      const { data, error } = await c.rpc('undo_invoice_paid', { p_invoice_id: id });

      expect(error).toBeNull();
      expect(data).toMatchObject({ status: 'nothing_to_undo' });
    });

    it('ROZ: po cofnięciu nie zostaje „paid”', async () => {
      const zaliczka = await faktura({ invoice_type: 'ZAL', invoice_kind: 'advance', advance_amount: 1230 });
      const id = await faktura({
        invoice_type: 'ROZ', invoice_kind: 'final', advance_invoice_ids: [zaliczka],
        gross_total: 10000, net_total: 8130.08, vat_total: 1869.92, payment_data: { amountDue: 6000 },
      });
      const c = await signedIn('owner');
      await c.rpc('mark_invoice_paid', { p_invoice_id: id });

      await c.rpc('undo_invoice_paid', { p_invoice_id: id });

      expect(await stanFaktury(id)).toEqual({ paid_amount: 0, paid_at: null, payment_status: 'overdue' });
    });
  });

  // Recenzja PR #358: audyt robi sama funkcja w bazie, w tej samej transakcji co wpłata. Dopiero wtedy nie ma
  // wpłaty bez śladu (akcja serwerowa mogła paść między RPC a zapisem audytu) ani śladu bez wpłaty.
  describe('audyt w tej samej transakcji co wpłata', () => {
    it('oznaczenie zapisuje wpis: firma i użytkownik z sesji, kwota, dzień, wpłata, przypomnienia', async () => {
      const id = await faktura();
      const c = await signedIn('owner');
      let payment = '';

      const wpisy = await nowyAudyt(id, async () => {
        const { data } = await c.rpc('mark_invoice_paid', { p_invoice_id: id });
        payment = (data as { payment_id: string }).payment_id;
      });

      expect(payment).not.toBe('');
      expect(wpisy).toEqual([{
        tenant_id: ORG_A,
        user_id: users.owner,
        action: 'invoice.marked_paid',
        entity_type: 'invoice',
        entity_id: id,
        metadata: { amount: 1230, paidOn: warsawToday(), customDate: false, paymentId: payment, remindersCancelled: 0 },
      }]);
    });

    it('wybrana data to customDate = true, a wpis niesie użytkownika, który kliknął (członek firmy)', async () => {
      const id = await faktura();
      const c = await signedIn('member');
      const day = shiftDays(warsawToday(), -3);

      const wpisy = await nowyAudyt(id, () => c.rpc('mark_invoice_paid', { p_invoice_id: id, p_paid_on: day }));

      expect(wpisy).toHaveLength(1);
      expect(wpisy[0]).toMatchObject({
        user_id: users.member,
        action: 'invoice.marked_paid',
        metadata: { amount: 1230, paidOn: day, customDate: true, remindersCancelled: 0 },
      });
    });

    it('cofnięcie zapisuje wpis z kwotą i dniem usuniętej wpłaty', async () => {
      const id = await faktura();
      const c = await signedIn('owner');
      const day = shiftDays(warsawToday(), -2);
      await c.rpc('mark_invoice_paid', { p_invoice_id: id, p_paid_on: day });

      const wpisy = await nowyAudyt(id, () => c.rpc('undo_invoice_paid', { p_invoice_id: id }));

      expect(wpisy).toEqual([{
        tenant_id: ORG_A,
        user_id: users.owner,
        action: 'invoice.paid_undone',
        entity_type: 'invoice',
        entity_id: id,
        metadata: { amount: 1230, paidOn: day, remindersRestored: 0 },
      }]);
    });

    it('bez zmiany nie ma wpisu: ponowne oznaczenie, odmowa, brak uprawnień, drugie cofnięcie', async () => {
      const id = await faktura();
      const c = await signedIn('owner');
      const ksiegowa = await signedIn('accountant');
      await c.rpc('mark_invoice_paid', { p_invoice_id: id });
      await c.rpc('undo_invoice_paid', { p_invoice_id: id });
      await c.rpc('mark_invoice_paid', { p_invoice_id: id });

      const wpisy = await nowyAudyt(id, async () => {
        await c.rpc('mark_invoice_paid', { p_invoice_id: id });
        await c.rpc('mark_invoice_paid', { p_invoice_id: id, p_paid_on: shiftDays(warsawToday(), 3) });
        await ksiegowa.rpc('mark_invoice_paid', { p_invoice_id: id });
        await ksiegowa.rpc('undo_invoice_paid', { p_invoice_id: id });
        await c.rpc('undo_invoice_paid', { p_invoice_id: id });
        await c.rpc('undo_invoice_paid', { p_invoice_id: id });
      });

      expect(wpisy.map((w) => w.action)).toEqual(['invoice.paid_undone']);
    });

    it('wpłata z banku zostaje i nie ma wpisu o cofnięciu', async () => {
      const id = await faktura();
      const bank = await admin.from('payments').insert({
        tenant_id: ORG_A, invoice_id: id, amount: 300, payment_date: '2026-10-05',
        is_confirmed: true, match_method: 'bank_import',
      });
      if (bank.error) throw bank.error;
      const c = await signedIn('owner');

      const wpisy = await nowyAudyt(id, () => c.rpc('undo_invoice_paid', { p_invoice_id: id }));

      expect(wpisy).toEqual([]);
    });
  });

  describe('należności po oznaczeniu', () => {
    it('widok invoices_overdue: znika po oznaczeniu, wraca po cofnięciu', async () => {
      const id = await faktura();
      const c = await signedIn('owner');
      const wWidoku = async () => (await c.from('invoices_overdue').select('id').eq('id', id)).data?.length ?? 0;
      expect(await wWidoku()).toBe(1);

      await c.rpc('mark_invoice_paid', { p_invoice_id: id });
      expect(await wWidoku()).toBe(0);

      await c.rpc('undo_invoice_paid', { p_invoice_id: id });
      expect(await wWidoku()).toBe(1);
    });
  });

  describe('wpływy i należności z prawdziwej sesji (te same loadery co karty)', () => {
    type Session = Parameters<typeof getInflows>[0];

    it('faktura po terminie to należność; po oznaczeniu wpływ w wybranym dniu; po cofnięciu znów należność', async () => {
      const id = await faktura();
      const c = await signedIn('owner');
      const from = shiftDays(warsawToday(), -60);
      const day = shiftDays(warsawToday(), -3);
      const stan = async () => ({
        wplywy: receivedInflows(await getInflows(c as unknown as Session, ORG_A, { from }), warsawToday()),
        naleznosci: await getReceivables(c as unknown as Session, ORG_A),
      });

      const przed = await stan();
      expect(przed.wplywy).toEqual([]);
      expect(przed.naleznosci).toMatchObject({ overdue: 1230, overdueCount: 1 });

      await c.rpc('mark_invoice_paid', { p_invoice_id: id, p_paid_on: day });
      const po = await stan();
      expect(po.wplywy.map((e) => [e.id, e.date, e.basis, e.amount])).toEqual([[id, day, 'paid', 1230]]);
      expect(po.naleznosci).toMatchObject({ total: 0, count: 0 });

      await c.rpc('undo_invoice_paid', { p_invoice_id: id });
      const cofniete = await stan();
      expect(cofniete.wplywy).toEqual([]);
      expect(cofniete.naleznosci).toMatchObject({ overdue: 1230, overdueCount: 1 });
    });

    it('korekta in minus do oznaczonej faktury: osobny ruch, suma to kwota po korekcie (także przy rodzicu przed zakresem)', async () => {
      const id = await faktura({ issue_date: '2026-01-05', payment_due_date: '2026-01-19' });
      await faktura({
        invoice_type: 'KOR', invoice_kind: 'correction', parent_invoice_id: id,
        correction_reason: 'test', correction_type: 'before_after', payment_due_date: null,
        issue_date: warsawToday(), gross_total: -123, net_total: -100, vat_total: -23,
      });
      const c = await signedIn('owner');
      await c.rpc('mark_invoice_paid', { p_invoice_id: id, p_paid_on: '2026-02-10' });

      const wszystko = receivedInflows(
        await getInflows(c as unknown as Session, ORG_A, { from: '2026-01-01' }),
        warsawToday(),
      );
      expect(wszystko.reduce((sum, e) => sum + e.amount, 0)).toBe(1107);
      // Okno, w którym rodzic już się nie mieści: dodatkowy odczyt przez prawdziwy PostgREST.
      const okno = receivedInflows(
        await getInflows(c as unknown as Session, ORG_A, { from: shiftDays(warsawToday(), -7) }),
        warsawToday(),
      );
      expect(okno.map((e) => [e.basis, e.amount])).toEqual([['correction', -123]]);
    });

    it('spodziewane: otwarta z terminem od dziś; po oznaczeniu znika', async () => {
      const id = await faktura({ payment_due_date: shiftDays(warsawToday(), 10) });
      const c = await signedIn('owner');
      const today = warsawToday();
      const spodziewane = async () =>
        upcomingInflows(await getInflows(c as unknown as Session, ORG_A, { from: today }), today).items.map((i) => i.id);

      expect(await spodziewane()).toEqual([id]);
      await c.rpc('mark_invoice_paid', { p_invoice_id: id });
      expect(await spodziewane()).toEqual([]);
    });

    it('filtr „Opłacone” przez prawdziwy PostgREST: ręczna wpłata, import i data zapłaty z FA(3)', async () => {
      const app = await faktura();
      const plik = await faktura({ origin: 'file_import' });
      const zFa3 = await faktura({ origin: 'ksef_import', fa3_data: { parsed: { paidDate: '2026-09-20' } } });
      await faktura();
      const c = await signedIn('owner');
      await c.rpc('mark_invoice_paid', { p_invoice_id: app });
      await c.rpc('mark_invoice_paid', { p_invoice_id: plik });

      const ops: PaymentFilterOp[] = settledFilterOps('test');
      let query = c.from('invoices').select('id').eq('tenant_id', ORG_A);
      for (const op of ops) {
        if (op.op === 'eq') query = query.eq(op.column, op.value);
        else if (op.op === 'or') query = query.or(orFilterString(op.anyOf));
      }
      const { data, error } = await query;

      expect(error).toBeNull();
      expect((data ?? []).map((row) => row.id).sort()).toEqual([app, plik, zFa3].sort());
    });
  });

  describe('invoice_manual_payment (szczegóły faktury)', () => {
    it('zwraca dzień i kwotę ręcznej wpłaty, po cofnięciu nic; obca firma nic nie widzi', async () => {
      const id = await faktura();
      const c = await signedIn('owner');
      const day = shiftDays(warsawToday(), -3);
      await c.rpc('mark_invoice_paid', { p_invoice_id: id, p_paid_on: day });

      const read = await c.rpc('invoice_manual_payment', { p_invoice_id: id });
      expect(read.error).toBeNull();
      expect(read.data).toEqual({ amount: 1230, paid_on: day });

      const accountant = await signedIn('accountant');
      expect((await accountant.rpc('invoice_manual_payment', { p_invoice_id: id })).data).toEqual({ amount: 1230, paid_on: day });

      const obcy = await signedIn('obcy', ORG_B);
      expect((await obcy.rpc('invoice_manual_payment', { p_invoice_id: id })).data).toBeNull();

      await c.rpc('undo_invoice_paid', { p_invoice_id: id });
      expect((await c.rpc('invoice_manual_payment', { p_invoice_id: id })).data).toBeNull();
    });

    it('wpłata z FLO nie jest ręczna', async () => {
      const id = await faktura();
      await admin.from('payments').insert({
        tenant_id: ORG_A, invoice_id: id, amount: 1230, payment_date: '2026-10-05',
        is_confirmed: true, match_method: 'flo_confirmation',
      });
      const c = await signedIn('owner');

      expect((await c.rpc('invoice_manual_payment', { p_invoice_id: id })).data).toBeNull();
    });
  });

  describe('przypomnienia', () => {
    const MARKER = 'Faktura oznaczona jako zapłacona';

    async function przypomnienie(invoiceId: string, stage: string, fields: Extra = {}): Promise<string> {
      const { data, error } = await admin.from('payment_reminders').insert({
        tenant_id: ORG_A, invoice_id: invoiceId, stage, channel: 'email',
        scheduled_for: new Date().toISOString(), status: 'pending', ...fields,
      }).select('id').single();
      if (error) throw error;
      return data.id as string;
    }

    /** Zgoda z zapisanym zleceniem wysyłki (`reminderDispatch`): identyfikator zgody = identyfikator przypomnienia. */
    async function zgoda(reminderId: string, invoiceId: string, stage: string, extra: Extra = {}) {
      const proposal = await admin.from('flo_proposals').insert({
        tenant_id: ORG_A, kind: 'payment.chase', topic_key: `reminder-preview:${reminderId}`, status: 'done',
        title: 'Przypomnienie', body: 'Treść', fingerprint: 'x', expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      }).select('id').single();
      if (proposal.error) throw proposal.error;
      const approval = await admin.from('flo_approvals').insert({
        id: reminderId, proposal_id: proposal.data.id, tenant_id: ORG_A, user_id: users.owner,
        consumed_at: new Date().toISOString(),
        snapshot: { operationHash: 'x', reminderDispatch: { version: 1, reminderId, invoiceId, stage }, ...extra },
      });
      if (approval.error) throw approval.error;
    }

    async function stanPrzypomnien(invoiceId: string) {
      const { data, error } = await admin.from('payment_reminders')
        .select('id, stage, status, failure_reason').eq('invoice_id', invoiceId).order('stage', { ascending: true });
      if (error) throw error;
      return data ?? [];
    }

    async function snapshotZgody(id: string): Promise<Record<string, unknown>> {
      const { data, error } = await admin.from('flo_approvals').select('snapshot').eq('id', id).single();
      if (error) throw error;
      return data.snapshot as Record<string, unknown>;
    }

    it('oznaczenie anuluje oczekujące w tej samej transakcji; wysłanych i wstrzymanych nie rusza', async () => {
      const id = await faktura();
      await przypomnienie(id, 'stage_1', { status: 'sent', sent_at: new Date().toISOString() });
      await przypomnienie(id, 'stage_2');
      await przypomnienie(id, 'stage_3', { status: 'cancelled', failure_reason: 'Wstrzymane przez użytkownika' });
      const c = await signedIn('owner');

      const { data } = await c.rpc('mark_invoice_paid', { p_invoice_id: id });

      expect(data).toMatchObject({ status: 'marked', reminders_cancelled: 1 });
      expect(await stanPrzypomnien(id)).toMatchObject([
        { stage: 'stage_1', status: 'sent' },
        { stage: 'stage_2', status: 'cancelled', failure_reason: MARKER },
        { stage: 'stage_3', status: 'cancelled', failure_reason: 'Wstrzymane przez użytkownika' },
      ]);
    });

    it('audyt niesie liczbę anulowanych i zwolnionych przypomnień', async () => {
      const id = await faktura();
      await przypomnienie(id, 'stage_1', { status: 'sent', sent_at: new Date().toISOString() });
      await przypomnienie(id, 'stage_2');
      const c = await signedIn('owner');

      const oznaczenie = await nowyAudyt(id, () => c.rpc('mark_invoice_paid', { p_invoice_id: id }));
      const cofniecie = await nowyAudyt(id, () => c.rpc('undo_invoice_paid', { p_invoice_id: id }));

      expect(oznaczenie[0]?.metadata).toMatchObject({ remindersCancelled: 1 });
      expect(cofniecie[0]?.metadata).toMatchObject({ remindersRestored: 1 });
    });

    it('cofnięcie zwalnia etap anulowany przez oznaczenie, a jego stara zgoda nie może już wysłać', async () => {
      const id = await faktura();
      const sent = await przypomnienie(id, 'stage_1', { status: 'sent', sent_at: new Date().toISOString() });
      const pending = await przypomnienie(id, 'stage_2');
      await zgoda(pending, id, 'stage_2');
      await przypomnienie(id, 'stage_3', { status: 'cancelled', failure_reason: 'Wstrzymane przez użytkownika' });
      const c = await signedIn('owner');
      await c.rpc('mark_invoice_paid', { p_invoice_id: id });

      const { data } = await c.rpc('undo_invoice_paid', { p_invoice_id: id });

      expect(data).toMatchObject({ status: 'undone', reminders_restored: 1 });
      // Etap wolny: harmonogram (`decideNextReminder`) zaproponuje go znów, wysyłka wyjdzie po nowej zgodzie.
      expect(await stanPrzypomnien(id)).toMatchObject([
        { id: sent, stage: 'stage_1', status: 'sent' },
        { stage: 'stage_3', status: 'cancelled', failure_reason: 'Wstrzymane przez użytkownika' },
      ]);
      // `hasReminderDispatch` szuka `snapshot->reminderDispatch`: etap wolny dla nowej zgody,
      // a job z kolejki przy starej zgodzie kończy się na `readReminderDispatch` (brak zlecenia).
      const snapshot = await snapshotZgody(pending);
      expect(snapshot.reminderDispatch).toBeUndefined();
      expect(snapshot.reminderDispatchVoided).toMatchObject({ reason: 'undo_invoice_paid' });
      // To samo zapytanie co `hasReminderDispatch` (`lib/reminders/delivery-consent.ts`).
      const zlecenia = await admin.from('flo_approvals').select('id').eq('tenant_id', ORG_A)
        .eq('snapshot->reminderDispatch->>invoiceId', id).eq('snapshot->reminderDispatch->>stage', 'stage_2');
      expect(zlecenia.data).toEqual([]);
      // A nowa wysyłka tego etapu zmieści się w UNIQUE (invoice_id, stage).
      await przypomnienie(id, 'stage_2');
      // Faktura wraca do kandydatów crona (`findInvoicesRequiringReminders`).
      expect((await stanFaktury(id)).payment_status).toBe('overdue');
    });

    it('wysyłka już potwierdzona (reminderReceipt): cofnięcie nie zwalnia etapu, więc drugiej wysyłki nie będzie', async () => {
      const id = await faktura();
      const pending = await przypomnienie(id, 'stage_1');
      await zgoda(pending, id, 'stage_1', { reminderReceipt: { messageId: 'm', sentAt: new Date().toISOString() } });
      const c = await signedIn('owner');
      await c.rpc('mark_invoice_paid', { p_invoice_id: id });

      const { data } = await c.rpc('undo_invoice_paid', { p_invoice_id: id });

      expect(data).toMatchObject({ status: 'undone', reminders_restored: 0 });
      expect(await stanPrzypomnien(id)).toHaveLength(1);
      expect((await snapshotZgody(pending)).reminderDispatch).toBeDefined();
    });

    it('cofnięcie nie rusza wstrzymania przypomnień na fakturze', async () => {
      const id = await faktura({ reminders_paused: true, reminders_paused_reason: 'Umowa z klientem' });
      const c = await signedIn('owner');
      await c.rpc('mark_invoice_paid', { p_invoice_id: id });
      await c.rpc('undo_invoice_paid', { p_invoice_id: id });

      const { data } = await admin.from('invoices').select('reminders_paused, reminders_paused_reason').eq('id', id).single();
      expect(data).toEqual({ reminders_paused: true, reminders_paused_reason: 'Umowa z klientem' });
    });
  });
});

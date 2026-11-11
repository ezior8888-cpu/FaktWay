import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { getRlsTestEnvironment } from './helpers/rls-environment';

/**
 * Wpłaty częściowe i historia wpłat (plan kompletnej aplikacji, krok 3.1,
 * migracja 00176) na prawdziwym Postgresie i PostgREST: RPC
 * `record_invoice_payment`, `void_invoice_payment` i `invoice_payments` razem
 * z wyzwalaczami, które naprawdę przeliczają `paid_amount`, `paid_at`
 * i `payment_status` (00073, 00145, 00176). Tych przejść nie sprawdzi żadna
 * atrapa bazy w pamięci.
 *
 * Niezmienniki z planu (krok 3.1, „Sprawdzamy na”):
 *  - suma niecofniętych wpłat równa się `paid_amount`;
 *  - ta sama wpłata z tym samym kluczem liczy się raz;
 *  - użytkownik innej firmy nie zapisze ani nie cofnie wpłaty;
 *  - kwota dodatnia, nie ponad resztę, tylko w PLN;
 *  - zakup, szkic, korekta: jak `mark_invoice_paid` (00158).
 *
 * `payments` zostaje zablokowana dla sesji (00074): jedyna droga z sesji to RPC.
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

const ORG_A = '00176176-0000-4000-8000-00000000000a';
const ORG_B = '00176176-0000-4000-8000-00000000000b';
const EMAILS = {
  owner: 'rls-wplaty-owner@ksef-saas.test',
  member: 'rls-wplaty-member@ksef-saas.test',
  accountant: 'rls-wplaty-ksiegowa@ksef-saas.test',
  obcy: 'rls-wplaty-obcy@ksef-saas.test',
} as const;
const PASS = 'RlsWplaty2026Aa!';
const NIP = '1234567890';
const MARKER = 'Faktura oznaczona jako zapłacona';
const AUDIT_ACTIONS = ['invoice.payment_recorded', 'invoice.payment_voided', 'invoice.marked_paid', 'invoice.paid_undone'];

const users: Record<keyof typeof EMAILS, string> = { owner: '', member: '', accountant: '', obcy: '' };
let counter = 0;
let keyCounter = 0;

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

/** Nowy klucz idempotencji (UUID v4), jak `crypto.randomUUID()` w oknie „Zapisz wpłatę”. */
function key(): string {
  keyCounter += 1;
  return `00176176-4444-4000-8000-${String(keyCounter).padStart(12, '0')}`;
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

/** Faktura sprzedaży przyjęta w KSeF, termin minął 5 dni temu: 1230 zł brutto, nic nie wpłacono. */
async function faktura(fields: Extra = {}, org: string = ORG_A): Promise<string> {
  counter += 1;
  const id = `00176176-1111-4000-8000-${String(counter).padStart(12, '0')}`;
  const number = `FV/176/${counter}`;
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
    currency: 'PLN',
    fa3_data: { internalNumber: number, type: 'VAT' },
    seller_data: { nip: NIP },
    buyer_data: { nip: NIP, name: 'Nabywca Testowy' },
    ksef_status: 'accepted',
    ksef_environment: 'test',
    xml_storage_path: 'x.xml',
    ksef_number: `${NIP}-20261001-${String(counter).padStart(12, '0')}-76`,
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

interface PaymentRow {
  id: string;
  amount: number;
  payment_date: string;
  match_method: string | null;
  is_confirmed: boolean;
  is_auto_matched: boolean;
  notes: string | null;
  idempotency_key: string | null;
  created_by: string | null;
  voided_at: string | null;
  voided_by: string | null;
}

/** Wszystkie wiersze `payments` faktury, także cofnięte (cofnięcie zostawia ślad). */
async function wplaty(id: string): Promise<PaymentRow[]> {
  const { data, error } = await admin
    .from('payments')
    .select('id, amount, payment_date, match_method, is_confirmed, is_auto_matched, notes, idempotency_key, created_by, voided_at, voided_by')
    .eq('invoice_id', id)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return ((data ?? []) as PaymentRow[]).map((row) => ({ ...row, amount: Number(row.amount) }));
}

/** Niezmiennik z planu: suma wpłat liczonych i niecofniętych = `paid_amount` faktury. */
async function sumaZgodna(id: string): Promise<void> {
  const rows = await wplaty(id);
  const sum = rows
    .filter((row) => row.voided_at === null && (!row.is_auto_matched || row.is_confirmed))
    .reduce((acc, row) => acc + Math.round(row.amount * 100), 0) / 100;
  expect((await stanFaktury(id)).paid_amount).toBe(sum);
}

async function audyt(id: string) {
  const { data, error } = await admin
    .from('audit_logs')
    .select('tenant_id, user_id, action, entity_type, entity_id, metadata')
    .eq('entity_id', id)
    .in('action', AUDIT_ACTIONS)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

/** `audit_logs` jest tylko do dopisywania (00052): porównujemy stan przed i po wywołaniu. */
async function nowyAudyt(id: string, wywolanie: () => PromiseLike<unknown>) {
  const przed = (await audyt(id)).length;
  await wywolanie();
  return (await audyt(id)).slice(przed);
}

interface RecordArgs {
  amount?: number | null;
  paidOn?: string | null;
  key?: string | null;
  note?: string | null;
  currency?: string;
}

function zapisz(c: SupabaseClient, invoiceId: string, args: RecordArgs = {}) {
  return c.rpc('record_invoice_payment', {
    p_invoice_id: invoiceId,
    p_amount: args.amount === undefined ? 300 : args.amount,
    p_paid_on: args.paidOn === undefined ? warsawToday() : args.paidOn,
    p_idempotency_key: args.key === undefined ? key() : args.key,
    p_note: args.note === undefined ? null : args.note,
    ...(args.currency === undefined ? {} : { p_currency: args.currency }),
  });
}

function cofnij(c: SupabaseClient, paymentId: string) {
  return c.rpc('void_invoice_payment', { p_payment_id: paymentId });
}

async function historia(c: SupabaseClient, invoiceId: string) {
  const { data, error } = await c.rpc('invoice_payments', { p_invoice_id: invoiceId });
  if (error) throw error;
  return data as Array<Record<string, unknown>>;
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

describe.skipIf(!hasDatabase)('Wpłaty częściowe i historia wpłat (00176)', () => {
  beforeAll(async () => {
    for (const who of Object.keys(EMAILS) as Array<keyof typeof EMAILS>) {
      users[who] = await userId(EMAILS[who]);
    }
    await cleanup();
    await admin.from('memberships').delete().in('organization_id', [ORG_A, ORG_B]);
    // Wpisy audytu zostają po przebiegu (00052), więc firmę dopisujemy, a nie odtwarzamy.
    const tenants = await admin.from('tenants').upsert([
      { id: ORG_A, nip: NIP, name: 'Firma A Wpłaty' },
      { id: ORG_B, nip: NIP, name: 'Firma B Wpłaty' },
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

  describe('zapis wpłaty', () => {
    it('wpłata częściowa: wiersz w payments, paid_amount z wyzwalacza, stan „partial”, bez paid_at', async () => {
      const id = await faktura();
      const c = await signedIn('owner');
      const k = key();
      const day = shiftDays(warsawToday(), -3);

      const { data, error } = await zapisz(c, id, { amount: 300, paidOn: day, key: k, note: '  przelew z mBanku ' });

      expect(error).toBeNull();
      expect(data).toMatchObject({ status: 'recorded', amount: 300, paid_on: day, remaining: 930, payment_status: 'partial' });
      expect(await stanFaktury(id)).toEqual({ paid_amount: 300, paid_at: null, payment_status: 'partial' });
      expect(await wplaty(id)).toEqual([expect.objectContaining({
        id: (data as { payment_id: string }).payment_id,
        amount: 300,
        payment_date: day,
        match_method: 'manual_entry',
        is_confirmed: true,
        is_auto_matched: false,
        notes: 'przelew z mBanku',
        idempotency_key: k,
        created_by: users.owner,
        voided_at: null,
      })]);
      await sumaZgodna(id);
    });

    it('druga wpłata zamyka fakturę: „paid”, a dzień paid_at to dzień najpóźniejszej wpłaty', async () => {
      const id = await faktura();
      const c = await signedIn('owner');
      const early = shiftDays(warsawToday(), -10);
      const late = shiftDays(warsawToday(), -4);

      await zapisz(c, id, { amount: 300, paidOn: late });
      const { data } = await zapisz(c, id, { amount: 930, paidOn: early });

      expect(data).toMatchObject({ status: 'recorded', remaining: 0, payment_status: 'paid' });
      const stan = await stanFaktury(id);
      expect(stan).toMatchObject({ paid_amount: 1230, payment_status: 'paid' });
      expect(warsawDay(stan.paid_at!)).toBe(late);
      await sumaZgodna(id);
    });

    it('wpłata na dziś bez daty: dzień w Warszawie', async () => {
      const id = await faktura();
      const c = await signedIn('owner');

      const { data } = await zapisz(c, id, { amount: 1230, paidOn: null });

      expect(data).toMatchObject({ status: 'recorded', paid_on: warsawToday(), payment_status: 'paid' });
      expect(warsawDay((await stanFaktury(id)).paid_at!)).toBe(warsawToday());
    });

    it('cała kwota co do grosza przechodzi; grosz więcej to odmowa z resztą, bez zapisu', async () => {
      const id = await faktura();
      const c = await signedIn('owner');
      await zapisz(c, id, { amount: 300 });

      const ponad = await zapisz(c, id, { amount: 930.01 });
      expect(ponad.error).toBeNull();
      expect(ponad.data).toMatchObject({ status: 'refused', code: 'over_remaining', remaining: 930, internal_number: expect.stringMatching(/^FV\/176\//) });
      expect(await wplaty(id)).toHaveLength(1);

      expect((await zapisz(c, id, { amount: 930 })).data).toMatchObject({ status: 'recorded', payment_status: 'paid' });
      await sumaZgodna(id);
    });

    it('ROZ: reszta liczona od payment_data.amountDue, nie od całego brutto', async () => {
      const zaliczka = await faktura({ invoice_type: 'ZAL', invoice_kind: 'advance', advance_amount: 1230 });
      const id = await faktura({
        invoice_type: 'ROZ', invoice_kind: 'final', advance_invoice_ids: [zaliczka],
        gross_total: 10000, net_total: 8130.08, vat_total: 1869.92, payment_data: { amountDue: 6000 },
      });
      const c = await signedIn('owner');

      expect((await zapisz(c, id, { amount: 6000.01 })).data).toMatchObject({ status: 'refused', code: 'over_remaining', remaining: 6000 });
      expect((await zapisz(c, id, { amount: 2000 })).data).toMatchObject({ status: 'recorded', remaining: 4000, payment_status: 'partial' });
      expect((await zapisz(c, id, { amount: 4000 })).data).toMatchObject({ status: 'recorded', remaining: 0, payment_status: 'paid' });
      await sumaZgodna(id);
    });

    it('po „Zapłacone” (mark_invoice_paid) nowa wpłata to odmowa „już zapłacona”', async () => {
      const id = await faktura();
      const c = await signedIn('owner');
      await c.rpc('mark_invoice_paid', { p_invoice_id: id });

      expect((await zapisz(c, id)).data).toMatchObject({ status: 'refused', code: 'already_paid' });
      expect((await wplaty(id)).map((p) => p.match_method)).toEqual(['manual']);
    });

    it('„Zapłacone” po wpłacie częściowej płaci tylko resztę; obie wpłaty w jednej historii', async () => {
      const id = await faktura();
      const c = await signedIn('owner');
      await zapisz(c, id, { amount: 300, paidOn: shiftDays(warsawToday(), -2) });

      expect((await c.rpc('mark_invoice_paid', { p_invoice_id: id })).data).toMatchObject({ status: 'marked', amount: 930 });

      expect((await historia(c, id)).map((p) => [Number(p.amount), p.source])).toEqual([[300, 'manual_entry'], [930, 'manual']]);
      await sumaZgodna(id);
    });

    it('faktura z datą zapłaty w FA(3): już zapłacona, bez wpłaty', async () => {
      const id = await faktura({ origin: 'file_import', fa3_data: { parsed: { paidDate: '2026-09-20' } } });
      const c = await signedIn('owner');

      expect((await zapisz(c, id)).data).toMatchObject({ status: 'refused', code: 'already_paid' });
      expect(await wplaty(id)).toEqual([]);
    });
  });

  describe('klucz idempotencji: ta sama wpłata liczy się raz', () => {
    it('drugie wysłanie z tym samym kluczem: „already_recorded” z tym samym wierszem, bez drugiej wpłaty', async () => {
      const id = await faktura();
      const c = await signedIn('owner');
      const k = key();
      const day = shiftDays(warsawToday(), -1);

      const first = await zapisz(c, id, { amount: 300, paidOn: day, key: k });
      const second = await zapisz(c, id, { amount: 300, paidOn: day, key: k });

      expect(second.error).toBeNull();
      expect(second.data).toMatchObject({
        status: 'already_recorded',
        payment_id: (first.data as { payment_id: string }).payment_id,
        amount: 300,
        paid_on: day,
        voided: false,
      });
      expect(await wplaty(id)).toHaveLength(1);
      expect((await stanFaktury(id)).paid_amount).toBe(300);
    });

    it('dwa wysłania naraz z tym samym kluczem: jedna wpłata (blokada wiersza faktury)', async () => {
      const id = await faktura();
      const c = await signedIn('owner');
      const k = key();

      const results = await Promise.all([zapisz(c, id, { amount: 300, key: k }), zapisz(c, id, { amount: 300, key: k })]);

      expect(results.map((r) => r.error)).toEqual([null, null]);
      expect(results.map((r) => (r.data as { status: string }).status).sort()).toEqual(['already_recorded', 'recorded']);
      expect(await wplaty(id)).toHaveLength(1);
      await sumaZgodna(id);
    });

    it('ponowienie po cofnięciu nie wskrzesza wpłaty: klucz zostaje przy cofniętym wierszu', async () => {
      const id = await faktura();
      const c = await signedIn('owner');
      const k = key();
      const first = await zapisz(c, id, { amount: 300, key: k });
      await cofnij(c, (first.data as { payment_id: string }).payment_id);

      const retry = await zapisz(c, id, { amount: 300, key: k });

      expect(retry.data).toMatchObject({ status: 'already_recorded', voided: true });
      expect((await stanFaktury(id)).paid_amount).toBe(0);
      expect(await wplaty(id)).toHaveLength(1);
    });

    it('ten sam klucz z inną kwotą albo do innej faktury: odmowa „key_reused”, bez zapisu', async () => {
      const id = await faktura();
      const other = await faktura();
      const c = await signedIn('owner');
      const k = key();
      await zapisz(c, id, { amount: 300, key: k });

      expect((await zapisz(c, id, { amount: 301, key: k })).data).toMatchObject({ status: 'refused', code: 'key_reused' });
      expect((await zapisz(c, other, { amount: 300, key: k })).data).toMatchObject({ status: 'refused', code: 'key_reused' });
      expect(await wplaty(other)).toEqual([]);
      expect(await wplaty(id)).toHaveLength(1);
    });

    it('ten sam klucz w dwóch firmach to dwie różne wpłaty (klucz jest w obrębie firmy)', async () => {
      const a = await faktura();
      const b = await faktura({}, ORG_B);
      const k = key();

      expect((await zapisz(await signedIn('owner'), a, { amount: 100, key: k })).data).toMatchObject({ status: 'recorded' });
      expect((await zapisz(await signedIn('obcy', ORG_B), b, { amount: 100, key: k })).data).toMatchObject({ status: 'recorded' });
    });

    it('brak klucza: odmowa bez zapisu', async () => {
      const id = await faktura();
      const c = await signedIn('owner');

      expect((await zapisz(c, id, { key: null })).data).toMatchObject({ status: 'refused', code: 'invalid_request' });
      expect(await wplaty(id)).toEqual([]);
    });
  });

  describe('odmowy zapisu', () => {
    it.each([
      ['zero', 0],
      ['ujemna', -5],
      ['trzy miejsca po przecinku', 10.005],
      ['brak kwoty', null],
    ])('kwota %s: odmowa „invalid_amount” bez zapisu', async (_label, amount) => {
      const id = await faktura();
      const c = await signedIn('owner');

      const { data, error } = await zapisz(c, id, { amount });

      expect(error).toBeNull();
      expect(data).toMatchObject({ status: 'refused', code: 'invalid_amount' });
      expect(await wplaty(id)).toEqual([]);
    });

    it('waluta wpłaty inna niż PLN: odmowa bez zapisu', async () => {
      const id = await faktura();
      const c = await signedIn('owner');

      expect((await zapisz(c, id, { currency: 'EUR' })).data).toMatchObject({ status: 'refused', code: 'payment_currency' });
      expect((await zapisz(c, id, { currency: 'pln' })).data).toMatchObject({ status: 'recorded' });
    });

    it('faktura w walucie obcej: odmowa z kodem waluty, bez zapisu', async () => {
      const id = await faktura({ currency: 'EUR' });
      const c = await signedIn('owner');

      expect((await zapisz(c, id)).data).toMatchObject({ status: 'refused', code: 'invoice_currency', currency: 'EUR' });
      expect(await wplaty(id)).toEqual([]);
    });

    it('data z przyszłości i rok z literówki: odmowa bez zapisu', async () => {
      const id = await faktura();
      const c = await signedIn('owner');

      expect((await zapisz(c, id, { paidOn: shiftDays(warsawToday(), 1) })).data).toMatchObject({ status: 'refused', code: 'future_date' });
      expect((await zapisz(c, id, { paidOn: '0202-10-01' })).data).toMatchObject({ status: 'refused', code: 'invalid_date' });
      expect(await wplaty(id)).toEqual([]);
    });

    it('notatka ponad 500 znaków: odmowa; pusta notatka to brak notatki', async () => {
      const id = await faktura();
      const c = await signedIn('owner');

      expect((await zapisz(c, id, { note: 'x'.repeat(501) })).data).toMatchObject({ status: 'refused', code: 'note_too_long' });
      await zapisz(c, id, { note: '   ' });
      expect((await wplaty(id)).map((p) => p.notes)).toEqual([null]);
    });

    it('szkic i faktura zakupu: odmowa jak w mark_invoice_paid', async () => {
      const szkic = await faktura({ ksef_status: 'draft', ksef_environment: null, xml_storage_path: null, ksef_number: null });
      const zakup = await faktura({ direction: 'incoming', origin: 'ksef_inbox' });
      const c = await signedIn('owner');

      expect((await zapisz(c, szkic)).data).toMatchObject({ status: 'refused', code: 'not_accepted' });
      expect((await zapisz(c, zakup)).data).toMatchObject({ status: 'refused', code: 'not_sales' });
      expect(await wplaty(szkic)).toEqual([]);
      expect(await wplaty(zakup)).toEqual([]);
    });

    it('korekty: in plus ma własną resztę, in minus i korekta do zera nie mają na co zapisać wpłaty', async () => {
      const f1 = await faktura();
      const plus = await faktura({
        invoice_type: 'KOR', invoice_kind: 'correction', parent_invoice_id: f1,
        correction_reason: 'test', correction_type: 'before_after', gross_total: 123, net_total: 100, vat_total: 23,
      });
      const f2 = await faktura();
      const minus = await faktura({
        invoice_type: 'KOR', invoice_kind: 'correction', parent_invoice_id: f2,
        correction_reason: 'test', correction_type: 'before_after', gross_total: -123, net_total: -100, vat_total: -23,
      });
      const f3 = await faktura();
      await faktura({
        invoice_type: 'KOR', invoice_kind: 'correction', parent_invoice_id: f3,
        correction_reason: 'test', correction_type: 'before_after', gross_total: -1230, net_total: -1000, vat_total: -230,
      });
      const c = await signedIn('owner');

      expect((await zapisz(c, plus, { amount: 100 })).data).toMatchObject({ status: 'recorded', remaining: 23 });
      expect((await zapisz(c, minus, { amount: 1 })).data).toMatchObject({ status: 'refused', code: 'nothing_to_pay' });
      expect((await zapisz(c, f3, { amount: 1 })).data).toMatchObject({ status: 'refused', code: 'corrected_to_zero' });
      // Faktura pierwotna z korektą częściową: wpłata na jej resztę, korekta to osobny ruch.
      expect((await zapisz(c, f2, { amount: 1000 })).data).toMatchObject({ status: 'recorded' });
      expect(await wplaty(minus)).toEqual([]);
      expect(await wplaty(f3)).toEqual([]);
    });
  });

  describe('firmy, role i sesja', () => {
    it('obca firma: zapis i cofnięcie wyglądają jak brak faktury i wpłaty, nic się nie zmienia', async () => {
      const id = await faktura();
      const owner = await signedIn('owner');
      const recorded = await zapisz(owner, id, { amount: 300 });
      const paymentId = (recorded.data as { payment_id: string }).payment_id;
      const obcy = await signedIn('obcy', ORG_B);

      expect((await zapisz(obcy, id)).data).toMatchObject({ status: 'refused', code: 'not_found' });
      expect((await cofnij(obcy, paymentId)).data).toMatchObject({ status: 'refused', code: 'not_found' });
      expect(await historia(obcy, id)).toEqual([]);
      expect((await wplaty(id)).map((p) => [p.amount, p.voided_at])).toEqual([[300, null]]);
      await sumaZgodna(id);
    });

    it('nagłówek obcej firmy bez członkostwa: odmowa 42501', async () => {
      const id = await faktura();
      const c = await signedIn('obcy', ORG_A);

      expect((await zapisz(c, id)).error?.code).toBe('42501');
      expect(await wplaty(id)).toEqual([]);
    });

    it('księgowa widzi historię, ale nie zapisuje i nie cofa: 42501', async () => {
      const id = await faktura();
      const owner = await signedIn('owner');
      const recorded = await zapisz(owner, id, { amount: 300 });
      const ksiegowa = await signedIn('accountant');

      expect((await zapisz(ksiegowa, id)).error?.code).toBe('42501');
      expect((await cofnij(ksiegowa, (recorded.data as { payment_id: string }).payment_id)).error?.code).toBe('42501');
      expect((await historia(ksiegowa, id)).map((p) => Number(p.amount))).toEqual([300]);
      expect((await wplaty(id)).map((p) => p.voided_at)).toEqual([null]);
    });

    it('członek firmy zapisuje i cofa', async () => {
      const id = await faktura();
      const c = await signedIn('member');

      const recorded = await zapisz(c, id, { amount: 300 });
      expect(recorded.data).toMatchObject({ status: 'recorded' });
      expect((await cofnij(c, (recorded.data as { payment_id: string }).payment_id)).data).toMatchObject({ status: 'voided' });
      expect((await wplaty(id))[0]).toMatchObject({ created_by: users.member, voided_by: users.member });
    });

    it('anon nie woła żadnej z funkcji', async () => {
      const id = await faktura();
      const anon = anonClient();

      expect((await zapisz(anon, id)).error?.code).toBe('42501');
      expect((await anon.rpc('void_invoice_payment', { p_payment_id: id })).error?.code).toBe('42501');
      expect((await anon.rpc('invoice_payments', { p_invoice_id: id })).error?.code).toBe('42501');
    });

    it('sesja dalej nie zapisuje, nie zmienia i nie czyta payments wprost (00074)', async () => {
      const id = await faktura();
      const c = await signedIn('owner');
      const recorded = await zapisz(c, id, { amount: 300 });
      const paymentId = (recorded.data as { payment_id: string }).payment_id;

      expect((await c.from('payments').insert({ tenant_id: ORG_A, invoice_id: id, amount: 1, payment_date: warsawToday() })).error?.code).toBe('42501');
      expect((await c.from('payments').update({ voided_at: null }).eq('id', paymentId)).error?.code).toBe('42501');
      expect((await c.from('payments').select('id').eq('id', paymentId)).error?.code).toBe('42501');
    });
  });

  describe('cofnięcie wpłaty', () => {
    it('wiersz zostaje oznaczony jako cofnięty (ślad), suma i stan przeliczone: termin minął → overdue', async () => {
      const id = await faktura();
      const c = await signedIn('owner');
      const recorded = await zapisz(c, id, { amount: 300 });
      const paymentId = (recorded.data as { payment_id: string }).payment_id;

      const { data, error } = await cofnij(c, paymentId);

      expect(error).toBeNull();
      expect(data).toMatchObject({ status: 'voided', mode: 'voided', payment_id: paymentId, invoice_id: id, amount: 300, remaining: 1230 });
      const [row] = await wplaty(id);
      expect(row).toMatchObject({ id: paymentId, amount: 300, voided_by: users.owner });
      expect(row!.voided_at).not.toBeNull();
      expect(await stanFaktury(id)).toEqual({ paid_amount: 0, paid_at: null, payment_status: 'overdue' });
      await sumaZgodna(id);
    });

    it('cofnięcie jednej z dwóch wpłat zapłaconej faktury: wraca „partial” bez paid_at', async () => {
      const id = await faktura();
      const c = await signedIn('owner');
      const first = await zapisz(c, id, { amount: 300 });
      await zapisz(c, id, { amount: 930 });

      await cofnij(c, (first.data as { payment_id: string }).payment_id);

      expect(await stanFaktury(id)).toEqual({ paid_amount: 930, paid_at: null, payment_status: 'partial' });
      await sumaZgodna(id);
    });

    it('drugie cofnięcie: „already_voided” bez zmian i bez drugiego wpisu audytu', async () => {
      const id = await faktura();
      const c = await signedIn('owner');
      const recorded = await zapisz(c, id, { amount: 300 });
      const paymentId = (recorded.data as { payment_id: string }).payment_id;
      await cofnij(c, paymentId);

      const wpisy = await nowyAudyt(id, async () => {
        expect((await cofnij(c, paymentId)).data).toMatchObject({ status: 'already_voided', payment_id: paymentId });
      });

      expect(wpisy).toEqual([]);
    });

    it('cofnięta wpłata jest tylko do odczytu, nawet dla klucza serwisowego', async () => {
      const id = await faktura();
      const c = await signedIn('owner');
      const recorded = await zapisz(c, id, { amount: 300 });
      const paymentId = (recorded.data as { payment_id: string }).payment_id;
      await cofnij(c, paymentId);

      expect((await admin.from('payments').update({ voided_at: null, voided_by: null }).eq('id', paymentId)).error).not.toBeNull();
      expect((await admin.from('payments').update({ amount: 1 }).eq('id', paymentId)).error).not.toBeNull();
      expect(await stanFaktury(id)).toMatchObject({ paid_amount: 0 });
    });

    it('wpłata cofnięta nie liczy się do paid_amount, nawet wstawiona kluczem serwisowym', async () => {
      const id = await faktura();
      const insert = await admin.from('payments').insert({
        tenant_id: ORG_A, invoice_id: id, amount: 500, payment_date: '2026-10-05',
        is_confirmed: true, match_method: 'manual_entry', voided_at: new Date().toISOString(),
      });
      if (insert.error) throw insert.error;

      expect(await stanFaktury(id)).toMatchObject({ paid_amount: 0, payment_status: 'overdue' });
      await sumaZgodna(id);
    });

    it('wpłata z „Zapłacone” cofa się drogą mark_invoice_paid: usunięta, z wpisem invoice.paid_undone', async () => {
      const id = await faktura();
      const c = await signedIn('owner');
      const marked = await c.rpc('mark_invoice_paid', { p_invoice_id: id });
      const paymentId = (marked.data as { payment_id: string }).payment_id;

      const wpisy = await nowyAudyt(id, async () => {
        expect((await cofnij(c, paymentId)).data).toMatchObject({ status: 'voided', mode: 'undo_paid', amount: 1230 });
      });

      expect(wpisy.map((w) => w.action)).toEqual(['invoice.paid_undone']);
      expect(await wplaty(id)).toEqual([]);
      expect(await stanFaktury(id)).toEqual({ paid_amount: 0, paid_at: null, payment_status: 'overdue' });
    });

    it('wpłata przed „Zapłacone”: odmowa „manual_first” z dniem i kwotą oznaczenia; po cofnięciu oznaczenia przechodzi', async () => {
      const id = await faktura();
      const c = await signedIn('owner');
      const partial = await zapisz(c, id, { amount: 300 });
      const paymentId = (partial.data as { payment_id: string }).payment_id;
      const day = shiftDays(warsawToday(), -1);
      await c.rpc('mark_invoice_paid', { p_invoice_id: id, p_paid_on: day });

      expect((await cofnij(c, paymentId)).data).toMatchObject({
        status: 'refused', code: 'manual_first', manual_paid_on: day, manual_amount: 930,
      });
      expect((await wplaty(id)).every((p) => p.voided_at === null)).toBe(true);

      await c.rpc('undo_invoice_paid', { p_invoice_id: id });
      expect((await cofnij(c, paymentId)).data).toMatchObject({ status: 'voided' });
      expect(await stanFaktury(id)).toMatchObject({ paid_amount: 0, payment_status: 'overdue' });
    });

    it.each(['bank_import'])('wpłata %s: odmowa „not_voidable”, wiersz bez zmian', async (method) => {
      const id = await faktura();
      const bank = await admin.from('payments').insert({
        tenant_id: ORG_A, invoice_id: id, amount: 300, payment_date: '2026-10-05', is_confirmed: true, match_method: method,
      }).select('id').single();
      if (bank.error) throw bank.error;
      const c = await signedIn('owner');

      expect((await cofnij(c, bank.data.id as string)).data).toMatchObject({ status: 'refused', code: 'not_voidable' });
      expect((await wplaty(id))[0]?.voided_at).toBeNull();
    });

    it('wpłatę z karty FLO cofa się tak samo jak wpisaną ręcznie (oznaczenie, nie usunięcie)', async () => {
      const id = await faktura();
      const flo = await admin.from('payments').insert({
        tenant_id: ORG_A, invoice_id: id, amount: 300, payment_date: '2026-10-05', is_confirmed: true, match_method: 'flo_confirmation',
      }).select('id').single();
      if (flo.error) throw flo.error;
      const c = await signedIn('owner');

      expect((await cofnij(c, flo.data.id as string)).data).toMatchObject({ status: 'voided', mode: 'voided' });
      expect((await wplaty(id))[0]?.voided_at).not.toBeNull();
      await sumaZgodna(id);
    });
  });

  describe('audyt w tej samej transakcji co wpłata', () => {
    it('zapis i cofnięcie: wpisy z firmą i użytkownikiem z sesji, kwotą, dniem i wpłatą', async () => {
      const id = await faktura();
      const c = await signedIn('member');
      const day = shiftDays(warsawToday(), -2);
      let paymentId = '';

      const zapisane = await nowyAudyt(id, async () => {
        const { data } = await zapisz(c, id, { amount: 300, paidOn: day, note: 'zaliczka' });
        paymentId = (data as { payment_id: string }).payment_id;
      });
      expect(zapisane).toEqual([{
        tenant_id: ORG_A,
        user_id: users.member,
        action: 'invoice.payment_recorded',
        entity_type: 'invoice',
        entity_id: id,
        metadata: {
          paymentId, amount: 300, paidOn: day, hasNote: true, remaining: 930, paymentStatus: 'partial', remindersCancelled: 0,
        },
      }]);

      const cofniete = await nowyAudyt(id, () => cofnij(c, paymentId));
      expect(cofniete).toEqual([{
        tenant_id: ORG_A,
        user_id: users.member,
        action: 'invoice.payment_voided',
        entity_type: 'invoice',
        entity_id: id,
        metadata: {
          paymentId, amount: 300, paidOn: day, source: 'manual_entry', remaining: 1230, paymentStatus: 'overdue', remindersRestored: 0,
        },
      }]);
    });

    it('bez zmiany nie ma wpisu: odmowa, ponowienie z tym samym kluczem, brak uprawnień', async () => {
      const id = await faktura();
      const c = await signedIn('owner');
      const ksiegowa = await signedIn('accountant');
      const k = key();
      await zapisz(c, id, { amount: 300, key: k });

      const wpisy = await nowyAudyt(id, async () => {
        await zapisz(c, id, { amount: 300, key: k });
        await zapisz(c, id, { amount: 5000 });
        await zapisz(c, id, { amount: 0 });
        await zapisz(ksiegowa, id, { amount: 10 });
      });

      expect(wpisy).toEqual([]);
    });
  });

  describe('historia wpłat (invoice_payments)', () => {
    it('kolejność po dniu wpłaty, cofnięte z datą cofnięcia, notatka tylko przy wpłatach wpisanych ręcznie', async () => {
      const id = await faktura();
      const c = await signedIn('owner');
      const d1 = shiftDays(warsawToday(), -6);
      const d2 = shiftDays(warsawToday(), -3);
      const later = await zapisz(c, id, { amount: 200, paidOn: d2, note: 'druga rata' });
      const earlier = await zapisz(c, id, { amount: 100, paidOn: d1 });
      await cofnij(c, (earlier.data as { payment_id: string }).payment_id);
      await c.rpc('mark_invoice_paid', { p_invoice_id: id });

      const rows = await historia(c, id);

      expect(rows.map((p) => [p.paid_on, Number(p.amount), p.source, p.note, p.voided_at !== null])).toEqual([
        [d1, 100, 'manual_entry', null, true],
        [d2, 200, 'manual_entry', 'druga rata', false],
        [warsawToday(), 1030, 'manual', null, false],
      ]);
      expect(rows[1]).toMatchObject({ id: (later.data as { payment_id: string }).payment_id });
      expect(Object.keys(rows[0]!).sort()).toEqual(['amount', 'id', 'note', 'paid_on', 'recorded_at', 'source', 'voided_at']);
      await sumaZgodna(id);
    });

    it('niepotwierdzone dopasowanie z banku nie jest wpłatą: nie ma go w historii ani w sumie', async () => {
      const id = await faktura();
      const insert = await admin.from('payments').insert({
        tenant_id: ORG_A, invoice_id: id, amount: 300, payment_date: '2026-10-05',
        is_auto_matched: true, is_confirmed: false, match_method: 'bank_import',
      });
      if (insert.error) throw insert.error;
      const c = await signedIn('owner');

      expect(await historia(c, id)).toEqual([]);
      expect((await stanFaktury(id)).paid_amount).toBe(0);
    });
  });

  describe('należności i przypomnienia', () => {
    it('widok invoices_overdue: wpłata częściowa zmniejsza kwotę, cofnięcie ją przywraca', async () => {
      const id = await faktura();
      const c = await signedIn('owner');
      const kwota = async () => Number((await c.from('invoices_overdue').select('amount_due').eq('id', id).single()).data?.amount_due);
      expect(await kwota()).toBe(1230);

      const recorded = await zapisz(c, id, { amount: 300 });
      expect(await kwota()).toBe(930);

      await cofnij(c, (recorded.data as { payment_id: string }).payment_id);
      expect(await kwota()).toBe(1230);
    });

    it('wpłata, która zamyka fakturę, anuluje oczekujące przypomnienia; wpłata częściowa ich nie rusza', async () => {
      const id = await faktura();
      const pending = await admin.from('payment_reminders').insert({
        tenant_id: ORG_A, invoice_id: id, stage: 'stage_1', channel: 'email', scheduled_for: new Date().toISOString(), status: 'pending',
      }).select('id').single();
      if (pending.error) throw pending.error;
      const c = await signedIn('owner');

      expect((await zapisz(c, id, { amount: 300 })).data).toMatchObject({ reminders_cancelled: 0 });
      expect((await admin.from('payment_reminders').select('status').eq('id', pending.data.id).single()).data).toEqual({ status: 'pending' });

      expect((await zapisz(c, id, { amount: 930 })).data).toMatchObject({ payment_status: 'paid', reminders_cancelled: 1 });
      expect((await admin.from('payment_reminders').select('status, failure_reason').eq('id', pending.data.id).single()).data)
        .toEqual({ status: 'cancelled', failure_reason: MARKER });
    });

    it('cofnięcie wpłaty, po której faktura nie jest już zapłacona, zwalnia etap anulowany zapłatą', async () => {
      const id = await faktura();
      const pending = await admin.from('payment_reminders').insert({
        tenant_id: ORG_A, invoice_id: id, stage: 'stage_2', channel: 'email', scheduled_for: new Date().toISOString(), status: 'pending',
      }).select('id').single();
      if (pending.error) throw pending.error;
      const c = await signedIn('owner');
      const recorded = await zapisz(c, id, { amount: 1230 });

      const { data } = await cofnij(c, (recorded.data as { payment_id: string }).payment_id);

      expect(data).toMatchObject({ status: 'voided', reminders_restored: 1 });
      expect((await admin.from('payment_reminders').select('id').eq('invoice_id', id)).data).toEqual([]);
      expect((await stanFaktury(id)).payment_status).toBe('overdue');
    });
  });
});

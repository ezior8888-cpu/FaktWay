import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { getRlsTestEnvironment } from './helpers/rls-environment';

/**
 * Przelewy do dostawców z wyciągu jako zapłaty kosztów z listy „Do zapłaty”
 * (plan kompletnej aplikacji, krok 3.2, część 3, migracja 00196) na prawdziwym
 * Postgresie i PostgREST: `confirm_bank_expense_payment`,
 * `skip_bank_expense_operation`, `undo_bank_expense_payment`,
 * `bank_known_operations`, `bank_expense_operations` i zastąpione
 * `skip_bank_operation` razem z `mark_expense_paid` / `undo_expense_paid`
 * (00177) i CHECK-ami `payment_imports`.
 *
 * Niezmienniki:
 *  - wypływ trafia do bazy dopiero po decyzji klienta: jako dowód zapłaty
 *    kosztów albo, po „Pomiń”, bez danych osób trzecich (CHECK, także dla
 *    klucza serwisowego);
 *  - potwierdzenie oznacza koszty jako zapłacone z dniem księgowania, raz
 *    (ponowienie bez drugiego wpisu), tylko przy rachunku z faktury i kwocie
 *    równej sumie do zapłaty, tylko w złotych;
 *  - zapłatę potwierdza owner, admin albo member swojej firmy; księgowa czyta;
 *  - cofnięcie oddaje kosztom stan sprzed potwierdzenia (chyba że ktoś zmienił
 *    je w międzyczasie) i usuwa operację z bazy.
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

const ORG_A = '00196196-0000-4000-8000-00000000000a';
const ORG_B = '00196196-0000-4000-8000-00000000000b';
const EMAILS = {
  owner: 'rls-wyciag-koszty-owner@ksef-saas.test',
  member: 'rls-wyciag-koszty-member@ksef-saas.test',
  accountant: 'rls-wyciag-koszty-ksiegowa@ksef-saas.test',
  obcy: 'rls-wyciag-koszty-obcy@ksef-saas.test',
} as const;
const PASS = 'RlsWyciagKoszty2026Aa!';
const NIP = '1234567890';
const RACHUNEK = 'PL61109010140000071219812874';
// Rachunek dostawcy: w banku z „PL”, na fakturze (payment_account) bez „PL”.
const DOSTAWCA = 'PL27114020040000300201355387';
const DOSTAWCA_NA_FAKTURZE = '27114020040000300201355387';
const INNY = 'PL49101010100160562221000000';

const users: Record<keyof typeof EMAILS, string> = { owner: '', member: '', accountant: '', obcy: '' };
let counter = 0;
let keyCounter = 0;

function warsawToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw' }).format(new Date());
}

function shiftDays(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const DZIEN = shiftDays(warsawToday(), -3);

function opKey(): string {
  keyCounter += 1;
  return `v1:${String(keyCounter).padStart(8, '0')}${'ef'.repeat(28)}`;
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

/** Losowy identyfikator: wpisy audytu zostają po przebiegu (00052), więc koszty nie mogą powtarzać id między przebiegami. */
function nextId(): string {
  counter += 1;
  return crypto.randomUUID();
}

/** Koszt z listy „Do zapłaty” (bez faktury KSeF, jak w teście 00177), 1230 zł, rachunek dostawcy. Wszystkie kolumny NOT NULL. */
async function koszt(fields: Record<string, unknown> = {}, org: string = ORG_A): Promise<string> {
  const id = nextId();
  const { error } = await admin.from('expenses').insert({
    id,
    tenant_id: org,
    created_by: org === ORG_A ? users.owner : users.obcy,
    source: 'manual',
    seller_name: `Dostawca ${counter}`,
    seller_nip: NIP,
    document_number: `FV/196/${counter}`,
    document_type: 'invoice',
    issue_date: shiftDays(warsawToday(), -20),
    net_amount: 1000,
    vat_amount: 230,
    gross_amount: 1230,
    payment_due_date: shiftDays(warsawToday(), 10),
    payment_account: DOSTAWCA_NA_FAKTURZE,
    payment_split: false,
    payment_terms: { zrodlo: 'ksef_xml', odczytano: new Date().toISOString(), problemy: [] },
    ...fields,
  });
  if (error) throw new Error(`insert koszt ${counter}: ${error.message}`);
  return id;
}

/** Koszt z faktury KSeF w euro (wzór z rls-faktura-do-paragonu i rls-api-klucze). */
async function kosztWEuro(): Promise<string> {
  const invoiceId = nextId();
  const number = `EUR/196/${counter}`;
  const invoice = await admin.from('invoices').insert({
    id: invoiceId, tenant_id: ORG_A, direction: 'incoming', origin: 'ksef_inbox', internal_number: number,
    invoice_type: 'VAT', invoice_kind: 'regular', issue_date: shiftDays(warsawToday(), -20), seller_nip: NIP, buyer_nip: NIP,
    gross_total: 1230, net_total: 1000, vat_total: 230, currency: 'EUR', ksef_status: 'received', ksef_environment: 'test',
    ksef_number: `${NIP}-20261101-${String(counter).padStart(12, '0')}-00`, xml_storage_path: 'x.xml',
    fa3_data: { _source: 'inbox-metadata', _pendingFullFetch: false },
  });
  if (invoice.error) throw new Error(`faktura ${number}: ${invoice.error.message}`);
  return koszt({ source: 'ksef_inbox', ksef_invoice_id: invoiceId, document_number: number });
}

async function stan(id: string) {
  const { data, error } = await admin.from('expenses').select('paid_at').eq('id', id).single();
  if (error) throw error;
  return data as { paid_at: string | null };
}

interface Operacja {
  key: string;
  account: string;
  booking_date: string;
  amount: string;
  currency: string;
  counterparty_name: string | null;
  counterparty_account: string | null;
  title: string | null;
  reference: string | null;
}

function przelew(over: Partial<Operacja> = {}): Operacja {
  return {
    key: opKey(),
    account: RACHUNEK,
    booking_date: DZIEN,
    amount: '-1230.00',
    currency: 'PLN',
    counterparty_name: 'Dostawca Testowy',
    counterparty_account: DOSTAWCA,
    title: 'Zaplata FV/196',
    reference: 'REF-196',
    ...over,
  };
}

const potwierdz = (c: SupabaseClient, op: Operacja, ids: string[], kind = 'manual') =>
  c.rpc('confirm_bank_expense_payment', { p_file_format: 'camt053', p_operation: op, p_expense_ids: ids, p_match_kind: kind });
const pomin = (c: SupabaseClient, op: Partial<Operacja>) =>
  c.rpc('skip_bank_expense_operation', { p_file_format: 'camt053', p_operation: op });
const cofnij = (c: SupabaseClient, operationId: string) => c.rpc('undo_bank_expense_payment', { p_operation_id: operationId });

async function wiersze(key?: string) {
  let q = admin
    .from('payment_imports')
    .select('id, transaction_id, amount, tax_kind, expense_ids, is_matched, ignored, decided_at, decided_by, redacted_at, title, counterparty_name, counterparty_account, counterparty_nip, reference, booking_date')
    .eq('tenant_id', ORG_A);
  if (key) q = q.eq('transaction_id', key);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []).map((row) => ({ ...row, amount: Number(row.amount) }));
}

async function audyt(actions: string[], entityId?: string) {
  let q = admin
    .from('audit_logs')
    .select('tenant_id, user_id, action, entity_type, entity_id, metadata')
    .eq('tenant_id', ORG_A)
    .in('action', actions)
    .order('created_at', { ascending: true });
  if (entityId) q = q.eq('entity_id', entityId);
  const { data, error } = await q;
  if (error) throw error;
  return data ?? [];
}

async function cleanup() {
  for (const org of [ORG_A, ORG_B]) {
    await admin.from('payment_imports').delete().eq('tenant_id', org);
    await admin.from('expenses').delete().eq('tenant_id', org);
    await admin.from('invoices').delete().eq('tenant_id', org);
  }
}

describe.skipIf(!hasDatabase)('Przelewy do dostawców z wyciągu jako zapłaty kosztów (00196)', () => {
  beforeAll(async () => {
    for (const who of Object.keys(EMAILS) as Array<keyof typeof EMAILS>) {
      users[who] = await userId(EMAILS[who]);
    }
    await cleanup();
    await admin.from('memberships').delete().in('organization_id', [ORG_A, ORG_B]);
    // Wpisy audytu zostają po przebiegu (00052), więc firma też: upsert zamiast kasowania.
    const tenants = await admin.from('tenants').upsert([
      { id: ORG_A, nip: NIP, name: 'Firma A Wyciąg Koszty' },
      { id: ORG_B, nip: NIP, name: 'Firma B Wyciąg Koszty' },
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
  });

  describe('potwierdzenie', () => {
    it('koszt zapłacony z dniem księgowania tą samą drogą co „Oznacz jako zapłacone”; przelew zostaje jako dowód; audyt bez danych drugiej strony', async () => {
      const id = await koszt();
      const owner = await signedIn('owner');
      const op = przelew({ title: 'FV/196 KSEF' });

      const { data, error } = await potwierdz(owner, op, [id], 'invoice_number');

      expect(error).toBeNull();
      expect(data).toMatchObject({ status: 'confirmed', expense_ids: [id], paid_on: DZIEN, amount_gr: 123000, match_kind: 'invoice_number' });
      expect(data.documents).toEqual([expect.objectContaining({ id, document_number: expect.stringMatching(/^FV\/196\//) })]);
      expect(await stan(id)).toEqual({ paid_at: DZIEN });
      const rows = await wiersze(op.key);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        amount: -1230, tax_kind: null, expense_ids: [id], is_matched: true, ignored: false, decided_by: users.owner,
        redacted_at: null, title: 'FV/196 KSEF', counterparty_account: DOSTAWCA, booking_date: DZIEN,
      });

      const oznaczenie = await audyt(['expense.marked_paid'], id);
      expect(oznaczenie).toHaveLength(1);
      expect(oznaczenie[0]).toMatchObject({ user_id: users.owner, metadata: expect.objectContaining({ paidOn: DZIEN, amount: 1230 }) });
      const bank = await audyt(['bank.expense_payment_confirmed'], rows[0]!.id);
      expect(bank).toHaveLength(1);
      expect(bank[0]).toMatchObject({ entity_type: 'bank_operation', metadata: expect.objectContaining({ expenseIds: [id], amountGr: 123000, paidOn: DZIEN }) });
      const tekst = JSON.stringify(bank[0]!.metadata);
      for (const secret of ['Dostawca Testowy', DOSTAWCA, 'FV/196 KSEF', 'REF-196']) expect(tekst).not.toContain(secret);
    });

    it('ponowienie: „już zapisane” bez drugiego wiersza i drugiego wpisu audytu; inny wybór kosztów dla tego przelewu to odmowa', async () => {
      const id = await koszt();
      const drugi = await koszt();
      const owner = await signedIn('owner');
      const op = przelew();

      await potwierdz(owner, op, [id]);
      const again = await potwierdz(owner, op, [id]);
      const inny = await potwierdz(owner, op, [drugi]);

      expect(again.data).toMatchObject({ status: 'already_confirmed', expense_ids: [id], paid_on: DZIEN });
      expect(inny.data).toMatchObject({ status: 'refused', code: 'operation_confirmed' });
      expect(await wiersze(op.key)).toHaveLength(1);
      expect(await audyt(['expense.marked_paid'], id)).toHaveLength(1);
      expect(await stan(drugi)).toEqual({ paid_at: null });
    });

    it('dwa potwierdzenia naraz: jeden wiersz, jedna zapłata', async () => {
      const id = await koszt();
      const owner = await signedIn('owner');
      const op = przelew();

      const results = await Promise.all([potwierdz(owner, op, [id]), potwierdz(owner, op, [id])]);

      expect(results.map((r) => r.data?.status).sort()).toEqual(['already_confirmed', 'confirmed']);
      expect(await wiersze(op.key)).toHaveLength(1);
      expect(await audyt(['expense.marked_paid'], id)).toHaveLength(1);
    });

    it('identyfikator zbiorczy: kilka kosztów jednego dostawcy, suma kwot do zapłaty (z wpłatą częściową z faktury)', async () => {
      const a = await koszt();
      const b = await koszt({ payment_terms: { zrodlo: 'ksef_xml', odczytano: new Date().toISOString(), problemy: [], zaplaconoCzesciowo: 230 } });
      const owner = await signedIn('owner');

      expect((await potwierdz(owner, przelew({ amount: '-2460.00' }), [a, b])).data).toMatchObject({ status: 'refused', code: 'amount_mismatch', due_gr: 223000, amount_gr: 246000 });
      const op = przelew({ amount: '-2230.00' });
      const { data } = await potwierdz(owner, op, [b, a], 'collective_identifier');

      expect(data).toMatchObject({ status: 'confirmed', expense_ids: [a, b].sort() });
      expect(await stan(a)).toEqual({ paid_at: DZIEN });
      expect(await stan(b)).toEqual({ paid_at: DZIEN });
      expect((await wiersze(op.key))[0]?.expense_ids).toEqual([a, b].sort());
    });

    it('granice: inny rachunek, inna kwota, waluta obca, koszt zapłacony, dzień z przyszłości; nic nie zostaje w bazie', async () => {
      const id = await koszt();
      const zaplacony = await koszt({ paid_at: shiftDays(warsawToday(), -1) });
      const euro = await kosztWEuro();
      const owner = await signedIn('owner');

      for (const [op, ids, code] of [
        [przelew({ counterparty_account: INNY }), [id], 'account_mismatch'],
        [przelew({ counterparty_account: null }), [id], 'not_expense_payment'],
        [przelew({ amount: '-1229.99' }), [id], 'amount_mismatch'],
        [przelew({ amount: '-1230.01' }), [id], 'amount_mismatch'],
        [przelew({ currency: 'EUR' }), [id], 'invalid_operation'],
        [przelew(), [euro], 'expense_currency'],
        [przelew(), [zaplacony], 'expense_paid'],
        [przelew({ booking_date: shiftDays(warsawToday(), 1) }), [id], 'payment_in_future'],
        [przelew({ amount: '1230.00' }), [id], 'invalid_operation'],
        [przelew({ amount: '-1230.005' }), [id], 'invalid_operation'],
        [przelew(), ['00196196-9999-4000-8000-000000000999'], 'expense_not_found'],
      ] as const) {
        const { data } = await potwierdz(owner, op as Operacja, [...ids]);
        expect(data, JSON.stringify(op)).toMatchObject({ status: 'refused', code });
      }
      expect(await potwierdz(owner, przelew(), [id], 'title').then((r) => r.data)).toMatchObject({ status: 'refused', code: 'invalid_request' });
      expect(await potwierdz(owner, przelew(), [id, id]).then((r) => r.data)).toMatchObject({ status: 'refused', code: 'invalid_request' });
      expect(await wiersze()).toEqual([]);
      expect(await stan(id)).toEqual({ paid_at: null });
      expect(await audyt(['expense.marked_paid'], id)).toEqual([]);
    });

    it('role i firmy: member potwierdza, księgowa i anon nie; obca firma nie widzi kosztu; nagłówek bez członkostwa to odmowa', async () => {
      const id = await koszt();
      const member = await signedIn('member');
      expect((await potwierdz(member, przelew(), [id])).data).toMatchObject({ status: 'confirmed' });

      const drugi = await koszt();
      expect((await potwierdz(await signedIn('accountant'), przelew(), [drugi])).error?.code).toBe('42501');
      expect((await potwierdz(anonClient(ORG_A), przelew(), [drugi])).error).not.toBeNull();
      expect((await potwierdz(await signedIn('obcy', ORG_B), przelew(), [drugi])).data).toMatchObject({ status: 'refused', code: 'expense_not_found' });
      expect((await potwierdz(await signedIn('obcy', ORG_A), przelew(), [drugi])).error?.code).toBe('42501');
      expect(await stan(drugi)).toEqual({ paid_at: null });
    });
  });

  describe('RODO', () => {
    it('„Pomiń”: znacznik od razu bez tytułu, nazwy, rachunku, NIP i referencji; drugi raz bez zmian; potem nie da się potwierdzić', async () => {
      const id = await koszt();
      const owner = await signedIn('owner');
      const op = przelew();

      const { data, error } = await pomin(owner, op);

      expect(error).toBeNull();
      expect(data).toMatchObject({ status: 'skipped' });
      const rows = await wiersze(op.key);
      expect(rows).toEqual([
        expect.objectContaining({
          amount: -1230, ignored: true, is_matched: false, expense_ids: null, title: null, counterparty_name: null,
          counterparty_account: null, counterparty_nip: null, reference: null, redacted_at: expect.any(String), decided_by: users.owner,
        }),
      ]);
      expect((await pomin(owner, op)).data).toMatchObject({ status: 'already_skipped' });
      expect((await potwierdz(owner, op, [id])).data).toMatchObject({ status: 'refused', code: 'operation_skipped' });
      expect(await stan(id)).toEqual({ paid_at: null });
      const wpis = await audyt(['bank.operation_skipped'], rows[0]!.id);
      expect(wpis).toHaveLength(1);
      expect(JSON.stringify(wpis[0]!.metadata)).not.toContain('Dostawca Testowy');
    });

    it('„Pomiń” przelewu, który nie trafia w rachunek żadnego kosztu firmy, nie zostawia nawet znacznika', async () => {
      await koszt();
      const owner = await signedIn('owner');
      expect((await pomin(owner, przelew({ counterparty_account: INNY }))).data).toMatchObject({ status: 'refused', code: 'not_expense_payment' });
      expect(await wiersze()).toEqual([]);
    });

    it('baza nie przyjmie niepotwierdzonego wypływu do dostawcy ani pominiętego z danymi, nawet kluczem serwisowym', async () => {
      const base = {
        tenant_id: ORG_A, provider: 'bank_file', account_iban: RACHUNEK, account_currency: 'PLN', transaction_date: DZIEN, booking_date: DZIEN,
        amount: -1230, currency: 'PLN', counterparty_name: 'Dostawca Testowy', counterparty_account: DOSTAWCA, title: 'FV/196', reference: 'REF',
        file_format: 'camt053', import_batch_id: '00196196-3333-4000-8000-000000000001', is_matched: false, ignored: false,
      };
      // 23514: CHECK payment_imports_bank_file_direction_check (wszystkie kolumny NOT NULL są podane, więc odmowa jest z tego CHECK-a).
      expect((await admin.from('payment_imports').insert({ ...base, transaction_id: opKey() })).error?.code).toBe('23514');
      expect((await admin.from('payment_imports').insert({ ...base, transaction_id: opKey(), ignored: true, decided_at: new Date().toISOString() })).error?.code).toBe('23514');
      expect(await wiersze()).toEqual([]);
    });

    it('połączenia z kosztami nie zmieni nawet klucz serwisowy; „Pomiń” potwierdzonej zapłaty to odmowa z wyjściem', async () => {
      const id = await koszt();
      const inny = await koszt();
      const owner = await signedIn('owner');
      const op = przelew();
      await potwierdz(owner, op, [id]);
      const opId = (await wiersze(op.key))[0]!.id as string;

      expect((await admin.from('payment_imports').update({ expense_ids: [inny] }).eq('id', opId)).error?.code).toBe('42501');
      expect((await owner.rpc('skip_bank_operation', { p_operation_id: opId })).data).toMatchObject({ status: 'refused', code: 'expense_payment_confirmed' });
      expect((await pomin(owner, op)).data).toMatchObject({ status: 'refused', code: 'operation_confirmed' });
      expect((await wiersze(op.key))[0]).toMatchObject({ expense_ids: [id], ignored: false, title: op.title });
    });
  });

  describe('cofnięcie', () => {
    it('koszt wraca do „Do zapłaty” przez undo_expense_paid, operacja znika z bazy; drugie cofnięcie nic nie zmienia; potem można potwierdzić jeszcze raz', async () => {
      const id = await koszt();
      const owner = await signedIn('owner');
      const op = przelew();
      await potwierdz(owner, op, [id]);
      const opId = (await wiersze(op.key))[0]!.id as string;

      const { data, error } = await cofnij(owner, opId);

      expect(error).toBeNull();
      expect(data).toMatchObject({ status: 'undone', reverted: 1, kept: 0, expense_ids: [id] });
      expect(await stan(id)).toEqual({ paid_at: null });
      expect(await wiersze()).toEqual([]);
      expect(await audyt(['expense.paid_undone'], id)).toHaveLength(1);
      const wpis = await audyt(['bank.expense_payment_undone'], opId);
      expect(wpis).toHaveLength(1);
      expect(wpis[0]!.metadata).toMatchObject({ expenseIds: [id], revertedIds: [id], keptIds: [] });
      expect(JSON.stringify(wpis[0]!.metadata)).not.toContain('Dostawca Testowy');

      expect((await cofnij(owner, opId)).data).toMatchObject({ status: 'refused', code: 'operation_not_found' });
      expect((await potwierdz(owner, op, [id])).data).toMatchObject({ status: 'confirmed' });
      expect(await stan(id)).toEqual({ paid_at: DZIEN });
    });

    it('koszt zmieniony po potwierdzeniu zostaje bez zmian; księgowa i obca firma nie cofają', async () => {
      const id = await koszt();
      const owner = await signedIn('owner');
      const op = przelew();
      await potwierdz(owner, op, [id]);
      const opId = (await wiersze(op.key))[0]!.id as string;
      const inny = shiftDays(warsawToday(), -1);
      // Zmiana dnia zapłaty po potwierdzeniu (np. cofnięcie i ponowne oznaczenie w Wydatkach).
      expect((await admin.from('expenses').update({ paid_at: inny }).eq('id', id)).error).toBeNull();

      expect((await cofnij(await signedIn('accountant'), opId)).error?.code).toBe('42501');
      expect((await cofnij(await signedIn('obcy', ORG_B), opId)).data).toMatchObject({ status: 'refused', code: 'operation_not_found' });
      expect((await cofnij(owner, opId)).data).toMatchObject({ status: 'undone', reverted: 0, kept: 1 });
      expect(await stan(id)).toEqual({ paid_at: inny });
      expect(await wiersze()).toEqual([]);
    });
  });

  describe('odczyty', () => {
    it('bank_known_operations: potwierdzone i pominięte klucze firmy; księgowa czyta, obca firma nic', async () => {
      const id = await koszt();
      const owner = await signedIn('owner');
      const potwierdzony = przelew();
      const pominiety = przelew({ amount: '-50.00' });
      const nowy = przelew({ amount: '-60.00' });
      await potwierdz(owner, potwierdzony, [id]);
      await pomin(owner, pominiety);

      const keys = [potwierdzony.key, pominiety.key, nowy.key];
      const { data, error } = await (await signedIn('accountant')).rpc('bank_known_operations', { p_keys: keys });
      expect(error).toBeNull();
      expect(data).toMatchObject({ status: 'ok' });
      expect(new Map((data.known as Array<{ key: string; state: string }>).map((k) => [k.key, k.state]))).toEqual(
        new Map([[potwierdzony.key, 'confirmed'], [pominiety.key, 'skipped']]),
      );
      expect((await (await signedIn('obcy', ORG_B)).rpc('bank_known_operations', { p_keys: keys })).data).toMatchObject({ status: 'ok', known: [] });
    });

    it('bank_expense_operations: decyzje z kosztami, pominięte bez danych; wpływy i przelewy podatkowe w swoich listach', async () => {
      const id = await koszt();
      const owner = await signedIn('owner');
      const potwierdzony = przelew({ title: 'FV/196 TYTUL' });
      await potwierdz(owner, potwierdzony, [id]);
      await pomin(owner, przelew({ amount: '-50.00' }));

      const { data, error } = await (await signedIn('accountant')).rpc('bank_expense_operations');
      expect(error).toBeNull();
      expect(data.confirmed_total).toBe(1);
      const decided = data.decided as Array<Record<string, unknown>>;
      expect(decided).toHaveLength(2);
      const confirmed = decided.find((d) => d.state === 'confirmed')!;
      expect(confirmed).toMatchObject({ amount: -1230, booking_date: DZIEN, title: 'FV/196 TYTUL', counterparty_name: 'Dostawca Testowy' });
      expect(confirmed.expenses).toEqual([expect.objectContaining({ id, paid_at: DZIEN })]);
      const skipped = decided.find((d) => d.state === 'skipped')!;
      expect(skipped).toMatchObject({ amount: -50, title: null, counterparty_name: null, expenses: [] });

      expect((await owner.rpc('bank_operations')).data).toMatchObject({ pending: [], pending_total: 0, confirmed_total: 0 });
      expect((await (await signedIn('obcy', ORG_B)).rpc('bank_expense_operations')).data).toMatchObject({ decided: [], confirmed_total: 0 });
    });
  });
});

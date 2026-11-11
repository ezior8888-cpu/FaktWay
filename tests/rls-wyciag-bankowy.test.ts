import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { getRlsTestEnvironment } from './helpers/rls-environment';

/**
 * Import wyciągu bankowego (plan kompletnej aplikacji, krok 3.2, część 1,
 * migracja 00180) na prawdziwym Postgresie i PostgREST: RPC
 * `import_bank_operations`, `bank_operations`, `confirm_bank_operation`,
 * `skip_bank_operation` i `undo_bank_operation` razem z `record_invoice_payment`
 * (00176) i wyzwalaczami, które liczą `paid_amount`.
 *
 * Niezmienniki:
 *  - ta sama operacja z drugiego pliku nie wchodzi drugi raz (klucz duplikatu);
 *  - wpłata powstaje dopiero po „Potwierdź” i tylko raz, ze źródłem `bank_import`,
 *    datą operacji i kluczem idempotencji z operacji;
 *  - użytkownik innej firmy nie widzi ani nie potwierdza cudzych operacji;
 *  - „Pomiń” usuwa dane osób trzecich (tytuł, nazwa, rachunek), zostawia kwotę i klucz;
 *  - `payment_imports` zostaje zamknięta dla sesji (00074): jedyna droga to RPC.
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

const ORG_A = '00180180-0000-4000-8000-00000000000a';
const ORG_B = '00180180-0000-4000-8000-00000000000b';
const EMAILS = {
  owner: 'rls-bank-owner@ksef-saas.test',
  accountant: 'rls-bank-ksiegowa@ksef-saas.test',
  obcy: 'rls-bank-obcy@ksef-saas.test',
} as const;
const PASS = 'RlsBank2026Aa!';
const NIP = '1234567890';
const RACHUNEK = 'PL61109010140000071219812874';
const KONTRAHENT = 'PL27114020040000300201355387';

const users: Record<keyof typeof EMAILS, string> = { owner: '', accountant: '', obcy: '' };
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

/** Klucz duplikatu w kształcie z `operationKeys` (v1: + 64 znaki szesnastkowe). */
function opKey(): string {
  keyCounter += 1;
  return `v1:${String(keyCounter).padStart(8, '0')}${'ab'.repeat(28)}`;
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

/** Faktura sprzedaży przyjęta w KSeF: 1230 zł brutto, nic nie wpłacono. */
async function faktura(org: string = ORG_A, fields: Record<string, unknown> = {}): Promise<{ id: string; number: string }> {
  counter += 1;
  const id = `00180180-1111-4000-8000-${String(counter).padStart(12, '0')}`;
  const number = `FV/180/${counter}`;
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
    ksef_number: `${NIP}-20261001-${String(counter).padStart(12, '0')}-80`,
    ...fields,
  });
  if (error) throw new Error(`insert ${number}: ${error.message}`);
  return { id, number };
}

interface Operation {
  key?: string;
  account?: string;
  booking_date?: string;
  amount?: string;
  currency?: string;
  counterparty_name?: string | null;
  counterparty_account?: string | null;
  title?: string | null;
  reference?: string | null;
}

function operacja(over: Operation = {}): Required<Operation> {
  return {
    key: opKey(),
    account: RACHUNEK,
    booking_date: shiftDays(warsawToday(), -1),
    amount: '1230.00',
    currency: 'PLN',
    counterparty_name: 'Nabywca Testowy ul. Krótka 1',
    counterparty_account: KONTRAHENT,
    title: 'Zapłata FV/180',
    reference: 'REF-1',
    ...over,
  };
}

function wgraj(c: SupabaseClient, operations: unknown, format = 'mt940') {
  return c.rpc('import_bank_operations', { p_file_format: format, p_operations: operations });
}

async function idOperacji(key: string, org: string = ORG_A): Promise<string> {
  const { data, error } = await admin.from('payment_imports').select('id').eq('tenant_id', org).eq('transaction_id', key).single();
  if (error) throw error;
  return data.id as string;
}

async function wiersz(id: string) {
  const { data, error } = await admin
    .from('payment_imports')
    .select('is_matched, matched_payment_id, ignored, title, counterparty_name, counterparty_account, counterparty_nip, reference, redacted_at, amount, transaction_id, provider, file_format, confirm_attempt, decided_by')
    .eq('id', id)
    .single();
  if (error) throw error;
  return data;
}

async function wplaty(invoiceId: string) {
  const { data, error } = await admin
    .from('payments')
    .select('id, amount, payment_date, payment_method, match_method, bank_import_id, is_confirmed, is_auto_matched, idempotency_key, created_by, voided_at')
    .eq('invoice_id', invoiceId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []).map((row) => ({ ...row, amount: Number(row.amount) }));
}

async function zaplacono(invoiceId: string): Promise<number> {
  const { data, error } = await admin.from('invoices').select('paid_amount').eq('id', invoiceId).single();
  if (error) throw error;
  return Number(data.paid_amount);
}

const potwierdz = (c: SupabaseClient, operationId: string, invoiceId: string, kind = 'invoice_number') =>
  c.rpc('confirm_bank_operation', { p_operation_id: operationId, p_invoice_id: invoiceId, p_match_kind: kind });

async function cleanup() {
  for (const org of [ORG_A, ORG_B]) {
    await admin.from('payment_imports').delete().eq('tenant_id', org);
    await admin.from('payment_reminders').delete().eq('tenant_id', org);
    await admin.from('payments').delete().eq('tenant_id', org);
    await admin.from('invoices').delete().eq('tenant_id', org);
  }
}

describe.skipIf(!hasDatabase)('Import wyciągu bankowego (00180)', () => {
  beforeAll(async () => {
    for (const who of Object.keys(EMAILS) as Array<keyof typeof EMAILS>) {
      users[who] = await userId(EMAILS[who]);
    }
    await cleanup();
    await admin.from('memberships').delete().in('organization_id', [ORG_A, ORG_B]);
    const tenants = await admin.from('tenants').upsert([
      { id: ORG_A, nip: NIP, name: 'Firma A Bank' },
      { id: ORG_B, nip: NIP, name: 'Firma B Bank' },
    ], { onConflict: 'id' });
    if (tenants.error) throw tenants.error;
    const profiles = await admin.from('users').upsert(
      (Object.keys(users) as Array<keyof typeof EMAILS>).map((who) => ({ id: users[who], name: who })),
      { onConflict: 'id' },
    );
    if (profiles.error) throw profiles.error;
    const memberships = await admin.from('memberships').insert([
      { organization_id: ORG_A, user_id: users.owner, role: 'owner', status: 'active' },
      { organization_id: ORG_A, user_id: users.accountant, role: 'accountant', status: 'active' },
      { organization_id: ORG_B, user_id: users.obcy, role: 'owner', status: 'active' },
    ]);
    if (memberships.error) throw memberships.error;
  });

  beforeEach(async () => {
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await admin.from('memberships').delete().in('organization_id', [ORG_A, ORG_B]);
  });

  describe('wgranie i duplikaty', () => {
    it('ta sama operacja z drugiego pliku nie wchodzi drugi raz, także dwa razy w jednym wywołaniu', async () => {
      const c = await signedIn('owner');
      const a = operacja();
      const b = operacja({ amount: '50.00' });

      expect((await wgraj(c, [a, b])).data).toMatchObject({ status: 'imported', received: 2, inserted: 2, duplicates: 0 });
      expect((await wgraj(c, [a, b, operacja({ key: b.key })], 'camt053')).data).toMatchObject({ inserted: 0, duplicates: 3 });
      const rows = await admin.from('payment_imports').select('id, provider, file_format, imported_by').eq('tenant_id', ORG_A);
      expect(rows.data).toHaveLength(2);
      expect(rows.data?.every((r) => r.provider === 'bank_file' && r.file_format === 'mt940' && r.imported_by === users.owner)).toBe(true);
    });

    it('odmowa całego wywołania przy złej operacji: obciążenie, waluta, klucz, data, format', async () => {
      const c = await signedIn('owner');
      for (const bad of [
        operacja({ amount: '-1.00' }),
        operacja({ amount: '0' }),
        operacja({ amount: '1.005' }),
        operacja({ currency: 'EUR' }),
        operacja({ key: 'abc' }),
        operacja({ booking_date: shiftDays(warsawToday(), 2) }),
        operacja({ booking_date: '1999-12-31' }),
        operacja({ account: 'zly rachunek' }),
      ]) {
        const { data } = await wgraj(c, [operacja(), bad]);
        expect(data, JSON.stringify(bad)).toMatchObject({ status: 'refused', code: 'invalid_operation', index: 1 });
      }
      expect((await wgraj(c, [operacja()], 'csv_mbank')).data).toMatchObject({ status: 'refused', code: 'invalid_request' });
      expect((await wgraj(c, [])).data).toMatchObject({ status: 'refused', code: 'no_operations' });
      expect((await admin.from('payment_imports').select('id').eq('tenant_id', ORG_A)).data).toEqual([]);
    });

    it('sesja nie czyta ani nie pisze tabeli wprost; księgowa i anon nie wgrywają; obca firma nie widzi operacji', async () => {
      const owner = await signedIn('owner');
      await wgraj(owner, [operacja()]);
      expect((await owner.from('payment_imports').select('id')).error?.code).toBe('42501');

      const ksiegowa = await signedIn('accountant');
      expect((await wgraj(ksiegowa, [operacja()])).error?.code).toBe('42501');
      const lista = await ksiegowa.rpc('bank_operations');
      expect(lista.error).toBeNull();
      expect((lista.data as { pending: unknown[] }).pending).toHaveLength(1);

      expect((await wgraj(anonClient(ORG_A), [operacja()])).error).not.toBeNull();

      const obcy = await signedIn('obcy', ORG_B);
      const obca = await obcy.rpc('bank_operations');
      expect((obca.data as { pending: unknown[] }).pending).toEqual([]);
      // Nagłówek cudzej firmy bez członkostwa: brak firmy z sesji, odmowa.
      const podszyty = await signedIn('obcy', ORG_A);
      expect((await wgraj(podszyty, [operacja()])).error?.code).toBe('42501');
    });

    it('lista do sprawdzenia: tylko wpływy niezdecydowane, z danymi do dopasowania', async () => {
      const c = await signedIn('owner');
      const a = operacja({ title: 'FV/180/1', counterparty_name: 'Nabywca' });
      await wgraj(c, [a]);
      const { data } = await c.rpc('bank_operations');
      expect((data as { pending: Array<Record<string, unknown>> }).pending[0]).toMatchObject({
        id: await idOperacji(a.key),
        account: RACHUNEK,
        booking_date: a.booking_date,
        amount: 1230,
        currency: 'PLN',
        title: 'FV/180/1',
        counterparty_name: 'Nabywca',
        counterparty_account: KONTRAHENT,
      });
    });
  });

  describe('potwierdzenie', () => {
    it('zapisuje wpłatę raz: źródło bank_import, data operacji, klucz z operacji; drugie potwierdzenie bez drugiej wpłaty', async () => {
      const invoice = await faktura();
      const c = await signedIn('owner');
      const a = operacja({ amount: '300.00', booking_date: shiftDays(warsawToday(), -3) });
      await wgraj(c, [a]);
      const opId = await idOperacji(a.key);

      const first = await potwierdz(c, opId, invoice.id, 'ksef_number');
      expect(first.data).toMatchObject({ status: 'confirmed', amount: 300, paid_on: a.booking_date, payment_status: 'partial', internal_number: invoice.number });
      const second = await potwierdz(c, opId, invoice.id, 'ksef_number');
      expect(second.data).toMatchObject({ status: 'already_confirmed', internal_number: invoice.number });

      const rows = await wplaty(invoice.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        amount: 300, payment_date: a.booking_date, payment_method: 'bank_transfer', match_method: 'bank_import',
        bank_import_id: opId, is_confirmed: true, is_auto_matched: false, created_by: users.owner, voided_at: null,
      });
      expect(rows[0]?.idempotency_key).not.toBeNull();
      expect(await zaplacono(invoice.id)).toBe(300);
      expect(await wiersz(opId)).toMatchObject({ is_matched: true, matched_payment_id: rows[0]?.id, ignored: false, decided_by: users.owner });

      // Ta sama operacja do innej faktury: odmowa, bez drugiej wpłaty.
      const inna = await faktura();
      expect((await potwierdz(c, opId, inna.id)).data).toMatchObject({ status: 'refused', code: 'operation_confirmed', internal_number: invoice.number });
      expect(await wplaty(inna.id)).toEqual([]);
    });

    it('odmowa zapisu wpłaty (nadpłata, faktura zakupu) nie zmienia operacji', async () => {
      const invoice = await faktura();
      const zakup = await faktura(ORG_A, { direction: 'incoming', origin: 'ksef_inbox' });
      const c = await signedIn('owner');
      const a = operacja({ amount: '1300.00' });
      await wgraj(c, [a]);
      const opId = await idOperacji(a.key);

      expect((await potwierdz(c, opId, invoice.id)).data).toMatchObject({ status: 'refused', code: 'over_remaining', remaining: 1230 });
      expect((await potwierdz(c, opId, zakup.id)).data).toMatchObject({ status: 'refused', code: 'not_sales' });
      expect(await wplaty(invoice.id)).toEqual([]);
      expect(await wiersz(opId)).toMatchObject({ is_matched: false, matched_payment_id: null });
    });

    it('obca firma: nie potwierdzi cudzej operacji, a własna operacja nie trafi w cudzą fakturę', async () => {
      const invoiceA = await faktura(ORG_A);
      const invoiceB = await faktura(ORG_B);
      const owner = await signedIn('owner');
      const a = operacja();
      await wgraj(owner, [a]);
      const opId = await idOperacji(a.key);

      const obcy = await signedIn('obcy', ORG_B);
      expect((await potwierdz(obcy, opId, invoiceB.id)).data).toMatchObject({ status: 'refused', code: 'operation_not_found' });
      expect((await potwierdz(owner, opId, invoiceB.id)).data).toMatchObject({ status: 'refused', code: 'not_found' });
      expect((await potwierdz(await signedIn('accountant'), opId, invoiceA.id)).error?.code).toBe('42501');
      expect(await wplaty(invoiceA.id)).toEqual([]);
      expect(await wplaty(invoiceB.id)).toEqual([]);
    });

    it('wpłaty z wyciągu nie cofa „Cofnij wpłatę” przy fakturze (00176): ma własną drogę', async () => {
      const invoice = await faktura();
      const c = await signedIn('owner');
      const a = operacja();
      await wgraj(c, [a]);
      await potwierdz(c, await idOperacji(a.key), invoice.id);
      const [payment] = await wplaty(invoice.id);
      expect((await c.rpc('void_invoice_payment', { p_payment_id: payment!.id })).data).toMatchObject({ status: 'refused', code: 'not_voidable' });
    });
  });

  describe('pominięcie i cofnięcie', () => {
    it('„Pomiń” usuwa tytuł, nazwę i rachunek, zostawia kwotę i klucz; pominiętej nie da się potwierdzić', async () => {
      const invoice = await faktura();
      const c = await signedIn('owner');
      const a = operacja();
      await wgraj(c, [a]);
      const opId = await idOperacji(a.key);

      expect((await c.rpc('skip_bank_operation', { p_operation_id: opId })).data).toMatchObject({ status: 'skipped' });
      expect((await c.rpc('skip_bank_operation', { p_operation_id: opId })).data).toMatchObject({ status: 'already_skipped' });
      const row = await wiersz(opId);
      expect(row).toMatchObject({
        ignored: true, title: null, counterparty_name: null, counterparty_account: null, counterparty_nip: null, reference: null,
        transaction_id: a.key, provider: 'bank_file',
      });
      expect(Number(row.amount)).toBe(1230);
      expect(row.redacted_at).not.toBeNull();
      expect((await potwierdz(c, opId, invoice.id)).data).toMatchObject({ status: 'refused', code: 'operation_skipped' });
      // Ten sam plik jeszcze raz: pominięta operacja nie wraca do sprawdzenia.
      expect((await wgraj(c, [a])).data).toMatchObject({ inserted: 0, duplicates: 1 });
      // Zamaskowanych danych nie da się przywrócić nawet kluczem serwisowym.
      expect((await admin.from('payment_imports').update({ title: 'x' }).eq('id', opId)).error).not.toBeNull();
    });

    it('„Cofnij” cofa wpłatę ze śladem i oddaje operację do sprawdzenia; ponowne potwierdzenie to nowa wpłata', async () => {
      const invoice = await faktura();
      const c = await signedIn('owner');
      const a = operacja();
      await wgraj(c, [a]);
      const opId = await idOperacji(a.key);
      await potwierdz(c, opId, invoice.id);
      expect(await zaplacono(invoice.id)).toBe(1230);

      expect((await c.rpc('skip_bank_operation', { p_operation_id: opId })).data).toMatchObject({ status: 'refused', code: 'operation_confirmed' });
      expect((await c.rpc('undo_bank_operation', { p_operation_id: opId })).data).toMatchObject({ status: 'undone', amount: 1230 });
      expect((await c.rpc('undo_bank_operation', { p_operation_id: opId })).data).toMatchObject({ status: 'not_confirmed' });
      expect(await zaplacono(invoice.id)).toBe(0);
      expect(await wiersz(opId)).toMatchObject({ is_matched: false, matched_payment_id: null, confirm_attempt: 1 });

      expect((await potwierdz(c, opId, invoice.id)).data).toMatchObject({ status: 'confirmed' });
      const rows = await wplaty(invoice.id);
      expect(rows).toHaveLength(2);
      expect(rows[0]?.voided_at).not.toBeNull();
      expect(rows[1]?.voided_at).toBeNull();
      expect(rows[0]?.idempotency_key).not.toBe(rows[1]?.idempotency_key);
      expect(await zaplacono(invoice.id)).toBe(1230);
    });

    it('audyt bez danych osób trzecich: wgranie, potwierdzenie, pominięcie', async () => {
      const invoice = await faktura();
      const c = await signedIn('owner');
      const a = operacja({ title: 'Tajny tytuł', counterparty_name: 'Jan Prywatny' });
      const b = operacja({ amount: '10.00' });
      await wgraj(c, [a, b]);
      await potwierdz(c, await idOperacji(a.key), invoice.id);
      await c.rpc('skip_bank_operation', { p_operation_id: await idOperacji(b.key) });

      const { data } = await admin
        .from('audit_logs')
        .select('action, metadata')
        .eq('tenant_id', ORG_A)
        .in('action', ['bank.statement_imported', 'bank.operation_confirmed', 'bank.operation_skipped'])
        .order('created_at', { ascending: false })
        .limit(3);
      expect(new Set(data?.map((row) => row.action))).toEqual(new Set(['bank.statement_imported', 'bank.operation_confirmed', 'bank.operation_skipped']));
      const text = JSON.stringify(data);
      expect(text).not.toContain('Tajny');
      expect(text).not.toContain('Prywatny');
      expect(text).not.toContain(KONTRAHENT);
    });
  });
});

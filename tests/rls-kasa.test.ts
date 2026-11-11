import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { PgBoss } from 'pg-boss';

import { getRlsTestDatabaseUrl, getRlsTestEnvironment } from './helpers/rls-environment';

/**
 * Kasa (plan kompletnej aplikacji, krok 3.7, migracja 00194) na prawdziwym
 * Postgresie i PostgREST: dowody wpłaty (KP) i wypłaty (KW) gotówki, korekta
 * (storno), stan kasy i raport kasowy. Tego nie sprawdzi atrapa w pamięci:
 *  - numer z bazy: osobna seria KP i KW na firmę i rok daty operacji, pod
 *    blokadą wiersza kasy; wystawienia naraz nie dają dubla;
 *  - stan kasy na koniec dnia nie schodzi poniżej zera (KW i korekta KP);
 *  - ten sam klucz idempotencji to ten sam dowód (ponowienie, dwa naraz);
 *  - wystawionego dowodu nie zmienia nikt (granty i wyzwalacz, także postgres);
 *  - RLS: odczyt tylko własnej firmy, zapis tylko przez RPC, księgowa ma wgląd;
 *  - KP do faktury zapisuje wpłatę przez `record_invoice_payment` (00176),
 *    korekta KP cofa ją przez `void_invoice_payment`, a wpłaty z aktywnym KP
 *    nie cofa się na fakturze (wyzwalacz na `payments`).
 *
 * Dane testowe: masowy insert PostgREST wpisuje NULL w brakujące kolumny, więc
 * faktury mają wszystkie kolumny NOT NULL; firmy mają adres (wystawca dowodu).
 */

const hasDatabase = Boolean(
  process.env.RLS_TEST_SUPABASE_URL?.trim() &&
    process.env.RLS_TEST_SUPABASE_ANON_KEY?.trim() &&
    process.env.RLS_TEST_SUPABASE_SERVICE_ROLE_KEY?.trim(),
);
const hasDirectDb = hasDatabase && Boolean(process.env.RLS_TEST_DATABASE_URL?.trim());
const environment = hasDatabase ? getRlsTestEnvironment() : null;
const admin: SupabaseClient = environment
  ? createClient(environment.url, environment.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    })
  : (null as unknown as SupabaseClient);

const ORG_A = '00194194-0000-4000-8000-00000000000a';
const ORG_B = '00194194-0000-4000-8000-00000000000b';
const EMAILS = {
  owner: 'rls-kasa-owner@ksef-saas.test',
  member: 'rls-kasa-member@ksef-saas.test',
  accountant: 'rls-kasa-ksiegowa@ksef-saas.test',
  obcy: 'rls-kasa-obcy@ksef-saas.test',
} as const;
const NAMES: Record<keyof typeof EMAILS, string> = {
  owner: 'Anna Właścicielka',
  member: 'Marek Członek',
  accountant: 'Ewa Księgowa',
  obcy: 'Obcy Właściciel',
};
const PASS = 'RlsKasa2026Aa!';
const NIP = '1234567890';
const ADDRESS = { countryCode: 'PL', addressLine1: 'ul. Przykładowa 1', addressLine2: '00-001 Warszawa' };
const AUDIT = ['cash_register.opened', 'cash_register.opening_changed', 'cash_document.issued', 'cash_document.corrected'];

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

const yearOf = (iso: string) => Number(iso.slice(0, 4));

/** Nowy klucz idempotencji (UUID v4), jak `crypto.randomUUID()` przy otwarciu formularza. */
function key(): string {
  keyCounter += 1;
  return `00194194-4444-4000-8000-${String(keyCounter).padStart(12, '0')}`;
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

type Result = { status: string; code?: string; [key: string]: unknown };

async function otworz(c: SupabaseClient, balance = 0, day = shiftDays(warsawToday(), -30)): Promise<Result> {
  const { data, error } = await c.rpc('open_cash_register', { p_opening_date: day, p_opening_balance: balance });
  if (error) throw new Error(`open_cash_register: ${error.message}`);
  return data as Result;
}

interface IssueArgs {
  kind?: 'KP' | 'KW';
  amount?: number;
  day?: string;
  key?: string;
  title?: string;
  party?: Record<string, unknown>;
  related?: string | null;
  invoiceId?: string | null;
  paymentId?: string | null;
}

function wystawRpc(c: SupabaseClient, args: IssueArgs = {}) {
  return c.rpc('issue_cash_document', {
    p_kind: args.kind ?? 'KP',
    p_idempotency_key: args.key ?? key(),
    p_operation_date: args.day ?? warsawToday(),
    p_amount: args.amount ?? 100,
    p_title: args.title ?? 'Wpłata gotówki',
    p_counterparty: args.party ?? { name: 'Jan Kowalski', addressLine1: 'ul. Klienta 10', addressLine2: '02-001 Warszawa' },
    p_related_document: args.related ?? null,
    p_invoice_id: args.invoiceId ?? null,
    p_payment_id: args.paymentId ?? null,
  });
}

async function wystaw(c: SupabaseClient, args: IssueArgs = {}): Promise<Result> {
  const { data, error } = await wystawRpc(c, args);
  if (error) throw new Error(`issue_cash_document: ${error.message}`);
  return data as Result;
}

async function koryguj(c: SupabaseClient, documentId: string, reason: string | null = 'Pomyłka w kwocie', k: string = key()): Promise<Result> {
  const { data, error } = await c.rpc('correct_cash_document', { p_document_id: documentId, p_reason: reason, p_idempotency_key: k });
  if (error) throw new Error(`correct_cash_document: ${error.message}`);
  return data as Result;
}

interface DocRow {
  id: string;
  kind: string;
  number: string;
  number_year: number;
  number_seq: number;
  issue_date: string;
  operation_date: string;
  amount: number;
  title: string;
  counterparty: Record<string, unknown>;
  issuer: Record<string, unknown>;
  issued_by: string | null;
  issued_by_name: string;
  invoice_id: string | null;
  invoice_number: string | null;
  payment_id: string | null;
  corrects_id: string | null;
  corrects_number: string | null;
  correction_reason: string | null;
  idempotency_key: string;
}

async function dowody(org: string = ORG_A): Promise<DocRow[]> {
  const { data, error } = await admin
    .from('cash_documents')
    .select('id, kind, number, number_year, number_seq, issue_date, operation_date, amount, title, counterparty, issuer, issued_by, issued_by_name, invoice_id, invoice_number, payment_id, corrects_id, corrects_number, correction_reason, idempotency_key')
    .eq('tenant_id', org)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return ((data ?? []) as DocRow[]).map((row) => ({ ...row, amount: Number(row.amount) }));
}

async function audyt(org: string = ORG_A) {
  const { data, error } = await admin
    .from('audit_logs')
    .select('tenant_id, user_id, action, entity_type, entity_id, metadata')
    .eq('tenant_id', org)
    .in('action', AUDIT)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

/** `audit_logs` jest tylko do dopisywania (00052): porównujemy stan przed i po wywołaniu. */
async function nowyAudyt(wywolanie: () => PromiseLike<unknown>, org: string = ORG_A) {
  const przed = (await audyt(org)).length;
  await wywolanie();
  return (await audyt(org)).slice(przed);
}

/** Faktura sprzedaży przyjęta w KSeF, termin minął 5 dni temu: 1230 zł brutto, nic nie wpłacono. */
async function faktura(fields: Record<string, unknown> = {}, org: string = ORG_A): Promise<string> {
  counter += 1;
  const id = `00194194-1111-4000-8000-${String(counter).padStart(12, '0')}`;
  const number = `FV/194/${counter}`;
  const { error } = await admin.from('invoices').insert({
    id,
    tenant_id: org,
    direction: 'outgoing',
    origin: 'app',
    internal_number: number,
    invoice_type: 'VAT',
    invoice_kind: 'regular',
    issue_date: shiftDays(warsawToday(), -20),
    payment_due_date: shiftDays(warsawToday(), -5),
    seller_nip: NIP,
    buyer_nip: NIP,
    gross_total: 1230,
    net_total: 1000,
    vat_total: 230,
    currency: 'PLN',
    fa3_data: { internalNumber: number, type: 'VAT' },
    seller_data: { nip: NIP },
    buyer_data: { nip: NIP, name: 'Nabywca Testowy', address: ADDRESS },
    ksef_status: 'accepted',
    ksef_environment: 'test',
    xml_storage_path: 'x.xml',
    ksef_number: `${NIP}-20261001-${String(counter).padStart(12, '0')}-94`,
    ...fields,
  });
  if (error) throw new Error(`insert ${number}: ${error.message}`);
  return id;
}

async function stanFaktury(id: string) {
  const { data, error } = await admin.from('invoices').select('paid_amount, payment_status').eq('id', id).single();
  if (error) throw error;
  return { paid_amount: Number(data.paid_amount), payment_status: data.payment_status as string };
}

interface PaymentRow {
  id: string;
  amount: number;
  payment_date: string;
  payment_method: string;
  match_method: string | null;
  notes: string | null;
  idempotency_key: string | null;
  voided_at: string | null;
}

async function wplaty(invoiceId: string): Promise<PaymentRow[]> {
  const { data, error } = await admin
    .from('payments')
    .select('id, amount, payment_date, payment_method, match_method, notes, idempotency_key, voided_at')
    .eq('invoice_id', invoiceId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return ((data ?? []) as PaymentRow[]).map((row) => ({ ...row, amount: Number(row.amount) }));
}

async function cleanup() {
  for (const org of [ORG_A, ORG_B]) {
    await admin.from('cash_documents').delete().eq('tenant_id', org);
    await admin.from('cash_registers').delete().eq('tenant_id', org);
    await admin.from('flo_proposals').delete().eq('tenant_id', org);
    await admin.from('payment_reminders').delete().eq('tenant_id', org);
    await admin.from('payments').delete().eq('tenant_id', org);
    await admin.from('invoices').delete().eq('tenant_id', org);
  }
}

describe.skipIf(!hasDatabase)('Kasa: dowody KP i KW, korekta i raport kasowy (00194)', () => {
  beforeAll(async () => {
    for (const who of Object.keys(EMAILS) as Array<keyof typeof EMAILS>) {
      users[who] = await userId(EMAILS[who]);
    }
    await cleanup();
    await admin.from('memberships').delete().in('organization_id', [ORG_A, ORG_B]);
    // Wpisy audytu zostają po przebiegu (00052), więc firmę dopisujemy, a nie odtwarzamy.
    // Firma B nie ma adresu: wystawca bez danych to odmowa.
    const tenants = await admin.from('tenants').upsert([
      { id: ORG_A, nip: NIP, name: 'Firma A Kasa', address_json: ADDRESS },
      { id: ORG_B, nip: NIP, name: 'Firma B Kasa', address_json: null },
    ], { onConflict: 'id' });
    if (tenants.error) throw tenants.error;
    const profiles = await admin.from('users').upsert(
      (Object.keys(users) as Array<keyof typeof EMAILS>).map((who) => ({ id: users[who], name: NAMES[who] })),
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

  describe('kasa i stan początkowy', () => {
    it('właściciel otwiera kasę; ten sam stan to „bez zmian”; zmiana przed pierwszym dowodem; po dowodzie odmowa', async () => {
      const c = await signedIn('owner');
      const day = shiftDays(warsawToday(), -10);

      const wpisy = await nowyAudyt(async () => {
        expect(await otworz(c, 100, day)).toMatchObject({ status: 'opened' });
        expect(await otworz(c, 100, day)).toMatchObject({ status: 'unchanged' });
        expect(await otworz(c, 250.5, day)).toMatchObject({ status: 'updated' });
      });
      expect(wpisy.map((w) => w.action)).toEqual(['cash_register.opened', 'cash_register.opening_changed']);
      expect(wpisy[0]).toMatchObject({ tenant_id: ORG_A, user_id: users.owner, entity_type: 'cash_register' });

      await wystaw(c, { amount: 10, day });
      expect(await otworz(c, 300, day)).toMatchObject({ status: 'refused', code: 'documents_exist', opening_balance: 250.5, opening_date: day });
      const { data } = await admin.from('cash_registers').select('opening_balance, opening_date').eq('tenant_id', ORG_A).single();
      expect({ balance: Number(data!.opening_balance), date: data!.opening_date }).toEqual({ balance: 250.5, date: day });
    });

    it('data z przyszłości, kwota ujemna i trzy miejsca po przecinku: odmowa bez kasy', async () => {
      const c = await signedIn('owner');

      expect(await otworz(c, 0, shiftDays(warsawToday(), 1))).toMatchObject({ status: 'refused', code: 'future_date' });
      expect(await otworz(c, -1)).toMatchObject({ status: 'refused', code: 'invalid_amount' });
      expect(await otworz(c, 10.005)).toMatchObject({ status: 'refused', code: 'invalid_amount' });
      expect((await admin.from('cash_registers').select('id').eq('tenant_id', ORG_A)).data).toEqual([]);
    });

    it('księgowa nie otwiera kasy (42501); anon nie woła funkcji', async () => {
      const ksiegowa = await signedIn('accountant');
      expect((await ksiegowa.rpc('open_cash_register', { p_opening_date: warsawToday(), p_opening_balance: 0 })).error?.code).toBe('42501');
      expect((await anonClient(ORG_A).rpc('open_cash_register', { p_opening_date: warsawToday(), p_opening_balance: 0 })).error).not.toBeNull();
      expect((await admin.from('cash_registers').select('id').eq('tenant_id', ORG_A)).data).toEqual([]);
    });

    it('bez kasy nie ma dowodu: odmowa register_missing', async () => {
      expect(await wystaw(await signedIn('owner'))).toMatchObject({ status: 'refused', code: 'register_missing' });
    });
  });

  describe('wystawienie i numer z bazy', () => {
    it('KP bez faktury: numer z serii, migawki wystawcy i strony, data wystawienia dziś, kto wystawił, audyt', async () => {
      const c = await signedIn('owner');
      await otworz(c);
      const day = shiftDays(warsawToday(), -2);
      const k = key();

      const wpisy = await nowyAudyt(async () => {
        const result = await wystaw(c, {
          amount: 1234.56, day, key: k, title: '  Wpłata zaliczki ', related: ' Umowa 7/2026 ',
          party: { name: ' Jan Kowalski ', nip: '', addressLine1: 'ul. Klienta 10', addressLine2: '02-001 Warszawa' },
        });
        expect(result).toMatchObject({ status: 'issued', number: `KP/1/${yearOf(day)}`, kind: 'KP', amount: 1234.56, payment_recorded: false });
      });

      const [doc] = await dowody();
      expect(doc).toMatchObject({
        kind: 'KP', number: `KP/1/${yearOf(day)}`, number_seq: 1, number_year: yearOf(day), operation_date: day,
        issue_date: warsawToday(), amount: 1234.56, title: 'Wpłata zaliczki',
        counterparty: { name: 'Jan Kowalski', nip: null, addressLine1: 'ul. Klienta 10', addressLine2: '02-001 Warszawa' },
        issuer: { name: 'Firma A Kasa', nip: NIP, addressLine1: ADDRESS.addressLine1, addressLine2: ADDRESS.addressLine2 },
        issued_by: users.owner, issued_by_name: NAMES.owner, invoice_id: null, payment_id: null, corrects_id: null, idempotency_key: k,
      });
      expect(wpisy).toEqual([expect.objectContaining({
        tenant_id: ORG_A, user_id: users.owner, action: 'cash_document.issued', entity_type: 'cash_document', entity_id: doc!.id,
        metadata: expect.objectContaining({ number: doc!.number, kind: 'KP', amount: 1234.56 }),
      })]);
    });

    it('KP i KW mają osobne serie, a rok bierze się z daty operacji', async () => {
      const c = await signedIn('owner');
      const lastYear = yearOf(warsawToday()) - 1;
      await otworz(c, 1000, `${lastYear}-12-01`);

      await wystaw(c, { kind: 'KP', day: `${lastYear}-12-31` });
      await wystaw(c, { kind: 'KP' });
      await wystaw(c, { kind: 'KW', amount: 50 });
      await wystaw(c, { kind: 'KP' });

      expect((await dowody()).map((d) => d.number)).toEqual([
        `KP/1/${lastYear}`, `KP/1/${lastYear + 1}`, `KW/1/${lastYear + 1}`, `KP/2/${lastYear + 1}`,
      ]);
    });

    it('pięć wystawień naraz z różnymi kluczami: kolejne numery bez dubla (blokada kasy)', async () => {
      const c = await signedIn('owner');
      await otworz(c);

      const results = await Promise.all([1, 2, 3, 4, 5].map(() => wystawRpc(c)));

      expect(results.map((r) => r.error)).toEqual([null, null, null, null, null]);
      const year = yearOf(warsawToday());
      expect((await dowody()).map((d) => d.number).sort()).toEqual([1, 2, 3, 4, 5].map((n) => `KP/${n}/${year}`).sort());
    });

    it('to samo wystawienie dwa razy naraz (ten sam klucz): jeden dowód', async () => {
      const c = await signedIn('owner');
      await otworz(c);
      const k = key();

      const results = await Promise.all([wystawRpc(c, { key: k }), wystawRpc(c, { key: k })]);

      expect(results.map((r) => r.error)).toEqual([null, null]);
      expect(results.map((r) => (r.data as Result).status).sort()).toEqual(['already_issued', 'issued']);
      expect(await dowody()).toHaveLength(1);
    });

    it('ponowienie z tym samym kluczem: ten sam dowód bez drugiego audytu; ten sam klucz z inną kwotą to odmowa', async () => {
      const c = await signedIn('owner');
      await otworz(c);
      const k = key();
      const first = await wystaw(c, { key: k, amount: 300 });

      const wpisy = await nowyAudyt(async () => {
        expect(await wystaw(c, { key: k, amount: 300 })).toMatchObject({ status: 'already_issued', document_id: first.document_id, number: first.number });
        expect(await wystaw(c, { key: k, amount: 301 })).toMatchObject({ status: 'refused', code: 'key_reused' });
      });
      expect(wpisy).toEqual([]);
      expect(await dowody()).toHaveLength(1);
    });

    it.each([
      ['kwota zero', { amount: 0 }, 'invalid_amount'],
      ['kwota z trzema miejscami', { amount: 10.005 }, 'invalid_amount'],
      ['data z przyszłości', { day: shiftDays(warsawToday(), 1) }, 'future_date'],
      ['data przed otwarciem kasy', { day: shiftDays(warsawToday(), -31) }, 'before_opening'],
      ['pusty tytuł', { title: '   ' }, 'title_invalid'],
      ['strona bez nazwy', { party: { name: ' ' } }, 'counterparty_invalid'],
      ['KW z fakturą', { kind: 'KW' as const, invoiceId: '00194194-1111-4000-8000-999999999999' }, 'invalid_request'],
    ])('%s: odmowa bez dowodu, a numer nie przepada', async (_name, args, code) => {
      const c = await signedIn('owner');
      await otworz(c, 500);

      expect(await wystaw(c, args)).toMatchObject({ status: 'refused', code });
      expect(await dowody()).toEqual([]);
      expect(await wystaw(c)).toMatchObject({ status: 'issued', number: `KP/1/${yearOf(warsawToday())}` });
    });

    it('wystawca bez adresu: odmowa issuer_incomplete', async () => {
      const obcy = await signedIn('obcy', ORG_B);
      await otworz(obcy);

      expect(await wystaw(obcy)).toMatchObject({ status: 'refused', code: 'issuer_incomplete' });
      expect(await dowody(ORG_B)).toEqual([]);
    });

    it('członek wystawia; księgowa nie (42501); obca firma z nagłówkiem firmy A też nie (brak członkostwa)', async () => {
      await otworz(await signedIn('owner'));

      expect(await wystaw(await signedIn('member'))).toMatchObject({ status: 'issued' });
      expect((await wystawRpc(await signedIn('accountant'))).error?.code).toBe('42501');
      expect((await wystawRpc(await signedIn('obcy', ORG_A))).error?.code).toBe('42501');
      expect((await wystawRpc(anonClient(ORG_A))).error).not.toBeNull();
      expect((await dowody()).map((d) => d.issued_by)).toEqual([users.member]);
    });
  });

  describe('stan kasy nie schodzi poniżej zera', () => {
    it('KW ponad stan: odmowa z kwotą i dniem; do zera przechodzi; grosz po zerze nie', async () => {
      const c = await signedIn('owner');
      await otworz(c, 100);

      expect(await wystaw(c, { kind: 'KW', amount: 100.01 })).toMatchObject({
        status: 'refused', code: 'insufficient_cash', available: 100, available_on: warsawToday(), amount: 100.01,
      });
      expect(await wystaw(c, { kind: 'KW', amount: 100 })).toMatchObject({ status: 'issued' });
      expect(await wystaw(c, { kind: 'KW', amount: 0.01 })).toMatchObject({ status: 'refused', code: 'insufficient_cash', available: 0 });
      expect(await dowody()).toHaveLength(1);
    });

    it('KW z datą wstecz: liczy się stan na koniec każdego dnia od daty operacji', async () => {
      const c = await signedIn('owner');
      await otworz(c, 0, shiftDays(warsawToday(), -10));
      const day5 = shiftDays(warsawToday(), -5);
      const day3 = shiftDays(warsawToday(), -3);
      await wystaw(c, { kind: 'KP', amount: 100, day: day3 });

      // 5 dni temu kasa była pusta: KP z dnia -3 nie pokrywa wypłaty z dnia -5.
      expect(await wystaw(c, { kind: 'KW', amount: 50, day: day5 })).toMatchObject({ status: 'refused', code: 'insufficient_cash', available: 0, available_on: day5 });
      expect(await wystaw(c, { kind: 'KW', amount: 60, day: day3 })).toMatchObject({ status: 'issued' });
      // Od dnia -3 w kasie jest 40 zł: wypłata 41 zł z wczoraj zeszłaby poniżej zera.
      expect(await wystaw(c, { kind: 'KW', amount: 41, day: shiftDays(warsawToday(), -1) })).toMatchObject({ status: 'refused', code: 'insufficient_cash', available: 40 });
      expect(await wystaw(c, { kind: 'KW', amount: 40, day: shiftDays(warsawToday(), -1) })).toMatchObject({ status: 'issued' });
    });

    it('dwie wypłaty naraz, każda mieści się osobno: jedna odmowa (blokada kasy)', async () => {
      const c = await signedIn('owner');
      await otworz(c, 100);

      const results = await Promise.all([wystawRpc(c, { kind: 'KW', amount: 60 }), wystawRpc(c, { kind: 'KW', amount: 60 })]);

      expect(results.map((r) => (r.data as Result).status).sort()).toEqual(['issued', 'refused']);
      expect((await dowody()).map((d) => d.amount)).toEqual([60]);
    });
  });

  describe('korekta (storno)', () => {
    it('korekta KP: kwota ujemna w tej samej serii, data operacji dowodu korygowanego, przyczyna, audyt', async () => {
      const c = await signedIn('owner');
      await otworz(c, 0, shiftDays(warsawToday(), -10));
      const day = shiftDays(warsawToday(), -4);
      const original = await wystaw(c, { amount: 200, day });

      const wpisy = await nowyAudyt(async () => {
        const result = await koryguj(c, original.document_id as string, '  Dubel  ');
        expect(result).toMatchObject({ status: 'issued', number: `KP/2/${yearOf(day)}`, corrects_number: original.number });
      });

      const [, storno] = await dowody();
      expect(storno).toMatchObject({
        kind: 'KP', amount: -200, operation_date: day, issue_date: warsawToday(), corrects_id: original.document_id,
        corrects_number: original.number, correction_reason: 'Dubel', title: `Korekta dowodu ${original.number}`,
      });
      expect(wpisy.map((w) => w.action)).toEqual(['cash_document.corrected']);
    });

    it('druga korekta, korekta korekty i brak przyczyny: odmowy bez nowego dowodu', async () => {
      const c = await signedIn('owner');
      await otworz(c, 500);
      const original = await wystaw(c, { amount: 100 });
      const storno = await koryguj(c, original.document_id as string);

      expect(await koryguj(c, original.document_id as string)).toMatchObject({
        status: 'refused', code: 'already_corrected', number: original.number, correction_number: storno.number,
      });
      expect(await koryguj(c, storno.document_id as string)).toMatchObject({ status: 'refused', code: 'is_correction', number: storno.number });
      const inny = await wystaw(c, { amount: 10 });
      expect(await koryguj(c, inny.document_id as string, '   ')).toMatchObject({ status: 'refused', code: 'reason_required' });
      expect(await dowody()).toHaveLength(3);
    });

    it('korekta KP, która zeszłaby poniżej zera: odmowa; korekta KW zwiększa stan', async () => {
      const c = await signedIn('owner');
      await otworz(c, 0);
      const kp = await wystaw(c, { amount: 100 });
      const kw = await wystaw(c, { kind: 'KW', amount: 80 });

      expect(await koryguj(c, kp.document_id as string)).toMatchObject({ status: 'refused', code: 'insufficient_cash', available: 20, amount: 100 });
      expect(await koryguj(c, kw.document_id as string)).toMatchObject({ status: 'issued' });
      expect(await koryguj(c, kp.document_id as string)).toMatchObject({ status: 'issued' });
      expect((await dowody()).map((d) => [d.kind, d.amount])).toEqual([['KP', 100], ['KW', 80], ['KW', -80], ['KP', -100]]);
    });

    it('ponowienie korekty z tym samym kluczem: ta sama korekta; klucz z innego dowodu to odmowa', async () => {
      const c = await signedIn('owner');
      await otworz(c, 500);
      const a = await wystaw(c);
      const b = await wystaw(c);
      const k = key();
      const first = await koryguj(c, a.document_id as string, 'Dubel', k);

      expect(await koryguj(c, a.document_id as string, 'Dubel', k)).toMatchObject({ status: 'already_issued', document_id: first.document_id });
      expect(await koryguj(c, b.document_id as string, 'Dubel', k)).toMatchObject({ status: 'refused', code: 'key_reused' });
      expect(await dowody()).toHaveLength(3);
    });

    it('dowód obcej firmy: nie znaleziono; księgowa nie koryguje (42501)', async () => {
      const c = await signedIn('owner');
      await otworz(c, 500);
      const a = await wystaw(c);
      const obcy = await signedIn('obcy', ORG_B);
      await otworz(obcy);

      expect(await koryguj(obcy, a.document_id as string)).toMatchObject({ status: 'refused', code: 'not_found' });
      const ksiegowa = await signedIn('accountant');
      expect((await ksiegowa.rpc('correct_cash_document', { p_document_id: a.document_id, p_reason: 'x', p_idempotency_key: key() })).error?.code).toBe('42501');
      expect(await dowody()).toHaveLength(1);
    });
  });

  describe('wystawionego dowodu nie zmienia nikt', () => {
    it('sesja: bez INSERT, UPDATE i DELETE (granty); dowód bez zmian', async () => {
      const c = await signedIn('owner');
      await otworz(c, 500);
      const a = await wystaw(c, { amount: 100 });

      expect((await c.from('cash_documents').update({ amount: 1 }).eq('id', a.document_id as string)).error).not.toBeNull();
      expect((await c.from('cash_documents').delete().eq('id', a.document_id as string)).error).not.toBeNull();
      expect((await c.from('cash_documents').insert({ tenant_id: ORG_A, kind: 'KP' })).error).not.toBeNull();
      expect((await c.from('cash_registers').update({ opening_balance: 9 }).eq('tenant_id', ORG_A)).error).not.toBeNull();
      expect((await dowody()).map((d) => d.amount)).toEqual([100]);
    });

    it('klucz serwisowy (PostgREST): bez UPDATE', async () => {
      const c = await signedIn('owner');
      await otworz(c, 500);
      const a = await wystaw(c, { amount: 100 });

      expect((await admin.from('cash_documents').update({ title: 'Inny tytuł' }).eq('id', a.document_id as string)).error).not.toBeNull();
      expect((await dowody())[0]!.title).toBe('Wpłata gotówki');
    });

    describe.skipIf(!hasDirectDb)('postgres bez RLS: wyzwalacze', () => {
      interface Db { executeSql(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> }
      let boss: PgBoss;
      const db = () => boss.getDb() as unknown as Db;

      beforeAll(async () => {
        boss = new PgBoss({ connectionString: getRlsTestDatabaseUrl(), schema: 'pgboss', schedule: false, supervise: false });
        await boss.start();
      });

      afterAll(async () => {
        await boss?.stop({ graceful: false, close: true });
      });

      it('zmiana kwoty, numeru i strony: wyjątek; stan początkowy po pierwszym dowodzie: wyjątek', async () => {
        const c = await signedIn('owner');
        await otworz(c, 500);
        const a = await wystaw(c, { amount: 100 });

        for (const set of ["amount = 1", "number = 'KP/99/2000'", `counterparty = '{"name":"Ktoś inny"}'::jsonb`, 'issued_at = now()']) {
          await expect(db().executeSql(`UPDATE public.cash_documents SET ${set} WHERE id = $1`, [a.document_id])).rejects.toThrow(/cannot be changed/);
        }
        await expect(db().executeSql('UPDATE public.cash_registers SET opening_balance = 1 WHERE tenant_id = $1', [ORG_A])).rejects.toThrow(/locked/);
        expect((await dowody())[0]).toMatchObject({ amount: 100, counterparty: expect.objectContaining({ name: 'Jan Kowalski' }) });
      });

      it('usunięcie wpłaty zeruje tylko payment_id dowodu; reszta bez zmian', async () => {
        const c = await signedIn('owner');
        await otworz(c, 0);
        const invoice = await faktura();
        const kp = await wystaw(c, { amount: 300, invoiceId: invoice });

        await db().executeSql('DELETE FROM public.payments WHERE invoice_id = $1', [invoice]);

        expect((await dowody())[0]).toMatchObject({ id: kp.document_id, payment_id: null, invoice_id: invoice, amount: 300, number: kp.number });
      });
    });
  });

  describe('RLS: odczyt tylko własnej firmy', () => {
    it('obca firma nie widzi kasy ani dowodów; księgowa widzi; anon nic', async () => {
      const c = await signedIn('owner');
      await otworz(c, 500);
      const a = await wystaw(c);

      const obcy = await signedIn('obcy', ORG_B);
      expect((await obcy.from('cash_documents').select('id').eq('id', a.document_id as string)).data).toEqual([]);
      expect((await obcy.from('cash_registers').select('id').eq('tenant_id', ORG_A)).data).toEqual([]);
      const zNaglowkiemA = await signedIn('obcy', ORG_A);
      expect((await zNaglowkiemA.from('cash_documents').select('id')).data).toEqual([]);
      const ksiegowa = await signedIn('accountant');
      expect((await ksiegowa.from('cash_documents').select('id, number')).data).toEqual([{ id: a.document_id, number: a.number }]);
      expect((await anonClient(ORG_A).from('cash_documents').select('id')).data ?? []).toEqual([]);
    });
  });

  describe('KP do faktury i do zapisanej wpłaty (00176)', () => {
    it('KP do faktury zapisuje wpłatę gotówką w tej samej transakcji; faktura częściowo opłacona', async () => {
      const c = await signedIn('owner');
      await otworz(c, 0);
      const invoice = await faktura();
      const k = key();

      const result = await wystaw(c, { amount: 300, invoiceId: invoice, key: k, title: 'Zapłata za fakturę FV/194' });

      expect(result).toMatchObject({ status: 'issued', payment_recorded: true, invoice_id: invoice });
      const [payment] = await wplaty(invoice);
      expect(payment).toMatchObject({
        amount: 300, payment_date: warsawToday(), payment_method: 'cash', match_method: 'manual_entry',
        notes: `Gotówka, ${result.number}`, idempotency_key: k, voided_at: null,
      });
      expect((await dowody())[0]).toMatchObject({ invoice_id: invoice, payment_id: payment!.id, invoice_number: expect.stringMatching(/^FV\/194\//) });
      expect(await stanFaktury(invoice)).toEqual({ paid_amount: 300, payment_status: 'partial' });
    });

    it('KP ponad resztę, faktura zakupu i faktura obcej firmy: odmowa bez dowodu i bez wpłaty', async () => {
      const c = await signedIn('owner');
      await otworz(c, 0);
      const invoice = await faktura();
      const zakup = await faktura({ direction: 'incoming', origin: 'ksef_inbox' });
      const obca = await faktura({}, ORG_B);

      expect(await wystaw(c, { amount: 1230.01, invoiceId: invoice })).toMatchObject({
        status: 'refused', code: 'invoice_refused', invoice_code: 'over_remaining', remaining: 1230,
      });
      expect(await wystaw(c, { invoiceId: zakup })).toMatchObject({ status: 'refused', code: 'invoice_refused', invoice_code: 'not_sales' });
      expect(await wystaw(c, { invoiceId: obca })).toMatchObject({ status: 'refused', code: 'invoice_refused', invoice_code: 'not_found' });
      expect(await dowody()).toEqual([]);
      expect(await wplaty(invoice)).toEqual([]);
      expect(await wystaw(c)).toMatchObject({ number: `KP/1/${yearOf(warsawToday())}` });
    });

    it('KP do zapisanej wpłaty: wiąże ją bez drugiej wpłaty; drugi KP do niej i inna kwota to odmowy', async () => {
      const c = await signedIn('owner');
      await otworz(c, 0);
      const invoice = await faktura();
      const day = shiftDays(warsawToday(), -1);
      const recorded = await c.rpc('record_invoice_payment', {
        p_invoice_id: invoice, p_amount: 300, p_idempotency_key: key(), p_paid_on: day, p_note: null,
      });
      const paymentId = (recorded.data as Result).payment_id as string;

      expect(await wystaw(c, { paymentId, amount: 299, day })).toMatchObject({ status: 'refused', code: 'payment_mismatch', amount: 300, paid_on: day });
      const kp = await wystaw(c, { paymentId, amount: 300, day });
      expect(kp).toMatchObject({ status: 'issued', payment_recorded: false, invoice_id: invoice });
      expect(await wystaw(c, { paymentId, amount: 300, day })).toMatchObject({ status: 'refused', code: 'payment_linked', document_number: kp.number });

      expect((await wplaty(invoice)).map((p) => [p.amount, p.payment_method])).toEqual([[300, 'cash']]);
      expect((await dowody())[0]).toMatchObject({ payment_id: paymentId, invoice_id: invoice });
    });

    it('wpłata z „Zapłacone”: KP jej nie obejmie; wpłata cofnięta też nie', async () => {
      const c = await signedIn('owner');
      await otworz(c, 0);
      const zaplacona = await faktura();
      await c.rpc('mark_invoice_paid', { p_invoice_id: zaplacona });
      const [manual] = await wplaty(zaplacona);
      expect(await wystaw(c, { paymentId: manual!.id, amount: manual!.amount, day: manual!.payment_date })).toMatchObject({
        status: 'refused', code: 'payment_not_linkable', source: 'manual',
      });

      const inna = await faktura();
      const recorded = await c.rpc('record_invoice_payment', { p_invoice_id: inna, p_amount: 100, p_idempotency_key: key(), p_paid_on: warsawToday(), p_note: null });
      const paymentId = (recorded.data as Result).payment_id as string;
      await c.rpc('void_invoice_payment', { p_payment_id: paymentId });
      expect(await wystaw(c, { paymentId, amount: 100 })).toMatchObject({ status: 'refused', code: 'payment_voided' });
      expect(await dowody()).toEqual([]);
    });

    it('wpłaty z aktywnym KP nie cofa się na fakturze; korekta KP cofa ją razem z dowodem', async () => {
      const c = await signedIn('owner');
      await otworz(c, 0);
      const invoice = await faktura();
      const kp = await wystaw(c, { amount: 300, invoiceId: invoice });
      const [payment] = await wplaty(invoice);

      const blocked = await c.rpc('void_invoice_payment', { p_payment_id: payment!.id });
      expect(blocked.error).toMatchObject({ code: 'P0001', message: 'cash_document_active', hint: kp.number });
      expect((await wplaty(invoice))[0]!.voided_at).toBeNull();

      expect(await koryguj(c, kp.document_id as string)).toMatchObject({ status: 'issued', payment_voided: true, invoice_id: invoice });
      expect((await wplaty(invoice))[0]!.voided_at).not.toBeNull();
      expect(await stanFaktury(invoice)).toEqual({ paid_amount: 0, payment_status: 'overdue' });
    });

    it('korekta KP przy „Zapłacone” policzonym po tej wpłacie: odmowa manual_first, bez korekty i bez zmian', async () => {
      const c = await signedIn('owner');
      await otworz(c, 0);
      const invoice = await faktura();
      const kp = await wystaw(c, { amount: 300, invoiceId: invoice });
      await c.rpc('mark_invoice_paid', { p_invoice_id: invoice });

      expect(await koryguj(c, kp.document_id as string)).toMatchObject({
        status: 'refused', code: 'payment_refused', payment_code: 'manual_first', number: kp.number, manual_amount: 930,
      });
      expect(await dowody()).toHaveLength(1);
      expect((await wplaty(invoice)).map((p) => p.voided_at)).toEqual([null, null]);
    });

    it('lista wpłat do KP: tylko wpisane ręcznie, niecofnięte i bez dowodu', async () => {
      const c = await signedIn('owner');
      await otworz(c, 0);
      const a = await faktura();
      const b = await faktura();
      const wolna = await c.rpc('record_invoice_payment', { p_invoice_id: a, p_amount: 100, p_idempotency_key: key(), p_paid_on: warsawToday(), p_note: null });
      await wystaw(c, { amount: 200, invoiceId: b });
      await c.rpc('mark_invoice_paid', { p_invoice_id: b });

      const { data, error } = await c.rpc('cash_receipt_payments');

      expect(error).toBeNull();
      expect((data as Array<Record<string, unknown>>).map((p) => [p.payment_id, Number(p.amount)])).toEqual([[(wolna.data as Result).payment_id, 100]]);
      const obcy = await signedIn('obcy', ORG_B);
      expect((await obcy.rpc('cash_receipt_payments')).data).toEqual([]);
    });
  });

  describe('raport kasowy (cash_report)', () => {
    it('stan przed okresem, dowody okresu po dniu (KP przed KW), korekta wskazuje dowód; obca firma bez kasy', async () => {
      const c = await signedIn('owner');
      const start = shiftDays(warsawToday(), -20);
      await otworz(c, 50, start);
      await wystaw(c, { amount: 100, day: shiftDays(warsawToday(), -15) });
      const from = shiftDays(warsawToday(), -10);
      await wystaw(c, { kind: 'KW', amount: 30, day: shiftDays(warsawToday(), -5) });
      const kp = await wystaw(c, { amount: 20, day: shiftDays(warsawToday(), -5) });
      const storno = await koryguj(c, kp.document_id as string);

      const { data, error } = await (await signedIn('accountant')).rpc('cash_report', { p_from: from, p_to: warsawToday() });

      expect(error).toBeNull();
      const report = data as {
        register: { opening_date: string; opening_balance: number };
        balance_before: number;
        documents: Array<{ number: string; amount: number; corrects_number: string | null; corrected_by_number: string | null }>;
      };
      expect({ date: report.register.opening_date, balance: Number(report.register.opening_balance) }).toEqual({ date: start, balance: 50 });
      expect(Number(report.balance_before)).toBe(150);
      expect(report.documents.map((d) => [d.number, Number(d.amount), d.corrects_number, d.corrected_by_number])).toEqual([
        [kp.number, 20, null, storno.number],
        [storno.number, -20, kp.number, null],
        [expect.stringMatching(/^KW\/1\//), 30, null, null],
      ]);

      const obcy = await signedIn('obcy', ORG_B);
      expect((await obcy.rpc('cash_report', { p_from: from, p_to: warsawToday() })).data).toMatchObject({ register: null });
    });
  });
});

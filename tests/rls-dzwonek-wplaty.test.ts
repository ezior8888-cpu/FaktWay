import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';

import { getRlsTestEnvironment } from './helpers/rls-environment';

/**
 * 00197 na prawdziwej bazie: wpis w dzwonku przy wpłacie do faktury (plan
 * kompletnej aplikacji, krok 8.1, część 3).
 *
 * Wpłaty zapisują prawdziwe RPC `record_invoice_payment` (00176) i
 * `mark_invoice_paid` (00158) z sesji użytkownika, a runner kolejki
 * `invoice.payment.received.bell` idzie przez prawdziwy PostgREST kluczem
 * serwisowym: odczyt wpłaty i faktury, zapis przez `app_notification_publish`
 * (00188) z UNIQUE jako kluczem idempotencji. Atrapa tylko podmienia klienta
 * serwisowego na klienta bazy testowej.
 *
 * Czerwień przed 00197 wynika z bazy: CHECK `app_notifications_kind_check`
 * z 00192 odrzuca rodzaj `payment_received`.
 */

const m = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => m.client }));

import { NonRetriableError } from '@/lib/jobs/errors';
import { runAppNotificationPaymentReceived } from '@/lib/jobs/runners/app-notifications';

const hasDatabase = Boolean(
  process.env.RLS_TEST_SUPABASE_URL?.trim() &&
    process.env.RLS_TEST_SUPABASE_ANON_KEY?.trim() &&
    process.env.RLS_TEST_SUPABASE_SERVICE_ROLE_KEY?.trim(),
);
const environment = hasDatabase ? getRlsTestEnvironment() : null;
const admin: SupabaseClient = environment
  ? createClient(environment.url, environment.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    })
  : (null as unknown as SupabaseClient);
m.client = admin;

const ORG = '00197197-0000-4000-8000-000000000001';
const OTHER_ORG = '00197197-0000-4000-8000-000000000002';
const EMAILS = {
  owner: 'rls-dzwonek-wplaty-owner@ksef-saas.test',
  member: 'rls-dzwonek-wplaty-member@ksef-saas.test',
  suspended: 'rls-dzwonek-wplaty-suspended@ksef-saas.test',
  other: 'rls-dzwonek-wplaty-other@ksef-saas.test',
} as const;
type Who = keyof typeof EMAILS;
const PASS = 'RlsDzwonekWplaty2026Aa!';
const NIP = '1234567890';
const NBSP = /[  ]/g;
const plain = (t: unknown) => String(t).replace(NBSP, ' ');

const users: Record<Who, string> = { owner: '', member: '', suspended: '', other: '' };
const sessions = new Map<string, SupabaseClient>();
let counter = 0;
let keyCounter = 0;

const ctx: JobContext = {
  attempt: 0,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  step: { run: async (_n, fn) => fn(), sleep: vi.fn(), sendEvent: vi.fn(), scheduleAfter: vi.fn() },
};

const run = (data: { invoiceId: string; paymentId?: string }) => runAppNotificationPaymentReceived(data, ctx);

function warsawToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw' }).format(new Date());
}

/** Klucz idempotencji wpłaty, jak `crypto.randomUUID()` w oknie „Zapisz wpłatę”. */
function key(): string {
  keyCounter += 1;
  return `00197197-4444-4000-8000-${String(keyCounter).padStart(12, '0')}`;
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

async function signedIn(who: Who, org: string = ORG): Promise<SupabaseClient> {
  const cached = sessions.get(`${who}:${org}`);
  if (cached) return cached;
  const client = createClient(environment!.url, environment!.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { 'x-active-org': org } },
  });
  const { error } = await client.auth.signInWithPassword({ email: EMAILS[who], password: PASS });
  if (error) throw error;
  sessions.set(`${who}:${org}`, client);
  return client;
}

/** Faktura sprzedaży przyjęta w KSeF: 1230 zł brutto, nic nie wpłacono. */
async function faktura(org: string = ORG): Promise<{ id: string; number: string }> {
  counter += 1;
  const id = `00197197-1111-4000-8000-${String(counter).padStart(12, '0')}`;
  const number = `FV/197/${counter}`;
  const { error } = await admin.from('invoices').insert({
    id,
    tenant_id: org,
    direction: 'outgoing',
    origin: 'app',
    internal_number: number,
    invoice_type: 'VAT',
    invoice_kind: 'regular',
    issue_date: '2026-11-02',
    payment_due_date: '2026-11-16',
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
    ksef_number: `${NIP}-20261102-${String(counter).padStart(12, '0')}-97`,
  });
  if (error) throw new Error(`insert ${number}: ${error.message}`);
  return { id, number };
}

/** Wpłata przez prawdziwe RPC z sesji (00176); zwraca identyfikator wpłaty. */
async function zapisz(who: Who, invoiceId: string, amount: number, org: string = ORG): Promise<string> {
  const { data, error } = await (await signedIn(who, org)).rpc('record_invoice_payment', {
    p_invoice_id: invoiceId,
    p_amount: amount,
    p_paid_on: warsawToday(),
    p_idempotency_key: key(),
    p_note: null,
  });
  if (error) throw error;
  expect(data).toMatchObject({ status: 'recorded' });
  return (data as { payment_id: string }).payment_id;
}

async function wpisy(objectKey: string) {
  const { data, error } = await admin
    .from('app_notifications')
    .select('tenant_id, user_id, kind, object_key, title, body, link, read_at')
    .eq('object_key', objectKey);
  if (error) throw error;
  return data ?? [];
}

async function cleanup() {
  for (const org of [ORG, OTHER_ORG]) {
    await admin.from('app_notifications').delete().eq('tenant_id', org);
    await admin.from('flo_proposals').delete().eq('tenant_id', org);
    await admin.from('payment_reminders').delete().eq('tenant_id', org);
    await admin.from('payments').delete().eq('tenant_id', org);
    await admin.from('invoices').delete().eq('tenant_id', org);
  }
}

describe.skipIf(!hasDatabase)('00197: wpis w dzwonku przy wpłacie do faktury na prawdziwym PostgREST', () => {
  beforeAll(async () => {
    for (const who of Object.keys(EMAILS) as Who[]) users[who] = await userId(EMAILS[who]);
    await cleanup();
    await admin.from('memberships').delete().in('organization_id', [ORG, OTHER_ORG]);
    // audit_logs jest tylko do dopisywania (00052) i zostaje po przebiegu, więc firmę dopisujemy.
    const tenants = await admin.from('tenants').upsert(
      [
        { id: ORG, nip: NIP, name: 'Firma Dzwonek Wpłaty 00197' },
        { id: OTHER_ORG, nip: NIP, name: 'Inna firma 00197' },
      ],
      { onConflict: 'id' },
    );
    if (tenants.error) throw tenants.error;
    const profiles = await admin
      .from('users')
      .upsert((Object.keys(users) as Who[]).map((who) => ({ id: users[who], name: who })), { onConflict: 'id' });
    if (profiles.error) throw profiles.error;
    const memberships = await admin.from('memberships').insert([
      { organization_id: ORG, user_id: users.owner, role: 'owner', status: 'active' },
      { organization_id: ORG, user_id: users.member, role: 'member', status: 'active' },
      { organization_id: ORG, user_id: users.suspended, role: 'member', status: 'suspended' },
      { organization_id: OTHER_ORG, user_id: users.other, role: 'owner', status: 'active' },
    ]);
    if (memberships.error) throw memberships.error;
  });

  afterAll(async () => {
    if (!hasDatabase) return;
    await cleanup();
    await admin.from('memberships').delete().in('organization_id', [ORG, OTHER_ORG]);
    await admin.from('tenants').delete().in('id', [ORG, OTHER_ORG]);
  });

  it('wpłata częściowa: wpis dla każdego aktywnego członka z kwotą i resztą; ponowienie nic nie dodaje', async () => {
    const { id: invoice, number } = await faktura();
    const payment = await zapisz('owner', invoice, 1000);

    await expect(run({ invoiceId: invoice, paymentId: payment })).resolves.toEqual({ created: 2 });
    // Ponowienie od zera: ten sam klucz (wpłata) trafia w UNIQUE z 00188.
    await expect(run({ invoiceId: invoice, paymentId: payment })).resolves.toEqual({ created: 0 });

    const rows = await wpisy(payment);
    expect(rows.map((r) => r.user_id).sort()).toEqual([users.owner, users.member].sort());
    for (const row of rows) {
      expect({ ...row, body: plain(row.body) }).toMatchObject({
        tenant_id: ORG,
        kind: 'payment_received',
        object_key: payment,
        title: 'Wpłata częściowa',
        body: `1000,00 zł za ${number} od Nabywca Testowy, pozostało do zapłaty 230,00 zł`,
        link: `/invoices/${invoice}`,
        read_at: null,
      });
    }

    // Dzwonek członka (RLS z 00188) pokazuje wpis; zawieszony nic nie dostał.
    const member = await signedIn('member');
    const bell = await member.from('app_notifications').select('kind, object_key');
    expect(bell.error).toBeNull();
    expect(bell.data).toEqual(expect.arrayContaining([{ kind: 'payment_received', object_key: payment }]));
    expect(rows.some((r) => r.user_id === users.suspended)).toBe(false);
  });

  it('druga wpłata zamyka fakturę: „Otrzymana płatność”; zadanie pierwszej, które ruszyło później, mówi o stanie po niej', async () => {
    const { id: invoice, number } = await faktura();
    const first = await zapisz('owner', invoice, 1000);
    const second = await zapisz('member', invoice, 230);

    // Kolejność zadań odwrotna (np. worker wstawał po wdrożeniu): pierwsze rusza po drugiej wpłacie.
    await run({ invoiceId: invoice, paymentId: first });
    await run({ invoiceId: invoice, paymentId: second });

    const [a] = await wpisy(first);
    const [b] = await wpisy(second);
    expect(a?.title).toBe('Wpłata częściowa');
    expect(plain(a?.body)).toBe(`1000,00 zł za ${number} od Nabywca Testowy, pozostało do zapłaty 230,00 zł`);
    expect(b?.title).toBe('Otrzymana płatność');
    expect(plain(b?.body)).toBe(`230,00 zł za ${number} od Nabywca Testowy, faktura opłacona w całości`);
  });

  it('„Zapłacone” jednym dotknięciem (00158): „Otrzymana płatność” na całą resztę', async () => {
    const { id: invoice, number } = await faktura();
    const { data, error } = await (await signedIn('owner')).rpc('mark_invoice_paid', { p_invoice_id: invoice, p_paid_on: null });
    expect(error).toBeNull();
    const payment = (data as { status: string; payment_id: string }).payment_id;

    await expect(run({ invoiceId: invoice, paymentId: payment })).resolves.toEqual({ created: 2 });
    const [row] = await wpisy(payment);
    expect(row?.title).toBe('Otrzymana płatność');
    expect(plain(row?.body)).toBe(`1230,00 zł za ${number} od Nabywca Testowy, faktura opłacona w całości`);
  });

  it('wpłata cofnięta albo usunięta, zanim zadanie ruszyło: bez wpisu', async () => {
    const { id: invoice } = await faktura();
    const voided = await zapisz('owner', invoice, 300);
    const cofnij = await (await signedIn('owner')).rpc('void_invoice_payment', { p_payment_id: voided });
    expect(cofnij.error).toBeNull();
    await expect(run({ invoiceId: invoice, paymentId: voided })).resolves.toEqual({ skipped: 'payment-voided' });
    expect(await wpisy(voided)).toEqual([]);

    // „Cofnij” przy „Zapłacone” usuwa wiersz wpłaty (undo_invoice_paid, 00158).
    const { id: marked } = await faktura();
    const owner = await signedIn('owner');
    const oznacz = await owner.rpc('mark_invoice_paid', { p_invoice_id: marked, p_paid_on: null });
    const removed = (oznacz.data as { payment_id: string }).payment_id;
    expect((await owner.rpc('undo_invoice_paid', { p_invoice_id: marked })).error).toBeNull();
    await expect(run({ invoiceId: marked, paymentId: removed })).resolves.toEqual({ skipped: 'payment-not-found' });
    expect(await wpisy(removed)).toEqual([]);
  });

  it('obca firma: wpłata i faktura z różnych firm w zdarzeniu to błąd bez ponowień; żadna firma nie dostaje wpisu', async () => {
    const { id: mine } = await faktura();
    const { id: foreign } = await faktura(OTHER_ORG);
    const myPayment = await zapisz('owner', mine, 100);
    const foreignPayment = await zapisz('other', foreign, 100, OTHER_ORG);

    await expect(run({ invoiceId: foreign, paymentId: myPayment })).rejects.toBeInstanceOf(NonRetriableError);
    await expect(run({ invoiceId: mine, paymentId: foreignPayment })).rejects.toBeInstanceOf(NonRetriableError);
    expect(await wpisy(myPayment)).toEqual([]);
    expect(await wpisy(foreignPayment)).toEqual([]);
  });

  // Nazwa ograniczenia w komunikacie: przypadek dowodzi CHECK-a z 00197.
  it('CHECK: payment_received przyjęty, rodzaje z 00188 i 00192 dalej przyjęte, nieznany odrzucony', async () => {
    const publish = (kind: string) =>
      admin.rpc('app_notification_publish', {
        p_tenant_id: OTHER_ORG,
        p_kind: kind,
        p_object_key: `rodzaj-${kind}`,
        p_title: 'Test rodzaju',
        p_body: null,
        p_link: null,
      });
    for (const kind of [
      'inbox_new',
      'invoice_accepted',
      'invoice_rejected',
      'tax_deadline',
      'expense_comment',
      'expense_document_request',
      'payment_received',
    ]) {
      const { data, error } = await publish(kind);
      expect(error, kind).toBeNull();
      expect(data, kind).toBe(1);
    }
    expect((await publish('cos_innego')).error?.message).toContain('app_notifications_kind_check');
  });
});

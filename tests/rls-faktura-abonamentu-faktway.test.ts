import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { buildSelfInvoiceDraft, insertSelfInvoice } from '@/lib/billing/self-invoice';
import { clearOperatorCache } from '@/lib/billing/operator-config';
import type { Invoice } from '@/types/invoice';

import { getRlsTestEnvironment } from './helpers/rls-environment';

/**
 * Faktura VAT za abonament pod nazwą FaktWay (00152) na prawdziwej bazie.
 *
 * `create_billing_vat_invoice` (00110) porównywała nazwę pozycji i uwagi
 * faktury z napisem „FaktFlow” co do znaku. Kod z nazwą FaktWay dostawał
 * odmowę, a klient płacący kartą — brak faktury. Po 00152:
 *
 *   - baza przyjmuje obie nazwy (worker sprzed wdrożenia wysyła jeszcze
 *     FaktFlow, nowy — FaktWay),
 *   - ponowienie inną nazwą zwraca TĘ SAMĄ fakturę, bez drugiej i bez
 *     nowego numeru; wystawiony dokument zostaje bez zmian,
 *   - dawna faktura bez powiązania z płatnością blokuje nową w obu nazwach,
 *   - każda inna różnica treści nadal odbija.
 *
 * Kod aplikacji (`buildSelfInvoiceDraft`, `insertSelfInvoice`, dane operatora)
 * idzie prawdziwą ścieżką — podmieniony jest tylko klient serwisowy, który
 * wskazuje lokalną bazę testową.
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

const db = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => db.client }));
db.client = admin;

// Losowe identyfikatory: faktury za abonament usuwa tylko należna retencja
// (00079), więc kolejny przebieg na tej samej bazie nie może na nie trafić.
const OPERATOR = randomUUID();
const CUSTOMER = randomUUID();
const RUN = randomUUID().replaceAll('-', '').slice(0, 12);
const STRIPE_CUSTOMER = `cus_rls${RUN}`;
const STRIPE_SUBSCRIPTION = `sub_rls${RUN}`;
const PAID_AT = '2026-10-02T10:00:00.000Z';
const GROSS_CENTS = 2999;

type Brand = 'FaktFlow' | 'FaktWay';
const LINE_BRAND = /^(FaktFlow|FaktWay) — subskrypcja /;
const NOTE_BRAND = /^Faktura za subskrypcję (FaktFlow|FaktWay)\. /;

interface Payment {
  id: string;
  stripeInvoiceId: string;
}

let subscriptionId = '';
let sequence = 0;

async function paidPayment(): Promise<Payment> {
  sequence += 1;
  const ref = `${RUN}${String(sequence).padStart(4, '0')}`;
  const payment = { id: randomUUID(), stripeInvoiceId: `in_rls${ref}` };
  const { error } = await admin.from('stripe_payments').insert({
    id: payment.id,
    tenant_id: CUSTOMER,
    subscription_id: subscriptionId,
    stripe_invoice_id: payment.stripeInvoiceId,
    stripe_payment_intent_id: `pi_rls${ref}`,
    stripe_charge_id: `ch_rls${ref}`,
    stripe_payment_refs_verified: true,
    status: 'succeeded',
    amount_cents: GROSS_CENTS,
    currency: 'pln',
    paid_at: PAID_AT,
    last_webhook_payload: {
      id: payment.stripeInvoiceId,
      status: 'paid',
      currency: 'pln',
      amount_paid: GROSS_CENTS,
      customer: STRIPE_CUSTOMER,
      subscription: STRIPE_SUBSCRIPTION,
    },
  });
  if (error) throw new Error(`insert payment: ${error.message}`);
  return payment;
}

async function draftFor(payment: Payment, plan: 'monthly' | 'annual' = 'monthly'): Promise<Invoice> {
  const draft = await buildSelfInvoiceDraft(CUSTOMER, {
    grossCents: GROSS_CENTS,
    paidAt: PAID_AT,
    stripeInvoiceId: payment.stripeInvoiceId,
    plan,
  });
  if (!draft) throw new Error('draft nie powstał');
  expect(draft.operator.tenantId).toBe(OPERATOR);
  return draft.invoice;
}

/** Ten sam draft z nazwą, którą wysyła worker sprzed albo po wdrożeniu. */
function withBrand(invoice: Invoice, brand: Brand): Invoice {
  const [line] = invoice.lines;
  expect(line.name).toMatch(LINE_BRAND);
  expect(invoice.notes).toMatch(NOTE_BRAND);
  return {
    ...invoice,
    lines: [{ ...line, name: line.name.replace(LINE_BRAND, `${brand} — subskrypcja `) }],
    notes: (invoice.notes ?? '').replace(NOTE_BRAND, `Faktura za subskrypcję ${brand}. `),
  };
}

function insert(invoice: Invoice, payment: Payment) {
  return insertSelfInvoice(invoice, OPERATOR, payment.stripeInvoiceId, payment.id, CUSTOMER);
}

async function storedInvoices(stripeInvoiceId: string) {
  const { data, error } = await admin.from('invoices')
    .select('id, internal_number, notes, fa3_data')
    .eq('tenant_id', OPERATOR)
    .eq('stripe_invoice_id', stripeInvoiceId);
  if (error) throw new Error(`read invoices: ${error.message}`);
  return data ?? [];
}

async function lineNames(invoiceId: string): Promise<string[]> {
  const { data, error } = await admin.from('invoice_line_items')
    .select('name')
    .eq('invoice_id', invoiceId);
  if (error) throw new Error(`read lines: ${error.message}`);
  return (data ?? []).map((row) => row.name as string);
}

async function linkedInvoice(payment: Payment): Promise<string | null> {
  const { data, error } = await admin.from('stripe_payments')
    .select('vat_invoice_id')
    .eq('id', payment.id)
    .single();
  if (error) throw new Error(`read payment: ${error.message}`);
  return data.vat_invoice_id as string | null;
}

async function cleanup() {
  await admin.from('stripe_payments').delete().eq('tenant_id', CUSTOMER);
  // Subskrypcję (bez zapisu dla serwisu, 00078) usuwa kaskada z firmy klienta.
  // Strażnik 00079 pozwala serwisowi usunąć fakturę za abonament tylko po
  // terminie retencji — ustawiamy go w przeszłości.
  await admin.from('invoices')
    .update({ scheduled_deletion_at: '2000-01-01T00:00:00.000Z' })
    .eq('tenant_id', OPERATOR);
  await admin.from('invoices').delete().eq('tenant_id', OPERATOR);
  await admin.from('tenants').delete().in('id', [OPERATOR, CUSTOMER]);
}

describe.skipIf(!hasDatabase)('faktura za abonament pod nazwą FaktWay (00152)', () => {
  beforeAll(async () => {
    const { error: tenantsError } = await admin.from('tenants').insert([
      { id: OPERATOR, nip: '1234567890', name: 'Operator Testowy' },
      { id: CUSTOMER, nip: '9876543210', name: 'Klient Testowy', stripe_customer_id: STRIPE_CUSTOMER },
    ]);
    if (tenantsError) throw new Error(`insert tenants: ${tenantsError.message}`);
    // Subskrypcje zapisuje tylko dzierżawa synchronizacji (00078), jak webhook.
    const { data: claim, error: claimError } = await admin
      .rpc('claim_stripe_subscription_sync', { p_subscription_id: STRIPE_SUBSCRIPTION })
      .single<{ claimed: boolean; claim_token: string; fence: number }>();
    if (claimError || !claim?.claimed) throw new Error(`claim subscription: ${claimError?.message ?? 'busy'}`);
    const { data: applied, error: applyError } = await admin.rpc('apply_stripe_subscription_sync', {
      p_subscription_id: STRIPE_SUBSCRIPTION,
      p_claim_token: claim.claim_token,
      p_fence: claim.fence,
      p_snapshot: {
        tenant_id: CUSTOMER,
        stripe_subscription_id: STRIPE_SUBSCRIPTION,
        stripe_customer_id: STRIPE_CUSTOMER,
        stripe_price_id: 'price_rls',
        status: 'active',
        plan: 'monthly',
        current_period_start: null,
        current_period_end: null,
        trial_start: null,
        trial_end: null,
        cancel_at_period_end: false,
        canceled_at: null,
      },
    });
    if (applyError || applied !== true) throw new Error(`apply subscription: ${applyError?.message ?? 'not written'}`);
    const { data, error } = await admin.from('subscriptions')
      .select('id')
      .eq('stripe_subscription_id', STRIPE_SUBSCRIPTION)
      .single();
    if (error) throw new Error(`read subscription: ${error.message}`);
    subscriptionId = data.id as string;
  });

  beforeEach(() => {
    vi.stubEnv('FAKTFLOW_OPERATOR_TENANT_ID', OPERATOR);
    clearOperatorCache();
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    if (!hasDatabase) return;
    await cleanup();
  });

  it('kod buduje fakturę z nazwą FaktWay, a baza ją wystawia', async () => {
    const payment = await paidPayment();
    const draft = await draftFor(payment);
    expect(draft.lines[0].name).toBe('FaktWay — subskrypcja miesięczna (październik 2026)');
    expect(draft.notes).toBe(`Faktura za subskrypcję FaktWay. Płatność Stripe: ${payment.stripeInvoiceId}.`);

    const result = await insert(draft, payment);

    expect(result.created).toBe(true);
    expect(result.internalNumber).toMatch(/^FF\/2026\/10\/\d{4}$/);
    const [invoice, ...rest] = await storedInvoices(payment.stripeInvoiceId);
    expect(rest).toEqual([]);
    expect(invoice.id).toBe(result.invoiceId);
    expect(invoice.notes).toBe(draft.notes);
    expect((invoice.fa3_data as Invoice).notes).toBe(draft.notes);
    expect(await lineNames(invoice.id as string)).toEqual([draft.lines[0].name]);
    expect(await linkedInvoice(payment)).toBe(result.invoiceId);
  });

  it.each<Brand>(['FaktWay', 'FaktFlow'])('baza przyjmuje nazwę %s (worker po i przed wdrożeniem)', async (brand) => {
    const payment = await paidPayment();
    const invoice = withBrand(await draftFor(payment), brand);

    const result = await insert(invoice, payment);

    expect(result.created).toBe(true);
    const [row] = await storedInvoices(payment.stripeInvoiceId);
    expect(row.notes).toBe(`Faktura za subskrypcję ${brand}. Płatność Stripe: ${payment.stripeInvoiceId}.`);
    expect(await lineNames(result.invoiceId)).toEqual([`${brand} — subskrypcja miesięczna (październik 2026)`]);
  });

  it.each<[Brand, Brand]>([
    ['FaktFlow', 'FaktWay'],
    ['FaktWay', 'FaktFlow'],
  ])('ponowienie: wystawiona jako %s, ponowiona jako %s — ta sama faktura, bez drugiej', async (first, retry) => {
    const payment = await paidPayment();
    const created = await insert(withBrand(await draftFor(payment), first), payment);
    expect(created.created).toBe(true);

    const again = await insert(withBrand(await draftFor(payment), retry), payment);

    expect(again).toEqual({ invoiceId: created.invoiceId, internalNumber: created.internalNumber, created: false });
    const rows = await storedInvoices(payment.stripeInvoiceId);
    expect(rows.map((row) => row.id)).toEqual([created.invoiceId]);
    // Wystawiony dokument się nie zmienia — zostaje nazwa z chwili wystawienia.
    expect(rows[0].notes).toBe(`Faktura za subskrypcję ${first}. Płatność Stripe: ${payment.stripeInvoiceId}.`);
    expect(await lineNames(created.invoiceId)).toEqual([`${first} — subskrypcja miesięczna (październik 2026)`]);
  });

  it('ponowienie z inną treścią niż nazwa produktu nadal odbija', async () => {
    const payment = await paidPayment();
    const created = await insert(withBrand(await draftFor(payment), 'FaktFlow'), payment);
    expect(created.created).toBe(true);

    // Ta sama płatność, ale plan roczny zamiast miesięcznego.
    const annual = withBrand(await draftFor(payment, 'annual'), 'FaktWay');
    await expect(insert(annual, payment)).rejects.toThrow('Existing VAT invoice requires reconciliation');

    expect((await storedInvoices(payment.stripeInvoiceId)).map((row) => row.id)).toEqual([created.invoiceId]);
  });

  it.each<[Brand, Brand]>([
    ['FaktFlow', 'FaktWay'],
    ['FaktWay', 'FaktFlow'],
  ])('dawna faktura bez powiązania (uwagi: %s) blokuje wystawienie jako %s', async (legacy, requested) => {
    const payment = await paidPayment();
    const legacyNumber = `FF/LEGACY/${sequence}`;
    const { error } = await admin.from('invoices').insert({
      tenant_id: OPERATOR, direction: 'outgoing', internal_number: legacyNumber, invoice_type: 'VAT',
      invoice_kind: 'regular', issue_date: '2026-10-02', seller_nip: '1234567890', buyer_nip: '9876543210',
      gross_total: 29.99, net_total: 24.38, vat_total: 5.61, ksef_status: 'draft',
      notes: `Faktura za subskrypcję ${legacy}. Płatność Stripe: ${payment.stripeInvoiceId}.`,
      fa3_data: { internalNumber: legacyNumber, type: 'VAT' },
      seller_data: { nip: '1234567890' }, buyer_data: { nip: '9876543210' },
    });
    if (error) throw new Error(`insert legacy invoice: ${error.message}`);

    await expect(insert(withBrand(await draftFor(payment), requested), payment))
      .rejects.toThrow('Existing or legacy VAT invoice requires reconciliation');

    expect(await storedInvoices(payment.stripeInvoiceId)).toEqual([]);
    expect(await linkedInvoice(payment)).toBeNull();
  });

  it('obca nazwa pozycji albo uwag nadal odbija', async () => {
    const payment = await paidPayment();
    const draft = await draftFor(payment);
    const foreignLine: Invoice = {
      ...draft,
      lines: [{ ...draft.lines[0], name: draft.lines[0].name.replace(LINE_BRAND, 'Inna Firma — subskrypcja ') }],
    };
    const foreignNote: Invoice = {
      ...withBrand(draft, 'FaktWay'),
      notes: `Faktura za subskrypcję Inna Firma. Płatność Stripe: ${payment.stripeInvoiceId}.`,
    };

    await expect(insert(foreignLine, payment)).rejects.toThrow('Billing VAT amount/line requires reconciliation');
    await expect(insert(foreignNote, payment)).rejects.toThrow('Billing VAT identity/date requires reconciliation');

    expect(await storedInvoices(payment.stripeInvoiceId)).toEqual([]);
  });

  // 00162: płatność BLIK to na fakturze forma „mobilna” (FA(3): 7), nie „karta”.
  async function blikDraftFor(payment: Payment): Promise<Invoice> {
    const draft = await buildSelfInvoiceDraft(CUSTOMER, {
      grossCents: GROSS_CENTS,
      paidAt: PAID_AT,
      stripeInvoiceId: payment.stripeInvoiceId,
      plan: 'monthly',
      paymentMethodType: 'blik',
    });
    if (!draft) throw new Error('draft nie powstał');
    return draft.invoice;
  }

  it('płatność BLIK: baza wystawia fakturę z formą „mobile”, a ponowienie zwraca tę samą', async () => {
    const payment = await paidPayment();
    const invoice = await blikDraftFor(payment);
    expect(invoice.payment.method).toBe('mobile');

    const created = await insert(invoice, payment);

    expect(created.created).toBe(true);
    const [row, ...rest] = await storedInvoices(payment.stripeInvoiceId);
    expect(rest).toEqual([]);
    expect((row.fa3_data as Invoice).payment.method).toBe('mobile');
    expect(await linkedInvoice(payment)).toBe(created.invoiceId);

    const again = await insert(invoice, payment);
    expect(again).toEqual({ invoiceId: created.invoiceId, internalNumber: created.internalNumber, created: false });
  });

  it('ponowienie z inną formą płatności niż na wystawionej fakturze odbija', async () => {
    const payment = await paidPayment();
    const invoice = await blikDraftFor(payment);
    const created = await insert(invoice, payment);
    expect(created.created).toBe(true);

    const asCard: Invoice = { ...invoice, payment: { ...invoice.payment, method: 'card' } };
    await expect(insert(asCard, payment)).rejects.toThrow('Existing VAT invoice requires reconciliation');

    expect((await storedInvoices(payment.stripeInvoiceId)).map((row) => row.id)).toEqual([created.invoiceId]);
  });

  it.each(['transfer', 'cash', 'other'] as const)('forma „%s” nadal odbija: abonament idzie tylko przez Stripe', async (method) => {
    const payment = await paidPayment();
    const draft = await draftFor(payment);
    const foreign: Invoice = { ...draft, payment: { ...draft.payment, method } };

    await expect(insert(foreign, payment)).rejects.toThrow('Billing VAT identity/date requires reconciliation');

    expect(await storedInvoices(payment.stripeInvoiceId)).toEqual([]);
  });
});

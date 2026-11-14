import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';

import { getRlsTestEnvironment } from './helpers/rls-environment';

/**
 * FZ-005 na prawdziwej bazie: `cron.retention-delete` a klucze, które
 * blokują usunięcie faktury. Korekta trzyma oryginał kluczem
 * `parent_invoice_id ... ON DELETE RESTRICT` (00012, 00118), koszt z KSeF
 * trzyma fakturę kluczem bez `ON DELETE` (00034, 00121). Przed naprawą
 * zadanie usuwało pliki całej paczki, a potem jeden DELETE paczki padał na
 * tych kluczach: pliki oryginału znikały, choć korekta się do niego
 * odwołuje, a pozostałe faktury zostawały jako wiersze bez plików.
 *
 * Runner idzie przez prawdziwy PostgREST kluczem serwisowym; atrapy tylko
 * dla magazynu plików i dziennika zdarzeń.
 */

const m = vi.hoisted(() => ({ client: null as unknown, pliki: [] as string[] }));
vi.mock('@/lib/supabase/server', () => ({ createAdminClient: () => m.client }));
vi.mock('@/lib/retention/invoice-files', () => ({
  collectInvoiceStorageKeys: async (_client: unknown, invoice: { id: string }) => ({ r2: [invoice.id], glacier: [], foreign: 0 }),
  deleteInvoiceStorage: async (keys: { r2: string[] }) => {
    m.pliki.push(...keys.r2);
    return keys.r2.length;
  },
}));
vi.mock('@/lib/audit/log-system', () => ({ logAuditSystem: async () => undefined }));

import { runRetentionDelete } from '@/lib/jobs/runners/retention-delete';

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

const ORG = '00500500-0000-4000-8000-000000000005';
const OWNER_EMAIL = 'rls-retencja-usuwanie-owner@ksef-saas.test';
const PASS = 'RlsRetencjaUsuwanie2026Aa!';
const PO_TERMINIE = '2020-01-01T00:00:00.000Z';
const PRZED_TERMINEM = '2099-01-01T00:00:00.000Z';
const DZIEN = 86_400_000;

const ctx: JobContext = {
  attempt: 0,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  step: { run: async (_n, fn) => fn(), sleep: vi.fn(), sendEvent: vi.fn(), scheduleAfter: vi.fn() },
};

let counter = 0;
const nextId = () => `00500500-0000-4000-8000-${String(++counter + 100).padStart(12, '0')}`;

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

async function faktura(fields: Record<string, unknown> = {}): Promise<string> {
  const id = nextId();
  const number = `FV/FZ005/${counter}`;
  const { error } = await admin.from('invoices').insert({
    id, tenant_id: ORG, direction: 'outgoing', internal_number: number, invoice_type: 'VAT',
    invoice_kind: 'regular', issue_date: '2016-01-15', seller_nip: '9480000014', buyer_nip: '1234567890',
    gross_total: 1230, net_total: 1000, vat_total: 230, ksef_status: 'draft',
    fa3_data: { internalNumber: number, type: 'VAT' }, seller_data: { nip: '9480000014' }, buyer_data: { nip: '1234567890' },
    scheduled_deletion_at: PO_TERMINIE,
    ...fields,
  });
  if (error) throw new Error(`insert ${number}: ${error.message}`);
  return id;
}

/** Korygowana faktura musi być przyjęta w KSeF (wyzwalacz korekty, 00118): jak w `rls-dzieci-faktur`. */
const przyjeta = (): Record<string, unknown> => ({
  ksef_status: 'accepted', ksef_environment: 'test', xml_storage_path: 'x.xml',
  ksef_number: `9480000014-20160115-${String(counter + 1).padStart(12, '0')}-00`,
});

const korekta = (rodzic: string, fields: Record<string, unknown> = {}) =>
  faktura({
    invoice_type: 'KOR', invoice_kind: 'correction', parent_invoice_id: rodzic,
    correction_reason: 'test', correction_type: 'before_after', gross_total: -123, net_total: -100, vat_total: -23,
    ...fields,
  });

async function cleanup() {
  // Korekty przed oryginałami (RESTRICT), koszty przed fakturami z KSeF.
  await admin.from('expenses').delete().eq('tenant_id', ORG);
  await admin.from('invoices').delete().eq('tenant_id', ORG).eq('invoice_kind', 'correction');
  await admin.from('invoices').delete().eq('tenant_id', ORG);
}

describe.skipIf(!hasDatabase)('FZ-005: retention-delete a korekty i koszty na prawdziwej bazie', () => {
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    await cleanup();
    await admin.from('tenants').delete().eq('id', ORG);
    const { error } = await admin.from('tenants').insert({ id: ORG, nip: '9480000014', name: 'Firma FZ-005' });
    if (error) throw error;
    const owner = await userId(OWNER_EMAIL);

    ids.oryginal = await faktura(przyjeta());
    ids.korektaPrzedTerminem = await korekta(ids.oryginal, { scheduled_deletion_at: PRZED_TERMINEM });
    ids.zwykla = await faktura();
    ids.zKosztem = await faktura({ direction: 'incoming', origin: 'ksef_inbox' });
    const { error: kosztError } = await admin.from('expenses').insert({
      id: nextId(), tenant_id: ORG, created_by: owner, source: 'ksef_inbox', ksef_invoice_id: ids.zKosztem,
      seller_name: 'Dostawca FZ-005', seller_nip: '1234567890', document_number: 'FV/KOSZT/1', document_type: 'invoice',
      issue_date: '2016-01-15', net_amount: 1000, vat_amount: 230, gross_amount: 1230, payment_split: false,
    });
    if (kosztError) throw new Error(`insert koszt: ${kosztError.message}`);
    ids.parzystyOryginal = await faktura(przyjeta());
    ids.parzystaKorekta = await korekta(ids.parzystyOryginal);
  });

  afterAll(async () => {
    if (!hasDatabase) return;
    await cleanup();
    await admin.from('tenants').delete().eq('id', ORG);
  });

  it('usuwa faktury bez blokad (korekta przed oryginałem), zablokowane zostają z plikami i odroczonym terminem', async () => {
    const start = Date.now();
    await expect(runRetentionDelete(ctx)).resolves.toBeTruthy();

    const { data, error } = await admin.from('invoices').select('id, scheduled_deletion_at').eq('tenant_id', ORG);
    if (error) throw error;
    const zostaly = new Map((data ?? []).map((r) => [r.id as string, Date.parse(r.scheduled_deletion_at as string)]));

    // Usunięte: zwykła faktura i para oryginał z korektą (obie po terminie).
    expect([...zostaly.keys()].sort()).toEqual([ids.oryginal, ids.korektaPrzedTerminem, ids.zKosztem].sort());
    expect(m.pliki.filter((p) => Object.values(ids).includes(p)).sort()).toEqual([ids.zwykla, ids.parzystyOryginal, ids.parzystaKorekta].sort());
    // Oryginał czeka do terminu swojej korekty, faktura z kosztem co najmniej 30 dni.
    expect(zostaly.get(ids.oryginal)).toBe(Date.parse(PRZED_TERMINEM));
    expect(zostaly.get(ids.zKosztem)!).toBeGreaterThanOrEqual(start + 29 * DZIEN);
  });
});

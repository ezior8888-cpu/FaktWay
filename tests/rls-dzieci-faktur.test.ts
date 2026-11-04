import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { loadTenantChildIds } from '@/lib/dashboard/receivables';

import { getRlsTestEnvironment } from './helpers/rls-environment';

/**
 * E3 (PLAN-FINORA §2.4 pkt 11) na prawdziwym PostgREST: należności, kafel
 * „Do zapłaty” i fakty wierszy listy pomijają faktury z „dzieckiem”
 * (korekta przez `parent_invoice_id`, ROZ przez `advance_invoice_ids`).
 * Filtr `advance_invoice_ids=not.eq.{}` był sprawdzony tylko w pamięci —
 * tu idzie przez prawdziwy PostgREST na kolumnie `uuid[] NOT NULL DEFAULT '{}'`.
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

const ORG = 'e3e3e3e3-0000-4000-8000-000000000003';
let counter = 0;

function nextId(): string {
  counter += 1;
  return `e3e3aaaa-0000-4000-8000-${String(counter).padStart(12, '0')}`;
}

type Extra = Record<string, unknown>;

async function insert(fields: Extra): Promise<string> {
  const id = nextId();
  const number = `FV/E3/${counter}`;
  const { error } = await admin.from('invoices').insert({
    id, tenant_id: ORG, direction: 'outgoing', internal_number: number, invoice_type: 'VAT',
    invoice_kind: 'regular', issue_date: '2026-10-01', seller_nip: '9480000014', buyer_nip: '1234567890',
    gross_total: 1230, net_total: 1000, vat_total: 230, ksef_status: 'draft',
    fa3_data: { internalNumber: number, type: 'VAT' }, seller_data: { nip: '9480000014' }, buyer_data: { nip: '1234567890' },
    ...fields,
  });
  if (error) throw new Error(`insert ${number}: ${error.message}`);
  return id;
}

function accepted(): Extra {
  return {
    ksef_status: 'accepted', ksef_environment: 'test', xml_storage_path: 'x.xml',
    ksef_number: `9480000014-20261001-${String(counter + 1).padStart(12, '0')}-00`,
  };
}

async function cleanup() {
  await admin.from('invoices').update({
    ksef_status: 'draft', ksef_send_owner: null, submitted_to_ksef_at: null, last_attempt_at: null,
    ksef_number: null, ksef_accepted_at: null, xml_storage_path: null, ksef_environment: null,
  }).eq('tenant_id', ORG).neq('ksef_status', 'accepted');
  await admin.from('invoices').delete().eq('tenant_id', ORG).eq('invoice_kind', 'correction');
  await admin.from('invoices').delete().eq('tenant_id', ORG).eq('invoice_kind', 'final');
  await admin.from('invoices').delete().eq('tenant_id', ORG);
  await admin.from('audit_logs').delete().eq('tenant_id', ORG);
}

describe.skipIf(!hasDatabase)('E3: dzieci faktur (korekta, ROZ) z prawdziwego PostgREST', () => {
  beforeAll(async () => {
    await cleanup();
    await admin.from('tenants').delete().eq('id', ORG);
    const { error } = await admin.from('tenants').insert({ id: ORG, nip: '9480000014', name: 'Firma E3' });
    if (error) throw error;
  });

  beforeEach(async () => {
    await cleanup();
  });

  afterAll(async () => {
    if (!hasDatabase) return;
    await cleanup();
    await admin.from('tenants').delete().eq('id', ORG);
  });

  it('korygowana faktura i rozliczona zaliczka są dziećmi; zwykła faktura bez dzieci nie', async () => {
    const corrected = await insert(accepted());
    await insert({
      invoice_type: 'KOR', invoice_kind: 'correction', parent_invoice_id: corrected,
      correction_reason: 'test', correction_type: 'before_after',
      gross_total: -123, net_total: -100, vat_total: -23,
    });
    const advance = await insert({
      ...accepted(), invoice_type: 'ZAL', invoice_kind: 'advance', advance_amount: 1230,
    });
    await insert({ invoice_type: 'ROZ', invoice_kind: 'final', advance_invoice_ids: [advance] });
    const plain = await insert(accepted());

    const childIds = await loadTenantChildIds(
      admin as unknown as Parameters<typeof loadTenantChildIds>[0],
      ORG,
    );

    expect(childIds.has(corrected)).toBe(true);
    expect(childIds.has(advance)).toBe(true);
    expect(childIds.has(plain)).toBe(false);
    expect(childIds.size).toBe(2);
  });

  it('pusta tablica `advance_invoice_ids` (domyślna) nie daje dzieci', async () => {
    await insert(accepted());
    await insert(accepted());

    const childIds = await loadTenantChildIds(
      admin as unknown as Parameters<typeof loadTenantChildIds>[0],
      ORG,
    );

    expect(childIds.size).toBe(0);
  });
});

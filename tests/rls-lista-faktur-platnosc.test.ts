import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { receivableBaseFilterOps } from '@/lib/dashboard/receivables';
import {
  orFilterString,
  paymentFilterSpec,
  searchOrFilter,
  type InvoicePaymentFilter,
} from '@/lib/invoices/list-query';

import { getRlsTestEnvironment } from './helpers/rls-environment';

/**
 * E3 / C1 (PLAN-FINORA §2.4 pkt 11) na prawdziwym PostgREST: filtr płatności
 * listy faktur niesie warunki faktury z pkt 11 — w tym dwa `or()` (pary
 * rodzaj → typ, waluta PLN albo brak) obok `or()` wyszukiwania. Testy
 * jednostkowe sprawdzają kształt warunków; tu PostgREST naprawdę je parsuje
 * i łączy kilka parametrów `or` przez AND.
 *
 * Pętla `applyOps` powtarza `switch` z `app/(dashboard)/invoices/page.tsx`.
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

const ORG = 'e3e3e3e3-0000-4000-8000-0000000000c1';
const TODAY = '2026-10-17';
let counter = 0;

type Extra = Record<string, unknown>;

/** Wstawia fakturę po terminie (termin 01.10, nic nie wpłacono) i zwraca jej numer. */
async function insert(label: string, fields: Extra): Promise<string> {
  counter += 1;
  const id = `e3e3c1c1-0000-4000-8000-${String(counter).padStart(12, '0')}`;
  const { error } = await admin.from('invoices').insert({
    id, tenant_id: ORG, direction: 'outgoing', internal_number: label, invoice_type: 'VAT',
    invoice_kind: 'regular', issue_date: '2026-09-15', payment_due_date: '2026-10-01',
    seller_nip: '9480000014', buyer_nip: '1234567890',
    gross_total: 1230, net_total: 1000, vat_total: 230, ksef_status: 'draft',
    fa3_data: { internalNumber: label, type: 'VAT' }, seller_data: { nip: '9480000014' },
    buyer_data: { nip: '1234567890', name: 'Nabywca E3' },
    ...fields,
  });
  if (error) throw new Error(`insert ${label}: ${error.message}`);
  return id;
}

function accepted(env = 'test'): Extra {
  return {
    ksef_status: 'accepted', ksef_environment: env, xml_storage_path: 'x.xml',
    ksef_number: `9480000014-20260915-${String(counter + 1).padStart(12, '0')}-00`,
  };
}

async function listNumbers(payment: InvoicePaymentFilter, q = ''): Promise<string[]> {
  let query = admin.from('invoices').select('internal_number').eq('tenant_id', ORG).eq('direction', 'outgoing');
  const ops = paymentFilterSpec(payment, TODAY, () => receivableBaseFilterOps('test')) ?? [];
  for (const cond of ops) {
    switch (cond.op) {
      case 'eq':
        query = query.eq(cond.column, cond.value);
        break;
      case 'neq':
        query = query.neq(cond.column, cond.value);
        break;
      case 'lt':
        query = query.lt(cond.column, cond.value);
        break;
      case 'gt':
        query = query.gt(cond.column, cond.value);
        break;
      case 'gte':
        query = query.gte(cond.column, cond.value);
        break;
      case 'in':
        query = query.in(cond.column, [...cond.value]);
        break;
      case 'or':
        query = query.or(orFilterString(cond.anyOf));
        break;
    }
  }
  const search = searchOrFilter(q);
  if (search) query = query.or(search);
  const { data, error } = await query.order('internal_number', { ascending: true });
  if (error) throw new Error(`lista: ${error.message}`);
  return (data ?? []).map((row) => String(row.internal_number));
}

async function cleanup() {
  await admin.from('invoices').update({
    ksef_status: 'draft', ksef_send_owner: null, submitted_to_ksef_at: null, last_attempt_at: null,
    ksef_number: null, ksef_accepted_at: null, xml_storage_path: null, ksef_environment: null,
  }).eq('tenant_id', ORG).neq('ksef_status', 'accepted');
  await admin.from('invoices').delete().eq('tenant_id', ORG).eq('invoice_kind', 'correction');
  await admin.from('invoices').delete().eq('tenant_id', ORG);
  await admin.from('audit_logs').delete().eq('tenant_id', ORG);
}

describe.skipIf(!hasDatabase)('E3 / C1: filtr płatności listy faktur na prawdziwym PostgREST', () => {
  beforeAll(async () => {
    await cleanup();
    await admin.from('tenants').delete().eq('id', ORG);
    const { error } = await admin.from('tenants').insert({ id: ORG, nip: '9480000014', name: 'Firma E3 C1' });
    if (error) throw error;
  });

  beforeEach(async () => {
    await cleanup();
    const parent = await insert('A-VAT', accepted());
    await insert('B-ZAL', { ...accepted(), invoice_type: 'ZAL', invoice_kind: 'advance', advance_amount: 1230 });
    await insert('C-SZKIC', {});
    await insert('D-IMPORT', { ...accepted(), origin: 'ksef_import' });
    await insert('E-EUR', { ...accepted(), currency: 'EUR' });
    await insert('F-PROD', accepted('production'));
    await insert('G-KOR', {
      invoice_type: 'KOR', invoice_kind: 'correction', parent_invoice_id: parent,
      correction_reason: 'test', correction_type: 'before_after',
      gross_total: -123, net_total: -100, vat_total: -23,
    });
  });

  afterAll(async () => {
    if (!hasDatabase) return;
    await cleanup();
    await admin.from('tenants').delete().eq('id', ORG);
  });

  it('„po terminie” i „nieopłacone”: tylko sprzedaż z aplikacji, przyjęta w tym środowisku, w PLN', async () => {
    expect(await listNumbers('po_terminie')).toEqual(['A-VAT', 'B-ZAL']);
    expect(await listNumbers('nieoplacone')).toEqual(['A-VAT', 'B-ZAL']);
  });

  it('bez filtra płatności lista pokazuje wszystkie faktury sprzedaży', async () => {
    expect(await listNumbers('wszystkie')).toEqual([
      'A-VAT', 'B-ZAL', 'C-SZKIC', 'D-IMPORT', 'E-EUR', 'F-PROD', 'G-KOR',
    ]);
  });

  it('`or()` wyszukiwania łączy się z `or()` filtra przez AND', async () => {
    expect(await listNumbers('po_terminie', 'ZAL')).toEqual(['B-ZAL']);
    expect(await listNumbers('po_terminie', 'IMPORT')).toEqual([]);
  });
});

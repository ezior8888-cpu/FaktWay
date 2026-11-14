import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';

import { getRlsTestEnvironment } from './helpers/rls-environment';

/**
 * 00205 na prawdziwej bazie (ustalenie 738u1 z obchodu M9 aplikacji mobilnej):
 * koszt, którego sprzedawca pasuje do reguły globalnej (`kpir_global_rules`
 * z 00034: Stacja, Orlen, Hotel, Allegro... albo NIP z listy), zapisuje się
 * w `expenses` po jednym odczycie.
 *
 * Runner `runProcessOcr` idzie przez prawdziwy PostgREST kluczem serwisowym:
 * zadanie OCR, członkostwo autora, kategoryzacja (reguły firmy i reguły
 * globalne z bazy), zapis kosztu, oznaczenie zadania, karta FLO. Atrapy tylko
 * dla wyjść poza bazę: odczyt modelu (Anthropic), pobranie zdjęcia (S3),
 * budżet AI (Redis) i push.
 *
 * Czerwień przed 00205 wynika z bazy: enum `categorization_method` z 00034 nie
 * zna `rule_global_keyword` ani `rule_global_nip`, więc INSERT kosztu pada
 * 22P02, a job ponawia się i za każdym razem płaci za odczyt od nowa.
 */

const m = vi.hoisted(() => ({ client: null as unknown, doc: null as unknown, ocrCalls: 0 }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => m.client }));
vi.mock('@/lib/ocr/engine', () => ({
  extractInvoiceFromImage: async () => {
    m.ocrCalls += 1;
    return { success: true, data: m.doc, inputTokens: 1200, outputTokens: 300, processingTimeMs: 5, modelUsed: 'atrapa' };
  },
}));
vi.mock('@/lib/storage/expenses', () => ({
  downloadExpensePhoto: async () => ({ buffer: Buffer.from('jpg'), mimeType: 'image/jpeg' }),
}));
vi.mock('@/lib/ai/tenant-ai-budget', () => ({
  checkTenantAiBudget: async () => ({ allowed: true }),
  recordTenantAiUsage: async () => undefined,
}));
vi.mock('@/lib/push/sender', () => ({ sendPushToUser: vi.fn(async () => undefined) }));

import { CATEGORIZATION_METHODS } from '@/lib/categorization/methods';
import { runProcessOcr } from '@/lib/jobs/runners/process-ocr';

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

const ORG = '00205205-0000-4000-8000-000000000001';
const EMAIL = 'rls-kategoryzacja-globalna-owner@ksef-saas.test';
const PASS = 'RlsKategoryzacjaGlobalna2026Aa!';
/** Fikcyjny NIP z AGENTS.md; reguła globalna z nim istnieje tylko w czasie testu. */
const NIP = '1234567890';

let owner = '';
let counter = 0;

const ctx: JobContext = {
  attempt: 0,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  step: { run: async (_n, fn) => fn(), sleep: vi.fn(), sendEvent: vi.fn(), scheduleAfter: vi.fn() },
};

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

/** Zadanie OCR po wgraniu zdjęcia, jak `acceptExpenseUpload`. */
async function zadanieOcr(): Promise<string> {
  counter += 1;
  const id = `00205205-1111-4000-8000-${String(counter).padStart(12, '0')}`;
  const { error } = await admin.from('ocr_jobs').insert({
    id,
    tenant_id: ORG,
    created_by: owner,
    status: 'pending',
    source_file_path: `${ORG}/expenses/${id}.jpg`,
    source_file_mime: 'image/jpeg',
  });
  if (error) throw new Error(`insert ocr_jobs ${counter}: ${error.message}`);
  return id;
}

/** Odczyt modelu: paragon albo faktura w złotych. */
function odczyt(fields: Record<string, unknown>) {
  return {
    seller_name: 'Sprzedawca',
    seller_nip: null,
    seller_address: null,
    document_number: `P/205/${counter}`,
    document_type: 'receipt',
    issue_date: '2026-11-10',
    net_amount: 162.6,
    vat_amount: 37.4,
    gross_amount: 200,
    vat_rate: '23',
    line_items: null,
    ocr_confidence: 0.97,
    notes: null,
    ...fields,
  };
}

async function kosztZadania(ocrJobId: string) {
  const { data, error } = await admin
    .from('expenses')
    .select('id, categorization_method, category_label, kpir_column, source')
    .eq('tenant_id', ORG)
    .eq('ocr_job_id', ocrJobId);
  if (error) throw error;
  return data ?? [];
}

async function stanZadania(ocrJobId: string) {
  const { data, error } = await admin.from('ocr_jobs').select('status, expense_id').eq('id', ocrJobId).single();
  if (error) throw error;
  return data as { status: string; expense_id: string | null };
}

async function cleanup() {
  await admin.from('flo_proposals').delete().eq('tenant_id', ORG);
  await admin.from('ocr_jobs').delete().eq('tenant_id', ORG);
  await admin.from('expenses').delete().eq('tenant_id', ORG);
}

describe.skipIf(!hasDatabase)('koszt z regułą globalną (00205)', () => {
  beforeAll(async () => {
    owner = await userId(EMAIL);
    await cleanup();
    await admin.from('memberships').delete().eq('organization_id', ORG);
    // Wpisy audytu zostają po przebiegu (00052), więc firma też: upsert zamiast kasowania.
    const tenant = await admin.from('tenants').upsert({ id: ORG, nip: NIP, name: 'Firma Reguły Globalne' }, { onConflict: 'id' });
    if (tenant.error) throw tenant.error;
    const profile = await admin.from('users').upsert({ id: owner, name: 'owner' }, { onConflict: 'id' });
    if (profile.error) throw profile.error;
    const membership = await admin
      .from('memberships')
      .insert({ organization_id: ORG, user_id: owner, role: 'owner', status: 'active' });
    if (membership.error) throw membership.error;
    await admin.from('kpir_global_rules').delete().eq('nip', NIP);
    const rule = await admin
      .from('kpir_global_rules')
      .insert({ nip: NIP, kpir_column: 'col_13', category_label: 'Energia elektryczna', notes: 'test 00205' });
    if (rule.error) throw rule.error;
  });

  beforeEach(async () => {
    await cleanup();
    m.ocrCalls = 0;
  });

  afterAll(async () => {
    if (!hasDatabase) return;
    await cleanup();
    await admin.from('kpir_global_rules').delete().eq('nip', NIP);
    await admin.from('memberships').delete().eq('organization_id', ORG);
  });

  it('paragon ze stacji paliw (słowo „Stacja” z reguł globalnych) zapisuje się po jednym odczycie', async () => {
    const ocrJobId = await zadanieOcr();
    m.doc = odczyt({ seller_name: 'Stacja Paliw Testowa sp. z o.o.' });

    const result = await runProcessOcr({ ocrJobId, tenantId: ORG }, ctx);

    expect(result).toMatchObject({ success: true });
    const koszty = await kosztZadania(ocrJobId);
    expect(koszty).toHaveLength(1);
    expect(koszty[0]).toMatchObject({
      categorization_method: 'rule_global_keyword',
      category_label: 'Paliwo',
      kpir_column: 'col_13',
      source: 'ocr_photo',
    });
    expect(await stanZadania(ocrJobId)).toEqual({ status: 'completed', expense_id: koszty[0].id });
    expect(m.ocrCalls).toBe(1);
  });

  it('faktura od sprzedawcy z NIP-em w regułach globalnych zapisuje się po jednym odczycie', async () => {
    const ocrJobId = await zadanieOcr();
    m.doc = odczyt({
      seller_name: 'Dostawca Prądu Testowy',
      seller_nip: NIP,
      document_type: 'invoice',
      document_number: `FV/205/${counter}`,
    });

    const result = await runProcessOcr({ ocrJobId, tenantId: ORG }, ctx);

    expect(result).toMatchObject({ success: true });
    const koszty = await kosztZadania(ocrJobId);
    expect(koszty).toHaveLength(1);
    expect(koszty[0]).toMatchObject({
      categorization_method: 'rule_global_nip',
      category_label: 'Energia elektryczna',
      kpir_column: 'col_13',
    });
    expect(await stanZadania(ocrJobId)).toEqual({ status: 'completed', expense_id: koszty[0].id });
    expect(m.ocrCalls).toBe(1);
  });

  // Obie drogi zapisu kosztu (process-ocr i auto-categorize-inbox dla faktur
  // z KSeF) wstawiają wynik klasyfikatora wprost do tej kolumny.
  it.each(CATEGORIZATION_METHODS)('baza przyjmuje koszt z metodą %s, którą może zwrócić klasyfikator', async (method) => {
    counter += 1;
    const { error } = await admin.from('expenses').insert({
      tenant_id: ORG,
      created_by: owner,
      source: 'manual',
      seller_name: `Dostawca ${counter}`,
      document_number: `FV/205/${counter}`,
      document_type: 'invoice',
      issue_date: '2026-11-10',
      net_amount: 100,
      vat_amount: 23,
      gross_amount: 123,
      kpir_column: 'col_13',
      category_label: 'Pozostałe wydatki',
      categorization_method: method,
      categorization_confidence: 0.9,
    });

    expect(error).toBeNull();
  });
});

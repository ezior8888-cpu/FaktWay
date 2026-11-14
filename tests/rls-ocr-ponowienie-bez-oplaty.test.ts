import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';

import { getRlsTestEnvironment } from './helpers/rls-environment';

/**
 * Ponowienie joba OCR nie płaci drugi raz za odczyt (ustalenie 738u1-u2
 * z przeglądu PR #762, 14.11.2026).
 *
 * pg-boss wykonuje cały handler od nowa (`lib/jobs/step-shim.ts`, bez pamięci
 * kroków). Odczyt modelu trafiał do `ocr_jobs.extracted_data` dopiero przy
 * zakończeniu zadania, więc każdy błąd PO odczycie (kurs NBP, kategoryzacja,
 * zapis kosztu) kończył się ponowieniem z nowym, płatnym odczytem i drugim
 * zużyciem budżetu AI firmy. Kolejka `ocr.process-photo` ma 2 ponowienia,
 * czyli do 3 odczytów za jedno zdjęcie.
 *
 * Runner `runProcessOcr` idzie przez prawdziwy PostgREST kluczem serwisowym.
 * Atrapy tylko dla wyjść poza bazę: model (Anthropic), S3, budżet AI (Redis),
 * push, kurs NBP (HTTP) i, w jednym przypadku, zerwane połączenie z bazą
 * przy zapisie kosztu.
 *
 * Skoro job czyta zapisany odczyt jako dane kosztu, klient nie może go
 * zmieniać: 00206 odbiera rolom klienta UPDATE na `ocr_jobs` (polityka
 * `ocr_jobs_update_own_tenant` z 00034 pozwalała członkowi firmy wpisać
 * własne kwoty jako „odczyt modelu”).
 */

const m = vi.hoisted(() => ({
  client: null as unknown,
  doc: null as unknown,
  ocrCalls: 0,
  budgetOcrCalls: 0,
  usageRecords: 0,
  failExpenseInserts: 0,
  nbp: [] as Array<'throw' | 'rate'>,
}));

/** Prawdziwy klient bazy testowej; opcjonalnie zerwane połączenie przy INSERT do `expenses`. */
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () =>
    new Proxy(m.client as object, {
      get(target, prop) {
        if (prop === 'from') {
          return (table: string) => {
            const builder = (target as SupabaseClient).from(table);
            if (table !== 'expenses' || m.failExpenseInserts === 0) return builder;
            return new Proxy(builder, {
              get(b, p) {
                if (p === 'insert') {
                  return () => {
                    m.failExpenseInserts -= 1;
                    const res = { data: null, error: { code: '08006', message: 'atrapa: połączenie z bazą zerwane' } };
                    return { select: () => ({ single: async () => res }) };
                  };
                }
                const v = Reflect.get(b, p);
                return typeof v === 'function' ? v.bind(b) : v;
              },
            });
          };
        }
        const v = Reflect.get(target, prop);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    }),
}));
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
  checkTenantAiBudget: async (_tenantId: string, kind: string) => {
    if (kind === 'ocr') m.budgetOcrCalls += 1;
    return { allowed: true };
  },
  recordTenantAiUsage: async () => {
    m.usageRecords += 1;
  },
}));
vi.mock('@/lib/push/sender', () => ({ sendPushToUser: vi.fn(async () => undefined) }));
vi.mock('@/lib/nbp/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/nbp/client')>()),
  nbpRateForCost: async () => {
    const next = m.nbp.shift() ?? 'rate';
    if (next === 'throw') throw new Error('atrapa: fetch failed (api.nbp.pl)');
    return {
      found: true,
      rate: { currency: 'EUR', mid: 4.25, tableNo: '217/A/NBP/2026', effectiveDate: '2026-11-09' },
      gapDays: 1,
    };
  },
}));

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

const ORG = '73807380-0000-4000-8000-000000000002';
const EMAIL = 'rls-ocr-ponowienie-owner@ksef-saas.test';
const PASS = 'RlsOcrPonowienie2026Aa!';
const NIP = '1234567890';

let owner = '';
let counter = 0;

const ctx = (attempt: number): JobContext => ({
  attempt,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  step: { run: async (_n, fn) => fn(), sleep: vi.fn(), sendEvent: vi.fn(), scheduleAfter: vi.fn() },
});

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
async function zadanieOcr(fields: Record<string, unknown> = {}): Promise<string> {
  counter += 1;
  const id = `73807380-1111-4000-8000-${String(counter).padStart(12, '0')}`;
  const { error } = await admin.from('ocr_jobs').insert({
    id,
    tenant_id: ORG,
    created_by: owner,
    status: 'pending',
    source_file_path: `${ORG}/expenses/${id}.jpg`,
    source_file_mime: 'image/jpeg',
    ...fields,
  });
  if (error) throw new Error(`insert ocr_jobs ${counter}: ${error.message}`);
  return id;
}

/**
 * Odczyt modelu: paragon ze sklepu biurowego. Kategorię daje heurystyka
 * („biurowe”), bez reguł globalnych i bez modelu klasyfikatora.
 */
function odczyt(fields: Record<string, unknown> = {}) {
  return {
    seller_name: 'Sklep Biurowe Centrum',
    seller_nip: null,
    seller_address: null,
    document_number: `P/738/${counter}`,
    document_type: 'receipt',
    issue_date: '2026-11-10',
    net_amount: 81.3,
    vat_amount: 18.7,
    gross_amount: 100,
    vat_rate: '23',
    line_items: null,
    ocr_confidence: 0.97,
    notes: null,
    ...fields,
  };
}

/** Dwa przebiegi jak w pg-boss: pierwszy pada, drugi (ponowienie) od zera. */
async function dwaPrzebiegi(ocrJobId: string): Promise<{ first: unknown; second: unknown }> {
  let first: unknown = null;
  try {
    await runProcessOcr({ ocrJobId, tenantId: ORG }, ctx(0));
  } catch (e) {
    first = e;
  }
  const second = await runProcessOcr({ ocrJobId, tenantId: ORG }, ctx(1));
  return { first, second };
}

async function kosztyZadania(ocrJobId: string) {
  const { data, error } = await admin
    .from('expenses')
    .select('id, seller_name, gross_amount, category_label, ocr_extracted_data')
    .eq('tenant_id', ORG)
    .eq('ocr_job_id', ocrJobId);
  if (error) throw error;
  return data ?? [];
}

async function zadanie(ocrJobId: string) {
  const { data, error } = await admin
    .from('ocr_jobs')
    .select('status, expense_id, ai_input_tokens, ai_output_tokens, ai_model_used, extracted_data')
    .eq('id', ocrJobId)
    .single();
  if (error) throw error;
  return data as {
    status: string;
    expense_id: string | null;
    ai_input_tokens: number | null;
    ai_output_tokens: number | null;
    ai_model_used: string | null;
    extracted_data: Record<string, unknown> | null;
  };
}

async function cleanup() {
  await admin.from('flo_proposals').delete().eq('tenant_id', ORG);
  await admin.from('ocr_jobs').delete().eq('tenant_id', ORG);
  await admin.from('expenses').delete().eq('tenant_id', ORG);
}

describe.skipIf(!hasDatabase)('ponowienie OCR bez drugiego płatnego odczytu (738u1-u2)', () => {
  beforeAll(async () => {
    owner = await userId(EMAIL);
    await cleanup();
    await admin.from('memberships').delete().eq('organization_id', ORG);
    // Wpisy audytu zostają po przebiegu (00052), więc firma też: upsert zamiast kasowania.
    const tenant = await admin.from('tenants').upsert({ id: ORG, nip: NIP, name: 'Firma Ponowienie OCR' }, { onConflict: 'id' });
    if (tenant.error) throw tenant.error;
    const profile = await admin.from('users').upsert({ id: owner, name: 'owner' }, { onConflict: 'id' });
    if (profile.error) throw profile.error;
    const membership = await admin
      .from('memberships')
      .insert({ organization_id: ORG, user_id: owner, role: 'owner', status: 'active' });
    if (membership.error) throw membership.error;
  });

  beforeEach(async () => {
    await cleanup();
    m.ocrCalls = 0;
    m.budgetOcrCalls = 0;
    m.usageRecords = 0;
    m.failExpenseInserts = 0;
    m.nbp = [];
  });

  afterAll(async () => {
    if (!hasDatabase) return;
    await cleanup();
    await admin.from('memberships').delete().eq('organization_id', ORG);
  });

  it('kurs NBP chwilowo niedostępny: ponowienie zapisuje koszt z zapisanego odczytu, bez drugiego płatnego odczytu', async () => {
    const ocrJobId = await zadanieOcr();
    m.doc = odczyt({ seller_name: 'Sklep Biurowe Berlin', currency: 'EUR' });
    m.nbp = ['throw', 'rate'];

    const { first, second } = await dwaPrzebiegi(ocrJobId);

    expect(String(first)).toContain('fetch failed');
    expect(second).toMatchObject({ success: true });
    expect(m.ocrCalls).toBe(1);
    expect(m.budgetOcrCalls).toBe(1);
    expect(m.usageRecords).toBe(1);
    const koszty = await kosztyZadania(ocrJobId);
    expect(koszty).toHaveLength(1);
    // 100 EUR po 4,25 zł z tabeli NBP z dnia przed dokumentem.
    expect(koszty[0]).toMatchObject({ seller_name: 'Sklep Biurowe Berlin', gross_amount: 425 });
    const stan = await zadanie(ocrJobId);
    expect(stan).toMatchObject({ status: 'completed', expense_id: koszty[0].id, ai_input_tokens: 1200, ai_output_tokens: 300 });
    expect(stan.extracted_data).toMatchObject({ seller_name: 'Sklep Biurowe Berlin', currency: 'EUR', gross_amount: 100 });
  });

  it('zerwane połączenie przy zapisie kosztu: ponowienie bez drugiego płatnego odczytu', async () => {
    const ocrJobId = await zadanieOcr();
    m.doc = odczyt();
    m.failExpenseInserts = 1;

    const { first, second } = await dwaPrzebiegi(ocrJobId);

    expect(String(first)).toContain('połączenie z bazą zerwane');
    expect(second).toMatchObject({ success: true });
    expect(m.ocrCalls).toBe(1);
    expect(m.budgetOcrCalls).toBe(1);
    expect(m.usageRecords).toBe(1);
    const koszty = await kosztyZadania(ocrJobId);
    expect(koszty).toHaveLength(1);
    expect(koszty[0]).toMatchObject({ seller_name: 'Sklep Biurowe Centrum', gross_amount: 100, category_label: 'Materiały biurowe' });
    expect(await zadanie(ocrJobId)).toMatchObject({ status: 'completed', expense_id: koszty[0].id, ai_input_tokens: 1200 });
  });

  it('klient (sesja członka firmy) nie zmienia odczytu ani stanu zadania OCR (00206)', async () => {
    const ocrJobId = await zadanieOcr();
    const client = createClient(environment!.url, environment!.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { headers: { 'x-active-org': ORG } },
    });
    const { error: signInError } = await client.auth.signInWithPassword({ email: EMAIL, password: PASS });
    if (signInError) throw signInError;
    // Zadanie jest widoczne dla firmy (odczyt stanu po wgraniu zostaje).
    const visible = await client.from('ocr_jobs').select('id').eq('id', ocrJobId);
    expect(visible.error).toBeNull();
    expect(visible.data).toHaveLength(1);

    const forged = await client
      .from('ocr_jobs')
      .update({ extracted_data: odczyt({ gross_amount: 99999 }), status: 'processing' })
      .eq('id', ocrJobId)
      .select('id');

    expect(forged.error?.code).toBe('42501');
    expect(await zadanie(ocrJobId)).toMatchObject({ status: 'pending', extracted_data: null });
  });

  it('zapisany odczyt, którego schemat nie przyjmuje: nowy odczyt i koszt z niego', async () => {
    // Np. odczyt sprzed zmiany schematu (ponowienie po wdrożeniu) albo ucięty zapis.
    const ocrJobId = await zadanieOcr({ extracted_data: { seller_name: 'Stary Format' } });
    m.doc = odczyt();

    const result = await runProcessOcr({ ocrJobId, tenantId: ORG }, ctx(1));

    expect(result).toMatchObject({ success: true });
    expect(m.ocrCalls).toBe(1);
    const koszty = await kosztyZadania(ocrJobId);
    expect(koszty).toHaveLength(1);
    expect(koszty[0]).toMatchObject({ seller_name: 'Sklep Biurowe Centrum' });
    expect((await zadanie(ocrJobId)).extracted_data).toMatchObject({ seller_name: 'Sklep Biurowe Centrum' });
  });
});

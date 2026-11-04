import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { isOpenCorrectionConflict } from '@/lib/invoices/ksef-send-step';

import { getRlsTestEnvironment } from './helpers/rls-environment';

/**
 * K4 (00133 + 00135) na prawdziwej bazie: faktura pierwotna ma najwyżej
 * jedną korektę W TOKU (szkic, kolejka, wysyłka, offline, błąd). Przyjęta
 * korekta tworzy łańcuch — kolejna liczy „stan przed” po niej (akcje), więc
 * NIE blokuje następnej; odrzucona nie liczy się wcale. Powrót korekty
 * z `rejected` do szkicu przy innej korekcie w toku odbija.
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

const ORG = '88888888-8888-4888-8888-888888888888';
let counter = 0;

function nextId(): string {
  counter += 1;
  return `8888aaaa-0000-4000-8000-${String(counter).padStart(12, '0')}`;
}

async function acceptedParent(): Promise<string> {
  const id = nextId();
  const { error } = await admin.from('invoices').insert({
    id, tenant_id: ORG, direction: 'outgoing', internal_number: `FV/${counter}`, invoice_type: 'VAT',
    invoice_kind: 'regular', issue_date: '2026-10-01', seller_nip: '9480000014', buyer_nip: '1234567890',
    gross_total: 1230, net_total: 1000, vat_total: 230, ksef_status: 'accepted', ksef_environment: 'test',
    ksef_number: `9480000014-20261001-${String(counter).padStart(12, '0')}-00`, xml_storage_path: 'x.xml',
    fa3_data: { internalNumber: `FV/${counter}`, type: 'VAT' }, seller_data: { nip: '9480000014' }, buyer_data: { nip: '1234567890' },
  });
  if (error) throw new Error(`insert parent: ${error.message}`);
  return id;
}

async function correction(parentId: string, status: string): Promise<{ id: string; error: { code?: string; message: string } | null }> {
  const id = nextId();
  const { error } = await admin.from('invoices').insert({
    id, tenant_id: ORG, direction: 'outgoing', internal_number: `KOR/${counter}`, invoice_type: 'KOR',
    invoice_kind: 'correction', parent_invoice_id: parentId, correction_reason: 'test', correction_type: 'before_after',
    issue_date: '2026-10-02', seller_nip: '9480000014', buyer_nip: '1234567890',
    gross_total: -123, net_total: -100, vat_total: -23, ksef_status: status,
    fa3_data: { internalNumber: `KOR/${counter}`, type: 'KOR' }, seller_data: { nip: '9480000014' }, buyer_data: { nip: '1234567890' },
  });
  return { id, error: error ? { code: error.code, message: error.message } : null };
}

async function cleanup() {
  await admin.from('ksef_submissions').delete().eq('tenant_id', ORG);
  // Najpierw korekty (klucz obcy do rodzica), potem reszta; statusy sprowadzamy
  // do szkicu, żeby wyzwalacze 00119/00122 pozwoliły na DELETE.
  await admin.from('invoices').update({
    ksef_status: 'draft', ksef_send_owner: null, submitted_to_ksef_at: null, last_attempt_at: null,
    ksef_number: null, ksef_accepted_at: null, xml_storage_path: null, ksef_environment: null,
  }).eq('tenant_id', ORG).neq('ksef_status', 'accepted');
  await admin.from('invoices').delete().eq('tenant_id', ORG).eq('invoice_kind', 'correction');
  await admin.from('invoices').delete().eq('tenant_id', ORG);
  await admin.from('audit_logs').delete().eq('tenant_id', ORG);
}

describe.skipIf(!hasDatabase)('K4 (00133 + 00135): jedna korekta w toku na fakturę pierwotną', () => {
  beforeAll(async () => {
    await cleanup();
    await admin.from('tenants').delete().eq('id', ORG);
    const { error } = await admin.from('tenants').insert({ id: ORG, nip: '9480000014', name: 'Firma Korekty' });
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

  it('druga korekta przy otwartej pierwszej (szkic) jest odrzucana z nazwą tej pierwszej', async () => {
    const parent = await acceptedParent();
    const first = await correction(parent, 'draft');
    expect(first.error).toBeNull();

    const second = await correction(parent, 'draft');
    expect(second.error?.code).toBe('23505');
    // 00135: komunikat mówi o korekcie W TOKU (przyjęta tworzy łańcuch).
    expect(second.error?.message).toContain('ma korektę w toku');
    expect(second.error?.message).toContain(`KOR/${counter - 1}`);
  });

  it.each(['queued', 'failed'])('korekta w stanie %s też blokuje kolejną', async (status) => {
    const parent = await acceptedParent();
    const first = await correction(parent, 'draft');
    expect(first.error).toBeNull();
    const { error: moveError } = await admin.from('invoices').update({ ksef_status: status }).eq('id', first.id);
    expect(moveError).toBeNull();

    const second = await correction(parent, 'draft');
    expect(second.error?.code).toBe('23505');
    expect(second.error?.message).toContain('w toku');
  });

  it('łańcuch: przyjęta korekta NIE blokuje kolejnej (00135)', async () => {
    const parent = await acceptedParent();
    const first = await correction(parent, 'draft');
    const { error: acceptError } = await admin.from('invoices').update({
      ksef_status: 'accepted', ksef_number: `9480000014-20261002-${String(counter).padStart(12, '0')}-00`,
      ksef_environment: 'test', xml_storage_path: 'k.xml',
    }).eq('id', first.id);
    expect(acceptError).toBeNull();

    const second = await correction(parent, 'draft');
    expect(second.error).toBeNull();
    // ...ale druga korekta w toku nadal blokuje trzecią.
    const third = await correction(parent, 'draft');
    expect(third.error?.code).toBe('23505');
  });

  it('odrzucona przez KSeF korekta nie blokuje; jej powrót do szkicu przy drugiej otwartej odbija', async () => {
    const parent = await acceptedParent();
    const first = await correction(parent, 'draft');
    const { error: rejectError } = await admin.from('invoices')
      .update({ ksef_status: 'rejected', last_error_code: 'KSEF_REJECTED' })
      .eq('id', first.id);
    expect(rejectError).toBeNull();

    const second = await correction(parent, 'draft');
    expect(second.error).toBeNull();

    const back = await admin.from('invoices').update({ ksef_status: 'draft' }).eq('id', first.id);
    expect(back.error?.code).toBe('23505');
  });

  it('strażnik (A4b PR2a, I5 crona): uzgodnienie odrzuconej korekty przy drugiej w toku — 23505 rozpoznany jako konflikt korekt, stan i audyt wycofane', async () => {
    const parent = await acceptedParent();
    const first = await correction(parent, 'draft');
    const { error: rejectError } = await admin.from('invoices')
      .update({ ksef_status: 'rejected', last_error_code: 'KSEF_REJECTED' })
      .eq('id', first.id);
    expect(rejectError).toBeNull();
    const second = await correction(parent, 'draft');
    expect(second.error).toBeNull();

    // Jak cron (aktor = automat): rejected → queued tylko w trybie uzgodnienia; wyzwalacz 00135 odbija.
    const { error } = await admin.rpc('requeue_ksef_send', {
      p_invoice_id: first.id, p_tenant_id: ORG, p_attempt_id: 'cron-a4b', p_actor_user_id: null, p_reconcile_only: true,
    });
    expect(error?.code).toBe('23505');
    // Cron łapie wąsko tylko ten tekst (skippedConflict); każdy inny 23505 idzie do errors i Sentry.
    expect(isOpenCorrectionConflict(error)).toBe(true);

    const { data: still, error: readError } = await admin.from('invoices').select('ksef_status').eq('id', first.id).single();
    expect(readError).toBeNull();
    expect(still?.ksef_status).toBe('rejected');
    // Audyt `invoice.send_requeued` pisze RPC w tej samej transakcji — wycofany razem z nią,
    // więc automat nie liczy tej próby do limitu i ponowi ją w następnym przebiegu.
    const { count, error: auditError } = await admin.from('audit_logs')
      .select('id', { count: 'exact', head: true })
      .eq('entity_id', first.id)
      .eq('action', 'invoice.send_requeued');
    expect(auditError).toBeNull();
    expect(count).toBe(0);
  });

  it('korekty różnych rodziców i zwykłe faktury nie przeszkadzają sobie', async () => {
    const a = await acceptedParent();
    const b = await acceptedParent();
    expect((await correction(a, 'draft')).error).toBeNull();
    expect((await correction(b, 'draft')).error).toBeNull();
    const plain = await acceptedParent();
    expect(plain).toBeTruthy();
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { isRecurringPeriodConflict, loadRecurringIssueLink } from '@/lib/invoices/recurring/issue';
import { countRecurringInvoicesDue, listRecurringInvoices } from '@/lib/invoices/recurring/queries';

import { getRlsTestEnvironment } from './helpers/rls-environment';

/**
 * 00154 (plan Finora N1) na prawdziwym PostgREST i Postgresie:
 *  - izolacja firm: firma B nie widzi, nie zmienia i nie usuwa pozycji
 *    firmy A, nie może wskazać faktury A jako wzoru ani podpiąć swojej
 *    faktury pod pozycję A (klucze złożone (tenant_id, …));
 *  - jedna faktura na okres: drugi INSERT z tym samym
 *    (recurring_invoice_id, recurring_period) → 23505 na
 *    `uq_invoices_recurring_period` (tę nazwę rozpoznaje aplikacja);
 *  - CHECK-i tabeli i formatu okresu, brak praw `anon`;
 *  - jedna pozycja na fakturę-wzór w firmie (`recurring_invoices_template_unique`);
 *  - klient nie przepina powiązania UPDATE-em (wyzwalacz), a usunięcie
 *    pozycji zeruje samo `recurring_invoice_id` i NIE rusza faktury
 *    przyjętej w KSeF (ON DELETE SET NULL (recurring_invoice_id) przechodzi
 *    przez wyzwalacze ochronne faktur).
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

const ORG_A = '00154154-0000-4000-8000-00000000000a';
const ORG_B = '00154154-0000-4000-8000-00000000000b';
const TPL_A = '00154154-1111-4000-8000-00000000000a';
const TPL_B = '00154154-1111-4000-8000-00000000000b';
/** Dodatkowe wzory firmy A — jedna pozycja na wzór (K2), więc kilka pozycji = kilka wzorów. */
const TPL_A2 = '00154154-1111-4000-8000-0000000000a2';
const TPL_A3 = '00154154-1111-4000-8000-0000000000a3';
const EMAIL_A = 'rls-cykliczne-a@ksef-saas.test';
const EMAIL_B = 'rls-cykliczne-b@ksef-saas.test';
const PASS = 'RlsCykliczne2026Aa!';

let userA = '';
let clientA: SupabaseClient;
let clientB: SupabaseClient;
let counter = 0;

function anonClient(activeOrg?: string) {
  return createClient(environment!.url, environment!.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: activeOrg ? { 'x-active-org': activeOrg } : {} },
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

async function signedIn(email: string, org: string): Promise<SupabaseClient> {
  const client = anonClient(org);
  const { error } = await client.auth.signInWithPassword({ email, password: PASS });
  if (error) throw error;
  return client;
}

/** Faktura-wzór przyjęta w KSeF (stan serwerowy — wstawia klucz serwisowy). */
async function acceptedTemplate(id: string, org: string, nip: string, number = `FV/W/${org.slice(-1)}`) {
  const { error } = await admin.from('invoices').insert({
    id, tenant_id: org, direction: 'outgoing', internal_number: number, invoice_type: 'VAT',
    invoice_kind: 'regular', issue_date: '2026-10-01', seller_nip: nip, buyer_nip: '1234567890',
    gross_total: 1230, net_total: 1000, vat_total: 230, currency: 'PLN',
    ksef_status: 'accepted', ksef_environment: 'test', xml_storage_path: 'x.xml',
    ksef_number: `${nip}-20261001-${id.slice(-12).toUpperCase()}-00`,
    fa3_data: { internalNumber: number, type: 'VAT' }, seller_data: { nip }, buyer_data: { nip: '1234567890', name: 'Klient testowy' },
  });
  if (error) throw new Error(`wzór ${number}: ${error.message}`);
}

/** Szkic faktury firmy (jak `insertInvoiceAndLines`) — kluczem użytkownika. */
function draftRow(org: string, extra: Record<string, unknown> = {}) {
  counter += 1;
  const number = `FV/C/${counter}`;
  return {
    tenant_id: org, direction: 'outgoing', ksef_status: 'draft', internal_number: number, invoice_type: 'VAT',
    issue_date: '2026-10-20', seller_nip: '9480000014', buyer_nip: '1234567890',
    gross_total: 1230, net_total: 1000, vat_total: 230, currency: 'PLN',
    fa3_data: { internalNumber: number, type: 'VAT' }, seller_data: { nip: '9480000014' }, buyer_data: { nip: '1234567890' },
    ...extra,
  };
}

async function newRecurring(client: SupabaseClient, extra: Record<string, unknown> = {}): Promise<string> {
  const { data, error } = await client
    .from('recurring_invoices')
    .insert({
      tenant_id: ORG_A, template_invoice_id: TPL_A, name: 'Abonament', frequency: 'monthly',
      day_of_month: 10, next_run_date: '2026-11-10', created_by: userA, ...extra,
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`pozycja: ${error?.message}`);
  return data.id as string;
}

async function cleanup() {
  await admin.from('recurring_invoices').delete().in('tenant_id', [ORG_A, ORG_B]);
  for (const org of [ORG_A, ORG_B]) {
    await admin.from('invoices').delete().eq('tenant_id', org).eq('ksef_status', 'draft');
  }
}

describe.skipIf(!hasDatabase)('00154: faktury cykliczne na prawdziwej bazie', () => {
  beforeAll(async () => {
    userA = await userId(EMAIL_A);
    const userB = await userId(EMAIL_B);
    await admin.from('recurring_invoices').delete().in('tenant_id', [ORG_A, ORG_B]);
    for (const org of [ORG_A, ORG_B]) {
      await admin.from('invoices').delete().eq('tenant_id', org);
      await admin.from('memberships').delete().eq('organization_id', org);
      await admin.from('tenants').delete().eq('id', org);
    }
    const { error: tErr } = await admin.from('tenants').insert([
      { id: ORG_A, nip: '9480000014', name: 'Firma A 00154' },
      { id: ORG_B, nip: '9480000021', name: 'Firma B 00154' },
    ]);
    if (tErr) throw tErr;
    await admin.from('users').upsert([{ id: userA, name: 'A' }, { id: userB, name: 'B' }], { onConflict: 'id' });
    const { error: mErr } = await admin.from('memberships').insert([
      { organization_id: ORG_A, user_id: userA, role: 'owner', status: 'active' },
      { organization_id: ORG_B, user_id: userB, role: 'owner', status: 'active' },
    ]);
    if (mErr) throw mErr;
    await acceptedTemplate(TPL_A, ORG_A, '9480000014');
    await acceptedTemplate(TPL_B, ORG_B, '9480000021');
    await acceptedTemplate(TPL_A2, ORG_A, '9480000014', 'FV/W/a2');
    await acceptedTemplate(TPL_A3, ORG_A, '9480000014', 'FV/W/a3');
    clientA = await signedIn(EMAIL_A, ORG_A);
    clientB = await signedIn(EMAIL_B, ORG_B);
  });

  beforeEach(async () => {
    await cleanup();
  });

  afterAll(async () => {
    if (!hasDatabase) return;
    await cleanup();
    for (const org of [ORG_A, ORG_B]) {
      await admin.from('invoices').delete().eq('tenant_id', org);
      await admin.from('memberships').delete().eq('organization_id', org);
      await admin.from('tenants').delete().eq('id', org);
    }
  });

  describe('izolacja firm', () => {
    it('firma A tworzy i czyta swoją pozycję; firma B jej nie widzi, nie zmienia i nie usuwa', async () => {
      const id = await newRecurring(clientA);

      const own = await clientA.from('recurring_invoices').select('id, name').eq('id', id);
      expect(own.error).toBeNull();
      expect(own.data).toEqual([{ id, name: 'Abonament' }]);

      const seen = await clientB.from('recurring_invoices').select('id').eq('id', id);
      expect(seen.error).toBeNull();
      expect(seen.data).toEqual([]);

      const upd = await clientB.from('recurring_invoices').update({ active: false }).eq('id', id).select('id');
      expect(upd.data ?? []).toEqual([]);
      const del = await clientB.from('recurring_invoices').delete().eq('id', id).select('id');
      expect(del.data ?? []).toEqual([]);

      const after = await admin.from('recurring_invoices').select('active').eq('id', id).single();
      expect(after.data).toEqual({ active: true });
    });

    it('firma B nie wpisze pozycji na firmę A (RLS WITH CHECK)', async () => {
      const r = await clientB.from('recurring_invoices').insert({
        tenant_id: ORG_A, template_invoice_id: TPL_A, name: 'Obca', frequency: 'monthly',
        day_of_month: 1, next_run_date: '2026-11-01',
      });
      expect(r.error?.code).toBe('42501');
    });

    it('firma B nie wskaże faktury A jako wzoru (klucz złożony → 23503)', async () => {
      const r = await clientB.from('recurring_invoices').insert({
        tenant_id: ORG_B, template_invoice_id: TPL_A, name: 'Cudzy wzór', frequency: 'monthly',
        day_of_month: 1, next_run_date: '2026-11-01',
      });
      expect(r.error?.code).toBe('23503');
      expect(r.error?.message).toContain('recurring_invoices_template_same_tenant_fk');
    });

    it('firma B nie podepnie swojej faktury pod pozycję A (klucz złożony → 23503)', async () => {
      const id = await newRecurring(clientA);
      const r = await clientB.from('invoices').insert(
        draftRow(ORG_B, { recurring_invoice_id: id, recurring_period: '2026-11' }),
      );
      expect(r.error?.code).toBe('23503');
      expect(r.error?.message).toContain('invoices_recurring_invoice_same_tenant_fk');
    });

    it('anon nie ma żadnych praw do tabeli', async () => {
      const r = await anonClient().from('recurring_invoices').select('id').limit(1);
      expect(r.error?.code).toBe('42501');
    });
  });

  describe('jedna faktura na okres', () => {
    it('drugi zapis tego samego okresu → 23505 na uq_invoices_recurring_period; następny okres przechodzi', async () => {
      const id = await newRecurring(clientA);
      const first = await clientA.from('invoices').insert(
        draftRow(ORG_A, { recurring_invoice_id: id, recurring_period: '2026-11' }),
      );
      expect(first.error).toBeNull();

      const second = await clientA.from('invoices').insert(
        draftRow(ORG_A, { recurring_invoice_id: id, recurring_period: '2026-11' }),
      );
      expect(second.error?.code).toBe('23505');
      expect(second.error?.message).toContain('uq_invoices_recurring_period');
      expect(isRecurringPeriodConflict(second.error)).toBe(true);

      const next = await clientA.from('invoices').insert(
        draftRow(ORG_A, { recurring_invoice_id: id, recurring_period: '2026-12' }),
      );
      expect(next.error).toBeNull();
    });

    it('dwa równoległe zapisy tego samego okresu → dokładnie jeden przechodzi', async () => {
      const id = await newRecurring(clientA);
      const results = await Promise.all([
        clientA.from('invoices').insert(draftRow(ORG_A, { recurring_invoice_id: id, recurring_period: '2026-11' })),
        clientA.from('invoices').insert(draftRow(ORG_A, { recurring_invoice_id: id, recurring_period: '2026-11' })),
      ]);
      expect(results.filter((r) => r.error === null)).toHaveLength(1);
      expect(results.find((r) => r.error)?.error?.code).toBe('23505');
      const { count } = await admin.from('invoices').select('id', { count: 'exact', head: true })
        .eq('tenant_id', ORG_A).eq('recurring_invoice_id', id).eq('recurring_period', '2026-11');
      expect(count).toBe(1);
    });

    it('zajęty numer i zajęty okres to dwa różne indeksy (aplikacja rozróżnia je po nazwie)', async () => {
      const id = await newRecurring(clientA);
      const row = draftRow(ORG_A, { recurring_invoice_id: id, recurring_period: '2026-11' });
      expect((await clientA.from('invoices').insert(row)).error).toBeNull();
      const sameNumber = await clientA.from('invoices').insert({ ...row, recurring_period: '2026-12' });
      expect(sameNumber.error?.code).toBe('23505');
      expect(sameNumber.error?.message).toContain('uq_invoices_tenant_outgoing_internal_number');
      expect(isRecurringPeriodConflict(sameNumber.error)).toBe(false);
    });

    it('odczyt pozycji do zapisu i licznik banera działają na prawdziwym PostgREST', async () => {
      const id = await newRecurring(clientA, { next_run_date: '2026-10-10' });
      // Każda pozycja z innego wzoru — jedna pozycja na wzór (K2).
      await newRecurring(clientA, { next_run_date: '2026-12-10', name: 'Późniejsza', template_invoice_id: TPL_A2 });
      await newRecurring(clientA, {
        next_run_date: '2026-09-10', active: false, name: 'Wstrzymana', template_invoice_id: TPL_A3,
      });

      const link = await loadRecurringIssueLink(clientA, ORG_A, id);
      expect(link).toEqual({
        ok: true,
        link: { recurringInvoiceId: id, period: '2026-10', runDate: '2026-10-10', nextRunDate: '2026-11-10' },
      });
      expect(await loadRecurringIssueLink(clientB, ORG_A, id)).toMatchObject({ ok: false });

      expect(await countRecurringInvoicesDue(clientA, ORG_A, '2026-10-20')).toBe(1);
      expect(await countRecurringInvoicesDue(clientB, ORG_B, '2026-10-20')).toBe(0);

      const list = await listRecurringInvoices(clientA, ORG_A, '2026-10-20');
      expect(list.map((p) => [p.name, p.status])).toEqual([
        ['Wstrzymana', 'paused'],
        ['Abonament', 'due'],
        ['Późniejsza', 'active'],
      ]);
      // Pozycja „Abonament” ma wzór TPL_A (pozostałe — własne wzory, K2).
      expect(list.find((p) => p.id === id)).toMatchObject({
        templateNumber: 'FV/W/a', templateGrossTotal: 1230, contractorName: 'Klient testowy',
        // Bez faktur z pozycji okres pokryty to data wzoru (podgląd „Edytuj”).
        coveredThrough: '2026-10-01',
      });
    });
  });

  describe('jedna pozycja na fakturę-wzór (K2)', () => {
    it('druga pozycja z tym samym wzorem → 23505 na recurring_invoices_template_unique; inny wzór przechodzi', async () => {
      await newRecurring(clientA);
      const second = await clientA.from('recurring_invoices').insert({
        tenant_id: ORG_A, template_invoice_id: TPL_A, name: 'Drugi abonament', frequency: 'quarterly',
        day_of_month: 5, next_run_date: '2026-11-05',
      });
      expect(second.error?.code).toBe('23505');
      expect(second.error?.message).toContain('recurring_invoices_template_unique');

      await expect(newRecurring(clientA, { template_invoice_id: TPL_A2, name: 'Inny wzór' })).resolves.toEqual(expect.any(String));
    });

    it('przepięcie pozycji UPDATE-em na wzór innej pozycji → 23505', async () => {
      await newRecurring(clientA);
      const other = await newRecurring(clientA, { template_invoice_id: TPL_A2, name: 'Inny wzór' });
      const r = await clientA.from('recurring_invoices').update({ template_invoice_id: TPL_A }).eq('id', other);
      expect(r.error?.code).toBe('23505');
      expect(r.error?.message).toContain('recurring_invoices_template_unique');
    });
  });

  describe('CHECK-i', () => {
    it.each([
      [{ day_of_month: 29 }],
      [{ day_of_month: 0 }],
      [{ frequency: 'weekly' }],
      [{ name: '   ' }],
      [{ name: 'x'.repeat(121) }],
    ])('pozycja %o → 23514', async (zmiana) => {
      const r = await clientA.from('recurring_invoices').insert({
        tenant_id: ORG_A, template_invoice_id: TPL_A, name: 'Abonament', frequency: 'monthly',
        day_of_month: 10, next_run_date: '2026-11-10', ...zmiana,
      });
      expect(r.error?.code).toBe('23514');
    });

    it.each([['listopad'], ['2026-13'], ['2026-Q5'], ['26-11']])('okres %s → 23514', async (okres) => {
      const id = await newRecurring(clientA);
      const r = await clientA.from('invoices').insert(
        draftRow(ORG_A, { recurring_invoice_id: id, recurring_period: okres }),
      );
      expect(r.error?.code).toBe('23514');
    });

    it('powiązanie bez okresu → 23514', async () => {
      const id = await newRecurring(clientA);
      const r = await clientA.from('invoices').insert(draftRow(ORG_A, { recurring_invoice_id: id }));
      expect(r.error?.code).toBe('23514');
    });
  });

  describe('powiązanie faktury z pozycją', () => {
    it('klient nie przepina okresu ani pozycji UPDATE-em (42501)', async () => {
      const id = await newRecurring(clientA);
      const ins = await clientA.from('invoices')
        .insert(draftRow(ORG_A, { recurring_invoice_id: id, recurring_period: '2026-11' }))
        .select('id')
        .single();
      expect(ins.error).toBeNull();

      const period = await clientA.from('invoices').update({ recurring_period: '2026-12' }).eq('id', ins.data!.id);
      expect(period.error?.code).toBe('42501');
      const unlink = await clientA.from('invoices').update({ recurring_invoice_id: null }).eq('id', ins.data!.id);
      expect(unlink.error?.code).toBe('42501');
    });

    it('usunięcie pozycji zeruje samo powiązanie; faktura przyjęta w KSeF zostaje bez zmian', async () => {
      const id = await newRecurring(clientA);
      const acceptedId = '00154154-2222-4000-8000-00000000000a';
      await admin.from('invoices').delete().eq('id', acceptedId);
      const { error: aErr } = await admin.from('invoices').insert({
        ...draftRow(ORG_A, { recurring_invoice_id: id, recurring_period: '2026-11' }),
        id: acceptedId, ksef_status: 'accepted', ksef_environment: 'test', xml_storage_path: 'y.xml',
        ksef_number: '9480000014-20261020-00154154222A-00',
      });
      expect(aErr).toBeNull();

      const del = await clientA.from('recurring_invoices').delete().eq('id', id).select('id');
      expect(del.error).toBeNull();
      expect(del.data).toEqual([{ id }]);

      const inv = await admin.from('invoices')
        .select('ksef_status, gross_total, recurring_invoice_id, recurring_period')
        .eq('id', acceptedId)
        .single();
      expect(inv.data).toEqual({
        ksef_status: 'accepted', gross_total: 1230, recurring_invoice_id: null, recurring_period: '2026-11',
      });
      await admin.from('invoices').delete().eq('id', acceptedId);
    });
  });
});

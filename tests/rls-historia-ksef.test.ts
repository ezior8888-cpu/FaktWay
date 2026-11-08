import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { asHistoryClient, claimLease } from '@/lib/ksef/history-sync/db';

import { getRlsTestEnvironment } from './helpers/rls-environment';

/**
 * 00155 (synchronizacja historii KSeF, decyzja Bartosza 22.10.2026) na
 * prawdziwym PostgREST i Postgresie, w jobie CI „RLS isolation”:
 *  - firma czyta tylko swoje strumienie, pozycje dziennika i liczniki;
 *  - klient NIE czyta `detail` ani `last_error_detail` (42501) i niczego nie
 *    zapisuje; `anon` nie ma nic; `service_role` nie usuwa (brak DELETE);
 *  - CHECK-i: para status–powód, stan firmy tylko na wierszu sprzedaży,
 *    kolejność okna, kursor bieżący tylko dla sprzedaży;
 *  - tożsamość (firma, środowisko, kierunek, numer KSeF) i strumienia;
 *  - usunięcie faktury zeruje `invoice_id`, wiersz zostaje nagrobkiem;
 *  - `ksef_upo_expected`: `app` → true; `ksef_import` bez naszej wysyłki →
 *    false; `ksef_import` z numerem oryginału 440 w `ksef_submissions` → true;
 *  - filtr pola wyliczanego działa w PostgREST na `invoices` i na osadzeniu
 *    `invoices!inner` z `upo_receipts` (tak pytają upo-retry-stale i raport);
 *  - widok `ksef_history_export_changes`: okresy eksportu, do których doszły
 *    faktury po eksporcie — liczy baza, firma widzi tylko swoje;
 *  - dzierżawa przebiegu: jeden warunkowy UPDATE z dwoma `or` (PostgREST
 *    łączy je przez AND) — wolna/zajęta/po wygaśnięciu/pauza klienta.
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

const ORG_A = '00155155-0000-4000-8000-00000000000a';
const ORG_B = '00155155-0000-4000-8000-00000000000b';
const EMAIL_A = 'rls-historia-a@ksef-saas.test';
const PASS = 'RlsHistoria2026Aa!';
const NIP_A = '9480000014';
const NIP_B = '9480000021';

const INV_APP = '00155155-1111-4000-8000-000000000001';
const INV_IMPORT = '00155155-1111-4000-8000-000000000002';
const INV_IMPORT_LINKED = '00155155-1111-4000-8000-000000000003';
const INV_DRAFT = '00155155-1111-4000-8000-000000000004';
const INV_LINK_SOURCE = '00155155-1111-4000-8000-000000000005';
const INV_TOMBSTONE = '00155155-1111-4000-8000-000000000006';

const ksefNumber = (n: number) => `${NIP_A}-20261001-${String(n).padStart(12, '0')}-00`;

let clientA: SupabaseClient;

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

function stream(org: string, direction: 'outgoing' | 'incoming', patch: Record<string, unknown> = {}) {
  return {
    tenant_id: org, environment: 'test', direction,
    history_floor: '2022-01-01T00:00:00Z', boundary_at: '2026-10-01T00:00:00Z',
    backfill_window_end: '2026-10-01T00:00:00Z', backfill_cursor: '2026-07-03T00:00:00Z',
    live_hwm: direction === 'outgoing' ? '2026-10-01T00:00:00Z' : null,
    ...patch,
  };
}

function item(org: string, n: number, patch: Record<string, unknown> = {}) {
  return {
    tenant_id: org, environment: 'test', direction: 'outgoing', ksef_number: ksefNumber(n),
    invoice_number: `FV/H/${n}`, issue_date: '2026-09-10', status: 'pending', ...patch,
  };
}

async function invoice(id: string, org: string, patch: Record<string, unknown>) {
  const number = `FV/H/${id.slice(-2)}`;
  const { error } = await admin.from('invoices').insert({
    id, tenant_id: org, direction: 'outgoing', internal_number: number, invoice_type: 'VAT', invoice_kind: 'regular',
    issue_date: '2026-10-01', seller_nip: NIP_A, buyer_nip: '1234567890', gross_total: 123, net_total: 100, vat_total: 23,
    currency: 'PLN', fa3_data: { internalNumber: number, type: 'VAT' }, seller_data: { nip: NIP_A },
    buyer_data: { nip: '1234567890' }, ...patch,
  });
  if (error) throw new Error(`faktura ${id}: ${error.message}`);
}

async function cleanup() {
  for (const org of [ORG_A, ORG_B]) {
    await admin.from('upo_receipts').delete().eq('tenant_id', org);
    await admin.from('export_jobs').delete().eq('tenant_id', org);
    await admin.from('ksef_submissions').delete().eq('tenant_id', org);
    await admin.from('invoices').delete().eq('tenant_id', org);
    await admin.from('memberships').delete().eq('organization_id', org);
    // Strumienie i dziennik znikają kaskadą z firmą (service_role nie ma DELETE).
    await admin.from('tenants').delete().eq('id', org);
  }
}

describe.skipIf(!hasDatabase)('00155: historia KSeF na prawdziwej bazie', () => {
  beforeAll(async () => {
    const userA = await userId(EMAIL_A);
    await cleanup();
    const { error: tErr } = await admin.from('tenants').insert([
      { id: ORG_A, nip: NIP_A, name: 'Firma A 00155' },
      { id: ORG_B, nip: NIP_B, name: 'Firma B 00155' },
    ]);
    if (tErr) throw tErr;
    await admin.from('users').upsert([{ id: userA, name: 'A' }], { onConflict: 'id' });
    const { error: mErr } = await admin.from('memberships').insert([
      { organization_id: ORG_A, user_id: userA, role: 'owner', status: 'active' },
    ]);
    if (mErr) throw mErr;

    const streams = await admin.from('ksef_history_sync').insert([
      stream(ORG_A, 'outgoing', { last_error_code: 'internal', last_error_detail: 'HTTP 500 /invoices/query/metadata kody:-' }),
      stream(ORG_A, 'incoming'),
      stream(ORG_B, 'outgoing'),
    ]);
    if (streams.error) throw streams.error;
    const items = await admin.from('ksef_history_items').insert([
      item(ORG_A, 1, { detail: 'szczegół operatora' }),
      item(ORG_A, 2, { status: 'blocked', reason_code: 'parse_failed', resolved_at: '2026-10-22T00:00:00Z' }),
      item(ORG_B, 3),
    ]);
    if (items.error) throw items.error;

    clientA = anonClient(ORG_A);
    const { error } = await clientA.auth.signInWithPassword({ email: EMAIL_A, password: PASS });
    if (error) throw error;
  });

  afterAll(async () => {
    if (!hasDatabase) return;
    await cleanup();
  });

  describe('izolacja i uprawnienia kolumnowe', () => {
    it('firma czyta tylko swoje strumienie, pozycje i liczniki (kolumny z GRANT)', async () => {
      const s = await clientA.from('ksef_history_sync').select('tenant_id, direction, last_error_code');
      expect(s.error).toBeNull();
      expect((s.data ?? []).map((r) => r.tenant_id)).toEqual([ORG_A, ORG_A]);

      const i = await clientA.from('ksef_history_items').select('tenant_id, ksef_number, status, reason_code');
      expect(i.error).toBeNull();
      expect((i.data ?? []).every((r) => r.tenant_id === ORG_A)).toBe(true);
      expect(i.data).toHaveLength(2);

      const c = await clientA.from('ksef_history_item_counts').select('tenant_id, status, reason_code, item_count');
      expect(c.error).toBeNull();
      expect((c.data ?? []).every((r) => r.tenant_id === ORG_A)).toBe(true);
      expect((c.data ?? []).reduce((a, r) => a + Number(r.item_count), 0)).toBe(2);
    });

    it('`detail` i `last_error_detail` — 42501 dla klienta (także przez `*`)', async () => {
      expect((await clientA.from('ksef_history_items').select('detail')).error?.code).toBe('42501');
      expect((await clientA.from('ksef_history_items').select('*')).error?.code).toBe('42501');
      expect((await clientA.from('ksef_history_sync').select('last_error_detail')).error?.code).toBe('42501');
      // Serwis widzi szczegół (ops, alarmy).
      const svc = await admin.from('ksef_history_sync').select('last_error_detail').eq('tenant_id', ORG_A).eq('direction', 'outgoing').single();
      expect(svc.data?.last_error_detail).toContain('HTTP 500');
    });

    it('klient nie pisze: INSERT/UPDATE/DELETE — 42501; anon nic nie czyta', async () => {
      expect((await clientA.from('ksef_history_items').insert(item(ORG_A, 9))).error?.code).toBe('42501');
      expect((await clientA.from('ksef_history_sync').update({ client_paused_at: new Date().toISOString() }).eq('tenant_id', ORG_A)).error?.code).toBe('42501');
      expect((await clientA.from('ksef_history_items').delete().eq('tenant_id', ORG_A)).error?.code).toBe('42501');
      const anon = anonClient();
      expect((await anon.from('ksef_history_sync').select('id')).error?.code).toBe('42501');
      expect((await anon.from('ksef_history_items').select('id')).error?.code).toBe('42501');
      expect((await anon.from('ksef_history_item_counts').select('item_count')).error?.code).toBe('42501');
    });

    it('service_role bez DELETE — dziennik znika tylko kaskadą z firmą', async () => {
      expect((await admin.from('ksef_history_items').delete().eq('tenant_id', ORG_B)).error?.code).toBe('42501');
      expect((await admin.from('ksef_history_sync').delete().eq('tenant_id', ORG_B)).error?.code).toBe('42501');
    });
  });

  describe('CHECK i tożsamość', () => {
    it.each([
      ['skipped bez powodu', item(ORG_A, 20, { status: 'skipped' })],
      ['pending z powodem blokady', item(ORG_A, 21, { status: 'pending', reason_code: 'parse_failed' })],
      ['deferred bez terminu', item(ORG_A, 22, { status: 'deferred', reason_code: 'own_send_pending' })],
      ['imported z powodem odłożenia', item(ORG_A, 23, { status: 'imported', reason_code: 'duplicate_decision' })],
      ['nieznany status', item(ORG_A, 24, { status: 'lost' })],
      ['szczegół > 300 znaków', item(ORG_A, 25, { detail: 'x'.repeat(301) })],
    ])('pozycja: %s → 23514', async (_label, row) => {
      expect((await admin.from('ksef_history_items').insert(row)).error?.code).toBe('23514');
    });

    it('poprawne pary status–powód przechodzą', async () => {
      const ok = await admin.from('ksef_history_items').insert([
        item(ORG_B, 30, { status: 'deferred', reason_code: 'duplicate_decision', next_attempt_at: '2026-10-22T11:00:00Z' }),
        item(ORG_B, 31, { status: 'imported', reason_code: 'jpk_note' }),
        item(ORG_B, 32, { status: 'skipped', reason_code: 'retired_draft' }),
        item(ORG_B, 33, { status: 'pending', reason_code: 'ksef_not_ready', next_attempt_at: '2026-10-22T11:00:00Z' }),
      ]);
      expect(ok.error).toBeNull();
    });

    it('ten sam numer KSeF w tej samej firmie, środowisku i kierunku → 23505; inny kierunek — wolno', async () => {
      expect((await admin.from('ksef_history_items').insert(item(ORG_A, 1))).error?.code).toBe('23505');
      expect((await admin.from('ksef_history_items').insert(item(ORG_A, 1, { direction: 'incoming' }))).error).toBeNull();
    });

    it.each([
      ['drugi strumień sprzedaży', stream(ORG_A, 'outgoing'), '23505'],
      ['stan firmy na strumieniu zakupów', stream(ORG_B, 'incoming', { paused_until: '2026-10-22T11:00:00Z' }), '23514'],
      ['zakupy z kursorem bieżącym', stream(ORG_B, 'incoming', { live_hwm: '2026-10-01T00:00:00Z' }), '23514'],
      ['sprzedaż bez kursora bieżącego', stream(ORG_B, 'outgoing', { environment: 'demo', live_hwm: null }), '23514'],
      ['kursor przed początkiem historii', stream(ORG_B, 'incoming', { environment: 'demo', backfill_cursor: '2021-01-01T00:00:00Z' }), '23514'],
      ['koniec okna za granicą', stream(ORG_B, 'incoming', { environment: 'demo', backfill_window_end: '2026-11-01T00:00:00Z' }), '23514'],
    ])('strumień: %s → %s', async (_label, row, code) => {
      expect((await admin.from('ksef_history_sync').insert(row)).error?.code).toBe(code);
    });

    it('usunięcie faktury zeruje `invoice_id`, wiersz zostaje nagrobkiem; obca faktura — 23503', async () => {
      await invoice(INV_TOMBSTONE, ORG_A, { ksef_status: 'draft' });
      const row = item(ORG_A, 40, { status: 'imported', invoice_id: INV_TOMBSTONE, resolved_at: '2026-10-22T00:00:00Z' });
      expect((await admin.from('ksef_history_items').insert(row)).error).toBeNull();
      expect((await admin.from('invoices').delete().eq('id', INV_TOMBSTONE)).error).toBeNull();
      const after = await admin.from('ksef_history_items').select('status, invoice_id').eq('tenant_id', ORG_A).eq('ksef_number', ksefNumber(40)).single();
      expect(after.data).toEqual({ status: 'imported', invoice_id: null });

      await invoice(INV_DRAFT, ORG_A, { ksef_status: 'draft', internal_number: 'FV/H/OBCA' });
      const foreign = await admin.from('ksef_history_items').insert(item(ORG_B, 41, { invoice_id: INV_DRAFT }));
      expect(foreign.error?.code).toBe('23503');
    });
  });

  describe('ksef_upo_expected i filtry PostgREST', () => {
    beforeAll(async () => {
      await invoice(INV_APP, ORG_A, { ksef_status: 'accepted', ksef_environment: 'test', ksef_number: ksefNumber(101), xml_storage_path: 'a.xml', origin: 'app' });
      await invoice(INV_IMPORT, ORG_A, { ksef_status: 'accepted', ksef_environment: 'test', ksef_number: ksefNumber(102), xml_storage_path: 'b.xml', origin: 'ksef_import', internal_number: 'FV/H/IMP' });
      await invoice(INV_IMPORT_LINKED, ORG_A, { ksef_status: 'accepted', ksef_environment: 'test', ksef_number: ksefNumber(103), xml_storage_path: 'c.xml', origin: 'ksef_import', internal_number: 'FV/H/LINK' });
      // Oryginał 440 (PR C): nasza próba wysyłki innego dokumentu wskazuje jego numer KSeF.
      await invoice(INV_LINK_SOURCE, ORG_A, { ksef_status: 'draft', internal_number: 'FV/H/SRC' });
      const sub = await admin.from('ksef_submissions').insert({
        tenant_id: ORG_A, invoice_id: INV_LINK_SOURCE, submission_type: 'online', status: 'duplicate',
        session_reference_number: 'SES-00155', invoice_reference_number: 'REF-00155', original_ksef_number: ksefNumber(103),
      });
      if (sub.error) throw new Error(`ksef_submissions: ${sub.error.message}`);
      for (const [id, n] of [[INV_APP, 101], [INV_IMPORT, 102]] as const) {
        const upo = await admin.from('upo_receipts').insert({
          tenant_id: ORG_A, invoice_id: id, ksef_number: ksefNumber(n), ksef_environment: 'test', status: 'pending',
          ksef_acceptance_timestamp: '2026-10-01T10:00:00Z',
        });
        if (upo.error) throw new Error(`upo_receipts: ${upo.error.message}`);
      }
    });

    it('predykat: app → true, historia bez wysyłki → false, historia z oryginałem 440 → true', async () => {
      const { data, error } = await admin.from('invoices').select('id')
        .eq('tenant_id', ORG_A).in('id', [INV_APP, INV_IMPORT, INV_IMPORT_LINKED])
        .filter('ksef_upo_expected', 'eq', 'true');
      expect(error).toBeNull();
      expect((data ?? []).map((r) => r.id).sort()).toEqual([INV_APP, INV_IMPORT_LINKED].sort());
    });

    it('filtr pola wyliczanego na osadzeniu `invoices!inner` z `upo_receipts`', async () => {
      const { data, error } = await admin.from('upo_receipts')
        .select('invoice_id, invoices!inner(id, tenant_id)')
        .eq('tenant_id', ORG_A)
        .filter('invoices.ksef_upo_expected', 'eq', 'true');
      expect(error).toBeNull();
      expect((data ?? []).map((r) => r.invoice_id)).toEqual([INV_APP]);
    });

    it('klient nie woła predykatu (EXECUTE tylko service_role)', async () => {
      const r = await clientA.from('invoices').select('id').filter('ksef_upo_expected', 'eq', 'true');
      expect(r.error).not.toBeNull();
    });

    it('I3: historia bez wysyłki i bez UPO nie jest naruszeniem; z oryginałem 440 — jest', async () => {
      await admin.from('upo_receipts').delete().eq('tenant_id', ORG_A);
      const { data, error } = await admin.rpc('ksef_lifecycle_violations');
      expect(error).toBeNull();
      const i3 = new Set(((data ?? []) as Array<{ invariant: string; invoice_id: string }>)
        .filter((v) => v.invariant === 'I3').map((v) => v.invoice_id));
      expect(i3.has(INV_APP)).toBe(true);
      expect(i3.has(INV_IMPORT)).toBe(false);
      expect(i3.has(INV_IMPORT_LINKED)).toBe(true);
    });
  });

  describe('okresy zmienione po eksporcie (widok ksef_history_export_changes)', () => {
    it('liczy pobrane po eksporcie z okresu i zakresu eksportu (bez napraw); firma widzi tylko swoje; anon nic', async () => {
      const day = 86_400_000;
      const at = (days: number) => new Date(Date.now() - days * day).toISOString();
      const exportRow = (org: string, patch: Record<string, unknown>) => ({
        tenant_id: org, format: 'jpk_fa', period_start: '2026-08-01', period_end: '2026-08-31',
        status: 'completed', completed_at: at(2), include_issued: true, include_received: false, ...patch,
      });
      const exp = await admin.from('export_jobs').insert([exportRow(ORG_A, {}), exportRow(ORG_B, { include_received: true })]);
      if (exp.error) throw new Error(`export_jobs: ${exp.error.message}`);
      const rows = await admin.from('ksef_history_items').insert([
        item(ORG_A, 60, { status: 'imported', issue_date: '2026-08-10', resolved_at: at(1) }),
        item(ORG_A, 61, { status: 'imported', issue_date: '2026-08-11', resolved_at: at(3) }), // przed eksportem
        item(ORG_A, 62, { status: 'imported', direction: 'incoming', issue_date: '2026-08-12', resolved_at: at(1) }), // eksport bez zakupów
        item(ORG_A, 63, { status: 'imported', reason_code: 'repaired', issue_date: '2026-08-13', resolved_at: at(1) }), // naprawa
        item(ORG_A, 64, { status: 'imported', issue_date: '2026-07-31', resolved_at: at(1) }), // poza okresem
        item(ORG_B, 65, { status: 'imported', issue_date: '2026-08-10', resolved_at: at(1) }),
      ]);
      if (rows.error) throw new Error(`ksef_history_items: ${rows.error.message}`);

      const a = await clientA.from('ksef_history_export_changes').select('tenant_id, environment, period, item_count');
      expect(a.error).toBeNull();
      expect(a.data).toEqual([{ tenant_id: ORG_A, environment: 'test', period: '2026-08', item_count: 1 }]);
      expect((await anonClient().from('ksef_history_export_changes').select('period')).error?.code).toBe('42501');
    });
  });

  describe('dzierżawa przebiegu przez PostgREST (jeden warunkowy UPDATE)', () => {
    it('wolna → zajęta; druga nie przechodzi; po wygaśnięciu znów wolna; pauza klienta blokuje', async () => {
      const history = asHistoryClient(admin);
      const now = new Date();
      const lease = 600_000;
      const first = await claimLease(history, ORG_B, 'test', now, lease);
      expect(first).not.toBeNull();
      expect(Date.parse(String(first?.lease_until))).toBe(now.getTime() + lease);
      expect(await claimLease(history, ORG_B, 'test', now, lease)).toBeNull();
      const later = new Date(now.getTime() + lease + 1);
      expect(await claimLease(history, ORG_B, 'test', later, lease)).not.toBeNull();

      const paused = await admin.from('ksef_history_sync')
        .update({ lease_until: null, client_paused_at: now.toISOString() })
        .eq('tenant_id', ORG_B).eq('environment', 'test').eq('direction', 'outgoing');
      expect(paused.error).toBeNull();
      expect(await claimLease(history, ORG_B, 'test', later, lease)).toBeNull();
    });
  });
});

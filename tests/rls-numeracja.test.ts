import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { loadInvoiceNumbering, readInvoiceSeries } from '@/lib/numeracja/baza';
import { numberConflictOf, saveWithInvoiceNumber, type NumberConflict } from '@/lib/numeracja/nadanie';
import { patternPeriod, patternProblem, renderInvoiceNumber } from '@/lib/numeracja/wzor';

import { getRlsTestEnvironment } from './helpers/rls-environment';

/**
 * 00199 na prawdziwym Postgresie i PostgREST: serie numeracji faktur
 * (plan kompletnej aplikacji, krok 2.5; art. 106e ust. 1 pkt 2 ustawy o VAT:
 * kolejny numer w ramach serii).
 *
 * - dwa (i pięć) wystawień naraz w jednej serii dają różne kolejne numery,
 *   bez dubli i bez luk; ten sam licznik dwa razy naraz: jeden zapis, drugi
 *   `invoice_number_moved` (blokada serii w wyzwalaczu);
 * - obca firma nie widzi serii, nie podejrzy licznika i nie zapisze faktury
 *   z cudzą serią; seriami zarządza właściciel i administrator, wystawia
 *   każdy aktywny członek;
 * - wzór bez licznika i wzór niejednoznaczny są odrzucane (te same reguły co
 *   w aplikacji), a dwie serie firmy nie mogą mieć tego samego układu;
 * - numer zajęty w KSeF (faktura z oryginału, wycofany szkic po 440) nie
 *   wraca z licznika; numer wraca tylko po usunięciu ostatniego szkicu bez
 *   kontaktu z KSeF;
 * - istniejące faktury i ich numery bez zmian; firma bez serii ich nie ma,
 *   dopóki nie zmieni numeracji.
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

const ORG_A = '00199199-0000-4000-8000-00000000000a';
const ORG_B = '00199199-0000-4000-8000-00000000000b';
const EMAILS = {
  owner: 'rls-numeracja-owner@ksef-saas.test',
  admin: 'rls-numeracja-admin@ksef-saas.test',
  member: 'rls-numeracja-member@ksef-saas.test',
  accountant: 'rls-numeracja-ksiegowa@ksef-saas.test',
  obcy: 'rls-numeracja-obcy@ksef-saas.test',
} as const;
type Kto = keyof typeof EMAILS;
const PASS = 'RlsNumeracja2026Aa!';
const NIP = '1234567890';
const BUYER_NIP = '1111111111';
const ALL_KINDS = ['regular', 'advance', 'final', 'correction'];
const PATTERN = 'FV/{N}/{MM}/{RRRR}';

const users: Record<Kto, string> = { owner: '', admin: '', member: '', accountant: '', obcy: '' };

function warsawToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw' }).format(new Date());
}

/** Numer serii PATTERN z licznikiem `n` dla dzisiejszej daty (liczony, nie wpisany na sztywno). */
function nr(n: number, pattern = PATTERN): string {
  return renderInvoiceNumber(pattern, patternPeriod(pattern, warsawToday()), n)!;
}

function anonClient(activeOrg: string) {
  return createClient(environment!.url, environment!.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { 'x-active-org': activeOrg } },
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

async function signedIn(who: Kto, activeOrg: string = ORG_A): Promise<SupabaseClient> {
  const c = anonClient(activeOrg);
  const { error } = await c.auth.signInWithPassword({ email: EMAILS[who], password: PASS });
  if (error) throw error;
  return c;
}

/** Szkic faktury jak `insertInvoiceAndLines`: wszystkie kolumny NOT NULL (masowy insert PostgREST wpisuje NULL w brakujące). */
function draftRow(number: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tenant_id: ORG_A, direction: 'outgoing', ksef_status: 'draft', internal_number: number,
    invoice_type: 'VAT', invoice_kind: 'regular', issue_date: warsawToday(),
    seller_nip: NIP, buyer_nip: BUYER_NIP, gross_total: 123, net_total: 100, vat_total: 23, currency: 'PLN',
    fa3_data: { internalNumber: number, type: 'VAT' }, seller_data: { nip: NIP }, buyer_data: { nip: BUYER_NIP, name: 'Klient' },
    ...extra,
  };
}

async function createSeries(
  c: SupabaseClient,
  args: { name: string; pattern: string; first?: number; defaults?: string[] },
) {
  return c.rpc('invoice_number_series_create', {
    p_name: args.name,
    p_pattern: args.pattern,
    p_first_number: args.first ?? 1,
    p_default_kinds: args.defaults ?? [],
  });
}

async function seriesId(c: SupabaseClient, args: Parameters<typeof createSeries>[1]): Promise<string> {
  const { data, error } = await createSeries(c, args);
  if (error) throw new Error(`seria ${args.name}: ${error.message}`);
  const out = data as { status: string; id?: string };
  if (out.status !== 'created' || !out.id) throw new Error(`seria ${args.name}: ${JSON.stringify(out)}`);
  return out.id;
}

async function next(c: SupabaseClient, series: string): Promise<{ status: string; number?: string; counter?: number; code?: string }> {
  const { data, error } = await c.rpc('invoice_number_next', { p_series_id: series, p_issue_date: warsawToday() });
  if (error) throw new Error(`invoice_number_next: ${error.message}`);
  return data as { status: string; number?: string; counter?: number };
}

type Saved = { success: true; invoiceId: string } | { success: false; error: string; numberConflict?: NumberConflict };

/**
 * Wystawienie jak w akcji zapisu: podpowiedź z formularza, potem prawdziwa
 * ścieżka aplikacji (`saveWithInvoiceNumber`) z INSERT przez PostgREST.
 */
async function issue(c: SupabaseClient, series: string, key: string = crypto.randomUUID()) {
  const preview = (await next(c, series)).number!;
  return saveWithInvoiceNumber<Saved, string>(
    c,
    { typed: preview, seriesId: series, preview, requestKey: key },
    warsawToday(),
    async (assigned): Promise<{ result: Saved; built: string }> => {
      const { data, error } = await c
        .from('invoices')
        .insert({ ...draftRow(assigned.number), ...assigned.columns })
        .select('id, internal_number')
        .single();
      if (error || !data) {
        const conflict = numberConflictOf(error);
        return {
          result: { success: false, error: error?.message ?? 'brak wiersza', ...(conflict ? { numberConflict: conflict } : {}) },
          built: assigned.number,
        };
      }
      return { result: { success: true, invoiceId: data.id as string }, built: data.internal_number as string };
    },
  );
}

async function invoiceRow(id: string) {
  const { data, error } = await admin.from('invoices').select('*').eq('id', id).single();
  if (error) throw error;
  return data as Record<string, unknown>;
}

async function cleanup() {
  for (const org of [ORG_A, ORG_B]) {
    await admin.from('ksef_submissions').delete().eq('tenant_id', org);
    await admin.from('invoices').delete().eq('tenant_id', org);
    await admin.from('invoice_number_counters').delete().eq('tenant_id', org);
    await admin.from('invoice_number_series').delete().eq('tenant_id', org);
  }
}

describe.skipIf(!hasDatabase)('00199: serie numeracji faktur na prawdziwym PostgREST', () => {
  beforeAll(async () => {
    for (const who of Object.keys(EMAILS) as Kto[]) users[who] = await userId(EMAILS[who]);
    await cleanup();
    await admin.from('memberships').delete().in('organization_id', [ORG_A, ORG_B]);
    // Wpisy audytu firmy testowej zostają po przebiegu (00052), więc firmy nie kasujemy, tylko nadpisujemy.
    const tenants = await admin.from('tenants').upsert(
      [
        { id: ORG_A, nip: NIP, name: 'Firma A Numeracja', address_json: { countryCode: 'PL', addressLine1: 'ul. Przykładowa 1', addressLine2: '00-001 Warszawa' } },
        { id: ORG_B, nip: NIP, name: 'Firma B Numeracja', address_json: { countryCode: 'PL', addressLine1: 'ul. Inna 2', addressLine2: '00-002 Warszawa' } },
      ],
      { onConflict: 'id' },
    );
    if (tenants.error) throw tenants.error;
    const profiles = await admin.from('users').upsert(
      (Object.keys(users) as Kto[]).map((who) => ({ id: users[who], name: who })),
      { onConflict: 'id' },
    );
    if (profiles.error) throw profiles.error;
    const memberships = await admin.from('memberships').insert([
      { organization_id: ORG_A, user_id: users.owner, role: 'owner', status: 'active' },
      { organization_id: ORG_A, user_id: users.admin, role: 'admin', status: 'active' },
      { organization_id: ORG_A, user_id: users.member, role: 'member', status: 'active' },
      { organization_id: ORG_A, user_id: users.accountant, role: 'accountant', status: 'active' },
      { organization_id: ORG_B, user_id: users.obcy, role: 'owner', status: 'active' },
    ]);
    if (memberships.error) throw memberships.error;
  });

  beforeEach(async () => {
    await cleanup();
  });

  afterAll(async () => {
    if (!hasDatabase) return;
    await cleanup();
  });

  describe('istniejące firmy i faktury', () => {
    it('firma bez serii: przegląd pusty, faktura bez serii zapisuje się jak dotąd i zostaje bez zmian', async () => {
      const owner = await signedIn('owner');
      expect(await readInvoiceSeries(owner, warsawToday())).toEqual([]);

      const { data, error } = await owner.from('invoices').insert(draftRow('FV/2026/11/007')).select('id').single();
      expect(error).toBeNull();
      const id = (data as { id: string }).id;

      // Pierwsza zmiana numeracji tworzy serię podstawową (bez wzoru) i nową serię.
      const fv = await seriesId(owner, { name: 'Faktury FV', pattern: PATTERN, defaults: ['regular'] });
      const issued = await issue(owner, fv);
      expect(issued.result.success).toBe(true);

      const row = await invoiceRow(id);
      expect(row.internal_number).toBe('FV/2026/11/007');
      expect([row.number_series_id, row.number_period, row.number_counter, row.number_request_key]).toEqual([null, null, null, null]);
    });

    it('podpowiedź dla firmy bez serii: dzisiejsza (kolejny po ostatniej zwykłej fakturze)', async () => {
      const owner = await signedIn('owner');
      const { error } = await owner.from('invoices').insert(draftRow('FV/2026/11/007'));
      expect(error).toBeNull();
      const numbering = await loadInvoiceNumbering(owner, ORG_A, 'regular', warsawToday());
      expect(numbering.selectedId).toBeNull();
      expect(numbering.options).toHaveLength(1);
      expect(numbering.options[0]!.id).toBeNull();
    });

    it('pierwsza seria: seria podstawowa bez wzoru zostaje domyślna dla rodzajów, których nowa seria nie przejęła', async () => {
      const owner = await signedIn('owner');
      const fv = await seriesId(owner, { name: 'Faktury FV', pattern: PATTERN, defaults: ['regular'] });

      const series = await readInvoiceSeries(owner, warsawToday());
      expect(series).toHaveLength(2);
      const basic = series!.find((s) => s.pattern === null)!;
      expect(basic.defaultKinds.sort()).toEqual(['advance', 'correction', 'final']);
      expect(series!.find((s) => s.id === fv)!.defaultKinds).toEqual(['regular']);
      expect(series!.find((s) => s.id === fv)!.next?.number).toBe(nr(1));
    });
  });

  describe('numer z licznika pod blokadą serii', () => {
    it('dwa wystawienia naraz w jednej serii (dwie osoby): dwa różne kolejne numery', async () => {
      const owner = await signedIn('owner');
      const member = await signedIn('member');
      const fv = await seriesId(owner, { name: 'Faktury FV', pattern: PATTERN, defaults: ['regular'] });

      const [a, b] = await Promise.all([issue(owner, fv), issue(member, fv)]);

      expect([a.result.success, b.result.success]).toEqual([true, true]);
      expect([a.built, b.built].sort()).toEqual([nr(1), nr(2)].sort());
    });

    it('pięć wystawień naraz: numery 1-5 bez dubli i bez luk', async () => {
      const owner = await signedIn('owner');
      const fv = await seriesId(owner, { name: 'Faktury FV', pattern: PATTERN, defaults: ['regular'] });

      const wyniki = await Promise.all([1, 2, 3, 4, 5].map(() => issue(owner, fv)));

      expect(wyniki.map((w) => w.result.success)).toEqual([true, true, true, true, true]);
      expect(wyniki.map((w) => w.built).sort()).toEqual([1, 2, 3, 4, 5].map((n) => nr(n)).sort());
    });

    it('ten sam licznik dwa razy naraz: jeden zapis, drugi `invoice_number_moved` (bez dubla)', async () => {
      const owner = await signedIn('owner');
      const fv = await seriesId(owner, { name: 'Faktury FV', pattern: PATTERN, defaults: ['regular'] });
      const columns = { number_series_id: fv, number_period: patternPeriod(PATTERN, warsawToday()), number_counter: 1 };

      const [a, b] = await Promise.all([
        owner.from('invoices').insert({ ...draftRow(nr(1)), ...columns }),
        owner.from('invoices').insert({ ...draftRow(nr(1)), ...columns }),
      ]);

      const errors = [a.error, b.error];
      expect(errors.filter((e) => e === null)).toHaveLength(1);
      expect(errors.find((e) => e !== null)).toMatchObject({ code: 'P0001', message: 'invoice_number_moved' });
      const { data } = await admin.from('invoices').select('internal_number').eq('tenant_id', ORG_A);
      expect((data ?? []).map((r) => r.internal_number)).toEqual([nr(1)]);
    });

    it('licznik niezgodny z numerem albo okresem: odmowa `invoice_number_mismatch`', async () => {
      const owner = await signedIn('owner');
      const fv = await seriesId(owner, { name: 'Faktury FV', pattern: PATTERN, defaults: ['regular'] });
      const period = patternPeriod(PATTERN, warsawToday());

      const wrongNumber = await owner.from('invoices').insert({ ...draftRow('FV/XYZ'), number_series_id: fv, number_period: period, number_counter: 1 });
      expect(wrongNumber.error).toMatchObject({ code: 'P0001', message: 'invoice_number_mismatch' });
      const wrongPeriod = await owner.from('invoices').insert({ ...draftRow(nr(1)), number_series_id: fv, number_period: '1999-01', number_counter: 1 });
      expect(wrongPeriod.error).toMatchObject({ code: 'P0001', message: 'invoice_number_mismatch' });
    });

    it('pierwszy numer serii (kontynuacja numeracji z innego programu)', async () => {
      const owner = await signedIn('owner');
      const fv = await seriesId(owner, { name: 'Faktury FV', pattern: PATTERN, first: 57, defaults: ['regular'] });

      expect((await next(owner, fv)).number).toBe(nr(57));
      expect((await issue(owner, fv)).built).toBe(nr(57));
      expect((await issue(owner, fv)).built).toBe(nr(58));
    });

    it('drugi zapis z tym samym kluczem (podwójne kliknięcie): jedna faktura, odmowa z numerem pierwszej', async () => {
      const owner = await signedIn('owner');
      const fv = await seriesId(owner, { name: 'Faktury FV', pattern: PATTERN, defaults: ['regular'] });
      const key = crypto.randomUUID();

      const first = await issue(owner, fv, key);
      const second = await issue(owner, fv, key);

      expect(first.result.success).toBe(true);
      expect(second.result).toMatchObject({ success: false, invoiceId: first.result.success ? first.result.invoiceId : '' });
      expect(second.result.success ? '' : second.result.error).toContain(nr(1));
      const { data } = await admin.from('invoices').select('id').eq('tenant_id', ORG_A);
      expect(data).toHaveLength(1);
    });

    it('seria, okres, licznik i klucz po zapisie: sesja ich nie zmienia (inne pola szkicu tak)', async () => {
      const owner = await signedIn('owner');
      const fv = await seriesId(owner, { name: 'Faktury FV', pattern: PATTERN, defaults: ['regular'] });
      const issued = await issue(owner, fv);
      const id = issued.result.success ? issued.result.invoiceId : '';

      const counter = await owner.from('invoices').update({ number_counter: 9 }).eq('id', id);
      expect(counter.error?.code).toBe('42501');
      const series = await owner.from('invoices').update({ number_series_id: null }).eq('id', id);
      expect(series.error?.code).toBe('42501');
      const notes = await owner.from('invoices').update({ notes: 'uwagi' }).eq('id', id);
      expect(notes.error).toBeNull();
      expect((await invoiceRow(id)).number_counter).toBe(1);
    });
  });

  describe('numer zajęty w KSeF nie wraca z licznika (plan zero zgubionych faktur)', () => {
    it('faktura z KSeF z numerem w układzie serii (np. oryginał K): licznik ją pomija', async () => {
      const owner = await signedIn('owner');
      const fv = await seriesId(owner, { name: 'Faktury FV', pattern: PATTERN, defaults: ['regular'] });
      const { error } = await admin.from('invoices').insert(
        draftRow(nr(1), {
          origin: 'ksef_import', ksef_status: 'accepted', ksef_environment: 'test',
          ksef_number: `${NIP}-20261111-0100A0B0C0D0-1A`, xml_storage_path: 'k.xml',
        }),
      );
      expect(error).toBeNull();

      expect((await next(owner, fv)).number).toBe(nr(2));
      expect((await issue(owner, fv)).built).toBe(nr(2));
    });

    it('wycofany szkic po 440 (wpis number_taken): klient go nie usunie, a po usunięciu przez serwis numer nie wraca', async () => {
      const owner = await signedIn('owner');
      const fv = await seriesId(owner, { name: 'Faktury FV', pattern: PATTERN, defaults: ['regular'] });
      const issued = await issue(owner, fv);
      const id = issued.result.success ? issued.result.invoiceId : '';
      const sub = await admin.from('ksef_submissions').insert({
        tenant_id: ORG_A, invoice_id: id, submission_type: 'online', status: 'number_taken', error_code: 'NUMBER_TAKEN',
        error_message: `Numer ${nr(1)} zajęty w KSeF`,
      });
      expect(sub.error).toBeNull();

      const byClient = await owner.from('invoices').delete().eq('id', id).select('id');
      expect(byClient.error).not.toBeNull();
      expect((await next(owner, fv)).number).toBe(nr(2));

      const byService = await admin.from('invoices').delete().eq('id', id);
      expect(byService.error).toBeNull();
      expect((await next(owner, fv)).number).toBe(nr(2));
    });

    it('usunięcie ostatniego szkicu bez kontaktu z KSeF oddaje numer; szkic w środku zostawia lukę', async () => {
      const owner = await signedIn('owner');
      const fv = await seriesId(owner, { name: 'Faktury FV', pattern: PATTERN, defaults: ['regular'] });
      const one = await issue(owner, fv);
      const two = await issue(owner, fv);
      const oneId = one.result.success ? one.result.invoiceId : '';
      const twoId = two.result.success ? two.result.invoiceId : '';

      expect((await owner.from('invoices').delete().eq('id', twoId)).error).toBeNull();
      expect((await next(owner, fv)).number).toBe(nr(2));

      expect((await issue(owner, fv)).built).toBe(nr(2));
      expect((await owner.from('invoices').delete().eq('id', oneId)).error).toBeNull();
      expect((await next(owner, fv)).number).toBe(nr(3));
    });

    it('numer wpisany ręcznie w układzie serii: licznik go pomija', async () => {
      const owner = await signedIn('owner');
      const fv = await seriesId(owner, { name: 'Faktury FV', pattern: PATTERN, defaults: ['regular'] });
      const manual = await owner.from('invoices').insert({ ...draftRow(nr(1)), number_series_id: fv });
      expect(manual.error).toBeNull();

      expect((await issue(owner, fv)).built).toBe(nr(2));
    });
  });

  describe('obca firma i role', () => {
    it('obca firma nie widzi serii, nie podejrzy licznika i nie zapisze faktury z cudzą serią', async () => {
      const owner = await signedIn('owner');
      const fv = await seriesId(owner, { name: 'Faktury FV', pattern: PATTERN, defaults: ['regular'] });
      const obcy = await signedIn('obcy', ORG_B);

      expect(await readInvoiceSeries(obcy, warsawToday())).toEqual([]);
      const { data: visible } = await obcy.from('invoice_number_series').select('id');
      expect(visible).toEqual([]);
      const { data: counters } = await obcy.from('invoice_number_counters').select('id');
      expect(counters).toEqual([]);
      expect(await next(obcy, fv)).toEqual({ status: 'refused', code: 'not_found' });

      const ownTenant = await obcy.from('invoices').insert({
        ...draftRow(nr(1)), tenant_id: ORG_B, number_series_id: fv,
        number_period: patternPeriod(PATTERN, warsawToday()), number_counter: 1,
      });
      expect(ownTenant.error).toMatchObject({ message: 'invoice_number_series_not_found' });
      const foreignTenant = await obcy.from('invoices').insert({
        ...draftRow(nr(1)), number_series_id: fv,
        number_period: patternPeriod(PATTERN, warsawToday()), number_counter: 1,
      });
      expect(foreignTenant.error?.code).toBe('42501');

      const update = await obcy.rpc('invoice_number_series_update', { p_series_id: fv, p_name: 'Przejęta', p_default_kinds: ['regular'] });
      expect(update.data).toEqual({ status: 'refused', code: 'not_found' });
      expect((await readInvoiceSeries(owner, warsawToday()))!.find((s) => s.id === fv)!.name).toBe('Faktury FV');
    });

    it.each(['member', 'accountant'] as const)('%s nie zmienia serii (zarządza właściciel i administrator), ale wystawia z serii', async (who) => {
      const owner = await signedIn('owner');
      const fv = await seriesId(owner, { name: 'Faktury FV', pattern: PATTERN, defaults: ['regular'] });
      const c = await signedIn(who);

      const created = await createSeries(c, { name: 'Moja', pattern: 'M/{N}' });
      expect(created.error?.code).toBe('42501');
      const archived = await c.rpc('invoice_number_series_set_active', { p_series_id: fv, p_active: false });
      expect(archived.error?.code).toBe('42501');
      expect((await issue(c, fv)).result.success).toBe(true);
    });

    it('administrator zakłada serię; zmiana trafia do audytu', async () => {
      const adminClient = await signedIn('admin');
      const id = await seriesId(adminClient, { name: 'Sklep Gdańsk', pattern: 'GD/{N}/{RRRR}' });

      const { data } = await admin
        .from('audit_logs')
        .select('action, user_id, metadata')
        .eq('entity_id', id)
        .eq('action', 'invoice_number_series.created');
      expect(data).toHaveLength(1);
      expect(data![0]).toMatchObject({ user_id: users.admin, metadata: { pattern: 'GD/{N}/{RRRR}' } });
    });
  });

  describe('wzór i układ serii', () => {
    it('wzór bez licznika i wzór niejednoznaczny: odmowa z kodem problemu', async () => {
      const owner = await signedIn('owner');
      for (const [pattern, problem] of [['FV/{RRRR}', 'no_counter'], ['{N}{M}/{RRRR}', 'ambiguous'], ['FV/{N}/{MM}', 'month_without_year']] as const) {
        const { data, error } = await createSeries(owner, { name: `Zła ${problem}`, pattern });
        expect(error).toBeNull();
        expect(data).toEqual({ status: 'refused', code: 'pattern', problem });
      }
      expect(await readInvoiceSeries(owner, warsawToday())).toEqual([]);
    });

    it('baza i aplikacja oceniają wzory tak samo i tak samo składają numer', async () => {
      const patterns = [
        PATTERN, 'FV/{NNN}/{MM}/{RRRR}', 'KOR/{RRRR}/{NNNN}', 'FV{RRRR}{NNNN}', '{N}/{M}/{RRRR}', '{N}', 'F {N}',
        '', 'FV/{RRRR}', 'FV/{N}/{N}', 'FV/{N}/{MM}', '{N}{M}/{RRRR}', '{N}1{M}/{RRRR}', 'FV/{X}', 'FV#{N}', ' FV/{N}',
        'FV/{N}/{RRRR}/ABCDEFGHIJKLMNOPQ',
      ];
      for (const pattern of patterns) {
        const { data, error } = await admin.rpc('invoice_number_pattern_problem', { p_pattern: pattern });
        expect(error).toBeNull();
        expect([pattern, data]).toEqual([pattern, patternProblem(pattern)]);
      }
      for (const [pattern, period, counter] of [[PATTERN, '2026-03', 15], ['FV/{NNN}/{MM}/{RRRR}', '2026-11', 1234], ['INV-{NNNN}', '', 42], ['{N}/{M}/{RRRR}', '2026-01', 7]] as const) {
        const { data } = await admin.rpc('invoice_number_render', { p_pattern: pattern, p_period: period, p_counter: counter });
        expect(data).toBe(renderInvoiceNumber(pattern, period, counter));
      }
    });

    it('dwie serie firmy nie mogą mieć tego samego układu (numery by się myliły); inna firma może', async () => {
      const owner = await signedIn('owner');
      await seriesId(owner, { name: 'Faktury FV', pattern: PATTERN, defaults: ['regular'] });

      const same = await createSeries(owner, { name: 'Druga FV', pattern: 'FV/{NNN}/{M}/{RRRR}' });
      expect(same.data).toEqual({ status: 'refused', code: 'pattern_taken' });
      const otherPrefix = await createSeries(owner, { name: 'Waluty', pattern: 'FW/{N}/{MM}/{RRRR}' });
      expect(otherPrefix.data).toMatchObject({ status: 'created' });
      const obcy = await signedIn('obcy', ORG_B);
      expect((await createSeries(obcy, { name: 'Faktury FV', pattern: PATTERN })).data).toMatchObject({ status: 'created' });
    });

    it('seria domyślna nie jest ukrywana ani usuwana; ukryta nie nadaje numerów; używanej nie usuwa się', async () => {
      const owner = await signedIn('owner');
      const fv = await seriesId(owner, { name: 'Faktury FV', pattern: PATTERN, defaults: ['regular'] });
      const fw = await seriesId(owner, { name: 'Waluty', pattern: 'FW/{N}/{RRRR}' });

      expect((await owner.rpc('invoice_number_series_set_active', { p_series_id: fv, p_active: false })).data)
        .toEqual({ status: 'refused', code: 'is_default' });
      expect((await owner.rpc('invoice_number_series_delete', { p_series_id: fv })).data)
        .toEqual({ status: 'refused', code: 'is_default' });

      expect((await issue(owner, fw)).result.success).toBe(true);
      expect((await owner.rpc('invoice_number_series_delete', { p_series_id: fw })).data)
        .toEqual({ status: 'refused', code: 'used' });
      expect((await owner.rpc('invoice_number_series_set_active', { p_series_id: fw, p_active: false })).data)
        .toEqual({ status: 'updated' });
      expect(await next(owner, fw)).toEqual({ status: 'refused', code: 'archived' });
      const archivedInsert = await owner.from('invoices').insert({ ...draftRow('FW/9/2026'), number_series_id: fw });
      expect(archivedInsert.error).toMatchObject({ message: 'invoice_number_series_archived' });

      const unused = await seriesId(owner, { name: 'Pomyłka', pattern: 'PM/{N}' });
      expect((await owner.rpc('invoice_number_series_delete', { p_series_id: unused })).data).toEqual({ status: 'deleted' });
    });

    it('domyślna seria rodzaju przechodzi na inną serię, a rodzaj nie zostaje bez serii domyślnej', async () => {
      const owner = await signedIn('owner');
      const fv = await seriesId(owner, { name: 'Faktury FV', pattern: PATTERN, defaults: ['regular'] });
      const kor = await seriesId(owner, { name: 'Korekty', pattern: 'KOR/{N}/{RRRR}', defaults: ['correction'] });

      const drop = await owner.rpc('invoice_number_series_update', { p_series_id: kor, p_name: 'Korekty', p_default_kinds: [] });
      expect(drop.data).toEqual({ status: 'refused', code: 'default_required' });
      const take = await owner.rpc('invoice_number_series_update', { p_series_id: fv, p_name: 'Faktury FV', p_default_kinds: ['regular', 'correction'] });
      expect(take.data).toEqual({ status: 'updated' });

      const series = (await readInvoiceSeries(owner, warsawToday()))!;
      const defaults = ALL_KINDS.map((kind) => series.filter((s) => s.defaultKinds.includes(kind as never)).map((s) => s.id));
      expect(defaults.every((ids) => ids.length === 1)).toBe(true);
      expect(series.find((s) => s.id === kor)!.defaultKinds).toEqual([]);
      expect((await loadInvoiceNumbering(owner, ORG_A, 'correction', warsawToday())).selectedId).toBe(fv);
    });
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { nrbZNumeruBankuIRachunku } from '@/lib/import/bank/rachunek';
import { mikrorachunekZNip } from '@/lib/ksiegowosc/mikrorachunek';

import { getRlsTestEnvironment } from './helpers/rls-environment';

/**
 * Przelewy do ZUS i urzędu skarbowego z wyciągu jako zapłaty rozliczeń modułu
 * księgowości (plan kompletnej aplikacji, krok 3.2, część 2, migracja 00189)
 * na prawdziwym Postgresie i PostgREST: `import_bank_operations` z przelewami
 * podatkowymi, `bank_tax_operations`, `confirm_bank_tax_payment`,
 * `undo_bank_tax_payment` i `skip_bank_operation` razem z wyzwalaczem
 * niezmienności rozliczeń (00168).
 *
 * Niezmienniki:
 *  - wypływ z pliku wchodzi tylko jako przelew do ZUS (rachunek składkowy
 *    z ustawień) albo na mikrorachunek z NIP firmy, tylko przy włączonym module;
 *  - potwierdzenie oznacza rozliczenia jako zapłacone z dniem księgowania, raz;
 *    drugie wywołanie nic nie zmienia, a rozliczenia nie potwierdzi drugi przelew;
 *  - kwota z banku zostaje przy operacji, kwota rozliczenia bez zmian;
 *  - zapłatę potwierdza tylko owner/admin swojej firmy;
 *  - cofnięcie oddaje rozliczeniom stan sprzed potwierdzenia, chyba że ktoś
 *    zmienił je w międzyczasie (wtedy zostają).
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

const ORG_A = '00189186-0000-4000-8000-00000000000a';
const ORG_B = '00189186-0000-4000-8000-00000000000b';
const EMAILS = {
  owner: 'rls-podatki-owner@ksef-saas.test',
  member: 'rls-podatki-member@ksef-saas.test',
  accountant: 'rls-podatki-ksiegowa@ksef-saas.test',
  obcy: 'rls-podatki-obcy@ksef-saas.test',
} as const;
const PASS = 'RlsPodatki2026Aa!';
// Fikcyjne NIP-y z poprawną sumą kontrolną (1234567890 z AGENTS.md nie ma mikrorachunku).
const NIP_A = '1234563218';
const NIP_B = '1111111111';
const MIKRO_A = `PL${mikrorachunekZNip(NIP_A)}`;
const MIKRO_B = `PL${mikrorachunekZNip(NIP_B)}`;
const NRS_A = nrbZNumeruBankuIRachunku('60000002', '0260123456789012')!;
const RACHUNEK = 'PL61109010140000071219812874';
const DOSTAWCA = 'PL27114020040000300201355387';
const DZIEN = '2026-10-15';

const users: Record<keyof typeof EMAILS, string> = { owner: '', member: '', accountant: '', obcy: '' };
let counter = 0;
let keyCounter = 0;

function opKey(): string {
  keyCounter += 1;
  return `v1:${String(keyCounter).padStart(8, '0')}${'cd'.repeat(28)}`;
}

function anonClient(activeOrg?: string) {
  return createClient(environment!.url, environment!.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: activeOrg ? { headers: { 'x-active-org': activeOrg } } : undefined,
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

async function signedIn(who: keyof typeof EMAILS, activeOrg: string = ORG_A): Promise<SupabaseClient> {
  const c = anonClient(activeOrg);
  const { error } = await c.auth.signInWithPassword({ email: EMAILS[who], password: PASS });
  if (error) throw error;
  return c;
}

/** Zatwierdzone rozliczenie za wrzesień 2026 (wszystkie kolumny NOT NULL). */
async function rozliczenie(fields: Record<string, unknown>): Promise<string> {
  counter += 1;
  const id = `00189186-2222-4000-8000-${String(counter).padStart(12, '0')}`;
  const { error } = await admin.from('tax_settlements').insert({
    id,
    tenant_id: ORG_A,
    okres: '2026-09-01',
    rodzaj: 'ryczalt',
    wersja: 1,
    kwota_gr: 120000,
    termin: '2026-10-20',
    migawka: { wejscia: { test: true }, spoleczneBezFpGr: 0 },
    parametry_wersja: 'test00189',
    wejscia_hash: 'a'.repeat(64),
    ...fields,
  });
  if (error) throw new Error(`rozliczenie: ${error.message}`);
  return id;
}

async function stan(id: string) {
  const { data, error } = await admin.from('tax_settlements').select('status, zaplacone_o, kwota_gr').eq('id', id).single();
  if (error) throw error;
  return { status: data.status as string, zaplacone_o: data.zaplacone_o as string | null, kwota_gr: Number(data.kwota_gr) };
}

interface Operacja {
  key: string;
  account: string;
  booking_date: string;
  amount: string;
  currency: string;
  counterparty_name: string | null;
  counterparty_account: string | null;
  title: string | null;
  reference: string | null;
  tax_kind?: string;
}

/** Przelew do ZUS za 2000 zł; `tax_kind: undefined` usuwa rodzaj (JSON go pomija). */
function doZus(over: Partial<Operacja> = {}): Operacja {
  return {
    key: opKey(),
    account: RACHUNEK,
    booking_date: DZIEN,
    amount: '-2000.00',
    currency: 'PLN',
    counterparty_name: 'ZUS',
    counterparty_account: NRS_A,
    title: 'SKLADKI 09/2026',
    reference: 'REF-ZUS',
    tax_kind: 'zus',
    ...over,
  };
}

function doUrzedu(over: Partial<Operacja> = {}): Operacja {
  return doZus({
    amount: '-1234.00',
    counterparty_name: 'URZAD SKARBOWY',
    counterparty_account: MIKRO_A,
    title: `/TI/N${NIP_A}/OKR/26M09/SFP/PPE/`,
    reference: 'REF-US',
    tax_kind: 'us',
    ...over,
  });
}

function wplyw(over: Partial<Operacja> = {}): Operacja {
  return doZus({ amount: '100.00', counterparty_name: 'Nabywca', counterparty_account: DOSTAWCA, title: 'FV/1', tax_kind: undefined, ...over });
}

function wgraj(c: SupabaseClient, operations: unknown) {
  return c.rpc('import_bank_operations', { p_file_format: 'mt940', p_operations: operations });
}

async function idOperacji(key: string): Promise<string> {
  const { data, error } = await admin.from('payment_imports').select('id').eq('tenant_id', ORG_A).eq('transaction_id', key).single();
  if (error) throw error;
  return data.id as string;
}

async function operacja(id: string) {
  const { data, error } = await admin
    .from('payment_imports')
    .select('is_matched, matched_payment_id, ignored, tax_kind, tax_settlement_ids, tax_marked_ids, decided_at, decided_by, title, redacted_at, amount')
    .eq('id', id)
    .single();
  if (error) throw error;
  return { ...data, amount: Number(data.amount) };
}

const potwierdz = (c: SupabaseClient, operationId: string, ids: string[], kind = 'amount') =>
  c.rpc('confirm_bank_tax_payment', { p_operation_id: operationId, p_settlement_ids: ids, p_match_kind: kind });

async function cleanup() {
  for (const org of [ORG_A, ORG_B]) {
    await admin.from('payment_imports').delete().eq('tenant_id', org);
    await admin.from('tax_settlements').delete().eq('tenant_id', org);
  }
}

describe.skipIf(!hasDatabase)('Przelewy do ZUS i urzędu z wyciągu (00189)', () => {
  beforeAll(async () => {
    for (const who of Object.keys(EMAILS) as Array<keyof typeof EMAILS>) {
      users[who] = await userId(EMAILS[who]);
    }
    await cleanup();
    await admin.from('tax_profiles').delete().in('tenant_id', [ORG_A, ORG_B]);
    await admin.from('tenant_feature_flags').delete().in('tenant_id', [ORG_A, ORG_B]);
    await admin.from('memberships').delete().in('organization_id', [ORG_A, ORG_B]);
    const tenants = await admin.from('tenants').upsert([
      { id: ORG_A, nip: NIP_A, name: 'Firma A Podatki' },
      { id: ORG_B, nip: NIP_B, name: 'Firma B Podatki' },
    ], { onConflict: 'id' });
    if (tenants.error) throw tenants.error;
    const profiles = await admin.from('users').upsert(
      (Object.keys(users) as Array<keyof typeof EMAILS>).map((who) => ({ id: users[who], name: who })),
      { onConflict: 'id' },
    );
    if (profiles.error) throw profiles.error;
    const memberships = await admin.from('memberships').insert([
      { organization_id: ORG_A, user_id: users.owner, role: 'owner', status: 'active' },
      { organization_id: ORG_A, user_id: users.member, role: 'member', status: 'active' },
      { organization_id: ORG_A, user_id: users.accountant, role: 'accountant', status: 'active' },
      { organization_id: ORG_B, user_id: users.obcy, role: 'owner', status: 'active' },
    ]);
    if (memberships.error) throw memberships.error;
    const profil = await admin.from('tax_profiles').insert({
      tenant_id: ORG_A,
      valid_from: '2026-01-01',
      forma: 'ryczalt',
      stawka_domyslna: 1200,
      zus_etap: 'pelny',
      chorobowe: false,
      nrs_zus: NRS_A.slice(2),
    });
    if (profil.error) throw profil.error;
  });

  beforeEach(async () => {
    await cleanup();
    const flags = await admin.from('tenant_feature_flags').upsert(
      [{ tenant_id: ORG_A, ksiegowosc_enabled: true }, { tenant_id: ORG_B, ksiegowosc_enabled: true }],
      { onConflict: 'tenant_id' },
    );
    if (flags.error) throw flags.error;
  });

  afterAll(async () => {
    await cleanup();
    await admin.from('tax_profiles').delete().in('tenant_id', [ORG_A, ORG_B]);
    await admin.from('tenant_feature_flags').delete().in('tenant_id', [ORG_A, ORG_B]);
    await admin.from('memberships').delete().in('organization_id', [ORG_A, ORG_B]);
  });

  describe('wgranie', () => {
    it('przelewy do ZUS i na mikrorachunek wchodzą z rodzajem, ten sam plik drugi raz nic nie dodaje', async () => {
      const c = await signedIn('owner');
      const ops = [wplyw(), doZus(), doUrzedu()];

      expect((await wgraj(c, ops)).data).toMatchObject({ status: 'imported', received: 3, inserted: 3, duplicates: 0, tax_inserted: 2 });
      expect((await wgraj(c, ops)).data).toMatchObject({ status: 'imported', inserted: 0, duplicates: 3, tax_inserted: 0 });

      const { data } = await admin.from('payment_imports').select('tax_kind, amount').eq('tenant_id', ORG_A).order('amount');
      expect(data?.map((r) => [r.tax_kind, Number(r.amount)])).toEqual([['zus', -2000], ['us', -1234], [null, 100]]);
    });

    it('odmowa całej paczki: wypływ bez rodzaju, rodzaj przy wpływie, nieznany rodzaj, rachunek spoza ustawień, mikrorachunek innej firmy', async () => {
      const c = await signedIn('owner');
      for (const [bad, code] of [
        [doZus({ tax_kind: undefined }), 'invalid_operation'],
        [doZus({ amount: '2000.00' }), 'invalid_operation'],
        [doZus({ amount: '-0.00' }), 'invalid_operation'],
        [doZus({ tax_kind: 'vat' }), 'invalid_operation'],
        [doZus({ counterparty_account: DOSTAWCA }), 'tax_account'],
        [doZus({ counterparty_account: null }), 'tax_account'],
        [doUrzedu({ counterparty_account: MIKRO_B }), 'tax_account'],
        [doUrzedu({ counterparty_account: NRS_A }), 'tax_account'],
      ] as const) {
        const { data } = await wgraj(c, [wplyw(), bad]);
        expect(data, JSON.stringify(bad)).toMatchObject({ status: 'refused', code, index: 1 });
      }
      const { count } = await admin.from('payment_imports').select('id', { count: 'exact', head: true }).eq('tenant_id', ORG_A);
      expect(count).toBe(0);
    });

    it('moduł wyłączony dla firmy: przelew podatkowy to odmowa, same wpływy wchodzą dalej', async () => {
      await admin.from('tenant_feature_flags').update({ ksiegowosc_enabled: false }).eq('tenant_id', ORG_A);
      const c = await signedIn('owner');
      expect((await wgraj(c, [wplyw(), doZus()])).data).toMatchObject({ status: 'refused', code: 'tax_module_disabled' });
      expect((await wgraj(c, [wplyw()])).data).toMatchObject({ status: 'imported', inserted: 1, tax_inserted: 0 });
    });
  });

  describe('lista i role', () => {
    it('przelewy podatkowe są w bank_tax_operations, nie w liście wpływów; księgowa czyta, obca firma nic nie widzi', async () => {
      const owner = await signedIn('owner');
      await wgraj(owner, [doZus(), doUrzedu()]);

      const lista = await owner.rpc('bank_tax_operations');
      expect(lista.error).toBeNull();
      expect(lista.data).toMatchObject({ pending_total: 2, decided: [], links: [] });
      expect(lista.data.pending.map((p: { tax_kind: string; amount: number }) => [p.tax_kind, Number(p.amount)]).sort()).toEqual([['us', -1234], ['zus', -2000]]);
      expect((await owner.rpc('bank_operations')).data).toMatchObject({ pending: [], pending_total: 0 });

      const ksiegowa = await signedIn('accountant');
      expect((await ksiegowa.rpc('bank_tax_operations')).data.pending).toHaveLength(2);
      const obcy = await signedIn('obcy', ORG_B);
      expect((await obcy.rpc('bank_tax_operations')).data).toMatchObject({ pending: [], pending_total: 0 });
    });

    it('członek i księgowa nie potwierdzają ani nie cofają; obca firma nie znajdzie operacji', async () => {
      const owner = await signedIn('owner');
      const sp = await rozliczenie({ rodzaj: 'zus_spoleczne', kwota_gr: 150000 });
      const op = doZus();
      await wgraj(owner, [op]);
      const opId = await idOperacji(op.key);

      for (const who of ['member', 'accountant'] as const) {
        const c = await signedIn(who);
        expect((await potwierdz(c, opId, [sp])).error?.code).toBe('42501');
        expect((await c.rpc('undo_bank_tax_payment', { p_operation_id: opId })).error?.code).toBe('42501');
      }
      const obcy = await signedIn('obcy', ORG_B);
      expect((await potwierdz(obcy, opId, [sp])).data).toMatchObject({ status: 'refused', code: 'operation_not_found' });
      expect(await stan(sp)).toMatchObject({ status: 'zatwierdzone', zaplacone_o: null });
    });
  });

  describe('potwierdzenie', () => {
    it('ZUS: oba rozliczenia zapłacone z dniem z wyciągu, raz; ponowienie zwraca „już potwierdzone”', async () => {
      const owner = await signedIn('owner');
      const sp = await rozliczenie({ rodzaj: 'zus_spoleczne', kwota_gr: 150000 });
      const zd = await rozliczenie({ rodzaj: 'zdrowotna', kwota_gr: 50000 });
      const op = doZus();
      await wgraj(owner, [op]);
      const opId = await idOperacji(op.key);

      const first = await potwierdz(owner, opId, [zd, sp]);
      expect(first.error).toBeNull();
      expect(first.data).toMatchObject({
        status: 'confirmed', tax_kind: 'zus', marked: 2, okres: '2026-09', paid_on: DZIEN,
        bank_amount_gr: 200000, computed_gr: 200000, difference_gr: 0,
      });
      expect((await potwierdz(owner, opId, [sp, zd])).data).toMatchObject({ status: 'already_confirmed' });

      for (const id of [sp, zd]) expect(await stan(id)).toMatchObject({ status: 'zaplacone', zaplacone_o: DZIEN });
      const row = await operacja(opId);
      expect(row).toMatchObject({ is_matched: true, matched_payment_id: null, ignored: false, decided_by: users.owner });
      expect(row.tax_settlement_ids).toEqual([sp, zd].sort());
      expect([...(row.tax_marked_ids as string[])].sort()).toEqual([sp, zd].sort());

      const audyt = await admin.from('audit_logs').select('action, entity_id').eq('tenant_id', ORG_A)
        .in('action', ['bank.tax_payment_confirmed', 'tax_settlement.paid']).gte('created_at', new Date(Date.now() - 60_000).toISOString());
      expect(audyt.data?.filter((a) => a.action === 'bank.tax_payment_confirmed' && a.entity_id === opId)).toHaveLength(1);
      expect(audyt.data?.filter((a) => a.action === 'tax_settlement.paid' && [sp, zd].includes(a.entity_id as string))).toHaveLength(2);
    });

    it('kwota z banku inna niż wyliczona: zapis kwoty z banku i różnica, wyliczenie bez zmian', async () => {
      const owner = await signedIn('owner');
      const ry = await rozliczenie({ rodzaj: 'ryczalt', kwota_gr: 120000 });
      const op = doUrzedu();
      await wgraj(owner, [op]);
      const opId = await idOperacji(op.key);

      expect((await potwierdz(owner, opId, [ry], 'title')).data).toMatchObject({
        status: 'confirmed', tax_kind: 'us', bank_amount_gr: 123400, computed_gr: 120000, difference_gr: 3400,
      });
      expect(await stan(ry)).toEqual({ status: 'zaplacone', zaplacone_o: DZIEN, kwota_gr: 120000 });
      expect((await operacja(opId)).amount).toBe(-1234);
    });

    it('jedno rozliczenie, jeden przelew; nowsza wersja, przelew sprzed okresu i zły rodzaj to odmowa bez zmian', async () => {
      const owner = await signedIn('owner');
      const ry = await rozliczenie({ rodzaj: 'ryczalt' });
      const vat1 = await rozliczenie({ rodzaj: 'vat', wersja: 1, kwota_gr: 50000 });
      const vat2 = await rozliczenie({ rodzaj: 'vat', wersja: 2, kwota_gr: 60000 });
      const pierwszy = doUrzedu();
      const drugi = doUrzedu({ amount: '-1200.00' });
      const wczesny = doUrzedu({ booking_date: '2026-08-20', amount: '-600.00' });
      const zus = doZus();
      await wgraj(owner, [pierwszy, drugi, wczesny, zus]);

      expect((await potwierdz(owner, await idOperacji(pierwszy.key), [ry], 'title')).data).toMatchObject({ status: 'confirmed' });
      expect((await potwierdz(owner, await idOperacji(drugi.key), [ry], 'manual')).data).toMatchObject({
        status: 'refused', code: 'settlement_linked', linked_on: DZIEN,
      });
      expect((await potwierdz(owner, await idOperacji(drugi.key), [vat1], 'manual')).data).toMatchObject({ status: 'refused', code: 'settlement_outdated' });
      expect((await potwierdz(owner, await idOperacji(wczesny.key), [vat2], 'manual')).data).toMatchObject({
        status: 'refused', code: 'paid_before_period', okres: '2026-09',
      });
      expect((await potwierdz(owner, await idOperacji(zus.key), [vat2], 'manual')).data).toMatchObject({ status: 'refused', code: 'settlement_kind' });
      expect((await potwierdz(owner, await idOperacji(drugi.key), [vat2, ry], 'manual')).data).toMatchObject({ status: 'refused', code: 'settlement_kind' });
      expect(await stan(vat1)).toMatchObject({ status: 'zatwierdzone' });
      expect(await stan(vat2)).toMatchObject({ status: 'zatwierdzone' });
      expect(await operacja(await idOperacji(drugi.key))).toMatchObject({ is_matched: false, tax_settlement_ids: null, decided_at: null });
    });

    it('moduł wyłączony po wgraniu: potwierdzenie to odmowa', async () => {
      const owner = await signedIn('owner');
      const ry = await rozliczenie({});
      const op = doUrzedu();
      await wgraj(owner, [op]);
      await admin.from('tenant_feature_flags').update({ ksiegowosc_enabled: false }).eq('tenant_id', ORG_A);
      expect((await potwierdz(owner, await idOperacji(op.key), [ry], 'title')).data).toMatchObject({ status: 'refused', code: 'tax_module_disabled' });
      expect(await stan(ry)).toMatchObject({ status: 'zatwierdzone' });
    });

    it('rozliczenie już oznaczone jako zapłacone: przelew dochodzi jako dowód, data zostaje', async () => {
      const owner = await signedIn('owner');
      const ry = await rozliczenie({ status: 'zaplacone', zaplacone_o: '2026-10-01' });
      const op = doUrzedu();
      await wgraj(owner, [op]);
      const opId = await idOperacji(op.key);

      expect((await potwierdz(owner, opId, [ry], 'title')).data).toMatchObject({ status: 'confirmed', marked: 0 });
      expect(await stan(ry)).toMatchObject({ status: 'zaplacone', zaplacone_o: '2026-10-01' });
      expect((await owner.rpc('undo_bank_tax_payment', { p_operation_id: opId })).data).toMatchObject({ status: 'undone', reverted: 0, kept: 0 });
      expect(await stan(ry)).toMatchObject({ status: 'zaplacone', zaplacone_o: '2026-10-01' });
    });
  });

  describe('cofnięcie i pominięcie', () => {
    it('cofnięcie oddaje stan sprzed potwierdzenia; rozliczenie zmienione w międzyczasie zostaje', async () => {
      const owner = await signedIn('owner');
      const sp = await rozliczenie({ rodzaj: 'zus_spoleczne', kwota_gr: 150000 });
      const zd = await rozliczenie({ rodzaj: 'zdrowotna', kwota_gr: 50000 });
      const op = doZus();
      await wgraj(owner, [op]);
      const opId = await idOperacji(op.key);
      await potwierdz(owner, opId, [sp, zd]);
      // Klient poprawił datę składek społecznych w „Ten miesiąc” po potwierdzeniu.
      expect((await owner.from('tax_settlements').update({ zaplacone_o: '2026-10-20' }).eq('id', sp)).error).toBeNull();

      expect((await owner.rpc('undo_bank_tax_payment', { p_operation_id: opId })).data).toMatchObject({ status: 'undone', reverted: 1, kept: 1 });
      expect(await stan(sp)).toMatchObject({ status: 'zaplacone', zaplacone_o: '2026-10-20' });
      expect(await stan(zd)).toMatchObject({ status: 'zatwierdzone', zaplacone_o: null });
      expect(await operacja(opId)).toMatchObject({ is_matched: false, tax_settlement_ids: null, tax_marked_ids: null, decided_at: null });
      expect((await owner.rpc('undo_bank_tax_payment', { p_operation_id: opId })).data).toMatchObject({ status: 'not_confirmed' });
      expect((await owner.rpc('bank_tax_operations')).data.pending.map((p: { id: string }) => p.id)).toEqual([opId]);

      // Po cofnięciu ta sama operacja potwierdza się jeszcze raz.
      expect((await potwierdz(owner, opId, [zd], 'manual')).data).toMatchObject({ status: 'confirmed', marked: 1 });
    });

    it('„Pomiń” przy potwierdzonej zapłacie to odmowa; czekający przelew traci tytuł i dane odbiorcy', async () => {
      const owner = await signedIn('owner');
      const ry = await rozliczenie({});
      const potwierdzony = doUrzedu();
      const czekajacy = doZus();
      await wgraj(owner, [potwierdzony, czekajacy]);
      const opId = await idOperacji(potwierdzony.key);
      await potwierdz(owner, opId, [ry], 'title');

      expect((await owner.rpc('skip_bank_operation', { p_operation_id: opId })).data).toMatchObject({ status: 'refused', code: 'tax_payment_confirmed' });
      expect((await owner.rpc('undo_bank_operation', { p_operation_id: opId })).data).toMatchObject({ status: 'not_confirmed' });
      expect(await stan(ry)).toMatchObject({ status: 'zaplacone' });

      const czekaId = await idOperacji(czekajacy.key);
      expect((await owner.rpc('skip_bank_operation', { p_operation_id: czekaId })).data).toMatchObject({ status: 'skipped' });
      expect(await operacja(czekaId)).toMatchObject({ ignored: true, title: null, tax_kind: 'zus' });
      expect((await potwierdz(owner, czekaId, [ry])).data).toMatchObject({ status: 'refused', code: 'operation_skipped' });
      const decided = (await owner.rpc('bank_tax_operations')).data.decided as Array<{ id: string; state: string; settlement_ids: string[] }>;
      expect(decided.map((d) => [d.id, d.state])).toEqual(expect.arrayContaining([[opId, 'confirmed'], [czekaId, 'skipped']]));
      expect(decided.find((d) => d.id === opId)?.settlement_ids).toEqual([ry]);
    });

    it('rodzaju przelewu nie zmieni nawet klucz serwisowy', async () => {
      const owner = await signedIn('owner');
      const op = doZus();
      await wgraj(owner, [op]);
      expect((await admin.from('payment_imports').update({ tax_kind: 'us' }).eq('id', await idOperacji(op.key))).error).not.toBeNull();
    });
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { getNote, listNoteEmails } from '@/lib/noty/baza';
import { formatNoteNumber, noteTotal } from '@/lib/noty/model';

import { getRlsTestEnvironment } from './helpers/rls-environment';

/**
 * 00193 na prawdziwym Postgresie i PostgREST: noty obciążeniowe i uznaniowe
 * (plan kompletnej aplikacji, krok 2.9, część 1).
 *
 * - izolacja firm: obca firma nie widzi not, nie zapisze noty dla innej firmy,
 *   nie wskaże kontrahenta innej firmy i nie wystawi cudzej noty;
 * - rola jak przy fakturach: każdy aktywny członek (także księgowy) zapisuje
 *   i wystawia, zawieszony członek nic;
 * - numer nadaje tylko baza (RPC), osobna seria na firmę, rodzaj i rok, bez
 *   dubli przy kilku wystawieniach naraz; drugie wystawienie tej samej noty
 *   oddaje ten sam numer;
 * - wystawionej noty nie zmienia nikt (RLS i wyzwalacz), także klucz
 *   serwisowy; usunięcie kontrahenta zostawia migawkę danych;
 * - historia wysyłek mailem: tylko przez RPC, raz na klucz idempotencji,
 *   z audytem.
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

const ORG_A = '00193193-0000-4000-8000-00000000000a';
const ORG_B = '00193193-0000-4000-8000-00000000000b';
const KONTRAHENT_A = '00193193-1111-4000-8000-00000000000a';
const KONTRAHENT_B = '00193193-1111-4000-8000-00000000000b';
const EMAILS = {
  owner: 'rls-noty-owner@ksef-saas.test',
  member: 'rls-noty-member@ksef-saas.test',
  accountant: 'rls-noty-ksiegowa@ksef-saas.test',
  zawieszony: 'rls-noty-zawieszony@ksef-saas.test',
  obcy: 'rls-noty-obcy@ksef-saas.test',
} as const;
type Kto = keyof typeof EMAILS;
const PASS = 'RlsNoty2026Aa!';
const NIP = '1234567890';

const users: Record<Kto, string> = { owner: '', member: '', accountant: '', zawieszony: '', obcy: '' };

function warsawToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw' }).format(new Date());
}

function shiftDays(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
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

const POZYCJE = [
  { description: 'Kara umowna za opóźnienie dostawy', amount: 1250.5 },
  { description: 'Zwrot kosztów transportu', amount: 99.99 },
];

/** Kontrahent w migawce noty — wszystkie pola, bo masowy insert PostgREST wpisuje NULL w brakujące kolumny. */
const MIGAWKA = {
  name: 'Kontrahent Testowy',
  nip: NIP,
  countryCode: 'PL',
  addressLine1: 'ul. Klienta 10',
  addressLine2: '02-001 Warszawa',
  email: 'ksiegowosc@kontrahent.test',
};

/** Szkic z kolumn, które klient może wpisać (granty kolumnowe 00193). */
function szkic(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tenant_id: ORG_A,
    kind: 'debit',
    issue_date: warsawToday(),
    title: 'Kara umowna',
    items: POZYCJE,
    total: noteTotal(POZYCJE),
    currency: 'PLN',
    contractor_id: KONTRAHENT_A,
    counterparty: MIGAWKA,
    related_document: 'FV/2026/11/3',
    due_date: null,
    bank_account: 'PL61109010140000071219812874',
    ...extra,
  };
}

async function zapiszSzkic(c: SupabaseClient, extra: Record<string, unknown> = {}): Promise<string> {
  const { data, error } = await c.from('accounting_notes').insert(szkic(extra)).select('id').single();
  if (error) throw new Error(`insert szkicu: ${error.message}`);
  return (data as { id: string }).id;
}

async function wystaw(c: SupabaseClient, id: string) {
  return c.rpc('issue_accounting_note', { p_note_id: id });
}

async function wiersz(id: string) {
  const { data, error } = await admin.from('accounting_notes').select('*').eq('id', id).single();
  if (error) throw error;
  return data as Record<string, unknown>;
}

async function audyt(id: string, action: string) {
  const { data, error } = await admin
    .from('audit_logs')
    .select('tenant_id, user_id, action, entity_type, entity_id, metadata')
    .eq('entity_id', id)
    .eq('action', action);
  if (error) throw error;
  return data ?? [];
}

async function cleanup() {
  for (const org of [ORG_A, ORG_B]) {
    await admin.from('accounting_note_emails').delete().eq('tenant_id', org);
    await admin.from('accounting_notes').delete().eq('tenant_id', org);
  }
}

describe.skipIf(!hasDatabase)('00193: noty obciążeniowe i uznaniowe na prawdziwym PostgREST', () => {
  beforeAll(async () => {
    for (const who of Object.keys(EMAILS) as Kto[]) users[who] = await userId(EMAILS[who]);
    await cleanup();
    await admin.from('contractors').delete().in('id', [KONTRAHENT_A, KONTRAHENT_B]);
    await admin.from('memberships').delete().in('organization_id', [ORG_A, ORG_B]);
    // Wpisy audytu firmy testowej zostają po przebiegu (00052), więc firmy nie kasujemy, tylko nadpisujemy.
    const tenants = await admin.from('tenants').upsert(
      [
        { id: ORG_A, nip: NIP, name: 'Firma A Noty', address_json: { countryCode: 'PL', addressLine1: 'ul. Przykładowa 1', addressLine2: '00-001 Warszawa' } },
        { id: ORG_B, nip: NIP, name: 'Firma B Noty', address_json: { countryCode: 'PL', addressLine1: 'ul. Inna 2', addressLine2: '00-002 Warszawa' } },
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
      { organization_id: ORG_A, user_id: users.member, role: 'member', status: 'active' },
      { organization_id: ORG_A, user_id: users.accountant, role: 'accountant', status: 'active' },
      { organization_id: ORG_A, user_id: users.zawieszony, role: 'member', status: 'suspended' },
      { organization_id: ORG_B, user_id: users.obcy, role: 'owner', status: 'active' },
    ]);
    if (memberships.error) throw memberships.error;
    for (const k of [
      { id: KONTRAHENT_A, tenant_id: ORG_A, nip: NIP, name: 'Kontrahent Testowy', address: { countryCode: 'PL', addressLine1: 'ul. Klienta 10', addressLine2: '02-001 Warszawa' } },
      { id: KONTRAHENT_B, tenant_id: ORG_B, nip: NIP, name: 'Kontrahent Firmy B', address: { countryCode: 'PL', addressLine1: 'ul. B 1', addressLine2: '00-003 Warszawa' } },
    ]) {
      const { error } = await admin.from('contractors').insert(k);
      if (error) throw error;
    }
  });

  beforeEach(async () => {
    await cleanup();
  });

  afterAll(async () => {
    if (!hasDatabase) return;
    await cleanup();
    await admin.from('contractors').delete().in('id', [KONTRAHENT_A, KONTRAHENT_B]);
    await admin.from('memberships').delete().in('organization_id', [ORG_A, ORG_B]);
  });

  describe('izolacja firm', () => {
    it('obca firma nie widzi not ani historii wysyłek firmy A', async () => {
      const owner = await signedIn('owner');
      const id = await zapiszSzkic(owner);
      const obcy = await signedIn('obcy', ORG_B);
      expect((await obcy.from('accounting_notes').select('id').eq('id', id)).data).toEqual([]);
      expect(await getNote(obcy, ORG_A, id)).toBeNull();
      expect(await listNoteEmails(obcy, ORG_A, id)).toEqual([]);
    });

    it('obca firma nie zapisze noty z tenant_id firmy A (RLS), także z nagłówkiem firmy A', async () => {
      const obcy = await signedIn('obcy', ORG_B);
      expect((await obcy.from('accounting_notes').insert(szkic()).select('id')).error?.message).toMatch(/row-level security/);
      const podszyty = await signedIn('obcy', ORG_A);
      expect((await podszyty.from('accounting_notes').insert(szkic()).select('id')).error?.message).toMatch(/row-level security/);
      expect((await admin.from('accounting_notes').select('id').eq('tenant_id', ORG_A)).data).toEqual([]);
    });

    it('nota firmy A nie wskaże kontrahenta firmy B (klucz złożony z firmą)', async () => {
      const owner = await signedIn('owner');
      const { error } = await owner.from('accounting_notes').insert(szkic({ contractor_id: KONTRAHENT_B })).select('id');
      expect(error?.message).toMatch(/accounting_notes_contractor_same_tenant_fk/);
    });

    it('obca firma nie wystawi, nie zmieni i nie usunie cudzego szkicu', async () => {
      const owner = await signedIn('owner');
      const id = await zapiszSzkic(owner);
      const obcy = await signedIn('obcy', ORG_B);
      expect((await wystaw(obcy, id)).data).toEqual({ status: 'refused', code: 'not_found' });
      expect((await obcy.from('accounting_notes').update({ title: 'Obcy' }).eq('id', id).select('id')).data ?? []).toEqual([]);
      expect((await obcy.from('accounting_notes').delete().eq('id', id).select('id')).data ?? []).toEqual([]);
      expect(await wiersz(id)).toMatchObject({ status: 'draft', title: 'Kara umowna' });
    });
  });

  describe('rola jak przy fakturach', () => {
    it.each(['owner', 'member', 'accountant'] as const)('%s zapisuje szkic i go wystawia', async (who) => {
      const c = await signedIn(who);
      const id = await zapiszSzkic(c);
      const { data, error } = await wystaw(c, id);
      expect(error).toBeNull();
      expect(data).toMatchObject({ status: 'issued' });
      expect(await wiersz(id)).toMatchObject({ status: 'issued', created_by: users[who], issued_by: users[who] });
    });

    it('zawieszony członek nie czyta, nie zapisuje i nie wystawia', async () => {
      const owner = await signedIn('owner');
      const id = await zapiszSzkic(owner);
      const z = await signedIn('zawieszony');
      expect((await z.from('accounting_notes').select('id').eq('id', id)).data).toEqual([]);
      expect((await z.from('accounting_notes').insert(szkic()).select('id')).error?.message).toMatch(/row-level security/);
      const proba = await wystaw(z, id);
      expect(proba.error?.code).toBe('42501');
      expect(await wiersz(id)).toMatchObject({ status: 'draft', number: null });
    });

    it('bez sesji (anon) nie ma dostępu do tabel ani funkcji', async () => {
      const owner = await signedIn('owner');
      const id = await zapiszSzkic(owner);
      const anon = anonClient(ORG_A);
      expect((await anon.from('accounting_notes').select('id')).error).not.toBeNull();
      expect((await wystaw(anon, id)).error).not.toBeNull();
      expect((await anon.rpc('record_accounting_note_email', {
        p_note_id: id, p_recipient: 'a@b.pl', p_idempotency_key: `nota/${id}/x/0`, p_provider_message_id: null,
      })).error).not.toBeNull();
    });
  });

  describe('numer nadaje baza', () => {
    it('format NO/<kolejny>/<rok>, wystawca z danych firmy, audyt wystawienia', async () => {
      const owner = await signedIn('owner');
      const id = await zapiszSzkic(owner);
      const year = Number(warsawToday().slice(0, 4));

      const { data, error } = await wystaw(owner, id);

      expect(error).toBeNull();
      expect(data).toEqual({ status: 'issued', number: formatNoteNumber('debit', 1, year) });
      expect(await wiersz(id)).toMatchObject({
        status: 'issued',
        number: formatNoteNumber('debit', 1, year),
        number_year: year,
        number_seq: 1,
        issuer: { name: 'Firma A Noty', nip: NIP, countryCode: 'PL', addressLine1: 'ul. Przykładowa 1', addressLine2: '00-001 Warszawa' },
      });
      const wpisy = await audyt(id, 'accounting_note.issued');
      expect(wpisy).toEqual([
        expect.objectContaining({ tenant_id: ORG_A, user_id: users.owner, entity_type: 'accounting_note', metadata: expect.objectContaining({ number: formatNoteNumber('debit', 1, year) }) }),
      ]);
    });

    it('pięć wystawień naraz daje numery 1-5 bez dubli i bez luk', async () => {
      const owner = await signedIn('owner');
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) ids.push(await zapiszSzkic(owner));
      const year = Number(warsawToday().slice(0, 4));

      const wyniki = await Promise.all(ids.map((id) => wystaw(owner, id)));

      expect(wyniki.map((w) => w.error)).toEqual([null, null, null, null, null]);
      const numery = wyniki.map((w) => (w.data as { number: string }).number).sort();
      expect(numery).toEqual([1, 2, 3, 4, 5].map((n) => formatNoteNumber('debit', n, year)).sort());
    });

    it('ta sama nota wystawiona dwa razy naraz: jeden numer, drugi wynik „już wystawiona”', async () => {
      const owner = await signedIn('owner');
      const id = await zapiszSzkic(owner);

      const wyniki = await Promise.all([wystaw(owner, id), wystaw(owner, id)]);

      expect(wyniki.map((w) => w.error)).toEqual([null, null]);
      expect(wyniki.map((w) => (w.data as { status: string }).status).sort()).toEqual(['already_issued', 'issued']);
      const numery = new Set(wyniki.map((w) => (w.data as { number: string }).number));
      expect(numery.size).toBe(1);
      expect(await audyt(id, 'accounting_note.issued')).toHaveLength(1);
    });

    it('osobna seria dla noty uznaniowej i dla roku; obca firma ma własną serię', async () => {
      const owner = await signedIn('owner');
      const today = warsawToday();
      const year = Number(today.slice(0, 4));
      const lastYearDate = `${year - 1}-12-31`;
      const debit = await zapiszSzkic(owner);
      const credit = await zapiszSzkic(owner, { kind: 'credit', bank_account: null });
      const lastYear = await zapiszSzkic(owner, { issue_date: lastYearDate });
      const obcy = await signedIn('obcy', ORG_B);
      const obcaNota = await zapiszSzkic(obcy, { tenant_id: ORG_B, contractor_id: KONTRAHENT_B });

      expect((await wystaw(owner, debit)).data).toMatchObject({ number: formatNoteNumber('debit', 1, year) });
      expect((await wystaw(owner, credit)).data).toMatchObject({ number: formatNoteNumber('credit', 1, year) });
      expect((await wystaw(owner, lastYear)).data).toMatchObject({ number: formatNoteNumber('debit', 1, year - 1) });
      expect((await wystaw(obcy, obcaNota)).data).toMatchObject({ number: formatNoteNumber('debit', 1, year) });
    });

    it('klient nie wpisze stanu ani numeru sam (granty kolumnowe), a baza pilnuje zgodności numeru', async () => {
      const owner = await signedIn('owner');
      expect((await owner.from('accounting_notes').insert(szkic({ status: 'issued', number: 'NO/1/2026' })).select('id')).error?.message).toMatch(/permission denied/);
      const id = await zapiszSzkic(owner);
      expect((await owner.from('accounting_notes').update({ number: 'NO/7/2026' }).eq('id', id).select('id')).error?.message).toMatch(/permission denied/);
      // Nawet klucz serwisowy nie zapisze numeru niezgodnego z serią i datą.
      const zly = await admin.from('accounting_notes').update({
        status: 'issued', number: 'NO/1/1999', number_year: 1999, number_seq: 1, issued_at: new Date().toISOString(),
        issuer: { name: 'X', nip: NIP, countryCode: 'PL', addressLine1: 'a', addressLine2: 'b' },
      }).eq('id', id).select('id');
      expect(zly.error?.message).toMatch(/accounting_notes_issued_check/);
    });

    it('odmowy z wyjściem: data z przyszłości, usunięty kontrahent, niepełne dane firmy', async () => {
      const owner = await signedIn('owner');
      const jutro = await zapiszSzkic(owner, { issue_date: shiftDays(warsawToday(), 1), due_date: null });
      expect((await wystaw(owner, jutro)).data).toEqual({ status: 'refused', code: 'future_date' });

      const bezKontrahenta = await zapiszSzkic(owner, { contractor_id: null });
      expect((await wystaw(owner, bezKontrahenta)).data).toEqual({ status: 'refused', code: 'contractor_missing' });

      const bezAdresu = await admin.from('tenants').update({ address_json: null }).eq('id', ORG_A);
      if (bezAdresu.error) throw bezAdresu.error;
      try {
        const id = await zapiszSzkic(owner);
        expect((await wystaw(owner, id)).data).toEqual({ status: 'refused', code: 'issuer_incomplete' });
        expect(await wiersz(id)).toMatchObject({ status: 'draft', number: null });
      } finally {
        await admin.from('tenants').update({ address_json: { countryCode: 'PL', addressLine1: 'ul. Przykładowa 1', addressLine2: '00-001 Warszawa' } }).eq('id', ORG_A);
      }
    });
  });

  describe('wystawionej noty nie zmienia nikt', () => {
    it('klient: zmiana i usunięcie wystawionej nie trafiają w żaden wiersz (RLS: tylko szkic), bez błędu', async () => {
      const owner = await signedIn('owner');
      const id = await zapiszSzkic(owner);
      await wystaw(owner, id);
      // Zero wierszy, nie błąd: akcja rozpoznaje po tym wystawioną notę i podaje jej numer.
      const zmiana = await owner.from('accounting_notes').update({ title: 'Po wystawieniu' }).eq('id', id).select('id');
      expect(zmiana.error).toBeNull();
      expect(zmiana.data).toEqual([]);
      const usuniecie = await owner.from('accounting_notes').delete().eq('id', id).select('id');
      expect(usuniecie.error).toBeNull();
      expect(usuniecie.data).toEqual([]);
      expect(await wiersz(id)).toMatchObject({ status: 'issued', title: 'Kara umowna' });
    });

    it('klucz serwisowy: wyzwalacz odrzuca zmianę treści i powrót do szkicu', async () => {
      const owner = await signedIn('owner');
      const id = await zapiszSzkic(owner);
      await wystaw(owner, id);
      for (const zmiana of [{ title: 'Po wystawieniu' }, { status: 'draft' }, { items: [{ description: 'Inna', amount: 1 }], total: 1 }]) {
        const { error } = await admin.from('accounting_notes').update(zmiana).eq('id', id).select('id');
        expect(error?.message, JSON.stringify(zmiana)).toMatch(/issued and cannot be changed/);
      }
    });

    it('usunięcie kontrahenta z bazy: nota zostaje z migawką, bez wskazania kontrahenta', async () => {
      const owner = await signedIn('owner');
      const tymczasowy = '00193193-1111-4000-8000-0000000000cc';
      const { error: kErr } = await admin.from('contractors').insert({ id: tymczasowy, tenant_id: ORG_A, nip: '1234567891', name: 'Do usunięcia' });
      if (kErr) throw kErr;
      const id = await zapiszSzkic(owner, { contractor_id: tymczasowy });
      await wystaw(owner, id);

      const { error } = await admin.from('contractors').delete().eq('id', tymczasowy);

      expect(error).toBeNull();
      expect(await wiersz(id)).toMatchObject({ status: 'issued', contractor_id: null, counterparty: MIGAWKA });
    });
  });

  describe('treść noty pilnowana w bazie', () => {
    it.each([
      ['waluta inna niż PLN', { currency: 'EUR' }, /accounting_notes_currency_check/],
      ['suma różna od pozycji', { total: 1 }, /accounting_notes_total_check/],
      ['pozycja z kwotą zero', { items: [{ description: 'X', amount: 0 }], total: 0 }, /accounting_notes_items_check/],
      ['pozycja z trzema miejscami po przecinku', { items: [{ description: 'X', amount: 1.005 }], total: 1.005 }, /accounting_notes_(items|total)_check/],
      ['pozycja z kwotą tekstem', { items: [{ description: 'X', amount: '10' }], total: 10 }, /accounting_notes_(items|total)_check/],
      ['bez pozycji', { items: [], total: 0 }, /accounting_notes_items_check/],
      ['nota uznaniowa z terminem zapłaty', { kind: 'credit', bank_account: null, due_date: warsawToday() }, /accounting_notes_payment_check/],
      ['termin przed datą wystawienia', { due_date: '2000-01-01' }, /accounting_notes_due_date_check/],
      ['kontrahent bez nazwy', { counterparty: { ...MIGAWKA, name: ' ' } }, /accounting_notes_counterparty_check/],
      ['pusty tytuł', { title: '  ' }, /accounting_notes_title_check/],
    ])('odmowa: %s', async (_nazwa, zmiana, ograniczenie) => {
      const owner = await signedIn('owner');
      const { error } = await owner.from('accounting_notes').insert(szkic(zmiana)).select('id');
      expect(error?.message).toMatch(ograniczenie);
    });
  });

  describe('historia wysyłek mailem', () => {
    async function wystawiona(): Promise<{ owner: SupabaseClient; id: string }> {
      const owner = await signedIn('owner');
      const id = await zapiszSzkic(owner);
      await wystaw(owner, id);
      return { owner, id };
    }

    it('zapis raz na klucz idempotencji (ponowienie nie dubluje), audyt raz', async () => {
      const { owner, id } = await wystawiona();
      const args = { p_note_id: id, p_recipient: 'Ksiegowosc@Kontrahent.test', p_idempotency_key: `nota/${id}/abc/0`, p_provider_message_id: 'msg-1' };

      const pierwszy = await owner.rpc('record_accounting_note_email', args);
      const drugi = await owner.rpc('record_accounting_note_email', args);

      expect(pierwszy.data).toMatchObject({ status: 'recorded' });
      expect(drugi.data).toEqual({ status: 'already_recorded' });
      expect((await listNoteEmails(owner, ORG_A, id)).map((e) => e.recipient)).toEqual(['ksiegowosc@kontrahent.test']);
      expect(await audyt(id, 'accounting_note.emailed')).toHaveLength(1);
    });

    it('szkic, cudza nota i klucz innej noty: odmowa bez zapisu', async () => {
      const owner = await signedIn('owner');
      const draft = await zapiszSzkic(owner);
      expect((await owner.rpc('record_accounting_note_email', {
        p_note_id: draft, p_recipient: 'a@b.pl', p_idempotency_key: `nota/${draft}/x/0`, p_provider_message_id: null,
      })).data).toEqual({ status: 'refused', code: 'not_issued' });

      const { id } = await wystawiona();
      expect((await owner.rpc('record_accounting_note_email', {
        p_note_id: id, p_recipient: 'a@b.pl', p_idempotency_key: `nota/${draft}/x/0`, p_provider_message_id: null,
      })).data).toEqual({ status: 'refused', code: 'invalid_key' });

      const obcy = await signedIn('obcy', ORG_B);
      expect((await obcy.rpc('record_accounting_note_email', {
        p_note_id: id, p_recipient: 'a@b.pl', p_idempotency_key: `nota/${id}/x/0`, p_provider_message_id: null,
      })).data).toEqual({ status: 'refused', code: 'not_found' });
      expect((await admin.from('accounting_note_emails').select('id').eq('note_id', id)).data).toEqual([]);
    });

    it('klient nie dopisze historii z pominięciem RPC', async () => {
      const { owner, id } = await wystawiona();
      const { error } = await owner.from('accounting_note_emails').insert({
        tenant_id: ORG_A, note_id: id, recipient: 'a@b.pl', idempotency_key: `nota/${id}/x/0`,
      });
      expect(error?.message).toMatch(/permission denied/);
    });
  });
});

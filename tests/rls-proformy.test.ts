import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { getQuote, listQuoteEmails, listQuoteInvoices } from '@/lib/proformy/baza';
import { formatQuoteNumber, quoteItems, quoteTotals } from '@/lib/proformy/model';
import { isSalesQuoteConflict } from '@/lib/proformy/powiazanie';

import { getRlsTestEnvironment } from './helpers/rls-environment';

/**
 * 00198 na prawdziwym Postgresie i PostgREST: proforma i oferta (plan
 * kompletnej aplikacji, krok 2.4).
 *
 * - izolacja firm: obca firma nie widzi dokumentów, nie zapisze dokumentu dla
 *   innej firmy, nie wskaże kontrahenta innej firmy i nie wystawi cudzego;
 * - rola jak przy fakturach: każdy aktywny członek (także księgowy) zapisuje
 *   i wystawia, zawieszony członek nic, bez sesji nic;
 * - numer nadaje tylko baza (RPC), osobna seria na firmę, rodzaj i rok, bez
 *   dubli przy kilku wystawieniach naraz; drugie wystawienie oddaje ten sam numer;
 * - wystawionego dokumentu nie zmienia nikt (RLS i wyzwalacz), także klucz
 *   serwisowy; usunięcie kontrahenta zostawia migawkę danych;
 * - kwoty i pozycje sprawdzane w bazie (sumy, stawki, PLN, ważność oferty);
 * - historia wysyłek mailem: tylko przez RPC, raz na klucz idempotencji;
 * - powiązanie z fakturą: wpisywane w INSERT faktury, tylko z wystawionego
 *   dokumentu tej samej firmy, jedna faktura na numer zamiany (druga tylko
 *   z kolejnym numerem, czyli po potwierdzeniu), klient nie przepina go
 *   UPDATE-em, usunięcie szkicu faktury zwalnia numer;
 * - poza przychodem: wystawienie i wysyłka dokumentu nie tworzą faktur ani wpłat.
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

const ORG_A = '00198198-0000-4000-8000-00000000000a';
const ORG_B = '00198198-0000-4000-8000-00000000000b';
const KONTRAHENT_A = '00198198-1111-4000-8000-00000000000a';
const KONTRAHENT_B = '00198198-1111-4000-8000-00000000000b';
const EMAILS = {
  owner: 'rls-proformy-owner@ksef-saas.test',
  member: 'rls-proformy-member@ksef-saas.test',
  accountant: 'rls-proformy-ksiegowa@ksef-saas.test',
  zawieszony: 'rls-proformy-zawieszony@ksef-saas.test',
  obcy: 'rls-proformy-obcy@ksef-saas.test',
} as const;
type Kto = keyof typeof EMAILS;
const PASS = 'RlsProformy2026Aa!';
const NIP = '1234567890';

const users: Record<Kto, string> = { owner: '', member: '', accountant: '', zawieszony: '', obcy: '' };
let counter = 0;

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

/** Pozycje policzone funkcjami faktury (`calculateLineItem`, `calculateInvoiceTotals`). */
const POZYCJE = quoteItems([
  { name: 'Wdrożenie systemu', unit: 'szt', quantity: 1, unitPriceNet: 1000, vatRate: '23' },
  { name: 'Szkolenie', unit: 'godz.', quantity: 1.5, unitPriceNet: 150.5, vatRate: '8' },
]);
const SUMY = quoteTotals(POZYCJE);

/** Kontrahent w migawce: wszystkie pola, bo masowy insert PostgREST wpisuje NULL w brakujące kolumny. */
const MIGAWKA = {
  name: 'Kontrahent Testowy',
  nip: NIP,
  countryCode: 'PL',
  addressLine1: 'ul. Klienta 10',
  addressLine2: '02-001 Warszawa',
  email: 'zakupy@kontrahent.test',
};

/** Szkic z kolumn, które klient może wpisać (granty kolumnowe 00198); wszystkie podane jawnie. */
function szkic(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tenant_id: ORG_A,
    kind: 'proforma',
    issue_date: warsawToday(),
    valid_until: null,
    items: POZYCJE,
    net_total: SUMY.netTotal,
    vat_total: SUMY.vatTotal,
    gross_total: SUMY.grossTotal,
    currency: 'PLN',
    contractor_id: KONTRAHENT_A,
    counterparty: MIGAWKA,
    payment_method: 'transfer',
    payment_due_date: null,
    bank_account: 'PL61109010140000071219812874',
    notes: null,
    ...extra,
  };
}

const OFERTA = { kind: 'offer', valid_until: null as string | null, payment_method: null, payment_due_date: null, bank_account: null };

async function zapiszSzkic(c: SupabaseClient, extra: Record<string, unknown> = {}): Promise<string> {
  const { data, error } = await c.from('sales_quotes').insert(szkic(extra)).select('id').single();
  if (error) throw new Error(`insert szkicu: ${error.message}`);
  return (data as { id: string }).id;
}

async function wystaw(c: SupabaseClient, id: string) {
  return c.rpc('issue_sales_quote', { p_quote_id: id });
}

async function wystawiony(c: SupabaseClient, extra: Record<string, unknown> = {}): Promise<string> {
  const id = await zapiszSzkic(c, extra);
  const { error } = await wystaw(c, id);
  if (error) throw new Error(`wystawienie: ${error.message}`);
  return id;
}

async function wiersz(id: string) {
  const { data, error } = await admin.from('sales_quotes').select('*').eq('id', id).single();
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

/** Szkic faktury kluczem użytkownika (jak `insertInvoiceAndLines`), z powiązaniem albo bez. */
function fakturaRow(org: string, extra: Record<string, unknown> = {}) {
  counter += 1;
  const number = `FV/P/${counter}`;
  return {
    tenant_id: org, direction: 'outgoing', ksef_status: 'draft', internal_number: number, invoice_type: 'VAT',
    invoice_kind: 'regular', issue_date: warsawToday(), seller_nip: NIP, buyer_nip: NIP,
    gross_total: SUMY.grossTotal, net_total: SUMY.netTotal, vat_total: SUMY.vatTotal, currency: 'PLN',
    fa3_data: { internalNumber: number, type: 'VAT' }, seller_data: { nip: NIP }, buyer_data: { nip: NIP, name: 'Kontrahent Testowy' },
    ...extra,
  };
}

async function cleanup() {
  for (const org of [ORG_A, ORG_B]) {
    await admin.from('invoices').delete().eq('tenant_id', org);
    await admin.from('sales_quote_emails').delete().eq('tenant_id', org);
    await admin.from('sales_quotes').delete().eq('tenant_id', org);
  }
}

describe.skipIf(!hasDatabase)('00198: proforma i oferta na prawdziwym PostgREST', () => {
  beforeAll(async () => {
    for (const who of Object.keys(EMAILS) as Kto[]) users[who] = await userId(EMAILS[who]);
    await cleanup();
    await admin.from('contractors').delete().in('id', [KONTRAHENT_A, KONTRAHENT_B]);
    await admin.from('memberships').delete().in('organization_id', [ORG_A, ORG_B]);
    // Wpisy audytu firmy testowej zostają po przebiegu (00052), więc firmy nie kasujemy, tylko nadpisujemy.
    const tenants = await admin.from('tenants').upsert(
      [
        { id: ORG_A, nip: NIP, name: 'Firma A Proformy', address_json: { countryCode: 'PL', addressLine1: 'ul. Przykładowa 1', addressLine2: '00-001 Warszawa' } },
        { id: ORG_B, nip: NIP, name: 'Firma B Proformy', address_json: { countryCode: 'PL', addressLine1: 'ul. Inna 2', addressLine2: '00-002 Warszawa' } },
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
    it('obca firma nie widzi dokumentów ani historii wysyłek firmy A', async () => {
      const owner = await signedIn('owner');
      const id = await zapiszSzkic(owner);
      const obcy = await signedIn('obcy', ORG_B);
      expect((await obcy.from('sales_quotes').select('id').eq('id', id)).data).toEqual([]);
      expect(await getQuote(obcy, ORG_A, id)).toBeNull();
      expect(await listQuoteEmails(obcy, ORG_A, id)).toEqual([]);
    });

    it('obca firma nie zapisze dokumentu z tenant_id firmy A (RLS), także z nagłówkiem firmy A', async () => {
      const obcy = await signedIn('obcy', ORG_B);
      expect((await obcy.from('sales_quotes').insert(szkic()).select('id')).error?.message).toMatch(/row-level security/);
      const podszyty = await signedIn('obcy', ORG_A);
      expect((await podszyty.from('sales_quotes').insert(szkic()).select('id')).error?.message).toMatch(/row-level security/);
      expect((await admin.from('sales_quotes').select('id').eq('tenant_id', ORG_A)).data).toEqual([]);
    });

    it('dokument firmy A nie wskaże kontrahenta firmy B (klucz złożony z firmą)', async () => {
      const owner = await signedIn('owner');
      const { error } = await owner.from('sales_quotes').insert(szkic({ contractor_id: KONTRAHENT_B })).select('id');
      expect(error?.message).toMatch(/sales_quotes_contractor_same_tenant_fk/);
    });

    it('obca firma nie wystawi, nie zmieni i nie usunie cudzego szkicu', async () => {
      const owner = await signedIn('owner');
      const id = await zapiszSzkic(owner);
      const obcy = await signedIn('obcy', ORG_B);
      expect((await wystaw(obcy, id)).data).toEqual({ status: 'refused', code: 'not_found' });
      expect((await obcy.from('sales_quotes').update({ notes: 'Obcy' }).eq('id', id).select('id')).data ?? []).toEqual([]);
      expect((await obcy.from('sales_quotes').delete().eq('id', id).select('id')).data ?? []).toEqual([]);
      expect(await wiersz(id)).toMatchObject({ status: 'draft', notes: null });
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
      expect((await z.from('sales_quotes').select('id').eq('id', id)).data).toEqual([]);
      expect((await z.from('sales_quotes').insert(szkic()).select('id')).error?.message).toMatch(/row-level security/);
      const proba = await wystaw(z, id);
      expect(proba.error?.code).toBe('42501');
      expect(await wiersz(id)).toMatchObject({ status: 'draft', number: null });
    });

    it('bez sesji (anon) nie ma dostępu do tabel ani funkcji', async () => {
      const owner = await signedIn('owner');
      const id = await zapiszSzkic(owner);
      const anon = anonClient(ORG_A);
      expect((await anon.from('sales_quotes').select('id')).error).not.toBeNull();
      expect((await wystaw(anon, id)).error).not.toBeNull();
      expect((await anon.rpc('record_sales_quote_email', {
        p_quote_id: id, p_recipient: 'a@b.pl', p_idempotency_key: `sales-quote/${id}/x/0`, p_provider_message_id: null,
      })).error).not.toBeNull();
    });
  });

  describe('numer nadaje baza', () => {
    it('format PRO/<kolejny>/<rok>, wystawca z danych firmy, audyt wystawienia', async () => {
      const owner = await signedIn('owner');
      const id = await zapiszSzkic(owner);
      const year = Number(warsawToday().slice(0, 4));

      const { data, error } = await wystaw(owner, id);

      expect(error).toBeNull();
      expect(data).toEqual({ status: 'issued', number: formatQuoteNumber('proforma', 1, year) });
      expect(await wiersz(id)).toMatchObject({
        status: 'issued',
        number: formatQuoteNumber('proforma', 1, year),
        number_year: year,
        number_seq: 1,
        issuer: { name: 'Firma A Proformy', nip: NIP, countryCode: 'PL', addressLine1: 'ul. Przykładowa 1', addressLine2: '00-001 Warszawa' },
      });
      expect(await audyt(id, 'sales_quote.issued')).toEqual([
        expect.objectContaining({ tenant_id: ORG_A, user_id: users.owner, entity_type: 'sales_quote', metadata: expect.objectContaining({ number: formatQuoteNumber('proforma', 1, year) }) }),
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
      expect(numery).toEqual([1, 2, 3, 4, 5].map((n) => formatQuoteNumber('proforma', n, year)).sort());
    });

    it('ten sam dokument wystawiony dwa razy naraz: jeden numer, drugi wynik „już wystawiony”', async () => {
      const owner = await signedIn('owner');
      const id = await zapiszSzkic(owner);

      const wyniki = await Promise.all([wystaw(owner, id), wystaw(owner, id)]);

      expect(wyniki.map((w) => w.error)).toEqual([null, null]);
      expect(wyniki.map((w) => (w.data as { status: string }).status).sort()).toEqual(['already_issued', 'issued']);
      expect(new Set(wyniki.map((w) => (w.data as { number: string }).number)).size).toBe(1);
      expect(await audyt(id, 'sales_quote.issued')).toHaveLength(1);
    });

    it('osobna seria dla oferty i dla roku; obca firma ma własną serię', async () => {
      const owner = await signedIn('owner');
      const today = warsawToday();
      const year = Number(today.slice(0, 4));
      const proforma = await zapiszSzkic(owner);
      const oferta = await zapiszSzkic(owner, { ...OFERTA, valid_until: shiftDays(today, 14) });
      const zeszlyRok = await zapiszSzkic(owner, { issue_date: `${year - 1}-12-31` });
      const obcy = await signedIn('obcy', ORG_B);
      const obcyDokument = await zapiszSzkic(obcy, { tenant_id: ORG_B, contractor_id: KONTRAHENT_B });

      expect((await wystaw(owner, proforma)).data).toMatchObject({ number: formatQuoteNumber('proforma', 1, year) });
      expect((await wystaw(owner, oferta)).data).toMatchObject({ number: formatQuoteNumber('offer', 1, year) });
      expect((await wystaw(owner, zeszlyRok)).data).toMatchObject({ number: formatQuoteNumber('proforma', 1, year - 1) });
      expect((await wystaw(obcy, obcyDokument)).data).toMatchObject({ number: formatQuoteNumber('proforma', 1, year) });
    });

    it('klient nie wpisze stanu ani numeru sam (granty kolumnowe), a baza pilnuje zgodności numeru', async () => {
      const owner = await signedIn('owner');
      expect((await owner.from('sales_quotes').insert(szkic({ status: 'issued', number: 'PRO/1/2026' })).select('id')).error?.message).toMatch(/permission denied/);
      const id = await zapiszSzkic(owner);
      expect((await owner.from('sales_quotes').update({ number: 'PRO/7/2026' }).eq('id', id).select('id')).error?.message).toMatch(/permission denied/);
      const zly = await admin.from('sales_quotes').update({
        status: 'issued', number: 'OF/1/1999', number_year: 1999, number_seq: 1, issued_at: new Date().toISOString(),
        issuer: { name: 'X', nip: NIP, countryCode: 'PL', addressLine1: 'a', addressLine2: 'b' },
      }).eq('id', id).select('id');
      expect(zly.error?.message).toMatch(/sales_quotes_issued_check/);
    });

    it('odmowy z wyjściem: data z przyszłości, oferta po terminie ważności, usunięty kontrahent, niepełne dane firmy', async () => {
      const owner = await signedIn('owner');
      const today = warsawToday();
      const jutro = await zapiszSzkic(owner, { issue_date: shiftDays(today, 1) });
      expect((await wystaw(owner, jutro)).data).toEqual({ status: 'refused', code: 'future_date' });

      const poTerminie = await zapiszSzkic(owner, { ...OFERTA, issue_date: shiftDays(today, -10), valid_until: shiftDays(today, -1) });
      expect((await wystaw(owner, poTerminie)).data).toEqual({ status: 'refused', code: 'valid_until_past' });

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

  describe('wystawionego dokumentu nie zmienia nikt', () => {
    it('klient: zmiana i usunięcie wystawionego nie trafiają w żaden wiersz (RLS: tylko szkic), bez błędu', async () => {
      const owner = await signedIn('owner');
      const id = await wystawiony(owner);
      const zmiana = await owner.from('sales_quotes').update({ notes: 'Po wystawieniu' }).eq('id', id).select('id');
      expect(zmiana.error).toBeNull();
      expect(zmiana.data).toEqual([]);
      const usuniecie = await owner.from('sales_quotes').delete().eq('id', id).select('id');
      expect(usuniecie.error).toBeNull();
      expect(usuniecie.data).toEqual([]);
      expect(await wiersz(id)).toMatchObject({ status: 'issued', notes: null });
    });

    it('klucz serwisowy: wyzwalacz odrzuca zmianę treści, kwot i powrót do szkicu', async () => {
      const owner = await signedIn('owner');
      const id = await wystawiony(owner);
      for (const zmiana of [{ notes: 'Po wystawieniu' }, { status: 'draft' }, { gross_total: 1, net_total: 1, vat_total: 0 }]) {
        const { error } = await admin.from('sales_quotes').update(zmiana).eq('id', id).select('id');
        expect(error?.message, JSON.stringify(zmiana)).toMatch(/issued and cannot be changed/);
      }
    });

    it('usunięcie kontrahenta z bazy: dokument zostaje z migawką, bez wskazania kontrahenta', async () => {
      const owner = await signedIn('owner');
      const tymczasowy = '00198198-1111-4000-8000-0000000000cc';
      const { error: kErr } = await admin.from('contractors').insert({ id: tymczasowy, tenant_id: ORG_A, nip: '1234567891', name: 'Do usunięcia' });
      if (kErr) throw kErr;
      const id = await wystawiony(owner, { contractor_id: tymczasowy });

      const { error } = await admin.from('contractors').delete().eq('id', tymczasowy);

      expect(error).toBeNull();
      expect(await wiersz(id)).toMatchObject({ status: 'issued', contractor_id: null, counterparty: MIGAWKA });
    });
  });

  describe('treść dokumentu pilnowana w bazie', () => {
    // Zmieniamy jedną pozycję i zostawiamy drugą, żeby sumy dokumentu dalej się zgadzały
    // i odezwał się CHECK pozycji. Gdy zmiana psuje też sumę, Postgres może zgłosić
    // najpierw CHECK sumy (sprawdza je w kolejności nazw), stąd dwie nazwy w części przypadków.
    const [p1, p2] = POZYCJE;
    it.each([
      ['waluta inna niż PLN', { currency: 'EUR' }, /sales_quotes_currency_check/],
      ['suma netto różna od pozycji', { net_total: 1 }, /sales_quotes_(net_total|gross_total)_check/],
      ['suma brutto różna od netto + VAT', { gross_total: SUMY.grossTotal + 1 }, /sales_quotes_gross_total_check/],
      ['bez pozycji', { items: [], net_total: 0, vat_total: 0, gross_total: 0 }, /sales_quotes_items_check/],
      ['stawka np. II', { items: [{ ...p1, vatRate: 'np_ii' }, p2] }, /sales_quotes_items_check/],
      ['brutto pozycji różne od netto + VAT', { items: [{ ...p1, grossAmount: 1 }, p2] }, /sales_quotes_(items|gross_total)_check/],
      ['ilość z pięcioma miejscami po przecinku', { items: [{ ...p1, quantity: 1.00001 }, p2] }, /sales_quotes_items_check/],
      ['kwota tekstem', { items: [{ ...p1, netAmount: '1000' }, p2] }, /sales_quotes_(items|net_total)_check/],
      ['oferta bez daty ważności', { ...OFERTA }, /sales_quotes_kind_fields_check/],
      ['proforma z datą ważności', { valid_until: warsawToday() }, /sales_quotes_kind_fields_check/],
      ['oferta ze sposobem zapłaty', { ...OFERTA, valid_until: warsawToday(), payment_method: 'transfer' }, /sales_quotes_kind_fields_check/],
      ['proforma przelewem bez rachunku', { bank_account: null }, /sales_quotes_transfer_account_check/],
      ['termin zapłaty przed datą wystawienia', { payment_due_date: '2000-01-01' }, /sales_quotes_payment_due_date_check/],
      ['kontrahent bez nazwy', { counterparty: { ...MIGAWKA, name: ' ' } }, /sales_quotes_counterparty_check/],
    ])('odmowa: %s', async (_nazwa, zmiana, ograniczenie) => {
      const owner = await signedIn('owner');
      const { error } = await owner.from('sales_quotes').insert(szkic(zmiana)).select('id');
      expect(error?.message).toMatch(ograniczenie);
    });
  });

  describe('historia wysyłek mailem', () => {
    it('zapis raz na klucz idempotencji (ponowienie nie dubluje), audyt raz', async () => {
      const owner = await signedIn('owner');
      const id = await wystawiony(owner);
      const args = { p_quote_id: id, p_recipient: 'Zakupy@Kontrahent.test', p_idempotency_key: `sales-quote/${id}/abc/0`, p_provider_message_id: 'msg-1' };

      const pierwszy = await owner.rpc('record_sales_quote_email', args);
      const drugi = await owner.rpc('record_sales_quote_email', args);

      expect(pierwszy.data).toMatchObject({ status: 'recorded' });
      expect(drugi.data).toEqual({ status: 'already_recorded' });
      expect((await listQuoteEmails(owner, ORG_A, id)).map((e) => e.recipient)).toEqual(['zakupy@kontrahent.test']);
      expect(await audyt(id, 'sales_quote.emailed')).toHaveLength(1);
    });

    it('szkic, cudzy dokument i klucz innego dokumentu: odmowa bez zapisu', async () => {
      const owner = await signedIn('owner');
      const draft = await zapiszSzkic(owner);
      expect((await owner.rpc('record_sales_quote_email', {
        p_quote_id: draft, p_recipient: 'a@b.pl', p_idempotency_key: `sales-quote/${draft}/x/0`, p_provider_message_id: null,
      })).data).toEqual({ status: 'refused', code: 'not_issued' });

      const id = await wystawiony(owner);
      expect((await owner.rpc('record_sales_quote_email', {
        p_quote_id: id, p_recipient: 'a@b.pl', p_idempotency_key: `sales-quote/${draft}/x/0`, p_provider_message_id: null,
      })).data).toEqual({ status: 'refused', code: 'invalid_key' });

      const obcy = await signedIn('obcy', ORG_B);
      expect((await obcy.rpc('record_sales_quote_email', {
        p_quote_id: id, p_recipient: 'a@b.pl', p_idempotency_key: `sales-quote/${id}/x/0`, p_provider_message_id: null,
      })).data).toEqual({ status: 'refused', code: 'not_found' });
      expect((await admin.from('sales_quote_emails').select('id').eq('quote_id', id)).data).toEqual([]);
    });

    it('klient nie dopisze historii z pominięciem RPC', async () => {
      const owner = await signedIn('owner');
      const id = await wystawiony(owner);
      const { error } = await owner.from('sales_quote_emails').insert({
        tenant_id: ORG_A, quote_id: id, recipient: 'a@b.pl', idempotency_key: `sales-quote/${id}/x/0`,
      });
      expect(error?.message).toMatch(/permission denied/);
    });
  });

  describe('powiązanie z fakturą', () => {
    it('szkic faktury z dokumentem (numer zamiany 1) kluczem użytkownika; druga z tym samym numerem: 23505 na indeksie zamiany', async () => {
      const owner = await signedIn('owner');
      const id = await wystawiony(owner);

      const pierwsza = await owner.from('invoices').insert(fakturaRow(ORG_A, { sales_quote_id: id, sales_quote_seq: 1 })).select('id').single();
      expect(pierwsza.error).toBeNull();

      const druga = await owner.from('invoices').insert(fakturaRow(ORG_A, { sales_quote_id: id, sales_quote_seq: 1 })).select('id').single();
      expect(druga.error?.code).toBe('23505');
      expect(isSalesQuoteConflict(druga.error)).toBe(true);

      const kolejna = await owner.from('invoices').insert(fakturaRow(ORG_A, { sales_quote_id: id, sales_quote_seq: 2, invoice_kind: 'advance', invoice_type: 'ZAL', advance_amount: 100 })).select('id').single();
      expect(kolejna.error).toBeNull();
      expect((await listQuoteInvoices(owner, ORG_A, id)).map((f) => [f.seq, f.invoiceKind])).toEqual([[1, 'regular'], [2, 'advance']]);
    });

    it('faktura ze szkicu dokumentu (bez numeru): odmowa wyzwalacza', async () => {
      const owner = await signedIn('owner');
      const draft = await zapiszSzkic(owner);
      const { error } = await owner.from('invoices').insert(fakturaRow(ORG_A, { sales_quote_id: draft, sales_quote_seq: 1 })).select('id');
      expect(error?.code).toBe('42501');
      expect(error?.message).toMatch(/not issued/);
    });

    it('faktura końcowa z dokumentu: odmowa (tylko zwykła albo zaliczkowa)', async () => {
      const owner = await signedIn('owner');
      const id = await wystawiony(owner);
      const { error } = await owner.from('invoices').insert(fakturaRow(ORG_A, {
        sales_quote_id: id, sales_quote_seq: 1, invoice_kind: 'final', invoice_type: 'ROZ', advance_invoice_ids: ['00198198-2222-4000-8000-000000000001'],
      })).select('id');
      expect(error?.message).toMatch(/regular or advance/);
    });

    it('faktura firmy B nie wskaże dokumentu firmy A (klucz złożony z firmą)', async () => {
      const owner = await signedIn('owner');
      const id = await wystawiony(owner);
      const obcy = await signedIn('obcy', ORG_B);
      const { error } = await obcy.from('invoices').insert(fakturaRow(ORG_B, { sales_quote_id: id, sales_quote_seq: 1 })).select('id');
      expect(error?.message).toMatch(/invoices_sales_quote_same_tenant_fk/);
      expect(await listQuoteInvoices(obcy, ORG_B, id)).toEqual([]);
    });

    it('klient nie przepina powiązania UPDATE-em; usunięcie szkicu faktury zwalnia numer zamiany', async () => {
      const owner = await signedIn('owner');
      const id = await wystawiony(owner);
      const inny = await wystawiony(owner);
      const { data: f } = await owner.from('invoices').insert(fakturaRow(ORG_A, { sales_quote_id: id, sales_quote_seq: 1 })).select('id').single();
      const fakturaId = (f as { id: string }).id;

      for (const zmiana of [{ sales_quote_id: inny }, { sales_quote_seq: 5 }, { sales_quote_id: null }]) {
        const { error } = await owner.from('invoices').update(zmiana).eq('id', fakturaId).select('id');
        expect(error?.code, JSON.stringify(zmiana)).toBe('42501');
      }

      await owner.from('invoices').delete().eq('id', fakturaId);
      const ponownie = await owner.from('invoices').insert(fakturaRow(ORG_A, { sales_quote_id: id, sales_quote_seq: 1 })).select('id');
      expect(ponownie.error).toBeNull();
    });

    it('usunięcie wystawionego dokumentu kluczem serwisowym zeruje samo powiązanie, faktura zostaje', async () => {
      const owner = await signedIn('owner');
      const id = await wystawiony(owner);
      const { data: f } = await owner.from('invoices').insert(fakturaRow(ORG_A, { sales_quote_id: id, sales_quote_seq: 1 })).select('id').single();
      const fakturaId = (f as { id: string }).id;

      const { error } = await admin.from('sales_quotes').delete().eq('id', id);

      expect(error).toBeNull();
      const { data } = await admin.from('invoices').select('id, sales_quote_id, sales_quote_seq').eq('id', fakturaId).single();
      expect(data).toEqual({ id: fakturaId, sales_quote_id: null, sales_quote_seq: 1 });
    });
  });

  describe('poza przychodem', () => {
    it('wystawienie i wysyłka dokumentu nie tworzą faktur ani wpłat', async () => {
      const owner = await signedIn('owner');
      const id = await wystawiony(owner);
      await owner.rpc('record_sales_quote_email', {
        p_quote_id: id, p_recipient: 'zakupy@kontrahent.test', p_idempotency_key: `sales-quote/${id}/abc/0`, p_provider_message_id: null,
      });
      expect((await admin.from('invoices').select('id').eq('tenant_id', ORG_A)).data).toEqual([]);
      expect((await admin.from('payments').select('id').eq('tenant_id', ORG_A)).data).toEqual([]);
    });
  });
});

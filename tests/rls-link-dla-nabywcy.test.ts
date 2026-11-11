import { createHash, randomBytes } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { getRlsTestEnvironment } from './helpers/rls-environment';

/**
 * 00179 na prawdziwym Postgresie i PostgREST: link do faktury dla nabywcy
 * (plan kompletnej aplikacji, krok 2.10).
 *
 * - Tabela `invoice_share_links`: firma widzi swoje linki, tworzy je i cofa
 *   właściciel, administrator i członek zespołu (księgowa nie), tylko dla
 *   zaakceptowanej w KSeF faktury sprzedaży z FaktWay (VAT albo zaliczkowa)
 *   z zapisanym plikiem XML. Skrót tokenu nie wychodzi z bazy do klienta,
 *   termin i licznik ustawia baza, cofnięcie jest jednokierunkowe, na fakturę
 *   najwyżej jeden link niecofnięty.
 * - Funkcja `invoice_share_link_view` (SECURITY DEFINER, tylko klucz
 *   serwisowy): po skrócie tokenu zwraca dane tej jednej faktury, gdy link żyje
 *   i faktura spełnia warunki; inaczej NULL (ważny, wygasły, cofnięty, cudzy
 *   token, faktura nieprzyjęta).
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

const ORG_A = '00179179-0000-4000-8000-00000000000a';
const ORG_B = '00179179-0000-4000-8000-00000000000b';
const EMAILS = {
  owner: 'rls-link-nabywcy-owner@ksef-saas.test',
  member: 'rls-link-nabywcy-member@ksef-saas.test',
  accountant: 'rls-link-nabywcy-ksiegowa@ksef-saas.test',
  obcy: 'rls-link-nabywcy-obcy@ksef-saas.test',
} as const;
const PASS = 'RlsLinkNabywcy2026Aa!';
const NIP = '1234567890';
const HASH_XML = 'ab'.repeat(32);
const DAY_MS = 24 * 60 * 60 * 1000;

const users: Record<keyof typeof EMAILS, string> = { owner: '', member: '', accountant: '', obcy: '' };
let counter = 0;

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
  const client = anonClient(activeOrg);
  const { error } = await client.auth.signInWithPassword({ email: EMAILS[who], password: PASS });
  if (error) throw error;
  return client;
}

function newToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: createHash('sha256').update(token).digest('hex') };
}

/** Faktura sprzedaży z FaktWay przyjęta w KSeF, z plikiem XML i jedną pozycją (zmiany w `fields`). */
async function faktura(fields: Record<string, unknown> = {}, org: string = ORG_A, { xml = true } = {}): Promise<{ id: string; number: string }> {
  counter += 1;
  const id = `00179179-1111-4000-8000-${String(counter).padStart(12, '0')}`;
  const number = `FV/179/${counter}`;
  const path = `${org}/2026/10/${id}.xml`;
  const { error } = await admin.from('invoices').insert({
    id,
    tenant_id: org,
    direction: 'outgoing',
    origin: 'app',
    internal_number: number,
    invoice_type: 'VAT',
    invoice_kind: 'regular',
    issue_date: '2026-10-01',
    sale_date: '2026-09-30',
    currency: 'PLN',
    seller_nip: NIP,
    buyer_nip: null,
    gross_total: 1230,
    net_total: 1000,
    vat_total: 230,
    notes: 'Uwagi na fakturze',
    fa3_data: { internalNumber: number, type: 'VAT', annotations: { splitPayment: 2 } },
    seller_data: { nip: NIP, name: `Sprzedawca ${org.slice(-1)}`, address: { countryCode: 'PL', addressLine1: 'ul. Prosta 1', addressLine2: '00-001 Warszawa' }, email: 'sprzedawca@example.test' },
    buyer_data: { nip: null, name: 'Jan Nabywca', address: { countryCode: 'PL', addressLine1: 'ul. Krzywa 2', addressLine2: '00-002 Kraków' }, email: 'nabywca@example.test', phone: '+48500100200' },
    payment_data: { method: 'transfer', dueDate: '2026-10-15', bankAccount: 'PL61109010140000071219812874', bankName: 'Bank Testowy', amountDue: 1230 },
    ksef_status: 'accepted',
    ksef_environment: 'test',
    ksef_number: `${NIP}-20261001-${String(counter).padStart(12, '0')}-00`,
    xml_storage_path: path,
    ...fields,
  });
  if (error) throw new Error(`insert ${number}: ${error.message}`);
  if (xml) {
    const doc = await admin.from('xml_documents').insert({ tenant_id: org, invoice_id: id, storage_path: path, sha256_hash: HASH_XML });
    if (doc.error) throw new Error(`xml ${number}: ${doc.error.message}`);
  }
  const line = await admin.from('invoice_line_items').insert({
    invoice_id: id, ordinal: 1, name: 'Usługa testowa', unit: 'szt.', quantity: 2,
    unit_price_net: 500, vat_rate: '23', net_amount: 1000, vat_amount: 230, gross_amount: 1230,
  });
  if (line.error) throw new Error(`pozycja ${number}: ${line.error.message}`);
  return { id, number };
}

/** Link wstawiony kluczem serwisowym (z pominięciem polityk), np. wygasły. */
async function linkSerwisowy(invoiceId: string, org: string = ORG_A, fields: Record<string, unknown> = {}) {
  const { token, hash } = newToken();
  const { data, error } = await admin.from('invoice_share_links')
    .insert({ tenant_id: org, invoice_id: invoiceId, token_hash: hash, ...fields })
    .select('id')
    .single();
  if (error) throw new Error(`link: ${error.message}`);
  return { id: (data as { id: string }).id, token, hash };
}

async function widok(hash: string, countOpen = false): Promise<Record<string, unknown> | null> {
  const { data, error } = await admin.rpc('invoice_share_link_view', { p_token_hash: hash, p_count_open: countOpen });
  if (error) throw new Error(`invoice_share_link_view: ${error.message}`);
  return (data ?? null) as Record<string, unknown> | null;
}

/** Korekta wymaga przyjętej faktury pierwotnej tej firmy (wyzwalacz z 00118). */
async function korekta(): Promise<Record<string, unknown>> {
  const parent = await faktura();
  return {
    invoice_type: 'KOR', invoice_kind: 'correction', parent_invoice_id: parent.id,
    correction_reason: 'test', correction_type: 'before_after',
  };
}

type Fixture = () => Promise<Record<string, unknown>>;
const fixed = (fields: Record<string, unknown>): Fixture => async () => fields;

async function cleanup() {
  for (const org of [ORG_A, ORG_B]) {
    await admin.from('invoice_share_links').delete().eq('tenant_id', org);
    await admin.from('invoices').delete().eq('tenant_id', org).eq('invoice_kind', 'correction');
    await admin.from('invoices').delete().eq('tenant_id', org);
  }
}

describe.skipIf(!hasDatabase)('00179: link do faktury dla nabywcy na prawdziwym PostgREST', () => {
  beforeAll(async () => {
    for (const who of Object.keys(EMAILS) as Array<keyof typeof EMAILS>) users[who] = await userId(EMAILS[who]);
    await cleanup();
    await admin.from('memberships').delete().in('organization_id', [ORG_A, ORG_B]);
    const tenants = await admin.from('tenants').upsert([
      { id: ORG_A, nip: NIP, name: 'Firma A Link 00179' },
      { id: ORG_B, nip: NIP, name: 'Firma B Link 00179' },
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
  });

  beforeEach(async () => {
    await cleanup();
  });

  afterAll(async () => {
    if (!hasDatabase) return;
    await cleanup();
    await admin.from('memberships').delete().in('organization_id', [ORG_A, ORG_B]);
    await admin.from('tenants').delete().in('id', [ORG_A, ORG_B]);
  });

  describe('tabela: kto tworzy, czyta i cofa', () => {
    it('właściciel tworzy link; termin 90 dni i licznik ustawia baza; skrót nie wraca do klienta', async () => {
      const { id } = await faktura();
      const owner = await signedIn('owner');
      const { hash } = newToken();
      const created = await owner.from('invoice_share_links')
        .insert({ tenant_id: ORG_A, invoice_id: id, token_hash: hash })
        .select('id, created_at, expires_at, revoked_at, open_count, created_by')
        .single();
      expect(created.error).toBeNull();
      const row = created.data as { created_at: string; expires_at: string; revoked_at: string | null; open_count: number; created_by: string };
      // 90 dni kalendarzowych w strefie sesji bazy (UTC; w strefie z czasem letnim doba bywa o godzinę krótsza).
      const ttl = new Date(row.expires_at).getTime() - new Date(row.created_at).getTime();
      expect(ttl).toBeGreaterThan(90 * DAY_MS - 3_600_001);
      expect(ttl).toBeLessThanOrEqual(90 * DAY_MS + 3_600_000);
      expect(row).toMatchObject({ revoked_at: null, open_count: 0, created_by: users.owner });

      const secret = await owner.from('invoice_share_links').select('token_hash').limit(1);
      expect(secret.error?.code).toBe('42501');
    });

    it('członek zespołu tworzy link; księgowa nie', async () => {
      const { id } = await faktura();
      const member = await signedIn('member');
      expect((await member.from('invoice_share_links').insert({ tenant_id: ORG_A, invoice_id: id, token_hash: newToken().hash })).error).toBeNull();

      const other = await faktura();
      const accountant = await signedIn('accountant');
      const refused = await accountant.from('invoice_share_links').insert({ tenant_id: ORG_A, invoice_id: other.id, token_hash: newToken().hash });
      expect(refused.error?.message).toMatch(/row-level security/);
    });

    it('klient nie podstawi terminu, licznika ani autora', async () => {
      const { id } = await faktura();
      const owner = await signedIn('owner');
      const base = { tenant_id: ORG_A, invoice_id: id };
      for (const extra of [
        { expires_at: new Date(Date.now() + 365 * DAY_MS).toISOString() },
        { open_count: 5 },
        { created_by: users.member },
        { revoked_at: null, revoked_by: users.member },
      ]) {
        const res = await owner.from('invoice_share_links').insert({ ...base, token_hash: newToken().hash, ...extra });
        expect(res.error?.code, JSON.stringify(extra)).toBe('42501');
      }
    });

    it('zaliczkowa przyjęta w KSeF: link powstaje', async () => {
      const { id } = await faktura({ invoice_type: 'ZAL', invoice_kind: 'advance', advance_amount: 1230 });
      const owner = await signedIn('owner');
      expect((await owner.from('invoice_share_links').insert({ tenant_id: ORG_A, invoice_id: id, token_hash: newToken().hash })).error).toBeNull();
    });

    it.each<[string, Fixture, boolean]>([
      ['szkic', fixed({ ksef_status: 'draft', ksef_number: null, ksef_environment: null, xml_storage_path: null }), true],
      ['faktura zakupu', fixed({ direction: 'incoming' }), true],
      ['import z KSeF', fixed({ origin: 'ksef_import' }), true],
      ['korekta', korekta, true],
      ['bez numeru KSeF', fixed({ ksef_number: null }), true],
      ['bez wiersza pliku XML', fixed({}), false],
    ])('nie powstanie link dla: %s', async (_name, fields, xml) => {
      const { id } = await faktura(await fields(), ORG_A, { xml });
      const owner = await signedIn('owner');
      const res = await owner.from('invoice_share_links').insert({ tenant_id: ORG_A, invoice_id: id, token_hash: newToken().hash });
      expect(res.error?.message).toMatch(/row-level security/);
    });

    it('inna firma nie utworzy linku do cudzej faktury i nie widzi linków firmy A', async () => {
      const { id } = await faktura();
      await linkSerwisowy(id);
      const obcy = await signedIn('obcy', ORG_B);
      expect((await obcy.from('invoice_share_links').insert({ tenant_id: ORG_A, invoice_id: id, token_hash: newToken().hash })).error?.message)
        .toMatch(/row-level security/);
      expect((await obcy.from('invoice_share_links').insert({ tenant_id: ORG_B, invoice_id: id, token_hash: newToken().hash })).error)
        .not.toBeNull();
      const seen = await obcy.from('invoice_share_links').select('id').eq('tenant_id', ORG_A);
      expect(seen.data ?? []).toEqual([]);
    });

    it('link nie wskaże faktury innej firmy nawet kluczem serwisowym (klucz złożony)', async () => {
      const cudza = await faktura({}, ORG_B);
      const res = await admin.from('invoice_share_links').insert({ tenant_id: ORG_A, invoice_id: cudza.id, token_hash: newToken().hash });
      expect(res.error?.code).toBe('23503');
    });

    it('niezalogowany nie czyta tabeli', async () => {
      const { id } = await faktura();
      await linkSerwisowy(id);
      const anon = anonClient(ORG_A);
      const read = await anon.from('invoice_share_links').select('id');
      expect(read.error?.code).toBe('42501');
    });

    it('na fakturę najwyżej jeden link niecofnięty; po cofnięciu można utworzyć nowy', async () => {
      const { id } = await faktura();
      const owner = await signedIn('owner');
      const first = await owner.from('invoice_share_links').insert({ tenant_id: ORG_A, invoice_id: id, token_hash: newToken().hash }).select('id').single();
      expect(first.error).toBeNull();
      const second = await owner.from('invoice_share_links').insert({ tenant_id: ORG_A, invoice_id: id, token_hash: newToken().hash });
      expect(second.error?.code).toBe('23505');

      const revoked = await owner.from('invoice_share_links')
        .update({ revoked_at: new Date().toISOString() })
        .eq('id', (first.data as { id: string }).id)
        .is('revoked_at', null)
        .select('id');
      expect(revoked.data).toHaveLength(1);
      expect((await owner.from('invoice_share_links').insert({ tenant_id: ORG_A, invoice_id: id, token_hash: newToken().hash })).error).toBeNull();
    });

    it('cofnięcie: czas i autor z bazy, bez przywrócenia; księgowa nie cofa; licznika i terminu klient nie zmieni', async () => {
      const { id } = await faktura();
      const link = await linkSerwisowy(id);
      const accountant = await signedIn('accountant');
      const notMine = await accountant.from('invoice_share_links').update({ revoked_at: new Date().toISOString() }).eq('id', link.id).select('id');
      expect(notMine.data ?? []).toEqual([]);

      const owner = await signedIn('owner');
      expect((await owner.from('invoice_share_links').update({ open_count: 0 }).eq('id', link.id).select('id')).error?.code).toBe('42501');
      expect((await owner.from('invoice_share_links').update({ expires_at: new Date(Date.now() + 200 * DAY_MS).toISOString() }).eq('id', link.id).select('id')).error?.code).toBe('42501');

      const before = Date.now();
      const revoked = await owner.from('invoice_share_links')
        .update({ revoked_at: '2030-01-01T00:00:00Z' })
        .eq('id', link.id)
        .select('revoked_at, revoked_by')
        .single();
      expect(revoked.error).toBeNull();
      const row = revoked.data as { revoked_at: string; revoked_by: string };
      expect(new Date(row.revoked_at).getTime()).toBeLessThan(before + 60_000);
      expect(row.revoked_by).toBe(users.owner);

      const restore = await owner.from('invoice_share_links').update({ revoked_at: null }).eq('id', link.id).select('id');
      expect(restore.data ?? []).toEqual([]);
      const service = await admin.from('invoice_share_links').update({ revoked_at: null }).eq('id', link.id);
      expect(service.error?.message).toMatch(/invoice_share_link_revoked/);
    });
  });

  describe('funkcja odczytu publicznego invoice_share_link_view', () => {
    it('ważny link: dane tej jednej faktury, bez kontaktów i bez innych pól', async () => {
      const { id, number } = await faktura();
      await faktura();
      const link = await linkSerwisowy(id);
      const view = await widok(link.hash);
      expect(view).toMatchObject({
        link_id: link.id,
        tenant_id: ORG_A,
        invoice_id: id,
        ksef_environment: 'test',
        xml_storage_path: `${ORG_A}/2026/10/${id}.xml`,
        xml_sha256: HASH_XML,
      });
      const invoice = view!.invoice as Record<string, unknown>;
      expect(invoice).toMatchObject({
        internal_number: number,
        invoice_kind: 'regular',
        issue_date: '2026-10-01',
        notes: 'Uwagi na fakturze',
        split_payment: false,
        seller: { name: 'Sprzedawca a', nip: NIP, address_line1: 'ul. Prosta 1' },
        buyer: { name: 'Jan Nabywca', nip: null, address_line1: 'ul. Krzywa 2' },
        payment: { method: 'transfer', due_date: '2026-10-15', bank_account: 'PL61109010140000071219812874' },
      });
      expect(invoice.lines).toEqual([expect.objectContaining({ ordinal: 1, name: 'Usługa testowa', vat_rate: '23' })]);
      const json = JSON.stringify(view);
      for (const hidden of ['nabywca@example.test', 'sprzedawca@example.test', '+48500100200', 'fa3_data', 'buyer_data', 'payment_status', 'paid_amount', 'token_hash']) {
        expect(json).not.toContain(hidden);
      }
    });

    it('licznik otwarć rośnie tylko przy p_count_open = true', async () => {
      const { id } = await faktura();
      const link = await linkSerwisowy(id);
      await widok(link.hash, true);
      await widok(link.hash, true);
      await widok(link.hash, false);
      const { data } = await admin.from('invoice_share_links').select('open_count, last_opened_at').eq('id', link.id).single();
      expect(data).toMatchObject({ open_count: 2 });
      expect((data as { last_opened_at: string | null }).last_opened_at).not.toBeNull();
    });

    it('wygasły link: NULL', async () => {
      const { id } = await faktura();
      const base = Date.now();
      const link = await linkSerwisowy(id, ORG_A, {
        created_at: new Date(base - 100 * DAY_MS).toISOString(),
        expires_at: new Date(base - 11 * DAY_MS).toISOString(),
      });
      expect(await widok(link.hash, true)).toBeNull();
      const { data } = await admin.from('invoice_share_links').select('open_count').eq('id', link.id).single();
      expect(data).toMatchObject({ open_count: 0 });
    });

    it('cofnięty link: NULL', async () => {
      const { id } = await faktura();
      const link = await linkSerwisowy(id);
      const owner = await signedIn('owner');
      await owner.from('invoice_share_links').update({ revoked_at: new Date().toISOString() }).eq('id', link.id);
      expect(await widok(link.hash, true)).toBeNull();
    });

    it('nieznany albo zniekształcony token: NULL', async () => {
      const { id } = await faktura();
      const link = await linkSerwisowy(id);
      expect(await widok(newToken().hash)).toBeNull();
      expect(await widok(link.hash.toUpperCase())).toBeNull();
      expect(await widok(link.token)).toBeNull();
      expect(await widok('')).toBeNull();
    });

    it('cudzy token: link firmy B zwraca wyłącznie fakturę firmy B', async () => {
      const a = await faktura();
      const b = await faktura({}, ORG_B);
      await linkSerwisowy(a.id);
      const linkB = await linkSerwisowy(b.id, ORG_B);
      const view = await widok(linkB.hash);
      expect(view).toMatchObject({ tenant_id: ORG_B, invoice_id: b.id });
      expect((view!.invoice as { internal_number: string }).internal_number).toBe(b.number);
      expect(JSON.stringify(view)).not.toContain(a.id);
    });

    it.each<[string, Fixture, boolean]>([
      ['szkic', fixed({ ksef_status: 'draft', ksef_number: null, ksef_environment: null }), true],
      ['odrzucona', fixed({ ksef_status: 'rejected', ksef_number: null }), true],
      ['korekta', korekta, true],
      ['faktura zakupu', fixed({ direction: 'incoming' }), true],
      ['import z KSeF', fixed({ origin: 'ksef_import' }), true],
      ['bez wiersza pliku XML', fixed({}), false],
    ])('faktura niespełniająca warunków (%s): NULL, nawet gdy link wstawił klucz serwisowy', async (_name, fields, xml) => {
      const { id } = await faktura(await fields(), ORG_A, { xml });
      const link = await linkSerwisowy(id);
      expect(await widok(link.hash, true)).toBeNull();
    });

    it('klient i niezalogowany nie wywołają funkcji (tylko klucz serwisowy)', async () => {
      const { id } = await faktura();
      const link = await linkSerwisowy(id);
      const owner = await signedIn('owner');
      const asOwner = await owner.rpc('invoice_share_link_view', { p_token_hash: link.hash, p_count_open: false });
      expect(asOwner.error?.code).toBe('42501');
      const asAnon = await anonClient().rpc('invoice_share_link_view', { p_token_hash: link.hash, p_count_open: false });
      expect(asAnon.error?.code).toBe('42501');
    });
  });
});

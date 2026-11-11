import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { MOI_KLIENCI_RPC, czytajMoichKlientow, type KlientRpc } from '@/lib/dashboard/moi-klienci';

import { getRlsTestEnvironment } from './helpers/rls-environment';

/**
 * 00185 na prawdziwej bazie (krok 6.2, część 2, „Moi klienci”): funkcja
 * `my_organizations_summary` oddaje podsumowanie TYLKO firm z aktywnym
 * członkostwem zalogowanego (`auth.uid()`), bez względu na nagłówek
 * aktywnej firmy; z cudzej firmy nic. Liczby po terminie z warunkami
 * `getReceivables` (środowisko, rodzaje, dzieci, waluta, reszta ROZ po
 * zaliczkach, wpłata częściowa), koszty do opisania jak kafel „Do opisania”.
 *
 * Dane testowe: paczki z tymi samymi kluczami w każdym wierszu (PostgREST
 * wpisuje NULL w brakujące kolumny), faktury pojedynczo.
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

const ORG_A = '00185185-0000-4000-8000-00000000000a';
const ORG_B = '00185185-0000-4000-8000-00000000000b';
const ORG_OBCA = '00185185-0000-4000-8000-00000000000c';
const ORG_COFNIETA = '00185185-0000-4000-8000-00000000000d';
const ORG_USUNIETA = '00185185-0000-4000-8000-00000000000e';
const ORGS = [ORG_A, ORG_B, ORG_OBCA, ORG_COFNIETA, ORG_USUNIETA];

const KSIEGOWA_EMAIL = 'rls-moi-klienci-ksiegowa@ksef-saas.test';
const OBCY_EMAIL = 'rls-moi-klienci-obcy@ksef-saas.test';
const PASS = 'RlsMoiKlienciPass2026Aa!';

const KOLUMNY = [
  'organization_id',
  'name',
  'nip',
  'role',
  'expenses_to_review',
  'overdue_count',
  'overdue_grosze',
  'overdue_foreign_count',
  'unknown_environment_count',
  'has_ksef_credentials',
  'ksef_verified_at',
  'ksef_verified_environment',
  'ksef_certificate_expiry',
  'vat_exemption_basis',
  'ksiegowosc_enabled',
];

type Wiersz = Record<string, unknown>;
let counter = 0;

function anonClient(activeOrg?: string): SupabaseClient {
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

async function zalogowany(email: string, activeOrg?: string): Promise<SupabaseClient> {
  const client = anonClient(activeOrg);
  const { error } = await client.auth.signInWithPassword({ email, password: PASS });
  if (error) throw error;
  return client;
}

const NIP: Readonly<Record<string, string>> = {
  [ORG_A]: '9480185001',
  [ORG_B]: '9480185002',
  [ORG_OBCA]: '9480185003',
  [ORG_COFNIETA]: '9480185004',
  [ORG_USUNIETA]: '9480185005',
};

/**
 * Faktura sprzedaży z terminem 01.10.2020 (po terminie), nic nie wpłacono;
 * zwraca id. Przyjęta w KSeF dostaje numer KSeF z NIP-em sprzedawcy.
 */
async function faktura(tenantId: string, pola: Wiersz): Promise<string> {
  counter += 1;
  const id = `00185185-0000-4000-8000-${String(counter).padStart(12, '0')}`;
  const numer = `FV/00185/${counter}`;
  const nip = NIP[tenantId]!;
  const numerKsef = pola.ksef_status === 'accepted'
    ? { ksef_number: `${nip}-20200915-${String(counter).padStart(12, '0')}-00` }
    : {};
  const { error } = await admin.from('invoices').insert({
    id, tenant_id: tenantId, direction: 'outgoing', internal_number: numer, invoice_type: 'VAT',
    invoice_kind: 'regular', issue_date: '2020-09-15', payment_due_date: '2020-10-01',
    seller_nip: nip, buyer_nip: '1234567890',
    gross_total: 1230, net_total: 1000, vat_total: 230, ksef_status: 'draft',
    fa3_data: { internalNumber: numer, type: 'VAT' }, seller_data: { nip },
    buyer_data: { nip: '1234567890', name: 'Nabywca 00185' },
    ...numerKsef,
    ...pola,
  });
  if (error) throw new Error(`faktura ${numer}: ${error.message}`);
  return id;
}

function przyjeta(env = 'test'): Wiersz {
  return { ksef_status: 'accepted', ksef_environment: env, xml_storage_path: 'x.xml' };
}

async function sprzataj() {
  for (const org of ORGS) {
    await admin.from('invoices').update({
      ksef_status: 'draft', ksef_send_owner: null, submitted_to_ksef_at: null, last_attempt_at: null,
      ksef_number: null, ksef_accepted_at: null, xml_storage_path: null, ksef_environment: null,
    }).eq('tenant_id', org).neq('ksef_status', 'accepted');
    await admin.from('invoices').delete().eq('tenant_id', org).eq('invoice_kind', 'correction');
    await admin.from('invoices').delete().eq('tenant_id', org).eq('invoice_kind', 'final');
    await admin.from('invoices').delete().eq('tenant_id', org);
    await admin.from('expenses').delete().eq('tenant_id', org);
    await admin.from('audit_logs').delete().eq('tenant_id', org);
    await admin.from('tenant_feature_flags').delete().eq('tenant_id', org);
    await admin.from('memberships').delete().eq('organization_id', org);
    await admin.from('tenants').delete().eq('id', org);
  }
}

function firma(id: string, nip: string, z: Wiersz = {}): Wiersz {
  return {
    id, nip, name: `Firma ${nip}`,
    deleted_at: null, ksef_credentials_encrypted: null, ksef_verified_at: null,
    ksef_verified_environment: null, ksef_certificate_expiry: null, vat_exemption_basis: null,
    ...z,
  };
}

function wydatek(tenantId: string, autor: string, isReviewed: boolean): Wiersz {
  return {
    tenant_id: tenantId, created_by: autor, source: 'manual', seller_name: 'Sprzedawca 00185',
    issue_date: '2026-10-01', net_amount: 100, gross_amount: 123, is_reviewed: isReviewed,
  };
}

function wiersz(dane: unknown, org: string): Wiersz | undefined {
  return (dane as Wiersz[] | null)?.find((w) => w.organization_id === org);
}

describe.skipIf(!hasDatabase)('00185: „Moi klienci” na prawdziwym PostgREST', () => {
  beforeAll(async () => {
    await sprzataj();
    const ksiegowaId = await userId(KSIEGOWA_EMAIL);
    const obcyId = await userId(OBCY_EMAIL);
    await admin.from('users').upsert(
      [{ id: ksiegowaId, name: 'Księgowa 00185' }, { id: obcyId, name: 'Obcy 00185' }],
      { onConflict: 'id' },
    );

    const blob = '\\x' + Buffer.from('zaszyfrowany-blob-00185').toString('hex');
    const { error: tErr } = await admin.from('tenants').insert([
      firma(ORG_A, '9480185001', {
        name: 'Alfa 00185', ksef_credentials_encrypted: blob,
        ksef_verified_at: '2026-10-01T00:00:00Z', ksef_verified_environment: 'test',
      }),
      firma(ORG_B, '9480185002', { name: 'Beta 00185' }),
      firma(ORG_OBCA, '9480185003', { name: 'Obca 00185' }),
      firma(ORG_COFNIETA, '9480185004', { name: 'Cofnięta 00185' }),
      firma(ORG_USUNIETA, '9480185005', { name: 'Usunięta 00185', deleted_at: '2026-10-01T00:00:00Z' }),
    ]);
    if (tErr) throw new Error(`tenants: ${tErr.message}`);

    const { error: mErr } = await admin.from('memberships').insert([
      { organization_id: ORG_A, user_id: ksiegowaId, role: 'accountant', status: 'active' },
      { organization_id: ORG_B, user_id: ksiegowaId, role: 'accountant', status: 'active' },
      { organization_id: ORG_COFNIETA, user_id: ksiegowaId, role: 'accountant', status: 'revoked' },
      { organization_id: ORG_USUNIETA, user_id: ksiegowaId, role: 'accountant', status: 'active' },
      { organization_id: ORG_OBCA, user_id: obcyId, role: 'owner', status: 'active' },
    ]);
    if (mErr) throw new Error(`memberships: ${mErr.message}`);

    const { error: fErr } = await admin
      .from('tenant_feature_flags')
      .upsert({ tenant_id: ORG_A, ksiegowosc_enabled: true }, { onConflict: 'tenant_id' });
    if (fErr) throw new Error(`flags: ${fErr.message}`);

    const { error: eErr } = await admin.from('expenses').insert([
      wydatek(ORG_A, ksiegowaId, false),
      wydatek(ORG_A, ksiegowaId, false),
      wydatek(ORG_A, ksiegowaId, true),
      wydatek(ORG_OBCA, obcyId, false),
      wydatek(ORG_OBCA, obcyId, false),
      wydatek(ORG_OBCA, obcyId, false),
      wydatek(ORG_OBCA, obcyId, false),
      wydatek(ORG_OBCA, obcyId, false),
    ]);
    if (eErr) throw new Error(`expenses: ${eErr.message}`);

    // Firma A: liczą się 1230 + 1000 (wpłata częściowa 230) + 500 (reszta ROZ) = 2730,00 zł.
    await faktura(ORG_A, przyjeta());
    await faktura(ORG_A, { ...przyjeta(), paid_amount: 230 });
    await faktura(ORG_A, { ...przyjeta(), payment_due_date: '2099-12-31' });
    await faktura(ORG_A, { ...przyjeta(), currency: 'EUR' });
    await faktura(ORG_A, przyjeta('production'));
    await faktura(ORG_A, { ...przyjeta(), origin: 'ksef_import' });
    await faktura(ORG_A, { ...przyjeta(), paid_amount: 1230 });
    await faktura(ORG_A, {});
    // Zaliczka rozliczona fakturą ROZ ma dziecko, więc się nie liczy (jak w getReceivables).
    const zaliczka = await faktura(ORG_A, {
      ...przyjeta(), invoice_type: 'ZAL', invoice_kind: 'advance', advance_amount: 1230,
    });
    await faktura(ORG_A, {
      ...przyjeta(), invoice_type: 'ROZ', invoice_kind: 'final', advance_invoice_ids: [zaliczka],
      gross_total: 3000, net_total: 2439.02, vat_total: 560.98, payment_data: { amountDue: 500 },
    });
    const korygowana = await faktura(ORG_A, przyjeta());
    await faktura(ORG_A, {
      invoice_type: 'KOR', invoice_kind: 'correction', parent_invoice_id: korygowana,
      correction_reason: 'test', correction_type: 'before_after',
      gross_total: -123, net_total: -100, vat_total: -23,
    });
    // Cudza firma: zaległość, której księgowa nie może zobaczyć.
    await faktura(ORG_OBCA, przyjeta());
  }, 60_000);

  afterAll(async () => {
    if (!hasDatabase) return;
    await sprzataj();
  });

  it('księgowa widzi tylko swoje dwie firmy i tylko kolumny podsumowania', async () => {
    const ksiegowa = await zalogowany(KSIEGOWA_EMAIL, ORG_A);
    const { data, error } = await ksiegowa.rpc(MOI_KLIENCI_RPC, { p_ksef_environment: 'test' });
    expect(error).toBeNull();
    const wiersze = data as Wiersz[];
    expect(wiersze.map((w) => w.organization_id).sort()).toEqual([ORG_A, ORG_B]);
    for (const w of wiersze) expect(Object.keys(w).sort()).toEqual([...KOLUMNY].sort());

    expect(wiersz(data, ORG_A)).toMatchObject({
      name: 'Alfa 00185',
      nip: '9480185001',
      role: 'accountant',
      expenses_to_review: 2,
      overdue_count: 3,
      overdue_grosze: 273000,
      overdue_foreign_count: 1,
      unknown_environment_count: 0,
      has_ksef_credentials: true,
      ksef_verified_environment: 'test',
      ksiegowosc_enabled: true,
    });
    expect(wiersz(data, ORG_B)).toMatchObject({
      expenses_to_review: 0,
      overdue_count: 0,
      overdue_grosze: 0,
      overdue_foreign_count: 0,
      has_ksef_credentials: false,
      ksiegowosc_enabled: false,
    });
  });

  it('nagłówek z cudzą firmą niczego nie dokłada', async () => {
    const ksiegowa = await zalogowany(KSIEGOWA_EMAIL, ORG_OBCA);
    const { data, error } = await ksiegowa.rpc(MOI_KLIENCI_RPC, { p_ksef_environment: 'test' });
    expect(error).toBeNull();
    expect((data as Wiersz[]).map((w) => w.organization_id).sort()).toEqual([ORG_A, ORG_B]);
  });

  it('właściciel innej firmy widzi tylko ją, z jej liczbami', async () => {
    const obcy = await zalogowany(OBCY_EMAIL, ORG_OBCA);
    const { data, error } = await obcy.rpc(MOI_KLIENCI_RPC, { p_ksef_environment: 'test' });
    expect(error).toBeNull();
    expect((data as Wiersz[]).map((w) => w.organization_id)).toEqual([ORG_OBCA]);
    expect(wiersz(data, ORG_OBCA)).toMatchObject({ role: 'owner', expenses_to_review: 5, overdue_count: 1, overdue_grosze: 123000 });
  });

  it('środowisko KSeF z argumentu: produkcja liczy tylko faktury przyjęte na produkcji', async () => {
    const ksiegowa = await zalogowany(KSIEGOWA_EMAIL, ORG_A);
    const { data, error } = await ksiegowa.rpc(MOI_KLIENCI_RPC, { p_ksef_environment: 'production' });
    expect(error).toBeNull();
    expect(wiersz(data, ORG_A)).toMatchObject({ overdue_count: 1, overdue_grosze: 123000, overdue_foreign_count: 0 });
  });

  it('nieznane środowisko to błąd, nie zera', async () => {
    const ksiegowa = await zalogowany(KSIEGOWA_EMAIL, ORG_A);
    const { data, error } = await ksiegowa.rpc(MOI_KLIENCI_RPC, { p_ksef_environment: 'staging' });
    expect(data).toBeNull();
    expect(error?.code).toBe('22023');
  });

  it('bez logowania funkcja nie działa', async () => {
    const { data, error } = await anonClient().rpc(MOI_KLIENCI_RPC, { p_ksef_environment: 'test' });
    expect(data).toBeNull();
    expect(error?.code).toBe('42501');
  });

  it('czytajMoichKlientow na prawdziwej bazie: kwoty, moduł i status KSeF', async () => {
    const ksiegowa = await zalogowany(KSIEGOWA_EMAIL, ORG_A);
    const wynik = await czytajMoichKlientow(ksiegowa as unknown as KlientRpc, {
      aktywnaFirma: ORG_A,
      czytajGlobalnyStop: async () => false,
    });
    expect(wynik.ok).toBe(true);
    if (!wynik.ok) return;
    expect(wynik.firmy.map((f) => f.organizationId)).toEqual([ORG_A, ORG_B]);
    expect(wynik.firmy[0]).toMatchObject({
      aktywna: true,
      kosztyDoOpisania: 2,
      poTerminie: { stan: 'ok', liczba: 3, sumaGr: 273000, walutaObca: 1 },
      ksef: 'polaczono',
      termin: { stan: 'ok' },
    });
    expect(wynik.firmy[1]).toMatchObject({ aktywna: false, ksef: 'brak', termin: null });
  });
});

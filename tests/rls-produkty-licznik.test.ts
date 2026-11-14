import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { recordProductUsage } from '@/lib/produkty/uzycie';

import { getRlsTestEnvironment } from './helpers/rls-environment';

/**
 * 00204 na prawdziwym Postgresie i PostgREST: licznik użyć produktu
 * z katalogu przy zapisie faktury (plan kompletnej aplikacji, krok 2.6).
 *
 * - jedno wywołanie zwiększa `use_count` o 1 i ustawia `last_used_at` w
 *   produktach aktywnej firmy, których klucz pasuje do pary nazwa + jednostka;
 *   ta sama para kilka razy w jednym wywołaniu to jedno użycie;
 * - klucz jak indeks `uq_products_tenant_catalog_key` (00186): wyrocznią jest
 *   sam indeks (para, z którą nowego produktu nie da się dodać, bo dostaje
 *   23505, liczy istniejący produkt; para, z którą się da, nie liczy nic);
 * - produkt archiwalny liczy się (historia użycia), produkt innej firmy nigdy;
 *   każdy aktywny członek firmy liczy, nie tylko właściciel;
 * - sesja bez aktywnej firmy, nagłówek firmy, w której zalogowany nie jest
 *   członkiem, i anon: odmowa, bez zmian;
 * - złe wejście (nie tablica, element bez tekstu, ponad 1000 pozycji, nazwa
 *   ponad 512 albo jednostka ponad 256 znaków): odmowa 22023 bez zmian;
 * - dziesięć wywołań naraz z tymi samymi produktami w różnej kolejności:
 *   każde dolicza swoje +1 (jeden UPDATE z `use_count + 1`, blokady po id),
 *   bez zakleszczenia;
 * - moduł aplikacji (`recordProductUsage`) woła funkcję przez PostgREST.
 *
 * Czerwień przed 00204: funkcji nie ma (PGRST202), liczniki stoją.
 */

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

const ORG_A = '00204204-0000-4000-8000-00000000000a';
const ORG_B = '00204204-0000-4000-8000-00000000000b';
const EMAILS = {
  owner: 'rls-produkty-licznik-owner@ksef-saas.test',
  member: 'rls-produkty-licznik-member@ksef-saas.test',
  obcy: 'rls-produkty-licznik-obcy@ksef-saas.test',
} as const;
type Kto = keyof typeof EMAILS;
const PASS = 'RlsProduktyLicznik2026Aa!';
const NIP = '1234567890';
const RPC = 'product_usage_record';

const users: Record<Kto, string> = { owner: '', member: '', obcy: '' };

/** Katalog obu firm na początku każdego testu. */
const PRODUCTS = {
  uslugaA: { tenant_id: ORG_A, name: 'Usługa programistyczna', unit: 'godz.' },
  konsultacjaA: { tenant_id: ORG_A, name: 'Konsultacja', unit: 'szt.' },
  archiwalnyA: { tenant_id: ORG_A, name: 'Abonament serwisowy', unit: 'mies.', is_archived: true },
  licencjaA: { tenant_id: ORG_A, name: 'Licencja roczna', unit: 'szt.', use_count: 5, last_used_at: '2020-01-15T10:00:00Z' },
  uslugaB: { tenant_id: ORG_B, name: 'Usługa programistyczna', unit: 'godz.' },
} as const;
type Produkt = keyof typeof PRODUCTS;
const ids = {} as Record<Produkt, string>;
const START = { uslugaA: 0, konsultacjaA: 0, archiwalnyA: 0, licencjaA: 5, uslugaB: 0 } satisfies Record<Produkt, number>;

const USLUGA = { name: 'Usługa programistyczna', unit: 'godz.' };
const KONSULTACJA = { name: 'Konsultacja', unit: 'szt.' };

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

async function signedIn(who: Kto, activeOrg?: string): Promise<SupabaseClient> {
  const c = anonClient(activeOrg);
  const { error } = await c.auth.signInWithPassword({ email: EMAILS[who], password: PASS });
  if (error) throw error;
  return c;
}

/** Sesje logowane raz na plik (bez logowania w każdym teście). */
const s = {} as {
  owner: SupabaseClient;
  member: SupabaseClient;
  obcyB: SupabaseClient;
  obcyNaA: SupabaseClient;
  ownerNaB: SupabaseClient;
  ownerBezFirmy: SupabaseClient;
};

async function cleanup() {
  const { error } = await admin.from('products').delete().in('tenant_id', [ORG_A, ORG_B]);
  if (error) throw new Error(`sprzątanie produktów: ${error.message}`);
}

async function seedProducts() {
  for (const key of Object.keys(PRODUCTS) as Produkt[]) {
    const row: Record<string, unknown> = { ...PRODUCTS[key] };
    const { data, error } = await admin.from('products').insert(row).select('id').single();
    if (error || !data) throw new Error(`produkt ${key}: ${error?.message ?? 'brak wiersza'}`);
    ids[key] = (data as { id: string }).id;
  }
}

async function counts(): Promise<Record<Produkt, number>> {
  const { data, error } = await admin.from('products').select('id, use_count').in('tenant_id', [ORG_A, ORG_B]);
  if (error) throw error;
  const byId = new Map((data ?? []).map((r) => [r.id as string, Number(r.use_count)]));
  return Object.fromEntries((Object.keys(PRODUCTS) as Produkt[]).map((k) => [k, byId.get(ids[k]) ?? -1])) as Record<Produkt, number>;
}

async function lastUsedAt(key: Produkt): Promise<string | null> {
  const { data, error } = await admin.from('products').select('last_used_at').eq('id', ids[key]).single();
  if (error || !data) throw error ?? new Error('brak produktu');
  return (data as { last_used_at: string | null }).last_used_at;
}

describe.skipIf(!hasDatabase)('00204: licznik użyć produktu na prawdziwym PostgREST', () => {
  beforeAll(async () => {
    for (const who of Object.keys(EMAILS) as Kto[]) users[who] = await userId(EMAILS[who]);
    await cleanup();
    await admin.from('memberships').delete().in('organization_id', [ORG_A, ORG_B]);
    // Wpisy audytu firmy testowej zostają po przebiegu (00052), więc firmy nie kasujemy, tylko nadpisujemy.
    const tenants = await admin.from('tenants').upsert(
      [
        { id: ORG_A, nip: NIP, name: 'Firma A Licznik produktów', address_json: { countryCode: 'PL', addressLine1: 'ul. Przykładowa 1', addressLine2: '00-001 Warszawa' } },
        { id: ORG_B, nip: NIP, name: 'Firma B Licznik produktów', address_json: { countryCode: 'PL', addressLine1: 'ul. Inna 2', addressLine2: '00-002 Warszawa' } },
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
      { organization_id: ORG_B, user_id: users.obcy, role: 'owner', status: 'active' },
    ]);
    if (memberships.error) throw memberships.error;

    s.owner = await signedIn('owner', ORG_A);
    s.member = await signedIn('member', ORG_A);
    s.obcyB = await signedIn('obcy', ORG_B);
    s.obcyNaA = await signedIn('obcy', ORG_A);
    s.ownerNaB = await signedIn('owner', ORG_B);
    s.ownerBezFirmy = await signedIn('owner');
  });

  beforeEach(async () => {
    await cleanup();
    await seedProducts();
  });

  afterAll(async () => {
    if (!hasDatabase) return;
    await cleanup();
    await admin.from('memberships').delete().in('organization_id', [ORG_A, ORG_B]);
  });

  describe('jedno wywołanie po zapisie faktury', () => {
    it('pasujące produkty firmy: +1 i last_used_at; ta sama para dwa razy to jedno użycie', async () => {
      const { data, error } = await s.owner.rpc(RPC, {
        p_lines: [USLUGA, USLUGA, KONSULTACJA, { name: 'Produkt spoza katalogu', unit: 'szt.' }],
      });

      expect(error).toBeNull();
      expect(data).toBe(2);
      expect(await counts()).toEqual({ ...START, uslugaA: 1, konsultacjaA: 1 });
      const used = await lastUsedAt('uslugaA');
      expect(used).not.toBeNull();
      expect(Math.abs(Date.parse(used!) - Date.now())).toBeLessThan(10 * 60_000);
      // Nietknięte produkty bez zmian, także data ostatniego użycia.
      expect(await lastUsedAt('archiwalnyA')).toBeNull();
      expect(Date.parse((await lastUsedAt('licencjaA'))!)).toBe(Date.parse('2020-01-15T10:00:00Z'));
    });

    it('licznik dolicza do dotychczasowej liczby (nie nadpisuje)', async () => {
      const { data, error } = await s.owner.rpc(RPC, { p_lines: [{ name: 'Licencja roczna', unit: 'szt.' }] });

      expect(error).toBeNull();
      expect(data).toBe(1);
      expect((await counts()).licencjaA).toBe(6);
      expect(Date.parse((await lastUsedAt('licencjaA'))!)).toBeGreaterThan(Date.parse('2020-01-15T10:00:00Z'));
    });

    it('pusta lista pozycji: 0, bez zmian', async () => {
      const { data, error } = await s.owner.rpc(RPC, { p_lines: [] });

      expect(error).toBeNull();
      expect(data).toBe(0);
      expect(await counts()).toEqual(START);
    });

    it('produkt archiwalny też liczy (historia użycia; archiwum chowa tylko podpowiedź)', async () => {
      const { data, error } = await s.owner.rpc(RPC, { p_lines: [{ name: 'Abonament serwisowy', unit: 'mies.' }] });

      expect(error).toBeNull();
      expect(data).toBe(1);
      expect((await counts()).archiwalnyA).toBe(1);
    });

    it('członek firmy (nie właściciel) też liczy', async () => {
      const { error } = await s.member.rpc(RPC, { p_lines: [KONSULTACJA] });

      expect(error).toBeNull();
      expect((await counts()).konsultacjaA).toBe(1);
    });
  });

  describe('klucz produktu jak indeks 00186', () => {
    /**
     * `same`: czego oczekujemy dla produktu „Usługa programistyczna” / „godz.”.
     * Różnice tylko w literach ASCII (lower() litery „Ł” zależy od ustawień bazy),
     * ale i tak rozstrzyga indeks: test porównuje licznik z odmową 23505.
     */
    const VARIANTS: ReadonlyArray<{ label: string; name: string; unit: string; same: boolean }> = [
      { label: 'wielkość liter, odstępy w nazwie i wokół jednostki', name: '  usługa   PROGRAMISTYCZNA ', unit: ' GODZ. ', same: true },
      { label: 'tabulator w nazwie, nowa linia na końcu', name: 'Usługa\tprogramistyczna\n', unit: 'godz.', same: true },
      { label: 'tabulator i nowa linia wokół jednostki', name: 'Usługa programistyczna', unit: '\tgodz.\n', same: true },
      { label: 'jednostka bez kropki', name: 'Usługa programistyczna', unit: 'godz', same: false },
      { label: 'odstęp w środku jednostki', name: 'Usługa programistyczna', unit: 'go dz.', same: false },
      { label: 'inna nazwa', name: 'Usługa programistyczna 2', unit: 'godz.', same: false },
    ];

    it.each(VARIANTS)('$label: licznik liczy ten sam produkt, którego indeks nie wpuści drugi raz', async (v) => {
      // Wyrocznia: indeks uq_products_tenant_catalog_key (nowy produkt z tą parą).
      const probe = await admin.from('products').insert({ tenant_id: ORG_A, name: v.name, unit: v.unit }).select('id');
      if (probe.error) {
        expect(probe.error.code).toBe('23505');
      } else {
        const del = await admin.from('products').delete().in('id', (probe.data ?? []).map((r) => r.id as string));
        expect(del.error).toBeNull();
      }
      const indexSaysSame = probe.error?.code === '23505';
      expect(indexSaysSame).toBe(v.same);

      const { data, error } = await s.owner.rpc(RPC, { p_lines: [{ name: v.name, unit: v.unit }] });

      expect(error).toBeNull();
      expect(data).toBe(indexSaysSame ? 1 : 0);
      expect((await counts()).uslugaA).toBe(indexSaysSame ? 1 : 0);
    });

    it('warianty tej samej pary w jednym wywołaniu: jedno użycie', async () => {
      const { data, error } = await s.owner.rpc(RPC, {
        p_lines: [USLUGA, { name: '  usługa   PROGRAMISTYCZNA ', unit: ' GODZ. ' }, { name: 'Usługa\tprogramistyczna', unit: 'godz.' }],
      });

      expect(error).toBeNull();
      expect(data).toBe(1);
      expect((await counts()).uslugaA).toBe(1);
    });
  });

  describe('firma i sesja', () => {
    it('produkt innej firmy nigdy: ta sama para w firmie B bez zmian, każda firma liczy swoje', async () => {
      const a = await s.owner.rpc(RPC, { p_lines: [USLUGA] });
      expect(a.error).toBeNull();
      expect(await counts()).toEqual({ ...START, uslugaA: 1 });

      const b = await s.obcyB.rpc(RPC, { p_lines: [USLUGA] });
      expect(b.error).toBeNull();
      expect(b.data).toBe(1);
      expect(await counts()).toEqual({ ...START, uslugaA: 1, uslugaB: 1 });
    });

    it('nagłówek firmy, w której zalogowany nie jest członkiem: odmowa 42501, bez zmian w obu firmach', async () => {
      const obcyNaA = await s.obcyNaA.rpc(RPC, { p_lines: [USLUGA, KONSULTACJA] });
      const ownerNaB = await s.ownerNaB.rpc(RPC, { p_lines: [USLUGA] });

      expect(obcyNaA.error?.code).toBe('42501');
      expect(ownerNaB.error?.code).toBe('42501');
      expect(await counts()).toEqual(START);
    });

    it('sesja bez aktywnej firmy (bez nagłówka x-active-org): odmowa 42501, bez zmian', async () => {
      const { data, error } = await s.ownerBezFirmy.rpc(RPC, { p_lines: [USLUGA] });

      expect(error?.code).toBe('42501');
      expect(data).toBeNull();
      expect(await counts()).toEqual(START);
    });

    it('anon: funkcja niedostępna, bez zmian', async () => {
      const { error } = await anonClient(ORG_A).rpc(RPC, { p_lines: [USLUGA] });

      expect(error?.code).toBe('42501');
      expect(await counts()).toEqual(START);
    });
  });

  describe('granice wejścia', () => {
    const BAD: ReadonlyArray<[string, unknown]> = [
      ['obiekt zamiast tablicy', KONSULTACJA],
      ['null', null],
      ['element bez jednostki', [{ name: 'Konsultacja' }]],
      ['jednostka nie jest tekstem', [{ name: 'Konsultacja', unit: 5 }]],
      ['element nie jest obiektem', ['Konsultacja']],
      ['nazwa ponad 512 znaków', [KONSULTACJA, { name: 'x'.repeat(513), unit: 'szt.' }]],
      ['jednostka ponad 256 znaków', [KONSULTACJA, { name: 'Konsultacja', unit: 'x'.repeat(257) }]],
      ['ponad 1000 pozycji', Array.from({ length: 1001 }, () => KONSULTACJA)],
    ];

    it.each(BAD)('%s: odmowa 22023 bez zmian', async (_name, p_lines) => {
      const { data, error } = await s.owner.rpc(RPC, { p_lines });

      expect(error?.code).toBe('22023');
      expect(data).toBeNull();
      expect(await counts()).toEqual(START);
    });

    it('1000 pozycji, nazwa 512 i jednostka 256 znaków: przechodzi', async () => {
      const lines = Array.from({ length: 1000 }, (_, i) => ({ name: `Pozycja ${i}`, unit: 'szt.' }));
      lines[0] = { name: 'x'.repeat(512), unit: 'y'.repeat(256) };
      lines[999] = KONSULTACJA;

      const { data, error } = await s.owner.rpc(RPC, { p_lines: lines });

      expect(error).toBeNull();
      expect(data).toBe(1);
      expect(await counts()).toEqual({ ...START, konsultacjaA: 1 });
    });
  });

  describe('atomowo', () => {
    it('dziesięć wywołań naraz (dwie osoby, różna kolejność pozycji): +10 bez zakleszczenia', async () => {
      const ab = [USLUGA, KONSULTACJA];
      const ba = [KONSULTACJA, USLUGA];

      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? s.owner : s.member).rpc(RPC, { p_lines: i % 3 === 0 ? ba : ab })),
      );

      expect(results.map((r) => r.error)).toEqual(Array.from({ length: 10 }, () => null));
      expect(results.map((r) => r.data)).toEqual(Array.from({ length: 10 }, () => 2));
      expect(await counts()).toEqual({ ...START, uslugaA: 10, konsultacjaA: 10 });
    });
  });

  describe('moduł aplikacji', () => {
    it('recordProductUsage przez PostgREST: pary bez powtórzeń, klucz liczy baza', async () => {
      await recordProductUsage(s.owner, [
        KONSULTACJA,
        KONSULTACJA,
        { name: '  KONSULTACJA ', unit: 'szt.' },
        { name: 'Licencja roczna', unit: 'szt.' },
      ]);

      expect(await counts()).toEqual({ ...START, konsultacjaA: 1, licencjaA: 6 });
    });
  });
});

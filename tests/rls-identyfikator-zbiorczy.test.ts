import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { getRlsTestEnvironment } from './helpers/rls-environment';

/**
 * Identyfikatory zbiorcze KSeF (00191, plan kompletnej aplikacji, krok 1.4,
 * część 2) na prawdziwym Postgresie i PostgREST: RPC
 * `claim_ksef_collective_identifier` (jeden wiersz na zestaw faktur w firmie
 * i środowisku, gotowy identyfikator wraca bez nowej próby, próba w toku
 * blokuje drugą, przerwana po 5 minutach do przejęcia),
 * `complete_ksef_collective_identifier` i `fail_ksef_collective_identifier`
 * (tylko bieżąca próba, audyt w tej samej transakcji), role owner/admin,
 * izolacja firm, brak zapisu z sesji poza RPC i wyzwalacz niezmienności.
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

const ORG_A = '00191191-0000-4000-8000-00000000000a';
const ORG_B = '00191191-0000-4000-8000-00000000000b';
const EMAILS = {
  owner: 'rls-identyfikator-owner@ksef-saas.test',
  admin: 'rls-identyfikator-admin@ksef-saas.test',
  member: 'rls-identyfikator-member@ksef-saas.test',
  accountant: 'rls-identyfikator-ksiegowa@ksef-saas.test',
  obcy: 'rls-identyfikator-obcy@ksef-saas.test',
} as const;
type Kto = keyof typeof EMAILS;
const PASS = 'RlsIdentyfikator2026Aa!';
const NIP_FIRMY = '1234567890';
const NIP_SPRZEDAWCY = '1111111111';
const WEKTOR = '1111111111-IZ202607-65ED02180000-E7';
const ksef = (n: number) => `${NIP_SPRZEDAWCY}-20261105-0A1B2C3D4E${String(n).padStart(2, '0')}-7A`;

const users: Record<Kto, string> = { owner: '', admin: '', member: '', accountant: '', obcy: '' };

interface Rezerwacja {
  status: string;
  id?: string;
  attempt?: string;
  identifier?: string;
  code?: string;
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

async function signedIn(who: Kto, activeOrg: string = ORG_A): Promise<SupabaseClient> {
  const c = anonClient(activeOrg);
  const { error } = await c.auth.signInWithPassword({ email: EMAILS[who], password: PASS });
  if (error) throw error;
  return c;
}

async function rezerwuj(c: SupabaseClient, numery: string[] = [ksef(1), ksef(2)], pola: Record<string, unknown> = {}) {
  return c.rpc('claim_ksef_collective_identifier', {
    p_environment: 'test',
    p_seller_nip: NIP_SPRZEDAWCY,
    p_ksef_numbers: numery,
    ...pola,
  });
}

async function wiersz(id: string) {
  const { data, error } = await admin.from('ksef_collective_identifiers').select('*').eq('id', id).single();
  if (error) throw error;
  return data as Record<string, unknown>;
}

async function audyt(id: string) {
  const { data, error } = await admin
    .from('audit_logs')
    .select('tenant_id, user_id, action, entity_type, entity_id, metadata')
    .eq('entity_id', id)
    .in('action', ['expense.collective_identifier_created', 'expense.collective_identifier_failed'])
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

async function cleanup() {
  await admin.from('ksef_collective_identifiers').delete().in('tenant_id', [ORG_A, ORG_B]);
}

describe.skipIf(!hasDatabase)('identyfikatory zbiorcze KSeF (00191)', () => {
  beforeAll(async () => {
    for (const who of Object.keys(EMAILS) as Kto[]) users[who] = await userId(EMAILS[who]);
    await cleanup();
    await admin.from('memberships').delete().in('organization_id', [ORG_A, ORG_B]);
    // Wpisy audytu zostają po przebiegu (00052), więc firma też: upsert zamiast kasowania.
    const tenants = await admin.from('tenants').upsert(
      [
        { id: ORG_A, nip: NIP_FIRMY, name: 'Firma A Identyfikator' },
        { id: ORG_B, nip: NIP_FIRMY, name: 'Firma B Identyfikator' },
      ],
      { onConflict: 'id' },
    );
    if (tenants.error) throw tenants.error;
    const profiles = await admin
      .from('users')
      .upsert((Object.keys(users) as Kto[]).map((who) => ({ id: users[who], name: who })), { onConflict: 'id' });
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
    await admin.from('memberships').delete().in('organization_id', [ORG_A, ORG_B]);
  });

  it('właściciel: rezerwacja, zapis identyfikatora z audytem; ponowna rezerwacja (inna kolejność) oddaje zapisany', async () => {
    const c = await signedIn('owner');

    const claim = await rezerwuj(c, [ksef(2), ksef(1)]);
    expect(claim.error).toBeNull();
    const r = claim.data as Rezerwacja;
    expect(r).toMatchObject({ status: 'claimed', id: expect.any(String), attempt: expect.any(String) });

    const done = await c.rpc('complete_ksef_collective_identifier', { p_id: r.id, p_attempt: r.attempt, p_identifier: WEKTOR });
    expect(done.error).toBeNull();
    expect(done.data).toMatchObject({ status: 'ready', identifier: WEKTOR });

    const again = await rezerwuj(c, [ksef(1), ksef(2)]);
    expect(again.data).toMatchObject({ status: 'ready', id: r.id, identifier: WEKTOR });

    expect(await wiersz(r.id!)).toMatchObject({
      tenant_id: ORG_A,
      ksef_environment: 'test',
      seller_nip: NIP_SPRZEDAWCY,
      ksef_numbers: [ksef(1), ksef(2)],
      status: 'ready',
      identifier: WEKTOR,
      error_code: null,
      requested_by: users.owner,
    });
    const wpisy = await audyt(r.id!);
    expect(wpisy).toHaveLength(1);
    expect(wpisy[0]).toMatchObject({
      tenant_id: ORG_A,
      user_id: users.owner,
      action: 'expense.collective_identifier_created',
      entity_type: 'collective_identifier',
      metadata: expect.objectContaining({ identifier: WEKTOR, sellerNip: NIP_SPRZEDAWCY, ksefNumbers: [ksef(1), ksef(2)], environment: 'test' }),
    });
  });

  it('inny zestaw faktur (część albo faktura więcej) to nowa rezerwacja', async () => {
    const c = await signedIn('owner');
    const r = (await rezerwuj(c)).data as Rezerwacja;
    await c.rpc('complete_ksef_collective_identifier', { p_id: r.id, p_attempt: r.attempt, p_identifier: WEKTOR });

    const wiecej = (await rezerwuj(c, [ksef(1), ksef(2), ksef(3)])).data as Rezerwacja;

    expect(wiecej).toMatchObject({ status: 'claimed' });
    expect(wiecej.id).not.toBe(r.id);
  });

  it('dwie rezerwacje naraz: jedna próba, druga „w toku”', async () => {
    const c = await signedIn('owner');

    const wyniki = await Promise.all([rezerwuj(c), rezerwuj(c)]);

    expect(wyniki.map((w) => (w.data as Rezerwacja).status).sort()).toEqual(['claimed', 'in_progress']);
  });

  it('porażka: „failed” z kodem i audytem; kolejna rezerwacja to nowa próba, a stara nie zapisze identyfikatora', async () => {
    const c = await signedIn('owner');
    const r1 = (await rezerwuj(c)).data as Rezerwacja;

    const fail = await c.rpc('fail_ksef_collective_identifier', { p_id: r1.id, p_attempt: r1.attempt, p_error_code: 'ksef_71002' });
    expect(fail.error).toBeNull();
    expect(fail.data).toMatchObject({ status: 'failed' });
    expect(await wiersz(r1.id!)).toMatchObject({ status: 'failed', error_code: 'ksef_71002', identifier: null });

    const r2 = (await rezerwuj(c)).data as Rezerwacja;
    expect(r2).toMatchObject({ status: 'claimed', id: r1.id });
    expect(r2.attempt).not.toBe(r1.attempt);

    const stara = await c.rpc('complete_ksef_collective_identifier', { p_id: r1.id, p_attempt: r1.attempt, p_identifier: WEKTOR });
    expect(stara.data).toMatchObject({ status: 'refused', code: 'stale_attempt' });
    const nowa = await c.rpc('complete_ksef_collective_identifier', { p_id: r2.id, p_attempt: r2.attempt, p_identifier: WEKTOR });
    expect(nowa.data).toMatchObject({ status: 'ready', identifier: WEKTOR });

    expect((await audyt(r1.id!)).map((w) => [w.action, (w.metadata as { errorCode?: string }).errorCode ?? null])).toEqual([
      ['expense.collective_identifier_failed', 'ksef_71002'],
      ['expense.collective_identifier_created', null],
    ]);
  });

  it('próba przerwana ponad 5 minut temu (np. restart serwera): następne kliknięcie ją przejmuje', async () => {
    const c = await signedIn('owner');
    const r1 = (await rezerwuj(c)).data as Rezerwacja;
    const stary = await admin
      .from('ksef_collective_identifiers')
      .update({ claimed_at: new Date(Date.now() - 6 * 60_000).toISOString() })
      .eq('id', r1.id!);
    expect(stary.error).toBeNull();

    const r2 = (await rezerwuj(c)).data as Rezerwacja;

    expect(r2).toMatchObject({ status: 'claimed', id: r1.id });
    expect(r2.attempt).not.toBe(r1.attempt);
  });

  it('administrator może; członek i księgowa: 42501; wszyscy członkowie widzą gotowy identyfikator', async () => {
    const a = await signedIn('admin');
    const r = (await rezerwuj(a)).data as Rezerwacja;
    expect(r).toMatchObject({ status: 'claimed' });
    await a.rpc('complete_ksef_collective_identifier', { p_id: r.id, p_attempt: r.attempt, p_identifier: WEKTOR });

    for (const who of ['member', 'accountant'] as const) {
      const c = await signedIn(who);
      const claim = await rezerwuj(c, [ksef(5), ksef(6)]);
      expect(claim.error?.code, who).toBe('42501');
      const done = await c.rpc('complete_ksef_collective_identifier', { p_id: r.id, p_attempt: r.attempt, p_identifier: WEKTOR });
      expect(done.error?.code, who).toBe('42501');
      const { data, error } = await c.from('ksef_collective_identifiers').select('id, status, identifier').eq('id', r.id!);
      expect(error, who).toBeNull();
      expect(data, who).toEqual([{ id: r.id, status: 'ready', identifier: WEKTOR }]);
    }
  });

  it('obca firma: nie widzi wiersza i nie zamyka cudzej próby', async () => {
    const c = await signedIn('owner');
    const r = (await rezerwuj(c)).data as Rezerwacja;
    const obcy = await signedIn('obcy', ORG_B);

    const done = await obcy.rpc('complete_ksef_collective_identifier', { p_id: r.id, p_attempt: r.attempt, p_identifier: WEKTOR });
    const fail = await obcy.rpc('fail_ksef_collective_identifier', { p_id: r.id, p_attempt: r.attempt, p_error_code: 'unknown' });
    const { data } = await obcy.from('ksef_collective_identifiers').select('id').eq('id', r.id!);

    expect(done.data).toMatchObject({ status: 'refused', code: 'not_found' });
    expect(fail.data).toMatchObject({ status: 'refused', code: 'not_found' });
    expect(data).toEqual([]);
    expect(await wiersz(r.id!)).toMatchObject({ status: 'pending', identifier: null });
    // Ten sam zestaw w drugiej firmie to osobny wiersz tamtej firmy.
    expect((await rezerwuj(obcy)).data).toMatchObject({ status: 'claimed' });
  });

  it('sesja nie pisze do tabeli wprost i nie czyta żetonu próby', async () => {
    const c = await signedIn('owner');
    const r = (await rezerwuj(c)).data as Rezerwacja;

    const insert = await c.from('ksef_collective_identifiers').insert({
      tenant_id: ORG_A,
      ksef_environment: 'test',
      seller_nip: NIP_SPRZEDAWCY,
      ksef_numbers: [ksef(7), ksef(8)],
      invoices_key: 'x'.repeat(64),
      status: 'ready',
      attempt: r.attempt,
      identifier: WEKTOR,
    });
    const update = await c.from('ksef_collective_identifiers').update({ status: 'ready', identifier: WEKTOR }).eq('id', r.id!);
    const del = await c.from('ksef_collective_identifiers').delete().eq('id', r.id!);
    const zeton = await c.from('ksef_collective_identifiers').select('attempt').eq('id', r.id!);

    expect(insert.error?.code).toBe('42501');
    expect(update.error?.code).toBe('42501');
    expect(del.error?.code).toBe('42501');
    expect(zeton.error?.code).toBe('42501');
    expect(await wiersz(r.id!)).toMatchObject({ status: 'pending', identifier: null });
  });

  it.each([
    ['jedna faktura', { p_ksef_numbers: [ksef(1)] }, 'too_few'],
    ['powtórzony numer KSeF', { p_ksef_numbers: [ksef(1), ksef(1)] }, 'duplicate_number'],
    ['numer spoza wzorca KSeF', { p_ksef_numbers: [ksef(1), 'FV/2/11/2026'] }, 'invalid_number'],
    ['ponad 500 faktur', { p_ksef_numbers: Array.from({ length: 501 }, (_, i) => `${NIP_SPRZEDAWCY}-20261105-${String(i).padStart(12, '0')}-7A`) }, 'too_many'],
    ['NIP sprzedawcy spoza 10 cyfr', { p_seller_nip: 'PL1111111111' }, 'invalid_seller'],
    ['nieznane środowisko KSeF', { p_environment: 'prod' }, 'invalid_environment'],
  ])('%s: odmowa bez wiersza', async (_opis, pola, kod) => {
    const c = await signedIn('owner');

    const { data, error } = await rezerwuj(c, [ksef(1), ksef(2)], pola);

    expect(error).toBeNull();
    expect(data).toMatchObject({ status: 'refused', code: kod });
    const { count } = await admin.from('ksef_collective_identifiers').select('id', { count: 'exact', head: true }).eq('tenant_id', ORG_A);
    expect(count).toBe(0);
  });

  it('zapis identyfikatora spoza wzorca: odmowa, próba dalej czeka na wynik', async () => {
    const c = await signedIn('owner');
    const r = (await rezerwuj(c)).data as Rezerwacja;

    const done = await c.rpc('complete_ksef_collective_identifier', {
      p_id: r.id,
      p_attempt: r.attempt,
      p_identifier: '1111111111-20261105-0A1B2C3D4E01-7A',
    });

    expect(done.data).toMatchObject({ status: 'refused', code: 'invalid_identifier' });
    expect(await wiersz(r.id!)).toMatchObject({ status: 'pending', identifier: null });
  });

  it('gotowy identyfikator jest niezmienny (wyzwalacz), także dla klucza serwisowego', async () => {
    const c = await signedIn('owner');
    const r = (await rezerwuj(c)).data as Rezerwacja;
    await c.rpc('complete_ksef_collective_identifier', { p_id: r.id, p_attempt: r.attempt, p_identifier: WEKTOR });

    const zmiana = await admin
      .from('ksef_collective_identifiers')
      .update({ identifier: '1111111111-IZ202611-ABCDEF012345-1C' })
      .eq('id', r.id!);
    const powrot = await admin.from('ksef_collective_identifiers').update({ status: 'pending' }).eq('id', r.id!);

    expect(zmiana.error?.code).toBe('23514');
    expect(powrot.error?.code).toBe('23514');
    expect(await wiersz(r.id!)).toMatchObject({ status: 'ready', identifier: WEKTOR });
  });
});

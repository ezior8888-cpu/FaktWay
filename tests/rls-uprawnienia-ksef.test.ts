import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { getRlsTestEnvironment } from './helpers/rls-environment';
import { totpCode } from './helpers/totp';

/**
 * Uprawnienia biura rachunkowego w KSeF (00195, plan kompletnej aplikacji,
 * krok 6.2, część 4) na prawdziwym Postgresie i PostgREST:
 *  - `claim_ksef_permission_grant`: jeden wiersz na biuro w firmie i środowisku,
 *    nadane albo w toku nie dostaje drugiej próby, próba starsza niż 5 minut do
 *    przejęcia, odmowy złego NIP-u (wzorzec i suma kontrolna), NIP-u firmy, nazwy,
 *    zakresu; krok kodu (sesja AAL1 konta z 2FA dostaje `code_step_required`);
 *  - `claim_ksef_permission_revoke`: tylko nadane albo nieodebrane, środowisko wiersza;
 *  - `finish_ksef_permission_attempt`: tylko bieżąca próba (żeton), numery operacji
 *    w formacie KSeF, audyt w tej samej transakcji;
 *  - `record_ksef_permission_check`: tylko operacja w toku z tymi samymi numerami;
 *  - tylko właściciel (administrator, członek i księgowa: 42501, odczyt pusty),
 *    izolacja firm, brak zapisu sesji poza RPC, żeton próby niewidoczny,
 *    wyzwalacz przejść stanów także dla klucza serwisowego.
 */

const hasDatabase = Boolean(
  process.env.RLS_TEST_SUPABASE_URL?.trim() &&
    process.env.RLS_TEST_SUPABASE_ANON_KEY?.trim() &&
    process.env.RLS_TEST_SUPABASE_SERVICE_ROLE_KEY?.trim(),
);
const environment = hasDatabase ? getRlsTestEnvironment() : null;
const admin: SupabaseClient = environment
  ? createClient(environment.url, environment.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })
  : (null as unknown as SupabaseClient);

const ORG_A = '00195195-0000-4000-8000-00000000000a';
const ORG_B = '00195195-0000-4000-8000-00000000000b';
const RUN = Date.now().toString(36);
const EMAILS = {
  owner: 'rls-uprawnienia-ksef-owner@ksef-saas.test',
  admin: 'rls-uprawnienia-ksef-admin@ksef-saas.test',
  member: 'rls-uprawnienia-ksef-member@ksef-saas.test',
  accountant: 'rls-uprawnienia-ksef-ksiegowa@ksef-saas.test',
  obcy: 'rls-uprawnienia-ksef-obcy@ksef-saas.test',
  z2fa: `rls-uprawnienia-ksef-2fa-${RUN}@ksef-saas.test`,
} as const;
type Kto = keyof typeof EMAILS;
const PASS = 'RlsUprawnieniaKsef2026Aa!';
const NIP_FIRMY = '1234567890';
/** Fikcyjne NIP-y z poprawną sumą kontrolną. */
const NIP_BIURA = '1111111111';
const NIP_BIURA_2 = '2222222222';
const NAZWA = 'Biuro Rachunkowe Testowe sp. z o.o.';
const numer = (n: number) => `20261111-EG-${String(n).padStart(10, '0')}-0000000000-00`;

const users: Record<Kto, string> = { owner: '', admin: '', member: '', accountant: '', obcy: '', z2fa: '' };

interface Odpowiedz {
  status: string;
  id?: string;
  attempt?: string;
  code?: string;
  row_status?: string;
  scopes?: string[];
  subject_nip?: string;
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

async function nadaj(c: SupabaseClient, pola: Record<string, unknown> = {}) {
  return c.rpc('claim_ksef_permission_grant', {
    p_environment: 'test',
    p_subject_nip: NIP_BIURA,
    p_subject_name: NAZWA,
    p_scopes: ['InvoiceRead'],
    p_can_delegate: true,
    ...pola,
  });
}

async function zakoncz(c: SupabaseClient, r: Odpowiedz, status: string, pola: Record<string, unknown> = {}) {
  return c.rpc('finish_ksef_permission_attempt', {
    p_id: r.id,
    p_attempt: r.attempt,
    p_status: status,
    p_references: [],
    p_ksef_code: null,
    p_ksef_description: null,
    p_error_code: null,
    p_detail: null,
    ...pola,
  });
}

async function sprawdzenie(c: SupabaseClient, id: string, refs: string[], status: string, pola: Record<string, unknown> = {}) {
  return c.rpc('record_ksef_permission_check', {
    p_id: id,
    p_references: refs,
    p_status: status,
    p_ksef_code: null,
    p_ksef_description: null,
    p_error_code: null,
    ...pola,
  });
}

async function wiersz(id: string) {
  const { data, error } = await admin.from('ksef_permission_grants').select('*').eq('id', id).single();
  if (error) throw error;
  return data as Record<string, unknown>;
}

async function audyt(id: string) {
  const { data, error } = await admin
    .from('audit_logs')
    .select('tenant_id, user_id, action, entity_type, entity_id, metadata')
    .eq('entity_id', id)
    .like('action', 'accountant.ksef_permission_%')
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

/** Nadane uprawnienie: rezerwacja, numer operacji, status 200. */
async function nadane(c: SupabaseClient, pola: Record<string, unknown> = {}): Promise<string> {
  const r = (await nadaj(c, pola)).data as Odpowiedz;
  expect(r.status).toBe('claimed');
  const wyslane = await zakoncz(c, r, 'grant_in_progress', { p_references: [numer(1)], p_ksef_code: 100 });
  expect(wyslane.data).toMatchObject({ status: 'saved', row_status: 'grant_in_progress' });
  const wynik = await sprawdzenie(c, r.id!, [numer(1)], 'granted', { p_ksef_code: 200, p_ksef_description: 'Operacja zakończona sukcesem' });
  expect(wynik.data).toMatchObject({ status: 'saved', row_status: 'granted' });
  return r.id!;
}

async function cleanup() {
  await admin.from('ksef_permission_grants').delete().in('tenant_id', [ORG_A, ORG_B]);
}

describe.skipIf(!hasDatabase)('uprawnienia biura rachunkowego w KSeF (00195)', () => {
  beforeAll(async () => {
    for (const who of Object.keys(EMAILS) as Kto[]) users[who] = await userId(EMAILS[who]);
    await cleanup();
    await admin.from('memberships').delete().in('organization_id', [ORG_A, ORG_B]);
    // Wpisy audytu zostają po przebiegu (00052), więc firma też: upsert zamiast kasowania.
    const tenants = await admin.from('tenants').upsert(
      [
        { id: ORG_A, nip: NIP_FIRMY, name: 'Firma A Uprawnienia KSeF' },
        { id: ORG_B, nip: NIP_BIURA_2, name: 'Firma B Uprawnienia KSeF' },
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
      { organization_id: ORG_A, user_id: users.z2fa, role: 'owner', status: 'active' },
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
    // Właściciel z 2FA ma czynnik TOTP: konto tylko na ten przebieg.
    if (users.z2fa) await admin.auth.admin.deleteUser(users.z2fa);
  });

  it('właściciel: rezerwacja, numer operacji, nadane, z audytem; drugie „Nadaj” nie daje nowej próby', async () => {
    const c = await signedIn('owner');
    const id = await nadane(c);

    const drugie = await nadaj(c, { p_scopes: ['InvoiceRead', 'InvoiceWrite'] });

    expect(drugie.error).toBeNull();
    expect(drugie.data).toMatchObject({ status: 'already_granted', id, scopes: ['InvoiceRead'] });
    expect(await wiersz(id)).toMatchObject({
      tenant_id: ORG_A,
      ksef_environment: 'test',
      subject_nip: NIP_BIURA,
      subject_name: NAZWA,
      scopes: ['InvoiceRead'],
      can_delegate: true,
      status: 'granted',
      operation_references: [numer(1)],
      ksef_status_code: 200,
      requested_by: users.owner,
    });
    expect((await wiersz(id)).granted_at).not.toBeNull();
    const wpisy = await audyt(id);
    expect(wpisy.map((w) => w.action)).toEqual(['accountant.ksef_permission_grant_sent', 'accountant.ksef_permission_granted']);
    expect(wpisy[0]).toMatchObject({
      tenant_id: ORG_A,
      user_id: users.owner,
      entity_type: 'ksef_permission_grant',
      metadata: expect.objectContaining({ subjectNip: NIP_BIURA, scopes: ['InvoiceRead'], references: [numer(1)], environment: 'test' }),
    });
  });

  it('nadanie w toku w KSeF: kolejne „Nadaj” to „awaiting_ksef”', async () => {
    const c = await signedIn('owner');
    const r = (await nadaj(c)).data as Odpowiedz;
    await zakoncz(c, r, 'grant_in_progress', { p_references: [numer(1)] });

    expect((await nadaj(c)).data).toMatchObject({ status: 'awaiting_ksef', id: r.id });
  });

  it('dwie rezerwacje naraz: jedna próba, druga „w toku”', async () => {
    const c = await signedIn('owner');

    const wyniki = await Promise.all([nadaj(c), nadaj(c)]);

    expect(wyniki.map((w) => (w.data as Odpowiedz).status).sort()).toEqual(['claimed', 'in_progress']);
  });

  it('próba przerwana ponad 5 minut temu: przejęcie z nowym żetonem; stara próba niczego nie zapisze', async () => {
    const c = await signedIn('owner');
    const r1 = (await nadaj(c)).data as Odpowiedz;
    const stary = await admin
      .from('ksef_permission_grants')
      .update({ claimed_at: new Date(Date.now() - 6 * 60_000).toISOString() })
      .eq('id', r1.id!);
    expect(stary.error).toBeNull();

    const r2 = (await nadaj(c, { p_scopes: ['InvoiceRead', 'InvoiceWrite'] })).data as Odpowiedz;

    expect(r2).toMatchObject({ status: 'claimed', id: r1.id });
    expect(r2.attempt).not.toBe(r1.attempt);
    expect((await zakoncz(c, r1, 'grant_in_progress', { p_references: [numer(1)] })).data).toMatchObject({ status: 'refused', code: 'stale_attempt' });
    expect(await wiersz(r1.id!)).toMatchObject({ status: 'grant_pending', scopes: ['InvoiceRead', 'InvoiceWrite'] });
  });

  it('porażka: „grant_failed” z kodem i audytem; kolejna rezerwacja to nowa próba z nowym zakresem', async () => {
    const c = await signedIn('owner');
    const r1 = (await nadaj(c)).data as Odpowiedz;

    const fail = await zakoncz(c, r1, 'grant_failed', { p_error_code: 'http_403' });
    expect(fail.data).toMatchObject({ status: 'saved', row_status: 'grant_failed' });
    expect(await wiersz(r1.id!)).toMatchObject({ status: 'grant_failed', error_code: 'http_403' });

    const r2 = (await nadaj(c, { p_scopes: ['InvoiceWrite', 'InvoiceRead'], p_can_delegate: false })).data as Odpowiedz;
    expect(r2).toMatchObject({ status: 'claimed', id: r1.id });
    expect(await wiersz(r1.id!)).toMatchObject({ status: 'grant_pending', scopes: ['InvoiceRead', 'InvoiceWrite'], can_delegate: false, error_code: null });
    expect((await audyt(r1.id!)).map((w) => w.action)).toEqual(['accountant.ksef_permission_grant_failed']);
  });

  it('porażka bez kodu błędu dostaje „unknown”', async () => {
    const c = await signedIn('owner');
    const r = (await nadaj(c)).data as Odpowiedz;

    await zakoncz(c, r, 'grant_failed', { p_error_code: 'NIE WOLNO' });

    expect(await wiersz(r.id!)).toMatchObject({ status: 'grant_failed', error_code: 'unknown' });
  });

  it('odebranie: rezerwacja, numery operacji, odebrane z audytem; potem nowe nadanie', async () => {
    const c = await signedIn('owner');
    const id = await nadane(c);

    const r = (await c.rpc('claim_ksef_permission_revoke', { p_id: id, p_environment: 'test' })).data as Odpowiedz;
    expect(r).toMatchObject({ status: 'claimed', id, subject_nip: NIP_BIURA, scopes: ['InvoiceRead'] });
    expect((await nadaj(c)).data).toMatchObject({ status: 'revoke_in_progress' });

    const wyslane = await zakoncz(c, r, 'revoke_in_progress', { p_references: [numer(2), numer(3)] });
    expect(wyslane.data).toMatchObject({ status: 'saved', row_status: 'revoke_in_progress' });
    const koniec = await sprawdzenie(c, id, [numer(2), numer(3)], 'revoked', { p_ksef_code: 200 });
    expect(koniec.data).toMatchObject({ status: 'saved', row_status: 'revoked' });
    expect((await c.rpc('claim_ksef_permission_revoke', { p_id: id, p_environment: 'test' })).data).toMatchObject({ status: 'already_revoked' });
    expect((await wiersz(id)).revoked_at).not.toBeNull();
    expect((await audyt(id)).map((w) => w.action)).toEqual([
      'accountant.ksef_permission_grant_sent',
      'accountant.ksef_permission_granted',
      'accountant.ksef_permission_revoke_sent',
      'accountant.ksef_permission_revoked',
    ]);

    expect((await nadaj(c)).data).toMatchObject({ status: 'claimed', id });
  });

  it('odebranie bez aktywnego uprawnienia w KSeF: „revoked” bez numerów, z uwagą w kodzie', async () => {
    const c = await signedIn('owner');
    const id = await nadane(c);
    const r = (await c.rpc('claim_ksef_permission_revoke', { p_id: id, p_environment: 'test' })).data as Odpowiedz;

    const zapis = await zakoncz(c, r, 'revoked', { p_error_code: 'not_found_in_ksef' });

    expect(zapis.data).toMatchObject({ status: 'saved', row_status: 'revoked' });
    expect(await wiersz(id)).toMatchObject({ status: 'revoked', error_code: 'not_found_in_ksef', operation_references: [] });
  });

  it('odebranie: nienadane, w toku i inne środowisko KSeF odmawiają', async () => {
    const c = await signedIn('owner');
    const r = (await nadaj(c)).data as Odpowiedz;

    expect((await c.rpc('claim_ksef_permission_revoke', { p_id: r.id, p_environment: 'test' })).data).toMatchObject({
      status: 'not_granted',
      row_status: 'grant_pending',
    });
    await zakoncz(c, r, 'grant_failed', { p_error_code: 'http_403' });
    expect((await c.rpc('claim_ksef_permission_revoke', { p_id: r.id, p_environment: 'test' })).data).toMatchObject({ status: 'not_granted' });

    const id = await nadane(c, { p_subject_nip: NIP_BIURA_2 });
    expect((await c.rpc('claim_ksef_permission_revoke', { p_id: id, p_environment: 'production' })).data).toMatchObject({
      status: 'refused',
      code: 'env_mismatch',
    });
  });

  it('sprawdzenie: tylko operacja w toku z tymi samymi numerami', async () => {
    const c = await signedIn('owner');
    const r = (await nadaj(c)).data as Odpowiedz;
    expect((await sprawdzenie(c, r.id!, [], 'granted')).data).toMatchObject({ status: 'refused', code: 'not_in_progress' });
    await zakoncz(c, r, 'grant_in_progress', { p_references: [numer(1)] });

    expect((await sprawdzenie(c, r.id!, [numer(9)], 'granted')).data).toMatchObject({ status: 'refused', code: 'stale_check' });
    expect((await sprawdzenie(c, r.id!, [numer(1)], 'revoked')).data).toMatchObject({ status: 'refused', code: 'invalid_status' });
    expect((await sprawdzenie(c, r.id!, [numer(1)], 'grant_in_progress', { p_ksef_code: 100 })).data).toMatchObject({
      status: 'saved',
      row_status: 'grant_in_progress',
    });
    expect((await audyt(r.id!)).map((w) => w.action)).toEqual(['accountant.ksef_permission_grant_sent']);
    expect((await sprawdzenie(c, r.id!, [numer(1)], 'grant_failed', { p_ksef_code: 420, p_error_code: 'status_420' })).data).toMatchObject({
      status: 'saved',
      row_status: 'grant_failed',
    });
    expect(await wiersz(r.id!)).toMatchObject({ status: 'grant_failed', ksef_status_code: 420, error_code: 'status_420' });
  });

  it.each([
    ['w toku bez numeru operacji', 'grant_in_progress', []],
    ['w toku z dwoma numerami', 'grant_in_progress', [numer(1), numer(2)]],
    ['numer spoza formatu KSeF', 'grant_in_progress', ['20261111-EG-1']],
    ['numer ze znakiem spoza wzorca', 'grant_in_progress', ['20261111-EG-0000000001-0000000000/00']],
  ])('zapis wyniku: %s, odmowa, próba czeka dalej', async (_opis, status, refs) => {
    const c = await signedIn('owner');
    const r = (await nadaj(c)).data as Odpowiedz;

    const zapis = await zakoncz(c, r, status, { p_references: refs });

    expect(zapis.data).toMatchObject({ status: 'refused', code: 'invalid_reference' });
    expect(await wiersz(r.id!)).toMatchObject({ status: 'grant_pending' });
  });

  it('zapis wyniku: stan spoza próby (odebranie przy nadaniu) odmawia', async () => {
    const c = await signedIn('owner');
    const r = (await nadaj(c)).data as Odpowiedz;

    expect((await zakoncz(c, r, 'revoked')).data).toMatchObject({ status: 'refused', code: 'invalid_status' });
  });

  it.each([
    ['NIP z błędną sumą kontrolną (fikcyjny NIP repo)', { p_subject_nip: NIP_FIRMY }, 'invalid_nip'],
    ['NIP z zerem na początku', { p_subject_nip: '0111111111' }, 'invalid_nip'],
    ['NIP z prefiksem', { p_subject_nip: 'PL1111111111' }, 'invalid_nip'],
    ['NIP własnej firmy', { p_subject_nip: NIP_BIURA_2 }, 'own_nip'],
    ['nazwa krótsza niż 5 znaków', { p_subject_name: ' Abc ' }, 'invalid_name'],
    ['nazwa dłuższa niż 90 znaków', { p_subject_name: 'B'.repeat(91) }, 'invalid_name'],
    ['samo wystawianie', { p_scopes: ['InvoiceWrite'] }, 'invalid_scopes'],
    ['uprawnienie spoza zakresu', { p_scopes: ['InvoiceRead', 'CredentialsManage'] }, 'invalid_scopes'],
    ['powtórzone uprawnienie', { p_scopes: ['InvoiceRead', 'InvoiceRead'] }, 'invalid_scopes'],
    ['brak decyzji o przekazaniu', { p_can_delegate: null }, 'invalid_delegate'],
    ['nieznane środowisko KSeF', { p_environment: 'prod' }, 'invalid_environment'],
  ])('%s: odmowa bez wiersza', async (_opis, pola, kod) => {
    // Firma B ma NIP 2222222222 (poprawna suma kontrolna), więc tu sprawdzamy odmowę własnego NIP-u.
    const c = await signedIn('obcy', ORG_B);

    const { data, error } = await nadaj(c, pola);

    expect(error).toBeNull();
    expect(data).toMatchObject({ status: 'refused', code: kod });
    const { count } = await admin.from('ksef_permission_grants').select('id', { count: 'exact', head: true }).eq('tenant_id', ORG_B);
    expect(count).toBe(0);
  });

  it('nazwa z wieloma spacjami zapisuje się znormalizowana', async () => {
    const c = await signedIn('owner');
    const r = (await nadaj(c, { p_subject_name: `  ${NAZWA.replace(/ /g, '   ')}  ` })).data as Odpowiedz;

    expect(await wiersz(r.id!)).toMatchObject({ subject_name: NAZWA });
  });

  it('administrator, członek i księgowa: 42501 przy każdej funkcji, odczyt pusty', async () => {
    const o = await signedIn('owner');
    const id = await nadane(o);

    for (const who of ['admin', 'member', 'accountant'] as const) {
      const c = await signedIn(who);
      expect((await nadaj(c, { p_subject_nip: NIP_BIURA_2 })).error?.code, who).toBe('42501');
      expect((await c.rpc('claim_ksef_permission_revoke', { p_id: id, p_environment: 'test' })).error?.code, who).toBe('42501');
      expect((await zakoncz(c, { status: 'claimed', id, attempt: '00195195-aaaa-4000-8000-000000000001' }, 'granted')).error?.code, who).toBe('42501');
      expect((await sprawdzenie(c, id, [numer(1)], 'granted')).error?.code, who).toBe('42501');
      const { data, error } = await c.from('ksef_permission_grants').select('id').eq('id', id);
      expect(error, who).toBeNull();
      expect(data, who).toEqual([]);
    }
    expect(await wiersz(id)).toMatchObject({ status: 'granted' });
  });

  it('obca firma: nie widzi wiersza i nie zmienia go żadną funkcją', async () => {
    const c = await signedIn('owner');
    const r = (await nadaj(c)).data as Odpowiedz;
    const obcy = await signedIn('obcy', ORG_B);

    expect((await zakoncz(obcy, r, 'grant_in_progress', { p_references: [numer(1)] })).data).toMatchObject({ status: 'refused', code: 'not_found' });
    expect((await sprawdzenie(obcy, r.id!, [], 'granted')).data).toMatchObject({ status: 'refused', code: 'not_found' });
    expect((await obcy.rpc('claim_ksef_permission_revoke', { p_id: r.id, p_environment: 'test' })).data).toMatchObject({
      status: 'refused',
      code: 'not_found',
    });
    const { data } = await obcy.from('ksef_permission_grants').select('id').eq('id', r.id!);
    expect(data).toEqual([]);
    expect(await wiersz(r.id!)).toMatchObject({ status: 'grant_pending' });
    // To samo biuro w drugiej firmie to osobny wiersz tamtej firmy.
    expect((await nadaj(obcy)).data).toMatchObject({ status: 'claimed' });
  });

  it('sesja nie pisze do tabeli wprost i nie czyta żetonu próby', async () => {
    const c = await signedIn('owner');
    const r = (await nadaj(c)).data as Odpowiedz;

    const insert = await c.from('ksef_permission_grants').insert({
      tenant_id: ORG_A,
      ksef_environment: 'test',
      subject_nip: NIP_BIURA_2,
      subject_name: NAZWA,
      scopes: ['InvoiceRead'],
      can_delegate: true,
      status: 'granted',
      attempt: r.attempt,
      operation_references: [],
    });
    const update = await c.from('ksef_permission_grants').update({ status: 'granted' }).eq('id', r.id!);
    const del = await c.from('ksef_permission_grants').delete().eq('id', r.id!);
    const zeton = await c.from('ksef_permission_grants').select('attempt').eq('id', r.id!);

    expect(insert.error?.code).toBe('42501');
    expect(update.error?.code).toBe('42501');
    expect(del.error?.code).toBe('42501');
    expect(zeton.error?.code).toBe('42501');
    expect(await wiersz(r.id!)).toMatchObject({ status: 'grant_pending' });
  });

  it('wyzwalacz: przejścia stanów, niezmienny NIP i zakres poza nową próbą, także dla klucza serwisowego', async () => {
    const c = await signedIn('owner');
    const id = await nadane(c);

    const skok = await admin.from('ksef_permission_grants').update({ status: 'grant_in_progress' }).eq('id', id);
    const nip = await admin.from('ksef_permission_grants').update({ subject_nip: NIP_BIURA_2 }).eq('id', id);
    const zakres = await admin.from('ksef_permission_grants').update({ scopes: ['InvoiceRead', 'InvoiceWrite'] }).eq('id', id);
    const srodowisko = await admin.from('ksef_permission_grants').update({ ksef_environment: 'production' }).eq('id', id);

    for (const zmiana of [skok, nip, zakres, srodowisko]) expect(zmiana.error?.code).toBe('23514');
    expect(await wiersz(id)).toMatchObject({ status: 'granted', subject_nip: NIP_BIURA, scopes: ['InvoiceRead'], ksef_environment: 'test' });
    // Ścieżka operatora: usunięcie wiersza kluczem serwisowym; klient zacznie od nowa.
    expect((await admin.from('ksef_permission_grants').delete().eq('id', id)).error).toBeNull();
    expect((await nadaj(c)).data).toMatchObject({ status: 'claimed' });
  });

  describe('krok kodu (00163): nadanie dostępu osobie trzeciej', () => {
    let bezKodu: SupabaseClient;
    let zKodem: SupabaseClient;

    beforeAll(async () => {
      zKodem = await signedIn('z2fa');
      const enroll = await zKodem.auth.mfa.enroll({ factorType: 'totp' });
      if (enroll.error || !enroll.data) throw enroll.error ?? new Error('enroll');
      const verified = await zKodem.auth.mfa.challengeAndVerify({ factorId: enroll.data.id, code: totpCode(enroll.data.totp.secret) });
      if (verified.error) throw verified.error;
      bezKodu = await signedIn('z2fa');
    });

    it('sesja bez kodu na koncie z 2FA: code_step_required, bez wiersza', async () => {
      const { error } = await nadaj(bezKodu);

      expect(error?.code).toBe('42501');
      expect(error?.message).toContain('code_step_required');
      const { count } = await admin.from('ksef_permission_grants').select('id', { count: 'exact', head: true }).eq('tenant_id', ORG_A);
      expect(count).toBe(0);
    });

    it('z kodem nadanie działa; odebranie kodu nie wymaga', async () => {
      const id = await nadane(zKodem);

      const odebranie = await bezKodu.rpc('claim_ksef_permission_revoke', { p_id: id, p_environment: 'test' });

      expect(odebranie.error).toBeNull();
      expect(odebranie.data).toMatchObject({ status: 'claimed' });
    });
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { getRlsTestEnvironment } from './helpers/rls-environment';

/**
 * 00192 na prawdziwej bazie: komentarze i prośby o dokument przy koszcie
 * (plan kompletnej aplikacji, krok 6.2, część 3), z wpisem w dzwonku (00188).
 *
 * Wątek widzi i pisze każdy, kto widzi koszt (aktywny członek aktywnej firmy,
 * role owner, admin, member, accountant). Zapis tylko przez dwie funkcje:
 * `expense_comment_add` (komentarz albo prośba i w tej samej transakcji wpis
 * w dzwonku pozostałych członków, bez autora; klucz: identyfikator komentarza)
 * i `expense_document_request_resolve` (kto i kiedy załatwił prośbę). Prośba
 * i jej załatwienie mają wiersz w `audit_logs`.
 *
 * `audit_logs` jest tylko do dopisywania (00052): wpisy z wcześniejszych
 * przebiegów zostają, a firma z wpisami audytu nie da się usunąć, więc firmy
 * są wstawiane przez upsert, a testy audytu porównują stan przed i po.
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

const ORG = '00192192-0000-4000-8000-000000000001';
const OTHER_ORG = '00192192-0000-4000-8000-000000000002';
const EXPENSE = '00192192-0000-4000-8000-0000000000e1';
const OTHER_EXPENSE = '00192192-0000-4000-8000-0000000000e2';
const COMMENT = '00192192-0000-4000-8000-0000000000c1';
const REQUEST = '00192192-0000-4000-8000-0000000000c2';
const LONG = '00192192-0000-4000-8000-0000000000c3';
const NO_NUMBER = '00192192-0000-4000-8000-0000000000c4';
const MISMATCHED = '00192192-0000-4000-8000-0000000000c9';
const PASS = 'RlsKomentarzePass2026Aa!';
const EMAILS = {
  owner: 'rls-komentarze-owner@ksef-saas.test',
  member: 'rls-komentarze-member@ksef-saas.test',
  accountant: 'rls-komentarze-accountant@ksef-saas.test',
  suspended: 'rls-komentarze-suspended@ksef-saas.test',
  other: 'rls-komentarze-other@ksef-saas.test',
} as const;
type Who = keyof typeof EMAILS;
const NAMES: Record<Who, string> = {
  owner: 'Olga Właścicielka',
  member: 'Marek Członek',
  accountant: 'Anna Księgowa',
  suspended: 'Zenon Zawieszony',
  other: 'Oskar Obcy',
};
const ids = {} as Record<Who, string>;
const AUDIT_ACTIONS = ['expense.document_requested', 'expense.document_request_resolved'];
const COMMENT_BODY = 'Czy to koszt firmowy?\n\nPytam o fakturę.';
const LINK = `/expenses/${EXPENSE}#komentarze`;
const LABEL = 'przy koszcie FV 7/2026 od Dostawca Testowy sp. z o.o.';

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

async function signedIn(who: Who, org?: string): Promise<SupabaseClient> {
  const client = anonClient(org);
  const { error } = await client.auth.signInWithPassword({ email: EMAILS[who], password: PASS });
  if (error) throw error;
  return client;
}

/** Wątek firmy widziany kluczem serwisowym (bez RLS). */
async function watek(org: string) {
  const { data, error } = await admin
    .from('expense_comments')
    .select('id, tenant_id, expense_id, author_id, author_role, kind, body, created_at, resolved_at, resolved_by')
    .eq('tenant_id', org)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

async function wpisyDzwonka(objectKey: string) {
  const { data, error } = await admin
    .from('app_notifications')
    .select('tenant_id, user_id, kind, object_key, title, body, link, read_at')
    .eq('object_key', objectKey)
    .order('user_id', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

async function audyt() {
  const { data, error } = await admin
    .from('audit_logs')
    .select('tenant_id, user_id, action, entity_type, entity_id, metadata, created_at')
    .in('entity_id', [EXPENSE, OTHER_EXPENSE])
    .in('action', AUDIT_ACTIONS)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

async function nowyAudyt(wywolanie: () => Promise<void>) {
  const przed = (await audyt()).length;
  await wywolanie();
  return (await audyt()).slice(przed);
}

async function sprzataj() {
  for (const org of [ORG, OTHER_ORG]) {
    await admin.from('app_notifications').delete().eq('tenant_id', org);
    await admin.from('expense_comments').delete().eq('tenant_id', org);
    await admin.from('expenses').delete().eq('tenant_id', org);
    await admin.from('memberships').delete().eq('organization_id', org);
  }
}

describe.skipIf(!hasDatabase)('00192: komentarze i prośby o dokument przy koszcie na prawdziwym PostgREST', () => {
  beforeAll(async () => {
    for (const who of Object.keys(EMAILS) as Who[]) ids[who] = await userId(EMAILS[who]);
    await sprzataj();
    const tenants = await admin.from('tenants').upsert(
      [
        { id: ORG, nip: '9480000156', name: 'Firma Komentarze 00192' },
        { id: OTHER_ORG, nip: '9480000162', name: 'Inna firma 00192' },
      ],
      { onConflict: 'id' },
    );
    if (tenants.error) throw tenants.error;
    const profiles = await admin.from('users').upsert(
      (Object.keys(ids) as Who[]).map((who) => ({ id: ids[who], name: NAMES[who] })),
      { onConflict: 'id' },
    );
    if (profiles.error) throw profiles.error;
    // Wszystkie wiersze z tymi samymi kluczami: masowy insert PostgREST wpisuje NULL w brakujące kolumny.
    const members = await admin.from('memberships').insert([
      { organization_id: ORG, user_id: ids.owner, role: 'owner', status: 'active' },
      { organization_id: ORG, user_id: ids.member, role: 'member', status: 'active' },
      { organization_id: ORG, user_id: ids.accountant, role: 'accountant', status: 'active' },
      { organization_id: ORG, user_id: ids.suspended, role: 'member', status: 'suspended' },
      { organization_id: OTHER_ORG, user_id: ids.other, role: 'owner', status: 'active' },
      // Księgowa obsługuje też drugą firmę: wątek i dzwonek tylko w aktywnej.
      { organization_id: OTHER_ORG, user_id: ids.accountant, role: 'accountant', status: 'active' },
    ]);
    if (members.error) throw members.error;
    const expenses = await admin.from('expenses').insert([
      {
        id: EXPENSE, tenant_id: ORG, created_by: ids.owner, source: 'manual', seller_name: 'Dostawca Testowy sp. z o.o.',
        document_number: 'FV 7/2026', issue_date: '2026-11-02', net_amount: 100, gross_amount: 123,
      },
      {
        // Koszt bez numeru i bez nazwy sprzedawcy (skrzynka KSeF zapisuje wtedy „Nieznany”).
        id: OTHER_EXPENSE, tenant_id: OTHER_ORG, created_by: ids.other, source: 'manual', seller_name: 'Nieznany',
        document_number: null, issue_date: '2026-11-03', net_amount: 10, gross_amount: 12.3,
      },
    ]);
    if (expenses.error) throw expenses.error;
  });

  afterAll(async () => {
    if (!hasDatabase) return;
    await sprzataj();
  });

  it('komentarz: wpis w wątku i w dzwonku pozostałych aktywnych członków, bez autora; ponowienie z tym samym identyfikatorem bez dubla', async () => {
    const owner = await signedIn('owner', ORG);
    const args = { p_expense_id: EXPENSE, p_kind: 'comment', p_body: `  ${COMMENT_BODY}  \n`, p_comment_id: COMMENT };
    const audytPrzed = (await audyt()).length;

    const pierwszy = await owner.rpc('expense_comment_add', args);
    expect(pierwszy.error).toBeNull();
    expect(pierwszy.data).toEqual({ status: 'created', comment_id: COMMENT, expense_id: EXPENSE, kind: 'comment', notified: 2 });

    const wpisy = await watek(ORG);
    expect(wpisy).toHaveLength(1);
    expect(wpisy[0]).toMatchObject({
      id: COMMENT,
      expense_id: EXPENSE,
      author_id: ids.owner,
      author_role: 'owner',
      kind: 'comment',
      body: COMMENT_BODY,
      resolved_at: null,
      resolved_by: null,
    });

    const dzwonek = await wpisyDzwonka(COMMENT);
    expect(dzwonek.map((w) => w.user_id).sort()).toEqual([ids.member, ids.accountant].sort());
    for (const w of dzwonek) {
      expect(w).toEqual({
        tenant_id: ORG,
        user_id: w.user_id,
        kind: 'expense_comment',
        object_key: COMMENT,
        title: 'Nowy komentarz do kosztu',
        body: `Olga Właścicielka (właściciel) ${LABEL}: Czy to koszt firmowy? Pytam o fakturę.`,
        link: LINK,
        read_at: null,
      });
    }

    // Ponowienie (drugie kliknięcie po zerwanym połączeniu): ten sam identyfikator i ta sama treść.
    const ponowienie = await owner.rpc('expense_comment_add', args);
    expect(ponowienie.error).toBeNull();
    expect(ponowienie.data).toEqual({ status: 'exists', comment_id: COMMENT, expense_id: EXPENSE, kind: 'comment', notified: 0 });
    expect(await watek(ORG)).toHaveLength(1);
    expect(await wpisyDzwonka(COMMENT)).toHaveLength(2);
    // Audyt dotyczy próśb o dokument, nie komentarzy.
    expect((await audyt()).length).toBe(audytPrzed);
  });

  it('prośba o dokument: dzwonek pozostałych bez autora, audyt bez treści; pisze każda rola z dostępem do kosztów', async () => {
    const ksiegowa = await signedIn('accountant', ORG);
    const nowe = await nowyAudyt(async () => {
      const r = await ksiegowa.rpc('expense_comment_add', {
        p_expense_id: EXPENSE,
        p_kind: 'document_request',
        p_body: 'Proszę o fakturę zamiast paragonu.',
        p_comment_id: REQUEST,
      });
      expect(r.error).toBeNull();
      expect(r.data).toMatchObject({ status: 'created', comment_id: REQUEST, kind: 'document_request', notified: 2 });
    });
    expect(nowe).toHaveLength(1);
    expect(nowe[0]).toMatchObject({
      tenant_id: ORG,
      user_id: ids.accountant,
      action: 'expense.document_requested',
      entity_type: 'expense',
      entity_id: EXPENSE,
    });
    // Bez treści prośby w audycie: identyfikator wpisu, rola i liczba powiadomionych.
    expect(nowe[0]!.metadata).toEqual({ commentId: REQUEST, role: 'accountant', notified: 2 });

    const dzwonek = await wpisyDzwonka(REQUEST);
    expect(dzwonek.map((w) => w.user_id).sort()).toEqual([ids.owner, ids.member].sort());
    expect(dzwonek[0]).toMatchObject({
      tenant_id: ORG,
      kind: 'expense_document_request',
      title: 'Prośba o dokument do kosztu',
      body: `Anna Księgowa (księgowy) ${LABEL}: Proszę o fakturę zamiast paragonu.`,
      link: LINK,
    });
    expect((await watek(ORG)).find((w) => w.id === REQUEST)).toMatchObject({ kind: 'document_request', resolved_at: null });

    // Członek zespołu też pisze; bez identyfikatora z przeglądarki baza nadaje własny.
    const czlonek = await signedIn('member', ORG);
    const bezId = await czlonek.rpc('expense_comment_add', { p_expense_id: EXPENSE, p_kind: 'comment', p_body: 'Dołączę zdjęcie.' });
    expect(bezId.error).toBeNull();
    expect(bezId.data).toMatchObject({ status: 'created', kind: 'comment', notified: 2 });
    const bezIdWpisy = await wpisyDzwonka((bezId.data as { comment_id: string }).comment_id);
    expect(bezIdWpisy.map((w) => w.user_id).sort()).toEqual([ids.owner, ids.accountant].sort());
  });

  it('odczyt: członkowie firmy widzą wątek kosztu; zawieszony, obcy z nagłówkiem firmy, druga firma tej samej osoby i anon nic', async () => {
    const czlonek = await signedIn('member', ORG);
    const widzi = await czlonek
      .from('expense_comments')
      .select('id, kind, author_role, body')
      .eq('expense_id', EXPENSE)
      .order('created_at', { ascending: true });
    expect(widzi.error).toBeNull();
    expect(widzi.data).toHaveLength(3);
    expect(widzi.data!.slice(0, 2).map((w) => w.id)).toEqual([COMMENT, REQUEST]);

    for (const [who, org] of [['suspended', ORG], ['other', ORG], ['accountant', OTHER_ORG]] as const) {
      const klient = await signedIn(who, org);
      const odczyt = await klient.from('expense_comments').select('id').eq('tenant_id', ORG);
      expect(odczyt.data ?? [], `${who} z nagłówkiem ${org}`).toEqual([]);
    }
    const bezFirmy = await signedIn('owner');
    expect((await bezFirmy.from('expense_comments').select('id')).data ?? []).toEqual([]);
    const anon = await anonClient(ORG).from('expense_comments').select('id');
    expect(anon.error?.code === '42501' || (anon.data ?? []).length === 0).toBe(true);

    // Wiersz, którego koszt należy do innej firmy (np. błąd skryptu serwisowego), nie wychodzi w żadnej z nich.
    const wstaw = await admin.from('expense_comments').insert({
      id: MISMATCHED, tenant_id: ORG, expense_id: OTHER_EXPENSE, author_id: ids.owner, author_role: 'owner', kind: 'comment', body: 'Koszt innej firmy',
    });
    expect(wstaw.error).toBeNull();
    const owner = await signedIn('owner', ORG);
    expect((await owner.from('expense_comments').select('id').eq('id', MISMATCHED)).data).toEqual([]);
    const obcy = await signedIn('other', OTHER_ORG);
    expect((await obcy.from('expense_comments').select('id').eq('id', MISMATCHED)).data).toEqual([]);
    await admin.from('expense_comments').delete().eq('id', MISMATCHED);
  });

  it('zapis tylko przez funkcje: bez INSERT, UPDATE i DELETE kluczem użytkownika; obca firma, zawieszony, bez sesji i cudzy identyfikator odmowa', async () => {
    const owner = await signedIn('owner', ORG);
    const dopisz = await owner.from('expense_comments').insert({
      tenant_id: ORG, expense_id: EXPENSE, author_id: ids.owner, author_role: 'owner', kind: 'comment', body: 'Z przeglądarki',
    });
    expect(dopisz.error?.code).toBe('42501');
    const zmien = await owner
      .from('expense_comments')
      .update({ resolved_at: new Date().toISOString(), resolved_by: ids.owner })
      .eq('id', REQUEST)
      .select('id');
    expect(zmien.error?.code).toBe('42501');
    const usun = await owner.from('expense_comments').delete().eq('id', COMMENT).select('id');
    expect(usun.error?.code).toBe('42501');
    // Wpisu w dzwonku też nie dopisze sam.
    const dzwonek = await owner.from('app_notifications').insert({
      tenant_id: ORG, user_id: ids.member, kind: 'expense_comment', object_key: 'z-przegladarki', title: 'Fałszywy wpis',
    });
    expect(dzwonek.error?.code).toBe('42501');

    const wpis = { p_expense_id: EXPENSE, p_kind: 'comment', p_body: 'Obcy wpis' };
    // Koszt innej firmy przy nagłówku własnej firmy wygląda jak brak kosztu.
    const obcy = await signedIn('other', OTHER_ORG);
    expect((await obcy.rpc('expense_comment_add', wpis)).data).toEqual({ status: 'refused', code: 'not_found' });
    // Nagłówek cudzej firmy bez członkostwa, zawieszone członkostwo, brak sesji, klucz serwisowy (bez auth.uid()).
    const obcyZNaglowkiem = await signedIn('other', ORG);
    expect((await obcyZNaglowkiem.rpc('expense_comment_add', wpis)).error?.code).toBe('42501');
    const zawieszony = await signedIn('suspended', ORG);
    expect((await zawieszony.rpc('expense_comment_add', wpis)).error?.code).toBe('42501');
    expect((await anonClient(ORG).rpc('expense_comment_add', wpis)).error).not.toBeNull();
    expect((await admin.rpc('expense_comment_add', wpis)).error).not.toBeNull();

    // Cudzy identyfikator albo inna treść pod tym samym identyfikatorem: odmowa, wpis bez zmian.
    const czlonek = await signedIn('member', ORG);
    const cudzy = await czlonek.rpc('expense_comment_add', { ...wpis, p_body: COMMENT_BODY, p_comment_id: COMMENT });
    expect(cudzy.data).toEqual({ status: 'refused', code: 'conflict' });
    const innaTresc = await owner.rpc('expense_comment_add', { ...wpis, p_body: 'Inna treść', p_comment_id: COMMENT });
    expect(innaTresc.data).toEqual({ status: 'refused', code: 'conflict' });
    const innyRodzaj = await owner.rpc('expense_comment_add', { ...wpis, p_kind: 'document_request', p_body: COMMENT_BODY, p_comment_id: COMMENT });
    expect(innyRodzaj.data).toEqual({ status: 'refused', code: 'conflict' });

    const wpisy = await watek(ORG);
    expect(wpisy.filter((w) => w.expense_id === EXPENSE)).toHaveLength(3);
    expect(wpisy.find((w) => w.id === COMMENT)).toMatchObject({ author_id: ids.owner, kind: 'comment', body: COMMENT_BODY });
    expect(await wpisyDzwonka(COMMENT)).toHaveLength(2);
  });

  it('załatwienie prośby: kto i kiedy, audyt, powtórka bez zmian; komentarz, obca firma i zawieszony odmowa', async () => {
    const obcy = await signedIn('other', OTHER_ORG);
    expect((await obcy.rpc('expense_document_request_resolve', { p_comment_id: REQUEST })).data).toEqual({ status: 'refused', code: 'not_found' });
    const zawieszony = await signedIn('suspended', ORG);
    expect((await zawieszony.rpc('expense_document_request_resolve', { p_comment_id: REQUEST })).error?.code).toBe('42501');
    const owner = await signedIn('owner', ORG);
    expect((await owner.rpc('expense_document_request_resolve', { p_comment_id: COMMENT })).data).toMatchObject({
      status: 'refused',
      code: 'not_request',
    });
    expect((await watek(ORG)).find((w) => w.id === REQUEST)).toMatchObject({ resolved_at: null, resolved_by: null });

    const czlonek = await signedIn('member', ORG);
    const nowe = await nowyAudyt(async () => {
      const r = await czlonek.rpc('expense_document_request_resolve', { p_comment_id: REQUEST });
      expect(r.error).toBeNull();
      expect(r.data).toMatchObject({ status: 'resolved', expense_id: EXPENSE, resolved_by: ids.member });
    });
    expect(nowe).toHaveLength(1);
    expect(nowe[0]).toMatchObject({
      tenant_id: ORG,
      user_id: ids.member,
      action: 'expense.document_request_resolved',
      entity_type: 'expense',
      entity_id: EXPENSE,
    });
    expect(nowe[0]!.metadata).toMatchObject({ commentId: REQUEST, role: 'member' });
    const prosba = (await watek(ORG)).find((w) => w.id === REQUEST)!;
    expect(prosba.resolved_by).toBe(ids.member);
    expect(Date.parse(prosba.resolved_at as string)).toBeGreaterThanOrEqual(Date.parse(prosba.created_at as string));

    // Powtórka (druga osoba albo drugie kliknięcie): bez zmiany kto i kiedy, bez drugiego wpisu audytu.
    const powtorka = await nowyAudyt(async () => {
      const r = await owner.rpc('expense_document_request_resolve', { p_comment_id: REQUEST });
      expect(r.error).toBeNull();
      expect(r.data).toMatchObject({ status: 'already_resolved', expense_id: EXPENSE, resolved_by: ids.member });
    });
    expect(powtorka).toEqual([]);
    expect((await watek(ORG)).find((w) => w.id === REQUEST)).toMatchObject({ resolved_by: ids.member, resolved_at: prosba.resolved_at });
  });

  it('treść: przycięcie, pusta, za długa, zły rodzaj; skrót w dzwonku; koszt bez numeru; CHECK-i tabeli i nowe rodzaje dzwonka', async () => {
    const owner = await signedIn('owner', ORG);
    const odmowy: Array<[string, string, string]> = [
      ['   \n\t ', 'comment', 'empty_body'],
      ['x'.repeat(2001), 'comment', 'body_too_long'],
      ['Treść', 'notatka', 'invalid_kind'],
    ];
    for (const [body, kind, code] of odmowy) {
      const r = await owner.rpc('expense_comment_add', { p_expense_id: EXPENSE, p_kind: kind, p_body: body });
      expect(r.data, code).toEqual({ status: 'refused', code });
    }

    // 2000 znaków przechodzi; w dzwonku skrót 140 znaków z wielokropkiem.
    const dlugi = await owner.rpc('expense_comment_add', { p_expense_id: EXPENSE, p_kind: 'comment', p_body: 'Ą'.repeat(2000), p_comment_id: LONG });
    expect(dlugi.data).toMatchObject({ status: 'created' });
    const [skrot] = await wpisyDzwonka(LONG);
    expect(skrot!.body).toBe(`Olga Właścicielka (właściciel) ${LABEL}: ${'Ą'.repeat(139)}…`);

    // Koszt bez numeru, sprzedawca „Nieznany”: bez „od Nieznany”; w drugiej firmie dzwonek tylko jej członka.
    const obcy = await signedIn('other', OTHER_ORG);
    const bezNumeru = await obcy.rpc('expense_comment_add', {
      p_expense_id: OTHER_EXPENSE, p_kind: 'document_request', p_body: 'Brak paragonu', p_comment_id: NO_NUMBER,
    });
    expect(bezNumeru.data).toMatchObject({ status: 'created', notified: 1 });
    expect(await wpisyDzwonka(NO_NUMBER)).toEqual([
      {
        tenant_id: OTHER_ORG,
        user_id: ids.accountant,
        kind: 'expense_document_request',
        object_key: NO_NUMBER,
        title: 'Prośba o dokument do kosztu',
        body: 'Oskar Obcy (właściciel) przy koszcie bez numeru: Brak paragonu',
        link: `/expenses/${OTHER_EXPENSE}#komentarze`,
        read_at: null,
      },
    ]);

    // CHECK-i tabeli: zapis serwisowy z pominięciem funkcji. Nazwa ograniczenia w komunikacie dowodzi swojego CHECK-a.
    const wiersz = { tenant_id: ORG, expense_id: EXPENSE, author_id: ids.owner, author_role: 'owner', kind: 'comment', body: 'Wpis serwisowy' };
    const przypadki: Array<[Record<string, unknown>, string]> = [
      [{ kind: 'notatka' }, 'expense_comments_kind_check'],
      [{ author_role: 'viewer' }, 'expense_comments_author_role_check'],
      [{ body: '' }, 'expense_comments_body_check'],
      [{ body: '   ' }, 'expense_comments_body_check'],
      [{ body: 'x'.repeat(2001) }, 'expense_comments_body_check'],
      // Komentarza nie da się „załatwić”; prośba bez daty nie ma osoby; załatwienie nie przed utworzeniem.
      [{ resolved_at: new Date(Date.now() + 60_000).toISOString() }, 'expense_comments_resolved_check'],
      [{ kind: 'document_request', resolved_by: ids.owner }, 'expense_comments_resolved_check'],
      [{ kind: 'document_request', resolved_at: '2000-01-01T00:00:00Z', resolved_by: ids.owner }, 'expense_comments_resolved_check'],
    ];
    for (const [zmiana, ograniczenie] of przypadki) {
      const { error } = await admin.from('expense_comments').insert({ ...wiersz, ...zmiana });
      expect(error?.message, ograniczenie).toContain(ograniczenie);
    }

    // Dzwonek (00188) przyjmuje dwa nowe rodzaje; nieznany rodzaj dalej odpada.
    const publish = (kind: string) =>
      admin.rpc('app_notification_publish', { p_tenant_id: OTHER_ORG, p_kind: kind, p_object_key: `rodzaj-${kind}`, p_title: 'Test rodzaju', p_body: null, p_link: null });
    expect((await publish('expense_comment')).data).toBe(2);
    expect((await publish('expense_document_request')).data).toBe(2);
    expect((await publish('cos_innego')).error?.message).toContain('app_notifications_kind_check');
  });

  it('usunięcie kosztu usuwa jego wątek; wpisy w dzwonku i audyt zostają', async () => {
    expect((await watek(OTHER_ORG)).map((w) => w.id)).toEqual([NO_NUMBER]);
    const usun = await admin.from('expenses').delete().eq('id', OTHER_EXPENSE);
    expect(usun.error).toBeNull();
    expect(await watek(OTHER_ORG)).toEqual([]);
    expect(await wpisyDzwonka(NO_NUMBER)).toHaveLength(1);
    expect((await audyt()).some((w) => w.entity_id === OTHER_EXPENSE && w.action === 'expense.document_requested')).toBe(true);
  });
});

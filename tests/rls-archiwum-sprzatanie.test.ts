import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';

import { getRlsTestEnvironment } from './helpers/rls-environment';

/**
 * 00190 na prawdziwej bazie: usuwanie plików wygasłych paczek archiwum
 * (plan kompletnej aplikacji, krok 6.4, część 2).
 *
 * Znacznik `file_deleted_at` ustawia tylko funkcja
 * `mark_document_archive_file_deleted` (EXECUTE wyłącznie service_role), tylko
 * na wierszu `completed` z wygasłym linkiem i tym samym kluczem pliku,
 * jeden raz, w jednej transakcji z wpisem `audit_logs`. CHECK
 * `document_archives_file_deleted_check` pilnuje tego także przy zapisie
 * kluczem serwisowym. Runner `cron.document-archive-cleanup` idzie przez
 * prawdziwy PostgREST kluczem serwisowym; atrapa tylko dla magazynu (S3).
 *
 * Czerwień przed 00190 wynika wyłącznie z bazy: kolumny i funkcji nie ma
 * (PGRST204/PGRST202, 42703).
 */

const m = vi.hoisted(() => ({ client: null as unknown, sent: [] as unknown[] }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => m.client }));
vi.mock('@/lib/storage/r2-client', () => ({
  getR2Config: () => ({ bucketName: 'faktury-rls' }),
  getR2Client: () => ({
    send: async (command: unknown) => {
      m.sent.push(command);
      return {};
    },
  }),
}));

import { readArchiveOrder, readArchiveOrders } from '@/lib/archiwum/zlecenia';
import { runDocumentArchiveCleanup } from '@/lib/jobs/runners/document-archive-cleanup';

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
m.client = admin;

const ORG = '00190190-0000-4000-8000-000000000001';
const OWNER_EMAIL = 'rls-sprzatanie-archiwum-owner@ksef-saas.test';
const PASS = 'RlsSprzatanieArchiwum2026Aa!';
const FILE = 'Archiwum_9480000090_okres.zip';
const RPC = 'mark_document_archive_file_deleted';
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

const ctx: JobContext = {
  attempt: 0,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  step: { run: async (_n, fn) => fn(), sleep: vi.fn(), sendEvent: vi.fn(), scheduleAfter: vi.fn() },
};

/** Zlecenia tej firmy po nazwie przypadku. */
const ids: Record<string, string> = {};

function anonClient(activeOrg?: string) {
  return createClient(environment!.url, environment!.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    ...(activeOrg ? { global: { headers: { 'x-active-org': activeOrg } } } : {}),
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

async function signedIn(email: string, org: string): Promise<SupabaseClient> {
  const client = anonClient(org);
  const { error } = await client.auth.signInWithPassword({ email, password: PASS });
  if (error) throw error;
  return client;
}

/** Cofa czas założenia zleceń firmy: następne nie trafi w limit 10 minut (wyzwalacz 00178). */
async function cofnij(minutes: number) {
  const { data, error } = await admin.from('document_archives').select('id, created_at').eq('tenant_id', ORG);
  if (error) throw error;
  for (const row of data ?? []) {
    const at = new Date(new Date(row.created_at as string).getTime() - minutes * 60_000).toISOString();
    const { error: upErr } = await admin.from('document_archives').update({ created_at: at }).eq('id', row.id);
    if (upErr) throw upErr;
  }
}

function lastDay(month: string): string {
  const [y, mo] = month.split('-').map(Number);
  return `${month}-${String(new Date(Date.UTC(y!, mo!, 0)).getUTCDate()).padStart(2, '0')}`;
}

const fileKey = (id: string) => `exports/${ORG}/archiwum/${id}/${FILE}`;

/** Gotowa paczka z linkiem ważnym do `expiresAt`. */
const gotowa = (expiresAt: number) => (id: string) => ({
  status: 'completed',
  file_key: fileKey(id),
  file_name: FILE,
  size_bytes: 2048,
  files_count: 3,
  missing_count: 1,
  finished_at: iso(expiresAt - 7 * DAY),
  expires_at: iso(expiresAt),
});

/** Zlecenie kluczem serwisowym (jak akcja, ale bez sesji), potem stan zadania. */
async function zlecenie(name: string, month: string, state: (id: string) => Record<string, unknown>) {
  await cofnij(11);
  const { data, error } = await admin
    .from('document_archives')
    .insert({ tenant_id: ORG, kind: 'archive', period_start: `${month}-01`, period_end: lastDay(month) })
    .select('id')
    .single();
  if (error || !data) throw error ?? new Error(`insert ${name}`);
  const id = (data as { id: string }).id;
  const patch = state(id);
  if (Object.keys(patch).length > 0) {
    const { error: upErr } = await admin.from('document_archives').update(patch).eq('id', id);
    if (upErr) throw new Error(`${name}: ${upErr.message}`);
  }
  ids[name] = id;
}

async function wiersz(name: string) {
  const { data, error } = await admin
    .from('document_archives')
    .select('status, file_key, expires_at, file_deleted_at')
    .eq('id', ids[name]!)
    .single();
  if (error) throw error;
  return data as { status: string; file_key: string | null; expires_at: string | null; file_deleted_at: string | null };
}

async function audyt(name: string) {
  const { data, error } = await admin
    .from('audit_logs')
    .select('tenant_id, user_id, action, entity_type, entity_id, metadata')
    .eq('entity_id', ids[name]!)
    .eq('action', 'document_archive.file_deleted');
  if (error) throw error;
  return data ?? [];
}

/** Klucze tej firmy, które runner kazał usunąć z magazynu. */
const usunieteKlucze = () =>
  m.sent
    .filter((c): c is DeleteObjectCommand => c instanceof DeleteObjectCommand)
    .map((c) => String(c.input.Key))
    .filter((key) => key.startsWith(`exports/${ORG}/`));

async function sprzataj() {
  await admin.from('document_archives').delete().eq('tenant_id', ORG);
  await admin.from('memberships').delete().eq('organization_id', ORG);
}

describe.skipIf(!hasDatabase)('00190: pliki wygasłych paczek archiwum na prawdziwym PostgREST', () => {
  beforeAll(async () => {
    const ownerId = await userId(OWNER_EMAIL);
    await sprzataj();
    // Wpisy audytu (00052, tylko do dopisywania) blokują kasowanie firmy kaskadą:
    // kolejny przebieg na tej samej bazie dopisuje się do istniejącej firmy.
    const { error: tErr } = await admin
      .from('tenants')
      .upsert([{ id: ORG, nip: '9480000090', name: 'Firma sprzątanie archiwum 00190' }], { onConflict: 'id' });
    if (tErr) throw tErr;
    await admin.from('users').upsert([{ id: ownerId, name: 'Owner' }], { onConflict: 'id' });
    const { error: mErr } = await admin
      .from('memberships')
      .insert([{ organization_id: ORG, user_id: ownerId, role: 'owner', status: 'active' }]);
    if (mErr) throw mErr;

    const now = Date.now();
    await zlecenie('wygasla', '2025-01', gotowa(now - 2 * DAY));
    await zlecenie('doRunnera', '2025-03', gotowa(now - 2 * DAY));
    await zlecenie('wZapasie', '2025-05', gotowa(now - 30 * 60_000));
    await zlecenie('swieza', '2025-07', gotowa(now + 3 * DAY));
    await zlecenie('oczekuje', '2025-08', () => ({}));
    // Stany aktywne i nieudane z kluczem i datą w przeszłości: CHECK-i 00178 na to pozwalają,
    // a funkcja i zadanie i tak ich nie ruszają.
    await zlecenie('wPrzygotowaniu', '2025-10', (id) => ({ status: 'generating', file_key: fileKey(id), expires_at: iso(now - 2 * DAY) }));
    await zlecenie('nieudana', '2025-12', (id) => ({
      status: 'failed',
      error_message: 'Nie udało się przygotować paczki.',
      finished_at: iso(now - 9 * DAY),
      file_key: fileKey(id),
      expires_at: iso(now - 2 * DAY),
    }));
  }, 60_000);

  afterAll(async () => {
    if (!hasDatabase) return;
    await sprzataj();
    await admin.from('tenants').delete().eq('id', ORG);
  });

  it('funkcja znacznika tylko dla zadania: właściciel firmy i anon dostają odmowę uprawnień', async () => {
    const owner = await signedIn(OWNER_EMAIL, ORG);
    const asOwner = await owner.rpc(RPC, { p_archive_id: ids.wygasla, p_file_key: fileKey(ids.wygasla!) });
    expect(asOwner.error?.code).toBe('42501');
    const asAnon = await anonClient().rpc(RPC, { p_archive_id: ids.wygasla, p_file_key: fileKey(ids.wygasla!) });
    expect(asAnon.error?.code).toBe('42501');
    expect((await wiersz('wygasla')).file_deleted_at).toBeNull();
    // Kluczem użytkownika znacznika nie da się też zapisać wprost (UPDATE tylko service_role).
    const { error } = await owner.from('document_archives').update({ file_deleted_at: new Date().toISOString() }).eq('id', ids.wygasla!);
    expect(error?.code).toBe('42501');
  });

  it('wygasła gotowa paczka: znacznik i jeden wpis audit_logs w jednej transakcji; drugie wywołanie zwraca false', async () => {
    const first = await admin.rpc(RPC, { p_archive_id: ids.wygasla, p_file_key: fileKey(ids.wygasla!) });
    expect(first.error).toBeNull();
    expect(first.data).toBe(true);
    const row = await wiersz('wygasla');
    expect(row.status).toBe('completed');
    expect(row.file_key).toBe(fileKey(ids.wygasla!));
    expect(Date.parse(row.file_deleted_at!)).toBeGreaterThanOrEqual(Date.parse(row.expires_at!));

    const entries = await audyt('wygasla');
    expect(entries).toEqual([
      {
        tenant_id: ORG,
        user_id: null,
        action: 'document_archive.file_deleted',
        entity_type: 'document_archive',
        entity_id: ids.wygasla,
        metadata: expect.objectContaining({
          kind: 'archive',
          periodStart: '2025-01-01',
          periodEnd: '2025-01-31',
          fileName: FILE,
          sizeBytes: 2048,
          source: 'system',
        }),
      },
    ]);

    const second = await admin.rpc(RPC, { p_archive_id: ids.wygasla, p_file_key: fileKey(ids.wygasla!) });
    expect(second.error).toBeNull();
    expect(second.data).toBe(false);
    expect(await audyt('wygasla')).toHaveLength(1);
  });

  it('funkcja odmawia: inny klucz pliku, link jeszcze ważny, „pending”, „generating”, „failed”; bez znacznika i bez audytu', async () => {
    const cases: Array<[string, string | null]> = [
      ['doRunnera', `exports/${ORG}/archiwum/${ids.doRunnera}/inny.zip`],
      ['swieza', fileKey(ids.swieza!)],
      ['oczekuje', fileKey(ids.oczekuje!)],
      ['wPrzygotowaniu', fileKey(ids.wPrzygotowaniu!)],
      ['nieudana', fileKey(ids.nieudana!)],
    ];
    for (const [name, key] of cases) {
      const { data, error } = await admin.rpc(RPC, { p_archive_id: ids[name], p_file_key: key });
      expect(error, name).toBeNull();
      expect(data, name).toBe(false);
      expect((await wiersz(name)).file_deleted_at, name).toBeNull();
      expect(await audyt(name), name).toEqual([]);
    }
  });

  it('CHECK znacznika także dla klucza serwisowego: tylko gotowa paczka, nie przed wygaśnięciem; linku usuniętej nie da się przedłużyć', async () => {
    const at = new Date().toISOString();
    for (const name of ['oczekuje', 'wPrzygotowaniu', 'nieudana', 'swieza']) {
      const { error } = await admin.from('document_archives').update({ file_deleted_at: at }).eq('id', ids[name]!);
      expect(error?.message, name).toMatch(/document_archives_file_deleted_check/);
    }
    const { error } = await admin
      .from('document_archives')
      .update({ expires_at: iso(Date.now() + 7 * DAY) })
      .eq('id', ids.wygasla!);
    expect(error?.message).toMatch(/document_archives_file_deleted_check/);
  });

  it('właściciel widzi znacznik w ustawieniach (odczyt listy i pojedynczej paczki przez RLS)', async () => {
    const owner = await signedIn(OWNER_EMAIL, ORG);
    const orders = await readArchiveOrders(owner, ORG, 10);
    expect(orders).toHaveLength(7);
    expect(orders.find((o) => o.id === ids.wygasla)?.file_deleted_at).toEqual(expect.any(String));
    expect(orders.find((o) => o.id === ids.swieza)?.file_deleted_at).toBeNull();
    expect((await readArchiveOrder(owner, ORG, ids.wygasla!))?.file_deleted_at).toEqual(expect.any(String));
  });

  it('zadanie na prawdziwej bazie: usuwa tylko plik wygasłej gotowej paczki po zapasie, znacznik i audyt; ponowienie nic nie dubluje', async () => {
    m.sent = [];
    await runDocumentArchiveCleanup(ctx);

    expect(m.sent.every((c) => c instanceof DeleteObjectCommand)).toBe(true);
    expect(usunieteKlucze()).toEqual([fileKey(ids.doRunnera!)]);
    expect((await wiersz('doRunnera')).file_deleted_at).toEqual(expect.any(String));
    expect(await audyt('doRunnera')).toHaveLength(1);
    for (const name of ['wZapasie', 'swieza', 'oczekuje', 'wPrzygotowaniu', 'nieudana']) {
      expect((await wiersz(name)).file_deleted_at, name).toBeNull();
    }

    m.sent = [];
    await runDocumentArchiveCleanup(ctx);
    expect(usunieteKlucze()).toEqual([]);
    expect(await audyt('doRunnera')).toHaveLength(1);
    expect(await audyt('wygasla')).toHaveLength(1);
  });
});

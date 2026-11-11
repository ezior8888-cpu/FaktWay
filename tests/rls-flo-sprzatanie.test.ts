import { randomUUID } from 'node:crypto';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const captureException = vi.hoisted(() => vi.fn());
vi.mock('@sentry/nextjs', () => ({ captureException }));

/** Wpis audytu: tylko pola, które ten test sprawdza. */
interface AuditEntry {
  tenantId?: string | null;
  action?: string;
  entityType?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
}
const audit = vi.hoisted(() => vi.fn(async (_entry: AuditEntry) => undefined));
vi.mock('@/lib/audit/log-system', () => ({ logAuditSystem: audit }));

import type { FloDbClient } from '@/lib/flo/db-types';
import { expireStale } from '@/lib/flo/proposals';
import { runFloTick, type FloTickSources } from '@/lib/flo/tick';

import { getRlsTestEnvironment } from './helpers/rls-environment';

/**
 * FLO-01 (plan skalowania 3000, sesja 3) na prawdziwym Postgresie i PostgREST.
 *
 * Sprzątanie na początku pulsu FLO to dwa zapisy z warunkiem w zapytaniu:
 * wygaszanie kart po terminie (`expireStale`) i podnoszenie kart porzuconych
 * w „wykonuję”. Test jednostkowy (`tests/unit/flo-sprzatanie-jednym-zapytaniem.test.ts`)
 * pilnuje kształtu żądania na atrapie serwera. Ten sprawdza to, czego atrapa
 * nie dowiedzie: prawdziwy PostgREST z `max_rows = 1000` (supabase/config.toml)
 * zmienia i odsyła WSZYSTKIE pasujące wiersze, także ponad tysiąc, a licznik
 * z nagłówka `Content-Range` jest prawdziwy.
 *
 * Obie funkcje działają na CAŁEJ tabeli, nie na jednej firmie. Pliki RLS idą
 * po kolei (`fileParallelism: false`), a jedyny inny plik z kartami FLO
 * (`rls-zaplacone`) sprząta po sobie. Mimo to liczby porównujemy z odczytem
 * całej tabeli tuż przed przebiegiem, a nie z liczbą wstawionych kart.
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
/** Tak jak worker: klucz service_role, bez sesji użytkownika. */
const db = admin as unknown as FloDbClient;

const ORG_A = 'f1000001-0000-4000-8000-00000000000a';
const ORG_B = 'f1000001-0000-4000-8000-00000000000b';
const ORGS = [ORG_A, ORG_B];
const NIP = '1234567890';

/** Limit odczytu PostgREST w bazie testowej (`max_rows`, supabase/config.toml). */
const MAX_ROWS = 1000;
/** Ponad limit odczytu: stare „najpierw lista id, potem zapis” nie objęłoby ich jednym przebiegiem. */
const STALE = 1200;
const STUCK = 1200;
/** Tyle minut czeka strażnik, zanim uzna kartę za porzuconą (`STUCK_AFTER_MS` w `lib/flo/tick.ts`). */
const STUCK_AFTER_MINUTES = 15;
const INSERT_CHUNK = 200;
const TIMEOUT = 120_000;

interface Card {
  id: string;
  tenant_id: string;
  kind: string;
  topic_key: string;
  status: string;
  title: string;
  body: string;
  fingerprint: string;
  expires_at: string;
  approved_at: string | null;
  dismissed_reason: string | null;
}

type GuardName = 'fresh' | 'dismissed' | 'busy' | 'done';

let now = new Date();
let stale: Card[] = [];
let stuck: Card[] = [];
let guards = {} as Record<GuardName, Card>;

function minutesFromNow(minutes: number): string {
  return new Date(now.getTime() + minutes * 60_000).toISOString();
}

function card(
  group: string,
  i: number,
  fields: Pick<Card, 'status' | 'expires_at' | 'approved_at'> & Partial<Card>,
): Card {
  return {
    id: randomUUID(),
    tenant_id: i % 2 === 0 ? ORG_A : ORG_B,
    kind: 'payment.chase',
    // Każda karta ma własny temat: unikalny indeks żywych kart (00061) nie może
    // zablokować zapisu, bo ten test nie dotyczy tematów.
    topic_key: `rls-flo-sprzatanie:${group}:${i}`,
    title: 'Karta testowa',
    body: 'Sprzątanie pulsu FLO (FLO-01)',
    fingerprint: 'x',
    dismissed_reason: null,
    ...fields,
  };
}

async function seed() {
  const past = minutesFromNow(-24 * 60);
  const future = minutesFromNow(7 * 24 * 60);
  const longAgo = minutesFromNow(-2 * STUCK_AFTER_MINUTES);
  const justNow = minutesFromNow(-5);

  stale = Array.from({ length: STALE }, (_, i) => {
    // Obie firmy mają karty otwarte i zatwierdzone.
    const approved = Math.floor(i / 2) % 2 === 1;
    return card('wygas', i, {
      status: approved ? 'approved' : 'open',
      expires_at: past,
      approved_at: approved ? past : null,
    });
  });
  stuck = Array.from({ length: STUCK }, (_, i) =>
    card('podnies', i, {
      status: 'executing',
      expires_at: future,
      approved_at: longAgo,
      // Różne rodzaje: wpis audytu ma nieść rodzaj TEJ karty.
      kind: i % 3 === 0 ? 'payment.confirm' : 'payment.chase',
    }),
  );
  guards = {
    // Termin jeszcze nie minął.
    fresh: card('straz', 0, { status: 'open', expires_at: future, approved_at: null }),
    // Po terminie, ale zamknięta przez człowieka: powód zostaje jego.
    dismissed: card('straz', 1, {
      status: 'dismissed',
      expires_at: past,
      approved_at: null,
      dismissed_reason: 'never',
    }),
    // Wykonanie trwa od 5 minut: mimo terminu po czasie nie gaśnie i nie wraca.
    busy: card('straz', 2, { status: 'executing', expires_at: past, approved_at: justNow }),
    // Dawno zatwierdzona, ale już wykonana: strażnik jej nie rusza.
    done: card('straz', 3, { status: 'done', expires_at: future, approved_at: longAgo }),
  };

  const all = [...stale, ...stuck, ...Object.values(guards)];
  for (let i = 0; i < all.length; i += INSERT_CHUNK) {
    const { error } = await admin.from('flo_proposals').insert(all.slice(i, i + INSERT_CHUNK));
    if (error) throw error;
  }
}

async function cleanup() {
  const { error } = await admin.from('flo_proposals').delete().in('tenant_id', ORGS);
  if (error) throw error;
}

async function exactCount(query: PromiseLike<{ count: number | null; error: unknown }>): Promise<number> {
  const { count, error } = await query;
  if (error) throw error;
  if (count === null) throw new Error('PostgREST nie zwrócił licznika');
  return count;
}

/** Karty, które wygaszanie ma objąć: w całej tabeli albo tylko w firmach testu. */
function countStale(tenants?: string[]): Promise<number> {
  let query = admin
    .from('flo_proposals')
    .select('id', { count: 'exact', head: true })
    .in('status', ['open', 'approved'])
    .lt('expires_at', now.toISOString());
  if (tenants) query = query.in('tenant_id', tenants);
  return exactCount(query);
}

/** Karty, które strażnik ma podnieść, w całej tabeli. */
function countStuck(): Promise<number> {
  return exactCount(
    admin
      .from('flo_proposals')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'executing')
      .lt('approved_at', minutesFromNow(-STUCK_AFTER_MINUTES)),
  );
}

/** Karty firm testu w danym stanie. */
function countStatus(status: string, reason?: string): Promise<number> {
  let query = admin
    .from('flo_proposals')
    .select('id', { count: 'exact', head: true })
    .in('tenant_id', ORGS)
    .eq('status', status);
  if (reason) query = query.eq('dismissed_reason', reason);
  return exactCount(query);
}

async function expectGuardsUntouched() {
  const { data, error } = await admin
    .from('flo_proposals')
    .select('id, status, dismissed_reason')
    .in('id', Object.values(guards).map((guard) => guard.id));
  expect(error).toBeNull();
  const rows = new Map((data ?? []).map((row) => [row.id as string, row]));
  for (const guard of Object.values(guards)) {
    expect(rows.get(guard.id)).toMatchObject({
      status: guard.status,
      dismissed_reason: guard.dismissed_reason,
    });
  }
}

/** Puls bez kont: ten test dotyczy sprzątania, reguły mają własne testy. */
function noTenants(): FloTickSources {
  return {
    listTenantIds: async () => [],
    readGlobalKill: async () => false,
    paymentConfirm: {
      readOverdueInvoices: async () => [],
      readInvoiceState: async () => ({ facts: {}, context: {} }),
      readGlobalKill: async () => false,
    },
    expenseMissing: { readRecentExpenses: async () => [], readGlobalKill: async () => false },
    invoiceMissing: { readIssuedInvoices: async () => [], readGlobalKill: async () => false },
    onboarding: { readAccount: async () => null, readGlobalKill: async () => false },
  };
}

describe.skipIf(!hasDatabase)('FLO-01: sprzątanie pulsu na prawdziwym PostgREST (ponad 1000 kart)', () => {
  beforeAll(async () => {
    const { error } = await admin.from('tenants').upsert(
      [
        { id: ORG_A, nip: NIP, name: 'Firma A Sprzątanie FLO' },
        { id: ORG_B, nip: NIP, name: 'Firma B Sprzątanie FLO' },
      ],
      { onConflict: 'id' },
    );
    if (error) throw error;
  }, TIMEOUT);

  beforeEach(async () => {
    audit.mockClear();
    captureException.mockClear();
    now = new Date();
    await cleanup();
    await seed();
  }, TIMEOUT);

  afterAll(async () => {
    await cleanup();
    // Jak w `rls-zaplacone`: gdyby coś trwale wiązało firmę (audyt jest
    // niemutowalny, 00052), kolejny przebieg dopisze się do niej przez upsert.
    await admin.from('tenants').delete().in('id', ORGS);
  }, TIMEOUT);

  it('baza testowa ucina odczyt do 1000 wierszy, więc stary odczyt listy id nie objąłby wszystkich kart', async () => {
    const { data, count, error } = await admin
      .from('flo_proposals')
      .select('id', { count: 'exact' })
      .in('tenant_id', ORGS)
      .in('status', ['open', 'approved'])
      .lt('expires_at', now.toISOString());

    expect(error).toBeNull();
    expect(count).toBe(STALE);
    expect(data).toHaveLength(MAX_ROWS);
  }, TIMEOUT);

  it('1200 kart po terminie gaśnie jednym zapisem, a drugi przebieg niczego nie zmienia', async () => {
    const before = await countStale();
    expect(before).toBeGreaterThanOrEqual(STALE);

    const expired = await expireStale(now, db);

    // Liczba z bazy (`Content-Range`), a nie długość odczytanej listy.
    expect(expired).toBe(before);
    expect(await countStale()).toBe(0);
    expect(await countStatus('expired', 'auto_expired')).toBe(STALE);
    await expectGuardsUntouched();

    expect(await expireStale(now, db)).toBe(0);
    expect(await countStatus('expired', 'auto_expired')).toBe(STALE);
    await expectGuardsUntouched();
  }, TIMEOUT);

  it('1200 kart porzuconych w „wykonuję” wraca do „zatwierdzona” jednym zapisem, każda z wpisem audytu swojej firmy', async () => {
    const staleBefore = await countStale();
    const stuckBefore = await countStuck();
    expect(stuckBefore).toBeGreaterThanOrEqual(STUCK);

    const first = await runFloTick(undefined, now, db, noTenants());

    expect(first.failedCleanup).toEqual([]);
    expect(captureException).not.toHaveBeenCalled();
    expect(first.expired).toBe(staleBefore);
    expect(first.released).toBe(stuckBefore);
    expect(await countStuck()).toBe(0);
    expect(await countStatus('approved')).toBe(STUCK);
    await expectGuardsUntouched();

    // Zapis odesłał WSZYSTKIE podniesione karty, nie tysiąc: każda ma jeden
    // wpis w audycie, z firmą i rodzajem tej karty.
    expect(audit).toHaveBeenCalledTimes(stuckBefore);
    const byId = new Map(stuck.map((c) => [c.id, c]));
    const mine = audit.mock.calls
      .map(([entry]) => entry)
      .filter((entry) => byId.has(entry.entityId ?? ''));
    expect(new Set(mine.map((entry) => entry.entityId)).size).toBe(STUCK);
    for (const entry of mine) {
      const source = byId.get(entry.entityId!)!;
      expect(entry).toMatchObject({
        tenantId: source.tenant_id,
        action: 'flo.proposal.failed',
        entityType: 'flo_proposal',
        metadata: expect.objectContaining({ kind: source.kind }),
      });
    }

    audit.mockClear();
    const second = await runFloTick(undefined, now, db, noTenants());

    expect(second).toMatchObject({ expired: 0, released: 0, failedCleanup: [] });
    expect(audit).not.toHaveBeenCalled();
    expect(await countStatus('approved')).toBe(STUCK);
    await expectGuardsUntouched();
  }, TIMEOUT);
});

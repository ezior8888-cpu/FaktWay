import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { PostHog } from 'posthog-node';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ANALYTICS_EVENTS, type AnalyticsEventName } from '@/lib/analytics/events';
import { identifyServer, trackServer } from '@/lib/analytics/server';

import { memoryDb, type MemoryDb, type Row } from '../helpers/fake-supabase-memory';
import { fakePosthog, lejekClient } from '../helpers/lejek-atrapy';

/**
 * Bramka zgody na serwerze (FAKTWAY-1-0, sekcja 3 pkt 7). Do 11.2026
 * `trackServer` wysyłał wszystko bez sprawdzania zgody, która żyła tylko
 * w localStorage przeglądarki. Mock tylko HTTP do PostHoga i baza w pamięci;
 * bramka i filtry są prawdziwe.
 */

const h = vi.hoisted(() => ({ db: null as unknown, posthog: null as unknown }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => lejekClient(h.db as MemoryDb) }));
vi.mock('@/lib/analytics/posthog-node-client', () => ({ getPostHogNodeClient: () => h.posthog }));

const OWNER = '00000000-0000-4000-8000-000000000011';
const SECOND_OWNER = '00000000-0000-4000-8000-000000000012';
const TENANT = '00000000-0000-4000-8000-000000000021';
const SOURCE = {
  channel: 'google_ads', utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'ksef-2026',
  referrer_host: 'www.google.com', landing_path: '/pricing', at: '2026-10-30',
};

let posthog: ReturnType<typeof fakePosthog>;
let db: MemoryDb;

function seed(owner: Row = {}) {
  db = memoryDb({
    users: [
      { id: OWNER, analytics_consent: 'granted', signup_source: SOURCE, ...owner },
      { id: SECOND_OWNER, analytics_consent: 'denied', signup_source: null },
    ],
    memberships: [
      { organization_id: TENANT, user_id: SECOND_OWNER, role: 'owner', status: 'active', joined_at: '2026-10-02T00:00:00Z' },
      { organization_id: TENANT, user_id: OWNER, role: 'owner', status: 'active', joined_at: '2026-10-01T00:00:00Z' },
    ],
  });
  h.db = db;
}

beforeEach(() => {
  posthog = fakePosthog();
  h.posthog = posthog;
  seed();
});

describe('brak zgody = brak zdarzenia', () => {
  it.each([null, 'denied', 'unexpected'])('użytkownik ze zgodą %s: nic nie wychodzi', async (consent) => {
    seed({ analytics_consent: consent });
    await trackServer({ userId: OWNER, event: ANALYTICS_EVENTS.loginCompleted, properties: { method: 'password' } });
    await identifyServer(OWNER, { plan: 'active' });
    expect(posthog.messages).toEqual([]);
  });

  it('zgoda: zdarzenie wychodzi na identyfikator użytkownika', async () => {
    await trackServer({ userId: OWNER, event: ANALYTICS_EVENTS.loginCompleted, properties: { method: 'password' } });
    expect(posthog.messages).toHaveLength(1);
    expect(posthog.messages[0]).toMatchObject({ distinctId: OWNER, event: 'login_completed' });
  });

  it('odwołanie działa od razu: kolejne zdarzenie czyta bazę, bez pamięci podręcznej', async () => {
    await trackServer({ userId: OWNER, event: ANALYTICS_EVENTS.loginCompleted });
    (db.tables.users[0] as Row).analytics_consent = 'denied';
    await trackServer({ userId: OWNER, event: ANALYTICS_EVENTS.loginCompleted });
    expect(posthog.messages).toHaveLength(1);
  });

  it('błąd odczytu zgody: fail-closed, bez wyjątku dla operacji biznesowej', async () => {
    db.failures['users:select'] = { code: '08006', message: 'połączenie zerwane' };
    await expect(trackServer({ userId: OWNER, event: ANALYTICS_EVENTS.loginCompleted })).resolves.toBeUndefined();
    expect(posthog.messages).toEqual([]);
  });

  it('nieznany użytkownik: bez zdarzenia', async () => {
    await trackServer({ userId: '00000000-0000-4000-8000-000000000099', event: ANALYTICS_EVENTS.loginCompleted });
    expect(posthog.messages).toEqual([]);
  });
});

describe('zdarzenia firmy: zgoda właściciela z bazy', () => {
  it('idzie na najstarszego aktywnego właściciela, z firmą w grupie i we właściwości', async () => {
    await trackServer({ tenantId: TENANT, event: ANALYTICS_EVENTS.invoiceAccepted, properties: { ksef_env: 'test' } });
    expect(posthog.messages).toHaveLength(1);
    expect(posthog.messages[0]).toMatchObject({
      distinctId: OWNER,
      groups: { tenant: TENANT },
      properties: { ksef_env: 'test', tenant_id: TENANT },
    });
  });

  it('właściciel bez zgody: bez zdarzenia, także gdy drugi właściciel ma inną decyzję', async () => {
    seed({ analytics_consent: 'denied' });
    (db.tables.users[1] as Row).analytics_consent = 'granted';
    await trackServer({ tenantId: TENANT, event: ANALYTICS_EVENTS.paymentSucceeded });
    expect(posthog.messages).toEqual([]);
  });

  it('firma bez właściciela i błąd RPC: bez zdarzenia i bez wyjątku', async () => {
    db.tables.memberships = [];
    await trackServer({ tenantId: TENANT, event: ANALYTICS_EVENTS.paymentSucceeded });
    seed();
    db.failures['rpc:analytics_tenant_owner'] = { code: '42883', message: 'brak funkcji' };
    await expect(trackServer({ tenantId: TENANT, event: ANALYTICS_EVENTS.paymentSucceeded })).resolves.toBeUndefined();
    expect(posthog.messages).toEqual([]);
  });
});

describe('zdarzenia lejka: kanał w zdarzeniu, surowe utm we właściwościach osoby', () => {
  it('source to znormalizowany kanał; utm tylko w $set_once, nie we właściwościach zdarzenia', async () => {
    await trackServer({ tenantId: TENANT, event: ANALYTICS_EVENTS.firstInvoiceSent, dedupeKey: TENANT });
    const message = posthog.messages[0]!;
    expect(message.properties).toMatchObject({ source: 'google_ads' });
    expect(message.properties).not.toHaveProperty('utm_source');
    expect(message.properties?.$set_once).toEqual({
      first_touch_channel: 'google_ads',
      utm_source: 'google',
      utm_medium: 'cpc',
      utm_campaign: 'ksef-2026',
      referrer_host: 'www.google.com',
      landing_path: '/pricing',
      first_touch_at: '2026-10-30',
    });
  });

  it('zdarzenie spoza lejka nie niesie kanału ani danych wejścia', async () => {
    await trackServer({ userId: OWNER, event: ANALYTICS_EVENTS.loginCompleted });
    expect(posthog.messages[0]!.properties).not.toHaveProperty('source');
    expect(posthog.messages[0]!.properties).not.toHaveProperty('$set_once');
  });

  it('brak źródła (zgoda po rejestracji): zdarzenie bez source', async () => {
    seed({ signup_source: null });
    await trackServer({ tenantId: TENANT, event: ANALYTICS_EVENTS.firstInvoiceSent, dedupeKey: TENANT });
    expect(posthog.messages[0]!.properties).not.toHaveProperty('source');
  });

  it('źródło z bazy też przechodzi przez listę pól: obce klucze i dane osobowe odpadają', async () => {
    seed({ signup_source: { ...SOURCE, gclid: 'abc123', email: 'jan@example.test', utm_term: 'jan@example.test' } });
    await trackServer({ tenantId: TENANT, event: ANALYTICS_EVENTS.firstInvoiceSent, dedupeKey: TENANT });
    expect(JSON.stringify(posthog.messages[0])).not.toMatch(/abc123|jan@example/);
  });

  it('właściwości lejka z listy dozwolonych: powód odejścia i first_payment przechodzą, reszta nie', async () => {
    await trackServer({
      tenantId: TENANT,
      event: ANALYTICS_EVENTS.subscriptionCanceled,
      properties: { reason: 'payment_failed', first_payment: false, note: 'Jan Kowalski', amount: 2999 },
    });
    await trackServer({
      tenantId: TENANT,
      event: ANALYTICS_EVENTS.subscriptionCanceled,
      properties: { reason: 'Jan Kowalski' },
    });
    expect(posthog.messages[0]!.properties).toMatchObject({ reason: 'payment_failed', first_payment: false });
    expect(posthog.messages[0]!.properties).not.toHaveProperty('note');
    expect(posthog.messages[0]!.properties).not.toHaveProperty('amount');
    expect(posthog.messages[1]!.properties).not.toHaveProperty('reason');
  });
});

describe('deterministyczny uuid', () => {
  it('ten sam klucz daje ten sam poprawny uuid; inna nazwa zdarzenia albo firma daje inny', async () => {
    const send = (event: AnalyticsEventName, dedupeKey: string) =>
      trackServer({ tenantId: TENANT, event, dedupeKey, timestamp: new Date('2026-10-30T10:00:00Z') });
    await send(ANALYTICS_EVENTS.trialStarted, TENANT);
    await send(ANALYTICS_EVENTS.trialStarted, TENANT);
    await send(ANALYTICS_EVENTS.trialEnded, TENANT);
    await send(ANALYTICS_EVENTS.trialStarted, 'inna-firma');
    const [a, b, c, d] = posthog.messages.map((m) => m.uuid);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(b).toBe(a);
    expect(c).not.toBe(a);
    expect(d).not.toBe(a);
    expect(posthog.sklejone()).toHaveLength(3);
  });

  it('bez klucza: SDK nadaje własny uuid (logowań nie sklejamy)', async () => {
    await trackServer({ userId: OWNER, event: ANALYTICS_EVENTS.loginCompleted });
    expect(posthog.messages[0]!.uuid).toBeUndefined();
  });
});

/**
 * Prawdziwy SDK z podstawionym `fetch`, bo decyzja stoi na tym, co naprawdę
 * wychodzi w żądaniu. SDK nie deduplikuje sam: przekazuje `uuid` (bez niego
 * nadaje świeży uuidv7) i `timestamp`, a skleja magazyn PostHoga po
 * (data z timestamp, nazwa, distinct id, uuid) — dlatego bramka wysyła oba.
 */
describe('prawdziwy klient posthog-node', () => {
  it('uuid, timestamp, $set i $set_once docierają do paczki wysyłanej do PostHoga', async () => {
    const batches: Array<{ batch: Array<Record<string, unknown> & { properties: Record<string, unknown> }> }> = [];
    const real = new PostHog('phc_unit_test', {
      host: 'https://posthog.invalid',
      flushAt: 1,
      flushInterval: 0,
      disableCompression: true,
      fetch: async (_url, options) => {
        batches.push(JSON.parse(String(options.body)));
        return { status: 200, text: async () => '{}', json: async () => ({}) };
      },
    });
    h.posthog = real;
    const timestamp = new Date('2026-10-30T10:00:00.000Z');
    const send = () => trackServer({
      tenantId: TENANT,
      event: ANALYTICS_EVENTS.trialStarted,
      dedupeKey: TENANT,
      timestamp,
      setPersonProperties: { plan: 'trial' },
    });
    await send();
    await send();
    await real.shutdown();

    const sent = batches.flatMap((b) => b.batch);
    expect(sent).toHaveLength(2);
    expect(sent[0]!.uuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(sent[1]!.uuid).toBe(sent[0]!.uuid);
    expect(new Date(String(sent[0]!.timestamp)).toISOString()).toBe(timestamp.toISOString());
    expect(sent[0]!.distinct_id).toBe(OWNER);
    expect(sent[0]!.properties.$set).toEqual({ plan: 'trial' });
    expect(sent[0]!.properties.$set_once).toMatchObject({ utm_source: 'google' });
    expect(sent[0]!.properties.$groups).toEqual({ tenant: TENANT });
  });
});

describe('strażnik: serwer wysyła wyłącznie przez bramkę', () => {
  const ROOT = join(__dirname, '..', '..');
  // Poza bramką klienta PostHog dotyka tylko to, co nie wysyła zdarzeń o użytkowniku:
  // fabryka i zamknięcie klienta, trasa testowa tylko w dev, nieużywane eksperymenty.
  const ALLOWED = new Set([
    'lib/analytics/server.ts',
    'lib/analytics/posthog-node-client.ts',
    'lib/analytics/posthog-process-shutdown.ts',
    'lib/analytics/experiments.ts',
    'lib/posthog-server.ts',
    'app/api/dev/posthog-test/route.ts',
  ]);

  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : walk(path);
      return /\.tsx?$/.test(name) ? [path] : [];
    });
  }

  it('nikt poza bramką nie sięga po klienta posthog-node', () => {
    const offenders = ['app', 'components', 'lib', 'hooks', 'scripts']
      .flatMap((dir) => walk(join(ROOT, dir)))
      .filter((file) => /getPostHogNodeClient|requirePostHogNodeClient|getPostHogClient|from 'posthog-node'/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(ROOT, file).replaceAll('\\', '/'))
      .filter((file) => !ALLOWED.has(file));
    expect(offenders).toEqual([]);
  });
});

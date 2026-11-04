import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A5 (osobne ustalenie z #259): `sendPushToUser` i `sendPushToTenant`
 * zamieniały błąd odczytu bazy (`push_subscriptions`, `memberships`) na
 * „brak subskrypcji” — `{ sent: 0, failed: 0 }` bez śladu. Chwilowa awaria
 * bazy = push po cichu nie wychodzi, a zadanie kończy się sukcesem, więc nic
 * go nie ponawia. Teraz błąd odczytu rzuca `PushReadError`: wołający
 * ponawia (powiadomienie o fakturze, OCR, płatność) albo łapie go jawnie
 * (skrzynka — „best effort”, certyfikat — mail już wyszedł).
 *
 * `sendPushToTenant` czyta subskrypcje wszystkich członków JEDNYM zapytaniem
 * przed pierwszą wysyłką: błąd w połowie nie może zostawić części wysłanej,
 * bo ponowienie zadania dałoby wtedy dubel (service worker: `renotify`).
 *
 * Prawdziwy moduł `lib/push/sender.ts`; atrapy: baza (tabele w pamięci
 * z wstrzykiwanym błędem odczytu) i `web-push`.
 */

type Row = Record<string, unknown>;

const m = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  /** Tabele, których odczyt kończy się błędem bazy — od N-tego odczytu (1 = pierwszy). */
  failFrom: {} as Record<string, number>,
  reads: {} as Record<string, number>,
  send: vi.fn(),
  rpc: vi.fn(),
}));

function client() {
  return {
    from(table: string) {
      const filters: Array<(r: Row) => boolean> = [];
      let patch: Row | null = null;
      const run = () => {
        if (patch) {
          for (const r of (m.tables[table] ?? []).filter((x) => filters.every((f) => f(x)))) Object.assign(r, patch);
          return { data: null, error: null };
        }
        m.reads[table] = (m.reads[table] ?? 0) + 1;
        const from = m.failFrom[table];
        if (from !== undefined && m.reads[table]! >= from) {
          return { data: null, error: { code: 'XX000', message: `${table}: connection terminated` } };
        }
        return { data: (m.tables[table] ?? []).filter((r) => filters.every((f) => f(r))).map((r) => ({ ...r })), error: null };
      };
      const q = {
        select: () => q,
        update: (p: Row) => { patch = p; return q; },
        eq: (k: string, v: unknown) => { filters.push((r) => r[k] === v); return q; },
        in: (k: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[k])); return q; },
        then: <A, B>(ok: (v: ReturnType<typeof run>) => A, fail?: (e: unknown) => B) => Promise.resolve(run()).then(ok, fail),
      };
      return q;
    },
    rpc: async (fn: string, args: unknown) => { m.rpc(fn, args); return { data: null, error: null }; },
  };
}

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => client() }));
vi.mock('web-push', () => ({ default: { setVapidDetails: vi.fn(), sendNotification: m.send } }));

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OWNER = '33333333-3333-4333-8333-333333333333';
const ACCOUNTANT = '44444444-4444-4444-8444-444444444444';
const KEYS = { p256dh: 'B' + 'A'.repeat(86), auth: 'A'.repeat(22) };
const PAYLOAD = { title: 'Faktura opłacona', body: 'FV/1', tag: 'payment-1' };

const sub = (id: string, userId: string, extra: Row = {}): Row => ({
  id, user_id: userId, endpoint: `https://fcm.googleapis.com/fcm/send/${id}`, ...KEYS,
  is_active: true, notify_invoice_accepted: true, notify_payment_received: true, ...extra,
});

async function sender() {
  return import('@/lib/push/sender');
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('VAPID_SUBJECT', 'mailto:pomoc@faktflow.pl');
  vi.stubEnv('NEXT_PUBLIC_VAPID_PUBLIC_KEY', 'fixture-public');
  vi.stubEnv('VAPID_PRIVATE_KEY', 'fixture-private');
  m.failFrom = {};
  m.reads = {};
  m.send.mockResolvedValue({ statusCode: 201 });
  m.tables = {
    memberships: [
      { organization_id: TENANT, user_id: OWNER, status: 'active' },
      { organization_id: TENANT, user_id: ACCOUNTANT, status: 'active' },
    ],
    push_subscriptions: [sub('s-owner', OWNER), sub('s-accountant', ACCOUNTANT)],
  };
});

afterEach(() => vi.unstubAllEnvs());

describe('sendPushToUser — błąd odczytu nie jest „brakiem subskrypcji”', () => {
  it('odczyt push_subscriptions pada → PushReadError, nic nie wysłane', async () => {
    m.failFrom.push_subscriptions = 1;
    const { sendPushToUser, PushReadError } = await sender();

    const run = sendPushToUser(OWNER, 'invoice_accepted', PAYLOAD);

    await expect(run).rejects.toBeInstanceOf(PushReadError);
    await expect(run).rejects.toMatchObject({ name: 'PushReadError', message: expect.stringMatching(/subskrypcji push/) });
    expect(m.send).not.toHaveBeenCalled();
  });

  it('prawdziwy brak subskrypcji → { sent: 0, failed: 0 } bez wyjątku (jak dotąd)', async () => {
    m.tables.push_subscriptions = [];
    const { sendPushToUser } = await sender();

    await expect(sendPushToUser(OWNER, 'invoice_accepted', PAYLOAD)).resolves.toEqual({ sent: 0, failed: 0 });
  });

  it('wysyła na aktywne subskrypcje użytkownika z włączonym typem', async () => {
    m.tables.push_subscriptions.push(sub('s-off', OWNER, { notify_invoice_accepted: false }), sub('s-dead', OWNER, { is_active: false }));
    const { sendPushToUser } = await sender();

    await expect(sendPushToUser(OWNER, 'invoice_accepted', PAYLOAD)).resolves.toEqual({ sent: 1, failed: 0 });
    expect(m.send.mock.calls.map((c) => (c[0] as { endpoint: string }).endpoint)).toEqual(['https://fcm.googleapis.com/fcm/send/s-owner']);
  });
});

describe('sendPushToTenant — błąd odczytu przed pierwszą wysyłką', () => {
  it('odczyt memberships pada → PushReadError, nic nie wysłane', async () => {
    m.failFrom.memberships = 1;
    const { sendPushToTenant, PushReadError } = await sender();

    await expect(sendPushToTenant(TENANT, 'payment_received', PAYLOAD)).rejects.toBeInstanceOf(PushReadError);
    expect(m.send).not.toHaveBeenCalled();
  });

  it('subskrypcje wszystkich członków JEDNYM odczytem — awaria przy drugim odczycie nie ma czego przerwać (dawniej: drugi członek po cichu bez pusha)', async () => {
    m.failFrom.push_subscriptions = 2;
    const { sendPushToTenant } = await sender();

    await expect(sendPushToTenant(TENANT, 'payment_received', PAYLOAD)).resolves.toEqual({ sent: 2, failed: 0 });
    expect(m.reads.push_subscriptions).toBe(1);
  });

  it('odczyt subskrypcji firmy pada → PushReadError, nic nie wysłane (żadnej połowy, którą ponowienie zdublowałoby)', async () => {
    m.failFrom.push_subscriptions = 1;
    const { sendPushToTenant, PushReadError } = await sender();

    await expect(sendPushToTenant(TENANT, 'payment_received', PAYLOAD)).rejects.toBeInstanceOf(PushReadError);
    expect(m.send).not.toHaveBeenCalled();
  });

  it('wysyła do aktywnych członków firmy (nie do nieaktywnych ani obcych), tylko aktywne subskrypcje z włączonym typem', async () => {
    m.tables.memberships.push({ organization_id: TENANT, user_id: 'left', status: 'removed' });
    m.tables.push_subscriptions.push(
      sub('s-left', 'left'),
      sub('s-other', 'other-user'),
      sub('s-owner-off', OWNER, { notify_payment_received: false }),
      sub('s-owner-dead', OWNER, { is_active: false }),
    );
    const { sendPushToTenant } = await sender();

    await expect(sendPushToTenant(TENANT, 'payment_received', PAYLOAD)).resolves.toEqual({ sent: 2, failed: 0 });
    expect(m.send.mock.calls.map((c) => (c[0] as { endpoint: string }).endpoint).sort()).toEqual([
      'https://fcm.googleapis.com/fcm/send/s-accountant',
      'https://fcm.googleapis.com/fcm/send/s-owner',
    ]);
  });

  it('firma bez aktywnych członków → { sent: 0, failed: 0 } bez odczytu subskrypcji', async () => {
    m.tables.memberships = [];
    const { sendPushToTenant } = await sender();

    await expect(sendPushToTenant(TENANT, 'payment_received', PAYLOAD)).resolves.toEqual({ sent: 0, failed: 0 });
    expect(m.reads.push_subscriptions).toBeUndefined();
  });

  it('bez konfiguracji VAPID → { sent: 0, failed: 0 } bez odczytów bazy', async () => {
    vi.stubEnv('VAPID_PRIVATE_KEY', '');
    vi.resetModules();
    const { sendPushToTenant } = await sender();

    await expect(sendPushToTenant(TENANT, 'payment_received', PAYLOAD)).resolves.toEqual({ sent: 0, failed: 0 });
    expect(m.reads).toEqual({});
  });
});

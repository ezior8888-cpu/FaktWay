import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';

import { historyClient, historyDb, type HistoryDb, type Row } from './helpers/historia-ksef-baza';

/**
 * Sesja 27 planu skalowania (JOB-11): pełne listy w cronach idą stronami po
 * kluczu. Atrapa PostgREST ucina KAŻDĄ odpowiedź SELECT do 1000 wierszy bez
 * błędu, jak produkcja (`PGRST_DB_MAX_ROWS`). Do tej sesji każdy z tych
 * cronów widział 1000 z 2500 firm, a reszta po cichu wypadała z cyklu:
 * skrzynka nie odpytywała połowy firm z KSeF, historia nie zakładała im
 * strumieni, Co-Pilot nie wysyłał paczek, a certyfikat wygasał bez ostrzeżenia.
 */

const m = vi.hoisted(() => ({
  db: null as unknown,
  jobEvents: [] as Array<{ name: string; data: { tenantId: string } }>,
  email: vi.fn(),
  push: vi.fn(),
  proposal: vi.fn(),
  audit: vi.fn(),
  slack: vi.fn(),
}));

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => m.db }));
vi.mock('@/lib/supabase/server', () => ({ createAdminClient: async () => m.db }));
vi.mock('@/lib/jobs/enqueue', () => ({
  sendJobEvent: vi.fn(async (event: { name: string; data: { tenantId: string } }) => {
    m.jobEvents.push(event);
    return { ids: ['id'] };
  }),
}));
vi.mock('@/lib/supabase/admin-queries', () => ({
  getTenantKsefCredentials: vi.fn(),
  readTenantOwnerContact: async (id: string) => ({ ownerUserId: `user-${id}`, email: `admin-${id}@firma.test` }),
}));
vi.mock('@/lib/email/send', () => ({ sendCertExpiryAlert: m.email }));
vi.mock('@/lib/push/sender', () => ({ sendPushToTenant: m.push }));
vi.mock('@/lib/flo/proposals', () => ({ createProposal: m.proposal }));
vi.mock('@/lib/alerts/slack', () => ({ sendSlackAlert: m.slack }));
vi.mock('@/lib/audit/log-system', () => ({ logAuditSystem: m.audit }));

import { runCertExpiryAlert } from '@/lib/jobs/runners/cert-expiry-alert';
import { runCoPilotMonthly } from '@/lib/jobs/runners/co-pilot-monthly';
import { runInboxPolling } from '@/lib/jobs/runners/inbox-polling';
import { runKsefHistorySync } from '@/lib/jobs/runners/ksef-history-sync';

// Atrapa w pamięci na 2500 firmach: lokalnie ok. 1 s na test, zapas na wolniejszy runner CI.
vi.setConfig({ testTimeout: 30_000 });

const FIRMS = 2500;
const MAX_ROWS = 1000;
const NOW = new Date('2026-10-05T06:00:00.000Z'); // 5. dnia, 8:00 w Warszawie — dzień paczek Co-Pilota
const DAY = 86_400_000;

/** uuid małymi literami — porządek napisów w JS = porządek uuid w Postgresie. */
const id = (n: number) => `${String(n).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
const settingsId = (n: number) => `${String(n).padStart(8, '0')}-bbbb-4bbb-8bbb-bbbbbbbbbbbb`;
/**
 * Kolejność wstawiania ≠ kolejność id: bez ORDER BY baza oddaje wiersze
 * w kolejności sterty, więc ucięte 1000 to przypadkowy podzbiór.
 * 7919 jest względnie pierwsze z 2500 — to permutacja 1..2500.
 */
const heapOrder = (count: number) => Array.from({ length: count }, (_, i) => ((i * 7919) % count) + 1);

function tenant(n: number, patch: Row = {}): Row {
  return {
    id: id(n), nip: String(1000000000 + n), name: `Firma ${n}`,
    ksef_credentials_encrypted: '\\x00', ksef_verified_at: '2026-09-01T00:00:00Z', ksef_verified_environment: 'test',
    ksef_certificate_expiry: '2099-01-01T00:00:00Z', business_started_on: null, deleted_at: null, is_active: true,
    ...patch,
  };
}

let db: HistoryDb;

function useDb(tables: Record<string, Row[]>): void {
  db = historyDb(tables, { maxRows: MAX_ROWS });
  m.db = historyClient(db);
}

/** Zapytania SELECT do tabeli (log atrapy). */
const selects = (table: string) => db.log.filter((e) => e.table === table && e.op === 'select');
/** Najdłuższa lista `in.(…)` po firmach w zapytaniach do tabeli. */
function longestTenantIn(table: string): number {
  const sizes = db.log
    .filter((e) => e.table === table)
    .flatMap((e) => e.filters.filter((f) => f.startsWith('tenant_id=in.(')).map((f) => f.split(',').length));
  return Math.max(0, ...sizes);
}

/** N-te zapytanie SELECT do tabeli kończy się błędem bazy (pozostałe działają). */
function failNthSelect(table: string, nth: number): void {
  const client = historyClient(db);
  let calls = 0;
  m.db = {
    ...client,
    from(name: string) {
      const q = client.from(name) as ReturnType<typeof client.from> & { then: unknown };
      if (name !== table) return q;
      calls += 1;
      if (calls === nth) {
        q.then = (ok: (v: unknown) => unknown, fail?: (e: unknown) => unknown) =>
          Promise.resolve({ data: null, count: null, error: { message: 'canceling statement due to statement timeout' } }).then(ok, fail);
      }
      return q;
    },
  };
}

function context(sendEvent = vi.fn()): JobContext {
  return {
    attempt: 0,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    step: { run: async (_n, fn) => fn(), sleep: vi.fn(), sendEvent, scheduleAfter: vi.fn() },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  m.jobEvents = [];
  m.email.mockResolvedValue({ sent: true });
  m.push.mockResolvedValue({ sent: 1, failed: 0 });
  m.proposal.mockResolvedValue({ status: 'created' });
});

afterEach(() => vi.useRealTimers());

describe('skrzynka KSeF (cron.inbox-polling)', () => {
  it(`${FIRMS} firm z KSeF → ${FIRMS} zadań inbox/poll.tenant, każda firma raz, jedno wysłanie po całej liście`, async () => {
    useDb({ tenants: heapOrder(FIRMS).map((n) => tenant(n)) });
    const sendEvent = vi.fn();
    await expect(runInboxPolling(context(sendEvent))).resolves.toEqual({ polled: FIRMS });

    expect(sendEvent).toHaveBeenCalledTimes(1);
    const events = sendEvent.mock.calls[0]![1] as Array<{ groupId: string; data: { tenantId: string; nip: string } }>;
    expect(new Set(events.map((e) => e.data.tenantId)).size).toBe(FIRMS);
    expect(events.every((e) => e.groupId === e.data.nip)).toBe(true);
    // 5 stron po 500 + pusta strona na koniec.
    expect(selects('tenants')).toHaveLength(6);
  });

  it('błąd odczytu strony 2 — cron rzuca i nie wysyła NIC (ponowienie nie zdubluje zadań)', async () => {
    useDb({ tenants: heapOrder(FIRMS).map((n) => tenant(n)) });
    failNthSelect('tenants', 2);
    const sendEvent = vi.fn();
    await expect(runInboxPolling(context(sendEvent))).rejects.toThrow('Failed to list tenants: canceling statement');
    expect(sendEvent).not.toHaveBeenCalled();
  });
});

describe('historia KSeF (cron.ksef-history-sync)', () => {
  // Firmy 1–2000: bez strumieni (nowe), 1–1200 z HWM skrzynki (dostają też
  // strumień zakupów). Firmy 2001–2500: wygasły certyfikat i istniejący
  // strumień sprzedaży — cron ma im zapisać `certificate_expired`.
  const EXPIRED_FROM = 2001;
  const WITH_HWM = 1200;

  function historyTables(): Record<string, Row[]> {
    const order = heapOrder(FIRMS);
    return {
      tenants: order.map((n) => tenant(n, n >= EXPIRED_FROM ? { ksef_certificate_expiry: '2026-09-30T00:00:00Z' } : {})),
      ksef_history_sync: order.filter((n) => n >= EXPIRED_FROM).map((n) => ({
        id: `${String(n).padStart(8, '0')}-cccc-4ccc-8ccc-cccccccccccc`, tenant_id: id(n), environment: 'test', direction: 'outgoing',
        history_floor: '2022-01-01T00:00:00.000Z', boundary_at: '2026-09-01T00:00:00.000Z',
        backfill_window_end: '2026-09-01T00:00:00.000Z', backfill_cursor: '2026-06-01T00:00:00.000Z', backfill_page_offset: 0,
        backfill_completed_at: null, backfill_issue: null, backfill_issue_at: null, live_hwm: '2026-09-01T00:00:00.000Z',
        live_page_offset: 0, live_checked_at: null, paused_until: null, client_paused_at: null, lease_until: null,
        last_enqueued_at: null, last_run_at: null, last_error_code: null, consecutive_failures: 0,
        updated_at: '2026-10-01T00:00:00.000Z',
      })),
      ksef_history_items: [],
      ksef_inbox_cursor: order.filter((n) => n <= WITH_HWM).map((n) => ({ tenant_id: id(n), window_to: '2026-10-05T05:45:00.000Z' })),
    };
  }

  it(`${FIRMS} firm → komplet strumieni, wygasłe certyfikaty zapisane, każda firma z pracą w planie fan-outu`, async () => {
    useDb(historyTables());
    const sendEvent = vi.fn().mockResolvedValue(undefined);
    const result = await runKsefHistorySync(context(sendEvent));

    expect(result.tenants).toBe(FIRMS);
    const streams = db.tables.ksef_history_sync!;
    const outgoing = new Set(streams.filter((s) => s.direction === 'outgoing').map((s) => s.tenant_id));
    const incoming = new Set(streams.filter((s) => s.direction === 'incoming').map((s) => s.tenant_id));
    expect(outgoing.size).toBe(FIRMS);
    expect(incoming.size).toBe(WITH_HWM);
    expect(result.created).toBe(EXPIRED_FROM - 1 + WITH_HWM);
    expect(result.certificateExpired).toBe(FIRMS - EXPIRED_FROM + 1);
    expect(streams.filter((s) => s.last_error_code === 'certificate_expired')).toHaveLength(FIRMS - EXPIRED_FROM + 1);
    // Każda firma z ważnym certyfikatem ma otwartą zaległość: albo zlecona, albo czeka na sloty.
    expect(result.enqueued + result.deferredByCap).toBe(EXPIRED_FROM - 1);
    expect(sendEvent).toHaveBeenCalledTimes(result.enqueued);
  });

  it('zapytania zależne od strony firm: `in.(…)` najwyżej 100 firm (strumienie), 21 (liczniki) — adres i limit 1000', async () => {
    useDb(historyTables());
    await runKsefHistorySync(context(vi.fn().mockResolvedValue(undefined)));
    expect(longestTenantIn('ksef_history_sync')).toBeLessThanOrEqual(100);
    expect(longestTenantIn('ksef_inbox_cursor')).toBeLessThanOrEqual(100);
    expect(longestTenantIn('ksef_history_item_counts')).toBeLessThanOrEqual(21);
    // Ani jednego odczytu strumieni czy liczników dla całego środowiska naraz.
    expect(selects('ksef_history_sync').filter((e) => !e.filters.some((f) => f.startsWith('tenant_id=')) && !e.filters.some((f) => f.startsWith('rate_limited_at=')))).toEqual([]);
    expect(selects('ksef_history_item_counts').every((e) => e.filters.some((f) => f.startsWith('tenant_id=in.(')))).toBe(true);
  });

  it('drugi cykl niczego nie dubluje', async () => {
    useDb(historyTables());
    await runKsefHistorySync(context(vi.fn().mockResolvedValue(undefined)));
    const again = await runKsefHistorySync(context(vi.fn().mockResolvedValue(undefined)));
    expect(again.created).toBe(0);
    expect(again.certificateExpired).toBe(0);
    expect(db.tables.ksef_history_sync).toHaveLength(FIRMS + WITH_HWM);
  });
});

describe('Co-Pilot (cron.co-pilot-monthly)', () => {
  it(`${FIRMS} firm z dniem wysyłki 5 → ${FIRMS} paczek dla księgowej`, async () => {
    useDb({
      accountant_settings: heapOrder(FIRMS).map((n) => ({
        id: settingsId(n), tenant_id: id(n), co_pilot_enabled: true, send_day_of_month: 5,
        accountant_email: `ksiegowa-${n}@example.test`, accountant_name: 'Księgowa', preferred_formats: ['kpir_excel'],
        last_sent_period_start: null, last_sent_period_end: null,
      })),
    });
    const result = await runCoPilotMonthly(context());
    expect(result).toMatchObject({ processed: FIRMS, triggered: FIRMS, periodStart: '2026-09-01', periodEnd: '2026-09-30' });
    expect(new Set(m.jobEvents.map((e) => e.data.tenantId)).size).toBe(FIRMS);
  });
});

describe('certyfikat KSeF (cron.cert-expiry-alert)', () => {
  it('1500 firm z certyfikatem wygasającym za 20 dni → 1500 ostrzeżeń', async () => {
    const expiry = new Date(NOW.getTime() + 20 * DAY).toISOString();
    useDb({ tenants: heapOrder(1500).map((n) => tenant(n, { ksef_certificate_expiry: expiry })), audit_logs: [] });
    const result = await runCertExpiryAlert(context());
    expect(result.totalAlerts).toBe(1500);
    expect(new Set(m.email.mock.calls.map(([to]) => to)).size).toBe(1500);
    // Odczyt wysłanych progów — paczki po 100 firm (adres zapytania).
    expect(longestTenantIn('audit_logs')).toBeLessThanOrEqual(100);
  });
});

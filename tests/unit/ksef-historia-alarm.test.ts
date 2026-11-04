import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { historyClient, historyDb, streamRow, type HistoryDb, type Row } from './helpers/historia-ksef-baza';

/**
 * Alarmy synchronizacji historii KSeF (decyzja Bartosza 22.10.2026, punkt 8
 * krytyki): „stoi” (bez startu, bez sukcesu, zaległość bez postępu,
 * podejrzane poświadczenia), „faktury do operatora” (raz na dobę) i „429 u
 * wielu firm”. Błędy, które naprawia klient, nie budzą operatora; w alarmie
 * tylko liczby, bez NIP-ów.
 */

const m = vi.hoisted(() => ({ db: null as unknown, alertCritical: vi.fn(), cacheGet: vi.fn(), cacheSet: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => m.db }));
vi.mock('@/lib/alerts/slack', () => ({ alertCritical: m.alertCritical }));
vi.mock('@/lib/cache', () => ({ cacheGet: m.cacheGet, cacheSet: m.cacheSet }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('@/lib/jobs/events', () => ({}));

import {
  checkKsefHistoryBlocked,
  checkKsefHistoryRateLimited,
  checkStaleKsefHistorySync,
  KSEF_HISTORY_OPERATOR_REASONS,
  ksefHistoryStaleClasses,
} from '@/lib/jobs/runners/critical-alerts-monitor';
import { KSEF_HISTORY_RECHECK_BLOCKED_REASONS } from '@/lib/ksef/history-sync/db';

const NOW = new Date('2026-10-22T12:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000).toISOString();
const id = (n: number) => `${String(n).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
let db: HistoryDb;

const tenant = (n: number, patch: Row = {}): Row => ({
  id: id(n), nip: String(1000000000 + n), ksef_credentials_encrypted: '\\x00', ksef_verified_at: hoursAgo(48),
  ksef_verified_environment: 'test', deleted_at: null, is_active: true, ...patch,
});
const healthy = (n: number, patch: Row = {}): Row[] => [
  streamRow({ tenant_id: id(n), direction: 'outgoing', created_at: hoursAgo(48), last_success_at: hoursAgo(0.2), backfill_progress_at: hoursAgo(0.2), ...patch }),
  streamRow({ tenant_id: id(n), direction: 'incoming', live_hwm: null, created_at: hoursAgo(47), backfill_progress_at: hoursAgo(0.2) }),
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.stubEnv('KSEF_ENV', 'test');
  db = historyDb({ tenants: [tenant(1)], ksef_history_sync: healthy(1), ksef_history_items: [], ksef_inbox_cursor: [] });
  m.db = historyClient(db);
  m.cacheGet.mockResolvedValue(null);
  m.cacheSet.mockResolvedValue(true);
  m.alertCritical.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('„historia stoi” — klasy', () => {
  const classes = () => ksefHistoryStaleClasses({
    tenants: db.tables.tenants as never,
    streams: db.tables.ksef_history_sync as never,
    cursors: db.tables.ksef_inbox_cursor as never,
    now: NOW.getTime(),
  });

  it('zdrowa firma — zero we wszystkich klasach', () => {
    expect(Object.values(classes()).every((v) => v === 0)).toBe(true);
  });

  it('brak strumienia sprzedaży > 1 h od weryfikacji; brak zakupów > 2 h od startu', () => {
    db.tables.tenants = [tenant(1), tenant(2), tenant(3, { ksef_verified_at: hoursAgo(0.5) })];
    db.tables.ksef_history_sync = [healthy(1)[0]!];
    expect(classes()).toMatchObject({ noStartOutgoing: 1, noStartIncoming: 1 });
  });

  it('bez sukcesu > 6 h: liczy błąd po naszej stronie, nie liczy błędu klienta ani krótkiej pauzy 429', () => {
    db.tables.ksef_history_sync = healthy(1, { last_success_at: hoursAgo(7), last_error_code: 'ksef_unavailable' });
    expect(classes().stalled).toBe(1);
    db.tables.ksef_history_sync = healthy(1, { last_success_at: hoursAgo(7), last_error_code: 'credentials' });
    expect(classes().stalled).toBe(0);
    db.tables.ksef_history_sync = healthy(1, { last_success_at: hoursAgo(7), paused_until: hoursAgo(-1), rate_limit_hits: 1 });
    expect(classes().stalled).toBe(0);
    db.tables.ksef_history_sync = healthy(1, { last_success_at: hoursAgo(7), paused_until: hoursAgo(-1), rate_limit_hits: 4 });
    expect(classes().stalled).toBe(1);
    db.tables.ksef_history_sync = healthy(1, { last_success_at: hoursAgo(7), paused_until: hoursAgo(-7), rate_limit_hits: 1 });
    expect(classes().stalled).toBe(1);
  });

  it('zaległość bez postępu > 24 h (bez limitu i bez zakończonych)', () => {
    db.tables.ksef_history_sync = healthy(1, { backfill_progress_at: hoursAgo(25) });
    expect(classes().backfillStuck).toBe(1);
    db.tables.ksef_history_sync = healthy(1, { backfill_progress_at: hoursAgo(25), backfill_issue: 'capacity' });
    expect(classes().backfillStuck).toBe(0);
    db.tables.ksef_history_sync = healthy(1, { backfill_progress_at: hoursAgo(25), backfill_completed_at: hoursAgo(30) });
    expect(classes().backfillStuck).toBe(0);
  });

  it('podejrzane poświadczenia: skrzynka działa po błędzie historii albo ≥ 3 firmy i ≥ 20%', () => {
    db.tables.ksef_history_sync = healthy(1, { last_error_code: 'credentials', last_error_at: hoursAgo(2) });
    db.tables.ksef_inbox_cursor = [{ tenant_id: id(1), last_page_at: hoursAgo(1) }];
    expect(classes().credentialsSuspicious).toBe(1);
    db.tables.ksef_inbox_cursor = [{ tenant_id: id(1), last_page_at: hoursAgo(3) }];
    expect(classes().credentialsSuspicious).toBe(0);

    db.tables.tenants = [1, 2, 3, 4, 5].map((n) => tenant(n));
    db.tables.ksef_history_sync = [1, 2, 3, 4, 5].flatMap((n) => healthy(n, n <= 3 ? { last_error_code: 'credentials', last_error_at: hoursAgo(2) } : {}));
    expect(classes().credentialsSuspicious).toBe(3);
  });

  it('wstrzymane przez klienta — pomijane', () => {
    db.tables.ksef_history_sync = healthy(1, { last_success_at: hoursAgo(30), client_paused_at: hoursAgo(31), backfill_progress_at: hoursAgo(30) });
    expect(Object.values(classes()).every((v) => v === 0)).toBe(true);
  });
});

describe('alarmy w monitorze', () => {
  it('„stoi”: alarm z liczbami, bez NIP-ów; dedup 30 min', async () => {
    db.tables.ksef_history_sync = healthy(1, { last_success_at: hoursAgo(7), last_error_code: 'internal' });
    await expect(checkStaleKsefHistorySync()).resolves.toEqual({ type: 'stale_ksef_history_sync', fired: true });
    const [title, body, rich] = m.alertCritical.mock.calls[0]!;
    expect(title).toBe('Synchronizacja historii KSeF stoi');
    expect(body).toContain('scripts/ops/ksef-historia.sh stan');
    expect(JSON.stringify(m.alertCritical.mock.calls)).not.toContain('1000000001');
    expect(rich.fields).toContainEqual({ label: 'Bez sukcesu > 6 h', value: '1' });
    expect(m.cacheSet).toHaveBeenCalledWith(expect.stringContaining('stale_ksef_history_sync'), expect.any(String), 1800);
  });

  it('„stoi”: zdrowo — cisza', async () => {
    await expect(checkStaleKsefHistorySync()).resolves.toEqual({ type: 'stale_ksef_history_sync', fired: false });
    expect(m.alertCritical).not.toHaveBeenCalled();
  });

  it('„faktury do operatora”: tylko powody operatorskie + limit; dedup na dobę', async () => {
    db.tables.ksef_history_items = [
      { tenant_id: id(1), environment: 'test', direction: 'outgoing', status: 'blocked', reason_code: 'parse_failed', ksef_number: 'A' },
      { tenant_id: id(1), environment: 'test', direction: 'outgoing', status: 'blocked', reason_code: 'parse_failed', ksef_number: 'B' },
      { tenant_id: id(1), environment: 'test', direction: 'outgoing', status: 'blocked', reason_code: 'number_conflict', ksef_number: 'C' },
      { tenant_id: id(1), environment: 'test', direction: 'outgoing', status: 'blocked', reason_code: 'currency_not_supported', ksef_number: 'D' },
      { tenant_id: id(1), environment: 'production', direction: 'outgoing', status: 'blocked', reason_code: 'save_failed', ksef_number: 'E' },
    ];
    db.tables.ksef_history_sync = healthy(1, { backfill_issue: 'capacity' });
    await expect(checkKsefHistoryBlocked()).resolves.toEqual({ type: 'ksef_history_blocked', fired: true });
    const [, body, rich] = m.alertCritical.mock.calls[0]!;
    expect(body).toContain('ksef-historia.sh pozycje');
    expect(rich.fields).toEqual([
      { label: 'parse_failed', value: '2' },
      { label: 'Strumienie przy limicie 25 000', value: '1' },
    ]);
    expect(m.cacheSet).toHaveBeenCalledWith(expect.stringContaining('ksef_history_blocked'), expect.any(String), 86400);
  });

  // Strażnik ZAP-01 (ksef-historia-pobieranie.test.ts, reguła 4) dopuszcza dla posiadacza
  // spoza ksiąg każdy powód sprawdzany ponownie — wyjście ma tylko wtedy, gdy każdy poza
  // `number_conflict` (droga klienta: usuń szkic) budzi operatora (recenzja #339).
  it('każdy powód sprawdzany ponownie poza number_conflict budzi operatora', () => {
    const client = KSEF_HISTORY_RECHECK_BLOCKED_REASONS.filter((r) => !(KSEF_HISTORY_OPERATOR_REASONS as readonly string[]).includes(r));
    expect(client).toEqual(['number_conflict']);
  });

  it('„faktury do operatora”: tylko powody klienta — cisza', async () => {
    db.tables.ksef_history_items = [
      { tenant_id: id(1), environment: 'test', direction: 'outgoing', status: 'blocked', reason_code: 'number_conflict', ksef_number: 'C' },
    ];
    await expect(checkKsefHistoryBlocked()).resolves.toMatchObject({ fired: false });
  });

  it('„429 u wielu firm”: od 3 firm w godzinie (warunek bezpiecznika)', async () => {
    db.tables.ksef_history_sync = [1, 2].map((n) => streamRow({ tenant_id: id(n), direction: 'outgoing', rate_limited_at: hoursAgo(0.5) }));
    await expect(checkKsefHistoryRateLimited()).resolves.toMatchObject({ fired: false });
    db.tables.ksef_history_sync.push(streamRow({ tenant_id: id(3), direction: 'outgoing', rate_limited_at: hoursAgo(0.2) }));
    db.tables.ksef_history_sync.push(streamRow({ tenant_id: id(4), direction: 'outgoing', rate_limited_at: hoursAgo(2) }));
    await expect(checkKsefHistoryRateLimited()).resolves.toEqual({ type: 'ksef_history_rate_limited', fired: true });
    const [, body, rich] = m.alertCritical.mock.calls[0]!;
    expect(body).toContain('Wysyłka i skrzynka działają');
    expect(rich.fields).toEqual([{ label: 'Firmy z 429 w ostatniej godzinie', value: '3' }]);
  });

  it('błąd odczytu — rzuca (monitor zamienia to w check-error + Sentry)', async () => {
    db.failures.add('ksef_history_sync:select');
    await expect(checkStaleKsefHistorySync()).rejects.toBeTruthy();
    await expect(checkKsefHistoryRateLimited()).rejects.toBeTruthy();
  });
});

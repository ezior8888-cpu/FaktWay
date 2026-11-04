import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';

import { historyClient, historyDb, streamRow, type HistoryDb, type Row } from './helpers/historia-ksef-baza';

/**
 * `cron.ksef-history-sync` (decyzja Bartosza 22.10.2026): wybór firm,
 * zakładanie strumieni, wygasły certyfikat, reguły „należy się przebieg”,
 * globalny bezpiecznik 429, fan-out z `groupId` = NIP w limicie slotów.
 */

const m = vi.hoisted(() => ({ db: null as unknown, sendEvent: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => m.db }));
vi.mock('@/lib/supabase/server', () => ({ createAdminClient: () => m.db }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

import { runKsefHistorySync } from '@/lib/jobs/runners/ksef-history-sync';

const NOW = new Date('2026-10-22T10:11:00.000Z');
const id = (n: number) => `${String(n).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
let db: HistoryDb;

const ctx: JobContext = {
  attempt: 0,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  step: { run: async (_n, fn) => fn(), sleep: vi.fn(), sendEvent: m.sendEvent, scheduleAfter: vi.fn() },
};

function tenant(n: number, patch: Row = {}): Row {
  return {
    id: id(n), nip: String(1000000000 + n), ksef_credentials_encrypted: '\\x00', ksef_verified_at: '2026-09-01T00:00:00Z',
    ksef_verified_environment: 'test', ksef_certificate_expiry: '2099-01-01T00:00:00Z', business_started_on: null,
    deleted_at: null, is_active: true, ...patch,
  };
}

const sent = () => m.sendEvent.mock.calls.map(([, event]) => event as { name: string; groupId: string; data: { tenantId: string; nip: string; environment: string } });
const streamsOf = (n: number) => (db.tables.ksef_history_sync ?? []).filter((s) => s.tenant_id === id(n));

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  db = historyDb({ tenants: [], ksef_history_sync: [], ksef_history_items: [], ksef_inbox_cursor: [] });
  m.db = historyClient(db);
  m.sendEvent.mockResolvedValue(undefined);
});

afterEach(() => vi.useRealTimers());

describe('wybór firm i strumienie', () => {
  it('tylko firmy z certyfikatem, zweryfikowane w tym środowisku, aktywne i nieusunięte', async () => {
    db.tables.tenants = [
      tenant(1),
      tenant(2, { ksef_verified_environment: 'production' }),
      tenant(3, { deleted_at: '2026-10-01T00:00:00Z' }),
      tenant(4, { is_active: false }),
      tenant(5, { ksef_credentials_encrypted: null }),
      tenant(6, { ksef_verified_at: null }),
    ];
    const result = await runKsefHistorySync(ctx);
    expect(result).toMatchObject({ tenants: 1, enqueued: 1, breaker: false });
    expect(db.tables.ksef_history_sync!.map((s) => s.tenant_id)).toEqual([id(1)]);
    expect(sent()).toEqual([{
      name: 'ksef/history-sync.tenant', groupId: '1000000001',
      data: { tenantId: id(1), nip: '1000000001', environment: 'test' },
    }]);
  });

  it('strumień zakupów dopiero z HWM skrzynki (granica U); ponowienie niczego nie dubluje', async () => {
    db.tables.tenants = [tenant(1), tenant(2)];
    db.tables.ksef_inbox_cursor = [{ tenant_id: id(1), window_to: '2026-10-22T09:45:00.000Z' }];
    await runKsefHistorySync(ctx);
    expect(streamsOf(1).map((s) => s.direction).sort()).toEqual(['incoming', 'outgoing']);
    expect(streamsOf(1).find((s) => s.direction === 'incoming')).toMatchObject({ boundary_at: '2026-10-22T09:45:00.000Z', live_hwm: null });
    expect(streamsOf(2).map((s) => s.direction)).toEqual(['outgoing']);
    expect(streamsOf(1).find((s) => s.direction === 'outgoing')).toMatchObject({ boundary_at: '2026-10-22T09:11:00.000Z', live_hwm: '2026-10-22T09:11:00.000Z' });

    const again = await runKsefHistorySync(ctx);
    expect(again.created).toBe(0);
    expect(db.tables.ksef_history_sync).toHaveLength(3);
  });

  it('data rozpoczęcia działalności podnosi początek historii', async () => {
    db.tables.tenants = [tenant(1, { business_started_on: '2024-03-01' })];
    await runKsefHistorySync(ctx);
    expect(streamsOf(1)[0]).toMatchObject({ history_floor: '2024-02-29T22:00:00.000Z' });
  });

  it('klient poprawił datę rozpoczęcia na wcześniejszą — zakończona zaległość to znowu praca: przebieg wychodzi (początek obniża przebieg firmy pod dzierżawą)', async () => {
    const oldFloor = '2025-05-31T22:00:00.000Z';
    db.tables.tenants = [tenant(1, { business_started_on: '2019-03-01' }), tenant(2, { business_started_on: '2025-06-01' })];
    const done = {
      history_floor: oldFloor, backfill_window_end: oldFloor, backfill_cursor: oldFloor, backfill_page_offset: 0,
      backfill_completed_at: '2026-10-20T00:00:00.000Z', live_checked_at: '2026-10-22T10:00:00.000Z',
    };
    db.tables.ksef_history_sync = [
      streamRow({ tenant_id: id(1), direction: 'outgoing', ...done }),
      // Firma 2: data bez zmian — nic do roboty.
      streamRow({ tenant_id: id(2), direction: 'outgoing', ...done }),
    ];
    await runKsefHistorySync(ctx);
    expect(sent().map((e) => e.data.tenantId)).toEqual([id(1)]);
    // Kursorów cron nie rusza (robi to przebieg firmy pod dzierżawą — bez wyścigu z odkrywaniem).
    expect(streamsOf(1)[0]).toMatchObject({ history_floor: oldFloor, backfill_completed_at: '2026-10-20T00:00:00.000Z' });
  });

  it('nowy certyfikat wgrany (data ważności w przyszłości) — zapisany `certificate_expired` znika, przebieg wychodzi', async () => {
    db.tables.tenants = [tenant(1, { ksef_certificate_expiry: '2027-10-22T00:00:00Z' })];
    db.tables.ksef_history_sync = [streamRow({
      tenant_id: id(1), direction: 'outgoing', last_error_code: 'certificate_expired',
      last_error_at: '2026-10-20T00:00:00.000Z', consecutive_failures: 0,
    })];
    await expect(runKsefHistorySync(ctx)).resolves.toMatchObject({ enqueued: 1 });
    expect(streamsOf(1)[0]).toMatchObject({ last_error_code: null, last_error_at: null, consecutive_failures: 0 });
  });

  it('wygasły certyfikat — `certificate_expired` zapisany raz, bez przebiegu', async () => {
    db.tables.tenants = [tenant(1, { ksef_certificate_expiry: '2026-10-01T00:00:00Z' })];
    const first = await runKsefHistorySync(ctx);
    expect(first).toMatchObject({ enqueued: 0, certificateExpired: 1 });
    expect(streamsOf(1)[0]).toMatchObject({ last_error_code: 'certificate_expired', last_error_at: NOW.toISOString() });
    const second = await runKsefHistorySync(ctx);
    expect(second.certificateExpired).toBe(0);
    expect(m.sendEvent).not.toHaveBeenCalled();
  });
});

describe('reguły przebiegu', () => {
  const withStream = (patch: Row) => {
    db.tables.tenants = [tenant(1)];
    db.tables.ksef_history_sync = [streamRow({ tenant_id: id(1), direction: 'outgoing', ...patch })];
  };

  it.each([
    ['pauza klienta', { client_paused_at: '2026-10-21T00:00:00.000Z' }],
    ['pauza po 429', { paused_until: '2026-10-22T11:00:00.000Z' }],
    ['dzierżawa trwa', { lease_until: '2026-10-22T10:15:00.000Z' }],
    ['zlecenie czeka w kolejce', { last_enqueued_at: '2026-10-22T10:00:00.000Z', last_run_at: '2026-10-22T09:30:00.000Z' }],
  ])('%s — bez nowego zlecenia', async (_label, patch) => {
    withStream(patch);
    await expect(runKsefHistorySync(ctx)).resolves.toMatchObject({ enqueued: 0 });
  });

  it.each([
    ['pauza minęła', { paused_until: '2026-10-22T10:00:00.000Z' }],
    ['zlecenie wykonane', { last_enqueued_at: '2026-10-22T10:00:00.000Z', last_run_at: '2026-10-22T10:01:00.000Z' }],
    ['zlecenie zaginęło (> 1 h)', { last_enqueued_at: '2026-10-22T09:00:00.000Z', last_run_at: '2026-10-22T08:00:00.000Z' }],
  ])('%s — zlecenie wychodzi i ma znacznik', async (_label, patch) => {
    withStream(patch);
    await expect(runKsefHistorySync(ctx)).resolves.toMatchObject({ enqueued: 1 });
    expect(streamsOf(1)[0]!.last_enqueued_at).toBe(NOW.toISOString());
  });

  it('nic do roboty (zaległość zakończona, bieżące świeże, brak kolejki) — bez zlecenia', async () => {
    withStream({ backfill_completed_at: '2026-10-20T00:00:00.000Z', live_checked_at: '2026-10-22T10:00:00.000Z' });
    await expect(runKsefHistorySync(ctx)).resolves.toMatchObject({ enqueued: 0 });
  });

  it('błąd wysyłki zlecenia jednej firmy nie zatrzymuje pozostałych', async () => {
    db.tables.tenants = [tenant(1), tenant(2)];
    m.sendEvent.mockRejectedValueOnce(new Error('pg-boss chwilowo niedostępny'));
    const result = await runKsefHistorySync(ctx);
    expect(result.enqueued).toBe(1);
    expect(streamsOf(1)[0]!.last_enqueued_at).toBeNull();
    expect(streamsOf(2)[0]!.last_enqueued_at).toBe(NOW.toISOString());
  });
});

describe('bezpieczniki', () => {
  it('≥ 3 firmy z 429 w godzinie — bez fan-outu w tym cyklu', async () => {
    db.tables.tenants = [tenant(1), tenant(2), tenant(3), tenant(4)];
    db.tables.ksef_history_sync = [1, 2, 3].map((n) => streamRow({
      tenant_id: id(n), direction: 'outgoing', rate_limited_at: '2026-10-22T09:30:00.000Z',
    }));
    await expect(runKsefHistorySync(ctx)).resolves.toMatchObject({ breaker: true, enqueued: 0 });
    expect(m.sendEvent).not.toHaveBeenCalled();
  });

  it('dwie firmy z 429 — fan-out działa (pauzowane same czekają)', async () => {
    db.tables.tenants = [tenant(1), tenant(2), tenant(3)];
    db.tables.ksef_history_sync = [1, 2].map((n) => streamRow({
      tenant_id: id(n), direction: 'outgoing', rate_limited_at: '2026-10-22T09:30:00.000Z', paused_until: '2026-10-22T11:00:00.000Z',
    }));
    await expect(runKsefHistorySync(ctx)).resolves.toMatchObject({ breaker: false, enqueued: 1 });
    expect(sent().map((e) => e.data.tenantId)).toEqual([id(3)]);
  });

  it('limit slotów: firmy z dużą kolejką pobrań — część czeka na następny cykl', async () => {
    db.tables.tenants = Array.from({ length: 60 }, (_, i) => tenant(i + 1));
    db.tables.ksef_history_sync = db.tables.tenants.map((t) => streamRow({ tenant_id: t.id, direction: 'outgoing' }));
    db.tables.ksef_history_items = db.tables.tenants.flatMap((t) => Array.from({ length: 5 }, (_, k) => ({
      tenant_id: t.id, environment: 'test', direction: 'outgoing', status: 'pending', reason_code: null, ksef_number: `${String(t.id)}-${k}`,
    })));
    // Szacunek: 15 + 5 (zapytanie) + 7 × 5 (pobrania) = 55 s → 2340 / 55 = 42 firmy.
    const result = await runKsefHistorySync(ctx);
    expect(result).toMatchObject({ enqueued: 42, deferredByCap: 18 });
  });

  it('otwarta zaległość z pustą kolejką: szacunek z pełnym budżetem pobrań (odkrywanie zapełnia kolejkę w tym samym przebiegu)', async () => {
    db.tables.tenants = Array.from({ length: 60 }, (_, i) => tenant(i + 1));
    // Bieżąca sprzedaż sprawdzona — jedyne zapytanie przebiegu idzie w zaległość,
    // a pobrania od razu biorą to, co zapytanie znalazło.
    db.tables.ksef_history_sync = db.tables.tenants.map((t) => streamRow({
      tenant_id: t.id, direction: 'outgoing', live_checked_at: '2026-10-22T10:00:00.000Z',
    }));
    // Szacunek: 15 + 5 + 7 × 5 = 55 s (nie 20 s) → 42 firmy, nie 60.
    await expect(runKsefHistorySync(ctx)).resolves.toMatchObject({ enqueued: 42, deferredByCap: 18 });
  });

  it('zlecenia z poprzedniego cyklu jeszcze w kolejce zmniejszają czas slotów nowego cyklu', async () => {
    db.tables.tenants = Array.from({ length: 60 }, (_, i) => tenant(i + 1));
    db.tables.ksef_history_sync = db.tables.tenants.map((t, i) => streamRow({
      tenant_id: t.id, direction: 'outgoing', live_checked_at: '2026-10-22T10:00:00.000Z',
      // 20 firm czeka w kolejce od poprzedniego cyklu (zlecone, jeszcze nie ruszyły).
      ...(i < 20 ? { last_enqueued_at: '2026-10-22T09:56:00.000Z', last_run_at: '2026-10-22T09:41:00.000Z' } : {}),
    }));
    // 2340 s − 20 × 55 s w kolejce = 1240 s → 22 nowe firmy po 55 s.
    await expect(runKsefHistorySync(ctx)).resolves.toMatchObject({ enqueued: 22, deferredByCap: 18 });
  });
});

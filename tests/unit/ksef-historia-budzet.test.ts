import { beforeEach, describe, expect, it } from 'vitest';

import { estimateRunSeconds, planFanOut, readYieldSignals } from '@/lib/ksef/history-sync/budget';
import { FANOUT_SLOT_SECONDS, LOCAL_CONCURRENCY } from '@/lib/ksef/history-sync/constants';

import { historyClient, historyDb, type HistoryDb } from './helpers/historia-ksef-baza';

/**
 * Priorytet i pojemność historii KSeF (decyzja Bartosza 22.10.2026, punkt 4
 * i 5 krytyki): historia ustępuje wysyłce i skrzynce na podstawie stanu
 * lokalnego, a fan-out cyklu mieści się w 3 slotach × 13 min.
 */

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NOW = new Date('2026-10-22T10:00:00.000Z');
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

let db: HistoryDb;
const admin = () => historyClient(db) as unknown as Parameters<typeof readYieldSignals>[0];

beforeEach(() => {
  db = historyDb({
    invoices: [],
    ksef_inbox_cursor: [{ tenant_id: TENANT, window_to: ago(10) }],
    ksef_inbox_schedule: [],
  });
});

describe('sygnały ustępowania (tylko stan lokalny)', () => {
  it('nic w toku — historia może pytać KSeF', async () => {
    await expect(readYieldSignals(admin(), TENANT, NOW)).resolves.toEqual({ yieldAll: false, yieldDownloads: false, reasons: [] });
  });

  it.each(['queued', 'sending'])('faktura w wysyłce (%s) — żadnego wywołania KSeF', async (status) => {
    db.tables.invoices = [{ tenant_id: TENANT, direction: 'outgoing', ksef_status: status }];
    const s = await readYieldSignals(admin(), TENANT, NOW);
    expect(s.yieldAll).toBe(true);
    expect(s.reasons).toContain('wysyłka w toku');
  });

  it('świeże (≤ 15 min) sprawdzenie duplikatu 440 — ustępuje; starsze nie', async () => {
    db.tables.invoices = [{ tenant_id: TENANT, direction: 'outgoing', ksef_status: 'failed', last_error_code: 'KSEF_DUPLICATE_RECONCILE', updated_at: ago(5) }];
    expect((await readYieldSignals(admin(), TENANT, NOW)).yieldAll).toBe(true);
    db.tables.invoices = [{ tenant_id: TENANT, direction: 'outgoing', ksef_status: 'failed', last_error_code: 'KSEF_DUPLICATE_RECONCILE', updated_at: ago(30) }];
    expect((await readYieldSignals(admin(), TENANT, NOW)).yieldAll).toBe(false);
  });

  it('HWM skrzynki starszy niż 60 min — skrzynka nadrabia, historia czeka', async () => {
    db.tables.ksef_inbox_cursor = [{ tenant_id: TENANT, window_to: ago(61) }];
    const s = await readYieldSignals(admin(), TENANT, NOW);
    expect(s.yieldAll).toBe(true);
    expect(s.reasons).toContain('skrzynka nadrabia zaległość');
  });

  // Od harmonogramu skrzynki (00160) HWM firmy zimnej bywa starszy niż godzina
  // zgodnie z planem. Stały próg 60 min zatrzymałby historię takich firm na zawsze.
  it('firma zimna z HWM sprzed 5 h: to norma, historia pracuje', async () => {
    db.tables.ksef_inbox_cursor = [{ tenant_id: TENANT, window_to: ago(300) }];
    db.tables.ksef_inbox_schedule = [{ tenant_id: TENANT, activity_tier: 'cold' }];
    await expect(readYieldSignals(admin(), TENANT, NOW)).resolves.toMatchObject({ yieldAll: false });
  });

  it('firma uśpiona z HWM sprzed 20 h: to norma; sprzed 3 dni: skrzynka nadrabia', async () => {
    db.tables.ksef_inbox_schedule = [{ tenant_id: TENANT, activity_tier: 'dormant' }];
    db.tables.ksef_inbox_cursor = [{ tenant_id: TENANT, window_to: ago(20 * 60) }];
    expect((await readYieldSignals(admin(), TENANT, NOW)).yieldAll).toBe(false);
    db.tables.ksef_inbox_cursor = [{ tenant_id: TENANT, window_to: ago(3 * 24 * 60) }];
    expect((await readYieldSignals(admin(), TENANT, NOW)).reasons).toContain('skrzynka nadrabia zaległość');
  });

  it('firma gorąca z HWM sprzed 2 h: skrzynka nadrabia, jak dawniej', async () => {
    db.tables.ksef_inbox_cursor = [{ tenant_id: TENANT, window_to: ago(120) }];
    db.tables.ksef_inbox_schedule = [{ tenant_id: TENANT, activity_tier: 'hot' }];
    expect((await readYieldSignals(admin(), TENANT, NOW)).reasons).toContain('skrzynka nadrabia zaległość');
  });

  it('brak kursora skrzynki to nie zaległość', async () => {
    db.tables.ksef_inbox_cursor = [];
    expect((await readYieldSignals(admin(), TENANT, NOW)).yieldAll).toBe(false);
  });

  it('XML skrzynki w drodze (≤ 2 h) — bez pobrań, ale metadane wolno', async () => {
    db.tables.invoices = [{ tenant_id: TENANT, direction: 'incoming', created_at: ago(30), fa3_data: { _pendingFullFetch: true } }];
    const s = await readYieldSignals(admin(), TENANT, NOW);
    expect(s).toMatchObject({ yieldAll: false, yieldDownloads: true });
    db.tables.invoices = [{ tenant_id: TENANT, direction: 'incoming', created_at: ago(180), fa3_data: { _pendingFullFetch: true } }];
    expect((await readYieldSignals(admin(), TENANT, NOW)).yieldDownloads).toBe(false);
  });

  it('błąd odczytu rzuca — „nie wiem” to nie „można pytać KSeF”', async () => {
    db.failures.add('invoices:select');
    await expect(readYieldSignals(admin(), TENANT, NOW)).rejects.toThrow('sygnały ustępowania');
  });

  it('sygnały dotyczą tylko tej firmy', async () => {
    db.tables.invoices = [{ tenant_id: 'inna-firma', direction: 'outgoing', ksef_status: 'sending' }];
    expect((await readYieldSignals(admin(), TENANT, NOW)).yieldAll).toBe(false);
  });
});

describe('szacunek przebiegu', () => {
  it('15 s + 5 s na zapytanie + 7 s na pobranie, najwyżej 100 s', () => {
    expect(estimateRunSeconds({ metadataCalls: 0, downloads: 0 })).toBe(15);
    expect(estimateRunSeconds({ metadataCalls: 1, downloads: 0 })).toBe(20);
    expect(estimateRunSeconds({ metadataCalls: 1, downloads: 5 })).toBe(55);
    expect(estimateRunSeconds({ metadataCalls: 2, downloads: 10 })).toBe(95);
    expect(estimateRunSeconds({ metadataCalls: 2, downloads: 50 })).toBe(100);
  });
});

describe('plan fan-outu', () => {
  const candidates = (n: number, seconds: number) => Array.from({ length: n }, (_, i) => ({
    tenantId: `t-${i}`,
    lastRunAt: new Date(NOW.getTime() - (n - i) * 60_000).toISOString(),
    estimateSeconds: seconds,
  }));

  it('200 ciężkich firm po 100 s — 23 w cyklu (3 sloty × 13 min = 2340 s)', () => {
    expect(FANOUT_SLOT_SECONDS).toBe(2340);
    const { planned, deferred } = planFanOut(candidates(200, 100));
    expect(planned).toHaveLength(23);
    expect(deferred).toHaveLength(177);
  });

  it('200 firm tylko z bieżącą sprzedażą (20 s) — 117 w cyklu, reszta w następnym; przy co 29 min wszystkie mieszczą się w interwale', () => {
    const first = planFanOut(candidates(200, estimateRunSeconds({ metadataCalls: 1, downloads: 0 })));
    expect(first.planned).toHaveLength(117);
    // Następny cykl: obsłużone dostają nowy `last_run_at`, więc idą na koniec.
    const second = planFanOut([
      ...first.deferred,
      ...first.planned.map((c) => ({ ...c, lastRunAt: NOW.toISOString() })),
    ]);
    expect(second.planned.slice(0, first.deferred.length).map((c) => c.tenantId))
      .toEqual(first.deferred.map((c) => c.tenantId));
  });

  it('najdawniej obsłużone pierwsze; nigdy nieobsłużone przed wszystkimi', () => {
    const { planned } = planFanOut([
      { tenantId: 'swiezy', lastRunAt: '2026-10-22T09:59:00.000Z', estimateSeconds: 1000 },
      { tenantId: 'nowy', lastRunAt: null, estimateSeconds: 1000 },
      { tenantId: 'stary', lastRunAt: '2026-10-21T09:00:00.000Z', estimateSeconds: 1000 },
    ]);
    expect(planned.map((c) => c.tenantId)).toEqual(['nowy', 'stary']);
  });

  it('ostatni przebieg cyklu startuje przed progiem „zaległe” heartbeatu', () => {
    expect(FANOUT_SLOT_SECONDS / LOCAL_CONCURRENCY).toBeLessThan(15 * 60);
  });
});

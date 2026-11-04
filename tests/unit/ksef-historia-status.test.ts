import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  readKsefHistorySyncStatus,
  STATUS_ITEM_COLUMNS,
  STATUS_STREAM_COLUMNS,
} from '@/lib/ksef/history-sync/status';

import { historyClient, historyDb, itemRow, streamRow, type HistoryDb, type Row } from './helpers/historia-ksef-baza';

/**
 * Stan synchronizacji historii KSeF dla ekranu Import danych (decyzja
 * Bartosza 22.10.2026, punkt 6 krytyki): faza bez przesady („pobrana” tylko,
 * gdy nic nie czeka), tempo zmierzone, termin końca dopiero po przeszukaniu
 * historii, listy odłożonych i zablokowanych, okresy zmienione po eksporcie.
 * Czyta klientem sesji wyłącznie kolumny z GRANT (bez `detail`, `last_error_detail`).
 */

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NOW = new Date('2026-10-22T10:00:00.000Z');
let db: HistoryDb;

const read = () => readKsefHistorySyncStatus(historyClient(db) as never, TENANT, NOW);
async function status() {
  const r = await read();
  if (!r.ok) throw new Error('oczekiwano ok');
  return r.status;
}
const items = (n: number, patch: Row) => Array.from({ length: n }, (_, i) => itemRow({ tenant_id: TENANT, ksef_number: `K-${patch.status}-${patch.reason_code ?? ''}-${i}-${Math.random()}`, ...patch }));

beforeEach(() => {
  vi.stubEnv('KSEF_ENV', 'test');
  db = historyDb({
    ksef_history_sync: [],
    ksef_history_items: [],
    export_jobs: [],
    tenants: [{ id: TENANT, ksef_certificate_expiry: '2027-03-01T00:00:00Z' }],
  });
});

afterEach(() => vi.unstubAllEnvs());

describe('fazy strumieni', () => {
  it('bez wiersza — waiting (oba kierunki), floor domyślny', async () => {
    const s = await status();
    expect(s.outgoing).toMatchObject({ phase: 'waiting', enabledAt: null, coveredFrom: null, historyFloor: '2022-01-01T00:00:00.000Z' });
    expect(s.incoming.phase).toBe('waiting');
    expect(s.error).toBeNull();
  });

  it('searching — przeszukane od końca bieżącego okna; `co najmniej` liczy ekran', async () => {
    db.tables.ksef_history_sync = [streamRow({ tenant_id: TENANT, backfill_window_end: '2026-04-01T00:00:00.000Z' })];
    db.tables.ksef_history_items = items(3, { status: 'pending' });
    const s = await status();
    expect(s.outgoing).toMatchObject({ phase: 'searching', coveredFrom: '2026-04-01T00:00:00.000Z', estimatedFinishAt: null });
    expect(s.outgoing.counts.pending).toBe(3);
  });

  it('downloading — zaległość przeszukana, coś czeka (także odłożone); termin z tempa ≥ 1/h', async () => {
    db.tables.ksef_history_sync = [streamRow({ tenant_id: TENANT, backfill_completed_at: '2026-10-21T00:00:00.000Z' })];
    db.tables.ksef_history_items = [
      ...items(24, { status: 'pending' }),
      ...items(1, { status: 'deferred', reason_code: 'own_send_pending', next_attempt_at: '2026-10-22T11:00:00.000Z' }),
      ...items(12, { status: 'imported', resolved_at: '2026-10-22T08:00:00.000Z' }),
    ];
    const s = await status();
    expect(s.outgoing).toMatchObject({ phase: 'downloading', coveredFrom: '2022-01-01T00:00:00.000Z', measuredPerHour: 2 });
    expect(s.outgoing.estimatedFinishAt).toBe('2026-10-22T22:00:00.000Z');
  });

  it('live (sprzedaż) / done (zakupy) — tylko gdy nic nie czeka i nic nie odłożone', async () => {
    db.tables.ksef_history_sync = [
      streamRow({ tenant_id: TENANT, direction: 'outgoing', backfill_completed_at: '2026-10-21T00:00:00.000Z' }),
      streamRow({ tenant_id: TENANT, direction: 'incoming', live_hwm: null, backfill_completed_at: '2026-10-21T00:00:00.000Z' }),
    ];
    db.tables.ksef_history_items = items(2, { status: 'imported', resolved_at: '2026-10-01T00:00:00.000Z' });
    const s = await status();
    expect(s.outgoing.phase).toBe('live');
    expect(s.incoming.phase).toBe('done');
    expect(s.outgoing.measuredPerHour).toBeNull();
    expect(s.outgoing.estimatedFinishAt).toBeNull();
  });

  it('limit dziennika — odkrywanie uznane za skończone, `capacityReached`', async () => {
    db.tables.ksef_history_sync = [streamRow({ tenant_id: TENANT, backfill_issue: 'capacity' })];
    const s = await status();
    expect(s.outgoing).toMatchObject({ phase: 'live', capacityReached: true });
  });

  it('`stuck`: problem `internal` z ostatniej doby; starszy — nie', async () => {
    db.tables.ksef_history_sync = [streamRow({ tenant_id: TENANT, backfill_issue: 'internal', backfill_issue_at: '2026-10-22T05:00:00.000Z' })];
    expect((await status()).outgoing.stuck).toBe(true);
    db.tables.ksef_history_sync = [streamRow({ tenant_id: TENANT, live_issue: 'internal', live_issue_at: '2026-10-20T05:00:00.000Z' })];
    expect((await status()).outgoing.stuck).toBe(false);
  });

  it('downloading, ale nic nie czeka na pobranie (tylko odłożone) — bez terminu końca', async () => {
    db.tables.ksef_history_sync = [streamRow({ tenant_id: TENANT, backfill_completed_at: '2026-10-21T00:00:00.000Z' })];
    db.tables.ksef_history_items = [
      ...items(2, { status: 'deferred', reason_code: 'duplicate_decision', next_attempt_at: '2026-10-22T11:00:00.000Z' }),
      ...items(12, { status: 'imported', resolved_at: '2026-10-22T08:00:00.000Z' }),
    ];
    const s = await status();
    expect(s.outgoing).toMatchObject({ phase: 'downloading', measuredPerHour: 2, estimatedFinishAt: null });
  });

  it('liczniki: `imported` bez napraw, wycofane szkice osobno', async () => {
    db.tables.ksef_history_sync = [streamRow({ tenant_id: TENANT })];
    db.tables.ksef_history_items = [
      ...items(3, { status: 'imported' }),
      ...items(2, { status: 'imported', reason_code: 'repaired' }),
      ...items(1, { status: 'imported', reason_code: 'jpk_note' }),
      ...items(2, { status: 'skipped', reason_code: 'retired_draft' }),
      ...items(4, { status: 'skipped', reason_code: 'already_present' }),
    ];
    expect((await status()).outgoing.counts).toEqual({ pending: 0, imported: 4, repaired: 2, skipped: 4, retiredDraft: 2, deferred: 0, blocked: 0 });
  });
});

describe('stan firmy', () => {
  it('pauza po 429 tylko w przyszłości; pauza klienta; błąd z liczbą porażek > 0', async () => {
    db.tables.ksef_history_sync = [streamRow({
      tenant_id: TENANT, paused_until: '2026-10-22T10:30:00.000Z', client_paused_at: '2026-10-21T00:00:00.000Z',
      last_error_code: 'permission', last_error_at: '2026-10-22T09:00:00.000Z', consecutive_failures: 2, last_success_at: '2026-10-20T00:00:00.000Z',
    })];
    const s = await status();
    expect(s).toMatchObject({
      rateLimitedUntil: '2026-10-22T10:30:00.000Z', clientPausedAt: '2026-10-21T00:00:00.000Z',
      error: { code: 'permission', at: '2026-10-22T09:00:00.000Z', certificateExpiry: '2027-03-01T00:00:00Z' },
    });
    expect(s.incoming.lastSuccessAt).toBe('2026-10-20T00:00:00.000Z');
  });

  it('błąd bez porażek (po sukcesie) — brak; wygasły certyfikat — zawsze, dopóki certyfikat jest wygasły', async () => {
    db.tables.ksef_history_sync = [streamRow({ tenant_id: TENANT, last_error_code: 'ksef_unavailable', consecutive_failures: 0, paused_until: '2026-10-22T09:00:00.000Z' })];
    expect(await status()).toMatchObject({ error: null, rateLimitedUntil: null });
    db.tables.tenants = [{ id: TENANT, ksef_certificate_expiry: '2026-10-01T00:00:00Z' }];
    db.tables.ksef_history_sync = [streamRow({ tenant_id: TENANT, last_error_code: 'certificate_expired', consecutive_failures: 0, last_error_at: '2026-10-22T08:00:00.000Z' })];
    expect((await status()).error).toMatchObject({ code: 'certificate_expired', certificateExpiry: '2026-10-01T00:00:00Z' });
  });

  it('nowy certyfikat już wgrany (ważny) — zapisany `certificate_expired` nie wraca na ekran z przyszłą datą „wygasł”', async () => {
    db.tables.tenants = [{ id: TENANT, ksef_certificate_expiry: '2027-10-22T00:00:00Z' }];
    db.tables.ksef_history_sync = [streamRow({ tenant_id: TENANT, last_error_code: 'certificate_expired', consecutive_failures: 0, last_error_at: '2026-10-22T08:00:00.000Z' })];
    expect((await status()).error).toBeNull();
  });
});

describe('listy odłożonych i zablokowanych', () => {
  it('najnowsze 20 z sumą z liczników; pola dla ekranu bez `detail`', async () => {
    db.tables.ksef_history_sync = [streamRow({ tenant_id: TENANT })];
    db.tables.ksef_history_items = [
      ...Array.from({ length: 25 }, (_, i) => itemRow({
        tenant_id: TENANT, ksef_number: `B-${i}`, status: 'blocked', reason_code: 'number_conflict', invoice_id: `szkic-${i}`,
        detail: 'tajny szczegół operatora', updated_at: `2026-10-22T0${i % 10}:00:00.000Z`,
      })),
      itemRow({ tenant_id: TENANT, ksef_number: 'D-1', status: 'deferred', reason_code: 'duplicate_decision', next_attempt_at: '2026-10-22T11:00:00.000Z', invoice_id: 'faktura-440' }),
    ];
    const s = await status();
    expect(s.blockedTotal).toBe(25);
    expect(s.blocked).toHaveLength(20);
    expect(s.blocked[0]).toEqual({
      ksefNumber: expect.any(String), direction: 'outgoing', invoiceNumber: 'FV/1/09/2026', issueDate: '2026-09-10',
      counterpartyName: 'Nabywca', grossAmount: 123, currency: 'PLN', localInvoiceId: expect.stringMatching(/^szkic-/),
      updatedAt: '2026-10-22T09:00:00.000Z', reason: 'number_conflict',
    });
    expect(s.deferred).toEqual([expect.objectContaining({ ksefNumber: 'D-1', reason: 'duplicate_decision', localInvoiceId: 'faktura-440' })]);
    expect(s.deferredTotal).toBe(1);
    expect(JSON.stringify(s)).not.toContain('tajny');
  });
});

describe('okresy zmienione po eksporcie', () => {
  const exportJob = (patch: Row) => ({
    tenant_id: TENANT, status: 'completed', period_start: '2026-09-01', period_end: '2026-09-30',
    completed_at: '2026-10-05T10:00:00.000Z', include_issued: true, include_received: false, ...patch,
  });

  const imported = (n: string, patch: Row) => itemRow({ tenant_id: TENANT, ksef_number: n, status: 'imported', ...patch });

  it('liczy fakturę z okresu eksportu, kierunku, który eksport obejmował, pobraną po eksporcie', async () => {
    db.tables.export_jobs = [exportJob({})];
    db.tables.ksef_history_items = [
      imported('A', { issue_date: '2026-09-10', resolved_at: '2026-10-06T00:00:00.000Z', direction: 'outgoing' }),
      imported('B', { issue_date: '2026-09-11', resolved_at: '2026-10-04T00:00:00.000Z', direction: 'outgoing' }), // przed eksportem
      imported('C', { issue_date: '2026-09-12', resolved_at: '2026-10-06T00:00:00.000Z', direction: 'incoming' }), // eksport bez zakupów
      imported('D', { issue_date: '2026-08-12', resolved_at: '2026-10-06T00:00:00.000Z', direction: 'outgoing' }), // poza okresem
    ];
    expect((await status()).periodsChangedAfterExport).toEqual([{ period: '2026-09', count: 1 }]);
  });

  it('duża historia (> 2000 pobranych po eksporcie) — starszy wyeksportowany okres nie ginie, liczby dokładne (liczy baza)', async () => {
    db.tables.export_jobs = [exportJob({ period_start: '2025-03-01', period_end: '2026-09-30' })];
    db.tables.ksef_history_items = [
      ...Array.from({ length: 2_500 }, (_, i) => imported(`N-${i}`, { issue_date: '2026-09-15', resolved_at: '2026-10-06T00:00:00.000Z' })),
      // Pobrana ostatnia (zaległość idzie od najnowszych) — w starszym okresie eksportu.
      imported('STARA', { issue_date: '2025-03-20', resolved_at: '2026-10-07T00:00:00.000Z' }),
    ];
    const periods = (await status()).periodsChangedAfterExport;
    expect(periods).toEqual([{ period: '2026-09', count: 2_500 }, { period: '2025-03', count: 1 }]);
  });

  it('czytnik: eksporty z 24 miesięcy, najnowsze okresy pierwsze, najwyżej 12', async () => {
    db.tables.ksef_history_sync = [streamRow({ tenant_id: TENANT })];
    db.tables.export_jobs = [exportJob({ period_start: '2025-01-01', period_end: '2026-09-30', include_received: true })];
    db.tables.ksef_history_items = Array.from({ length: 14 }, (_, i) => itemRow({
      tenant_id: TENANT, ksef_number: `I-${i}`, status: 'imported', resolved_at: '2026-10-06T00:00:00.000Z',
      issue_date: `20${i < 9 ? '26' : '25'}-${String((i % 9) + 1).padStart(2, '0')}-15`,
    }));
    db.tables.ksef_history_items.push(itemRow({ tenant_id: TENANT, ksef_number: 'R-1', status: 'imported', reason_code: 'repaired', resolved_at: '2026-10-06T00:00:00.000Z', issue_date: '2026-09-15' }));
    const s = await status();
    expect(s.periodsChangedAfterExport).toHaveLength(12);
    expect(s.periodsChangedAfterExport[0]).toEqual({ period: '2026-09', count: 1 });
  });
});

describe('odporność i uprawnienia', () => {
  it('bez skonfigurowanego środowiska KSeF albo przy błędzie zapytania — ok:false', async () => {
    vi.stubEnv('KSEF_ENV', '');
    await expect(read()).resolves.toEqual({ ok: false });
    vi.stubEnv('KSEF_ENV', 'test');
    db.failures.add('ksef_history_sync:select');
    await expect(read()).resolves.toEqual({ ok: false });
  });

  it('czyta tylko kolumny z GRANT — nigdy `detail` ani `last_error_detail`', async () => {
    db.tables.ksef_history_sync = [streamRow({ tenant_id: TENANT })];
    db.tables.export_jobs = [{ tenant_id: TENANT, status: 'completed', period_start: '2026-09-01', period_end: '2026-09-30', completed_at: '2026-10-05T00:00:00.000Z', include_issued: true, include_received: true }];
    await read();
    const historySelects = db.log.filter((q) => q.table.startsWith('ksef_history'));
    expect(historySelects.length).toBeGreaterThan(0);
    for (const q of historySelects) {
      expect(q.columns, q.table).toBeDefined();
      expect(q.columns).not.toBe('*');
      expect(q.columns).not.toMatch(/\bdetail\b|last_error_detail/);
    }
    expect(STATUS_STREAM_COLUMNS).not.toMatch(/last_error_detail/);
    expect(STATUS_ITEM_COLUMNS.split(', ')).not.toContain('detail');
  });

  it('czyta tylko swoją firmę i bieżące środowisko', async () => {
    db.tables.ksef_history_sync = [
      streamRow({ tenant_id: 'inna-firma', backfill_completed_at: '2026-10-01T00:00:00.000Z' }),
      streamRow({ tenant_id: TENANT, environment: 'production', backfill_completed_at: '2026-10-01T00:00:00.000Z' }),
    ];
    expect((await status()).outgoing.phase).toBe('waiting');
  });
});

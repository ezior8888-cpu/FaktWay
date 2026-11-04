import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { historyClient, historyDb, streamRow, type HistoryDb } from './helpers/historia-ksef-baza';

/**
 * Wyłącznik właściciela „Wstrzymaj pobieranie historii” (decyzja Bartosza
 * 22.10.2026, punkt 12 krytyki): kluczem serwisowym na wierszu sprzedaży,
 * idempotentnie, z audytem. Roli nie sprawdza — robi to akcja serwera
 * (`requireOwner` + MFA, testy ekranu).
 */

const m = vi.hoisted(() => ({ db: null as unknown, audit: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => m.db }));
vi.mock('@/lib/audit/log', () => ({ logAudit: m.audit }));

import { clearKsefHistoryCertificateErrors, setKsefHistoryClientPause } from '@/lib/ksef/history-sync/client-pause';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NOW = new Date('2026-10-22T10:00:00.000Z');
let db: HistoryDb;
const outgoing = () => (db.tables.ksef_history_sync ?? []).filter((s) => s.direction === 'outgoing');

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  db = historyDb({ tenants: [{ id: TENANT, business_started_on: null }], ksef_history_sync: [] });
  m.db = historyClient(db);
});

afterEach(() => vi.useRealTimers());

describe('setKsefHistoryClientPause', () => {
  it('wstrzymanie zakłada brakujący strumień sprzedaży i zapisuje kto i kiedy (audyt)', async () => {
    await expect(setKsefHistoryClientPause({ tenantId: TENANT, environment: 'test', paused: true, userId: USER }))
      .resolves.toEqual({ ok: true, pausedAt: NOW.toISOString() });
    expect(outgoing()).toHaveLength(1);
    expect(outgoing()[0]).toMatchObject({ client_paused_at: NOW.toISOString(), client_paused_by: USER, environment: 'test' });
    expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'ksef.history.paused', tenantId: TENANT, userId: USER, metadata: expect.objectContaining({ changed: true }),
    }));
  });

  it('ponowne wstrzymanie zostawia pierwotną chwilę; wznowienie czyści; ponowne wznowienie nic nie zmienia', async () => {
    db.tables.ksef_history_sync = [streamRow({ tenant_id: TENANT, client_paused_at: '2026-10-20T08:00:00.000Z', client_paused_by: USER })];
    await expect(setKsefHistoryClientPause({ tenantId: TENANT, environment: 'test', paused: true, userId: USER }))
      .resolves.toEqual({ ok: true, pausedAt: '2026-10-20T08:00:00.000Z' });
    expect(m.audit).toHaveBeenLastCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ changed: false }) }));

    await expect(setKsefHistoryClientPause({ tenantId: TENANT, environment: 'test', paused: false, userId: USER }))
      .resolves.toEqual({ ok: true, pausedAt: null });
    expect(outgoing()[0]).toMatchObject({ client_paused_at: null, client_paused_by: null });
    expect(m.audit).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'ksef.history.resumed' }));

    await setKsefHistoryClientPause({ tenantId: TENANT, environment: 'test', paused: false, userId: USER });
    expect(m.audit).toHaveBeenLastCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ changed: false }) }));
    expect(outgoing()).toHaveLength(1);
  });

  it('błąd zapisu — `write-failed`, bez audytu', async () => {
    db.failures.add('ksef_history_sync:update');
    await expect(setKsefHistoryClientPause({ tenantId: TENANT, environment: 'test', paused: true, userId: USER }))
      .resolves.toEqual({ ok: false, reason: 'write-failed' });
    expect(m.audit).not.toHaveBeenCalled();
  });

  it('nieznana firma — `write-failed`', async () => {
    db.tables.tenants = [];
    await expect(setKsefHistoryClientPause({ tenantId: TENANT, environment: 'test', paused: true, userId: USER }))
      .resolves.toEqual({ ok: false, reason: 'write-failed' });
  });
});

describe('clearKsefHistoryCertificateErrors (po wgraniu nowego certyfikatu)', () => {
  it.each(['certificate_expired', 'credentials', 'permission'])('błąd naprawiany certyfikatem (%s) znika od razu — ekran nie każe wgrywać drugi raz', async (code) => {
    db.tables.ksef_history_sync = [streamRow({
      tenant_id: TENANT, last_error_code: code, last_error_detail: 'HTTP 401 /auth kody:-', last_error_at: '2026-10-22T09:00:00.000Z', consecutive_failures: 3,
    })];
    await expect(clearKsefHistoryCertificateErrors({ tenantId: TENANT, environment: 'test' })).resolves.toEqual({ ok: true, cleared: true });
    expect(outgoing()[0]).toMatchObject({ last_error_code: null, last_error_detail: null, last_error_at: null, consecutive_failures: 0 });
  });

  it('inne błędy (operatora, KSeF) i brak strumienia — bez zmian; ponowienie nic nie psuje', async () => {
    db.tables.ksef_history_sync = [streamRow({ tenant_id: TENANT, last_error_code: 'internal', consecutive_failures: 2 })];
    await expect(clearKsefHistoryCertificateErrors({ tenantId: TENANT, environment: 'test' })).resolves.toEqual({ ok: true, cleared: false });
    expect(outgoing()[0]).toMatchObject({ last_error_code: 'internal', consecutive_failures: 2 });
    db.tables.ksef_history_sync = [];
    await expect(clearKsefHistoryCertificateErrors({ tenantId: TENANT, environment: 'test' })).resolves.toEqual({ ok: true, cleared: false });
  });

  it('błąd zapisu — `ok: false` (wgranie certyfikatu i tak się udało; błąd zniknie po najbliższym przebiegu)', async () => {
    db.tables.ksef_history_sync = [streamRow({ tenant_id: TENANT, last_error_code: 'credentials', consecutive_failures: 1 })];
    db.failures.add('ksef_history_sync:update');
    await expect(clearKsefHistoryCertificateErrors({ tenantId: TENANT, environment: 'test' })).resolves.toEqual({ ok: false });
  });
});

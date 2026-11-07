import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ executeSql: vi.fn() }));
vi.mock('@/lib/jobs/boss', () => ({
  startBoss: async () => ({ getDb: () => ({ executeSql: mocks.executeSql }) }),
}));

import { buildTelegramReport } from '@/lib/jobs/runners/daily-summary-email';
import { readDbHealth, type DbHealth } from '@/lib/observability/db-health';
import type { DailyMetrics } from '@/lib/observability/business-metrics';

/**
 * Raport dzienny na Telegram (06:00) dostaje stan bazy, którego dotąd nie
 * miał: wiek ostatniej udanej kopii, rozmiar bazy i WAL trzymany przez slot
 * replikacji (Logflare na db-1 nie ma retencji, a slot potrafi trzymać
 * gigabajty WAL na dysku 40 GB). Te same progi co bramka (`/status`: kopia
 * starsza niż 26 h) i 2 GB dla WAL.
 */

const NOW = Date.parse('2026-11-07T05:00:00.000Z');
const metrics: DailyMetrics = {
  period: { from: '2026-11-06T05:00:00.000Z', to: '2026-11-07T05:00:00.000Z' },
  signups: 1, newTenants: 1, onboardingCompletions: 0, firstInvoiceCount: 0,
  invoicesIssued: 3, invoicesAccepted: 3, invoicesFailed: 0, invoicesOfflineQueued: 0,
  ocrJobsCompleted: 0, ksefDowntimeMinutes: 0, ksefMaxConsecutiveFailures: 0,
  totalAuditErrors: 0, totalInngestFailures: 0, paymentsSucceeded: 0, paymentsFailed: 0,
  paymentsTotalGrossPln: 0,
};
const healthy: DbHealth = {
  databaseBytes: 198 * 1024 ** 2,
  slotWalBytes: 300 * 1024 ** 2,
  slotName: 'supabase_logflare',
  backupAt: '2026-11-07T01:00:00.000Z',
  backupFailed24h: 0,
};

beforeEach(() => vi.resetAllMocks());

describe('raport dzienny: stan bazy', () => {
  it('pokazuje wiek kopii, rozmiar bazy i WAL slotu bez ostrzeżeń, gdy wszystko gra', () => {
    const report = buildTelegramReport(metrics, healthy, NOW);
    expect(report).toContain('Kopia bazy: 4 h temu');
    expect(report).toContain('Baza: 198 MB, WAL trzymany przez slot supabase_logflare: 300 MB');
    expect(report).not.toContain('⚠️');
  });

  it('ostrzega o starej kopii, porażkach i dużym WAL', () => {
    const report = buildTelegramReport(
      metrics,
      { ...healthy, backupAt: '2026-11-05T23:00:00.000Z', backupFailed24h: 2, slotWalBytes: 4.2 * 1024 ** 3 },
      NOW,
    );
    expect(report).toContain('Kopia bazy: 30 h temu ⚠️ nieaktualna, porażki 24 h: 2');
    expect(report).toContain('WAL trzymany przez slot supabase_logflare: 4,2 GB ⚠️');
  });

  it('brak udanej kopii i brak slotów', () => {
    const report = buildTelegramReport(metrics, { ...healthy, backupAt: null, slotWalBytes: 0, slotName: null }, NOW);
    expect(report).toContain('Kopia bazy: ⚠️ brak udanej kopii');
    expect(report).toContain('Baza: 198 MB, bez slotów replikacji trzymających WAL');
  });

  it('nieudany odczyt stanu bazy nie psuje raportu', () => {
    const report = buildTelegramReport(metrics, null, NOW);
    expect(report).toContain('Baza: ⚠️ odczyt stanu nieudany');
    expect(report).toContain('Faktury: wystawione 3');
  });
});

describe('readDbHealth', () => {
  it('czyta jednym zapytaniem przez połączenie pg-boss', async () => {
    mocks.executeSql.mockResolvedValue({
      rows: [{ db_bytes: '207618048', slot_wal_bytes: '314572800', slot_name: 'supabase_logflare', backup_at: new Date('2026-11-07T01:00:00Z'), backup_failed_24h: '0' }],
    });
    await expect(readDbHealth()).resolves.toEqual({
      databaseBytes: 207618048, slotWalBytes: 314572800, slotName: 'supabase_logflare',
      backupAt: '2026-11-07T01:00:00.000Z', backupFailed24h: 0,
    });
    expect(mocks.executeSql).toHaveBeenCalledOnce();
    expect(String(mocks.executeSql.mock.calls[0]?.[0])).toMatch(/pg_replication_slots/);
  });

  it('błąd bazy daje null (raport idzie dalej)', async () => {
    mocks.executeSql.mockRejectedValue(new Error('connection reset'));
    await expect(readDbHealth()).resolves.toBeNull();
  });
});

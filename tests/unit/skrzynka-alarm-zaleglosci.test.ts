import { beforeEach, describe, expect, it, vi } from 'vitest';

// AUD-18: niekompletne pobranie skrzynki było tylko linijką w logu. Monitor
// (co 5 min) alarmuje, gdy firmy nie dostają faktur.
//
// Od harmonogramu (00160) próg nie jest stałą liczbą godzin: firma zimna po 5 h
// jest w normie, firma gorąca po 2 h nie. Liczy baza (RPC), więc alarm działa
// też ponad limitem 1000 wierszy odpowiedzi. Scenariusze na prawdziwych
// terminach sprawdza też `tests/rls-skrzynka-harmonogram.test.ts`.

const mocks = vi.hoisted(() => ({
  alertCritical: vi.fn(),
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
  captureException: vi.fn(),
  counts: null as Record<string, number> | null,
  rpcArgs: [] as Array<Record<string, unknown>>,
  error: null as Error | null,
}));

vi.mock('@sentry/nextjs', () => ({ captureException: mocks.captureException }));
vi.mock('@/lib/alerts/slack', () => ({ alertCritical: mocks.alertCritical }));
vi.mock('@/lib/cache', () => ({ cacheGet: mocks.cacheGet, cacheSet: mocks.cacheSet }));
vi.mock('@/lib/jobs/events', () => ({ inngest: { createFunction: vi.fn() } }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name !== 'ksef_inbox_alarm_counts') return { data: null, error: { message: `nieznane RPC ${name}` } };
      mocks.rpcArgs.push(args);
      return mocks.error ? { data: null, error: mocks.error } : { data: [mocks.counts], error: null };
    },
  }),
}));

import { checkStaleInboxSync } from '@/lib/jobs/runners/critical-alerts-monitor';
import {
  INBOX_ALARM_FAILING_MARGIN_MS,
  INBOX_ALARM_HWM_MARGIN_MS,
  INBOX_ALARM_OVERDUE_MS,
  inboxExpectedGapSeconds,
  inboxExpectedMaxGapMs,
  nextInboxPollAfterSuccess,
} from '@/lib/ksef/inbox-schedule';

const NOW = new Date('2026-11-02T12:00:00Z');
const TENANT = '11111111-1111-4111-8111-111111111111';
const zero = { live: 1, overdue: 0, failing: 0, hwm_behind: 0, credentials: 0, rate_limited: 0, unscheduled: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('KSEF_ENV', 'test');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  mocks.cacheGet.mockResolvedValue(null);
  mocks.alertCritical.mockResolvedValue(undefined);
  mocks.error = null;
  mocks.counts = { ...zero };
  mocks.rpcArgs = [];
});

describe('alarm zaległości skrzynki KSeF', () => {
  it('wszystko zgodnie z harmonogramem: bez alarmu', async () => {
    expect(await checkStaleInboxSync()).toEqual({ type: 'stale_inbox_sync', fired: false });
    expect(mocks.alertCritical).not.toHaveBeenCalled();
  });

  it('progi idą z modułu konfiguracji, w sekundach, dla bieżącego środowiska', async () => {
    await checkStaleInboxSync();
    expect(mocks.rpcArgs[0]).toEqual({
      p_environment: 'test',
      p_overdue_seconds: INBOX_ALARM_OVERDUE_MS / 1000,
      p_failing_margin_seconds: INBOX_ALARM_FAILING_MARGIN_MS / 1000,
      p_hwm_margin_seconds: INBOX_ALARM_HWM_MARGIN_MS / 1000,
      p_expected_gap_seconds: inboxExpectedGapSeconds(),
    });
  });

  it.each([
    ['overdue', 'Termin minął ponad'],
    ['failing', 'Błędy po stronie KSeF albo naszej'],
    ['hwm_behind', 'HWM stoi'],
    ['unscheduled', 'Bez harmonogramu'],
  ])('%s: alarm z liczbą firm, bez NIP-ów', async (key, label) => {
    mocks.counts = { ...zero, [key]: 3 };
    expect(await checkStaleInboxSync()).toEqual({ type: 'stale_inbox_sync', fired: true });
    const [title, , opts] = mocks.alertCritical.mock.calls[0]!;
    expect(title).toContain('Skrzynka KSeF');
    const fields = (opts as { fields: Array<{ label: string; value: string }> }).fields;
    expect(fields.find((f) => f.label.startsWith(label))?.value).toBe('3');
    expect(JSON.stringify(mocks.alertCritical.mock.calls)).not.toContain('1234567890');
    expect(mocks.cacheSet).toHaveBeenCalled();
  });

  it('błędy certyfikatu naprawia klient: pojedyncze bez alarmu', async () => {
    mocks.counts = { ...zero, live: 100, credentials: 2 };
    expect((await checkStaleInboxSync()).fired).toBe(false);
  });

  it('podejrzanie dużo błędów certyfikatu (nasz klucz, nie klienci): alarm', async () => {
    mocks.counts = { ...zero, live: 10, credentials: 3 };
    expect((await checkStaleInboxSync()).fired).toBe(true);
    const fields = (mocks.alertCritical.mock.calls[0]![2] as { fields: Array<{ label: string; value: string }> }).fields;
    expect(fields.find((f) => f.label.startsWith('Podejrzane błędy certyfikatu'))?.value).toBe('3');
  });

  it('powtórka w oknie deduplikacji nie wysyła drugi raz', async () => {
    mocks.counts = { ...zero, overdue: 1 };
    mocks.cacheGet.mockResolvedValue('1');
    expect(await checkStaleInboxSync()).toEqual({ type: 'stale_inbox_sync', fired: false, reason: 'dedup' });
    expect(mocks.alertCritical).not.toHaveBeenCalled();
  });

  it('błąd odczytu: rzuca (monitor zamienia to w check-error + Sentry)', async () => {
    mocks.error = new Error('fixture offline');
    await expect(checkStaleInboxSync()).rejects.toThrow('fixture offline');
  });

  it('brak skonfigurowanego środowiska: nie ma czego liczyć', async () => {
    vi.stubEnv('KSEF_ENV', '');
    expect(await checkStaleInboxSync()).toEqual({ type: 'stale_inbox_sync', fired: false });
  });
});

describe('progi względem harmonogramu (rachunek, który RPC robi w bazie)', () => {
  const HOUR = 3_600_000;
  /** Termin firmy, która miała ostatni sukces `ago` temu i od tamtej pory nic. */
  const overdueBy = (tier: 'hot' | 'cold', ago: number) => {
    const lastPoll = new Date(NOW.getTime() - ago);
    return NOW.getTime() - nextInboxPollAfterSuccess({ tenantId: TENANT, tier, now: lastPoll }).getTime();
  };

  it('firma zimna po 5 h: termin jeszcze przed nami, bez alarmu', () => {
    expect(overdueBy('cold', 5 * HOUR)).toBeLessThan(INBOX_ALARM_OVERDUE_MS);
    // Także gdyby przebiegi padały: margines bez sukcesu przekracza 5 h.
    expect(5 * HOUR).toBeLessThan(inboxExpectedMaxGapMs('cold') + INBOX_ALARM_FAILING_MARGIN_MS);
  });

  it('firma gorąca po 2 h: termin minął ponad godzinę temu, alarm', () => {
    expect(overdueBy('hot', 2 * HOUR)).toBeGreaterThan(INBOX_ALARM_OVERDUE_MS);
    // I tak samo przy błędach: bez sukcesu dłużej niż odstęp poziomu + margines.
    expect(2 * HOUR).toBeGreaterThan(inboxExpectedMaxGapMs('hot') + INBOX_ALARM_FAILING_MARGIN_MS);
  });
});

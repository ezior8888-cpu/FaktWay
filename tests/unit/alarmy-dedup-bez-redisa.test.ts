import { afterEach, describe, expect, it, vi } from 'vitest';

import { markAlertDelivered, shouldSendAlert } from '@/lib/jobs/runners/critical-alerts-monitor';

/**
 * N2: deduplikacja alarmów krytycznych szła tylko przez Redis — gdy go
 * brakowało, ten sam alarm wychodził co 5 minut. Bez Redisa (lokalnie albo
 * przy jego awarii; na produkcji worker go ma — stan 23.10.2026) znacznik
 * „wysłano” trzyma pamięć procesu workera przez 30 minut.
 */

afterEach(() => {
  vi.useRealTimers();
});

describe('dedup alarmów bez Redisa', () => {
  it('po wysłaniu ten sam alarm milczy 30 minut, potem może iść znowu', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-02T03:00:00Z'));

    expect(await shouldSendAlert('test_n2')).toBe(true);
    await markAlertDelivered('test_n2');
    expect(await shouldSendAlert('test_n2')).toBe(false);

    vi.setSystemTime(new Date('2026-10-02T03:25:00Z'));
    expect(await shouldSendAlert('test_n2')).toBe(false);

    vi.setSystemTime(new Date('2026-10-02T03:31:00Z'));
    expect(await shouldSendAlert('test_n2')).toBe(true);
  });

  it('inny typ alarmu nie jest wyciszany', async () => {
    await markAlertDelivered('test_n2_a');
    expect(await shouldSendAlert('test_n2_b')).toBe(true);
  });
});

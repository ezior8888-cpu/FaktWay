import { beforeEach, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';
import { runKsefHealthCheck } from '@/lib/jobs/runners/ksef-health-check';

/** Plan „zero zgubionych faktur”, sesja B3: cron zapisuje obok pomiaru stan ogłoszony przez MF. */
const mocks = vi.hoisted(() => ({
  availability: vi.fn(),
  official: vi.fn(),
  record: vi.fn(),
}));

vi.mock('@sentry/nextjs', () => ({ addBreadcrumb: vi.fn() }));
vi.mock('@/lib/ksef/health-check', () => ({ checkKsefAvailability: mocks.availability }));
vi.mock('@/lib/ksef/latarnia', () => ({ fetchKsefOfficialStatus: mocks.official }));
vi.mock('@/lib/ksef/health-status', () => ({ recordKsefPing: mocks.record }));

const context = {
  step: { run: (_name: string, fn: () => unknown) => fn(), sleep: async () => undefined },
} as unknown as JobContext;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.availability.mockResolvedValue({ available: true, responseTime: 100 });
});

it('zapisuje stan MF przy każdym pomiarze', async () => {
  mocks.official.mockResolvedValue({ status: 'FAILURE', end: null });
  await runKsefHealthCheck(context);
  expect(mocks.record).toHaveBeenCalledTimes(2);
  expect(mocks.record.mock.calls[0]?.[1]).toMatchObject({
    available: true,
    official: { status: 'FAILURE', end: null },
  });
});

it('brak odpowiedzi Latarni nie zatrzymuje pomiaru KSeF', async () => {
  mocks.official.mockResolvedValue(null);
  await runKsefHealthCheck(context);
  expect(mocks.record.mock.calls[0]?.[1]).toMatchObject({ available: true, official: null });
});

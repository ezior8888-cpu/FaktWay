import { afterEach, beforeEach, expect, it, vi } from 'vitest';

/**
 * Plan skalowania 3000, sesja 1: `/api/ksef/health` przechodzi przez proxy
 * bez sesji (test `baner-ksef-proxy-bez-gotrue`). Bez pamięci w procesie
 * byłaby wtedy darmowym wzmacniaczem odczytów Redisa (HTTP na każde
 * żądanie), a bez cięcia pola `error` oddawałaby każdemu tekst dla operatora
 * (komunikaty sieci, adresy).
 */

const mocks = vi.hoisted(() => ({ cacheGet: vi.fn() }));
vi.mock('@/lib/cache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/cache')>()),
  cacheGet: mocks.cacheGet,
}));

const snapshot = {
  level: 'down',
  lastCheckedAt: '2026-10-29T10:00:00.000Z',
  responseTimeMs: null,
  consecutiveFailures: 4,
  isMfOutage: true,
  error: 'connect ECONNREFUSED 10.0.0.12:443 (fixture)',
  env: 'test',
};

async function get() {
  const { GET } = await import('@/app/api/ksef/health/route');
  return GET();
}

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-29T10:00:10Z'));
  mocks.cacheGet.mockResolvedValue(snapshot);
});
afterEach(() => vi.useRealTimers());

it('nie oddaje pola error ze snapshotu', async () => {
  const body = await (await get()).json();

  expect(body).not.toHaveProperty('error');
  expect(JSON.stringify(body)).not.toContain('ECONNREFUSED');
  expect(body).toEqual({
    level: 'down',
    lastCheckedAt: '2026-10-29T10:00:00.000Z',
    responseTimeMs: null,
    consecutiveFailures: 4,
    isMfOutage: true,
    env: 'test',
    stale: false,
  });
});

it('pozwala trzymać odpowiedź 15 s tylko przeglądarce, nie wspólnym cache’om', async () => {
  // `private`, bo alias `/api/ksef/health/` (bez przekierowania ukośnika)
  // trafia do tej samej trasy przez pełną bramkę proxy i może nieść
  // odświeżone ciasteczko sesji. Wspólny cache nie może tego przechować.
  const response = await get();
  expect(response.headers.get('cache-control')).toBe('private, max-age=15');
  expect(response.headers.get('set-cookie')).toBeNull();
});

it('pamięta odczyt Redisa w procesie przez 15 s', async () => {
  for (let i = 0; i < 50; i++) await get();
  expect(mocks.cacheGet).toHaveBeenCalledTimes(1);

  vi.advanceTimersByTime(14_999);
  await get();
  expect(mocks.cacheGet).toHaveBeenCalledTimes(1);

  vi.advanceTimersByTime(1);
  mocks.cacheGet.mockResolvedValue({ ...snapshot, level: 'operational', isMfOutage: false });
  const body = await (await get()).json();
  expect(mocks.cacheGet).toHaveBeenCalledTimes(2);
  expect(body.level).toBe('operational');
});

it('równoczesne żądania przy pustej pamięci czytają Redisa raz', async () => {
  await Promise.all(Array.from({ length: 20 }, () => get()));
  expect(mocks.cacheGet).toHaveBeenCalledTimes(1);
});

it('brak snapshotu (Redis padł) też jest pamiętany, żeby awaria nie mnożyła odczytów', async () => {
  mocks.cacheGet.mockResolvedValue(null);
  for (let i = 0; i < 10; i++) {
    const body = await (await get()).json();
    expect(body).toMatchObject({ level: 'operational', stale: true });
    expect(body).not.toHaveProperty('error');
  }
  expect(mocks.cacheGet).toHaveBeenCalledTimes(1);
});

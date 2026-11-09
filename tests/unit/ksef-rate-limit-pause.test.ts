import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

/**
 * L1a (plan „zero zgubionych faktur”, 08.11.2026): magazyn pauzy firmy po 429
 * (`lib/ksef/rate-limit-pause.ts`).
 *
 * Pauza musi przeżyć restart workera i obejmować drugi proces (ten sam adres
 * IP u MF), więc leży w Redisie; awaria Redisa nie może zatrzymać wysyłki
 * (fail-open na pamięć procesu). Atrapa tylko klienta Redisa (HTTP do SRH),
 * reszta prawdziwa: `ksefFetch` z atrapą `fetch`, kolejka per NIP.
 */

const r = vi.hoisted(() => {
  const state = {
    configured: true,
    /** Redis „wisi”: każde polecenie to obietnica bez końca. */
    hang: false,
    /** Odpowiedź GET jako liczba (domyślna deserializacja `@upstash/redis`). */
    numericGet: false,
    strings: new Map<string, string>(),
    zsets: new Map<string, Map<string, number>>(),
    calls: [] as Array<[string, ...unknown[]]>,
  };
  const never = () => new Promise<never>(() => {});
  const client = {
    get: async (key: string) => {
      state.calls.push(['get', key]);
      if (state.hang) return never();
      const value = state.strings.get(key);
      if (value === undefined) return null;
      return state.numericGet ? Number(value) : value;
    },
    set: async (key: string, value: string, opts?: { px?: number }) => {
      state.calls.push(['set', key, value, opts]);
      if (state.hang) return never();
      state.strings.set(key, value);
      return 'OK';
    },
    zadd: async (key: string, entry: { score: number; member: string }) => {
      state.calls.push(['zadd', key, entry]);
      if (state.hang) return never();
      const set = state.zsets.get(key) ?? new Map<string, number>();
      set.set(entry.member, entry.score);
      state.zsets.set(key, set);
      return 1;
    },
    zremrangebyscore: async (key: string, min: number, max: number) => {
      state.calls.push(['zremrangebyscore', key, min, max]);
      if (state.hang) return never();
      const set = state.zsets.get(key);
      let removed = 0;
      for (const [member, score] of set ?? []) {
        if (score >= min && score <= max) {
          set!.delete(member);
          removed += 1;
        }
      }
      return removed;
    },
    pexpire: async (key: string, ms: number) => {
      state.calls.push(['pexpire', key, ms]);
      if (state.hang) return never();
      return 1;
    },
    zcount: async (key: string, min: number, max: number | string) => {
      state.calls.push(['zcount', key, min, max]);
      if (state.hang) return never();
      const upper = max === '+inf' ? Infinity : Number(max);
      return [...(state.zsets.get(key)?.values() ?? [])].filter((s) => s >= min && s <= upper).length;
    },
  };
  return { state, client };
});

vi.mock('@/lib/cache/redis', () => ({
  isRedisConfigured: () => r.state.configured,
  getRedis: () => r.client,
}));

import {
  currentKsefNip,
  KSEF_PAUSE_DEFAULT_MS,
  KSEF_PAUSE_MAX_MS,
  KSEF_SEND_BRAKE_WINDOW_MS,
  ksefPausedUntil as pausedUntil,
  ksefPauseRetryError,
  ksefPauseWaitMs,
  ksefSendBrakeActive,
  ksefSendBrakeAllows,
  recordKsefRateLimit,
  runWithKsefNip,
} from '@/lib/ksef/rate-limit-pause';
import { decideRetry, MAX_WAIT_RETRIES } from '@/lib/jobs/retry';
import { isKsefLocalPause, isKsefRateLimitResponse, ksefFetch } from '@/lib/ksef/client';
import { ksefRateLimiter } from '@/lib/ksef/rate-limiter';

const NIP = '1234567890';
const PAUSE_KEY = `ff:ksef:pause:test:${NIP}`;
const BRAKE_KEY = 'ff:ksef:rl429:test';
const T0 = new Date('2026-11-09T09:00:00.000Z').getTime();

const nip = (n: number) => `12345${String(n).padStart(5, '0')}`;
const callsOf = (name: string) => r.state.calls.filter(([op]) => op === name);
const settle = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => e);

let warn: MockInstance<typeof console.warn>;

beforeEach(() => {
  r.state.configured = true;
  r.state.hang = false;
  r.state.numericGet = false;
  r.state.strings.clear();
  r.state.zsets.clear();
  r.state.calls = [];
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  warn.mockRestore();
});

describe('zapis pauzy po 429', () => {
  it('klucz ff:ksef:pause:<env>:<nip>, wartość = koniec pauzy w ms, TTL px = Retry-After', async () => {
    const until = await recordKsefRateLimit('test', NIP, 45_000);
    expect(until).toBe(T0 + 45_000);
    expect(callsOf('set')).toEqual([['set', PAUSE_KEY, String(T0 + 45_000), { px: 45_000 }]]);
    // Firma trafia do okna hamulca (sorted set z czasem 429).
    expect(r.state.zsets.get(BRAKE_KEY)?.get(NIP)).toBe(T0);
    expect(callsOf('pexpire')).toEqual([['pexpire', BRAKE_KEY, KSEF_SEND_BRAKE_WINDOW_MS]]);
  });

  it('429 bez (czytelnego) Retry-After: 60 s', async () => {
    const cases = [null, undefined, Number.NaN, 0, -5_000];
    for (const [i, retryAfter] of cases.entries()) {
      r.state.calls = [];
      // Każdy przypadek na innym NIP-ie, żeby „tylko wydłużanie” nie zasłoniło wyniku.
      const until = await recordKsefRateLimit('test', nip(10 + i), retryAfter);
      expect(until, `Retry-After ${String(retryAfter)}`).toBe(T0 + KSEF_PAUSE_DEFAULT_MS);
      expect((callsOf('set')[0]![3] as { px: number }).px).toBe(KSEF_PAUSE_DEFAULT_MS);
    }
    expect(KSEF_PAUSE_DEFAULT_MS).toBe(60_000);
  });

  it('bezpiecznik 24 h: absurdalny Retry-After przycięty do doby (nie do godziny)', async () => {
    const until = await recordKsefRateLimit('test', NIP, 48 * 3_600_000);
    expect(until).toBe(T0 + 24 * 3_600_000);
    expect(KSEF_PAUSE_MAX_MS).toBe(24 * 3_600_000);
    expect((callsOf('set')[0]![3] as { px: number }).px).toBe(24 * 3_600_000);
    // 2 h zostają 2 h (dawne obcięcie do 3600 s skracałoby czekanie poniżej blokady MF).
    const twoHours = await recordKsefRateLimit('test', nip(7), 2 * 3_600_000);
    expect(twoHours).toBe(T0 + 2 * 3_600_000);
  });

  it('tylko wydłużanie: krótszy Retry-After nie skraca pauzy, dłuższy ją przedłuża', async () => {
    const first = await recordKsefRateLimit('test', NIP, 120_000);
    vi.setSystemTime(T0 + 10_000);
    const shorter = await recordKsefRateLimit('test', NIP, 30_000);
    expect(shorter).toBe(first);
    expect(await pausedUntil('test', NIP)).toBe(first);
    // Redis bez zapisu krótszej wartości.
    expect(callsOf('set')).toHaveLength(1);
    expect(r.state.strings.get(PAUSE_KEY)).toBe(String(first));

    const longer = await recordKsefRateLimit('test', NIP, 300_000);
    expect(longer).toBe(T0 + 10_000 + 300_000);
    expect(callsOf('set')).toHaveLength(2);
    expect(callsOf('set')[1]).toEqual(['set', PAUSE_KEY, String(longer), { px: 300_000 }]);
  });

  it('dłuższa pauza innego procesu w Redisie nie jest nadpisywana krótszą', async () => {
    r.state.strings.set(PAUSE_KEY, String(T0 + 600_000));
    await recordKsefRateLimit('test', NIP, 30_000);
    expect(callsOf('set')).toHaveLength(0);
    expect(r.state.strings.get(PAUSE_KEY)).toBe(String(T0 + 600_000));
  });

  it('prawdziwa ścieżka: 429 z Retry-After: 45 w ksefFetch zapisuje pauzę, następne żądanie firmy nie wychodzi', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': '45' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const first = await settle(ksefRateLimiter.enqueue(NIP, () => ksefFetch('/sessions/online', { method: 'POST', env: 'test' })));
    expect(isKsefRateLimitResponse(first)).toBe(true);
    expect(callsOf('set')).toEqual([['set', PAUSE_KEY, String(T0 + 45_000), { px: 45_000 }]]);

    vi.setSystemTime(T0 + 44_000);
    const second = await settle(ksefRateLimiter.enqueue(NIP, () => ksefFetch('/sessions/online', { method: 'POST', env: 'test' })));
    expect(isKsefLocalPause(second)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('odczyt pauzy', () => {
  it('pauza zapisana przez inny proces (tylko w Redisie) zatrzymuje żądania tej firmy', async () => {
    r.state.strings.set(PAUSE_KEY, String(T0 + 30_000));
    expect(await pausedUntil('test', NIP)).toBe(T0 + 30_000);

    const fetchMock = vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const error = await settle(ksefRateLimiter.enqueue(NIP, () => ksefFetch('/sessions/online', { method: 'POST', env: 'test' })));
    expect(isKsefLocalPause(error)).toBe(true);
    expect((error as { retryAfterMs: number }).retryAfterMs).toBe(30_000);
    expect(fetchMock).not.toHaveBeenCalled();

    // Druga firma: bez pauzy, żądanie wychodzi.
    await ksefRateLimiter.enqueue(nip(2), () => ksefFetch('/sessions/online', { method: 'POST', env: 'test' }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('wartość jako liczba (deserializacja @upstash/redis) też działa; po końcu pauzy — brak pauzy', async () => {
    r.state.numericGet = true;
    r.state.strings.set(PAUSE_KEY, String(T0 + 30_000));
    expect(await pausedUntil('test', NIP)).toBe(T0 + 30_000);
    vi.setSystemTime(T0 + 31_000);
    expect(await pausedUntil('test', NIP)).toBeNull();
  });

  it('Redis czytany najwyżej co 5 s na firmę (odpytywanie statusu idzie co 2 s)', async () => {
    await pausedUntil('test', NIP);
    vi.setSystemTime(T0 + 2_000);
    await pausedUntil('test', NIP);
    vi.setSystemTime(T0 + 4_999);
    await pausedUntil('test', NIP);
    expect(callsOf('get')).toHaveLength(1);

    // Pauza z innego procesu w tym czasie: widoczna po odświeżeniu.
    r.state.strings.set(PAUSE_KEY, String(T0 + 60_000));
    vi.setSystemTime(T0 + 5_000);
    expect(await pausedUntil('test', NIP)).toBe(T0 + 60_000);
    expect(callsOf('get')).toHaveLength(2);

    // Inna firma ma własny termin odczytu.
    await pausedUntil('test', nip(3));
    expect(callsOf('get')).toHaveLength(3);
  });

  it('operator (`scripts/ops/ksef-pauza.sh zdejmij`): DEL klucza zdejmuje pauzę innego procesu po odświeżeniu odczytu', async () => {
    r.state.strings.set(PAUSE_KEY, String(T0 + 600_000));
    expect(await pausedUntil('test', NIP)).toBe(T0 + 600_000);
    r.state.strings.delete(PAUSE_KEY);
    vi.setSystemTime(T0 + 5_000);
    expect(await pausedUntil('test', NIP)).toBeNull();
  });

  it('…także pauzę zapisaną przez TEN proces: po odświeżeniu odczytu (≤ 5 s) Redis rozstrzyga (runbook hamulce-ksef.md)', async () => {
    const until = await recordKsefRateLimit('test', NIP, 600_000);
    expect(await pausedUntil('test', NIP)).toBe(until);
    r.state.strings.delete(PAUSE_KEY);
    vi.setSystemTime(T0 + 5_000);
    expect(await pausedUntil('test', NIP)).toBeNull();
  });

  it('bez Redisa (brak konfiguracji): pauza w pamięci procesu działa, Redis niewołany', async () => {
    r.state.configured = false;
    const until = await recordKsefRateLimit('test', NIP, 30_000);
    expect(await pausedUntil('test', NIP)).toBe(until);
    expect(r.state.calls).toHaveLength(0);
  });

  // Błąd znaleziony w przeglądzie L1a (zakres D), naprawiony: krótka pauza
  // tego procesu zasłaniała dłuższą pauzę innego procesu z Redisa przez okno
  // odświeżania odczytu (5 s).
  it('krótka pauza tego procesu nie skraca widoku dłuższej pauzy z Redisa', async () => {
    r.state.strings.set(PAUSE_KEY, String(T0 + 600_000));
    await recordKsefRateLimit('test', NIP, 1_000);
    vi.setSystemTime(T0 + 2_000);
    expect(await pausedUntil('test', NIP)).toBe(T0 + 600_000);
  });
});

describe('Redis wisi albo pada: fail-open na pamięć procesu', () => {
  it('wiszący Redis: zapis i odczyt kończą się po ok. 1 s, pauza działa z pamięci', async () => {
    vi.useRealTimers();
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    r.state.hang = true;

    let recorded: number | null = null;
    const record = recordKsefRateLimit('test', NIP, 30_000).then((v) => { recorded = v; });
    await vi.advanceTimersByTimeAsync(999);
    expect(recorded).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    await record;
    // Koniec pauzy liczony od chwili 429, nie od końca czekania na Redis.
    expect(recorded).toBe(T0 + 30_000);

    // Po oknie odświeżania odczyt idzie do wiszącego Redisa: po 1 s pamięć.
    vi.setSystemTime(T0 + 6_000);
    let read: number | null | undefined;
    const reading = pausedUntil('test', NIP).then((v) => { read = v; });
    await vi.advanceTimersByTimeAsync(1_000);
    await reading;
    expect(read).toBe(T0 + 30_000);

    // Firma bez pauzy w pamięci: wiszący Redis nie zatrzymuje żądania (fail-open).
    let free: number | null | undefined;
    const freeRead = pausedUntil('test', nip(4)).then((v) => { free = v; });
    await vi.advanceTimersByTimeAsync(1_000);
    await freeRead;
    expect(free).toBeNull();

    // Ostrzeżenie w logu najwyżej raz na minutę.
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('błąd Redisa przy zapisie nie rzuca; pauza zostaje w pamięci', async () => {
    const spy = vi.spyOn(r.client, 'get').mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(recordKsefRateLimit('test', NIP, 30_000)).resolves.toBe(T0 + 30_000);
    expect(await pausedUntil('test', NIP)).toBe(T0 + 30_000);
    spy.mockRestore();
  });
});

describe('hamulec wysyłki: wiele firm z 429 naraz', () => {
  it('od 5 różnych firm w 10 min; 429 tej samej firmy liczy się raz; po oknie gaśnie', async () => {
    r.state.configured = false;
    for (let i = 0; i < 4; i += 1) await recordKsefRateLimit('test', nip(i), 30_000);
    await recordKsefRateLimit('test', nip(0), 30_000);
    expect(await ksefSendBrakeActive('test')).toBe(false);

    vi.setSystemTime(T0 + 60_000);
    await recordKsefRateLimit('test', nip(4), 30_000);
    expect(await ksefSendBrakeActive('test')).toBe(true);
    // Inne środowisko osobno.
    expect(await ksefSendBrakeActive('production')).toBe(false);

    // 10 min po 429 firm 0–3 zostaje w oknie tylko firma 4 (429 minutę później).
    vi.setSystemTime(T0 + KSEF_SEND_BRAKE_WINDOW_MS + 1);
    expect(await ksefSendBrakeActive('test')).toBe(false);
  });

  it('firmy z 429 w innych procesach (Redis) też się liczą', async () => {
    const set = new Map<string, number>();
    for (let i = 0; i < 5; i += 1) set.set(nip(i), T0 - 60_000);
    // Stara firma spoza okna się nie liczy.
    set.set(nip(9), T0 - KSEF_SEND_BRAKE_WINDOW_MS - 1);
    r.state.zsets.set(BRAKE_KEY, set);
    expect(await ksefSendBrakeActive('test')).toBe(true);

    set.delete(nip(4));
    // Odczyt z pamięci przez 5 s, potem świeży.
    vi.setSystemTime(T0 + 5_000);
    expect(await ksefSendBrakeActive('test')).toBe(false);
  });

  it('w hamulcu przechodzi ok. co czwarte zadanie na minutę, deterministycznie', () => {
    const seeds = Array.from({ length: 400 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    const allowed = seeds.filter((s) => ksefSendBrakeAllows(s, T0)).length;
    expect(allowed / seeds.length).toBeGreaterThanOrEqual(0.15);
    expect(allowed / seeds.length).toBeLessThanOrEqual(0.35);
    // Ten sam seed w tej samej minucie — ten sam wynik; w innej minucie losuje od nowa.
    for (const s of seeds.slice(0, 20)) {
      expect(ksefSendBrakeAllows(s, T0 + 59_000)).toBe(ksefSendBrakeAllows(s, T0));
    }
    // Żadne zadanie nie czeka w hamulcu w nieskończoność: każde przechodzi w ciągu godziny.
    for (const s of seeds) {
      const minutes = Array.from({ length: 60 }, (_, m) => ksefSendBrakeAllows(s, T0 + m * 60_000));
      expect(minutes.some(Boolean), s).toBe(true);
    }
  });
});

describe('czekanie do końca pauzy', () => {
  it('ksefPauseWaitMs: nigdy krócej niż pozostała pauza, rozrzut tylko w górę', () => {
    for (const remaining of [0, 1, 999, 1_000, 30_000, 3_600_000, 24 * 3_600_000]) {
      for (const seed of ['a', 'faktura-1', 'faktura-2', NIP]) {
        const wait = ksefPauseWaitMs(remaining, seed);
        expect(wait, `${remaining} ${seed}`).toBeGreaterThanOrEqual(Math.max(1_000, remaining));
        // Rozrzut: 20% pozostałego czasu, najmniej 5 s, najwięcej 5 min.
        expect(wait).toBeLessThanOrEqual(Math.max(1_000, remaining + Math.min(300_000, Math.max(5_000, remaining * 0.2))) + 1);
      }
    }
    expect(ksefPauseWaitMs(-60_000, 'x')).toBeGreaterThanOrEqual(1_000);
  });

  it('ksefPauseRetryError z ujemnym albo NaN czasem nie rzuca; pauza nie zużywa próby ani odczekań', () => {
    const policy = { maxRetries: 5, getDelayMs: () => 30_000 };
    for (const remaining of [-1, -86_400_000, Number.NaN, Number.POSITIVE_INFINITY, 0]) {
      let error: ReturnType<typeof ksefPauseRetryError> | undefined;
      expect(() => { error = ksefPauseRetryError('pauza', remaining, 'faktura-1'); }, String(remaining)).not.toThrow();
      expect(error!.name).toBe('RetryAfterError');
      expect(error!.pause).toBe(true);
      expect(error!.countsAsAttempt).toBe(false);
      expect(Number.isFinite(error!.retryAfterMs)).toBe(true);
      expect(error!.retryAfterMs).toBeGreaterThanOrEqual(1_000);
      // Ostatnia próba i wyczerpane odczekania: pauza dalej ponawia bez zużycia.
      expect(decideRetry(error, 5, policy, MAX_WAIT_RETRIES, { sinceMs: null, nowMs: T0 })).toMatchObject({
        action: 'retry', nextAttempt: 5, nextWaits: MAX_WAIT_RETRIES,
      });
    }
    // Czas nieczytelny: domyślna minuta, nie natychmiast.
    expect(ksefPauseRetryError('pauza', Number.NaN, 'x').retryAfterMs).toBeGreaterThanOrEqual(KSEF_PAUSE_DEFAULT_MS);
    const cause = new Error('429');
    expect(ksefPauseRetryError('pauza', 1_000, 'x', cause).cause).toBe(cause);
  });
});

describe('kontekst NIP-u w kolejce firmy', () => {
  it('przy pełnej kolejce (11 zadań, 10 naraz) 11. zadanie widzi swój NIP, nie kontekst wywołującego', async () => {
    vi.useRealTimers();
    const queueNip = nip(50);
    const seen: Array<string | null> = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const task = (i: number) => async () => {
      seen[i] = currentKsefNip();
      await gate;
      return i;
    };

    // Pierwsze 10 wołane z kontekstu INNEJ firmy, 11. bez kontekstu.
    const first = Array.from({ length: 10 }, (_, i) =>
      runWithKsefNip('9999999999', () => ksefRateLimiter.enqueue(queueNip, task(i))));
    const eleventh = ksefRateLimiter.enqueue(queueNip, task(10));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(ksefRateLimiter.stats(queueNip)).toEqual({ size: 1, pending: 10 });
    expect(seen[10]).toBeUndefined();

    release();
    await Promise.all([...first, eleventh]);
    expect(seen).toHaveLength(11);
    expect(new Set(seen)).toEqual(new Set([queueNip]));
    // Poza zadaniem kontekstu nie ma.
    expect(currentKsefNip()).toBeNull();
  });
});

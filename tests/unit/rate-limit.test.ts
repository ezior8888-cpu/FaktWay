import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { checkRateLimit, hashIdentifier } from '@/lib/rate-limit';

/** Posortowany zbiór Upstash w pamięci: tylko polecenia, których używa limiter. */
const fakeRedis = vi.hoisted(() => {
  const sets = new Map<string, Map<string, number>>();
  const zset = (key: string) => {
    let set = sets.get(key);
    if (!set) sets.set(key, (set = new Map()));
    return set;
  };
  const client = {
    pipeline() {
      const operations: Array<() => number> = [];
      const pipe = {
        zremrangebyscore(key: string, min: number, max: number) {
          operations.push(() => {
            let removed = 0;
            for (const [member, score] of zset(key)) {
              if (score >= min && score <= max) {
                zset(key).delete(member);
                removed += 1;
              }
            }
            return removed;
          });
          return pipe;
        },
        zadd(key: string, entry: { score: number; member: string }) {
          operations.push(() => {
            zset(key).set(entry.member, entry.score);
            return 1;
          });
          return pipe;
        },
        zcard(key: string) {
          operations.push(() => zset(key).size);
          return pipe;
        },
        expire() {
          operations.push(() => 1);
          return pipe;
        },
        async exec() {
          return operations.map((operation) => operation());
        },
      };
      return pipe;
    },
    async zrange(key: string) {
      const oldest = [...zset(key)].sort((a, b) => a[1] - b[1])[0];
      return oldest ? [oldest[0], oldest[1]] : [];
    },
    async zrem(key: string, member: string) {
      return zset(key).delete(member) ? 1 : 0;
    },
  };
  return { client, sets };
});

vi.mock('@/lib/cache/redis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cache/redis')>();
  return { ...actual, getRedis: () => fakeRedis.client };
});

/**
 * TEST-3 (audyt przedlaunchowy): rate limiter chroni login/register/reset przed
 * brute-force. Krytyczne: (a) gdy Redisa brak, limit liczy pamięć procesu (AUD-62) —
 * rate-limit NIE może zablokować logowania całej apce; (b) hash identyfikatora — nie trzymamy
 * plaintext IP/email w Redis.
 */

const REDIS_ENV = ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'] as const;

describe('hashIdentifier — nie trzymamy plaintext', () => {
  it('deterministyczny dla tego samego wejścia', () => {
    expect(hashIdentifier('user@example.com')).toBe(hashIdentifier('user@example.com'));
  });

  it('case-insensitive (email normalizowany)', () => {
    expect(hashIdentifier('User@Example.COM')).toBe(hashIdentifier('user@example.com'));
  });

  it('różne wejścia ⇒ różne hashe', () => {
    expect(hashIdentifier('a@x.com')).not.toBe(hashIdentifier('b@x.com'));
  });

  it('wynik to 32 znaki hex, NIE zawiera plaintextu', () => {
    const h = hashIdentifier('sekretny@email.pl');
    expect(h).toMatch(/^[0-9a-f]{32}$/);
    expect(h).not.toContain('sekretny');
    expect(h).not.toContain('email');
  });

  it('192.168.1.1 (IP) też zahashowany', () => {
    const h = hashIdentifier('192.168.1.1');
    expect(h).not.toContain('192');
    expect(h).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('checkRateLimit — bez Redis limit w pamięci procesu (AUD-62)', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of REDIS_ENV) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of REDIS_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('brak Redis ⇒ pierwsze żądanie przechodzi, limit się liczy (fallback=true)', async () => {
    const r = await checkRateLimit({
      bucket: 'login',
      identifier: 'test@example.com',
      limit: 5,
      windowSeconds: 900,
    });
    expect(r.allowed).toBe(true);
    expect(r.fallback).toBe(true);
    expect(r.retryAfter).toBe(0);
    expect(r.remaining).toBe(4);
  });

  it('pierwsze żądanie w każdym kubełku przechodzi', async () => {
    for (const bucket of ['login', 'register', 'password_reset', 'support_chat'] as const) {
      const r = await checkRateLimit({ bucket, identifier: 'x', limit: 3, windowSeconds: 60 });
      expect(r.allowed).toBe(true);
      expect(r.fallback).toBe(true);
    }
  });
});

/**
 * Recenzja #361, pkt 4 (`ksef_certificate`): odmowa też dopisywała znacznik do okna, więc
 * kliknięcie w trakcie blokady ją wydłużało, a podany czas był za krótki. Teraz kubełek może
 * nie liczyć odmów (`countDenied: false`), a próba nieudana z winy KSeF wraca do limitu (`refund`).
 * Kubełki bez `countDenied` zachowują się jak dotąd.
 */
describe.each([
  ['pamięć procesu (Redis nieskonfigurowany)', false],
  ['Redis', true],
])('limit bez przedłużania blokady i ze zwrotem próby: %s', (_name, useRedis) => {
  const T0 = Date.parse('2026-11-03T10:00:00.000Z');
  const at = (seconds: number) => vi.setSystemTime(T0 + seconds * 1000);
  let counter = 0;
  /** Każdy test liczy na własnym kluczu: okna w pamięci procesu żyją między testami. */
  const config = (over: { limit?: number; countDenied?: boolean } = {}) => ({
    bucket: 'ksef_certificate' as const,
    identifier: `test-${useRedis ? 'redis' : 'pamiec'}-${(counter += 1)}-${Math.random()}`,
    limit: 5,
    windowSeconds: 3600,
    ...over,
  });

  beforeEach(() => {
    vi.useFakeTimers();
    fakeRedis.sets.clear();
    if (useRedis) {
      vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://redis.example.test');
      vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'unit-test-token');
    } else {
      vi.stubEnv('UPSTASH_REDIS_REST_URL', '');
      vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', '');
    }
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  /** 5 prób co minutę, potem blokada i klient, który klika w trakcie niej. */
  async function blockedThenClicking(cfg: ReturnType<typeof config>) {
    for (let minute = 0; minute < 5; minute += 1) {
      at(minute * 60);
      expect((await checkRateLimit(cfg)).allowed).toBe(true);
    }
    at(600);
    const denied = await checkRateLimit(cfg);
    for (const seconds of [900, 1500, 2400, 3300]) {
      at(seconds);
      expect((await checkRateLimit(cfg)).allowed).toBe(false);
    }
    return denied;
  }

  it('countDenied: false: odmowa niczego nie dopisuje, więc podany czas jest prawdziwy mimo kliknięć w trakcie blokady', async () => {
    const cfg = config({ countDenied: false });
    const denied = await blockedThenClicking(cfg);

    // Pierwsza próba była w t=0, okno trwa godzinę, odmowa w t=600: zostało 3000 s.
    expect(denied).toMatchObject({ allowed: false, remaining: 0, retryAfter: 3000 });
    at(3600);
    expect((await checkRateLimit(cfg)).allowed).toBe(true);
  });

  it('bez countDenied (inne kubełki): odmowy nadal liczą się do okna, jak dotąd', async () => {
    const cfg = config();
    const denied = await blockedThenClicking(cfg);

    expect(denied).toMatchObject({ allowed: false, retryAfter: 3000 });
    // Cztery kliknięcia w trakcie blokady zajęły sloty: w t=3600 nadal odmowa.
    at(3600);
    expect((await checkRateLimit(cfg)).allowed).toBe(false);
  });

  it('zwrot próby oddaje slot, a odmowa nie ma czego zwracać', async () => {
    const cfg = config({ limit: 1, countDenied: false });
    const first = await checkRateLimit(cfg);
    expect(first.allowed).toBe(true);
    expect(first.refund).toBeTypeOf('function');

    await first.refund!();
    const second = await checkRateLimit(cfg);
    expect(second.allowed).toBe(true);

    const third = await checkRateLimit(cfg);
    expect(third.allowed).toBe(false);
    expect(third.refund).toBeUndefined();
  });

  it('zwrot oddaje tylko własną próbę i tylko raz', async () => {
    const cfg = config({ limit: 2, countDenied: false });
    at(0);
    const a = await checkRateLimit(cfg);
    at(10);
    const b = await checkRateLimit(cfg);
    expect([a.allowed, b.allowed]).toEqual([true, true]);

    await b.refund!();
    await b.refund!();
    at(20);
    expect((await checkRateLimit(cfg)).allowed).toBe(true);
    at(30);
    expect((await checkRateLimit(cfg)).allowed).toBe(false);
    // Próba A (t=0) nadal liczy się do okna: slot wraca dopiero po godzinie.
    at(3601);
    expect((await checkRateLimit(cfg)).allowed).toBe(true);
  });

  it('zwrot działa także dla kubełka, który liczy odmowy', async () => {
    const cfg = config({ limit: 1 });
    const first = await checkRateLimit(cfg);
    await first.refund!();
    expect((await checkRateLimit(cfg)).allowed).toBe(true);
  });
});

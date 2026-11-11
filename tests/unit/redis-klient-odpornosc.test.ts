import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Plan skalowania 3000, sesja 6 (HOR-05, LIM-04): klient Redisa.
 *
 * Biblioteka `@upstash/redis` domyślnie robi 6 prób z przerwami
 * 50 + 136 + 369 + 1004 + 2730 ms i nie ma limitu czasu. Przy zatrzymanej
 * nakładce SRH każde polecenie czekało ok. 4,3 s, a przy zawieszonej do
 * kilku minut. Każdy render panelu czyta Redisa (baner KSeF), limitery
 * logowania też, a „informacyjny” ping w `/api/health` mógł przekroczyć
 * 5 s healthchecku kontenera.
 *
 * Testy idą PRAWDZIWĄ ścieżką: prawdziwy `getRedis()` i prawdziwa biblioteka
 * przeciw lokalnemu serwerowi HTTP, który udaje nakładkę SRH (zawiesza się,
 * zrywa połączenie, odpowiada błędem albo poprawnie). Atrapą jest tylko
 * serwer, nie klient.
 */

const mocks = vi.hoisted(() => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  addBreadcrumb: vi.fn(),
  dbLimit: vi.fn(),
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: mocks.captureException,
  captureMessage: mocks.captureMessage,
  addBreadcrumb: mocks.addBreadcrumb,
}));

vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: () => ({
    from: () => ({ select: () => ({ limit: mocks.dbLimit }) }),
  }),
}));

/**
 * - `hang`: nie odpowiada; `reset`: zrywa połączenie; `resetOnce`: zrywa tylko pierwsze;
 * - `ok`: odpowiada od razu; `slow`: odpowiada po 700 ms (Redis wolny, ale działa);
 * - `error400`: błąd polecenia (np. skryptu) jak SRH, HTTP 400 z JSON;
 * - `srh500`: SRH bez połączenia z Redisem, HTTP 500 z JSON (`base_router.ex` w SRH);
 * - `notJson`: strona błędu bramki zamiast SRH;
 * - `denyZrange`: limiter: paczka liczy próby ponad limit, a `zrange` zrywa połączenie.
 */
type Mode = 'hang' | 'reset' | 'resetOnce' | 'ok' | 'slow' | 'error400' | 'srh500' | 'notJson' | 'denyZrange';

interface FakeSrh {
  url: string;
  readonly requests: number;
  setMode(mode: Mode): void;
  close(): Promise<void>;
}

const servers: FakeSrh[] = [];

/** Wynik polecenia jak w SRH z kodowaniem base64 (liczby i null bez zmian). */
function reply(command: unknown): { result: unknown } {
  const name = Array.isArray(command) ? String(command[0]).toLowerCase() : '';
  if (name === 'ping') return { result: Buffer.from('PONG').toString('base64') };
  // Skrypt limitera 2FA/hasła: dozwolone, 1. próba w oknie 300 s.
  if (name === 'eval') return { result: [1, 1, 300_000] };
  if (name === 'zcard') return { result: 6 };
  if (name === 'zadd' || name === 'expire') return { result: 1 };
  if (name === 'zremrangebyscore') return { result: 0 };
  return { result: null };
}

/** Udaje `hiett/serverless-redis-http`: POST `/` z jednym poleceniem, POST `/pipeline` z listą. */
async function startFakeSrh(initial: Mode): Promise<FakeSrh> {
  let mode: Mode = initial;
  let requests = 0;
  const server = createServer((req, res) => {
    requests += 1;
    if (mode === 'hang') return;
    if (mode === 'reset' || (mode === 'resetOnce' && requests === 1)) {
      req.socket.destroy();
      return;
    }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
    });
    req.on('end', () => {
      const send = (status: number, payload: string, type = 'application/json') => {
        res.writeHead(status, { 'content-type': type });
        res.end(payload);
      };
      if (mode === 'error400') return send(400, JSON.stringify({ error: 'ERR Error running script' }));
      if (mode === 'srh500') {
        return send(500, JSON.stringify({
          error: 'SRH: Unable to connect to the Redis server. See SRH logs for more information.',
        }));
      }
      if (mode === 'notJson') return send(502, '<html><body>502 Bad Gateway</body></html>', 'text/html');
      const parsed: unknown = JSON.parse(body);
      const isBatch = req.url === '/pipeline' || req.url === '/multi-exec';
      if (mode === 'denyZrange' && !isBatch && Array.isArray(parsed) && String(parsed[0]).toLowerCase() === 'zrange') {
        req.socket.destroy();
        return;
      }
      const payload = JSON.stringify(isBatch && Array.isArray(parsed) ? parsed.map(reply) : reply(parsed));
      if (mode === 'slow') setTimeout(() => send(200, payload), 700);
      else send(200, payload);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const srh: FakeSrh = {
    url: `http://127.0.0.1:${port}`,
    get requests() {
      return requests;
    },
    setMode(next) {
      mode = next;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  servers.push(srh);
  return srh;
}

/** Świeży moduł: klient i obwód to stan procesu, każdy test zaczyna od zera. */
async function freshRedisModule(srh: FakeSrh) {
  vi.stubEnv('UPSTASH_REDIS_REST_URL', srh.url);
  vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'token-testowy');
  vi.resetModules();
  return import('@/lib/cache/redis');
}

type Outcome = { kind: 'value'; value: unknown } | { kind: 'error'; error: unknown } | { kind: 'hang' };

/** Wynik albo „wisi” po `capMs`; czas mierzony zegarem monotonicznym (Date bywa podmieniony). */
async function settle(promise: Promise<unknown>, capMs = 3000): Promise<{ outcome: Outcome; ms: number }> {
  const started = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race<Outcome>([
    promise.then(
      (value): Outcome => ({ kind: 'value', value }),
      (error: unknown): Outcome => ({ kind: 'error', error }),
    ),
    new Promise<Outcome>((resolve) => {
      timer = setTimeout(() => resolve({ kind: 'hang' }), capMs);
    }),
  ]);
  clearTimeout(timer);
  return { outcome, ms: performance.now() - started };
}

function errorName(outcome: Outcome): string | null {
  if (outcome.kind !== 'error') return null;
  const { error } = outcome;
  // DOMException (TimeoutError z AbortSignal) też ma `name`.
  return typeof error === 'object' && error !== null && 'name' in error ? String(error.name) : null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Trzy awarie z rzędu (każde polecenie wysłane po poprzedniej awarii) otwierają obwód. */
async function openCircuit(redis: { get: (key: string) => Promise<unknown> }) {
  for (let i = 0; i < 3; i += 1) {
    const { outcome } = await settle(redis.get('k'));
    expect(outcome.kind).toBe('error');
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.dbLimit.mockResolvedValue({ error: null });
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((srh) => srh.close()));
});

describe('klient Redisa: limit czasu i jedno ponowienie', () => {
  it('zawieszony Redis: polecenie kończy się błędem po ok. 500 ms, nie wisi', async () => {
    const srh = await startFakeSrh('hang');
    const { getRedis } = await freshRedisModule(srh);

    const { outcome, ms } = await settle(getRedis().get('k'));

    expect(outcome.kind).toBe('error');
    expect(ms).toBeGreaterThanOrEqual(450);
    expect(ms).toBeLessThan(750);
  }, 15_000);

  it('przerwane polecenie to wyjątek, a nie udawana odpowiedź „Aborted”', async () => {
    const srh = await startFakeSrh('hang');
    const { getRedis } = await freshRedisModule(srh);

    // Statyczny AbortSignal kazałby bibliotece zwrócić 200 { result: "Aborted" }:
    // limiter dostałby „wynik” zamiast błędu i przepuścił próbę.
    const { outcome } = await settle(getRedis().eval('return 1', [], []));

    expect(outcome.kind).toBe('error');
    expect(errorName(outcome)).toBe('TimeoutError');
  }, 15_000);

  it('zerwane połączenie: dokładnie jedno ponowienie, błąd od razu', async () => {
    const srh = await startFakeSrh('reset');
    const { getRedis } = await freshRedisModule(srh);

    const { outcome, ms } = await settle(getRedis().get('k'), 8000);

    expect(outcome.kind).toBe('error');
    expect(srh.requests).toBe(2);
    expect(ms).toBeLessThan(500);
  }, 15_000);

  it('jedno ponowienie ratuje połączenie zerwane raz (np. stare z puli)', async () => {
    const srh = await startFakeSrh('resetOnce');
    const { getRedis } = await freshRedisModule(srh);

    const { outcome } = await settle(getRedis().get('k'));

    expect(outcome).toEqual({ kind: 'value', value: null });
    expect(srh.requests).toBe(2);
  }, 15_000);
});

describe('obwód „Redis niedostępny”', () => {
  it('po 3 awariach z rzędu kolejne polecenie odmawia od razu, bez połączenia', async () => {
    const srh = await startFakeSrh('reset');
    const { getRedis } = await freshRedisModule(srh);
    await openCircuit(getRedis());
    const before = srh.requests;

    const { outcome, ms } = await settle(getRedis().get('k'));

    expect(errorName(outcome)).toBe('RedisUnavailableError');
    expect(ms).toBeLessThan(50);
    expect(srh.requests).toBe(before);
  }, 60_000);

  it('dwie awarie nie otwierają obwodu: trzecie polecenie dalej idzie do serwera', async () => {
    const srh = await startFakeSrh('reset');
    const { getRedis } = await freshRedisModule(srh);
    await settle(getRedis().get('k'));
    await settle(getRedis().get('k'));
    srh.setMode('ok');

    const { outcome } = await settle(getRedis().get('k'));

    expect(outcome).toEqual({ kind: 'value', value: null });
  }, 60_000);

  it('polecenia przerwane naraz (np. po zatrzymaniu pętli zdarzeń) liczą się jak jedna awaria', async () => {
    // Pętla zdarzeń stoi ok. 0,5 s, a po niej najpierw odpalają się timery limitu:
    // wszystkie polecenia w locie padają naraz, choć Redis jest zdrowy.
    const srh = await startFakeSrh('hang');
    const { getRedis } = await freshRedisModule(srh);
    const inFlight = [settle(getRedis().get('a')), settle(getRedis().get('b')), settle(getRedis().get('c'))];
    for (const { outcome } of await Promise.all(inFlight)) expect(errorName(outcome)).toBe('TimeoutError');
    srh.setMode('ok');
    const before = srh.requests;

    const { outcome } = await settle(getRedis().get('k'));

    expect(outcome).toEqual({ kind: 'value', value: null });
    expect(srh.requests).toBe(before + 1);
  }, 60_000);

  it('po 10 s przepuszcza jedną próbę, a gdy Redis wrócił, obwód się zamyka', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-08T10:00:00.000Z'));
    const srh = await startFakeSrh('reset');
    const { getRedis } = await freshRedisModule(srh);
    await openCircuit(getRedis());
    srh.setMode('ok');
    const before = srh.requests;

    vi.setSystemTime(new Date('2026-11-08T10:00:09.900Z'));
    const stillOpen = await settle(getRedis().get('k'));
    expect(errorName(stillOpen.outcome)).toBe('RedisUnavailableError');
    expect(srh.requests).toBe(before);

    vi.setSystemTime(new Date('2026-11-08T10:00:10.100Z'));
    const probe = await settle(getRedis().get('k'));
    expect(probe.outcome).toEqual({ kind: 'value', value: null });
    expect(srh.requests).toBe(before + 1);

    const next = await settle(getRedis().get('k'));
    expect(next.outcome).toEqual({ kind: 'value', value: null });
    expect(srh.requests).toBe(before + 2);
  }, 60_000);

  it('nieudana próba po 10 s otwiera obwód na kolejne 10 s', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-08T10:00:00.000Z'));
    const srh = await startFakeSrh('reset');
    const { getRedis } = await freshRedisModule(srh);
    await openCircuit(getRedis());

    vi.setSystemTime(new Date('2026-11-08T10:00:10.100Z'));
    const probe = await settle(getRedis().get('k'));
    expect(probe.outcome.kind).toBe('error');
    expect(errorName(probe.outcome)).not.toBe('RedisUnavailableError');
    const afterProbe = srh.requests;

    vi.setSystemTime(new Date('2026-11-08T10:00:19.900Z'));
    const again = await settle(getRedis().get('k'));
    expect(errorName(again.outcome)).toBe('RedisUnavailableError');
    expect(srh.requests).toBe(afterProbe);
  }, 60_000);

  it('w trakcie próby pozostałe polecenia odmawiają od razu (jedna próba naraz)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-08T10:00:00.000Z'));
    const srh = await startFakeSrh('reset');
    const { getRedis } = await freshRedisModule(srh);
    await openCircuit(getRedis());
    srh.setMode('hang');
    const before = srh.requests;

    vi.setSystemTime(new Date('2026-11-08T10:00:10.100Z'));
    const probe = settle(getRedis().get('probe'));
    // Osobne makrozadanie: próba musi już wisieć na serwerze, zanim padnie drugie polecenie.
    await sleep(50);
    const concurrent = await settle(getRedis().get('k'));

    expect(errorName(concurrent.outcome)).toBe('RedisUnavailableError');
    expect(concurrent.ms).toBeLessThan(50);
    expect((await probe).outcome.kind).toBe('error');
    expect(srh.requests).toBe(before + 1);
  }, 60_000);

  it('błąd polecenia z odpowiedzią serwera (np. skrypt) nie otwiera obwodu', async () => {
    // Inaczej ktoś, kto potrafi wywołać błąd polecenia (np. zepsuty stan klucza),
    // wyłączyłby Redisa wszystkim, a z nim logowanie z 2FA.
    const srh = await startFakeSrh('error400');
    const { getRedis } = await freshRedisModule(srh);

    for (let i = 0; i < 5; i += 1) {
      const { outcome } = await settle(getRedis().get('k'));
      expect(errorName(outcome)).toBe('UpstashError');
    }

    expect(srh.requests).toBe(5);
  }, 60_000);

  it('odpowiedź z błędem polecenia przerywa serię awarii połączenia', async () => {
    const srh = await startFakeSrh('reset');
    const { getRedis } = await freshRedisModule(srh);
    await settle(getRedis().get('k'));
    await settle(getRedis().get('k'));
    srh.setMode('error400');
    await settle(getRedis().get('k'));
    srh.setMode('reset');
    await settle(getRedis().get('k'));
    srh.setMode('ok');

    const { outcome } = await settle(getRedis().get('k'));

    expect(outcome).toEqual({ kind: 'value', value: null });
  }, 60_000);

  it('SRH bez Redisa (HTTP 500 „Unable to connect”) liczy się jak awaria i nie zamyka obwodu próbą', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-08T10:00:00.000Z'));
    const srh = await startFakeSrh('srh500');
    const { getRedis } = await freshRedisModule(srh);
    await openCircuit(getRedis());
    const before = srh.requests;

    const open = await settle(getRedis().get('k'));
    expect(errorName(open.outcome)).toBe('RedisUnavailableError');
    expect(srh.requests).toBe(before);

    // Próba po 10 s dostaje ten sam błąd SRH: obwód zostaje otwarty, a nie „Redis znowu odpowiada”.
    vi.setSystemTime(new Date('2026-11-08T10:00:10.100Z'));
    const probe = await settle(getRedis().get('k'));
    expect(errorName(probe.outcome)).toBe('UpstashError');
    const again = await settle(getRedis().get('k'));
    expect(errorName(again.outcome)).toBe('RedisUnavailableError');
    expect(srh.requests).toBe(before + 1);
  }, 60_000);

  it('spóźniona awaria polecenia wysłanego przed otwarciem nie przedłuża przerwy', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-08T10:00:00.000Z'));
    const srh = await startFakeSrh('hang');
    const { getRedis } = await freshRedisModule(srh);
    await settle(getRedis().get('a'));
    await settle(getRedis().get('b'));
    const third = settle(getRedis().get('c'));
    await sleep(250);
    const late = settle(getRedis().get('d'));
    expect(errorName((await third).outcome)).toBe('TimeoutError'); // ok. 500 ms: obwód otwarty o 10:00:00
    vi.setSystemTime(new Date('2026-11-08T10:00:05.000Z'));
    expect(errorName((await late).outcome)).toBe('TimeoutError'); // ok. 250 ms później, przy otwartym obwodzie
    srh.setMode('ok');

    vi.setSystemTime(new Date('2026-11-08T10:00:10.100Z'));
    const probe = await settle(getRedis().get('k'));

    expect(probe.outcome).toEqual({ kind: 'value', value: null });
  }, 60_000);

  it('próba, która by utknęła, nie blokuje obwodu, a jej spóźniona porażka nie otwiera go ponownie', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-08T10:00:00.000Z'));
    const srh = await startFakeSrh('reset');
    const { getRedis } = await freshRedisModule(srh);
    await openCircuit(getRedis());
    srh.setMode('hang');

    vi.setSystemTime(new Date('2026-11-08T10:00:10.100Z'));
    const stuck = settle(getRedis().get('probe-1'));
    await sleep(50);
    srh.setMode('ok');
    const before = srh.requests;
    // Skok zegara (np. krok NTP): po kolejnym oknie wolno wysłać nową próbę.
    vi.setSystemTime(new Date('2026-11-08T10:00:20.200Z'));
    const second = await settle(getRedis().get('probe-2'));
    expect(second.outcome).toEqual({ kind: 'value', value: null });
    expect(srh.requests).toBe(before + 1);

    expect(errorName((await stuck).outcome)).toBe('TimeoutError');
    const after = await settle(getRedis().get('k'));

    expect(after.outcome).toEqual({ kind: 'value', value: null });
    expect(srh.requests).toBe(before + 2);
  }, 60_000);

  it('cofnięty zegar systemu kończy przerwę od razu, zamiast ją wydłużać', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-08T10:00:00.000Z'));
    const srh = await startFakeSrh('reset');
    const { getRedis } = await freshRedisModule(srh);
    await openCircuit(getRedis());
    srh.setMode('ok');

    vi.setSystemTime(new Date('2026-11-08T09:59:00.000Z'));
    const probe = await settle(getRedis().get('k'));

    expect(probe.outcome).toEqual({ kind: 'value', value: null });
  }, 60_000);

  it('odpowiedź, która nie jest JSON-em (bramka zamiast SRH), liczy się jak awaria', async () => {
    const srh = await startFakeSrh('notJson');
    const { getRedis } = await freshRedisModule(srh);
    for (let i = 0; i < 3; i += 1) await settle(getRedis().get('k'));
    const before = srh.requests;

    const { outcome } = await settle(getRedis().get('k'));

    expect(errorName(outcome)).toBe('RedisUnavailableError');
    expect(srh.requests).toBe(before);
  }, 60_000);

  it('obwód obejmuje każdy rodzaj polecenia i oba profile klienta', async () => {
    // Pilnuje biblioteki: gdyby nowa wersja wysyłała coś obok podmienionego
    // klienta HTTP, ten test zrobi się czerwony. `scan` to metoda prototypu,
    // którą przy automatycznych paczkach omijała obwód.
    const srh = await startFakeSrh('reset');
    const { getRedis } = await freshRedisModule(srh);
    const redis = getRedis();
    const limiter = getRedis('failClosedLimiter');
    await openCircuit(redis);
    const before = srh.requests;

    const calls: Array<[string, () => Promise<unknown>]> = [
      ['get', () => redis.get('k')],
      ['set', () => redis.set('k', 'v', { ex: 10 })],
      ['del', () => redis.del('k')],
      ['incr', () => redis.incr('k')],
      ['expire', () => redis.expire('k', 10)],
      ['keys', () => redis.keys('k*')],
      ['scan', () => redis.scan(0)],
      ['ping', () => redis.ping()],
      ['eval', () => redis.eval('return 1', ['k'], [1])],
      ['zrange', () => redis.zrange('k', 0, 0, { withScores: true })],
      ['zrem', () => redis.zrem('k', 'm')],
      ['pipeline', () => redis.pipeline().zadd('k', { score: 1, member: 'm' }).zcard('k').exec()],
      ['multi', () => redis.multi().incr('k').exec()],
      ['limiter eval', () => limiter.eval('return 1', ['k'], [1])],
    ];
    for (const [name, call] of calls) {
      const { outcome, ms } = await settle(call());
      expect({ name, error: errorName(outcome) }).toEqual({ name, error: 'RedisUnavailableError' });
      expect(ms).toBeLessThan(50);
    }

    expect(srh.requests).toBe(before);
  }, 60_000);
});

describe('miejsca użycia', () => {
  it('limiter 2FA przy zawieszonym Redisie odmawia (fail-closed) po ok. 2 s, a nie po minucie', async () => {
    const srh = await startFakeSrh('hang');
    await freshRedisModule(srh);
    const { checkMfaRateLimit } = await import('@/lib/rate-limit/mfa');

    const { outcome, ms } = await settle(checkMfaRateLimit('user-1'), 5000);

    expect(outcome).toEqual({
      kind: 'value',
      value: { allowed: false, retryAfter: 300, unavailable: true },
    });
    expect(ms).toBeGreaterThanOrEqual(1900);
    expect(ms).toBeLessThan(2600);
  }, 15_000);

  it('wolny Redis (700 ms): skrypt limitera kończy się wynikiem, a nie przerwaniem, które spaliłoby próbę', async () => {
    // Przerwanie nie cofa skryptu: Redis policzyłby próbę 2FA albo jednorazowe
    // potwierdzenie resetu hasła, a klient dostałby „niedostępne”.
    const srh = await startFakeSrh('slow');
    const { getRedis } = await freshRedisModule(srh);
    const { checkMfaRateLimit } = await import('@/lib/rate-limit/mfa');
    const { claimPasswordRecoverySession } = await import('@/lib/rate-limit/password');

    const mfa = await settle(checkMfaRateLimit('user-1'), 5000);
    const claim = await settle(claimPasswordRecoverySession('11111111-1111-4111-8111-111111111111'), 5000);
    // Dla porównania zwykłe polecenie: 500 ms, bo cache i ogólny limiter wolą nie czekać.
    const plain = await settle(getRedis().get('k'), 5000);

    expect(mfa.outcome).toEqual({ kind: 'value', value: { allowed: true, retryAfter: 0, unavailable: false } });
    expect(claim.outcome).toEqual({ kind: 'value', value: { allowed: true, retryAfter: 0, unavailable: false } });
    expect(errorName(plain.outcome)).toBe('TimeoutError');
  }, 15_000);

  it('ogólny limiter przechodzi na licznik w pamięci po ok. 500 ms', async () => {
    const srh = await startFakeSrh('hang');
    await freshRedisModule(srh);
    const { checkRateLimit } = await import('@/lib/rate-limit');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const { outcome, ms } = await settle(
      checkRateLimit({ bucket: 'login', identifier: 'ip-1', limit: 5, windowSeconds: 60 }),
    );

    expect(outcome.kind).toBe('value');
    expect(outcome.kind === 'value' && outcome.value).toMatchObject({ allowed: true, fallback: true });
    expect(ms).toBeLessThan(900);
  }, 15_000);

  it('ogólny limiter: odmowa z Redisa zostaje odmową, gdy padnie odczyt czasu odblokowania', async () => {
    // Paczka policzyła 6 prób przy limicie 5, a osobny `zrange` padł (obwód albo limit czasu).
    // Wcześniej catch przechodził na pusty licznik w pamięci i przepuszczał próbę.
    const srh = await startFakeSrh('denyZrange');
    await freshRedisModule(srh);
    const { checkRateLimit } = await import('@/lib/rate-limit');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const { outcome } = await settle(
      checkRateLimit({ bucket: 'login', identifier: 'ip-1', limit: 5, windowSeconds: 60 }),
    );

    expect(outcome).toEqual({ kind: 'value', value: { allowed: false, remaining: 0, retryAfter: 60 } });
  }, 15_000);

  it('cache (np. baner KSeF przy każdym renderze panelu) zwraca brak po ok. 500 ms', async () => {
    const srh = await startFakeSrh('hang');
    await freshRedisModule(srh);
    const { cacheGet } = await import('@/lib/cache');

    const { outcome, ms } = await settle(cacheGet('ksef:health:test'));

    expect(outcome).toEqual({ kind: 'value', value: null });
    expect(ms).toBeLessThan(900);
  }, 15_000);
});

describe('/api/health: ping Redisa z osobnym limitem', () => {
  function stubHealthEnv() {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://fixture.supabase.test');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'fixture-service-role');
    vi.stubEnv('KSEF_CREDENTIALS_ENCRYPTION_KEY', 'fixture-key');
    vi.stubEnv('DATABASE_URL', 'postgres://fixture');
    vi.stubEnv('JOBS_BACKEND', '');
  }

  it('zawieszony Redis: odpowiedź w ok. 300 ms, status 200, Redis „fail” tylko informacyjnie', async () => {
    const srh = await startFakeSrh('hang');
    await freshRedisModule(srh);
    stubHealthEnv();
    const { GET } = await import('@/app/api/health/route');

    const { outcome, ms } = await settle(GET());

    expect(outcome.kind).toBe('value');
    const response = (outcome as { kind: 'value'; value: Response }).value;
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 'healthy',
      informational: { redis: { status: 'fail' } },
    });
    expect(ms).toBeGreaterThanOrEqual(250);
    expect(ms).toBeLessThan(450);
  }, 15_000);

  it('ping pokazuje prawdziwy stan także przy otwartym obwodzie aplikacji', async () => {
    const srh = await startFakeSrh('reset');
    const { getRedis } = await freshRedisModule(srh);
    await openCircuit(getRedis());
    srh.setMode('ok');
    stubHealthEnv();
    const { GET } = await import('@/app/api/health/route');
    const before = srh.requests;

    const response = await GET();

    expect(await response.json()).toMatchObject({ informational: { redis: { status: 'ok' } } });
    expect(srh.requests).toBe(before + 1);
    // Obwód aplikacji zostaje otwarty: ping go nie zamyka ani nie karmi.
    const { outcome } = await settle(getRedis().get('k'));
    expect(errorName(outcome)).toBe('RedisUnavailableError');
  }, 60_000);
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Plan skalowania 3000, sesja 5 (REQ-V01, QRY-V1, LIM-05): limity czasu
 * w klientach Supabase poza proxy (`lib/supabase/server.ts`).
 *
 * Testy idą przez PRAWDZIWE `@supabase/ssr` i `@supabase/supabase-js`, a atrapa
 * gra serwer, który nie odpowiada (jak undici: kończy go tylko przerwanie
 * sygnałem). Sprawdzają limit odczytu i zapisu w żądaniu, dłuższe limity
 * workera, limit na czytanie treści i to, że przekroczenie nie kasuje sesji.
 */

const cookieStore = vi.hoisted(() => ({
  values: new Map<string, string>(),
  set: vi.fn(),
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    getAll: () => [...cookieStore.values].map(([name, value]) => ({ name, value })),
    get: (name: string) => (cookieStore.values.has(name) ? { name, value: cookieStore.values.get(name)! } : undefined),
    set: cookieStore.set,
  }),
}));

type FetchTimeout = typeof import('@/lib/supabase/fetch-timeout');
type Server = typeof import('@/lib/supabase/server');

const SUPABASE_URL = 'https://fixture.supabase.test';
const COOKIE_NAME = 'sb-fixture-auth-token';
const userId = '22222222-2222-4222-8222-222222222222';
const org = '11111111-1111-4111-8111-111111111111';

/** Świeże moduły w każdym teście: tryb workera to stan procesu. */
let timeouts: FetchTimeout;
let server: Server;
let fetchMock: ReturnType<typeof vi.fn>;
/** Sygnały, z którymi przyszły zawieszone żądania. */
let hungSignals: (AbortSignal | undefined)[];

const b64url = (value: string) => Buffer.from(value).toString('base64url');

function sessionCookie(): string {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const payload = { sub: userId, aal: 'aal2', role: 'authenticated', aud: 'authenticated', exp, session_id: 'fixture-session' };
  const token = [b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' })), b64url(JSON.stringify(payload)), b64url('sig')].join('.');
  const session = {
    access_token: token, refresh_token: 'fixture-refresh', token_type: 'bearer',
    expires_in: 3600, expires_at: exp, user: { id: userId, aud: 'authenticated', role: 'authenticated' },
  };
  return `base64-${b64url(JSON.stringify(session))}`;
}

/** Serwer, który przyjmuje żądanie i nigdy nie odpowiada. */
function neverAnswers(_input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const signal = init?.signal ?? undefined;
  hungSignals.push(signal);
  return new Promise((_resolve, reject) => {
    if (!signal) return;
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

/** Serwer wysyła nagłówki i początek treści, a potem staje (treść przerywa sygnał, jak w undici). */
function stallsBody(_input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const signal = init?.signal ?? undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('[{"id":'));
      signal?.addEventListener('abort', () => controller.error(signal.reason), { once: true });
    },
  });
  return Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }));
}

/** Stan obietnicy bez czekania na nią: zegar jest sztuczny, więc test sam go przesuwa. */
function track<T>(promise: PromiseLike<T>) {
  const state: { done: boolean; value?: T; error?: unknown } = { done: false };
  Promise.resolve(promise).then(
    (value) => { state.done = true; state.value = value; },
    (error: unknown) => { state.done = true; state.error = error; },
  );
  return state;
}

/** Wynik kończy się dokładnie po `limitMs`, a nie wcześniej. */
async function settlesAt<T>(limitMs: number, work: PromiseLike<T>): Promise<T> {
  const result = track(work);
  await vi.advanceTimersByTimeAsync(limitMs - 1);
  expect(result.done, 'przed limitem wywołanie jeszcze czeka').toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(result.done, 'po limicie wywołanie ma wynik').toBe(true);
  expect(result.error).toBeUndefined();
  return result.value!;
}

function expectTimeoutResult(result: { data: unknown; error: { message: string; code: string } | null; status: number }, limitMs: number, operation: string) {
  expect(result.data).toBeNull();
  expect(result.status).toBe(0);
  expect(result.error?.message).toBe(`TimeoutError: Supabase nie odpowiedział w ${limitMs} ms (${operation})`);
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SUPABASE_URL);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'fixture-anon-key');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'fixture-service-role-key-do-testow');
  cookieStore.values = new Map([[COOKIE_NAME, sessionCookie()]]);
  cookieStore.set.mockReset();
  hungSignals = [];
  fetchMock = vi.fn(neverAnswers);
  vi.stubGlobal('fetch', fetchMock);
  timeouts = await import('@/lib/supabase/fetch-timeout');
  server = await import('@/lib/supabase/server');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('limity w żądaniu (RSC, akcje, trasy API)', () => {
  it('stałe: proxy 5 s, odczyt 10 s, zapis 30 s, worker 60 s i 120 s', () => {
    expect(timeouts.PROXY_GATE_TIMEOUT_MS).toBe(5_000);
    expect(timeouts.REQUEST_READ_TIMEOUT_MS).toBe(10_000);
    expect(timeouts.REQUEST_WRITE_TIMEOUT_MS).toBe(30_000);
    expect(timeouts.WORKER_READ_TIMEOUT_MS).toBe(60_000);
    expect(timeouts.WORKER_WRITE_TIMEOUT_MS).toBe(120_000);
  });

  it('odczyt klientem użytkownika: błąd po 10 s, jedno wywołanie, przerwane żądanie', async () => {
    const supabase = await server.createClient();

    const result = await settlesAt(10_000, supabase.from('invoices').select('id'));

    expectTimeoutResult(result, 10_000, 'GET /rest/v1/invoices');
    expect(result.error?.code).toBe('');
    // PostgREST nie ponawia przerwanego odczytu (bez tego 3 ponowienia po 10 s).
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(hungSignals.every((signal) => signal?.aborted === true)).toBe(true);
  });

  it('zapis (RPC) klientem z wybraną firmą: błąd dopiero po 30 s, nagłówek firmy zostaje', async () => {
    const supabase = await server.createClientForOrg(org);

    const result = await settlesAt(30_000, supabase.rpc('fixture_zapis', { a: 1 }));

    expectTimeoutResult(result, 30_000, 'POST /rest/v1/rpc/fixture_zapis');
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(new Headers(init.headers).get('x-active-org')).toBe(org);
  });

  it('klient admina w żądaniu: odczyt 10 s, zapis 30 s', async () => {
    const admin = server.createAdminClient();

    expectTimeoutResult(await settlesAt(10_000, admin.from('tenants').select('id')), 10_000, 'GET /rest/v1/tenants');
    expectTimeoutResult(await settlesAt(30_000, admin.from('tenants').update({ name: 'x' }).eq('id', org)), 30_000, 'PATCH /rest/v1/tenants');
  });

  it('GoTrue nie odpowiada: getUser kończy się błędem przejściowym po 10 s, sesja zostaje', async () => {
    const supabase = await server.createClient();

    const { data, error } = await settlesAt(10_000, supabase.auth.getUser());

    expect(data.user).toBeNull();
    expect(error?.name).toBe('AuthRetryableFetchError');
    // Żadnego zapisu ciasteczek, więc tym bardziej żadnego skasowania sesji.
    expect(cookieStore.set).not.toHaveBeenCalled();
  });

  it('serwer staje w połowie treści: ten sam limit obejmuje czytanie odpowiedzi', async () => {
    fetchMock.mockImplementation(stallsBody);
    const admin = server.createAdminClient();

    const result = await settlesAt(10_000, admin.from('invoices').select('id'));

    expectTimeoutResult(result, 10_000, 'GET /rest/v1/invoices');
  });

  it('komunikat bez zapytania i bez identyfikatorów (filtry niosą NIP-y i e-maile)', async () => {
    const admin = server.createAdminClient();

    const query = await settlesAt(10_000, admin.from('users').select('id').eq('email', 'jan@example.test').eq('nip', '1234567890'));
    const byId = await settlesAt(10_000, admin.auth.admin.getUserById(userId));

    expect(query.error?.message).toBe('TimeoutError: Supabase nie odpowiedział w 10000 ms (GET /rest/v1/users)');
    expect(byId.error?.message).toBe('Supabase nie odpowiedział w 10000 ms (GET /auth/v1/admin/users)');
    for (const message of [query.error?.message, byId.error?.message]) {
      expect(message).not.toMatch(/example\.test|1234567890|22222222/);
    }
  });

  it('sygnał wywołującego dalej przerywa od razu, przed limitem', async () => {
    const admin = server.createAdminClient();
    const caller = new AbortController();
    const pending = track(admin.from('invoices').select('id').abortSignal(caller.signal));

    caller.abort();
    await vi.advanceTimersByTimeAsync(0);

    expect(pending.done).toBe(true);
    expect(pending.value?.error?.message).toMatch(/^AbortError/);
  });

  it('odpowiedź w limicie przechodzi bez zmian i nie zostawia zegara', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === '/rest/v1/invoices' && url.searchParams.get('select') === 'id') {
        return Response.json([{ id: 'a' }, { id: 'b' }], {
          status: 200, headers: { 'content-range': '0-1/7', 'x-fixture': 'tak' },
        });
      }
      return new Response(null, { status: 204 });
    });
    const admin = server.createAdminClient();

    const read = await admin.from('invoices').select('id', { count: 'exact' });
    const write = await admin.from('invoices').insert({ id: 'c' });
    await vi.advanceTimersByTimeAsync(0);

    expect(read.error).toBeNull();
    expect(read.data).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(read.count).toBe(7);
    expect(write.error).toBeNull();
    expect(write.status).toBe(204);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('worker pg-boss: dłuższe limity', () => {
  it('po włączeniu trybu workera odczyt 60 s, zapis 120 s, także dla klienta sprzed włączenia', async () => {
    // Klient utworzony przy imporcie modułu, zanim `main()` workera włączy tryb.
    const early = server.createAdminClient();
    timeouts.enableWorkerSupabaseTimeouts();
    const late = server.createAdminClient();

    expectTimeoutResult(await settlesAt(60_000, early.from('invoices').select('id')), 60_000, 'GET /rest/v1/invoices');
    expectTimeoutResult(await settlesAt(120_000, late.rpc('fixture_zapis')), 120_000, 'POST /rest/v1/rpc/fixture_zapis');
  });

  it('przekroczenie w jobie to zwykły błąd, który pg-boss ponawia (nie NonRetriableError)', async () => {
    const { NonRetriableError } = await import('@/lib/jobs/errors');
    const error = new timeouts.SupabaseTimeoutError(60_000, 'GET /rest/v1/invoices');

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(NonRetriableError);
    expect(error.name).toBe('TimeoutError');
    expect(error.code).toBe('ABORT_ERR');
  });

  it('worker włącza tryb przed startem pg-boss', () => {
    const source = readFileSync(join(process.cwd(), 'lib/jobs/worker.ts'), 'utf8');
    const main = source.slice(source.indexOf('async function main()'));

    expect(main.indexOf('enableWorkerSupabaseTimeouts();')).toBeGreaterThan(-1);
    expect(main.indexOf('enableWorkerSupabaseTimeouts();')).toBeLessThan(main.indexOf('await startBoss()'));
  });
});

describe('termin całej bramki (createSupabaseDeadline)', () => {
  it('wynik przed terminem przechodzi, a po dispose nie zostaje zegar', async () => {
    const gate = timeouts.createSupabaseDeadline(5_000, 'test');

    const value = await gate.within(Promise.resolve('ok'));
    gate.dispose();

    expect(value).toBe('ok');
    expect(gate.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('praca dłuższa niż termin: TIMED_OUT, sygnał przerwany błędem limitu', async () => {
    const gate = timeouts.createSupabaseDeadline(5_000, 'bramka proxy');
    const slow = new Promise<string>((resolve) => setTimeout(() => resolve('za późno'), 6_000));

    const result = await settlesAt(5_000, gate.within(slow));

    expect(result).toBe(timeouts.TIMED_OUT);
    expect(gate.signal.reason).toBeInstanceOf(timeouts.SupabaseTimeoutError);
    expect((gate.signal.reason as Error).message).toBe('Supabase nie odpowiedział w 5000 ms (bramka proxy)');
  });

  it('wynik, który przyszedł już po terminie, to TIMED_OUT (np. „brak sesji” z przerwanego fetch)', async () => {
    const gate = timeouts.createSupabaseDeadline(5_000, 'test');
    const afterAbort = new Promise<string>((resolve) => {
      gate.signal.addEventListener('abort', () => resolve('brak sesji'), { once: true });
    });
    const pending = track(gate.within(afterAbort));

    await vi.advanceTimersByTimeAsync(5_000);

    expect(pending.value).toBe(timeouts.TIMED_OUT);
  });

  it('błąd przed terminem przechodzi bez zmian, a wywołanie po terminie nie idzie do sieci', async () => {
    const gate = timeouts.createSupabaseDeadline(5_000, 'test');
    await expect(gate.within(Promise.reject(new Error('błąd przed terminem')))).rejects.toThrow('błąd przed terminem');

    await vi.advanceTimersByTimeAsync(5_000);
    const gatedFetch = timeouts.createSupabaseFetch({ deadline: gate.signal });
    await expect(gatedFetch(`${SUPABASE_URL}/auth/v1/user`)).rejects.toBeInstanceOf(timeouts.SupabaseTimeoutError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

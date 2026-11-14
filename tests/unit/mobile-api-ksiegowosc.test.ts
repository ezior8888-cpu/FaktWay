import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

/**
 * Plan aplikacji mobilnej, M10b: „Ten miesiąc” z telefonu.
 *
 * Prawdziwe: trasy `app/api/mobile/v1/ksiegowosc/**`, bramka, `lib/api/mobile/ksiegowosc.ts`,
 * pomocnicze `lib/ksiegowosc/{ten-miesiac-dane,przelew,mikrorachunek}` (aktualna wersja,
 * zapłacono, skróty, dane do przelewu). Granice z własnymi testami na ścieżce strony:
 * wyłącznik (`czyKsiegowoscWlaczona`), wyliczenie miesiąca (`czytajTenMiesiac`) i zapis
 * rozliczeń (`lib/ksiegowosc/ten-miesiac-zapis.ts`, testy akcji `ksiegowosc-ten-miesiac-akcje`).
 */

const SUPABASE_URL = 'https://db.fixture.test';
const USER_OWNER = 'aaaaaaaa-1111-4111-8111-000000000001';
const USER_MEMBER = 'aaaaaaaa-1111-4111-8111-000000000002';
const ORG_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const ROZ_ID = '55555555-5555-4555-8555-555555555555';
const H = (c: string) => c.repeat(64);

const fake = vi.hoisted(() => {
  const sets = new Map<string, Map<string, number>>();
  const zset = (key: string) => {
    let set = sets.get(key);
    if (!set) sets.set(key, (set = new Map()));
    return set;
  };
  const client = {
    pipeline() {
      const ops: Array<() => number> = [];
      const pipe = {
        zremrangebyscore: () => (ops.push(() => 0), pipe),
        zadd: (key: string, entry: { score: number; member: string }) => (ops.push(() => (zset(key).set(entry.member, entry.score), 1)), pipe),
        zcard: (key: string) => (ops.push(() => zset(key).size), pipe),
        expire: () => (ops.push(() => 1), pipe),
        exec: async () => ops.map((op) => op()),
      };
      return pipe;
    },
    zrange: async () => [],
    zrem: async () => 0,
  };
  return { client, sets, wlaczona: vi.fn(), czytaj: vi.fn(), zatwierdz: vi.fn(), zaplac: vi.fn() };
});

vi.mock('@/lib/cache/redis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cache/redis')>();
  return { ...actual, isRedisConfigured: () => true, getRedis: () => fake.client };
});
vi.mock('@/lib/feature-flags/maintenance', () => ({ isMaintenanceMode: async () => false, MAINTENANCE_PATH: '/przerwa-techniczna' }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/ksiegowosc/wylacznik', () => ({ czyKsiegowoscWlaczona: fake.wlaczona }));
vi.mock('@/lib/ksiegowosc/ten-miesiac-dane', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ksiegowosc/ten-miesiac-dane')>();
  return { ...actual, czytajTenMiesiac: fake.czytaj };
});
vi.mock('@/lib/ksiegowosc/ten-miesiac-zapis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ksiegowosc/ten-miesiac-zapis')>();
  return { ...actual, zatwierdzMiesiac: fake.zatwierdz, oznaczZaplacone: fake.zaplac };
});

import { GET as miesiacRoute } from '@/app/api/mobile/v1/ksiegowosc/route';
import { POST as zatwierdzRoute } from '@/app/api/mobile/v1/ksiegowosc/zatwierdz/route';
import { POST as zaplataRoute } from '@/app/api/mobile/v1/ksiegowosc/rozliczenia/[id]/zaplata/route';
import type { RodzajRozliczeniaTelefonu, TenMiesiacOdpowiedz } from '@/lib/api/mobile/kontrakt';
import type { RodzajRozliczenia } from '@/lib/ksiegowosc/ten-miesiac';

const b64url = (value: string) => Buffer.from(value).toString('base64url');
function accessToken(sub: string, n: number): string {
  const now = Math.floor(Date.now() / 1000);
  return [b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' })), b64url(JSON.stringify({ aud: 'authenticated', role: 'authenticated', iat: now, exp: now + 3600, sub, aal: 'aal1', session_id: `cccccccc-2222-4222-8222-00000000000${n}` })), b64url('sig')].join('.');
}
const TOKEN_OWNER = accessToken(USER_OWNER, 1);
const TOKEN_MEMBER = accessToken(USER_MEMBER, 2);
const issued = new Map([[TOKEN_OWNER, USER_OWNER], [TOKEN_MEMBER, USER_MEMBER]]);
const memberships = [
  { user_id: USER_OWNER, organization_id: ORG_A, role: 'owner', status: 'active' },
  { user_id: USER_MEMBER, organization_id: ORG_A, role: 'member', status: 'active' },
];

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  const url = new URL(request.url);
  const token = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? null;
  const sub = token ? issued.get(token) : undefined;
  if (url.pathname === '/auth/v1/user') {
    return sub ? Response.json({ id: sub, aud: 'authenticated', role: 'authenticated', email: `${sub}@x.test`, factors: [] }) : Response.json({}, { status: 401 });
  }
  if (!sub) return Response.json({}, { status: 401 });
  const asObject = request.headers.get('accept')?.includes('vnd.pgrst.object');
  if (url.pathname === '/rest/v1/memberships') {
    const rows = memberships.filter((m) => m.user_id === sub && m.organization_id === url.searchParams.get('organization_id')?.slice(3));
    return asObject ? (rows[0] ? Response.json(rows[0]) : Response.json({}, { status: 406 })) : Response.json(rows);
  }
  if (url.pathname === '/rest/v1/tenants') return asObject ? Response.json({ nip: '5260001246' }) : Response.json([{ nip: '5260001246' }]);
  return Response.json({ message: url.pathname }, { status: 404 });
}

let ip = 0;
function req(path: string, options: { method?: string; token?: string; body?: unknown } = {}): Request {
  const headers: Record<string, string> = { 'x-real-ip': `203.0.113.${(ip += 1) % 250}`, authorization: `Bearer ${options.token ?? TOKEN_OWNER}`, 'x-active-org': ORG_A };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  return new Request(`https://app.example.test/api/mobile/v1/${path}`, { method: options.method ?? 'GET', headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
}

const termin = { rodzaj: 'zus', nominalny: '2026-11-20', faktyczny: '2026-11-20', przesuniety: false };
function dane() {
  return {
    ok: true,
    wynik: { miesiac: '2026-10', profil: { forma: 'ryczalt', nrsZus: '12345678901234567890123456' }, przychodGr: 1_000_000, kosztyGr: null, pozycje: [] },
    pozycje: [
      { ok: true, rodzaj: 'ryczalt', kwotaGr: 120_000, termin: { ...termin, faktyczny: '2026-11-20' }, wejscia: {}, wejsciaHash: H('a') },
      { ok: true, rodzaj: 'zus_spoleczne', kwotaGr: 150_000, termin, wejscia: {}, wejsciaHash: H('b') },
      { ok: false, rodzaj: 'zdrowotna', termin, brak: 'Brak etapu ZUS w ustawieniach podatkowych.' },
    ],
    parametryWersja: 'p',
    rozliczenia: [
      { id: ROZ_ID, miesiac: '2026-10', rodzaj: 'ryczalt', wersja: 1, kwotaGr: 120_000, termin: '2026-11-20', status: 'zaplacone', wejsciaHash: H('a'), zatwierdzoneO: '2026-11-03T10:00:00Z', zaplaconeO: '2026-11-10', spoleczneBezFpGr: 0, reczna: false },
      { id: '66666666-6666-4666-8666-666666666666', miesiac: '2026-10', rodzaj: 'zus_spoleczne', wersja: 1, kwotaGr: 140_000, termin: '2026-11-20', status: 'zatwierdzone', wejsciaHash: H('c'), zatwierdzoneO: '2026-11-03T10:00:00Z', zaplaconeO: null, spoleczneBezFpGr: 0, reczna: false },
    ],
    zaplatyReczne: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  fake.sets.clear();
  fake.wlaczona.mockResolvedValue({ wlaczony: true });
  fake.czytaj.mockResolvedValue(dane());
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-14T09:00:00Z'));
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SUPABASE_URL);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon');
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('kontrakt', () => {
  it('rodzaje rozliczeń telefonu to rodzaje strony', () => {
    expectTypeOf<RodzajRozliczeniaTelefonu>().toEqualTypeOf<RodzajRozliczenia>();
  });
});

describe('GET /api/mobile/v1/ksiegowosc', () => {
  it('domyślnie poprzedni miesiąc, jak strona; pozycje z danymi do przelewu, stanem i dopłatą', async () => {
    const response = await miesiacRoute(req('ksiegowosc'));
    expect(response.status).toBe(200);
    const body = (await response.json()) as TenMiesiacOdpowiedz;
    expect(fake.czytaj).toHaveBeenCalledWith(expect.anything(), ORG_A, '2026-10', { nadwyzkaVat: null });
    expect(fake.wlaczona).toHaveBeenCalledWith(expect.anything(), ORG_A, 'ten_miesiac');
    expect(body).toMatchObject({ wlaczona: true, miesiac: '2026-10', dzis: '2026-11-14', forma: 'ryczalt', braki: null, przychodGr: 1_000_000, mozeEdytowac: true, miesiacZakonczony: true });
    expect(body.miesiace[0]).toBe('2026-11');
    expect(body.miesiace).toContain('2026-01');
    expect(body.miesiace).not.toContain('2025-12');
    const [ryczalt, spoleczne, zdrowotna] = body.pozycje;
    expect(ryczalt).toMatchObject({ rodzaj: 'ryczalt', nazwa: 'Ryczałt od przychodów ewidencjonowanych', kwotaGr: 120_000, zaplaconoGr: 120_000, zmiana: false, rozliczenie: { id: ROZ_ID, status: 'zaplacone', zaplaconeO: '2026-11-10' } });
    expect(ryczalt!.przelew).toMatch(/^Mikrorachunek podatkowy .*symbol formularza PPE, okres 26M10, identyfikator NIP 5260001246\.$/);
    expect(spoleczne).toMatchObject({ kwotaGr: 150_000, zmiana: true, zaplaconoGr: 0, rozliczenie: { wersja: 1, kwotaGr: 140_000 } });
    expect(spoleczne!.przelew).toMatch(/^Rachunek składkowy ZUS /);
    expect(zdrowotna).toMatchObject({ kwotaGr: null, brak: 'Brak etapu ZUS w ustawieniach podatkowych.', rozliczenie: null });
    // Do zatwierdzenia tylko pozycja ze skrótem innym niż ostatnia wersja.
    expect(body.doZatwierdzenia).toBe(1);
    expect(body.skroty).toEqual({ ryczalt: H('a'), zus_spoleczne: H('b') });
    expect(body.historia).toHaveLength(2);
  });

  it('członek firmy widzi, ale nie zatwierdza; moduł wyłączony: `wlaczona: false` bez wyliczenia', async () => {
    const czlonek = (await (await miesiacRoute(req('ksiegowosc', { token: TOKEN_MEMBER }))).json()) as TenMiesiacOdpowiedz;
    expect(czlonek.mozeEdytowac).toBe(false);
    fake.wlaczona.mockResolvedValue({ wlaczony: false });
    vi.clearAllMocks();
    fake.wlaczona.mockResolvedValue({ wlaczony: false });
    const wylaczona = (await (await miesiacRoute(req('ksiegowosc'))).json()) as TenMiesiacOdpowiedz;
    expect(wylaczona.wlaczona).toBe(false);
    expect(fake.czytaj).not.toHaveBeenCalled();
  });

  it('miesiąc z braków: braki ze strony, pozycji nie liczymy', async () => {
    fake.czytaj.mockResolvedValue({ ok: false, braki: ['Brak ustawień podatkowych.'], rozliczenia: [], zaplatyReczne: [] });
    const body = (await (await miesiacRoute(req('ksiegowosc?miesiac=2026-09'))).json()) as TenMiesiacOdpowiedz;
    expect(fake.czytaj).toHaveBeenCalledWith(expect.anything(), ORG_A, '2026-09', { nadwyzkaVat: null });
    expect(body).toMatchObject({ miesiac: '2026-09', braki: ['Brak ustawień podatkowych.'], pozycje: [], doZatwierdzenia: 0 });
  });

  it('miesiąc w złym kształcie albo z przyszłości: 400 bez wyliczenia', async () => {
    for (const m of ['2026-13', 'abc', '2026-12']) {
      const response = await miesiacRoute(req(`ksiegowosc?miesiac=${m}`));
      expect(response.status).toBe(400);
    }
    expect(fake.czytaj).not.toHaveBeenCalled();
  });
});

describe('POST /ksiegowosc/zatwierdz i /rozliczenia/{id}/zaplata', () => {
  it('zatwierdzenie: tylko właściciel albo administrator, skróty z widoku, ta sama funkcja co strona', async () => {
    fake.zatwierdz.mockResolvedValue({ success: true, nowe: 1 });
    const response = await zatwierdzRoute(req('ksiegowosc/zatwierdz', { method: 'POST', body: { miesiac: '2026-10', skroty: { zus_spoleczne: H('b') } } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ nowe: 1 });
    expect(fake.zatwierdz).toHaveBeenCalledWith({ client: expect.anything(), tenantId: ORG_A, userId: USER_OWNER }, { miesiac: '2026-10', skroty: { zus_spoleczne: H('b') }, nadwyzkaVat: null });
    const czlonek = await zatwierdzRoute(req('ksiegowosc/zatwierdz', { method: 'POST', token: TOKEN_MEMBER, body: { miesiac: '2026-10', skroty: {} } }));
    expect(czlonek.status).toBe(403);
    expect(fake.zatwierdz).toHaveBeenCalledTimes(1);
  });

  it('treść spoza kontraktu (nieznany rodzaj, zły skrót, zły miesiąc): 400 `invalid_request` bez zapisu, nie odmowa rozliczenia', async () => {
    for (const body of [
      { miesiac: '2026-10', skroty: { inny: H('b') } },
      { miesiac: '2026-10', skroty: { vat: 'abc' } },
      { miesiac: '10-2026', skroty: {} },
    ]) {
      const response = await zatwierdzRoute(req('ksiegowosc/zatwierdz', { method: 'POST', body }));
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe('invalid_request');
    }
    expect(fake.zatwierdz).not.toHaveBeenCalled();
  });

  it('odmowa zapisu (dane zmieniły się od otwarcia): 422 `settlement_refused` ze zdaniem strony', async () => {
    fake.zatwierdz.mockResolvedValue({ success: false, error: 'Dane miesiąca zmieniły się od otwarcia, więc nic nie zatwierdziliśmy.' });
    const response = await zatwierdzRoute(req('ksiegowosc/zatwierdz', { method: 'POST', body: { miesiac: '2026-10', skroty: {} } }));
    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('settlement_refused');
  });

  it('zapłata rozliczenia: id z trasy, dzień z treści, ta sama funkcja co strona; członek dostaje 403', async () => {
    fake.zaplac.mockResolvedValue({ success: true });
    const response = await zaplataRoute(req(`ksiegowosc/rozliczenia/${ROZ_ID}/zaplata`, { method: 'POST', body: { zaplacone: true, dzien: '2026-11-13' } }), { params: Promise.resolve({ id: ROZ_ID }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ zaplacone: true });
    expect(fake.zaplac).toHaveBeenCalledWith({ client: expect.anything(), tenantId: ORG_A, userId: USER_OWNER }, { id: ROZ_ID, zaplacone: true, data: '2026-11-13' });
    const czlonek = await zaplataRoute(req(`ksiegowosc/rozliczenia/${ROZ_ID}/zaplata`, { method: 'POST', token: TOKEN_MEMBER, body: { zaplacone: true, dzien: '2026-11-13' } }), { params: Promise.resolve({ id: ROZ_ID }) });
    expect(czlonek.status).toBe(403);
  });
});

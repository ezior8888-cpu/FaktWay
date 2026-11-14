import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Plan aplikacji mobilnej, M10a: należności, zapłata, przypomnienia, PDF i
 * „Sprawdź teraz” z telefonu.
 *
 * Prawdziwe: trasy `app/api/mobile/v1/**`, bramka `authenticateMobileRequest`,
 * `lib/api/mobile/naleznosci.ts` i funkcje z `lib/` wspólne ze stroną:
 * `lib/invoices/mark-paid.ts` (zapłata) i `lib/reminders/pause.ts`
 * (wstrzymanie) aż do RPC w PostgREST. Atrapy: HTTP (GoTrue, PostgREST przez
 * `fetch`), Redis, kolejka, pamięć podręczna, analityka, webhooki. Funkcje,
 * które mają własne testy na ścieżce strony (lista „Po terminie”, podgląd
 * i zatwierdzenie przypomnienia, PDF, termin skrzynki), są tu granicą: test
 * sprawdza, że trasa daje im firmę i konto z tokenu i dobrze przekłada wynik.
 * Same RPC na prawdziwej bazie: `tests/rls-zaplacone.test.ts`.
 */

const SUPABASE_URL = 'https://db.fixture.test';
const ANON_KEY = 'anon-fixture-key';
const SERVICE_ROLE_KEY = 'service-fixture-key';

const USER_OWNER = 'aaaaaaaa-1111-4111-8111-000000000001';
const USER_ACCOUNTANT = 'aaaaaaaa-1111-4111-8111-000000000002';
const USER_MEMBER = 'aaaaaaaa-1111-4111-8111-000000000003';
const ORG_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const ORG_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const INVOICE = '11111111-1111-4111-8111-111111111111';
const PROPOSAL = '22222222-2222-4222-8222-222222222222';
const VERSION = 'a'.repeat(64);

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
  return {
    client,
    sets,
    revalidate: vi.fn(),
    invalidate: vi.fn(),
    track: vi.fn(),
    sendJob: vi.fn(async () => ({ ids: [] })),
    webhook: vi.fn(),
    overview: vi.fn(),
    prepare: vi.fn(),
    approve: vi.fn(),
    pdf: vi.fn(),
    poll: vi.fn(),
  };
});

vi.mock('@/lib/cache/redis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cache/redis')>();
  return { ...actual, isRedisConfigured: () => true, getRedis: () => fake.client };
});
vi.mock('@/lib/feature-flags/maintenance', () => ({ isMaintenanceMode: async () => false, MAINTENANCE_PATH: '/przerwa-techniczna' }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: fake.revalidate }));
vi.mock('@/lib/cache/invalidation', () => ({ invalidateTenantDashboard: fake.invalidate }));
vi.mock('@/lib/analytics/server', () => ({ trackServer: fake.track }));
vi.mock('@/lib/jobs/enqueue', () => ({ sendJobEvent: fake.sendJob }));
vi.mock('@/lib/webhooks/emit', () => ({ emitWebhookEvent: fake.webhook }));
vi.mock('@/lib/ksef/claim-environment', () => ({ requireConfiguredKsefEnvironment: () => 'test' }));
vi.mock('@/lib/overdue/load-overdue', () => ({ loadOverdueOverview: fake.overview }));
vi.mock('@/lib/reminders/prepare-preview', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/reminders/prepare-preview')>();
  return { ...actual, prepareReminderPreview: fake.prepare };
});
vi.mock('@/lib/flo/approve-proposal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/flo/approve-proposal')>();
  return { ...actual, approveFloProposal: fake.approve };
});
vi.mock('@/lib/pdf/invoice-pdf', () => ({ generateInvoicePdf: fake.pdf }));
vi.mock('@/lib/ksef/inbox-activity', () => ({ requestInboxPoll: fake.poll }));

import { GET as naleznosciRoute } from '@/app/api/mobile/v1/naleznosci/route';
import { POST as zaplataRoute } from '@/app/api/mobile/v1/faktury/[id]/zaplata/route';
import { POST as cofnijRoute } from '@/app/api/mobile/v1/faktury/[id]/zaplata/cofnij/route';
import { POST as podgladRoute } from '@/app/api/mobile/v1/faktury/[id]/przypomnienie/route';
import { POST as wstrzymanieRoute } from '@/app/api/mobile/v1/faktury/[id]/wstrzymanie/route';
import { GET as pdfRoute } from '@/app/api/mobile/v1/faktury/[id]/pdf/route';
import { POST as zatwierdzRoute } from '@/app/api/mobile/v1/przypomnienia/[id]/zatwierdz/route';
import { POST as sprawdzRoute } from '@/app/api/mobile/v1/skrzynka/sprawdz/route';
import type {
  NaleznosciOdpowiedz,
  PdfFakturyOdpowiedz,
  PodgladPrzypomnieniaOdpowiedz,
  SprawdzenieSkrzynkiOdpowiedz,
  ZaplataOdpowiedz,
} from '@/lib/api/mobile/kontrakt';

// ─── Tokeny ───────────────────────────────────────────────────────────

const b64url = (value: string) => Buffer.from(value).toString('base64url');
function accessToken(sub: string, n: number): string {
  const now = Math.floor(Date.now() / 1000);
  return [
    b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' })),
    b64url(JSON.stringify({ aud: 'authenticated', role: 'authenticated', iat: now, exp: now + 3600, sub, aal: 'aal1', session_id: `cccccccc-2222-4222-8222-00000000000${n}` })),
    b64url('fixture-signature'),
  ].join('.');
}
const TOKEN_OWNER = accessToken(USER_OWNER, 1);
const TOKEN_ACCOUNTANT = accessToken(USER_ACCOUNTANT, 2);
const TOKEN_MEMBER = accessToken(USER_MEMBER, 3);
const issued = new Map([[TOKEN_OWNER, USER_OWNER], [TOKEN_ACCOUNTANT, USER_ACCOUNTANT], [TOKEN_MEMBER, USER_MEMBER]]);

const memberships = [
  { user_id: USER_OWNER, organization_id: ORG_A, role: 'owner', status: 'active' },
  { user_id: USER_ACCOUNTANT, organization_id: ORG_A, role: 'accountant', status: 'active' },
  { user_id: USER_MEMBER, organization_id: ORG_A, role: 'member', status: 'active' },
];

// ─── Atrapa PostgREST: członkostwa i RPC zapłaty i wstrzymania ────────

type Rpc = { fn: string; args: Record<string, unknown>; token: string | null; org: string | null };
let rpcCalls: Rpc[] = [];
/** Stan faktury w atrapie RPC: jak 00158, druga zapłata to `already_paid`, drugie cofnięcie `nothing_to_undo`. */
let paid = false;
let rpcRefusal: string | null = null;
let pauseResult: unknown = true;

const eq = (url: URL, column: string) => {
  const value = url.searchParams.get(column);
  return value?.startsWith('eq.') ? decodeURIComponent(value.slice(3)) : null;
};

function reply(request: Request, rows: unknown[]): Response {
  const asObject = request.headers.get('accept')?.includes('vnd.pgrst.object');
  if (asObject) return rows[0] ? Response.json(rows[0]) : Response.json({ code: 'PGRST116', message: '0 rows' }, { status: 406 });
  return Response.json(rows);
}

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.origin !== SUPABASE_URL) throw new Error(`nieoczekiwane wyjście do ${url.origin}`);
  const token = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? null;

  if (url.pathname === '/auth/v1/user') {
    const sub = token ? issued.get(token) : undefined;
    if (!sub) return Response.json({ msg: 'invalid JWT' }, { status: 401 });
    return Response.json({ id: sub, aud: 'authenticated', role: 'authenticated', email: `${sub}@x.test`, factors: [] });
  }
  if (token === SERVICE_ROLE_KEY) return Response.json({ message: 'API aplikacji nie używa klucza serwisowego' }, { status: 418 });
  const sub = token ? issued.get(token) : undefined;
  if (!sub) return Response.json({ message: 'JWT invalid' }, { status: 401 });

  if (url.pathname === '/rest/v1/memberships') {
    return reply(request, memberships.filter((m) => m.user_id === sub && (eq(url, 'organization_id') === null || m.organization_id === eq(url, 'organization_id')) && m.status === 'active'));
  }
  if (url.pathname.startsWith('/rest/v1/rpc/')) {
    const fn = url.pathname.replace('/rest/v1/rpc/', '');
    const args = JSON.parse(await request.text()) as Record<string, unknown>;
    rpcCalls.push({ fn, args, token, org: request.headers.get('x-active-org') });
    if (fn === 'mark_invoice_paid') {
      if (rpcRefusal) return Response.json({ status: 'refused', code: rpcRefusal, internal_number: 'FV/1/11/2026' });
      if (paid) return Response.json({ status: 'already_paid', internal_number: 'FV/1/11/2026' });
      paid = true;
      return Response.json({ status: 'marked', amount: 1230, paid_on: (args.p_paid_on as string | null) ?? '2026-11-13', payment_id: '33333333-3333-4333-8333-333333333333', internal_number: 'FV/1/11/2026' });
    }
    if (fn === 'undo_invoice_paid') {
      if (!paid) return Response.json({ status: 'nothing_to_undo' });
      paid = false;
      return Response.json({ status: 'undone' });
    }
    if (fn === 'set_invoice_reminders_paused') return Response.json(pauseResult);
  }
  return Response.json({ message: `nieznana ścieżka ${url.pathname}` }, { status: 404 });
}

// ─── Żądania ──────────────────────────────────────────────────────────

let ip = 0;
function req(path: string, options: { method?: string; token?: string | null; org?: string | null; body?: unknown } = {}): Request {
  const headers: Record<string, string> = { 'x-real-ip': `198.51.100.${(ip += 1) % 250}` };
  if (options.token !== null) headers.authorization = `Bearer ${options.token ?? TOKEN_OWNER}`;
  if (options.org !== null) headers['x-active-org'] = options.org ?? ORG_A;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  return new Request(`https://app.example.test/api/mobile/v1/${path}`, {
    method: options.method ?? 'POST',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });

async function errorOf(response: Response) {
  return ((await response.json()) as { error: { code: string; message: string } }).error;
}

beforeEach(() => {
  vi.clearAllMocks();
  fake.sets.clear();
  rpcCalls = [];
  paid = false;
  rpcRefusal = null;
  pauseResult = true;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-13T09:00:00Z'));
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SUPABASE_URL);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', ANON_KEY);
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', SERVICE_ROLE_KEY);
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// ─── Bramka na każdej trasie ──────────────────────────────────────────

describe('każda trasa M10a za bramką', () => {
  it.each([
    ['GET /naleznosci', (o: Parameters<typeof req>[1]) => naleznosciRoute(req('naleznosci', { method: 'GET', ...o }))],
    ['POST /zaplata', (o: Parameters<typeof req>[1]) => zaplataRoute(req(`faktury/${INVOICE}/zaplata`, o), params(INVOICE))],
    ['POST /zaplata/cofnij', (o: Parameters<typeof req>[1]) => cofnijRoute(req(`faktury/${INVOICE}/zaplata/cofnij`, o), params(INVOICE))],
    ['POST /przypomnienie', (o: Parameters<typeof req>[1]) => podgladRoute(req(`faktury/${INVOICE}/przypomnienie`, o), params(INVOICE))],
    ['POST /wstrzymanie', (o: Parameters<typeof req>[1]) => wstrzymanieRoute(req(`faktury/${INVOICE}/wstrzymanie`, { body: { wstrzymane: true }, ...o }), params(INVOICE))],
    ['GET /pdf', (o: Parameters<typeof req>[1]) => pdfRoute(req(`faktury/${INVOICE}/pdf`, { method: 'GET', ...o }), params(INVOICE))],
    ['POST /zatwierdz', (o: Parameters<typeof req>[1]) => zatwierdzRoute(req(`przypomnienia/${PROPOSAL}/zatwierdz`, { body: { wersja: VERSION, tresc: 'x' }, ...o }), params(PROPOSAL))],
    ['POST /skrzynka/sprawdz', (o: Parameters<typeof req>[1]) => sprawdzRoute(req('skrzynka/sprawdz', o))],
  ])('%s: bez tokenu 401, bez firmy 400, cudza firma 403; nic nie dotyka danych', async (_nazwa, wywolaj) => {
    const bezTokenu = await wywolaj({ token: null });
    expect(bezTokenu.status).toBe(401);
    expect((await errorOf(bezTokenu)).code).toBe('missing_token');
    const bezFirmy = await wywolaj({ org: null });
    expect(bezFirmy.status).toBe(400);
    expect((await errorOf(bezFirmy)).code).toBe('missing_org');
    const cudza = await wywolaj({ org: ORG_B });
    expect(cudza.status).toBe(403);
    expect((await errorOf(cudza)).code).toBe('no_active_org');
    expect(rpcCalls).toEqual([]);
    for (const granica of [fake.overview, fake.prepare, fake.approve, fake.pdf, fake.poll]) expect(granica).not.toHaveBeenCalled();
  });
});

// ─── Należności ───────────────────────────────────────────────────────

describe('GET /api/mobile/v1/naleznosci', () => {
  const wiersz = {
    id: INVOICE, internal_number: 'FV/1/10/2026', payment_due_date: '2026-10-20', gross_total: 1230, amount_due: 1000,
    days_overdue: 24, buyer_name: 'Klient Sp. z o.o.', buyer_nip: '5252241585', buyer_email: 'klient@example.test',
    reminders_paused: false, reminders_sent_count: 1, reminder_status: 'pending',
    latest_reminder: { stage: 1, status: 'sent', scheduledFor: '2026-10-28T08:00:00.000Z' },
  };

  it('ta sama lista co strona „Po terminie”: firma z nagłówka, środowisko KSeF z konfiguracji, klient z tokenu', async () => {
    fake.overview.mockResolvedValue({ ok: true, invoices: [wiersz], limitReached: false, sentThisMonth: 3 });
    const response = await naleznosciRoute(req('naleznosci', { method: 'GET' }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as NaleznosciOdpowiedz;
    expect(body).toEqual({
      faktury: [{
        id: INVOICE, numer: 'FV/1/10/2026', kontrahent: 'Klient Sp. z o.o.', nip: '5252241585', email: 'klient@example.test',
        termin: '2026-10-20', brutto: 1230, doZaplaty: 1000, dniPoTerminie: 24, wstrzymane: false, wyslane: 1,
        kolejka: 'zaplanowane', ostatnie: { status: 'sent', etap: 1, kiedy: '2026-10-28T08:00:00.000Z' },
      }],
      blad: null,
      limit: false,
      wyslaneWMiesiacu: 3,
      mozeOznaczac: true,
      mozeZatwierdzac: true,
    });
    const [klient, firma, srodowisko] = fake.overview.mock.calls[0]!;
    expect(firma).toBe(ORG_A);
    expect(srodowisko).toBe('test');
    expect(typeof (klient as { from?: unknown }).from).toBe('function');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('księgowa ma wgląd: lista tak, oznaczanie i zatwierdzanie nie; nieznany odczyt kolejki zostaje „nieznany”', async () => {
    fake.overview.mockResolvedValue({ ok: true, invoices: [{ ...wiersz, reminder_status: 'unavailable', latest_reminder: 'unavailable' }], limitReached: true, sentThisMonth: null });
    const body = (await (await naleznosciRoute(req('naleznosci', { method: 'GET', token: TOKEN_ACCOUNTANT }))).json()) as NaleznosciOdpowiedz;
    expect(body.mozeOznaczac).toBe(false);
    expect(body.mozeZatwierdzac).toBe(false);
    expect(body.limit).toBe(true);
    expect(body.wyslaneWMiesiacu).toBeNull();
    expect(body.faktury[0]).toMatchObject({ kolejka: 'nieznany', ostatnie: 'nieznany' });
  });

  it('listy nie da się potwierdzić: 200 z tym samym zdaniem co strona i pustą listą', async () => {
    fake.overview.mockResolvedValue({ ok: false, error: 'Nie można potwierdzić pełnej listy zaległych faktur' });
    const body = (await (await naleznosciRoute(req('naleznosci', { method: 'GET', token: TOKEN_MEMBER }))).json()) as NaleznosciOdpowiedz;
    expect(body).toMatchObject({ faktury: [], blad: 'Nie można potwierdzić pełnej listy zaległych faktur', mozeOznaczac: true, mozeZatwierdzac: false });
  });
});

// ─── Zapłata ──────────────────────────────────────────────────────────

describe('POST /faktury/{id}/zaplata i /zaplata/cofnij', () => {
  const oznacz = (o: Parameters<typeof req>[1] = {}) => zaplataRoute(req(`faktury/${INVOICE}/zaplata`, o), params(INVOICE));
  const cofnij = (o: Parameters<typeof req>[1] = {}) => cofnijRoute(req(`faktury/${INVOICE}/zaplata/cofnij`, o), params(INVOICE));

  it('oznaczenie: RPC 00158 tokenem klienta w jego firmie, raz pamięć podręczna, zdarzenie wpłaty, analityka i webhook', async () => {
    const response = await oznacz({ token: TOKEN_MEMBER });
    expect(response.status).toBe(200);
    expect((await response.json()) as ZaplataOdpowiedz).toEqual({ zaplacona: true, juzBylo: false, numer: 'FV/1/11/2026' });
    expect(rpcCalls).toEqual([{ fn: 'mark_invoice_paid', args: { p_invoice_id: INVOICE, p_paid_on: null }, token: TOKEN_MEMBER, org: ORG_A }]);
    expect(fake.invalidate).toHaveBeenCalledWith(ORG_A);
    expect(fake.sendJob).toHaveBeenCalledTimes(1);
    expect(fake.track).toHaveBeenCalledWith(expect.objectContaining({ userId: USER_MEMBER, tenantId: ORG_A, properties: { source: 'manual', role: 'member' } }));
    expect(fake.webhook).toHaveBeenCalledWith({ tenantId: ORG_A, type: 'payment.recorded', entityId: '33333333-3333-4333-8333-333333333333' });
    expect(fake.revalidate.mock.calls.map((c) => c[0])).toContain('/payments/overdue');
  });

  it('ponowienie po zerwanym połączeniu: `juzBylo`, bez drugiego zdarzenia, analityki i webhooka', async () => {
    await oznacz();
    vi.clearAllMocks();
    const response = await oznacz();
    expect((await response.json()) as ZaplataOdpowiedz).toEqual({ zaplacona: true, juzBylo: true, numer: 'FV/1/11/2026' });
    expect(fake.sendJob).not.toHaveBeenCalled();
    expect(fake.track).not.toHaveBeenCalled();
    expect(fake.webhook).not.toHaveBeenCalled();
  });

  it('dzień zapłaty z treści idzie do RPC; zły dzień odmawia bez RPC', async () => {
    await oznacz({ body: { dzien: '2026-11-10' } });
    expect(rpcCalls[0]!.args).toEqual({ p_invoice_id: INVOICE, p_paid_on: '2026-11-10' });
    rpcCalls = [];
    const zly = await oznacz({ body: { dzien: '2026-02-30' } });
    expect(zly.status).toBe(422);
    expect((await errorOf(zly)).code).toBe('payment_refused');
    expect(rpcCalls).toEqual([]);
  });

  it('księgowa: 403 `forbidden` ze zdaniem strony, bez RPC', async () => {
    const response = await oznacz({ token: TOKEN_ACCOUNTANT });
    expect(response.status).toBe(403);
    expect(await errorOf(response)).toEqual({ code: 'forbidden', message: 'Zapłatę oznacza właściciel, administrator albo członek firmy. Księgowa ma tu wgląd.' });
    expect(rpcCalls).toEqual([]);
    const cofniecie = await cofnij({ token: TOKEN_ACCOUNTANT });
    expect(cofniecie.status).toBe(403);
  });

  it('odmowa RPC (faktura skorygowana): 422 `payment_refused` ze zdaniem strony i numerem', async () => {
    rpcRefusal = 'not_found';
    const response = await oznacz();
    expect(response.status).toBe(422);
    const error = await errorOf(response);
    expect(error.code).toBe('payment_refused');
    expect(error.message).toMatch(/Nie znaleziono tej faktury/);
  });

  it('cofnięcie: `undo_invoice_paid`; drugie cofnięcie to `juzBylo` bez zmian', async () => {
    await oznacz();
    const pierwsze = await cofnij();
    expect((await pierwsze.json()) as ZaplataOdpowiedz).toEqual({ zaplacona: false, juzBylo: false, numer: null });
    const drugie = await cofnij();
    expect((await drugie.json()) as ZaplataOdpowiedz).toEqual({ zaplacona: false, juzBylo: true, numer: null });
    expect(rpcCalls.map((c) => c.fn)).toEqual(['mark_invoice_paid', 'undo_invoice_paid', 'undo_invoice_paid']);
  });

  it('identyfikator spoza UUID: 404 bez RPC', async () => {
    const response = await zaplataRoute(req('faktury/nie-uuid/zaplata'), params('nie-uuid'));
    expect(response.status).toBe(404);
    expect(rpcCalls).toEqual([]);
  });
});

// ─── Przypomnienia ────────────────────────────────────────────────────

describe('POST /faktury/{id}/przypomnienie (podgląd) i /przypomnienia/{id}/zatwierdz', () => {
  const podglad = {
    success: true, proposalId: PROPOSAL, approvalVersion: VERSION, expiresAt: '2026-11-13T09:30:00.000Z',
    preview: { from: 'Firma A <powiadomienia@faktflow.pl>', to: 'klient@example.test', replyTo: 'biuro@a.test', subject: 'Przypomnienie o płatności FV/1/10/2026', body: 'Dzień dobry…', attachment: { filename: 'wezwanie.pdf', contentBase64: 'JVBERi0=' } },
  };

  it('podgląd: firma i konto z tokenu, adres z treści, nic nie wychodzi; odpowiedź jak okno strony', async () => {
    fake.prepare.mockResolvedValue(podglad);
    const response = await podgladRoute(req(`faktury/${INVOICE}/przypomnienie`, { token: TOKEN_MEMBER, body: { email: 'inny@example.test' } }), params(INVOICE));
    expect(response.status).toBe(200);
    expect((await response.json()) as PodgladPrzypomnieniaOdpowiedz).toEqual({
      propozycja: PROPOSAL, wersja: VERSION, wazneDo: '2026-11-13T09:30:00.000Z', od: podglad.preview.from, do: 'klient@example.test',
      odpowiedzNa: 'biuro@a.test', temat: podglad.preview.subject, tresc: 'Dzień dobry…', zalacznik: { nazwa: 'wezwanie.pdf', pdfBase64: 'JVBERi0=' },
    });
    const [ctx, input] = fake.prepare.mock.calls[0]!;
    expect(ctx).toMatchObject({ tenantId: ORG_A, userId: USER_MEMBER });
    expect(input).toEqual({ invoiceId: INVOICE, recipientEmail: 'inny@example.test' });
    expect(fake.approve).not.toHaveBeenCalled();
  });

  it('odmowa podglądu (etap już zlecony): 422 `reminder_refused` ze zdaniem strony', async () => {
    fake.prepare.mockResolvedValue({ success: false, error: 'Ten etap już zlecono. Nie ponawiaj wysyłki; status musi sprawdzić administrator.' });
    const response = await podgladRoute(req(`faktury/${INVOICE}/przypomnienie`), params(INVOICE));
    expect(response.status).toBe(422);
    expect(await errorOf(response)).toEqual({ code: 'reminder_refused', message: 'Ten etap już zlecono. Nie ponawiaj wysyłki; status musi sprawdzić administrator.' });
  });

  it('zły adres w treści: 422 bez przygotowania', async () => {
    const response = await podgladRoute(req(`faktury/${INVOICE}/przypomnienie`, { body: { email: 'to nie adres' } }), params(INVOICE));
    expect(response.status).toBe(422);
    expect((await errorOf(response)).code).toBe('reminder_refused');
    expect(fake.prepare).not.toHaveBeenCalled();
  });

  it('zatwierdzenie: właściciel, tylko rodzaj `payment.chase`, ta wersja i poprawiona treść', async () => {
    fake.approve.mockResolvedValue({ ok: true });
    const response = await zatwierdzRoute(req(`przypomnienia/${PROPOSAL}/zatwierdz`, { body: { wersja: VERSION, tresc: 'Poprawiona treść' } }), params(PROPOSAL));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ zlecone: true });
    expect(fake.approve).toHaveBeenCalledWith(
      { tenantId: ORG_A, userId: USER_OWNER, role: 'owner' },
      PROPOSAL,
      VERSION,
      { editedBody: 'Poprawiona treść' },
      { onlyKind: 'payment.chase' },
    );
  });

  it('członek firmy nie zatwierdza (jak strona): 403 bez zatwierdzenia', async () => {
    const response = await zatwierdzRoute(req(`przypomnienia/${PROPOSAL}/zatwierdz`, { token: TOKEN_MEMBER, body: { wersja: VERSION, tresc: 'x' } }), params(PROPOSAL));
    expect(response.status).toBe(403);
    expect((await errorOf(response)).code).toBe('forbidden');
    expect(fake.approve).not.toHaveBeenCalled();
  });

  it('ponowienie po zerwanym połączeniu albo zmieniony podgląd: 422 `reminder_refused` ze zdaniem, bez drugiej wysyłki', async () => {
    fake.approve.mockResolvedValue({ ok: false, reason: 'blocked', message: 'Ta sprawa jest już w toku.' });
    const response = await zatwierdzRoute(req(`przypomnienia/${PROPOSAL}/zatwierdz`, { body: { wersja: VERSION, tresc: 'x' } }), params(PROPOSAL));
    expect(response.status).toBe(422);
    expect(await errorOf(response)).toEqual({ code: 'reminder_refused', message: 'Ta sprawa jest już w toku.' });
  });

  it('wysyłka padła po zgodzie: zdanie bez Flo w pierwszej osobie, z tym, co zrobić (plan D13)', async () => {
    fake.approve.mockResolvedValue({ ok: false, reason: 'blocked', message: 'Nie udało mi się tego dokończyć. Zajmujemy się tym.' });
    const response = await zatwierdzRoute(req(`przypomnienia/${PROPOSAL}/zatwierdz`, { body: { wersja: VERSION, tresc: 'x' } }), params(PROPOSAL));
    expect(response.status).toBe(422);
    const error = await errorOf(response);
    expect(error.code).toBe('reminder_refused');
    expect(error.message).toMatch(/^Nie zleciliśmy wysyłki tego przypomnienia\. Przygotuj nowy podgląd/);
    expect(error.message).not.toMatch(/\bmi\b/);
  });

  it.each([
    [{ ok: false, reason: 'expired', message: 'Minął termin tej propozycji. Przygotuję ją od nowa.' }, /^Ten podgląd już nie obowiązuje/],
    [{ ok: false, reason: 'blocked', message: 'Nie rozpoznaję tego rodzaju sprawy, zgłosiłem to zespołowi.' }, /^Nie zleciliśmy wysyłki/],
    [{ ok: false, reason: 'stale', message: 'Propozycja zmieniła się. Sprawdź ją ponownie przed zatwierdzeniem.' }, /^Propozycja zmieniła się/],
  ])('odmowa wykonawcy %j: zdanie bez pierwszej osoby', async (wynik, zdanie) => {
    fake.approve.mockResolvedValue(wynik);
    const response = await zatwierdzRoute(req(`przypomnienia/${PROPOSAL}/zatwierdz`, { body: { wersja: VERSION, tresc: 'x' } }), params(PROPOSAL));
    expect((await errorOf(response)).message).toMatch(zdanie);
  });

  it('zła wersja albo pusta treść: 400 bez zatwierdzenia', async () => {
    for (const body of [{ wersja: 'krotka', tresc: 'x' }, { wersja: VERSION, tresc: '   ' }, { wersja: VERSION }]) {
      const response = await zatwierdzRoute(req(`przypomnienia/${PROPOSAL}/zatwierdz`, { body }), params(PROPOSAL));
      expect(response.status).toBe(400);
    }
    expect(fake.approve).not.toHaveBeenCalled();
  });
});

describe('POST /faktury/{id}/wstrzymanie', () => {
  it('RPC `set_invoice_reminders_paused` tokenem klienta w jego firmie', async () => {
    const response = await wstrzymanieRoute(req(`faktury/${INVOICE}/wstrzymanie`, { token: TOKEN_MEMBER, body: { wstrzymane: true } }), params(INVOICE));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ wstrzymane: true });
    expect(rpcCalls).toEqual([{ fn: 'set_invoice_reminders_paused', args: { p_invoice_id: INVOICE, p_paused: true, p_reason: null }, token: TOKEN_MEMBER, org: ORG_A }]);
  });

  it('RPC nie potwierdza zmiany: 422 ze zdaniem strony', async () => {
    pauseResult = false;
    const response = await wstrzymanieRoute(req(`faktury/${INVOICE}/wstrzymanie`, { body: { wstrzymane: false } }), params(INVOICE));
    expect(response.status).toBe(422);
    expect(await errorOf(response)).toEqual({ code: 'reminder_refused', message: 'Nie udało się zmienić stanu przypomnień. Spróbuj ponownie.' });
  });

  it('treść bez `wstrzymane`: 400 bez RPC', async () => {
    const response = await wstrzymanieRoute(req(`faktury/${INVOICE}/wstrzymanie`, { body: {} }), params(INVOICE));
    expect(response.status).toBe(400);
    expect(rpcCalls).toEqual([]);
  });
});

// ─── PDF ──────────────────────────────────────────────────────────────

describe('GET /faktury/{id}/pdf', () => {
  it('ten sam PDF co strona dla firmy z nagłówka (członkostwo sprawdzone tokenem)', async () => {
    fake.pdf.mockResolvedValue({ success: true, pdf: Buffer.from('%PDF-1.7'), filename: 'FV_1_11_2026.pdf', qrStateKey: 'k', missingKodI: false });
    const response = await pdfRoute(req(`faktury/${INVOICE}/pdf`, { method: 'GET' }), params(INVOICE));
    expect(response.status).toBe(200);
    expect((await response.json()) as PdfFakturyOdpowiedz).toEqual({ nazwa: 'FV_1_11_2026.pdf', pdfBase64: Buffer.from('%PDF-1.7').toString('base64') });
    expect(fake.pdf).toHaveBeenCalledWith(INVOICE, ORG_A);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it.each([
    ['NOT_FOUND', 404, 'not_found'],
    ['FORBIDDEN', 404, 'not_found'],
    ['OFFLINE_QR_UNAVAILABLE', 409, 'pdf_unavailable'],
    ['RETIRED_DRAFT', 409, 'pdf_unavailable'],
    ['PDF_STATE_CHANGED', 409, 'pdf_unavailable'],
  ])('%s: %i %s', async (code, status, kod) => {
    fake.pdf.mockResolvedValue({ success: false, code, error: 'Zdanie strony.' });
    const response = await pdfRoute(req(`faktury/${INVOICE}/pdf`, { method: 'GET' }), params(INVOICE));
    expect(response.status).toBe(status);
    expect((await errorOf(response)).code).toBe(kod);
  });

  it('identyfikator spoza UUID: 404 bez generowania', async () => {
    const response = await pdfRoute(req('faktury/x/pdf', { method: 'GET' }), params('x'));
    expect(response.status).toBe(404);
    expect(fake.pdf).not.toHaveBeenCalled();
  });
});

// ─── Skrzynka KSeF ────────────────────────────────────────────────────

describe('POST /skrzynka/sprawdz', () => {
  it.each([
    [{ status: 'accepted', retryAfterSeconds: 0 }, { stan: 'zlecone', komunikat: 'Sprawdzamy KSeF. Nowe faktury pojawią się na liście za chwilę.', ponowZaSekund: null }],
    [{ status: 'in_flight', retryAfterSeconds: 0 }, { stan: 'w_toku', komunikat: 'Właśnie sprawdzamy KSeF. Nowe faktury pojawią się na liście za chwilę.', ponowZaSekund: null }],
    [{ status: 'too_soon', retryAfterSeconds: 130 }, { stan: 'za_wczesnie', komunikat: 'KSeF sprawdzamy właśnie albo sprawdzaliśmy przed chwilą. Spróbuj ponownie za 3 min.', ponowZaSekund: 130 }],
    [{ status: 'no_ksef', retryAfterSeconds: 0 }, { stan: 'bez_ksef', komunikat: 'Podłącz KSeF w ustawieniach, żeby sprawdzać nowe faktury.', ponowZaSekund: null }],
  ])('termin firmy z nagłówka: %j', async (wynik, odpowiedz) => {
    fake.poll.mockResolvedValue(wynik);
    const response = await sprawdzRoute(req('skrzynka/sprawdz'));
    expect(response.status).toBe(200);
    expect((await response.json()) as SprawdzenieSkrzynkiOdpowiedz).toEqual(odpowiedz);
    expect(fake.poll).toHaveBeenCalledWith(ORG_A);
  });

  it('błąd terminu: zdanie strony, bez szczegółów', async () => {
    fake.poll.mockRejectedValue(new Error('PRIVATE'));
    const body = (await (await sprawdzRoute(req('skrzynka/sprawdz'))).json()) as SprawdzenieSkrzynkiOdpowiedz;
    expect(body).toEqual({ stan: 'blad', komunikat: 'Nie udało się sprawdzić KSeF. Spróbuj ponownie za chwilę.', ponowZaSekund: null });
  });
});

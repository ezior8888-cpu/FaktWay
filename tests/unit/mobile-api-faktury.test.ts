import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { z } from 'zod';

/**
 * Plan aplikacji mobilnej, M8: szybka faktura z telefonu.
 *
 * Prawdziwe: trasy `app/api/mobile/v1/faktury/*`, bramka `authenticateMobileRequest`,
 * `lib/api/mobile/faktury.ts`, schematy, `lib/invoices/issue-regular.ts`
 * i `send-draft.ts` (te same funkcje co akcje strony). Atrapy tylko dla HTTP
 * i baz: GoTrue i PostgREST przez `fetch` (tabele, unikalne indeksy i RLS
 * firmy w uproszczeniu), kolejka KSeF (granica pg-boss i RPC `enqueue_ksef_send`:
 * przejmuje tylko szkic, jak w bazie), audyt i Redis. Prawdziwą tabelę kluczy
 * z RLS sprawdza `tests/rls-mobile-faktury.test.ts` na bazie.
 */

const SUPABASE_URL = 'https://db.fixture.test';
const ANON_KEY = 'anon-fixture-key';
const SERVICE_ROLE_KEY = 'service-fixture-key';

const USER_A = 'aaaaaaaa-1111-4111-8111-000000000001';
const USER_TOTP = 'bbbbbbbb-1111-4111-8111-000000000002';
const ORG_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const ORG_B = 'bbbbbbbb-0000-4000-8000-000000000003';
const KEY_1 = '0c4e5f1a-7b2d-4c3e-9f10-111111111111';
const KEY_2 = '0c4e5f1a-7b2d-4c3e-9f10-222222222222';

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
  return { client, sets, enqueue: vi.fn(), audit: vi.fn(), revalidate: vi.fn() };
});

vi.mock('@/lib/cache/redis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cache/redis')>();
  return { ...actual, isRedisConfigured: () => true, getRedis: () => fake.client };
});
vi.mock('@/lib/feature-flags/maintenance', () => ({ isMaintenanceMode: async () => false, MAINTENANCE_PATH: '/przerwa-techniczna' }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: fake.revalidate }));
vi.mock('@/lib/audit/log', () => ({ logAudit: fake.audit, logAuditWithResult: fake.audit }));
vi.mock('@/lib/invoices/ksef-submit-enqueue', () => ({ enqueueKsefSubmitAfterDraft: fake.enqueue }));

import { POST as wysylkaRoute } from '@/app/api/mobile/v1/faktury/[id]/wysylka/route';
import { GET as podpowiedzRoute } from '@/app/api/mobile/v1/faktury/podpowiedz/route';
import { POST as fakturyRoute } from '@/app/api/mobile/v1/faktury/route';
import type { FakturaTelefonu, WystawienieOdpowiedz, WystawienieZadanie, WysylkaSzkicuOdpowiedz } from '@/lib/api/mobile/kontrakt';
import { fakturaTelefonuSchema, wystawienieSchema } from '@/lib/api/mobile/schematy';
import type { InvoiceFormValues } from '@/lib/schemas/invoice-form';

// ─── Tokeny ───────────────────────────────────────────────────────────

const b64url = (value: string) => Buffer.from(value).toString('base64url');
function accessToken(claims: Record<string, unknown>): string {
  const now = Math.floor(Date.now() / 1000);
  return [
    b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' })),
    b64url(JSON.stringify({ aud: 'authenticated', role: 'authenticated', iat: now, exp: now + 3600, ...claims })),
    b64url('fixture-signature'),
  ].join('.');
}
const TOKEN_A = accessToken({ sub: USER_A, aal: 'aal1', session_id: 'cccccccc-2222-4222-8222-000000000001' });
const TOKEN_TOTP = accessToken({ sub: USER_TOTP, aal: 'aal2', session_id: 'cccccccc-2222-4222-8222-000000000002' });
const users: Record<string, { id: string; factors: Array<{ id: string; factor_type: string; status: string }> }> = {
  [USER_A]: { id: USER_A, factors: [] },
  [USER_TOTP]: { id: USER_TOTP, factors: [{ id: 'f-1', factor_type: 'totp', status: 'verified' }] },
};
const issued = new Map([[TOKEN_A, USER_A], [TOKEN_TOTP, USER_TOTP]]);

// ─── Atrapa bazy ──────────────────────────────────────────────────────

type Row = Record<string, unknown>;
let invoices: Row[] = [];
let lines: Row[] = [];
let keys: Row[] = [];
let keyInsertFails = false;
let idCounter = 0;
let counter = 4;
let series: Row[] = [];
const writes: Array<{ table: string; method: string }> = [];

const memberships = [
  { user_id: USER_A, organization_id: ORG_A, role: 'owner', status: 'active' },
  { user_id: USER_TOTP, organization_id: ORG_B, role: 'owner', status: 'active' },
];
const tenants: Record<string, Row> = {
  [ORG_A]: { id: ORG_A, nip: '5260001246', name: 'Firma A', address_json: { countryCode: 'PL', addressLine1: 'ul. A 1', addressLine2: '00-001 Warszawa' }, vat_exemption_basis: null, vat_cash_method: false },
  [ORG_B]: { id: ORG_B, nip: '1234567890', name: 'Firma B', address_json: { countryCode: 'PL', addressLine1: 'ul. B 2', addressLine2: '00-002 Warszawa' }, vat_exemption_basis: null, vat_cash_method: false },
};

const eq = (url: URL, column: string) => {
  const value = url.searchParams.get(column);
  return value?.startsWith('eq.') ? decodeURIComponent(value.slice(3)) : null;
};
const matches = (url: URL, row: Row, columns: string[]) =>
  columns.every((c) => eq(url, c) === null || String(row[c]) === eq(url, c));
const conflict = (constraint: string) =>
  Response.json({ code: '23505', message: `duplicate key value violates unique constraint "${constraint}"` }, { status: 409 });

/** Odpowiedź jak PostgREST: obiekt przy `.single()` (Accept object), inaczej lista. */
function reply(request: Request, rows: Row[], status = 200): Response {
  const asObject = request.headers.get('accept')?.includes('vnd.pgrst.object');
  if (asObject) return rows[0] ? Response.json(rows[0], { status }) : Response.json({ code: 'PGRST116', message: '0 rows' }, { status: 406 });
  return Response.json(rows, { status });
}

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.origin !== SUPABASE_URL) throw new Error(`nieoczekiwane wyjście do ${url.origin}`);
  const token = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? null;

  if (url.pathname === '/auth/v1/user') {
    const sub = token ? issued.get(token) : undefined;
    if (!sub) return Response.json({ msg: 'invalid JWT' }, { status: 401 });
    return Response.json({ id: sub, aud: 'authenticated', role: 'authenticated', email: `${sub}@x.test`, factors: users[sub]!.factors });
  }

  if (token === SERVICE_ROLE_KEY) return Response.json({ message: 'API aplikacji nie używa klucza serwisowego' }, { status: 418 });
  const sub = token ? issued.get(token) : undefined;
  if (!sub) return Response.json({ message: 'JWT invalid' }, { status: 401 });
  // RLS firmy w uproszczeniu: `get_current_tenant_id()` z nagłówka i członkostwa.
  const org = request.headers.get('x-active-org');
  const current = memberships.some((m) => m.user_id === sub && m.organization_id === org && m.status === 'active') ? org : null;
  const table = url.pathname.replace('/rest/v1/', '');
  const method = request.method;
  if (method !== 'GET') writes.push({ table, method });

  if (table === 'memberships') {
    return reply(request, memberships.filter((m) => m.user_id === sub && matches(url, m, ['organization_id', 'status'])));
  }
  if (table === 'tenants') return reply(request, current && eq(url, 'id') === current ? [tenants[current]!] : []);

  if (table === 'mobile_idempotency_keys') {
    if (method === 'POST') {
      const row = JSON.parse(await request.text()) as Row;
      if (keyInsertFails) return Response.json({ message: 'boom' }, { status: 500 });
      if (row.user_id !== sub || row.tenant_id !== current) return Response.json({ code: '42501', message: 'RLS' }, { status: 403 });
      if (keys.some((k) => k.tenant_id === row.tenant_id && k.user_id === row.user_id && k.idempotency_key === row.idempotency_key)) {
        return conflict('uq_mobile_idempotency_keys_key');
      }
      keys.push(row);
      return new Response(null, { status: 201 });
    }
    return reply(request, keys.filter((k) => k.user_id === sub && k.tenant_id === current && matches(url, k, ['tenant_id', 'user_id', 'idempotency_key'])));
  }

  if (table === 'rpc/invoice_number_series_overview') return Response.json({ series });
  if (table === 'rpc/invoice_number_next') {
    counter += 1;
    return Response.json({ status: 'ok', number: `FV/${counter}/11/2026`, counter, period: '2026-11' });
  }
  if (table === 'invoices') {
    if (method === 'POST') {
      const row = JSON.parse(await request.text()) as Row;
      if (row.tenant_id !== current) return Response.json({ code: '42501', message: 'RLS' }, { status: 403 });
      // Wyzwalacz 00199 `zzz_invoice_number_assign`: drugi zapis z tym samym kluczem zapisu.
      if (row.number_request_key && invoices.some((i) => i.tenant_id === row.tenant_id && i.number_request_key === row.number_request_key)) {
        return Response.json({ code: 'P0001', message: 'invoice_number_request_done' }, { status: 400 });
      }
      if (invoices.some((i) => i.tenant_id === row.tenant_id && i.internal_number === row.internal_number)) {
        return conflict('uq_invoices_tenant_internal_number');
      }
      const saved = { ...row, id: `00000000-0000-4000-8000-${String((idCounter += 1)).padStart(12, '0')}`, ksef_status: 'draft' };
      invoices.push(saved);
      return reply(request, [{ id: saved.id }], 201);
    }
    if (method === 'DELETE') {
      invoices = invoices.filter((i) => !(i.tenant_id === current && matches(url, i, ['id'])));
      return new Response(null, { status: 204 });
    }
    const visible = invoices.filter((i) => i.tenant_id === current && matches(url, i, ['id', 'tenant_id', 'direction', 'number_request_key']));
    return reply(request, url.searchParams.has('limit') ? visible.slice(-1) : visible);
  }
  if (table === 'invoice_line_items') {
    lines.push(...(JSON.parse(await request.text()) as Row[]));
    return new Response(null, { status: 201 });
  }
  if (table === 'ksef_submissions') return reply(request, []);
  return Response.json({ message: `nieznana tabela ${table}` }, { status: 404 });
}

// ─── Żądania ──────────────────────────────────────────────────────────

let ip = 0;
const DZIS = '2026-11-13';

const faktura = (extra: Partial<FakturaTelefonu> = {}): FakturaTelefonu => ({
  internalNumber: 'FV/1/11/2026',
  issueDate: DZIS,
  saleDate: '',
  buyerNip: '5252241585',
  buyerName: 'Klient Sp. z o.o.',
  buyerAddressLine1: 'ul. Kliencka 3',
  buyerAddressLine2: '00-003 Warszawa',
  buyerEmail: '',
  buyerIsConsumer: false,
  lines: [{ name: 'Projekt graficzny', unit: 'szt', quantity: 1, unitPriceNet: 1500, vatRate: '23' }],
  paymentMethod: 'transfer',
  paymentDueDate: '2026-11-27',
  bankAccount: 'PL61109010140000071219812874',
  notes: '',
  splitPayment: false,
  numberSeriesId: '',
  numberPreview: '',
  ...extra,
});

function post(path: string, body: unknown, options: { token?: string; org?: string | null; key?: string | null } = {}): Request {
  const headers: Record<string, string> = {
    authorization: `Bearer ${options.token ?? TOKEN_A}`,
    'content-type': 'application/json',
    'x-real-ip': `198.51.100.${(ip += 1) % 250}`,
  };
  if (options.org !== null) headers['x-active-org'] = options.org ?? ORG_A;
  if (options.key !== null) headers['idempotency-key'] = options.key ?? KEY_1;
  return new Request(`https://app.example.test${path}`, { method: 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

const wystaw = (body: unknown, options?: Parameters<typeof post>[2]) => fakturyRoute(post('/api/mobile/v1/faktury', body, options));
const wyslijSzkic = (id: string, options?: Parameters<typeof post>[2]) =>
  wysylkaRoute(post(`/api/mobile/v1/faktury/${id}/wysylka`, undefined, { key: null, ...options }), { params: Promise.resolve({ id }) });

async function errorOf(response: Response) {
  return ((await response.json()) as { error: { code: string; message: string; field?: string } }).error;
}

/** Kolejka jak RPC `enqueue_ksef_send`: przejmuje tylko szkic. */
function kolejkaPrzyjmuje() {
  fake.enqueue.mockImplementation(async (params: { invoiceId: string }) => {
    const row = invoices.find((i) => i.id === params.invoiceId);
    if (!row || row.ksef_status !== 'draft') return { ok: false, error: 'Faktura jest już wysyłana do KSeF.' };
    row.ksef_status = 'queued';
    return { ok: true, mode: 'online_queued' };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  fake.sets.clear();
  invoices = [];
  lines = [];
  keys = [];
  keyInsertFails = false;
  idCounter = 0;
  counter = 4;
  series = [];
  writes.length = 0;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-13T09:00:00Z'));
  kolejkaPrzyjmuje();
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

// ─── Kontrakt ─────────────────────────────────────────────────────────

describe('kontrakt treści i schemat', () => {
  it('schemat telefonu daje dokładnie typy kontraktu', () => {
    expectTypeOf<z.output<typeof wystawienieSchema>>().toEqualTypeOf<WystawienieZadanie>();
    expectTypeOf<z.output<typeof fakturaTelefonuSchema>>().toEqualTypeOf<FakturaTelefonu>();
  });

  it('pola faktury telefonu są polami formularza strony', () => {
    expectTypeOf<keyof FakturaTelefonu>().toExtend<keyof InvoiceFormValues>();
  });
});

// ─── POST /faktury ────────────────────────────────────────────────────

describe('POST /api/mobile/v1/faktury', () => {
  it('bez firmy: 400 missing_org bez zapisu', async () => {
    const response = await wystaw({ wyslij: true, faktura: faktura() }, { org: null });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('missing_org');
    expect(writes).toEqual([]);
  });

  it.each([null, 'klucz-1', ''])('klucz %j: 400 missing_idempotency_key bez zapisu', async (key) => {
    const response = await wystaw({ wyslij: true, faktura: faktura() }, { key: key === '' ? '' : key });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('missing_idempotency_key');
    expect(writes).toEqual([]);
  });

  it('pole spoza kontraktu (faktura cykliczna, nabywca z UE): 400 invalid_request bez zapisu', async () => {
    for (const extra of [{ recurringInvoiceId: '3f0f6a2e-1111-4111-8111-000000000009' }, { buyerIsEu: true }]) {
      const response = await wystaw({ wyslij: true, faktura: { ...faktura(), ...extra } });
      expect(response.status).toBe(400);
      expect((await errorOf(response)).code).toBe('invalid_request');
    }
    expect(writes).toEqual([]);
  });

  it('błąd z formularza strony: 422 invoice_invalid z polem i tym samym zdaniem, bez zapisu', async () => {
    const response = await wystaw({ wyslij: true, faktura: faktura({ buyerName: '' }) });
    expect(response.status).toBe(422);
    expect(await errorOf(response)).toEqual({ code: 'invoice_invalid', message: 'Nazwa wymagana', field: 'buyerName' });

    const nip = await wystaw({ wyslij: true, faktura: faktura({ buyerNip: '1234567891' }) }, { key: KEY_2 });
    expect(nip.status).toBe(422);
    expect((await errorOf(nip)).code).toBe('invoice_invalid');
    expect(writes).toEqual([]);
  });

  it('data inna niż dziś przy wysyłce: 422 z komunikatem strony, bez zapisu', async () => {
    const response = await wystaw({ wyslij: true, faktura: faktura({ issueDate: '2026-11-12' }) });
    expect(response.status).toBe(422);
    expect((await errorOf(response)).message).toContain('2026-11-13');
    expect(invoices).toEqual([]);
    expect(fake.enqueue).not.toHaveBeenCalled();
  });

  it('„Wyślij do KSeF”: szkic w firmie z nagłówka, pozycje, klucz, jedna kolejka z 2FA z tokenu', async () => {
    const response = await wystaw({ wyslij: true, faktura: faktura() });
    expect(response.status).toBe(201);
    const body = (await response.json()) as WystawienieOdpowiedz;
    expect(body).toEqual({
      faktura: { id: invoices[0]!.id, numer: 'FV/1/11/2026', ksefStatus: 'queued' },
      powtorzenie: false,
      wysylka: { zlecona: true, blad: null },
    });
    expect(invoices).toHaveLength(1);
    expect(invoices[0]).toMatchObject({ tenant_id: ORG_A, internal_number: 'FV/1/11/2026', direction: 'outgoing' });
    expect(lines).toEqual([expect.objectContaining({ invoice_id: invoices[0]!.id, name: 'Projekt graficzny' })]);
    expect(keys).toEqual([expect.objectContaining({ tenant_id: ORG_A, user_id: USER_A, idempotency_key: KEY_1, invoice_id: invoices[0]!.id, endpoint: 'POST /api/mobile/v1/faktury' })]);
    expect(fake.enqueue).toHaveBeenCalledTimes(1);
    expect(fake.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: ORG_A, userId: USER_A, invoiceId: invoices[0]!.id, nip: '5260001246', auditKind: 'regular', tokenSession: { mfa: 'enrollment_required' },
    }));
    // Klucz zapisany przed kolejką: przerwa po kolejce nie zostawia szkicu bez klucza.
    // Licznik użyć produktów (krok 2.6, 00204) liczy się przy każdej zapisanej
    // fakturze z pozycjami, także z telefonu, zaraz po pozycjach.
    expect(writes.map((w) => w.table)).toEqual(['invoices', 'invoice_line_items', 'rpc/product_usage_record', 'mobile_idempotency_keys']);
  });

  it('konto z TOTP po kodzie: kolejka dostaje 2FA „verified” z tokenu', async () => {
    const response = await wystaw({ wyslij: true, faktura: faktura() }, { token: TOKEN_TOTP, org: ORG_B });
    expect(response.status).toBe(201);
    expect(fake.enqueue).toHaveBeenCalledWith(expect.objectContaining({ tenantId: ORG_B, tokenSession: { mfa: 'verified' } }));
  });

  it('ponowienie z tym samym kluczem i treścią: ta sama faktura, bez drugiego zapisu i drugiej kolejki', async () => {
    const body = { wyslij: true, faktura: faktura() };
    const first = (await (await wystaw(body)).json()) as WystawienieOdpowiedz;
    writes.length = 0;

    const again = await wystaw(body);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ...first, powtorzenie: true });
    expect(invoices).toHaveLength(1);
    expect(fake.enqueue).toHaveBeenCalledTimes(1);
    expect(writes).toEqual([]);
  });

  it('ten sam klucz z inną treścią: 409 idempotency_conflict, bez drugiej faktury', async () => {
    await wystaw({ wyslij: true, faktura: faktura() });
    const response = await wystaw({ wyslij: true, faktura: faktura({ internalNumber: 'FV/2/11/2026' }) });
    expect(response.status).toBe(409);
    expect((await errorOf(response)).code).toBe('idempotency_conflict');
    expect(invoices).toHaveLength(1);
    expect(fake.enqueue).toHaveBeenCalledTimes(1);
  });

  it('kolejka odmawia (brak certyfikatu): szkic zostaje z kluczem; ponowienie zleca wysyłkę szkicu raz', async () => {
    const brak = 'Najpierw wgraj certyfikat KSeF w Ustawienia KSeF — bez niego wysyłka nie jest możliwa. Faktura została zapisana jako szkic.';
    fake.enqueue.mockResolvedValueOnce({ ok: false, error: brak });
    const body = { wyslij: true, faktura: faktura() };

    const first = await wystaw(body);
    expect(first.status).toBe(201);
    expect(await first.json()).toEqual({
      faktura: { id: invoices[0]!.id, numer: 'FV/1/11/2026', ksefStatus: 'draft' },
      powtorzenie: false,
      wysylka: { zlecona: false, blad: brak },
    });
    expect(keys).toHaveLength(1);

    // Klient wgrał certyfikat i dotyka „Wyślij do KSeF” jeszcze raz (ten sam formularz, ten sam klucz).
    const again = await wystaw(body);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({
      faktura: { id: invoices[0]!.id, numer: 'FV/1/11/2026', ksefStatus: 'queued' },
      powtorzenie: true,
      wysylka: { zlecona: true, blad: null },
    });
    expect(invoices).toHaveLength(1);
    expect(fake.enqueue).toHaveBeenCalledTimes(2);

    // Trzecie ponowienie: faktura w kolejce, nic nie zlecamy.
    await wystaw(body);
    expect(fake.enqueue).toHaveBeenCalledTimes(2);
  });

  it('klucz nie zapisał się po szkicu: bez kolejki; ponowienie oddaje ten szkic (klucz zapisu 00199) i zleca wysyłkę raz', async () => {
    keyInsertFails = true;
    const body = { wyslij: true, faktura: faktura() };
    const first = (await (await wystaw(body)).json()) as WystawienieOdpowiedz;
    expect(first.wysylka).toEqual({ zlecona: false, blad: expect.stringContaining('Szkic faktury jest zapisany') });
    expect(fake.enqueue).not.toHaveBeenCalled();
    // Klucz żądania idzie też jako klucz zapisu faktury (`number_request_key`).
    expect(invoices[0]).toMatchObject({ number_request_key: KEY_1 });

    keyInsertFails = false;
    const again = await wystaw(body);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({
      faktura: { id: invoices[0]!.id, numer: 'FV/1/11/2026', ksefStatus: 'queued' },
      powtorzenie: true,
      wysylka: { zlecona: true, blad: null },
    });
    expect(invoices).toHaveLength(1);
    expect(keys).toEqual([expect.objectContaining({ idempotency_key: KEY_1, invoice_id: invoices[0]!.id })]);
    expect(fake.enqueue).toHaveBeenCalledTimes(1);
  });

  it('wyjątek kolejki po zapisie szkicu: 201 ze szkicem i zdaniem, co zrobić (nie 500)', async () => {
    fake.enqueue.mockRejectedValueOnce(new Error('pg-boss: connection terminated'));
    const response = await wystaw({ wyslij: true, faktura: faktura() });
    expect(response.status).toBe(201);
    const body = (await response.json()) as WystawienieOdpowiedz;
    expect(body.faktura).toMatchObject({ id: invoices[0]!.id, ksefStatus: 'draft' });
    expect(body.wysylka).toEqual({ zlecona: false, blad: expect.stringContaining('Szkic faktury jest zapisany') });
  });

  it('powtórzenie, gdy faktura ma już błąd wysyłki albo odrzucenie: nie udaje „wysłano”', async () => {
    const body = { wyslij: true, faktura: faktura() };
    await wystaw(body);
    invoices[0]!.ksef_status = 'failed';
    const again = (await (await wystaw(body)).json()) as WystawienieOdpowiedz;
    expect(again.wysylka).toEqual({ zlecona: false, blad: expect.stringContaining('faktway.pl') });
  });

  it('powtórzenie w trakcie pierwszego żądania: gdy kolejkę przejęło tamto, odpowiedź mówi „zlecona”', async () => {
    fake.enqueue.mockResolvedValueOnce({ ok: false, error: 'Najpierw wgraj certyfikat KSeF.' });
    const body = { wyslij: true, faktura: faktura() };
    await wystaw(body);
    // Drugie żądanie przegrywa wyścig: RPC odmawia („już wysyłana”), bo pierwsze właśnie przejęło szkic.
    fake.enqueue.mockImplementationOnce(async () => {
      invoices[0]!.ksef_status = 'queued';
      return { ok: false, error: 'Faktura jest już wysyłana do KSeF.' };
    });
    const again = (await (await wystaw(body)).json()) as WystawienieOdpowiedz;
    expect(again.wysylka).toEqual({ zlecona: true, blad: null });
    expect(again.faktura.ksefStatus).toBe('queued');
  });

  it('numer z serii (krok 2.5): seria i podpowiedź z formularza, numer nadaje licznik przy zapisie', async () => {
    const SERIA = '5e71e5e7-0000-4000-8000-000000000001';
    const response = await wystaw({ wyslij: false, faktura: faktura({ internalNumber: 'FV/5/11/2026', numberSeriesId: SERIA, numberPreview: 'FV/5/11/2026', issueDate: '2026-11-20' }) });
    expect(response.status).toBe(201);
    expect(invoices[0]).toMatchObject({ number_series_id: SERIA, internal_number: 'FV/5/11/2026', number_counter: 5, number_request_key: KEY_1 });
  });

  it('szkic (`wyslij: false`): bez kolejki, z kluczem; ponowienie oddaje ten szkic', async () => {
    const body = { wyslij: false, faktura: faktura({ issueDate: '2026-11-20' }) };
    const response = await wystaw(body);
    expect(response.status).toBe(201);
    const first = (await response.json()) as WystawienieOdpowiedz;
    expect(first).toEqual({ faktura: { id: invoices[0]!.id, numer: 'FV/1/11/2026', ksefStatus: 'draft' }, powtorzenie: false, wysylka: null });
    expect(fake.enqueue).not.toHaveBeenCalled();
    expect(fake.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'invoice.draft_created', tenantId: ORG_A, userId: USER_A }));

    const again = await wystaw(body);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ...first, powtorzenie: true });
    expect(invoices).toHaveLength(1);
  });

  it('osoba prywatna: bez NIP, „bez numeru identyfikacyjnego” jak w publicznym API', async () => {
    const response = await wystaw({ wyslij: true, faktura: faktura({ buyerIsConsumer: true, buyerNip: '', buyerName: 'Jan Kowalski' }) });
    expect(response.status).toBe(201);
    expect(invoices[0]).toMatchObject({ is_b2c: true });
  });
});

// ─── POST /faktury/{id}/wysylka ───────────────────────────────────────

describe('POST /api/mobile/v1/faktury/{id}/wysylka', () => {
  async function szkic(): Promise<string> {
    const response = await wystaw({ wyslij: false, faktura: faktura() }, { key: KEY_2 });
    return ((await response.json()) as WystawienieOdpowiedz).faktura.id;
  }

  it('szkic do kolejki raz; ponowienie oddaje stan bez drugiej wysyłki', async () => {
    const id = await szkic();
    const first = await wyslijSzkic(id);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ faktura: { id, numer: 'FV/1/11/2026', ksefStatus: 'queued' }, juzZlecona: false } satisfies WysylkaSzkicuOdpowiedz);

    const again = await wyslijSzkic(id);
    expect(again.status).toBe(200);
    expect(((await again.json()) as WysylkaSzkicuOdpowiedz).juzZlecona).toBe(true);
    expect(fake.enqueue).toHaveBeenCalledTimes(1);
    expect(fake.enqueue).toHaveBeenCalledWith(expect.objectContaining({ invoiceId: id, tenantId: ORG_A, tokenSession: { mfa: 'enrollment_required' } }));
  });

  it('odrzucona przez KSeF: 409 not_draft, bez kolejki', async () => {
    const id = await szkic();
    invoices[0]!.ksef_status = 'rejected';
    const response = await wyslijSzkic(id);
    expect(response.status).toBe(409);
    expect((await errorOf(response)).code).toBe('not_draft');
    expect(fake.enqueue).not.toHaveBeenCalled();
  });

  it('faktura innej firmy albo nieistniejąca: 404 not_found', async () => {
    const id = await szkic();
    const obca = await wyslijSzkic(id, { token: TOKEN_TOTP, org: ORG_B });
    expect(obca.status).toBe(404);
    expect((await errorOf(obca)).code).toBe('not_found');
    expect((await wyslijSzkic('nie-uuid')).status).toBe(404);
    expect(fake.enqueue).not.toHaveBeenCalled();
  });

  it('kolejka odmawia: 422 ksef_send_refused ze zdaniem strony, szkic zostaje', async () => {
    const id = await szkic();
    fake.enqueue.mockResolvedValueOnce({ ok: false, error: 'Wysyłka do KSeF jest chwilowo wstrzymana.' });
    const response = await wyslijSzkic(id);
    expect(response.status).toBe(422);
    expect(await errorOf(response)).toEqual({ code: 'ksef_send_refused', message: 'Wysyłka do KSeF jest chwilowo wstrzymana.' });
    expect(invoices[0]!.ksef_status).toBe('draft');
  });
});

// ─── GET /faktury/podpowiedz ──────────────────────────────────────────

describe('GET /api/mobile/v1/faktury/podpowiedz', () => {
  it('firma bez faktur: bez numeru, dziś w Polsce, bez zwolnienia', async () => {
    const request = new Request('https://app.example.test/api/mobile/v1/faktury/podpowiedz', {
      headers: { authorization: `Bearer ${TOKEN_A}`, 'x-active-org': ORG_A, 'x-real-ip': '198.51.100.9' },
    });
    const response = await podpowiedzRoute(request);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ numer: null, seria: null, dzis: DZIS, zwolnienieVat: false });
  });

  it('firma z serią domyślną: numer z licznika i id serii (jak formularz strony)', async () => {
    const SERIA = '5e71e5e7-0000-4000-8000-000000000001';
    series = [{ id: SERIA, name: 'Faktury', pattern: 'FV/{N}/{MM}/{RRRR}', is_active: true, active: true, default_kinds: ['regular'], next: { number: 'FV/5/11/2026', counter: 5, period: '2026-11' } }];
    const request = new Request('https://app.example.test/api/mobile/v1/faktury/podpowiedz', {
      headers: { authorization: `Bearer ${TOKEN_A}`, 'x-active-org': ORG_A, 'x-real-ip': '198.51.100.10' },
    });
    expect(await (await podpowiedzRoute(request)).json()).toEqual({ numer: 'FV/5/11/2026', seria: SERIA, dzis: DZIS, zwolnienieVat: false });
  });
});

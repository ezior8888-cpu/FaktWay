import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { z } from 'zod';

/**
 * Plan aplikacji mobilnej, M9: wydatek ze zdjęcia z telefonu.
 *
 * Prawdziwe: trasy `app/api/mobile/v1/wydatki/*`, bramka `authenticateMobileRequest`,
 * `lib/api/mobile/wydatki.ts`, bramka wgrań `lib/uploads/server.ts`, schematy
 * oraz te same funkcje co strona: `acceptExpenseDocument`, `readOcrJobStatus`,
 * `reviewExpense`. Atrapy tylko dla HTTP i granic: GoTrue i PostgREST przez
 * `fetch` (tabele, unikalny klucz i RLS firmy w uproszczeniu), magazyn plików,
 * kolejka (pg-boss), uczenie reguł, Redis. Prawdziwą tabelę kluczy z 00202
 * sprawdza `tests/rls-mobile-wydatki.test.ts` na bazie.
 */

const SUPABASE_URL = 'https://db.fixture.test';
const ANON_KEY = 'anon-fixture-key';
const SERVICE_ROLE_KEY = 'service-fixture-key';

const USER_A = 'aaaaaaaa-1111-4111-8111-000000000001';
const ORG_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const ORG_B = 'bbbbbbbb-0000-4000-8000-000000000003';
const KEY_1 = '0c4e5f1a-7b2d-4c3e-9f10-111111111111';
const KEY_2 = '0c4e5f1a-7b2d-4c3e-9f10-222222222222';
const EXP_OCR = 'eeeeeeee-0000-4000-8000-000000000001';
const EXP_KSEF = 'eeeeeeee-0000-4000-8000-000000000002';
const EXP_B = 'eeeeeeee-0000-4000-8000-000000000003';

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
    // Zwrot próby (`refund`) usuwa wpis: bez tego test limitu ponowień nic by nie sprawdzał.
    zrem: async (key: string, member: string) => (zset(key).delete(member) ? 1 : 0),
  };
  return {
    client,
    sets,
    upload: vi.fn(),
    removePhoto: vi.fn(),
    sendEvent: vi.fn(),
    learn: vi.fn(),
    revalidate: vi.fn(),
  };
});

vi.mock('@/lib/cache/redis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cache/redis')>();
  return { ...actual, isRedisConfigured: () => true, getRedis: () => fake.client };
});
vi.mock('@/lib/feature-flags/maintenance', () => ({ isMaintenanceMode: async () => false, MAINTENANCE_PATH: '/przerwa-techniczna' }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: fake.revalidate }));
vi.mock('@/lib/storage/expenses', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/storage/expenses')>();
  return { ...actual, uploadExpensePhoto: fake.upload, deleteExpensePhoto: fake.removePhoto };
});
vi.mock('@/lib/jobs/enqueue', () => ({ sendJobEvent: fake.sendEvent }));
vi.mock('@/lib/categorization', () => ({ learnFromCorrection: fake.learn }));

import { POST as zatwierdzenieRoute } from '@/app/api/mobile/v1/wydatki/[id]/zatwierdzenie/route';
import { GET as odczytRoute } from '@/app/api/mobile/v1/wydatki/odczyt/[id]/route';
import { POST as zdjecieRoute } from '@/app/api/mobile/v1/wydatki/zdjecie/route';
import type {
  OdczytWydatkuOdpowiedz,
  StanOdczytu,
  WgranieWydatkuOdpowiedz,
  ZatwierdzenieWydatkuOdpowiedz,
  ZatwierdzenieWydatkuZadanie,
  ZmianyWydatkuTelefonu,
} from '@/lib/api/mobile/kontrakt';
import { STALE_UPLOAD_MS } from '@/lib/api/mobile/wydatki';
import { zatwierdzenieWydatkuSchema, zmianyWydatkuSchema } from '@/lib/api/mobile/schematy';
import type { ExpenseReviewUpdates } from '@/lib/expenses/review';
import type { Database } from '@/types/database';

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
const issued = new Map([[TOKEN_A, USER_A]]);

// ─── Atrapa bazy ──────────────────────────────────────────────────────

type Row = Record<string, unknown>;
let jobs: Row[] = [];
let keys: Row[] = [];
let expenses: Row[] = [];
let jobCounter = 0;
let keyInsertFails = false;
let jobReadFails = false;
/** Wiersz klucza, który „równoległe” wgranie zapisze tuż przed naszym (wyścig). */
let racingKey: Row | null = null;
const writes: Array<{ table: string; method: string; role: 'user' | 'service' }> = [];

const memberships = [
  { user_id: USER_A, organization_id: ORG_A, role: 'owner', status: 'active' },
];

const eq = (url: URL, column: string) => {
  const value = url.searchParams.get(column);
  return value?.startsWith('eq.') ? decodeURIComponent(value.slice(3)) : null;
};
const matches = (url: URL, row: Row, columns: string[]) =>
  columns.every((c) => eq(url, c) === null || String(row[c]) === eq(url, c));

function reply(request: Request, rows: Row[], status = 200): Response {
  const asObject = request.headers.get('accept')?.includes('vnd.pgrst.object');
  if (asObject) return rows[0] ? Response.json(rows[0], { status }) : Response.json({ code: 'PGRST116', message: '0 rows' }, { status: 406 });
  return Response.json(rows, { status });
}

function pick(row: Row, url: URL): Row {
  const select = url.searchParams.get('select');
  if (!select || select === '*') return row;
  return Object.fromEntries(select.split(',').map((c) => [c, row[c] ?? null]));
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

  const table = url.pathname.replace('/rest/v1/', '');
  const method = request.method;

  // Klucz serwisowy: tylko zadania OCR (wgranie jak na stronie) i RPC kosztu KSeF.
  if (token === SERVICE_ROLE_KEY) {
    if (method !== 'GET') writes.push({ table, method, role: 'service' });
    if (table !== 'ocr_jobs') return Response.json({ message: `klucz serwisowy poza ocr_jobs: ${table}` }, { status: 418 });
    if (method === 'POST') {
      const row = JSON.parse(await request.text()) as Row;
      const saved = { ...row, id: `0cc00000-0000-4000-8000-${String((jobCounter += 1)).padStart(12, '0')}`, created_at: new Date().toISOString() };
      jobs.push(saved);
      return reply(request, [{ id: saved.id }], 201);
    }
    if (method === 'PATCH') {
      const patch = JSON.parse(await request.text()) as Row;
      for (const j of jobs) if (matches(url, j, ['id'])) Object.assign(j, patch);
      return new Response(null, { status: 204 });
    }
    if (method === 'DELETE') {
      const gone = jobs.filter((j) => matches(url, j, ['id']));
      jobs = jobs.filter((j) => !gone.includes(j));
      // ON DELETE CASCADE z 00202.
      keys = keys.filter((k) => !gone.some((j) => j.id === k.ocr_job_id));
      return new Response(null, { status: 204 });
    }
    return Response.json({ message: 'nieobsłużone' }, { status: 500 });
  }

  const sub = token ? issued.get(token) : undefined;
  if (!sub) return Response.json({ message: 'JWT invalid' }, { status: 401 });
  const org = request.headers.get('x-active-org');
  const current = memberships.some((m) => m.user_id === sub && m.organization_id === org && m.status === 'active') ? org : null;
  if (method !== 'GET') writes.push({ table, method, role: 'user' });

  if (table === 'memberships') {
    return reply(request, memberships.filter((m) => m.user_id === sub && matches(url, m, ['organization_id', 'status'])));
  }

  if (table === 'mobile_idempotency_keys') {
    if (method === 'POST') {
      const row = JSON.parse(await request.text()) as Row;
      if (racingKey) {
        keys.push(racingKey);
        racingKey = null;
      }
      if (keyInsertFails) return Response.json({ message: 'boom' }, { status: 500 });
      if (row.user_id !== sub || row.tenant_id !== current) return Response.json({ code: '42501', message: 'RLS' }, { status: 403 });
      if (keys.some((k) => k.tenant_id === row.tenant_id && k.user_id === row.user_id && k.idempotency_key === row.idempotency_key)) {
        return Response.json({ code: '23505', message: 'duplicate key value violates unique constraint "uq_mobile_idempotency_keys_key"' }, { status: 409 });
      }
      if (!jobs.some((j) => j.id === row.ocr_job_id && j.tenant_id === row.tenant_id)) {
        return Response.json({ code: '23503', message: 'fk' }, { status: 409 });
      }
      keys.push(row);
      return new Response(null, { status: 201 });
    }
    return reply(request, keys.filter((k) => k.user_id === sub && k.tenant_id === current && matches(url, k, ['tenant_id', 'user_id', 'idempotency_key'])).map((k) => pick(k, url)));
  }

  if (table === 'ocr_jobs') {
    if (jobReadFails && method === 'GET') return Response.json({ code: '08006', message: 'connection lost, tenant 1234567890' }, { status: 500 });
    const visible = jobs.filter((j) => j.tenant_id === current && matches(url, j, ['id', 'tenant_id', 'source_file_path']));
    if (method === 'DELETE') {
      jobs = jobs.filter((j) => !visible.includes(j));
      keys = keys.filter((k) => !visible.some((j) => j.id === k.ocr_job_id));
      return reply(request, visible.map((j) => pick(j, url)));
    }
    return reply(request, visible.map((j) => pick(j, url)));
  }

  if (table === 'expenses') {
    const visible = expenses.filter((e) => e.tenant_id === current && matches(url, e, ['id', 'tenant_id']));
    if (method === 'PATCH') {
      const patch = JSON.parse(await request.text()) as Row;
      for (const e of visible) Object.assign(e, patch);
      return reply(request, visible.map((e) => pick(e, url)));
    }
    return reply(request, visible.map((e) => pick(e, url)));
  }

  if (table === 'invoices') return reply(request, [{ currency: 'PLN' }]);
  return Response.json({ message: `nieznana tabela ${table}` }, { status: 404 });
}

// ─── Żądania ──────────────────────────────────────────────────────────

let ip = 0;

/** Najmniejszy „JPEG”: sygnatura wystarcza `detectExpensePhotoType`. */
const jpeg = (fill = 1, size = 64) => {
  const bytes = new Uint8Array(size).fill(fill);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  return new File([bytes], 'paragon.jpg', { type: 'image/jpeg' });
};

function headersFor(options: { token?: string | null; org?: string | null; key?: string | null }): Record<string, string> {
  const headers: Record<string, string> = { 'x-real-ip': `198.51.100.${(ip += 1) % 250}` };
  if (options.token !== null) headers.authorization = `Bearer ${options.token ?? TOKEN_A}`;
  if (options.org !== null) headers['x-active-org'] = options.org ?? ORG_A;
  if (options.key !== null) headers['idempotency-key'] = options.key ?? KEY_1;
  return headers;
}

function wgraj(file: File | null, options: { token?: string | null; org?: string | null; key?: string | null; field?: string; contentLength?: string } = {}) {
  const form = new FormData();
  if (file) form.set(options.field ?? 'plik', file);
  const base = new Request('https://app.example.test/api/mobile/v1/wydatki/zdjecie', { method: 'POST', body: form });
  const headers = new Headers(base.headers);
  for (const [k, v] of Object.entries(headersFor(options))) headers.set(k, v);
  if (options.contentLength) headers.set('content-length', options.contentLength);
  return zdjecieRoute(new Request(base.url, { method: 'POST', headers, body: base.body, duplex: 'half' } as RequestInit));
}

const odczyt = (id: string, options: Parameters<typeof headersFor>[0] = {}) =>
  odczytRoute(new Request(`https://app.example.test/api/mobile/v1/wydatki/odczyt/${id}`, { headers: headersFor({ key: null, ...options }) }), {
    params: Promise.resolve({ id }),
  });

const zatwierdz = (id: string, body: unknown, options: Parameters<typeof headersFor>[0] = {}) =>
  zatwierdzenieRoute(
    new Request(`https://app.example.test/api/mobile/v1/wydatki/${id}/zatwierdzenie`, {
      method: 'POST',
      headers: { ...headersFor({ key: null, ...options }), 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );

async function errorOf(response: Response) {
  return ((await response.json()) as { error: { code: string; message: string } }).error;
}

const zmiany = (extra: Partial<ZmianyWydatkuTelefonu> = {}): ZmianyWydatkuTelefonu => ({
  seller_name: 'Stacja Testowa',
  seller_nip: '1234567890',
  document_number: '0051/2026',
  issue_date: '2026-11-10',
  net_amount: 81.3,
  vat_amount: 18.7,
  gross_amount: 100,
  kpir_column: 'col_13',
  category_label: 'Paliwo',
  is_deductible: true,
  ...extra,
});

const expenseRow = (extra: Row = {}): Row => ({
  id: EXP_OCR,
  tenant_id: ORG_A,
  seller_nip: '1234567890',
  seller_name: 'Stacja Testowa',
  kpir_column: 'col_13',
  category_label: 'Pozostałe wydatki',
  vat_amount: 18.7,
  vat_deductible_amount: 18.7,
  is_deductible: true,
  is_reviewed: false,
  source: 'ocr_photo',
  ksef_invoice_id: null,
  issue_date: '2026-11-10',
  ocr_extracted_data: { currency: 'PLN' },
  updated_at: '2026-11-10T08:00:00Z',
  ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  fake.sets.clear();
  jobs = [];
  keys = [];
  jobCounter = 0;
  keyInsertFails = false;
  jobReadFails = false;
  racingKey = null;
  writes.length = 0;
  expenses = [
    expenseRow(),
    expenseRow({ id: EXP_KSEF, source: 'ksef_inbox', ksef_invoice_id: 'inv-1', ocr_extracted_data: { source: 'ksef_inbox', currency: 'PLN' } }),
    expenseRow({ id: EXP_B, tenant_id: ORG_B }),
  ];
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-13T09:00:00Z'));
  fake.upload.mockImplementation(async (tenantId: string, ocrJobId: string) => `tenants/${tenantId}/expenses/2026/11/${ocrJobId}.jpg`);
  fake.sendEvent.mockResolvedValue({ ids: ['job'] });
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SUPABASE_URL);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', ANON_KEY);
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', SERVICE_ROLE_KEY);
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ─── Kontrakt ─────────────────────────────────────────────────────────

describe('kontrakt treści i schemat', () => {
  it('schemat telefonu daje dokładnie typy kontraktu', () => {
    expectTypeOf<z.output<typeof zatwierdzenieWydatkuSchema>>().toEqualTypeOf<ZatwierdzenieWydatkuZadanie>();
    expectTypeOf<z.output<typeof zmianyWydatkuSchema>>().toEqualTypeOf<ZmianyWydatkuTelefonu>();
  });

  it('pola zmian telefonu to pola zmian strony (`reviewExpenseAction`)', () => {
    expectTypeOf<keyof ZmianyWydatkuTelefonu>().toExtend<keyof ExpenseReviewUpdates>();
  });

  it('stan odczytu to stan zadania OCR z bazy', () => {
    expectTypeOf<StanOdczytu>().toEqualTypeOf<Database['public']['Enums']['ocr_status']>();
  });
});

// ─── POST /wydatki/zdjecie ────────────────────────────────────────────

describe('POST /api/mobile/v1/wydatki/zdjecie', () => {
  it('bez tokenu: 401 missing_token, bez zapisu', async () => {
    const response = await wgraj(jpeg(), { token: null });
    expect(response.status).toBe(401);
    expect((await errorOf(response)).code).toBe('missing_token');
    expect(writes).toEqual([]);
  });

  it('bez firmy: 400 missing_org, bez zapisu', async () => {
    const response = await wgraj(jpeg(), { org: null });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('missing_org');
    expect(writes).toEqual([]);
  });

  it('firma bez członkostwa: 403 no_active_org, bez zapisu', async () => {
    const response = await wgraj(jpeg(), { org: ORG_B });
    expect(response.status).toBe(403);
    expect((await errorOf(response)).code).toBe('no_active_org');
    expect(writes).toEqual([]);
  });

  it.each([null, 'klucz-1'])('klucz %j: 400 missing_idempotency_key, bez zapisu', async (key) => {
    const response = await wgraj(jpeg(), { key });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('missing_idempotency_key');
    expect(writes).toEqual([]);
  });

  it('pierwsze wgranie: 201, zadanie OCR, klucz przed plikiem i kolejką, jedno zdarzenie', async () => {
    const response = await wgraj(jpeg());
    expect(response.status).toBe(201);
    const body = (await response.json()) as WgranieWydatkuOdpowiedz;
    expect(body).toEqual({ odczyt: { id: jobs[0]!.id }, powtorzenie: false });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ tenant_id: ORG_A, created_by: USER_A, status: 'pending', source_file_mime: 'image/jpeg' });
    expect(jobs[0]!.source_file_path).toBe(`tenants/${ORG_A}/expenses/2026/11/${jobs[0]!.id}.jpg`);
    expect(keys).toEqual([
      expect.objectContaining({ tenant_id: ORG_A, user_id: USER_A, idempotency_key: KEY_1, endpoint: 'POST /api/mobile/v1/wydatki/zdjecie', ocr_job_id: jobs[0]!.id }),
    ]);
    expect(keys[0]!.request_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(keys[0]).not.toHaveProperty('invoice_id');
    // Kolejność: zadanie (serwis), klucz (token telefonu), plik w zadaniu (serwis); zdarzenie po nich.
    expect(writes.filter((w) => w.table !== 'memberships')).toEqual([
      { table: 'ocr_jobs', method: 'POST', role: 'service' },
      { table: 'mobile_idempotency_keys', method: 'POST', role: 'user' },
      { table: 'ocr_jobs', method: 'PATCH', role: 'service' },
    ]);
    expect(fake.sendEvent).toHaveBeenCalledTimes(1);
    expect(fake.sendEvent.mock.calls[0]![0]).toMatchObject({ data: { ocrJobId: jobs[0]!.id, tenantId: ORG_A } });
  });

  it('ponowienie z tym samym kluczem i plikiem: 200 to samo zadanie, bez drugiego odczytu', async () => {
    const first = (await (await wgraj(jpeg())).json()) as WgranieWydatkuOdpowiedz;
    const again = await wgraj(jpeg());
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ odczyt: { id: first.odczyt.id }, powtorzenie: true });
    expect(jobs).toHaveLength(1);
    expect(keys).toHaveLength(1);
    expect(fake.upload).toHaveBeenCalledTimes(1);
    expect(fake.sendEvent).toHaveBeenCalledTimes(1);
  });

  it('ponowienie nie zużywa limitu wgrań (31. ponowienie przechodzi)', async () => {
    await wgraj(jpeg());
    for (let i = 0; i < 31; i++) expect((await wgraj(jpeg())).status).toBe(200);
  });

  it('ten sam klucz z innym plikiem: 409 idempotency_conflict, bez drugiego zadania', async () => {
    await wgraj(jpeg(1));
    const response = await wgraj(jpeg(2));
    expect(response.status).toBe(409);
    expect((await errorOf(response)).code).toBe('idempotency_conflict');
    expect(jobs).toHaveLength(1);
    expect(fake.sendEvent).toHaveBeenCalledTimes(1);
  });

  it('nowy klucz: drugie zdjęcie to drugie zadanie', async () => {
    await wgraj(jpeg(1));
    expect((await wgraj(jpeg(2), { key: KEY_2 })).status).toBe(201);
    expect(jobs).toHaveLength(2);
  });

  it('równoległe wgranie z tym samym kluczem zdążyło pierwsze: oddajemy jego zadanie, nasze znika', async () => {
    const winnerJob = { id: '0cc00000-0000-4000-8000-00000000aaaa', tenant_id: ORG_A, created_by: USER_A, status: 'pending', source_file_path: 'pending', source_file_mime: 'image/jpeg', created_at: new Date().toISOString() };
    jobs.push(winnerJob);
    const hash = (await import('node:crypto')).createHash('sha256').update(Buffer.from(await jpeg().arrayBuffer())).digest('hex');
    racingKey = { tenant_id: ORG_A, user_id: USER_A, idempotency_key: KEY_1, request_hash: hash, endpoint: 'POST /api/mobile/v1/wydatki/zdjecie', ocr_job_id: winnerJob.id };
    const response = await wgraj(jpeg());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ odczyt: { id: winnerJob.id }, powtorzenie: true });
    expect(jobs.map((j) => j.id)).toEqual([winnerJob.id]);
    expect(fake.upload).not.toHaveBeenCalled();
    expect(fake.sendEvent).not.toHaveBeenCalled();
  });

  it('zapis klucza padł: 503, zadanie usunięte, bez pliku i bez odczytu (ponowienie wgra od nowa)', async () => {
    keyInsertFails = true;
    const response = await wgraj(jpeg());
    expect(response.status).toBe(503);
    expect((await errorOf(response)).code).toBe('service_unavailable');
    expect(jobs).toEqual([]);
    expect(fake.upload).not.toHaveBeenCalled();
    expect(fake.sendEvent).not.toHaveBeenCalled();
    keyInsertFails = false;
    expect((await wgraj(jpeg())).status).toBe(201);
  });

  it('kolejka padła po kluczu: 503, zadanie i klucz znikają razem, ponowienie wgrywa od nowa', async () => {
    fake.sendEvent.mockRejectedValueOnce(new Error('pg-boss niedostępny'));
    const response = await wgraj(jpeg());
    expect(response.status).toBe(503);
    expect((await errorOf(response)).code).toBe('service_unavailable');
    expect(jobs).toEqual([]);
    expect(keys).toEqual([]);
    expect(fake.removePhoto).toHaveBeenCalledTimes(1);
    const again = await wgraj(jpeg());
    expect(again.status).toBe(201);
    expect(jobs).toHaveLength(1);
  });

  it('pierwsze wgranie umarło po kluczu, przed plikiem: w ciągu 5 minut oddajemy zadanie, potem wgrywamy od nowa', async () => {
    const hash = (await import('node:crypto')).createHash('sha256').update(Buffer.from(await jpeg().arrayBuffer())).digest('hex');
    const dead = { id: '0cc00000-0000-4000-8000-00000000dead', tenant_id: ORG_A, created_by: USER_A, status: 'pending', source_file_path: 'pending', source_file_mime: 'image/jpeg', created_at: new Date().toISOString() };
    jobs.push(dead);
    keys.push({ tenant_id: ORG_A, user_id: USER_A, idempotency_key: KEY_1, request_hash: hash, endpoint: 'POST /api/mobile/v1/wydatki/zdjecie', ocr_job_id: dead.id });

    const soon = await wgraj(jpeg());
    expect(soon.status).toBe(200);
    expect(await soon.json()).toEqual({ odczyt: { id: dead.id }, powtorzenie: true });

    vi.setSystemTime(new Date(Date.now() + STALE_UPLOAD_MS + 1000));
    const later = await wgraj(jpeg());
    expect(later.status).toBe(201);
    const body = (await later.json()) as WgranieWydatkuOdpowiedz;
    expect(body.odczyt.id).not.toBe(dead.id);
    expect(jobs.map((j) => j.id)).toEqual([body.odczyt.id]);
    expect(keys).toEqual([expect.objectContaining({ ocr_job_id: body.odczyt.id })]);
    expect(fake.sendEvent).toHaveBeenCalledTimes(1);
  });

  it('plik jest, a odczytu nikt nie zaczął przez 5 minut: ponowienie zleca odczyt jeszcze raz (job idempotentny)', async () => {
    const first = (await (await wgraj(jpeg())).json()) as WgranieWydatkuOdpowiedz;
    vi.setSystemTime(new Date(Date.now() + STALE_UPLOAD_MS + 1000));
    const again = await wgraj(jpeg());
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ odczyt: { id: first.odczyt.id }, powtorzenie: true });
    expect(fake.sendEvent).toHaveBeenCalledTimes(2);
    expect(fake.sendEvent.mock.calls[1]![0]).toMatchObject({ data: { ocrJobId: first.odczyt.id, tenantId: ORG_A } });
    expect(jobs).toHaveLength(1);
  });

  it('odczyt już trwa: ponowienie po 5 minutach nie zleca niczego', async () => {
    const first = (await (await wgraj(jpeg())).json()) as WgranieWydatkuOdpowiedz;
    jobs[0]!.status = 'processing';
    vi.setSystemTime(new Date(Date.now() + STALE_UPLOAD_MS + 1000));
    expect((await wgraj(jpeg())).status).toBe(200);
    expect(fake.sendEvent).toHaveBeenCalledTimes(1);
    expect(first.odczyt.id).toBe(jobs[0]!.id);
  });

  it('plik, który nie jest zdjęciem ani PDF: 415 file_invalid z komunikatem strony, bez zadania', async () => {
    const response = await wgraj(new File([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])], 'x.bin'));
    expect(response.status).toBe(400);
    const error = await errorOf(response);
    expect(error.code).toBe('file_invalid');
    expect(error.message).toContain('JPG');
    expect(jobs).toEqual([]);
  });

  it('brak pola z plikiem: 400 file_invalid', async () => {
    const response = await wgraj(jpeg(), { field: 'photo' });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('file_invalid');
    expect(jobs).toEqual([]);
  });

  it('zdjęcie ponad 7 MB: 413 file_invalid', async () => {
    const response = await wgraj(jpeg(1, 7 * 1024 * 1024 + 10));
    expect(response.status).toBe(413);
    expect((await errorOf(response)).code).toBe('file_invalid');
    expect(jobs).toEqual([]);
  });

  it('Content-Length ponad limit: 413 przed odczytem ciała i przed kluczem', async () => {
    const response = await wgraj(jpeg(), { contentLength: String(50 * 1024 * 1024) });
    expect(response.status).toBe(413);
    expect((await errorOf(response)).code).toBe('file_invalid');
    expect(writes.filter((w) => w.table !== 'memberships')).toEqual([]);
  });

  it('nie multipart: 415 file_invalid, bez „Odśwież stronę” w komunikacie', async () => {
    const response = await zdjecieRoute(new Request('https://app.example.test/api/mobile/v1/wydatki/zdjecie', {
      method: 'POST',
      headers: { ...headersFor({}), 'content-type': 'application/json' },
      body: '{}',
    }));
    expect(response.status).toBe(415);
    const error = await errorOf(response);
    expect(error.code).toBe('file_invalid');
    expect(error.message).not.toContain('Odśwież stronę');
  });

  it('31. wgranie w 10 minut: 429 rate_limited z Retry-After', async () => {
    for (let i = 0; i < 30; i++) {
      const key = `0c4e5f1a-7b2d-4c3e-9f10-${String(i).padStart(12, '0')}`;
      expect((await wgraj(jpeg(i + 1), { key })).status).toBe(201);
    }
    const response = await wgraj(jpeg(99), { key: KEY_2 });
    expect(response.status).toBe(429);
    expect((await errorOf(response)).code).toBe('rate_limited');
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
  });
});

// ─── GET /wydatki/odczyt/{id} ─────────────────────────────────────────

describe('GET /api/mobile/v1/wydatki/odczyt/{id}', () => {
  it('trwa: 200 ze stanem, bez wydatku', async () => {
    const { odczyt: { id } } = (await (await wgraj(jpeg())).json()) as WgranieWydatkuOdpowiedz;
    const response = await odczyt(id);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ odczyt: { id, stan: 'pending', wydatekId: null, blad: null } });
  });

  it('gotowy: 200 z wydatkiem', async () => {
    const { odczyt: { id } } = (await (await wgraj(jpeg())).json()) as WgranieWydatkuOdpowiedz;
    Object.assign(jobs[0]!, { status: 'completed', expense_id: EXP_OCR });
    expect(await (await odczyt(id)).json()).toEqual({ odczyt: { id, stan: 'completed', wydatekId: EXP_OCR, blad: null } } satisfies OdczytWydatkuOdpowiedz);
  });

  it('nieudany: 200 ze zdaniem z odczytu', async () => {
    const { odczyt: { id } } = (await (await wgraj(jpeg())).json()) as WgranieWydatkuOdpowiedz;
    Object.assign(jobs[0]!, { status: 'failed', error_message: 'Nie udało się rozpoznać paragonu.' });
    expect(await (await odczyt(id)).json()).toEqual({ odczyt: { id, stan: 'failed', wydatekId: null, blad: 'Nie udało się rozpoznać paragonu.' } });
  });

  it('zadania nie ma (albo jest w innej firmie): 404 not_found', async () => {
    jobs.push({ id: '0cc00000-0000-4000-8000-0000000000bb', tenant_id: ORG_B, status: 'completed', expense_id: EXP_B });
    for (const id of ['0cc00000-0000-4000-8000-0000000000bb', '0cc00000-0000-4000-8000-0000000000cc', 'nie-uuid']) {
      const response = await odczyt(id);
      expect(response.status).toBe(404);
      expect((await errorOf(response)).code).toBe('not_found');
    }
  });

  it('błąd odczytu: 503 (telefon pyta dalej), bez treści błędu bazy', async () => {
    jobReadFails = true;
    const response = await odczyt('0cc00000-0000-4000-8000-0000000000cc');
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(text).toContain('service_unavailable');
    expect(text).not.toContain('1234567890');
  });
});

// ─── POST /wydatki/{id}/zatwierdzenie ─────────────────────────────────

describe('POST /api/mobile/v1/wydatki/{id}/zatwierdzenie', () => {
  it('opis kosztu ze zdjęcia: 200, zapis jak na stronie i uczenie reguły', async () => {
    const response = await zatwierdz(EXP_OCR, { zmiany: zmiany() });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ wydatek: { id: EXP_OCR, opisany: true, wKpir: true } } satisfies ZatwierdzenieWydatkuOdpowiedz);
    expect(expenses[0]).toMatchObject({ is_reviewed: true, category_label: 'Paliwo', categorization_method: 'manual', document_number: '0051/2026' });
    expect(fake.learn).toHaveBeenCalledWith(ORG_A, { seller_nip: '1234567890', seller_name: 'Stacja Testowa', kpir_column: 'col_13', category_label: 'Paliwo' });
    expect(writes.filter((w) => w.table === 'expenses')).toEqual([{ table: 'expenses', method: 'PATCH', role: 'user' }]);
  });

  it('ponowienie tej samej treści: 200, ten sam stan, bez drugiego uczenia reguły', async () => {
    await zatwierdz(EXP_OCR, { zmiany: zmiany() });
    const before = structuredClone(expenses[0]);
    const again = await zatwierdz(EXP_OCR, { zmiany: zmiany() });
    expect(again.status).toBe(200);
    expect(expenses[0]).toEqual(before);
    expect(fake.learn).toHaveBeenCalledTimes(1);
  });

  it('kwoty w EUR bez kursu, KPiR bez potwierdzenia złotych: 422 expense_invalid ze zdaniem strony', async () => {
    expenses[0]!.ocr_extracted_data = { currency: 'EUR' };
    expenses[0]!.is_deductible = false;
    const response = await zatwierdz(EXP_OCR, { zmiany: zmiany({ is_deductible: true }) });
    expect(response.status).toBe(422);
    const error = await errorOf(response);
    expect(error.code).toBe('expense_invalid');
    expect(error.message).toContain('Kwoty tego wydatku są w EUR');
    expect(writes.filter((w) => w.table === 'expenses')).toEqual([]);
  });

  it('kwoty w EUR z potwierdzeniem złotych: 200 i ślad potwierdzenia', async () => {
    expenses[0]!.ocr_extracted_data = { currency: 'EUR', gross_amount: 25 };
    expenses[0]!.is_deductible = false;
    const response = await zatwierdz(EXP_OCR, { zmiany: zmiany({ confirmPlnAmounts: true }) });
    expect(response.status).toBe(200);
    expect(expenses[0]!.ocr_extracted_data).toMatchObject({ pln_confirmation: { confirmed_by: USER_A } });
  });

  it('koszt z KSeF: 422 expense_invalid „na faktway.pl”, bez RPC i bez zapisu', async () => {
    const response = await zatwierdz(EXP_KSEF, { zmiany: zmiany() });
    expect(response.status).toBe(422);
    const error = await errorOf(response);
    expect(error.code).toBe('expense_invalid');
    expect(error.message).toContain('faktway.pl');
    expect(writes.filter((w) => w.table !== 'memberships')).toEqual([]);
  });

  it('wydatek innej firmy albo nieznany: 404 not_found', async () => {
    for (const id of [EXP_B, 'eeeeeeee-0000-4000-8000-0000000000ff', 'nie-uuid']) {
      const response = await zatwierdz(id, { zmiany: zmiany() });
      expect(response.status).toBe(404);
      expect((await errorOf(response)).code).toBe('not_found');
    }
    expect(expenses[2]).toMatchObject({ is_reviewed: false });
  });

  it.each([
    ['pole spoza kontraktu', { zmiany: { ...zmiany(), confirmForeignCurrencyReview: true } }],
    ['kwota jako tekst', { zmiany: { ...zmiany(), gross_amount: '100' } }],
    ['zła data', { zmiany: zmiany({ issue_date: '2026-02-30' }) }],
    ['pusty sprzedawca', { zmiany: zmiany({ seller_name: '  ' }) }],
    ['kolumna spoza KPiR', { zmiany: { ...zmiany(), kpir_column: 'col_99' } }],
    ['bez zmian', {}],
    ['nie JSON', '{zmiany'],
  ])('%s: 400 invalid_request bez zapisu', async (_name, body) => {
    const response = await zatwierdz(EXP_OCR, body);
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('invalid_request');
    expect(writes.filter((w) => w.table === 'expenses')).toEqual([]);
  });

  it('bez tokenu: 401, bez zapisu', async () => {
    const response = await zatwierdz(EXP_OCR, { zmiany: zmiany() }, { token: null });
    expect(response.status).toBe(401);
    expect(writes).toEqual([]);
  });
});

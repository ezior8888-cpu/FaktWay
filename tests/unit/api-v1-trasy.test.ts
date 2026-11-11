import { createHash, createHmac } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Krok 7.1 planu kompletnej aplikacji, część 1: publiczne API do odczytu.
 *
 * Prawdziwe trasy `/api/v1/*` i prawdziwy kod uwierzytelniania. Atrapy tylko
 * dla HTTP i baz: PostgREST (przez `fetch`) i Redis (sorted set w pamięci, jak
 * w `rate-limit.test.ts`), do tego flaga udostępnienia i przerwa techniczna.
 *
 * Atrapa PostgREST-a sprawdza podpis tokenu sekretem JWT i naśladuje polityki
 * RLS z 00181: wiersze widzi tylko firma klucza z odpowiednim zakresem.
 * Prawdziwe polityki sprawdza `tests/rls-api-klucze.test.ts` na bazie.
 */

const SUPABASE_URL = 'https://db.fixture.test';
const ANON_KEY = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const SERVICE_ROLE_KEY = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const JWT_SECRET = 'j'.repeat(48);

const TENANT_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const TENANT_B = 'bbbbbbbb-0000-4000-8000-000000000002';

const fake = vi.hoisted(() => {
  const sets = new Map<string, Map<string, number>>();
  const zset = (key: string) => {
    let set = sets.get(key);
    if (!set) sets.set(key, (set = new Map()));
    return set;
  };
  const state = { redisBroken: false };
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
          if (state.redisBroken) throw new Error('redis down');
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
  return { client, sets, zset, state, flag: vi.fn(), maintenance: vi.fn(), captureException: vi.fn(), captureMessage: vi.fn() };
});

vi.mock('@/lib/cache/redis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cache/redis')>();
  return { ...actual, getRedis: () => fake.client };
});
vi.mock('@/lib/feature-flags/global-flags', () => ({
  getGlobalFlag: fake.flag,
  getGlobalFlagForExecution: fake.flag,
}));
vi.mock('@/lib/feature-flags/maintenance', () => ({
  isMaintenanceMode: fake.maintenance,
  MAINTENANCE_PATH: '/przerwa-techniczna',
}));
vi.mock('@sentry/nextjs', () => ({
  captureException: fake.captureException,
  captureMessage: fake.captureMessage,
}));

import { GET as listInvoicesRoute } from '@/app/api/v1/invoices/route';
import { GET as invoiceRoute } from '@/app/api/v1/invoices/[id]/route';
import { GET as listExpensesRoute } from '@/app/api/v1/expenses/route';
import { hashIdentifier } from '@/lib/rate-limit';

// ─── Klucze i dane firm ─────────────────────────────────────────────────

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

function fixtureKey(seed: string): string {
  // 43 znaki base64url po prefiksie, jak klucz z generatora; bez entropii w repo.
  return `fwk_${seed.repeat(43).slice(0, 43)}`;
}

interface FixtureKey {
  key: string;
  id: string;
  tenantId: string;
  scopes: string[];
  revoked: boolean;
}

const KEYS: Record<string, FixtureKey> = {
  a: { key: fixtureKey('A'), id: 'aaaa0000-0000-4000-8000-00000000000a', tenantId: TENANT_A, scopes: ['invoices:read', 'expenses:read'], revoked: false },
  aInvoicesOnly: { key: fixtureKey('C'), id: 'aaaa0000-0000-4000-8000-00000000000c', tenantId: TENANT_A, scopes: ['invoices:read'], revoked: false },
  aExpensesOnly: { key: fixtureKey('E'), id: 'aaaa0000-0000-4000-8000-00000000000e', tenantId: TENANT_A, scopes: ['expenses:read'], revoked: false },
  aRevoked: { key: fixtureKey('R'), id: 'aaaa0000-0000-4000-8000-00000000000f', tenantId: TENANT_A, scopes: ['invoices:read', 'expenses:read'], revoked: true },
  b: { key: fixtureKey('B'), id: 'bbbb0000-0000-4000-8000-00000000000b', tenantId: TENANT_B, scopes: ['invoices:read', 'expenses:read'], revoked: false },
};
const KEYS_BY_HASH = new Map(Object.values(KEYS).map((k) => [sha256(k.key), k]));

const INVOICE_A1 = 'a1a1a1a1-0000-4000-8000-000000000001';
const INVOICE_A2 = 'a2a2a2a2-0000-4000-8000-000000000002';
const INVOICE_B1 = 'b1b1b1b1-0000-4000-8000-000000000001';

/** Wiersze w kształcie, w jakim PostgREST zwraca SELECT trasy (kwoty `::text`). */
function invoiceRow(id: string, tenant: string, overrides: Record<string, unknown> = {}) {
  return {
    id, tenant_id: tenant, direction: 'outgoing', internal_number: `FV/${id.slice(0, 2)}/2026`,
    invoice_kind: 'regular', issue_date: '2026-11-02', sale_date: '2026-11-02', payment_due_date: '2026-11-16',
    currency: 'PLN', net_total: '1000.00', vat_total: '230.00', gross_total: '1230.00', paid_amount: '0.00',
    payment_status: 'unpaid', seller_nip: '1234567890', seller_name: 'Sprzedawca testowy', seller_data_nip: '1234567890',
    fa3_seller_name: null, fa3_seller_nip: null, buyer_nip: '1234567890', buyer_name: 'Nabywca testowy',
    buyer_data_nip: '1234567890', fa3_buyer_name: null, fa3_buyer_nip: null, ksef_status: 'accepted',
    ksef_number: '1234567890-20261102-0000000000AB-01', ksef_accepted_at: '2026-11-02T10:00:00+00:00',
    ksef_environment: 'test', parent_invoice_id: null, created_at: '2026-11-02T09:00:00+00:00',
    updated_at: '2026-11-02T10:00:00+00:00', ...overrides,
  };
}

const INVOICES = [
  invoiceRow(INVOICE_A1, TENANT_A),
  invoiceRow(INVOICE_A2, TENANT_A, {
    direction: 'incoming', issue_date: '2026-11-01', ksef_status: 'received', seller_name: null,
    seller_data_nip: null, fa3_seller_name: 'Dostawca z KSeF', fa3_seller_nip: '1234567890', currency: null,
  }),
  invoiceRow(INVOICE_B1, TENANT_B, { internal_number: 'FV/B/2026' }),
];

const LINE_ITEMS = [
  { invoice_id: INVOICE_A1, ordinal: 1, name: 'Usługa programistyczna', quantity: '1.000', unit: 'szt.', unit_price_net: '1000.00', net_amount: '1000.00', vat_rate: '23', vat_amount: '230.00', gross_amount: '1230.00' },
  { invoice_id: INVOICE_B1, ordinal: 1, name: 'Cudza pozycja', quantity: '1.000', unit: 'szt.', unit_price_net: '1.00', net_amount: '1.00', vat_rate: '23', vat_amount: '0.23', gross_amount: '1.23' },
];

const EXPENSE_A_MANUAL = 'e1e1e1e1-0000-4000-8000-000000000001';
const EXPENSE_A_EUR = 'e2e2e2e2-0000-4000-8000-000000000002';
const EXPENSE_A_UNKNOWN = 'e3e3e3e3-0000-4000-8000-000000000003';
const EXPENSE_B = 'e4e4e4e4-0000-4000-8000-000000000004';

function expenseRow(id: string, tenant: string, overrides: Record<string, unknown> = {}) {
  return {
    id, tenant_id: tenant, document_number: `K/${id.slice(0, 2)}`, document_type: 'invoice', issue_date: '2026-11-03',
    seller_name: 'Dostawca', seller_nip: '1234567890', net_amount: '100.00', vat_amount: '23.00', gross_amount: '123.00',
    vat_deductible_amount: '23.00', vat_rate: '23', is_deductible: true, is_reviewed: true, category_label: 'Usługi',
    kpir_column: 'col_13', source: 'manual', ksef_invoice_id: null, ocr_source: null, ocr_currency: null, ocr_fx: null,
    created_at: '2026-11-03T08:00:00+00:00', updated_at: '2026-11-03T08:00:00+00:00', ...overrides,
  };
}

const EXPENSES = [
  expenseRow(EXPENSE_A_MANUAL, TENANT_A),
  // Koszt ze skrzynki KSeF z faktury w EUR bez kursu: kwoty zostały w EUR.
  expenseRow(EXPENSE_A_EUR, TENANT_A, {
    source: 'ksef_inbox', ksef_invoice_id: INVOICE_A2, is_reviewed: false, is_deductible: false,
    ocr_source: 'ksef_inbox', ocr_currency: 'EUR', ocr_fx: null, vat_amount: '0.00', vat_deductible_amount: '0.00',
  }),
  // Koszt ze skrzynki bez potwierdzonej waluty faktury: waluta nieznana.
  expenseRow(EXPENSE_A_UNKNOWN, TENANT_A, { source: 'ksef_inbox', ksef_invoice_id: null, issue_date: '2026-11-01' }),
  expenseRow(EXPENSE_B, TENANT_B),
];
const EXPENSE_INVOICE_CURRENCY = new Map([[EXPENSE_A_EUR, 'EUR']]);

// ─── Atrapa PostgREST ───────────────────────────────────────────────────

interface Recorded {
  method: string;
  path: string;
  params: URLSearchParams;
  authorization: string | null;
  apikey: string | null;
  body: unknown;
}
let recorded: Recorded[];

function verifyJwt(authorization: string | null): Record<string, unknown> | null {
  const token = authorization?.replace(/^Bearer /, '') ?? '';
  const [header, payload, signature] = token.split('.');
  if (!header || !payload || !signature) return null;
  const expected = createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest('base64url');
  if (expected !== signature) return null;
  if (JSON.parse(Buffer.from(header, 'base64url').toString()).alg !== 'HS256') return null;
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<string, unknown>;
  if (typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now()) return null;
  return claims;
}

/** Firma, której wiersze widzi token z danym zakresem (jak `api_key_request_tenant`). */
function visibleTenant(claims: Record<string, unknown>, scope: string): string | null {
  if (claims.role !== 'api_key_client') return null;
  const key = KEYS_BY_HASH.get(String(claims.api_key_hash));
  if (!key || key.revoked || !key.scopes.includes(scope)) return null;
  return key.tenantId;
}

function applyFilters<T extends Record<string, unknown>>(rows: T[], params: URLSearchParams): T[] {
  let out = rows;
  for (const [column, condition] of params) {
    if (['select', 'order', 'limit', 'or'].includes(column)) continue;
    const [op, ...rest] = condition.split('.');
    const value = rest.join('.');
    out = out.filter((row) => {
      const cell = row[column];
      if (op === 'eq') return String(cell) === value;
      if (op === 'gte') return String(cell) >= value;
      if (op === 'lte') return String(cell) <= value;
      if (op === 'in') return value.replace(/^\(|\)$/g, '').split(',').includes(String(cell));
      throw new Error(`atrapa nie zna operatora ${op}`);
    });
  }
  const limit = params.get('limit');
  const sorted = [...out].sort((x, y) => String(y.issue_date ?? '').localeCompare(String(x.issue_date ?? '')) || String(y.id ?? '').localeCompare(String(x.id ?? '')));
  return limit ? sorted.slice(0, Number(limit)) : sorted;
}

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.origin !== SUPABASE_URL) throw new Error(`Nieoczekiwane żądanie: ${url.href}`);
  const bodyText = request.method === 'GET' ? '' : await request.text();
  recorded.push({
    method: request.method,
    path: url.pathname,
    params: url.searchParams,
    authorization: request.headers.get('authorization'),
    apikey: request.headers.get('apikey'),
    body: bodyText ? JSON.parse(bodyText) : null,
  });

  const claims = verifyJwt(request.headers.get('authorization'));
  if (!claims) return Response.json({ code: 'PGRST301', message: 'JWT invalid' }, { status: 401 });

  if (url.pathname === '/rest/v1/rpc/api_key_session') {
    const key = claims.role === 'api_key_client' ? KEYS_BY_HASH.get(String(claims.api_key_hash)) : undefined;
    if (!key || key.revoked) return Response.json(null);
    return Response.json({ key_id: key.id, tenant_id: key.tenantId, scopes: key.scopes, key_prefix: key.key.slice(0, 12) });
  }
  if (url.pathname === '/rest/v1/invoices') {
    const tenant = visibleTenant(claims, 'invoices:read');
    return Response.json(applyFilters(INVOICES.filter((row) => row.tenant_id === tenant), url.searchParams));
  }
  if (url.pathname === '/rest/v1/invoice_line_items') {
    const tenant = visibleTenant(claims, 'invoices:read');
    const own = new Set(INVOICES.filter((row) => row.tenant_id === tenant).map((row) => row.id));
    return Response.json(applyFilters(LINE_ITEMS.filter((row) => own.has(row.invoice_id)), url.searchParams));
  }
  if (url.pathname === '/rest/v1/expenses') {
    const tenant = visibleTenant(claims, 'expenses:read');
    return Response.json(applyFilters(EXPENSES.filter((row) => row.tenant_id === tenant), url.searchParams));
  }
  if (url.pathname === '/rest/v1/rpc/api_expense_invoice_currencies') {
    const tenant = visibleTenant(claims, 'expenses:read');
    const ids = ((request.method === 'GET' ? [] : (JSON.parse(bodyText) as { p_expense_ids: string[] }).p_expense_ids) ?? []);
    const own = new Set(EXPENSES.filter((row) => row.tenant_id === tenant).map((row) => row.id));
    return Response.json(ids.filter((id) => own.has(id) && EXPENSE_INVOICE_CURRENCY.has(id))
      .map((id) => ({ expense_id: id, currency: EXPENSE_INVOICE_CURRENCY.get(id) })));
  }
  return Response.json({ code: 'PGRST205', message: 'not exposed' }, { status: 404 });
}

// ─── Pomocnicze ─────────────────────────────────────────────────────────

const IP = '203.0.113.7';

function apiRequest(path: string, key: string | null, extraHeaders: Record<string, string> = {}): Request {
  return new Request(`https://app.example.test${path}`, {
    headers: {
      'x-real-ip': IP,
      'user-agent': 'fixture-client/1.0',
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...extraHeaders,
    },
  });
}

async function body(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

function errorCode(json: Record<string, unknown>): unknown {
  return (json.error as { code?: unknown } | undefined)?.code;
}

const listInvoices = (key: string | null, search = '') => listInvoicesRoute(apiRequest(`/api/v1/invoices${search}`, key));
const getInvoice = (key: string | null, id: string) =>
  invoiceRoute(apiRequest(`/api/v1/invoices/${id}`, key), { params: Promise.resolve({ id }) });
const listExpenses = (key: string | null, search = '') => listExpensesRoute(apiRequest(`/api/v1/expenses${search}`, key));

const dataPaths = () => recorded.filter((r) => !r.path.startsWith('/rest/v1/rpc/api_key_session')).map((r) => r.path);

beforeEach(() => {
  vi.clearAllMocks();
  fake.sets.clear();
  fake.state.redisBroken = false;
  recorded = [];
  fake.flag.mockResolvedValue(true);
  fake.maintenance.mockResolvedValue(false);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SUPABASE_URL);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', ANON_KEY);
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', SERVICE_ROLE_KEY);
  vi.stubEnv('SUPABASE_JWT_SECRET', JWT_SECRET);
  vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://redis.fixture.test');
  vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'cccccccccccccccccccccccc');
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// ─── Uwierzytelnianie ───────────────────────────────────────────────────

describe('uwierzytelnianie kluczem API', () => {
  it('bez nagłówka: 401 missing_api_key z WWW-Authenticate, bez bazy', async () => {
    const response = await listInvoices(null);
    expect(response.status).toBe(401);
    expect(errorCode(await body(response))).toBe('missing_api_key');
    expect(response.headers.get('www-authenticate')).toMatch(/^Bearer/);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(recorded).toEqual([]);
  });

  it.each([
    ['inny schemat', 'Basic dXNlcjpwYXNz'],
    ['zły prefiks', `Bearer sk_${'A'.repeat(43)}`],
    ['za krótki', 'Bearer fwk_abc'],
    ['niedozwolone znaki', `Bearer fwk_${'A'.repeat(42)}$`],
    ['dwa klucze', `Bearer ${KEYS.a!.key} ${KEYS.b!.key}`],
  ])('zły klucz (%s): 401 invalid_api_key, bez bazy', async (_name, header) => {
    const response = await listInvoicesRoute(apiRequest('/api/v1/invoices', null, { authorization: header }));
    expect(response.status).toBe(401);
    expect(errorCode(await body(response))).toBe('invalid_api_key');
    expect(recorded).toEqual([]);
  });

  it('nieznany klucz w dobrym formacie: 401 invalid_api_key, bez zapytań o dane', async () => {
    const response = await listInvoices(fixtureKey('Z'));
    expect(response.status).toBe(401);
    expect(errorCode(await body(response))).toBe('invalid_api_key');
    expect(dataPaths()).toEqual([]);
  });

  it('odwołany klucz: 401 invalid_api_key na każdym punkcie, bez zapytań o dane', async () => {
    for (const response of [
      await listInvoices(KEYS.aRevoked!.key),
      await getInvoice(KEYS.aRevoked!.key, INVOICE_A1),
      await listExpenses(KEYS.aRevoked!.key),
    ]) {
      expect(response.status).toBe(401);
      expect(errorCode(await body(response))).toBe('invalid_api_key');
    }
    expect(dataPaths()).toEqual([]);
  });

  it('token do bazy: rola api_key_client, skrót klucza, najwyżej 60 s; nigdy klucz serwisowy', async () => {
    const response = await listInvoices(KEYS.a!.key);
    expect(response.status).toBe(200);
    expect(recorded.length).toBeGreaterThanOrEqual(2);
    for (const r of recorded) {
      expect(r.apikey).toBe(ANON_KEY);
      expect(r.authorization).not.toContain(SERVICE_ROLE_KEY);
      const claims = verifyJwt(r.authorization);
      expect(claims).toMatchObject({ role: 'api_key_client', api_key_hash: sha256(KEYS.a!.key) });
      expect(Number(claims!.exp) - Number(claims!.iat)).toBeLessThanOrEqual(60);
      expect(JSON.stringify(claims)).not.toContain(KEYS.a!.key);
    }
  });

  it('sesja klucza dostaje punkt, identyfikator żądania, adres i przeglądarkę do audytu', async () => {
    const response = await listInvoices(KEYS.a!.key, '?direction=outgoing');
    const session = recorded.find((r) => r.path === '/rest/v1/rpc/api_key_session');
    expect(session?.method).toBe('POST');
    expect(session?.body).toEqual({
      p_endpoint: 'GET /api/v1/invoices?direction=outgoing',
      p_request_id: response.headers.get('x-request-id'),
      p_ip: IP,
      p_user_agent: 'fixture-client/1.0',
    });
    expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });
});

// ─── Zakresy ────────────────────────────────────────────────────────────

describe('zakresy klucza', () => {
  it('klucz tylko do kosztów nie czyta faktur (403 insufficient_scope), bez zapytań o dane', async () => {
    for (const response of [await listInvoices(KEYS.aExpensesOnly!.key), await getInvoice(KEYS.aExpensesOnly!.key, INVOICE_A1)]) {
      expect(response.status).toBe(403);
      expect(errorCode(await body(response))).toBe('insufficient_scope');
      expect(response.headers.get('www-authenticate')).toContain('insufficient_scope');
    }
    expect(dataPaths()).toEqual([]);
  });

  it('klucz tylko do faktur nie czyta kosztów', async () => {
    const response = await listExpenses(KEYS.aInvoicesOnly!.key);
    expect(response.status).toBe(403);
    expect(errorCode(await body(response))).toBe('insufficient_scope');
    expect(dataPaths()).toEqual([]);
  });
});

// ─── Izolacja firm ──────────────────────────────────────────────────────

describe('izolacja firm na każdym punkcie', () => {
  it('lista faktur: firma A widzi tylko swoje, firma B tylko swoje; zapytanie filtruje po firmie klucza', async () => {
    const a = await body(await listInvoices(KEYS.a!.key));
    expect((a.data as { id: string }[]).map((row) => row.id).sort()).toEqual([INVOICE_A1, INVOICE_A2].sort());
    const b = await body(await listInvoices(KEYS.b!.key));
    expect((b.data as { id: string }[]).map((row) => row.id)).toEqual([INVOICE_B1]);
    const invoiceQueries = recorded.filter((r) => r.path === '/rest/v1/invoices');
    expect(invoiceQueries.map((r) => r.params.get('tenant_id'))).toEqual([`eq.${TENANT_A}`, `eq.${TENANT_B}`]);
  });

  it('faktura innej firmy: 404 not_found, także jej pozycje', async () => {
    const response = await getInvoice(KEYS.b!.key, INVOICE_A1);
    expect(response.status).toBe(404);
    const text = await response.text();
    expect(JSON.parse(text).error.code).toBe('not_found');
    expect(text).not.toContain('Usługa programistyczna');
    expect(text).not.toContain('FV/a1/2026');
  });

  it('koszty: firma B nie widzi kosztów firmy A', async () => {
    const b = await body(await listExpenses(KEYS.b!.key));
    expect((b.data as { id: string }[]).map((row) => row.id)).toEqual([EXPENSE_B]);
    const currencyCalls = recorded.filter((r) => r.path === '/rest/v1/rpc/api_expense_invoice_currencies');
    for (const call of currencyCalls) {
      expect((call.body as { p_expense_ids: string[] }).p_expense_ids).not.toContain(EXPENSE_A_EUR);
    }
  });
});

// ─── Odczyt ─────────────────────────────────────────────────────────────

describe('odczyt faktur', () => {
  it('lista: pola po angielsku, kwoty jako tekst dziesiętny, strony kursorem', async () => {
    const response = await listInvoices(KEYS.a!.key, '?limit=1');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const json = await body(response);
    expect(json.data).toEqual([{
      id: INVOICE_A1, direction: 'outgoing', number: 'FV/a1/2026', kind: 'regular',
      issue_date: '2026-11-02', sale_date: '2026-11-02', payment_due_date: '2026-11-16', currency: 'PLN',
      net_total: '1000.00', vat_total: '230.00', gross_total: '1230.00', paid_amount: '0.00', payment_status: 'unpaid',
      seller: { name: 'Sprzedawca testowy', nip: '1234567890' }, buyer: { name: 'Nabywca testowy', nip: '1234567890' },
      ksef_status: 'accepted', ksef_number: '1234567890-20261102-0000000000AB-01',
      ksef_accepted_at: '2026-11-02T10:00:00+00:00', ksef_environment: 'test', corrected_invoice_id: null,
      created_at: '2026-11-02T09:00:00+00:00', updated_at: '2026-11-02T10:00:00+00:00',
    }]);
    expect(typeof json.next_cursor).toBe('string');

    const query = recorded.find((r) => r.path === '/rest/v1/invoices')!;
    expect(query.params.get('order')).toBe('issue_date.desc,id.desc');
    expect(query.params.get('limit')).toBe('2');
    // Minimum danych: bez PESEL, danych specjalnych, uwag i błędów wysyłki.
    for (const hidden of ['pesel', 'special_data', 'notes', 'last_error', 'payment_data']) {
      expect(query.params.get('select')).not.toContain(hidden);
    }

    await listInvoices(KEYS.a!.key, `?limit=1&cursor=${String(json.next_cursor)}`);
    const next = recorded.filter((r) => r.path === '/rest/v1/invoices').at(-1)!;
    expect(next.params.get('or')).toBe(`(issue_date.lt.2026-11-02,and(issue_date.eq.2026-11-02,id.lt.${INVOICE_A1}))`);
  });

  it('faktura przychodząca: sprzedawca z FA(3), waluta domyślnie PLN', async () => {
    const json = await body(await listInvoices(KEYS.a!.key, '?direction=incoming'));
    expect(json.data).toEqual([expect.objectContaining({
      id: INVOICE_A2, direction: 'incoming', currency: 'PLN', ksef_status: 'received',
      seller: { name: 'Dostawca z KSeF', nip: '1234567890' },
    })]);
    expect(json.next_cursor).toBeNull();
    const query = recorded.find((r) => r.path === '/rest/v1/invoices')!;
    expect(query.params.get('direction')).toBe('eq.incoming');
  });

  it('filtry dat i statusu idą do bazy', async () => {
    await listInvoices(KEYS.a!.key, '?issue_date_from=2026-11-01&issue_date_to=2026-11-30&ksef_status=accepted');
    const query = recorded.find((r) => r.path === '/rest/v1/invoices')!;
    expect(query.params.getAll('issue_date')).toEqual(['gte.2026-11-01', 'lte.2026-11-30']);
    expect(query.params.get('ksef_status')).toBe('eq.accepted');
  });

  it('szczegóły: dane, numer KSeF, status i pozycje', async () => {
    const response = await getInvoice(KEYS.a!.key, INVOICE_A1);
    expect(response.status).toBe(200);
    const json = await body(response);
    expect(json.data).toMatchObject({
      id: INVOICE_A1, ksef_number: '1234567890-20261102-0000000000AB-01', ksef_status: 'accepted',
      items: [{
        position: 1, name: 'Usługa programistyczna', quantity: '1.000', unit: 'szt.', unit_price_net: '1000.00',
        net_amount: '1000.00', vat_rate: '23', vat_amount: '230.00', gross_amount: '1230.00',
      }],
    });
  });

  it.each([
    ['?direction=sideways', 'direction'],
    ['?ksef_status=wyslana', 'ksef_status'],
    ['?limit=0', 'limit'],
    ['?limit=101', 'limit'],
    ['?limit=1.5', 'limit'],
    ['?issue_date_from=2026-13-01', 'issue_date_from'],
    ['?issue_date_to=2026-02-30', 'issue_date_to'],
    ['?cursor=nie-kursor', 'cursor'],
    ['?limit=1&limit=2', 'limit'],
    ['?status=accepted', 'status'],
  ])('zły parametr %s: 400 invalid_parameter z nazwą parametru, bez zapytań o dane', async (search, param) => {
    const response = await listInvoices(KEYS.a!.key, search);
    expect(response.status).toBe(400);
    const json = await body(response);
    expect(errorCode(json)).toBe('invalid_parameter');
    expect((json.error as { message: string }).message).toContain(param);
    expect(dataPaths()).toEqual([]);
  });

  it('zły identyfikator faktury: 400 invalid_parameter', async () => {
    const response = await getInvoice(KEYS.a!.key, 'nie-uuid');
    expect(response.status).toBe(400);
    expect(errorCode(await body(response))).toBe('invalid_parameter');
    expect(dataPaths()).toEqual([]);
  });

  it('błąd bazy: 503 bez treści błędu bazy w odpowiedzi', async () => {
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = new URL(new Request(input, init).url);
      if (url.pathname === '/rest/v1/invoices') {
        return Response.json({ code: 'XX000', message: 'private_schema.secret_detail' }, { status: 500 });
      }
      return fakeFetch(input, init);
    });
    const response = await listInvoices(KEYS.a!.key);
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(text).not.toContain('private_schema');
    expect(JSON.parse(text).error.code).toBe('service_unavailable');
  });
});

describe('odczyt kosztów', () => {
  it('lista z kwotami i statusem; waluta jak w karcie kosztu', async () => {
    const response = await listExpenses(KEYS.a!.key);
    expect(response.status).toBe(200);
    const json = await body(response);
    const byId = new Map((json.data as { id: string }[]).map((row) => [row.id, row]));
    expect(byId.get(EXPENSE_A_MANUAL)).toEqual({
      id: EXPENSE_A_MANUAL, document_number: 'K/e1', document_type: 'invoice', issue_date: '2026-11-03',
      seller: { name: 'Dostawca', nip: '1234567890' }, currency: 'PLN', net_amount: '100.00', vat_amount: '23.00',
      gross_amount: '123.00', vat_deductible_amount: '23.00', vat_rate: '23', deductible: true,
      review_status: 'reviewed', category: 'Usługi', kpir_column: 'col_13', source: 'manual', invoice_id: null,
      created_at: '2026-11-03T08:00:00+00:00', updated_at: '2026-11-03T08:00:00+00:00',
    });
    // Faktura w EUR bez kursu: kwoty w EUR, nie w złotych.
    expect(byId.get(EXPENSE_A_EUR)).toMatchObject({ currency: 'EUR', review_status: 'unreviewed', invoice_id: INVOICE_A2 });
    // Bez potwierdzonej waluty faktury API nie twierdzi, że to złote.
    expect(byId.get(EXPENSE_A_UNKNOWN)).toMatchObject({ currency: null });
  });

  it('filtr statusu przeglądu idzie do bazy', async () => {
    await listExpenses(KEYS.a!.key, '?review_status=unreviewed');
    const query = recorded.find((r) => r.path === '/rest/v1/expenses')!;
    expect(query.params.get('is_reviewed')).toBe('eq.false');
    expect(query.params.get('tenant_id')).toBe(`eq.${TENANT_A}`);
  });

  it('zły status przeglądu: 400', async () => {
    const response = await listExpenses(KEYS.a!.key, '?review_status=done');
    expect(response.status).toBe(400);
    expect(errorCode(await body(response))).toBe('invalid_parameter');
  });
});

// ─── Limity i blokady ───────────────────────────────────────────────────

describe('limit zapytań i odmowy fail-closed', () => {
  it('60 zapytań na minutę na klucz; 61. dostaje 429 z Retry-After, bez bazy', async () => {
    for (let i = 0; i < 60; i += 1) {
      expect((await listInvoices(KEYS.a!.key)).status).toBe(200);
    }
    const before = recorded.length;
    const response = await listInvoices(KEYS.a!.key);
    expect(response.status).toBe(429);
    expect(errorCode(await body(response))).toBe('rate_limited');
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(recorded.length).toBe(before);
    // Inny klucz ma własny limit.
    expect((await listInvoices(KEYS.b!.key)).status).toBe(200);
  });

  it('limit na adres IP obejmuje też żądania bez klucza', async () => {
    const window = fake.zset(`rl:api_v1_ip:${hashIdentifier(IP)}`);
    for (let i = 0; i < 600; i += 1) window.set(`seed-${i}`, Date.now());
    const response = await listInvoices(null);
    expect(response.status).toBe(429);
    expect(errorCode(await body(response))).toBe('rate_limited');
  });

  it('bez Redisa: 503 service_unavailable, bez bazy', async () => {
    vi.stubEnv('UPSTASH_REDIS_REST_URL', '');
    const response = await listInvoices(KEYS.a!.key);
    expect(response.status).toBe(503);
    expect(errorCode(await body(response))).toBe('service_unavailable');
    expect(recorded).toEqual([]);
  });

  it('awaria Redisa (limit tylko w pamięci procesu): 503, bez bazy', async () => {
    fake.state.redisBroken = true;
    const response = await listInvoices(KEYS.a!.key);
    expect(response.status).toBe(503);
    expect(errorCode(await body(response))).toBe('service_unavailable');
    expect(recorded).toEqual([]);
  });

  it('bez sekretu JWT: 503 service_unavailable, bez bazy', async () => {
    vi.stubEnv('SUPABASE_JWT_SECRET', '');
    const response = await listInvoices(KEYS.a!.key);
    expect(response.status).toBe(503);
    expect(errorCode(await body(response))).toBe('service_unavailable');
    expect(recorded).toEqual([]);
  });

  it('API nieudostępnione (flaga publicApiEnabled wyłączona): 503 api_disabled na każdym punkcie', async () => {
    fake.flag.mockResolvedValue(false);
    for (const response of [await listInvoices(KEYS.a!.key), await getInvoice(KEYS.a!.key, INVOICE_A1), await listExpenses(KEYS.a!.key)]) {
      expect(response.status).toBe(503);
      expect(errorCode(await body(response))).toBe('api_disabled');
    }
    expect(fake.flag).toHaveBeenCalledWith('publicApiEnabled');
    expect(recorded).toEqual([]);
  });

  it('przerwa techniczna: 503 maintenance', async () => {
    fake.maintenance.mockResolvedValue(true);
    const response = await listInvoices(KEYS.a!.key);
    expect(response.status).toBe(503);
    expect(errorCode(await body(response))).toBe('maintenance');
    expect(recorded).toEqual([]);
  });
});

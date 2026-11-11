import { createHash, createHmac } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Krok 7.2 planu kompletnej aplikacji: łącze MCP (`POST /api/mcp`) tylko do odczytu.
 *
 * Prawdziwa trasa i prawdziwy kod uwierzytelniania `/api/v1`. Atrapy tylko dla
 * HTTP i baz: PostgREST (przez `fetch`, z podpisem tokenu i polityką RLS firmy
 * klucza i zakresu) oraz Redis (sorted set w pamięci), flaga i przerwa techniczna.
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

import { GET as mcpGet, POST as mcpPost, DELETE as mcpDelete } from '@/app/api/mcp/route';

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
  aWriteOnly: { key: fixtureKey('W'), id: 'aaaa0000-0000-4000-8000-00000000000d', tenantId: TENANT_A, scopes: ['invoices:write'], revoked: false },
  b: { key: fixtureKey('B'), id: 'bbbb0000-0000-4000-8000-00000000000b', tenantId: TENANT_B, scopes: ['invoices:read', 'expenses:read'], revoked: false },
};
const KEYS_BY_HASH = new Map(Object.values(KEYS).map((k) => [sha256(k.key), k]));

const INVOICE_A1 = 'a1a1a1a1-0000-4000-8000-000000000001';
const INVOICE_A2 = 'a2a2a2a2-0000-4000-8000-000000000002';
const INVOICE_B1 = 'b1b1b1b1-0000-4000-8000-000000000001';
const INVOICE_A3_OVERDUE_EUR = 'a3a3a3a3-0000-4000-8000-000000000003';
const INVOICE_A4_DRAFT = 'a4a4a4a4-0000-4000-8000-000000000004';
const INVOICE_A5_PAID = 'a5a5a5a5-0000-4000-8000-000000000005';
const INVOICE_B2_OVERDUE = 'b2b2b2b2-0000-4000-8000-000000000002';

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
  // Po terminie, częściowo zapłacona, w EUR.
  invoiceRow(INVOICE_A3_OVERDUE_EUR, TENANT_A, {
    issue_date: '2026-09-15', payment_due_date: '2026-10-01', currency: 'EUR', gross_total: '1230.00',
    paid_amount: '500.00', payment_status: 'partial', internal_number: 'FV/EUR/1',
  }),
  // Szkic: niezapłacony, ale jeszcze nie wystawiony do KSeF, więc nie jest należnością.
  invoiceRow(INVOICE_A4_DRAFT, TENANT_A, { issue_date: '2026-11-05', ksef_status: 'draft', ksef_number: null, internal_number: 'FV/SZKIC' }),
  invoiceRow(INVOICE_A5_PAID, TENANT_A, { issue_date: '2026-10-20', payment_status: 'paid', paid_amount: '1230.00', internal_number: 'FV/ZAPL' }),
  invoiceRow(INVOICE_B2_OVERDUE, TENANT_B, { issue_date: '2026-09-01', payment_due_date: '2026-09-15', payment_status: 'overdue', internal_number: 'FV/B/PO' }),
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
      if (op === 'lt') return String(cell) < value;
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

const MCP_PROTOCOL = '2025-06-18';

function mcpRequest(payload: unknown, key: string | null, extraHeaders: Record<string, string> = {}, raw?: string): Request {
  return new Request('https://app.example.test/api/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'x-real-ip': IP,
      'user-agent': 'fixture-client/1.0',
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...extraHeaders,
    },
    body: raw ?? JSON.stringify(payload),
  });
}

type Json = Record<string, unknown>;
async function body(response: Response): Promise<Json> {
  return (await response.json()) as Json;
}

let nextId = 1;
const rpc = (key: string | null, method: string, params?: unknown) =>
  mcpPost(mcpRequest({ jsonrpc: '2.0', id: nextId++, method, ...(params === undefined ? {} : { params }) }, key));
const call = (key: string | null, name: string, args: unknown = {}) => rpc(key, 'tools/call', { name, arguments: args });

/** Wynik narzędzia: dane (structuredContent) i flaga błędu. */
async function toolResult(response: Response): Promise<{ data: Json; isError: boolean; text: string }> {
  const json = await body(response);
  const result = json.result as { structuredContent?: Json; isError?: boolean; content: { type: string; text: string }[] };
  return { data: result.structuredContent ?? {}, isError: result.isError === true, text: result.content.map((c) => c.text).join('\n') };
}
const rpcErrorCode = async (response: Response) => ((await body(response)).error as { code?: number } | undefined)?.code;

const dataPaths = () => recorded.filter((r) => !r.path.startsWith('/rest/v1/rpc/api_key_session')).map((r) => r.path);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-10T12:00:00Z'));
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
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});


// ─── Protokół ───────────────────────────────────────────────────────────

const READ_TOOLS = ['get_invoice', 'list_expenses', 'list_invoices', 'list_receivables'];
const WRITE_WORDS = /(create|update|delete|send|write|issue|pay|cancel|submit|remove|set|add|post|put)_|^(create|update|delete|send|write|pay|cancel|submit|remove|set|add)/i;

describe('protokół MCP', () => {
  it('initialize: wersja protokołu, tylko narzędzia, nazwa serwera, bez sesji', async () => {
    const response = await rpc(KEYS.a!.key, 'initialize', {
      protocolVersion: MCP_PROTOCOL, capabilities: {}, clientInfo: { name: 'fixture-assistant', version: '1.0' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('mcp-session-id')).toBeNull();
    const json = await body(response);
    expect(json).toMatchObject({ jsonrpc: '2.0', result: { protocolVersion: MCP_PROTOCOL, serverInfo: { name: 'faktway' } } });
    const capabilities = (json.result as { capabilities: Json }).capabilities;
    expect(Object.keys(capabilities)).toEqual(['tools']);
    expect(JSON.stringify(json)).not.toMatch(/[—–]/);
  });

  it('initialize z nieznaną wersją protokołu: serwer odpowiada swoją najnowszą', async () => {
    const json = await body(await rpc(KEYS.a!.key, 'initialize', { protocolVersion: '1999-01-01', capabilities: {}, clientInfo: { name: 'x', version: '1' } }));
    expect((json.result as { protocolVersion: string }).protocolVersion).toMatch(/^20\d\d-\d\d-\d\d$/);
  });

  it('id odpowiedzi to id żądania (liczba albo tekst)', async () => {
    const a = await body(await mcpPost(mcpRequest({ jsonrpc: '2.0', id: 'abc', method: 'ping' }, KEYS.a!.key)));
    expect(a).toMatchObject({ jsonrpc: '2.0', id: 'abc', result: {} });
    const b = await body(await mcpPost(mcpRequest({ jsonrpc: '2.0', id: 41, method: 'ping' }, KEYS.a!.key)));
    expect(b).toMatchObject({ id: 41, result: {} });
  });

  it('notifications/initialized: 202 bez treści', async () => {
    const response = await mcpPost(mcpRequest({ jsonrpc: '2.0', method: 'notifications/initialized' }, KEYS.a!.key));
    expect(response.status).toBe(202);
    expect(await response.text()).toBe('');
  });

  it('tools/list: tylko narzędzia odczytu, każde z opisem po polsku i schematem wejścia', async () => {
    const json = await body(await rpc(KEYS.a!.key, 'tools/list'));
    const tools = (json.result as { tools: { name: string; description: string; inputSchema: Json; annotations: Json }[] }).tools;
    expect(tools.map((t) => t.name).sort()).toEqual(READ_TOOLS);
    for (const tool of tools) {
      expect(tool.name, tool.name).not.toMatch(WRITE_WORDS);
      expect(tool.description.length, tool.name).toBeGreaterThan(40);
      expect(tool.description, tool.name).toMatch(/[ąćęłńóśźż]/i);
      expect(tool.description, tool.name).not.toMatch(/[—–]/);
      expect(tool.inputSchema.type, tool.name).toBe('object');
      expect(tool.annotations, tool.name).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    }
    const limit = (tools.find((t) => t.name === 'list_invoices')!.inputSchema.properties as Record<string, { maximum?: number }>).limit;
    expect(limit?.maximum).toBeLessThanOrEqual(50);
  });

  it('tools/list pokazuje tylko narzędzia dozwolone zakresem klucza', async () => {
    const names = async (key: string) =>
      ((await body(await rpc(key, 'tools/list'))).result as { tools: { name: string }[] }).tools.map((t) => t.name).sort();
    expect(await names(KEYS.aInvoicesOnly!.key)).toEqual(['get_invoice', 'list_invoices', 'list_receivables']);
    expect(await names(KEYS.aExpensesOnly!.key)).toEqual(['list_expenses']);
  });

  it('klucz bez żadnego zakresu odczytu (tylko wystawianie): 403 insufficient_scope', async () => {
    const response = await rpc(KEYS.aWriteOnly!.key, 'tools/list');
    expect(response.status).toBe(403);
    expect((await body(response)).error).toMatchObject({ code: 'insufficient_scope' });
  });

  it('narzędzie spoza zakresu klucza: błąd narzędzia, bez zapytania o dane', async () => {
    const result = await toolResult(await call(KEYS.aExpensesOnly!.key, 'list_invoices'));
    expect(result.isError).toBe(true);
    expect(result.text).toContain('invoices:read');
    expect(dataPaths()).toEqual([]);
  });

  it('nieznana metoda: błąd JSON-RPC -32601', async () => {
    expect(await rpcErrorCode(await rpc(KEYS.a!.key, 'resources/list'))).toBe(-32601);
    expect(await rpcErrorCode(await rpc(KEYS.a!.key, 'prompts/get'))).toBe(-32601);
  });

  it('nieznane narzędzie (w tym każdy zapis): błąd JSON-RPC -32602', async () => {
    expect(await rpcErrorCode(await call(KEYS.a!.key, 'create_invoice', {}))).toBe(-32602);
    expect(await rpcErrorCode(await call(KEYS.a!.key, 'send_invoice_to_ksef', {}))).toBe(-32602);
  });

  it('zła treść: -32700 dla niepoprawnego JSON, -32600 dla złego żądania i dla paczki', async () => {
    const parse = await mcpPost(mcpRequest(null, KEYS.a!.key, {}, '{nie json'));
    expect(parse.status).toBe(400);
    expect(await rpcErrorCode(parse)).toBe(-32700);
    for (const payload of [{ jsonrpc: '1.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', id: 1 }, [{ jsonrpc: '2.0', id: 1, method: 'ping' }], 'ping', null]) {
      const response = await mcpPost(mcpRequest(payload, KEYS.a!.key));
      expect(response.status, JSON.stringify(payload)).toBe(400);
      expect(await rpcErrorCode(response), JSON.stringify(payload)).toBe(-32600);
    }
  });

  it('za duża treść: 413, bez zapytań o dane', async () => {
    const response = await mcpPost(mcpRequest({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(70_000) } }, KEYS.a!.key));
    expect(response.status).toBe(413);
    expect(dataPaths()).toEqual([]);
  });

  it('GET i DELETE: 405 z Allow: POST (bez strumienia SSE i bez sesji)', async () => {
    for (const handler of [mcpGet, mcpDelete]) {
      const response = await handler();
      expect(response.status).toBe(405);
      expect(response.headers.get('allow')).toBe('POST');
    }
  });

  it('zły nagłówek Origin: 403, bez bazy; własna strona i brak Origin przechodzą', async () => {
    const bad = await mcpPost(mcpRequest({ jsonrpc: '2.0', id: 1, method: 'ping' }, KEYS.a!.key, { origin: 'https://zly.example' }));
    expect(bad.status).toBe(403);
    expect(recorded).toEqual([]);
    const ok = await mcpPost(mcpRequest({ jsonrpc: '2.0', id: 1, method: 'ping' }, KEYS.a!.key, { origin: 'https://faktway.pl' }));
    expect(ok.status).toBe(200);
  });
});

// ─── Narzędzia ──────────────────────────────────────────────────────────

describe('list_invoices', () => {
  it('zwraca tylko faktury firmy klucza, kwoty jako liczby z walutą', async () => {
    const result = await toolResult(await call(KEYS.a!.key, 'list_invoices', {}));
    expect(result.isError).toBe(false);
    const invoices = result.data.invoices as Json[];
    const ids = invoices.map((i) => i.id);
    expect(ids).toContain(INVOICE_A1);
    expect(ids).not.toContain(INVOICE_B1);
    expect(ids).not.toContain(INVOICE_B2_OVERDUE);
    const a1 = invoices.find((i) => i.id === INVOICE_A1)!;
    expect(a1).toMatchObject({ currency: 'PLN', net_total: 1000, vat_total: 230, gross_total: 1230, paid_amount: 0 });
    expect(typeof a1.gross_total).toBe('number');
    const eur = invoices.find((i) => i.id === INVOICE_A3_OVERDUE_EUR)!;
    expect(eur).toMatchObject({ currency: 'EUR', gross_total: 1230 });
    expect(result.text).not.toMatch(/zł/);
  });

  it('filtry okresu, kierunku i stanu trafiają do zapytania firmy klucza; limit domyślny to 25', async () => {
    await call(KEYS.a!.key, 'list_invoices', {
      direction: 'outgoing', ksef_status: 'accepted', payment_status: ['unpaid', 'partial'],
      issue_date_from: '2026-10-01', issue_date_to: '2026-11-30',
    });
    const query = recorded.find((r) => r.path === '/rest/v1/invoices')!;
    expect(query.params.get('tenant_id')).toBe(`eq.${TENANT_A}`);
    expect(query.params.get('direction')).toBe('eq.outgoing');
    expect(query.params.get('ksef_status')).toBe('eq.accepted');
    expect(query.params.get('payment_status')).toBe('in.(unpaid,partial)');
    expect(query.params.getAll('issue_date')).toEqual(['gte.2026-10-01', 'lte.2026-11-30']);
    expect(Number(query.params.get('limit'))).toBe(26);
  });

  it('limit powyżej górnej granicy to błąd wejścia, nie ciche przycięcie', async () => {
    const result = await toolResult(await call(KEYS.a!.key, 'list_invoices', { limit: 500 }));
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/limit/i);
  });

  it('strony kursorem: next_cursor przy kolejnej stronie; zły kursor to błąd wejścia', async () => {
    const first = await toolResult(await call(KEYS.a!.key, 'list_invoices', { limit: 1 }));
    expect((first.data.invoices as Json[]).length).toBe(1);
    expect(typeof first.data.next_cursor).toBe('string');
    const second = await toolResult(await call(KEYS.a!.key, 'list_invoices', { limit: 1, cursor: first.data.next_cursor }));
    expect(second.isError).toBe(false);
    const bad = await toolResult(await call(KEYS.a!.key, 'list_invoices', { cursor: '!!!' }));
    expect(bad.isError).toBe(true);
  });
});

describe('get_invoice', () => {
  it('faktura z pozycjami; cudza faktura wygląda jak nieistniejąca', async () => {
    const own = await toolResult(await call(KEYS.a!.key, 'get_invoice', { id: INVOICE_A1 }));
    expect(own.isError).toBe(false);
    const invoice = own.data.invoice as Json;
    expect(invoice).toMatchObject({ id: INVOICE_A1, currency: 'PLN', gross_total: 1230 });
    expect((invoice.items as Json[])[0]).toMatchObject({ name: 'Usługa programistyczna', gross_amount: 1230, net_amount: 1000 });

    const foreign = await toolResult(await call(KEYS.a!.key, 'get_invoice', { id: INVOICE_B1 }));
    expect(foreign.isError).toBe(true);
    expect(foreign.text).toMatch(/nie ma takiej faktury/i);
    expect(JSON.stringify(foreign.data)).not.toContain('FV/B/2026');
  });

  it('zły identyfikator: błąd wejścia, bez zapytania o dane', async () => {
    const result = await toolResult(await call(KEYS.a!.key, 'get_invoice', { id: 'nie-uuid' }));
    expect(result.isError).toBe(true);
    expect(dataPaths()).toEqual([]);
  });
});

describe('list_receivables', () => {
  it('niezapłacone faktury wystawione i przyjęte w KSeF, z kwotą do zapłaty i dniami po terminie', async () => {
    const result = await toolResult(await call(KEYS.a!.key, 'list_receivables', {}));
    expect(result.isError).toBe(false);
    const rows = result.data.receivables as Json[];
    const ids = rows.map((r) => r.id).sort();
    expect(ids).toEqual([INVOICE_A1, INVOICE_A3_OVERDUE_EUR].sort());
    const eur = rows.find((r) => r.id === INVOICE_A3_OVERDUE_EUR)!;
    expect(eur).toMatchObject({ currency: 'EUR', gross_total: 1230, paid_amount: 500, amount_due: 730, overdue: true, days_overdue: 40 });
    const current = rows.find((r) => r.id === INVOICE_A1)!;
    expect(current).toMatchObject({ currency: 'PLN', amount_due: 1230, overdue: false, days_overdue: 0 });
    // Sumy osobno dla każdej waluty, nigdy jedna suma różnych walut.
    expect(result.data.amount_due_by_currency).toEqual({ EUR: 730, PLN: 1230 });
  });

  it('only_overdue zostawia tylko faktury po terminie (zapytanie z granicą terminu)', async () => {
    const result = await toolResult(await call(KEYS.a!.key, 'list_receivables', { only_overdue: true }));
    expect((result.data.receivables as Json[]).map((r) => r.id)).toEqual([INVOICE_A3_OVERDUE_EUR]);
    const query = recorded.find((r) => r.path === '/rest/v1/invoices')!;
    expect(query.params.get('direction')).toBe('eq.outgoing');
    expect(query.params.get('payment_status')).toBe('in.(unpaid,partial,overdue)');
    expect(query.params.get('ksef_status')).toBe('eq.accepted');
    expect(query.params.get('payment_due_date')).toBe('lt.2026-11-10');
  });

  it('dzień „dzisiaj” liczony w strefie Europe/Warsaw (tuż po północy)', async () => {
    vi.setSystemTime(new Date('2026-11-10T23:30:00Z'));
    await call(KEYS.a!.key, 'list_receivables', { only_overdue: true });
    const query = recorded.find((r) => r.path === '/rest/v1/invoices')!;
    expect(query.params.get('payment_due_date')).toBe('lt.2026-11-11');
  });
});

describe('list_expenses', () => {
  it('koszty tylko firmy klucza; waluta kwot, kwoty jako liczby', async () => {
    const result = await toolResult(await call(KEYS.a!.key, 'list_expenses', {}));
    expect(result.isError).toBe(false);
    const rows = result.data.expenses as Json[];
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(EXPENSE_A_MANUAL);
    expect(ids).not.toContain(EXPENSE_B);
    expect(rows.find((r) => r.id === EXPENSE_A_MANUAL)).toMatchObject({ gross_amount: 123, net_amount: 100, vat_amount: 23, currency: 'PLN' });
    expect(rows.find((r) => r.id === EXPENSE_A_EUR)).toMatchObject({ currency: 'EUR', gross_amount: 123 });
    expect(rows.find((r) => r.id === EXPENSE_A_UNKNOWN)).toMatchObject({ currency: null });
  });

  it('filtry okresu i stanu przeglądu; nieznany stan to błąd wejścia', async () => {
    await call(KEYS.a!.key, 'list_expenses', { review_status: 'unreviewed', issue_date_from: '2026-11-01', issue_date_to: '2026-11-30', limit: 10 });
    const query = recorded.find((r) => r.path === '/rest/v1/expenses')!;
    expect(query.params.get('tenant_id')).toBe(`eq.${TENANT_A}`);
    expect(query.params.get('is_reviewed')).toBe('eq.false');
    expect(query.params.getAll('issue_date')).toEqual(['gte.2026-11-01', 'lte.2026-11-30']);
    expect(query.params.get('limit')).toBe('11');
    const bad = await toolResult(await call(KEYS.a!.key, 'list_expenses', { review_status: 'zatwierdzone' }));
    expect(bad.isError).toBe(true);
  });
});

describe('wejście narzędzi i błędy', () => {
  it.each([
    ['list_invoices', { direction: 'sideways' }],
    ['list_invoices', { issue_date_from: '2026-02-30' }],
    ['list_invoices', { nieznane_pole: 1 }],
    ['list_invoices', 'tekst'],
    ['list_receivables', { limit: 0 }],
    ['list_expenses', { issue_date_to: '10.11.2026' }],
  ])('%s z błędnym wejściem %j: błąd narzędzia po polsku, bez zapytania o dane', async (name, args) => {
    const result = await toolResult(await call(KEYS.a!.key, name, args));
    expect(result.isError).toBe(true);
    expect(result.text.length).toBeGreaterThan(10);
    expect(dataPaths()).toEqual([]);
  });

  it('żadne narzędzie nie zapisuje: do danych tylko odczyty (GET) i sesja klucza', async () => {
    for (const name of READ_TOOLS) {
      await call(KEYS.a!.key, name, name === 'get_invoice' ? { id: INVOICE_A1 } : {});
    }
    const mutating = recorded.filter((r) => r.method !== 'GET' && !r.path.endsWith('/rpc/api_key_session') && !r.path.endsWith('/rpc/api_expense_invoice_currencies'));
    expect(mutating).toEqual([]);
  });

  it('błąd bazy: -32603 bez szczegółów wewnętrznych, zgłoszony do Sentry', async () => {
    const real = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(new Request(input).url).pathname === '/rest/v1/invoices') {
        return Response.json({ code: '57014', message: 'relation "invoices" secret internals' }, { status: 500 });
      }
      return real(input, init);
    }));
    const response = await call(KEYS.a!.key, 'list_invoices', {});
    const text = JSON.stringify(await body(response));
    expect(text).toContain('-32603');
    expect(text).not.toMatch(/secret internals|relation|57014/);
    expect(fake.captureMessage).toHaveBeenCalled();
  });
});

// ─── Uwierzytelnianie, limity, flaga ────────────────────────────────────

describe('uwierzytelnianie tak samo jak w /api/v1', () => {
  it('brak klucza: 401 missing_api_key z WWW-Authenticate, bez bazy', async () => {
    const response = await rpc(null, 'tools/list');
    expect(response.status).toBe(401);
    expect((await body(response)).error).toMatchObject({ code: 'missing_api_key' });
    expect(response.headers.get('www-authenticate')).toMatch(/^Bearer/);
    expect(recorded).toEqual([]);
  });

  it('zły klucz (zły format): 401 invalid_api_key, bez bazy', async () => {
    const response = await mcpPost(mcpRequest({ jsonrpc: '2.0', id: 1, method: 'ping' }, null, { authorization: 'Bearer fwk_abc' }));
    expect(response.status).toBe(401);
    expect((await body(response)).error).toMatchObject({ code: 'invalid_api_key' });
    expect(recorded).toEqual([]);
  });

  it('nieznany i odwołany klucz: 401, bez zapytań o dane (także dla notyfikacji)', async () => {
    for (const key of [fixtureKey('Z'), KEYS.aRevoked!.key]) {
      const response = await call(key, 'list_invoices');
      expect(response.status).toBe(401);
      expect((await body(response)).error).toMatchObject({ code: 'invalid_api_key' });
      const notification = await mcpPost(mcpRequest({ jsonrpc: '2.0', method: 'notifications/initialized' }, key));
      expect(notification.status).toBe(401);
    }
    expect(dataPaths()).toEqual([]);
  });

  it('token do bazy: rola api_key_client, skrót klucza, do 60 s; sesja z punktem /api/mcp do audytu', async () => {
    const response = await call(KEYS.a!.key, 'list_invoices');
    expect(response.status).toBe(200);
    for (const r of recorded) {
      expect(r.apikey).toBe(ANON_KEY);
      expect(r.authorization).not.toContain(SERVICE_ROLE_KEY);
      const claims = verifyJwt(r.authorization);
      expect(claims).toMatchObject({ role: 'api_key_client', api_key_hash: sha256(KEYS.a!.key) });
      expect(Number(claims!.exp) - Number(claims!.iat)).toBeLessThanOrEqual(60);
    }
    const session = recorded.find((r) => r.path === '/rest/v1/rpc/api_key_session');
    expect(session?.body).toEqual({
      p_endpoint: 'POST /api/mcp',
      p_request_id: response.headers.get('x-request-id'),
      p_ip: IP,
      p_user_agent: 'fixture-client/1.0',
    });
  });

  it('60 żądań na minutę na klucz; 61. dostaje 429 z Retry-After, bez bazy; inny klucz ma własny limit', async () => {
    for (let i = 0; i < 60; i += 1) expect((await rpc(KEYS.a!.key, 'ping')).status).toBe(200);
    const before = recorded.length;
    const response = await rpc(KEYS.a!.key, 'ping');
    expect(response.status).toBe(429);
    expect((await body(response)).error).toMatchObject({ code: 'rate_limited' });
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(recorded.length).toBe(before);
    expect((await rpc(KEYS.b!.key, 'ping')).status).toBe(200);
  });

  it('flaga publicApiEnabled wyłączona: 503 api_disabled jak w /api/v1, bez bazy', async () => {
    fake.flag.mockResolvedValue(false);
    const response = await rpc(KEYS.a!.key, 'initialize', { protocolVersion: MCP_PROTOCOL, capabilities: {}, clientInfo: { name: 'x', version: '1' } });
    expect(response.status).toBe(503);
    expect((await body(response)).error).toMatchObject({ code: 'api_disabled' });
    expect(fake.flag).toHaveBeenCalledWith('publicApiEnabled');
    expect(recorded).toEqual([]);
  });

  it('przerwa techniczna i awaria Redisa: 503 bez bazy', async () => {
    fake.maintenance.mockResolvedValue(true);
    expect((await body(await rpc(KEYS.a!.key, 'ping'))).error).toMatchObject({ code: 'maintenance' });
    fake.maintenance.mockResolvedValue(false);
    fake.state.redisBroken = true;
    expect((await rpc(KEYS.a!.key, 'ping')).status).toBe(503);
    expect(recorded).toEqual([]);
  });
});

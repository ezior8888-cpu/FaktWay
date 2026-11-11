import { createHash, createHmac, randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Krok 7.1 planu kompletnej aplikacji, część 2: wystawianie faktur przez
 * publiczne API (`POST /api/v1/invoices`).
 *
 * Prawdziwa trasa i prawdziwy kod: uwierzytelnianie kluczem, walidacja (ten
 * sam schemat co formularz i `validateInvoice`), numeracja, budowa faktury
 * (`buildInvoiceFromForm`) i kolejka wysyłki do KSeF
 * (`enqueueKsefSubmitAfterDraft`, `sendJobEvent`). Atrapy tylko dla HTTP
 * i baz: PostgREST (`fetch`), Redis, pg-boss (połączenie z Postgresem), flagi
 * i przerwa techniczna (odczyt z bazy), Sentry; do tego `next/cache` poza Next.
 *
 * Atrapa PostgREST-a naśladuje 00184: firmę i zakres ustala skrót klucza
 * w tokenie, klucz idempotencji jest unikalny w (firma, klucz API, klucz
 * idempotencji), numer faktury w firmie, sprzedawca to firma klucza, a rola
 * `api_key_client` czyta tylko nadane kolumny `tenants`. Prawdziwe funkcje
 * i polityki sprawdza `tests/rls-api-wystawianie.test.ts` na bazie.
 */

const SUPABASE_URL = 'https://db.fixture.test';
// Wartości przy nazwach kluczy i sekretów bez entropii (skan sekretów).
const ANON_KEY = 'a'.repeat(24);
const SERVICE_ROLE_KEY = 'b'.repeat(24);
const JWT_SECRET = 'j'.repeat(48);

const TENANT_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const TENANT_B = 'bbbbbbbb-0000-4000-8000-000000000002';
// Fikcyjne NIP-y z poprawną sumą kontrolną (powtórzona cyfra).
const NIP_A = '1111111111';
const NIP_B = '2222222222';
const BUYER_NIP = '3333333333';
const IBAN = 'PL61109010140000071219812874';

const fake = vi.hoisted(() => {
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

  const flags: Record<string, boolean> = {};
  const jobs: Array<{ queue: string; data: Record<string, unknown>; options: Record<string, unknown> }> = [];
  const hooks: { executeSql: (text: string, values: unknown[]) => Promise<unknown> } = {
    executeSql: async () => {
      throw new Error('atrapa pg-boss bez kroku transakcji');
    },
  };
  /** pg-boss: zlecenie i krok RPC w jednej „transakcji” (krok najpierw, jak w `sendJobEvent`). */
  const boss = {
    getDb: () => ({
      executeSql: async () => {
        throw new Error('zapis zlecenia poza transakcją');
      },
      withTransaction: async <T,>(fn: (tx: { executeSql: (text: string, values: unknown[]) => Promise<unknown> }) => Promise<T>) =>
        fn({ executeSql: (text: string, values: unknown[]) => hooks.executeSql(text, values) }),
    }),
    send: async (queue: string, data: Record<string, unknown>, options: Record<string, unknown>) => {
      jobs.push({ queue, data, options });
      return `job-${jobs.length}`;
    },
  };

  return {
    client,
    sets,
    flags,
    jobs,
    hooks,
    boss,
    flag: vi.fn(async (name: string) => flags[name] ?? false),
    maintenance: vi.fn(async () => false),
    captureException: vi.fn(),
    captureMessage: vi.fn(),
  };
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
  addBreadcrumb: vi.fn(),
  setTag: vi.fn(),
}));
vi.mock('@/lib/jobs/boss', () => ({ startBoss: async () => fake.boss }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { GET as listInvoicesRoute, POST as createInvoiceRoute } from '@/app/api/v1/invoices/route';
import { API_RATE_LIMITS } from '@/lib/api/v1/auth';
import {
  apiInvoiceBuyerSchema,
  apiInvoiceCreateSchema,
  apiInvoiceItemSchema,
  INVOICE_CREATE_FIELDS,
} from '@/lib/api/v1/invoice-create';
import { addDaysToIsoDate, todayInWarsaw } from '@/lib/format/warsaw-date';
import { nextInvoiceNumberCandidates, suggestNextInvoiceNumber } from '@/lib/invoices/next-number';
import { encryptCredentials } from '@/lib/ksef/credentials-crypto';

// ─── Klucze, firmy i baza w pamięci ─────────────────────────────────────

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

function fixtureKey(seed: string): string {
  return `fwk_${seed.repeat(43).slice(0, 43)}`;
}

interface FixtureKey {
  key: string;
  id: string;
  tenantId: string;
  scopes: string[];
  revoked: boolean;
}

const KEYS: Record<'writer' | 'full' | 'reader' | 'revoked' | 'writerB', FixtureKey> = {
  writer: { key: fixtureKey('W'), id: 'aaaa0000-0000-4000-8000-0000000000a1', tenantId: TENANT_A, scopes: ['invoices:write'], revoked: false },
  full: { key: fixtureKey('F'), id: 'aaaa0000-0000-4000-8000-0000000000a2', tenantId: TENANT_A, scopes: ['invoices:read', 'invoices:write'], revoked: false },
  reader: { key: fixtureKey('R'), id: 'aaaa0000-0000-4000-8000-0000000000a3', tenantId: TENANT_A, scopes: ['invoices:read', 'expenses:read'], revoked: false },
  revoked: { key: fixtureKey('X'), id: 'aaaa0000-0000-4000-8000-0000000000a4', tenantId: TENANT_A, scopes: ['invoices:write'], revoked: true },
  writerB: { key: fixtureKey('B'), id: 'bbbb0000-0000-4000-8000-0000000000b1', tenantId: TENANT_B, scopes: ['invoices:write'], revoked: false },
};
const KEYS_BY_HASH = new Map(Object.values(KEYS).map((k) => [sha256(k.key), k]));

const TENANTS: Record<string, Record<string, unknown>> = {
  [TENANT_A]: {
    id: TENANT_A, nip: NIP_A, name: 'Firma A testowa',
    address_json: { countryCode: 'PL', addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa' },
    vat_exemption_basis: null, vat_cash_method: false,
    ksef_verified_at: '2026-10-01T08:00:00+00:00', ksef_verified_environment: 'test',
  },
  [TENANT_B]: {
    id: TENANT_B, nip: NIP_B, name: 'Firma B testowa',
    address_json: { countryCode: 'PL', addressLine1: 'ul. Obca 9', addressLine2: '30-001 Kraków' },
    vat_exemption_basis: null, vat_cash_method: false,
    ksef_verified_at: '2026-10-01T08:00:00+00:00', ksef_verified_environment: 'test',
  },
};
/** Kolumny `tenants` nadane roli `api_key_client` w 00184. */
const TENANT_COLUMNS_FOR_API = [
  'id', 'nip', 'name', 'address_json', 'vat_exemption_basis', 'vat_cash_method', 'ksef_verified_at', 'ksef_verified_environment',
];

type Row = Record<string, unknown>;

interface StoredInvoice {
  row: Row;
  lines: Row[];
}

interface IdempotencyRow {
  id: string;
  tenantId: string;
  keyId: string;
  idempotencyKey: string;
  requestHash: string;
  invoiceId: string | null;
  sendRequested: boolean;
  requestId: string | null;
}

let store: {
  invoices: Map<string, StoredInvoice>;
  idempotency: Map<string, IdempotencyRow>;
  /** Wpisy audytu z funkcji bazy (00184) i z klucza serwisowego (`logAudit`). */
  audit: Row[];
  attempts: Row[];
  credentials: Record<string, string>;
  /** Hak: równoległe żądanie zajmuje numer tuż przed zapisem (wyścig numeracji). */
  beforeCreate: ((invoice: Row) => void) | null;
};
let clock = Date.parse('2026-11-10T09:00:00Z');
const tick = () => new Date((clock += 1000)).toISOString();

const fix = (value: unknown, digits: number) => (value === null || value === undefined ? null : Number(value).toFixed(digits));

function seedInvoice(tenantId: string, overrides: Row = {}): string {
  const id = randomUUID();
  const at = tick();
  store.invoices.set(id, {
    row: {
      id, tenant_id: tenantId, direction: 'outgoing', invoice_kind: 'regular', origin: 'app', ksef_status: 'accepted',
      internal_number: `FV/${id.slice(0, 4)}`, issue_date: todayInWarsaw(), created_at: at, updated_at: at, ...overrides,
    },
    lines: [],
  });
  return id;
}

/** Wynik w kształcie `api_invoice_request_result` z 00184. */
function requestResult(request: IdempotencyRow, status: string): Row {
  const stored = request.invoiceId ? store.invoices.get(request.invoiceId) : undefined;
  const i = stored?.row;
  const draft = i?.ksef_status === 'draft';
  const invoice = i
    ? {
      id: i.id, direction: i.direction, internal_number: i.internal_number, invoice_kind: i.invoice_kind,
      issue_date: i.issue_date, sale_date: i.sale_date ?? null, payment_due_date: i.payment_due_date ?? null,
      currency: i.currency, net_total: fix(i.net_total, 2), vat_total: fix(i.vat_total, 2), gross_total: fix(i.gross_total, 2),
      paid_amount: '0.00', payment_status: 'unpaid', seller_nip: i.seller_nip,
      seller_name: (i.seller_data as Row | undefined)?.name ?? null, seller_data_nip: (i.seller_data as Row | undefined)?.nip ?? null,
      fa3_seller_name: ((i.fa3_data as Row | undefined)?.seller as Row | undefined)?.name ?? null,
      fa3_seller_nip: ((i.fa3_data as Row | undefined)?.seller as Row | undefined)?.nip ?? null,
      buyer_nip: i.buyer_nip, buyer_name: (i.buyer_data as Row | undefined)?.name ?? null,
      buyer_data_nip: (i.buyer_data as Row | undefined)?.nip ?? null,
      fa3_buyer_name: ((i.fa3_data as Row | undefined)?.buyer as Row | undefined)?.name ?? null,
      fa3_buyer_nip: ((i.fa3_data as Row | undefined)?.buyer as Row | undefined)?.nip ?? null,
      ksef_status: i.ksef_status, ksef_number: null, ksef_accepted_at: null, ksef_environment: null,
      parent_invoice_id: null, created_at: i.created_at, updated_at: i.updated_at,
    }
    : null;
  return {
    status,
    send_requested: request.sendRequested,
    send_allowed: Boolean(request.sendRequested && draft && i?.updated_at === i?.created_at),
    invoice,
    items: (stored?.lines ?? []).map((l) => ({
      ordinal: l.ordinal, name: l.name, quantity: fix(l.quantity, 4), unit: l.unit, unit_price_net: fix(l.unit_price_net, 4),
      net_amount: fix(l.net_amount, 2), vat_rate: l.vat_rate, vat_amount: fix(l.vat_amount, 2), gross_amount: fix(l.gross_amount, 2),
    })),
    fa3_data: request.sendRequested && draft ? i?.fa3_data ?? null : null,
  };
}

// ─── Atrapa PostgREST ───────────────────────────────────────────────────

interface Recorded {
  method: string;
  path: string;
  params: URLSearchParams;
  service: boolean;
  body: Row | null;
}
let recorded: Recorded[];

function verifyJwt(authorization: string | null): Row | null {
  const token = authorization?.replace(/^Bearer /, '') ?? '';
  const [header, payload, signature] = token.split('.');
  if (!header || !payload || !signature) return null;
  const expected = createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest('base64url');
  if (expected !== signature) return null;
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Row;
  if (typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now()) return null;
  return claims;
}

/** Klucz z tokenu, gdy nie jest odwołany i ma zakres (jak `api_key_request_tenant`). */
function keyWithScope(claims: Row, scope: string): FixtureKey | null {
  if (claims.role !== 'api_key_client') return null;
  const key = KEYS_BY_HASH.get(String(claims.api_key_hash));
  return key && !key.revoked && key.scopes.includes(scope) ? key : null;
}

const pgError = (status: number, code: string, message: string) =>
  Response.json({ code, message, details: null, hint: null }, { status });

function selectColumns(params: URLSearchParams): string[] {
  return (params.get('select') ?? '*').split(',').map((c) => c.trim());
}

function rpcCreate(key: FixtureKey, body: Row): Response {
  const invoice = body.p_invoice as Row;
  const fa3 = invoice.fa3_data as Row;
  const tenant = TENANTS[key.tenantId]!;
  if (invoice.seller_nip !== tenant.nip || (fa3.seller as Row).nip !== tenant.nip || (invoice.seller_data as Row).nip !== tenant.nip) {
    return pgError(400, 'P0001', 'api_invoice_seller_mismatch');
  }
  if (fa3.type !== 'VAT' || (fa3.payment as Row).currency !== 'PLN' || invoice.invoice_type !== 'VAT' || invoice.currency !== 'PLN') {
    return pgError(400, 'P0001', 'api_invoice_unsupported');
  }
  const slot = `${key.tenantId}|${key.id}|${String(body.p_idempotency_key)}`;
  const existing = store.idempotency.get(slot);
  if (existing) {
    return Response.json(existing.requestHash === body.p_request_hash ? requestResult(existing, 'replayed') : { status: 'conflict' });
  }
  store.beforeCreate?.(invoice);
  const taken = [...store.invoices.values()].some(
    (s) => s.row.tenant_id === key.tenantId && s.row.direction === 'outgoing' && s.row.internal_number === invoice.internal_number,
  );
  if (taken) return pgError(400, 'P0001', 'api_invoice_number_taken');

  const id = randomUUID();
  const at = tick();
  store.invoices.set(id, {
    row: {
      ...invoice, id, tenant_id: key.tenantId, direction: 'outgoing', ksef_status: 'draft', origin: 'app',
      invoice_kind: 'regular', seller_nip: tenant.nip, created_at: at, updated_at: at,
    },
    lines: (body.p_lines as Row[]).map((l) => ({ ...l, invoice_id: id })),
  });
  const request: IdempotencyRow = {
    id: randomUUID(), tenantId: key.tenantId, keyId: key.id, idempotencyKey: String(body.p_idempotency_key),
    requestHash: String(body.p_request_hash), invoiceId: id, sendRequested: body.p_send === true, requestId: String(body.p_request_id),
  };
  store.idempotency.set(slot, request);
  store.audit.push({
    tenant_id: key.tenantId, user_id: null, action: 'invoice.draft_created', entity_id: id,
    metadata: { source: 'api_v1', api_key_id: key.id, request_id: body.p_request_id },
  });
  return Response.json(requestResult(request, 'created'));
}

function serviceRole(method: string, url: URL, request: Request, body: Row | null): Response {
  if (method === 'GET' && url.pathname === '/rest/v1/tenants' && url.searchParams.get('select') === 'ksef_credentials_encrypted') {
    const tenantId = url.searchParams.get('id')?.replace(/^eq\./, '') ?? '';
    const row = { ksef_credentials_encrypted: store.credentials[tenantId] ?? null };
    return request.headers.get('accept')?.includes('vnd.pgrst.object') ? Response.json(row) : Response.json([row]);
  }
  if (method === 'POST' && url.pathname === '/rest/v1/audit_logs') {
    store.audit.push({ ...(body ?? {}), via: 'service_role' });
    return new Response(null, { status: 201 });
  }
  if (method === 'POST' && url.pathname === '/rest/v1/ksef_send_attempts') {
    store.attempts.push(body ?? {});
    return new Response(null, { status: 201 });
  }
  throw new Error(`Klucz serwisowy poza wysyłką do KSeF: ${method} ${url.pathname}?${url.searchParams}`);
}

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.origin !== SUPABASE_URL) throw new Error(`Nieoczekiwane żądanie: ${url.href}`);
  const text = request.method === 'GET' || request.method === 'HEAD' ? '' : await request.text();
  const body = text ? (JSON.parse(text) as Row) : null;
  const authorization = request.headers.get('authorization');
  const service = authorization === `Bearer ${SERVICE_ROLE_KEY}`;
  recorded.push({ method: request.method, path: url.pathname, params: url.searchParams, service, body });
  if (service) return serviceRole(request.method, url, request, body);

  const claims = verifyJwt(authorization);
  if (!claims) return pgError(401, 'PGRST301', 'JWT invalid');

  switch (url.pathname) {
    case '/rest/v1/rpc/api_key_session': {
      const key = claims.role === 'api_key_client' ? KEYS_BY_HASH.get(String(claims.api_key_hash)) : undefined;
      if (!key || key.revoked) return Response.json(null);
      return Response.json({ key_id: key.id, tenant_id: key.tenantId, scopes: key.scopes, key_prefix: key.key.slice(0, 12) });
    }
    case '/rest/v1/tenants': {
      const columns = selectColumns(url.searchParams);
      const denied = columns.filter((c) => !TENANT_COLUMNS_FOR_API.includes(c));
      if (denied.length > 0) return pgError(401, '42501', 'permission denied for table tenants');
      const key = keyWithScope(claims, 'invoices:write');
      const wanted = url.searchParams.get('id')?.replace(/^eq\./, '');
      const rows = key && wanted === key.tenantId ? [TENANTS[key.tenantId]!] : [];
      return Response.json(rows.map((row) => Object.fromEntries(columns.map((c) => [c, row[c]]))));
    }
    case '/rest/v1/rpc/api_invoice_idempotent_result': {
      const key = keyWithScope(claims, 'invoices:write');
      if (!key) return pgError(403, '42501', 'api_key_forbidden');
      const existing = store.idempotency.get(`${key.tenantId}|${key.id}|${String(body?.p_idempotency_key)}`);
      if (!existing) return Response.json({ status: 'new' });
      return Response.json(existing.requestHash === body?.p_request_hash ? requestResult(existing, 'replayed') : { status: 'conflict' });
    }
    case '/rest/v1/rpc/api_invoice_number_context': {
      const key = keyWithScope(claims, 'invoices:write');
      if (!key) return pgError(403, '42501', 'api_key_forbidden');
      const regular = [...store.invoices.values()]
        .map((s) => s.row)
        .filter((r) => r.tenant_id === key.tenantId && r.direction === 'outgoing' && r.invoice_kind === 'regular' && r.internal_number)
        .sort((x, y) => String(y.issue_date).localeCompare(String(x.issue_date)) || String(y.created_at).localeCompare(String(x.created_at)));
      const pick = (r: Row | undefined) => (r ? { internal_number: r.internal_number, issue_date: r.issue_date } : null);
      return Response.json({ last_app: pick(regular.find((r) => r.origin === 'app')), last_any: pick(regular[0]) });
    }
    case '/rest/v1/rpc/api_invoice_numbers_taken': {
      const key = keyWithScope(claims, 'invoices:write');
      if (!key) return pgError(403, '42501', 'api_key_forbidden');
      const wanted = new Set(((body?.p_numbers as string[] | undefined) ?? []).slice(0, 10));
      return Response.json([...new Set([...store.invoices.values()]
        .filter((s) => s.row.tenant_id === key.tenantId && wanted.has(String(s.row.internal_number)))
        .map((s) => String(s.row.internal_number)))]);
    }
    case '/rest/v1/rpc/api_create_invoice': {
      const key = keyWithScope(claims, 'invoices:write');
      if (!key) return pgError(403, '42501', 'api_key_forbidden');
      return rpcCreate(key, body ?? {});
    }
    case '/rest/v1/invoices': {
      // Odczyt faktur: tylko zakres invoices:read (00181).
      const key = keyWithScope(claims, 'invoices:read');
      return Response.json(key ? [] : []);
    }
    default:
      return pgError(404, 'PGRST205', 'not exposed');
  }
}

/** `enqueue_ksef_send` z 00131: draft → queued albo P0002. */
async function enqueueRpc(text: string, values: unknown[]): Promise<unknown> {
  if (!/public\.enqueue_ksef_send\(/.test(text)) throw new Error(`atrapa pg-boss nie zna: ${text}`);
  const [invoiceId, tenantId] = values as [string, string];
  const stored = store.invoices.get(invoiceId);
  if (!stored || stored.row.tenant_id !== tenantId || stored.row.ksef_status !== 'draft') {
    throw Object.assign(new Error('Faktura nie jest szkicem albo nie należy do tej firmy'), { code: 'P0002' });
  }
  stored.row.ksef_status = 'queued';
  stored.row.updated_at = tick();
  return { rows: [{ id: invoiceId }], rowCount: 1 };
}

// ─── Pomocnicze ─────────────────────────────────────────────────────────

const IP = '203.0.113.9';
const TODAY = todayInWarsaw();
const IN_14_DAYS = addDaysToIsoDate(TODAY, 14)!;

function validBody(overrides: Row = {}): Row {
  return {
    number: 'FV/API/1',
    issue_date: TODAY,
    payment_due_date: IN_14_DAYS,
    payment_method: 'transfer',
    bank_account: IBAN,
    buyer: { type: 'company', nip: BUYER_NIP, name: 'Nabywca testowy', address_line1: 'ul. Kupiecka 2', address_line2: '00-002 Warszawa' },
    items: [{ name: 'Usługa programistyczna', unit: 'szt.', quantity: '3', unit_price_net: '33.333', vat_rate: '23' }],
    ...overrides,
  };
}

interface PostOptions {
  idem?: string | null;
  headers?: Record<string, string>;
  raw?: string;
}

function postInvoice(key: string | null, body: unknown, options: PostOptions = {}) {
  const idem = options.idem === undefined ? 'zam-1' : options.idem;
  return createInvoiceRoute(new Request('https://app.example.test/api/v1/invoices', {
    method: 'POST',
    headers: {
      'x-real-ip': IP,
      'user-agent': 'fixture-shop/1.0',
      'content-type': 'application/json',
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...(idem !== null ? { 'idempotency-key': idem } : {}),
      ...options.headers,
    },
    body: options.raw ?? JSON.stringify(body),
  }));
}

async function json(response: Response): Promise<Row> {
  return (await response.json()) as Row;
}

const errorOf = (body: Row) => body.error as { code: string; message: string; fields?: Array<{ field: string; message: string }> };
const invoiceRpcCalls = () => recorded.filter((r) => /api_create_invoice|api_invoice_/.test(r.path));
const createCalls = () => recorded.filter((r) => r.path === '/rest/v1/rpc/api_create_invoice');
const serviceCalls = () => recorded.filter((r) => r.service);
const invoicesOf = (tenantId: string) => [...store.invoices.values()].filter((s) => s.row.tenant_id === tenantId && s.row.origin === 'app' && s.lines.length > 0);

beforeEach(() => {
  vi.clearAllMocks();
  fake.sets.clear();
  fake.jobs.length = 0;
  for (const name of Object.keys(fake.flags)) delete fake.flags[name];
  fake.flags.publicApiEnabled = true;
  fake.hooks.executeSql = enqueueRpc;
  recorded = [];
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SUPABASE_URL);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', ANON_KEY);
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', SERVICE_ROLE_KEY);
  vi.stubEnv('SUPABASE_JWT_SECRET', JWT_SECRET);
  vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://redis.fixture.test');
  vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'c'.repeat(24));
  vi.stubEnv('KSEF_CREDENTIALS_ENCRYPTION_KEY', 'k'.repeat(32));
  vi.stubEnv('KSEF_ENV', 'test');
  store = {
    invoices: new Map(),
    idempotency: new Map(),
    audit: [],
    attempts: [],
    credentials: Object.fromEntries([TENANT_A, TENANT_B].map((tenantId) => [
      tenantId,
      `\\x${encryptCredentials({ type: 'token', nip: String(TENANTS[tenantId]!.nip), token: 't'.repeat(8) }, tenantId).toString('hex')}`,
    ])),
    beforeCreate: null,
  };
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// ─── Udostępnienie, klucz i zakres ──────────────────────────────────────

describe('POST /api/v1/invoices: udostępnienie i zakres invoices:write', () => {
  it('flaga wyłączona: 503 api_disabled, bez bazy i bez zapisu', async () => {
    fake.flags.publicApiEnabled = false;
    const response = await postInvoice(KEYS.writer.key, validBody());
    expect(response.status).toBe(503);
    expect(errorOf(await json(response)).code).toBe('api_disabled');
    expect(recorded).toEqual([]);
    expect(store.invoices.size).toBe(0);
  });

  it('klucz bez invoices:write (tylko odczyt): 403 insufficient_scope, bez zapytań o fakturę', async () => {
    const response = await postInvoice(KEYS.reader.key, validBody());
    expect(response.status).toBe(403);
    const error = errorOf(await json(response));
    expect(error.code).toBe('insufficient_scope');
    expect(error.message).toContain('invoices:write');
    expect(response.headers.get('www-authenticate')).toContain('scope="invoices:write"');
    expect(invoiceRpcCalls()).toEqual([]);
    expect(store.invoices.size).toBe(0);
  });

  it('odwołany klucz: 401 invalid_api_key; bez klucza: 401 missing_api_key', async () => {
    const revoked = await postInvoice(KEYS.revoked.key, validBody());
    expect(revoked.status).toBe(401);
    expect(errorOf(await json(revoked)).code).toBe('invalid_api_key');
    const missing = await postInvoice(null, validBody());
    expect(missing.status).toBe(401);
    expect(errorOf(await json(missing)).code).toBe('missing_api_key');
    expect(invoiceRpcCalls()).toEqual([]);
  });

  it('klucz tylko do wystawiania nie czyta faktur (GET 403)', async () => {
    const response = await listInvoicesRoute(new Request('https://app.example.test/api/v1/invoices', {
      headers: { 'x-real-ip': IP, authorization: `Bearer ${KEYS.writer.key}` },
    }));
    expect(response.status).toBe(403);
    expect(errorOf(await json(response)).code).toBe('insufficient_scope');
  });

  it('sesja klucza dostaje punkt POST /api/v1/invoices do audytu, a zapis ten sam identyfikator żądania', async () => {
    const response = await postInvoice(KEYS.writer.key, validBody());
    expect(response.status).toBe(201);
    const session = recorded.find((r) => r.path === '/rest/v1/rpc/api_key_session');
    expect(session?.body).toMatchObject({ p_endpoint: 'POST /api/v1/invoices', p_ip: IP, p_user_agent: 'fixture-shop/1.0' });
    expect(createCalls()[0]?.body?.p_request_id).toBe(response.headers.get('x-request-id'));
    expect(store.audit).toContainEqual(expect.objectContaining({
      action: 'invoice.draft_created', user_id: null, metadata: expect.objectContaining({ source: 'api_v1', api_key_id: KEYS.writer.id }),
    }));
  });

  it('limit zapisu: osobny limit żądań POST na minutę na klucz, potem 429 z Retry-After', async () => {
    expect(API_RATE_LIMITS.write.limit).toBeLessThan(API_RATE_LIMITS.key.limit);
    for (let i = 0; i < API_RATE_LIMITS.write.limit; i++) {
      const response = await postInvoice(KEYS.writer.key, {}, { idem: `zam-${i}` });
      expect(response.status).toBe(422);
    }
    const limited = await postInvoice(KEYS.writer.key, {}, { idem: 'zam-x' });
    expect(limited.status).toBe(429);
    expect(errorOf(await json(limited)).code).toBe('rate_limited');
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
  });
});

// ─── Utworzenie szkicu ──────────────────────────────────────────────────

describe('POST /api/v1/invoices: pola treści', () => {
  it('schemat trasy przyjmuje dokładnie pola z opisu OpenAPI (INVOICE_CREATE_FIELDS)', () => {
    expect(Object.keys(apiInvoiceCreateSchema.shape).sort()).toEqual([...INVOICE_CREATE_FIELDS.invoice].sort());
    expect(Object.keys(apiInvoiceBuyerSchema.shape).sort()).toEqual([...INVOICE_CREATE_FIELDS.buyer].sort());
    expect(Object.keys(apiInvoiceItemSchema.shape).sort()).toEqual([...INVOICE_CREATE_FIELDS.item].sort());
  });
});

describe('POST /api/v1/invoices: szkic tą samą drogą co formularz', () => {
  it('201 z fakturą: kwoty z kalkulatora (grosze), sprzedawca z firmy klucza, szkic bez wysyłki', async () => {
    const response = await postInvoice(KEYS.writer.key, validBody());
    expect(response.status).toBe(201);
    const body = await json(response);
    const data = body.data as Row;
    expect(data).toMatchObject({
      direction: 'outgoing', number: 'FV/API/1', kind: 'regular', issue_date: TODAY, sale_date: null,
      payment_due_date: IN_14_DAYS, currency: 'PLN', net_total: '100.00', vat_total: '23.00', gross_total: '123.00',
      seller: { name: 'Firma A testowa', nip: NIP_A }, buyer: { name: 'Nabywca testowy', nip: BUYER_NIP },
      ksef_status: 'draft', ksef_number: null,
    });
    expect(data.items).toEqual([expect.objectContaining({
      position: 1, name: 'Usługa programistyczna', quantity: '3.0000', unit_price_net: '33.3330',
      net_amount: '100.00', vat_rate: '23', vat_amount: '23.00', gross_amount: '123.00',
    })]);
    expect(body.ksef_submission).toEqual({ requested: false, status: 'not_requested', message: null });
    expect(response.headers.get('location')).toBe(`/api/v1/invoices/${String(data.id)}`);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('idempotency-replayed')).toBeNull();

    // Wiersz dla bazy: ten sam kształt co zapis formularza, bez firmy z aplikacji.
    const call = createCalls()[0]!;
    const invoice = call.body!.p_invoice as Row;
    expect(invoice).not.toHaveProperty('tenant_id');
    expect(invoice).toMatchObject({ ksef_status: 'draft', direction: 'outgoing', seller_nip: NIP_A, buyer_nip: BUYER_NIP, currency: 'PLN', invoice_type: 'VAT' });
    expect((invoice.fa3_data as Row).seller).toMatchObject({ nip: NIP_A, name: 'Firma A testowa' });
    expect(call.body!.p_lines).toEqual([expect.objectContaining({ ordinal: 1, quantity: 3, unit_price_net: 33.333, net_amount: 100, vat_amount: 23, gross_amount: 123 })]);
    expect(call.body!.p_send).toBe(false);

    // Bez wysyłki: ani jednego żądania kluczem serwisowym, ani zlecenia.
    expect(serviceCalls()).toEqual([]);
    expect(fake.jobs).toEqual([]);
  });

  it('domyślne jak w formularzu: data wystawienia dziś, przelew, termin 14 dni', async () => {
    const response = await postInvoice(KEYS.writer.key, validBody({ issue_date: undefined, payment_due_date: undefined, payment_method: undefined }));
    expect(response.status).toBe(201);
    expect((await json(response)).data).toMatchObject({ issue_date: TODAY, payment_due_date: IN_14_DAYS });
  });

  it('osoba prywatna bez identyfikatora (B2C)', async () => {
    const response = await postInvoice(KEYS.writer.key, validBody({
      buyer: { type: 'consumer', name: 'Jan Kowalski', address_line1: 'ul. Domowa 3', address_line2: '00-003 Warszawa' },
    }));
    expect(response.status).toBe(201);
    const invoice = createCalls()[0]!.body!.p_invoice as Row;
    expect(invoice).toMatchObject({ is_b2c: true, buyer_id_type: 'no_id', buyer_nip: null, buyer_pesel: null });
    expect((invoice.fa3_data as Row).buyer).toMatchObject({ name: 'Jan Kowalski', noIdMarker: true });
  });
});

// ─── Idempotency-Key ────────────────────────────────────────────────────

describe('POST /api/v1/invoices: klucz idempotencji', () => {
  it('bez nagłówka Idempotency-Key: 400 missing_idempotency_key, bez zapisu', async () => {
    const response = await postInvoice(KEYS.writer.key, validBody(), { idem: null });
    expect(response.status).toBe(400);
    expect(errorOf(await json(response)).code).toBe('missing_idempotency_key');
    expect(invoiceRpcCalls()).toEqual([]);
  });

  it.each([
    ['ze spacją', 'zam 1'],
    ['za długi', 'z'.repeat(256)],
    ['z polskim znakiem', 'zamówienie-1'],
  ])('zły klucz idempotencji (%s): 400 invalid_idempotency_key', async (_name, idem) => {
    const response = await postInvoice(KEYS.writer.key, validBody(), { idem });
    expect(response.status).toBe(400);
    expect(errorOf(await json(response)).code).toBe('invalid_idempotency_key');
    expect(invoiceRpcCalls()).toEqual([]);
  });

  it('ten sam klucz i ta sama treść: ta sama faktura (201, Idempotency-Replayed), jeden zapis', async () => {
    const first = await postInvoice(KEYS.writer.key, validBody());
    const firstBody = await json(first);
    // Inna kolejność pól i odstępy: ta sama treść.
    const reordered = JSON.stringify(Object.fromEntries(Object.entries(validBody()).reverse()), null, 2);
    const second = await postInvoice(KEYS.writer.key, null, { raw: reordered });
    const secondBody = await json(second);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers.get('idempotency-replayed')).toBe('true');
    expect((secondBody.data as Row).id).toBe((firstBody.data as Row).id);
    expect(secondBody.data).toEqual(firstBody.data);
    expect(invoicesOf(TENANT_A)).toHaveLength(1);
    expect(createCalls()).toHaveLength(1);
  });

  it('ten sam klucz i inna treść: 409 idempotency_conflict, bez drugiej faktury', async () => {
    await postInvoice(KEYS.writer.key, validBody());
    const response = await postInvoice(KEYS.writer.key, validBody({ number: 'FV/API/2' }));
    expect(response.status).toBe(409);
    expect(errorOf(await json(response)).code).toBe('idempotency_conflict');
    expect(invoicesOf(TENANT_A)).toHaveLength(1);
  });

  it('odrzucona treść (422) nie zajmuje klucza: poprawione żądanie z tym kluczem tworzy fakturę', async () => {
    const rejected = await postInvoice(KEYS.writer.key, validBody({ buyer: { type: 'company', nip: '1234567890', name: 'X', address_line1: 'a', address_line2: 'b' } }));
    expect(rejected.status).toBe(422);
    const created = await postInvoice(KEYS.writer.key, validBody());
    expect(created.status).toBe(201);
    expect(created.headers.get('idempotency-replayed')).toBeNull();
  });

  it('klucze idempotencji są osobne dla każdego klucza API i każdej firmy', async () => {
    const a = await postInvoice(KEYS.writer.key, validBody());
    const aFull = await postInvoice(KEYS.full.key, validBody({ number: 'FV/API/2' }));
    const b = await postInvoice(KEYS.writerB.key, validBody());
    expect([a.status, aFull.status, b.status]).toEqual([201, 201, 201]);
    for (const response of [aFull, b]) expect(response.headers.get('idempotency-replayed')).toBeNull();
    const ids = await Promise.all([a, aFull, b].map(async (response) => ((await json(response)).data as Row).id));
    expect(new Set(ids).size).toBe(3);
    expect(invoicesOf(TENANT_A)).toHaveLength(2);
    expect(invoicesOf(TENANT_B)).toHaveLength(1);
  });
});

// ─── Walidacja ──────────────────────────────────────────────────────────

describe('POST /api/v1/invoices: walidacja (422 z polami), bez zapisu', () => {
  it.each([
    ['NIP nabywcy bez sumy kontrolnej', 'buyer.nip', { buyer: { type: 'company', nip: '1234567890', name: 'N', address_line1: 'a', address_line2: 'b' } }],
    ['ujemna ilość', 'items[0].quantity', { items: [{ name: 'U', unit: 'szt.', quantity: '-1', unit_price_net: '10', vat_rate: '23' }] }],
    ['ilość nie liczbą', 'items[0].quantity', { items: [{ name: 'U', unit: 'szt.', quantity: 'trzy', unit_price_net: '10', vat_rate: '23' }] }],
    ['cena z pięcioma miejscami', 'items[0].unit_price_net', { items: [{ name: 'U', unit: 'szt.', quantity: '1', unit_price_net: '1.00001', vat_rate: '23' }] }],
    ['nieznana stawka', 'items[0].vat_rate', { items: [{ name: 'U', unit: 'szt.', quantity: '1', unit_price_net: '1', vat_rate: '22' }] }],
    ['bez pozycji', 'items', { items: [] }],
    ['przelew bez rachunku', 'bank_account', { bank_account: undefined }],
    ['termin przed datą wystawienia', 'payment_due_date', { payment_due_date: addDaysToIsoDate(TODAY, -1) }],
    ['nieznane pole', 'discount', { discount: '10' }],
    ['data w złym formacie', 'issue_date', { issue_date: '10.11.2026' }],
  ])('%s: 422 validation_failed z polem %s', async (_name, field, overrides) => {
    const response = await postInvoice(KEYS.writer.key, validBody(overrides as Row));
    expect(response.status).toBe(422);
    const error = errorOf(await json(response));
    expect(error.code).toBe('validation_failed');
    expect(error.fields?.map((f) => f.field)).toContain(field);
    for (const f of error.fields ?? []) expect(f.message.length).toBeGreaterThan(0);
    expect(createCalls()).toEqual([]);
    expect(store.invoices.size).toBe(0);
  });

  it('send: true z datą wystawienia inną niż dziś: 422 (KSeF wystawia w dniu wysyłki), bez zapisu', async () => {
    const response = await postInvoice(KEYS.writer.key, validBody({ issue_date: addDaysToIsoDate(TODAY, 1), send: true }));
    expect(response.status).toBe(422);
    const error = errorOf(await json(response));
    expect(error.code).toBe('validation_failed');
    expect(error.fields?.map((f) => f.field)).toContain('issue_date');
    expect(createCalls()).toEqual([]);
  });

  it('stawka „zw” bez podstawy zwolnienia w ustawieniach firmy: 422 (validateInvoice), bez zapisu', async () => {
    const response = await postInvoice(KEYS.writer.key, validBody({
      items: [{ name: 'Szkolenie', unit: 'usł.', quantity: '1', unit_price_net: '100', vat_rate: 'zw' }],
    }));
    expect(response.status).toBe(422);
    const error = errorOf(await json(response));
    expect(error.code).toBe('validation_failed');
    expect(error.message).toMatch(/zwolnienia/);
    expect(createCalls()).toEqual([]);
  });

  it.each([
    ['korekta', 'unsupported_invoice_kind', { kind: 'correction' }],
    ['faktura do korekty', 'unsupported_invoice_kind', { corrected_invoice_id: 'a1a1a1a1-0000-4000-8000-000000000001' }],
    ['zaliczka', 'unsupported_invoice_kind', { kind: 'advance' }],
    ['waluta EUR', 'unsupported_currency', { currency: 'EUR' }],
    ['firma z UE', 'unsupported_buyer', { buyer: { type: 'eu_company', vat_ue: 'DE123456789', name: 'GmbH', address_line1: 'a', address_line2: 'b' } }],
    ['osoba z PESEL', 'unsupported_buyer', { buyer: { type: 'consumer', pesel: '00000000000', name: 'Jan', address_line1: 'a', address_line2: 'b' } }],
  ])('%s: 422 %s z opisem, bez zapisu', async (_name, code, overrides) => {
    const response = await postInvoice(KEYS.writer.key, validBody(overrides as Row));
    expect(response.status).toBe(422);
    const error = errorOf(await json(response));
    expect(error.code).toBe(code);
    expect(error.message.length).toBeGreaterThan(20);
    expect(createCalls()).toEqual([]);
  });

  it('treść nie JSON: 400 invalid_json; inny Content-Type: 415', async () => {
    const broken = await postInvoice(KEYS.writer.key, null, { raw: '{"number": ' });
    expect(broken.status).toBe(400);
    expect(errorOf(await json(broken)).code).toBe('invalid_json');
    const form = await postInvoice(KEYS.writer.key, validBody(), { headers: { 'content-type': 'text/plain' } });
    expect(form.status).toBe(415);
    expect(errorOf(await json(form)).code).toBe('unsupported_media_type');
    expect(createCalls()).toEqual([]);
  });
});

// ─── Izolacja firm ──────────────────────────────────────────────────────

describe('POST /api/v1/invoices: izolacja firm', () => {
  it('klucz firmy B wystawia fakturę firmy B: sprzedawca B, dane B; faktury A bez zmian', async () => {
    seedInvoice(TENANT_A, { internal_number: 'FV/A/1' });
    const response = await postInvoice(KEYS.writerB.key, validBody());
    expect(response.status).toBe(201);
    const data = (await json(response)).data as Row;
    expect(data.seller).toEqual({ name: 'Firma B testowa', nip: NIP_B });
    const created = store.invoices.get(String(data.id))!;
    expect(created.row.tenant_id).toBe(TENANT_B);
    expect(invoicesOf(TENANT_A)).toHaveLength(0);
    // Odczyt danych firmy szedł tokenem klucza B (RLS), z jego firmą w filtrze.
    const tenantReads = recorded.filter((r) => r.path === '/rest/v1/tenants');
    expect(tenantReads.length).toBeGreaterThan(0);
    for (const read of tenantReads) expect(read.params.get('id')).toBe(`eq.${TENANT_B}`);
  });

  it('ten sam numer w dwóch firmach to dwie faktury; numer zajęty we własnej firmie: 409 number_taken', async () => {
    seedInvoice(TENANT_A, { internal_number: 'FV/API/1' });
    const b = await postInvoice(KEYS.writerB.key, validBody());
    expect(b.status).toBe(201);
    const a = await postInvoice(KEYS.writer.key, validBody());
    expect(a.status).toBe(409);
    expect(errorOf(await json(a)).code).toBe('number_taken');
    expect(invoicesOf(TENANT_A)).toHaveLength(0);
  });
});

// ─── Numeracja ──────────────────────────────────────────────────────────

describe('POST /api/v1/invoices: numeracja jak w formularzu', () => {
  const MM = TODAY.slice(5, 7);
  const YYYY = TODAY.slice(0, 4);

  it('bez numeru: kolejny po ostatniej fakturze firmy (podpowiedź formularza), zajęty numer pominięty', async () => {
    seedInvoice(TENANT_A, { internal_number: `FV/7/${MM}/${YYYY}` });
    seedInvoice(TENANT_A, { internal_number: `FV/8/${MM}/${YYYY}`, direction: 'incoming', invoice_kind: 'regular', origin: 'ksef_inbox', issue_date: '2026-01-01' });
    const response = await postInvoice(KEYS.writer.key, validBody({ number: undefined }));
    expect(response.status).toBe(201);
    expect(((await json(response)).data as Row).number).toBe(`FV/9/${MM}/${YYYY}`);
  });

  it('wyścig: numer zajęty tuż przed zapisem, więc API bierze następny', async () => {
    seedInvoice(TENANT_A, { internal_number: `FV/7/${MM}/${YYYY}` });
    store.beforeCreate = (invoice) => {
      store.beforeCreate = null;
      seedInvoice(TENANT_A, { internal_number: invoice.internal_number });
    };
    const response = await postInvoice(KEYS.writer.key, validBody({ number: undefined }));
    expect(response.status).toBe(201);
    expect(((await json(response)).data as Row).number).toBe(`FV/9/${MM}/${YYYY}`);
    expect(createCalls()).toHaveLength(2);
  });

  it('firma bez faktur i bez numeru w żądaniu: 422 number_required', async () => {
    const response = await postInvoice(KEYS.writerB.key, validBody({ number: undefined }));
    expect(response.status).toBe(422);
    expect(errorOf(await json(response)).code).toBe('number_required');
    expect(createCalls()).toEqual([]);
  });

  it('kandydaci API to ta sama seria co podpowiedź formularza', () => {
    const last = { number: `FV/7/${MM}/${YYYY}`, issueDate: TODAY };
    const candidates = nextInvoiceNumberCandidates(last, TODAY);
    expect(candidates[0]).toBe(suggestNextInvoiceNumber(last, TODAY));
    expect(candidates).toHaveLength(5);
    expect(candidates.at(-1)).toBe(`FV/12/${MM}/${YYYY}`);
  });
});

// ─── Wysyłka do KSeF ────────────────────────────────────────────────────

describe('POST /api/v1/invoices: send: true kolejkuje wysyłkę raz', () => {
  const sendBody = () => validBody({ send: true });

  it('send: true: jedno zlecenie przez enqueue_ksef_send w transakcji, faktura queued', async () => {
    const response = await postInvoice(KEYS.writer.key, sendBody());
    expect(response.status).toBe(201);
    const body = await json(response);
    const data = body.data as Row;
    expect(body.ksef_submission).toEqual({ requested: true, status: 'queued', message: null });
    expect(data.ksef_status).toBe('queued');
    expect(fake.jobs).toHaveLength(1);
    expect(fake.jobs[0]).toMatchObject({
      queue: 'invoice.submit.requested',
      data: { tenantId: TENANT_A, invoiceId: data.id, nip: NIP_A, environment: 'test' },
      options: expect.objectContaining({ singletonKey: data.id, group: { id: TENANT_A } }),
    });
    expect((fake.jobs[0]!.data.invoice as Row).internalNumber).toBe('FV/API/1');
    expect(store.invoices.get(String(data.id))!.row.ksef_status).toBe('queued');
    // Autor zlecenia: klucz API, nie użytkownik.
    expect(store.audit).toContainEqual(expect.objectContaining({
      action: 'invoice.submit_requested', user_id: null, entity_id: data.id,
      metadata: expect.objectContaining({ source: 'api_v1', api_key_id: KEYS.writer.id, mode: 'online_queued' }),
    }));
    // Klucz serwisowy tylko w ścieżce wysyłki: certyfikat KSeF i dziennik.
    for (const call of serviceCalls()) {
      expect(`${call.method} ${call.path}`).toMatch(/^(GET \/rest\/v1\/tenants|POST \/rest\/v1\/audit_logs|POST \/rest\/v1\/ksef_send_attempts)$/);
    }
  });

  it('ponowienie z tym samym kluczem nie dubluje zlecenia', async () => {
    const first = await postInvoice(KEYS.writer.key, sendBody());
    const second = await postInvoice(KEYS.writer.key, sendBody());
    const third = await postInvoice(KEYS.writer.key, sendBody());
    expect([first.status, second.status, third.status]).toEqual([201, 201, 201]);
    const replay = await json(second);
    expect(second.headers.get('idempotency-replayed')).toBe('true');
    expect(replay.ksef_submission).toMatchObject({ requested: true, status: 'already_requested' });
    expect((replay.data as Row).ksef_status).toBe('queued');
    expect(fake.jobs).toHaveLength(1);
    expect(invoicesOf(TENANT_A)).toHaveLength(1);
  });

  it('wysyłka wstrzymana: szkic zostaje (201, refused); ponowienie po zdjęciu wstrzymania wysyła raz', async () => {
    fake.flags.killAllKsefSubmissions = true;
    const refused = await postInvoice(KEYS.writer.key, sendBody());
    expect(refused.status).toBe(201);
    const refusedBody = await json(refused);
    expect(refusedBody.ksef_submission).toMatchObject({ requested: true, status: 'refused' });
    expect(String((refusedBody.ksef_submission as Row).message).length).toBeGreaterThan(10);
    expect((refusedBody.data as Row).ksef_status).toBe('draft');
    expect(fake.jobs).toEqual([]);
    expect(store.attempts).toContainEqual(expect.objectContaining({ status: 'refused', error_code: 'KSEF_PAUSED', user_id: null }));

    fake.flags.killAllKsefSubmissions = false;
    const retried = await postInvoice(KEYS.writer.key, sendBody());
    expect(retried.status).toBe(201);
    expect((await json(retried)).ksef_submission).toMatchObject({ status: 'queued' });
    await postInvoice(KEYS.writer.key, sendBody());
    expect(fake.jobs).toHaveLength(1);
    expect(invoicesOf(TENANT_A)).toHaveLength(1);
  });

  it('szkic zmieniony w FaktWay po utworzeniu: ponowienie go nie wysyła', async () => {
    fake.flags.killAllKsefSubmissions = true;
    const first = await postInvoice(KEYS.writer.key, sendBody());
    const id = String(((await json(first)).data as Row).id);
    fake.flags.killAllKsefSubmissions = false;
    store.invoices.get(id)!.row.updated_at = tick();

    const retried = await postInvoice(KEYS.writer.key, sendBody());
    expect(retried.status).toBe(201);
    expect((await json(retried)).ksef_submission).toMatchObject({ requested: true, status: 'refused' });
    expect(fake.jobs).toEqual([]);
  });

  it('FaktWay wymaga 2FA przy wysyłce (requireMfaForSensitive): klucz API nie wysyła, szkic zostaje', async () => {
    fake.flags.requireMfaForSensitive = true;
    const response = await postInvoice(KEYS.writer.key, sendBody());
    expect(response.status).toBe(201);
    const body = await json(response);
    expect(body.ksef_submission).toMatchObject({ requested: true, status: 'refused' });
    expect(String((body.ksef_submission as Row).message)).toMatch(/dwuetapow/);
    expect(fake.jobs).toEqual([]);
  });

  it('firma bez zweryfikowanego KSeF: odmowa wysyłki z opisem, szkic zostaje', async () => {
    const original = TENANTS[TENANT_A]!.ksef_verified_at;
    TENANTS[TENANT_A]!.ksef_verified_at = null;
    try {
      const response = await postInvoice(KEYS.writer.key, sendBody());
      expect(response.status).toBe(201);
      expect((await json(response)).ksef_submission).toMatchObject({ requested: true, status: 'refused' });
      expect(fake.jobs).toEqual([]);
    } finally {
      TENANTS[TENANT_A]!.ksef_verified_at = original;
    }
  });
});

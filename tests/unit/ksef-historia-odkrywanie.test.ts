import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';

import { historyClient, historyDb, itemRow, streamRow, type HistoryDb, type Row } from './helpers/historia-ksef-baza';

/**
 * Odkrywanie w synchronizacji historii KSeF (decyzja Bartosza 22.10.2026):
 * klasyfikacja strony KSeF do dziennika, zapis strony PRZED ruchem kursora,
 * wybór strumienia (round-robin), limit dziennika i mapowanie błędów KSeF
 * na stan firmy (429, 401, 403, poświadczenia, wygasły certyfikat).
 */

const m = vi.hoisted(() => ({
  db: null as unknown,
  fetch: vi.fn(),
  getSession: vi.fn(),
  invalidate: vi.fn(),
  credentials: vi.fn(),
  audit: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => m.db }));
vi.mock('@/lib/supabase/server', () => ({ createAdminClient: () => m.db }));
vi.mock('@/lib/ksef/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ksef/client')>()),
  ksefFetch: m.fetch,
}));
vi.mock('@/lib/ksef/session-cache', () => ({ ksefSessionCache: { getSession: m.getSession, invalidate: m.invalidate } }));
vi.mock('@/lib/ksef/rate-limiter', () => ({ ksefRateLimiter: { enqueue: (_nip: string, fn: () => unknown) => fn() } }));
vi.mock('@/lib/supabase/admin-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/supabase/admin-queries')>()),
  getTenantKsefCredentials: m.credentials,
}));
vi.mock('@/lib/audit/log-system', () => ({ logAuditSystem: m.audit }));
vi.mock('@sentry/nextjs', () => ({ captureException: m.captureException, captureMessage: m.captureMessage }));

import { KsefApiError } from '@/lib/ksef/client';
import { classifyDiscovered } from '@/lib/ksef/history-sync/classify';
import { MAX_ITEMS_PER_STREAM } from '@/lib/ksef/history-sync/constants';
import { classifyHistoryError, rateLimitPauseMs } from '@/lib/ksef/history-sync/errors';
import { runKsefHistorySyncTenant } from '@/lib/jobs/runners/ksef-history-sync';
import { KsefCredentialsError } from '@/lib/supabase/admin-queries';
import type { InvoiceMetadata } from '@/types/ksef';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NIP = '1234567890';
const DAY_NOW = new Date('2026-10-22T10:00:00.000Z'); // 12:00 w Warszawie — budżet dzienny
const NIGHT_NOW = new Date('2026-10-22T21:00:00.000Z'); // 23:00 — budżet nocny
const event = { tenantId: TENANT, nip: NIP, environment: 'test' as const };

let db: HistoryDb;

const ctx: JobContext = {
  attempt: 0,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  step: { run: async (_n, fn) => fn(), sleep: vi.fn(async () => undefined), sendEvent: vi.fn(), scheduleAfter: vi.fn() },
};

function meta(n: number, patch: Partial<InvoiceMetadata> = {}): InvoiceMetadata {
  return {
    ksefNumber: `${NIP}-20260910-${String(n).padStart(12, '0')}-01`,
    invoiceNumber: `FV/${n}/09/2026`,
    issueDate: '2026-09-10',
    invoicingDate: '2026-09-10T10:00:00Z',
    acquisitionDate: '2026-09-10T10:00:01Z',
    permanentStorageDate: `2026-09-10T10:${String(n).padStart(2, '0')}:00Z`,
    invoicingMode: 'Online',
    invoiceType: 'Vat',
    seller: { nip: NIP, name: 'Sprzedawca' },
    buyer: { identifier: { type: 'Nip', value: '1111111111' }, name: 'Nabywca' },
    netAmount: 100, grossAmount: 123, vatAmount: 23, currency: 'PLN',
    invoiceHash: Buffer.alloc(32, n).toString('base64'),
    formCode: { systemCode: 'FA (3)', schemaVersion: '1-0E', value: 'FA' },
    isSelfInvoicing: false, hasAttachment: false,
    ...patch,
  };
}

function tenant(patch: Row = {}): Row {
  return {
    id: TENANT, nip: NIP, ksef_verified_at: '2026-09-01T00:00:00Z', ksef_verified_environment: 'test',
    ksef_certificate_expiry: '2099-01-01T00:00:00Z', deleted_at: null, is_active: true, has_ksef_credentials: true,
    business_started_on: null, ...patch,
  };
}

const outgoing = (patch: Row = {}) => streamRow({ tenant_id: TENANT, direction: 'outgoing', ...patch });
const incoming = (patch: Row = {}) => streamRow({
  tenant_id: TENANT, direction: 'incoming', live_hwm: null, boundary_at: '2026-10-21T00:00:00.000Z',
  backfill_window_end: '2026-10-21T00:00:00.000Z', backfill_cursor: '2026-07-23T00:00:00.000Z', ...patch,
});
const rows = (table: string) => db.tables[table] ?? [];
const stream = (direction: 'outgoing' | 'incoming') => rows('ksef_history_sync').find((s) => s.direction === direction)!;
const subjectsAsked = () => m.fetch.mock.calls
  .filter(([path]) => String(path).startsWith('/invoices/query/metadata'))
  .map(([, init]) => (init as { body: { subjectType: string } }).body.subjectType);

function setNow(now: Date) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  // Skrzynka na bieżąco (HWM 10 min temu) — historia nie ustępuje.
  if (db) db.tables.ksef_inbox_cursor = [{ tenant_id: TENANT, window_to: new Date(now.getTime() - 10 * 60_000).toISOString() }];
}

beforeEach(() => {
  vi.clearAllMocks();
  setNow(DAY_NOW);
  db = historyDb({
    tenants: [tenant()],
    // Bieżąca sprzedaż sprawdzona przed chwilą — przebieg idzie w zaległość.
    ksef_history_sync: [outgoing({ live_checked_at: '2026-10-22T09:55:00.000Z' })],
    ksef_history_items: [],
    invoices: [],
    ksef_inbox_cursor: [{ tenant_id: TENANT, window_to: '2026-10-22T09:50:00.000Z' }],
  });
  m.db = historyClient(db);
  m.credentials.mockResolvedValue({ type: 'token', nip: NIP, token: 'token-testowy' });
  m.getSession.mockResolvedValue({ accessToken: 'sesja-testowa' });
  m.fetch.mockResolvedValue({ invoices: [], hasMore: false, isTruncated: false, permanentStorageHwmDate: '2026-10-22T09:00:00Z' });
});

afterEach(() => vi.useRealTimers());

describe('classifyDiscovered — strona KSeF → dziennik', () => {
  const ctxFor = (direction: 'outgoing' | 'incoming' = 'outgoing') => ({
    admin: historyClient(db) as never, tenantId: TENANT, environment: 'test' as const, direction, streamId: 'strumien-1',
  });
  const local = (n: number, patch: Row = {}): Row => ({
    id: `inv-${n}`, tenant_id: TENANT, direction: 'outgoing', ksef_number: meta(n).ksefNumber,
    // Faktura z numerem KSeF jest przyjęta (ZAP-01: `already_present` tylko z posiadaczem w księgach).
    ksef_status: 'accepted', ksef_environment: 'test', origin: 'app', xml_storage_path: 'x.xml', fa3_data: { annotations: {} }, ...patch,
  });

  it('każdy wiersz tabeli klasyfikacji', async () => {
    db.tables.invoices = [
      local(1, { origin: 'app' }),
      local(2, { id: 'inv-2a' }), local(2, { id: 'inv-2b', origin: 'ksef_import' }),
      local(3, { ksef_environment: 'production', origin: 'ksef_import' }),
      local(4, { origin: 'ksef_import', xml_storage_path: null }),
      local(5, { origin: 'ksef_import', fa3_data: {} }),
      local(6, { origin: 'ksef_import', ksef_environment: null }),
      local(7, { origin: 'ksef_import', fa3_data: { annotations: {}, import: { importJobId: 'strumien-1' } } }),
      local(8, { origin: 'ksef_import', fa3_data: { annotations: {}, import: { importJobId: 'magiczny-import' } } }),
      local(9, { origin: 'file_import' }),
      // Zapis tego strumienia bez wiersza `xml_documents` (nieudany zapis oryginału).
      local(12, { origin: 'ksef_import', fa3_data: { annotations: {}, import: { importJobId: 'strumien-1' } } }),
    ];
    // Pełny zapis inv-7 (pozycje i `xml_documents`); inv-12 ma tylko pozycję.
    db.tables.invoice_line_items = [{ id: 'l-7', invoice_id: 'inv-7' }, { id: 'l-12', invoice_id: 'inv-12' }];
    db.tables.xml_documents = [{ id: 'x-7', tenant_id: TENANT, invoice_id: 'inv-7' }];
    const page = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => meta(n))
      .concat([meta(10, { currency: 'EUR' }), meta(11), meta(12)]);
    const out = await classifyDiscovered(ctxFor(), page, DAY_NOW);
    const byNumber = new Map(out.map((r) => [r.ksef_number, r]));
    const at = (n: number) => byNumber.get(meta(n).ksefNumber);

    expect(at(1)).toBeUndefined(); // faktura FaktWay — bez wiersza
    expect(at(2)).toMatchObject({ status: 'blocked', reason_code: 'local_conflict' });
    expect(at(3)).toMatchObject({ status: 'blocked', reason_code: 'local_conflict' });
    expect(at(4)).toMatchObject({ status: 'pending', reason_code: 'repair_content', invoice_id: 'inv-4' });
    expect(at(5)).toMatchObject({ status: 'pending', reason_code: 'repair_content', invoice_id: 'inv-5' });
    expect(at(6)).toMatchObject({ status: 'skipped', reason_code: 'already_present', invoice_id: 'inv-6' });
    expect(at(7)).toMatchObject({ status: 'imported', reason_code: null, invoice_id: 'inv-7' });
    // Samo pochodzenie nie dowodzi pełnego zapisu — do uzupełnienia przez silnik.
    expect(at(12)).toMatchObject({ status: 'pending', reason_code: null, invoice_id: 'inv-12', resolved_at: null });
    expect(at(8)).toMatchObject({ status: 'skipped', reason_code: 'already_present' });
    expect(at(9)).toMatchObject({ status: 'skipped', reason_code: 'already_present' });
    expect(at(10)).toMatchObject({ status: 'blocked', reason_code: 'currency_not_supported', invoice_id: null });
    expect(at(11)).toMatchObject({
      status: 'pending', reason_code: null, invoice_id: null, resolved_at: null,
      counterparty_nip: '1111111111', counterparty_name: 'Nabywca', gross_amount: 123, currency: 'PLN',
      acquisition_at: '2026-09-10T10:00:01Z', permanent_storage_at: '2026-09-10T10:11:00Z',
    });
    // Rozstrzygnięte mają datę rozstrzygnięcia; nic nie znika po cichu.
    expect(out.filter((r) => r.status !== 'pending').every((r) => r.resolved_at === DAY_NOW.toISOString())).toBe(true);
    expect(out).toHaveLength(11);
  });

  it('zakupy: faktura ze Skrzynki KSeF — bez wiersza; kontrahent = sprzedawca', async () => {
    db.tables.invoices = [{ ...local(1, { origin: 'ksef_inbox' }), direction: 'incoming' }];
    const out = await classifyDiscovered(ctxFor('incoming'), [meta(1), meta(2)], DAY_NOW);
    expect(out.map((r) => r.ksef_number)).toEqual([meta(2).ksefNumber]);
    expect(out[0]).toMatchObject({ direction: 'incoming', counterparty_nip: NIP, counterparty_name: 'Sprzedawca' });
  });

  it('numer KSeF spoza formatu — błąd (fail-closed), nie cichy pominięty wiersz', async () => {
    await expect(classifyDiscovered(ctxFor(), [meta(1, { ksefNumber: 'zły numer; DROP' })], DAY_NOW)).rejects.toThrow('format');
  });
});

describe('przebieg: zapis strony przed kursorem', () => {
  it('strona trafia do dziennika, potem kursor przesuwa się o stronę (CAS)', async () => {
    m.fetch.mockResolvedValueOnce({ invoices: [meta(1), meta(2)], hasMore: true, isTruncated: false, permanentStorageHwmDate: '2026-10-22T09:00:00Z' });
    await expect(runKsefHistorySyncTenant(event, ctx)).resolves.toMatchObject({ succeededCalls: 1, stopped: null });
    expect(rows('ksef_history_items').map((r) => r.ksef_number).sort()).toEqual([meta(1).ksefNumber, meta(2).ksefNumber]);
    expect(stream('outgoing')).toMatchObject({ backfill_page_offset: 1, backfill_issue: null, last_success_at: DAY_NOW.toISOString() });
    // Kolejność zapisów: dziennik przed strumieniem.
    const writes = db.log.filter((q) => q.op !== 'select').map((q) => q.table);
    expect(writes.indexOf('ksef_history_items')).toBeLessThan(writes.lastIndexOf('ksef_history_sync'));
  });

  it('błąd zapisu dziennika — kursor stoi, błąd `internal`, ponowienie zapyta o tę samą stronę', async () => {
    m.fetch.mockResolvedValueOnce({ invoices: [meta(1)], hasMore: true, isTruncated: false, permanentStorageHwmDate: '2026-10-22T09:00:00Z' });
    db.failures.add('ksef_history_items:upsert');
    await expect(runKsefHistorySyncTenant(event, ctx)).rejects.toThrow('zapis dziennika');
    expect(stream('outgoing')).toMatchObject({ backfill_page_offset: 0, last_error_code: 'internal', consecutive_failures: 1, lease_until: null });
    expect(m.captureException).toHaveBeenCalled();

    db.failures.clear();
    m.fetch.mockResolvedValueOnce({ invoices: [meta(1)], hasMore: true, isTruncated: false, permanentStorageHwmDate: '2026-10-22T09:00:00Z' });
    await runKsefHistorySyncTenant(event, ctx);
    const pageOffsets = m.fetch.mock.calls
      .filter(([path]) => String(path).startsWith('/invoices/query/metadata'))
      .map(([path]) => new URL(`https://x${String(path)}`).searchParams.get('pageOffset'));
    expect(pageOffsets).toEqual(['0', '0']);
    expect(stream('outgoing')).toMatchObject({ backfill_page_offset: 1, last_error_code: null, consecutive_failures: 0 });
  });

  it('ponowienie tej samej strony nie dubluje dziennika', async () => {
    const page = { invoices: [meta(1)], hasMore: false, isTruncated: false, permanentStorageHwmDate: null };
    m.fetch.mockResolvedValue(page);
    await runKsefHistorySyncTenant(event, ctx);
    stream('outgoing').backfill_window_end = '2026-10-01T00:00:00.000Z';
    stream('outgoing').backfill_cursor = '2026-07-03T00:00:00.000Z';
    stream('outgoing').backfill_completed_at = null;
    await runKsefHistorySyncTenant(event, ctx);
    expect(rows('ksef_history_items')).toHaveLength(1);
  });
});

describe('przebieg: wybór strumienia i limity', () => {
  it('dzień: 1 zapytanie — strumień z najdawniejszym postępem; remis — sprzedaż', async () => {
    db.tables.ksef_history_sync = [
      outgoing({ live_checked_at: '2026-10-22T09:55:00.000Z', backfill_progress_at: '2026-10-22T09:00:00.000Z' }),
      incoming({ backfill_progress_at: '2026-10-22T08:00:00.000Z' }),
    ];
    await runKsefHistorySyncTenant(event, ctx);
    expect(subjectsAsked()).toEqual(['subject2']);
  });

  it('noc: 2 zapytania — po jednym na strumień (round-robin), sprzedaż przy remisie pierwsza', async () => {
    setNow(NIGHT_NOW);
    db.tables.ksef_history_sync = [
      outgoing({ live_checked_at: '2026-10-22T20:55:00.000Z' }),
      incoming(),
    ];
    await runKsefHistorySyncTenant(event, ctx);
    expect(subjectsAsked()).toEqual(['subject1', 'subject2']);
  });

  it('bieżąca sprzedaż ma pierwszeństwo, gdy minął interwał', async () => {
    db.tables.ksef_history_sync = [outgoing({ live_checked_at: '2026-10-22T09:00:00.000Z' }), incoming()];
    const liveFrom = stream('outgoing').live_hwm;
    await runKsefHistorySyncTenant(event, ctx);
    const [, init] = m.fetch.mock.calls[0]!;
    expect((init as { body: { dateRange: { from: string } } }).body.dateRange.from).toBe(liveFrom);
    // Brak kolejnych stron i HWM — kursor bieżący do HWM (jak skrzynka).
    expect(stream('outgoing').live_hwm).toBe('2026-10-22T09:00:00Z');
    expect(subjectsAsked()).toEqual(['subject1']);
    expect(stream('outgoing').live_checked_at).toBe(DAY_NOW.toISOString());
  });

  it(`limit ${MAX_ITEMS_PER_STREAM} pozycji — bez zapytania, strumień „capacity”`, async () => {
    db.tables.ksef_history_items = Array.from({ length: MAX_ITEMS_PER_STREAM }, (_, i) => ({
      tenant_id: TENANT, environment: 'test', direction: 'outgoing', status: 'imported', ksef_number: `K-${i}`,
    }));
    await runKsefHistorySyncTenant(event, ctx);
    expect(subjectsAsked()).toEqual([]);
    expect(stream('outgoing')).toMatchObject({ backfill_issue: 'capacity' });
  });

  it('klient poprawił datę rozpoczęcia na wcześniejszą — przebieg obniża początek, otwiera zakończoną zaległość i pyta KSeF o okno pod starym początkiem', async () => {
    const oldFloor = '2025-05-31T22:00:00.000Z';
    db.tables.tenants = [tenant({ business_started_on: '2019-03-01' })];
    db.tables.ksef_history_sync = [outgoing({
      live_checked_at: '2026-10-22T09:55:00.000Z', history_floor: oldFloor, backfill_window_end: oldFloor,
      backfill_cursor: oldFloor, backfill_page_offset: 0, backfill_completed_at: '2026-10-20T00:00:00.000Z',
    })];
    await runKsefHistorySyncTenant(event, ctx);
    const query = m.fetch.mock.calls.find(([path]) => String(path).startsWith('/invoices/query/metadata'));
    expect(query?.[1]).toMatchObject({ body: { subjectType: 'subject1', dateRange: { from: '2025-03-02T22:00:00.000Z', to: oldFloor } } });
    // Okno potwierdzone przez KSeF (HWM ≥ koniec) — następne wstecz, zaległość otwarta do 2022-01-01.
    expect(stream('outgoing')).toMatchObject({
      history_floor: '2022-01-01T00:00:00.000Z', backfill_completed_at: null, backfill_window_end: '2025-03-02T22:00:00.000Z',
    });
  });

  it('wstrzymane przez klienta albo w pauzie po 429 — bez dzierżawy i bez KSeF', async () => {
    stream('outgoing').client_paused_at = '2026-10-21T00:00:00.000Z';
    await expect(runKsefHistorySyncTenant(event, ctx)).resolves.toEqual({ skipped: 'leased-or-paused' });
    stream('outgoing').client_paused_at = null;
    stream('outgoing').paused_until = '2026-10-22T11:00:00.000Z';
    await expect(runKsefHistorySyncTenant(event, ctx)).resolves.toEqual({ skipped: 'leased-or-paused' });
    expect(m.fetch).not.toHaveBeenCalled();
  });
});

describe('przebieg: błędy KSeF → stan firmy', () => {
  it.each([
    [String(2 * 3600), 2 * 3600_000],
    [String(48 * 3600), 24 * 3600_000],
    [null, 15 * 60_000],
  ])('429 (Retry-After %s s) — pauza firmy, bez zmian pozycji i bez ponowień', async (retryAfter, pauseMs) => {
    m.fetch.mockRejectedValueOnce(new KsefApiError(429, '{}', 'KSeF API POST /invoices/query/metadata failed: 429',
      retryAfter === null ? null : Number(retryAfter) * 1000));
    await expect(runKsefHistorySyncTenant(event, ctx)).resolves.toMatchObject({ stopped: 'pause' });
    expect(stream('outgoing')).toMatchObject({
      paused_until: new Date(DAY_NOW.getTime() + pauseMs).toISOString(),
      rate_limited_at: DAY_NOW.toISOString(),
      rate_limit_hits: 1,
      last_error_code: null,
      backfill_page_offset: 0,
    });
    expect(rows('ksef_history_items')).toEqual([]);
  });

  it('Retry-After krótszy niż minuta — czekamy minutę (nigdy krócej niż serwer)', () => {
    expect(rateLimitPauseMs(5_000)).toBe(60_000);
    expect(rateLimitPauseMs(90_000)).toBe(90_000);
  });

  it('403 — `permission` (klient nadaje uprawnienie)', async () => {
    m.fetch.mockRejectedValueOnce(new KsefApiError(403, JSON.stringify({ exception: { exceptionDetailList: [{ exceptionCode: 21115 }] } }),
      'KSeF API POST /invoices/query/metadata?pageOffset=0 failed: 403'));
    await expect(runKsefHistorySyncTenant(event, ctx)).resolves.toMatchObject({ stopped: 'session' });
    expect(stream('outgoing')).toMatchObject({ last_error_code: 'permission', consecutive_failures: 1 });
    expect(stream('outgoing').last_error_detail).toBe('HTTP 403 /invoices/query/metadata kody:21115');
  });

  it('401 po otwarciu sesji — unieważnia sesję i zapisuje `credentials`', async () => {
    m.fetch.mockRejectedValueOnce(new KsefApiError(401, '', 'KSeF API POST /invoices/query/metadata failed: 401'));
    await runKsefHistorySyncTenant(event, ctx);
    expect(m.invalidate).toHaveBeenCalledWith(NIP, 'test');
    expect(stream('outgoing').last_error_code).toBe('credentials');
  });

  it.each([
    ['missing', 'credentials'],
    ['not-verified', 'credentials'],
    ['decrypt', 'internal'],
    ['nip-mismatch', 'internal'],
    ['tenant-read', 'internal'],
  ] as const)('KsefCredentialsError(%s) → %s', async (reason, code) => {
    m.credentials.mockRejectedValueOnce(new KsefCredentialsError(reason, 'test'));
    await runKsefHistorySyncTenant(event, ctx);
    expect(stream('outgoing').last_error_code).toBe(code);
    expect(m.fetch).not.toHaveBeenCalled();
  });

  it('dwa błędy przejściowe w przebiegu — `ksef_unavailable`', async () => {
    setNow(NIGHT_NOW);
    db.tables.ksef_history_sync = [outgoing({ live_checked_at: '2026-10-22T20:55:00.000Z' }), incoming()];
    m.fetch.mockRejectedValue(new KsefApiError(503, '', 'KSeF API POST /invoices/query/metadata failed: 503'));
    await runKsefHistorySyncTenant(event, ctx);
    expect(stream('outgoing')).toMatchObject({ last_error_code: 'ksef_unavailable' });
  });

  it('wygasły certyfikat — zapis `certificate_expired`, bez dzierżawy i bez KSeF', async () => {
    db.tables.tenants = [tenant({ ksef_certificate_expiry: '2026-10-01T00:00:00Z' })];
    await expect(runKsefHistorySyncTenant(event, ctx)).resolves.toEqual({ skipped: 'tenant-state' });
    expect(stream('outgoing')).toMatchObject({ last_error_code: 'certificate_expired', lease_until: null });
    expect(m.credentials).not.toHaveBeenCalled();
  });

  it('mapowanie: odrzucone uwierzytelnienie przy wygasłym certyfikacie = `certificate_expired`', () => {
    const now = DAY_NOW;
    const auth400 = new KsefApiError(400, '', 'KSeF API POST /auth/xades-signature failed: 400');
    expect(classifyHistoryError(auth400, { phase: 'session', certificateExpiry: '2026-10-01T00:00:00Z', now }))
      .toMatchObject({ kind: 'session', code: 'certificate_expired' });
    expect(classifyHistoryError(auth400, { phase: 'session', certificateExpiry: '2099-01-01T00:00:00Z', now }))
      .toMatchObject({ kind: 'session', code: 'credentials' });
    expect(classifyHistoryError(new Error('KSeF auth failed: Nieprawidłowy podpis'), { phase: 'session', certificateExpiry: null, now }))
      .toMatchObject({ kind: 'session', code: 'credentials' });
    // 400 przy metadanych = nasze zapytanie jest złe — operator.
    expect(classifyHistoryError(new KsefApiError(400, '', 'KSeF API POST /invoices/query/metadata failed: 400'),
      { phase: 'metadata', certificateExpiry: null, now })).toMatchObject({ kind: 'session', code: 'internal' });
    // Błąd naszego kodu — nieoczekiwany (null), wywołujący zapisze `internal` i rzuci.
    expect(classifyHistoryError(new TypeError('x is undefined'), { phase: 'metadata', certificateExpiry: null, now })).toBeNull();
    // Sieć bez statusu HTTP — przejściowy.
    expect(classifyHistoryError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }),
      { phase: 'metadata', certificateExpiry: null, now })).toMatchObject({ kind: 'transient' });
  });
});

describe('przebieg: firma i dzierżawa', () => {
  it('dzierżawa zwolniona po przebiegu; druga równoległa dzierżawa nie przechodzi', async () => {
    await runKsefHistorySyncTenant(event, ctx);
    expect(stream('outgoing').lease_until).toBeNull();
    expect(stream('outgoing').last_run_at).toBe(DAY_NOW.toISOString());

    stream('outgoing').lease_until = '2026-10-22T10:05:00.000Z';
    await expect(runKsefHistorySyncTenant(event, ctx)).resolves.toEqual({ skipped: 'leased-or-paused' });
  });

  it('równoległy zapis crona (`mark-enqueued` podbija `updated_at`) nie odbiera dzierżawy — warunek to stan dzierżawy i pauz, nie `updated_at`', async () => {
    const base = historyClient(db);
    let bumped = false;
    // Pierwsze zapytanie przebiegu o wiersz sprzedaży: zaraz po nim cron zapisuje
    // `last_enqueued_at`, a wyzwalacz `set_updated_at` (00155) podbija `updated_at`.
    m.db = {
      ...base,
      from(table: string) {
        const q = base.from(table);
        if (table !== 'ksef_history_sync' || bumped) return q;
        const once = q.maybeSingle;
        q.maybeSingle = async () => {
          const res = await once();
          bumped = true;
          const row = stream('outgoing');
          row.last_enqueued_at = DAY_NOW.toISOString();
          row.updated_at = new Date(Date.parse(String(row.updated_at)) + 1_000).toISOString();
          return res;
        };
        return q;
      },
    };
    await expect(runKsefHistorySyncTenant(event, ctx)).resolves.not.toEqual({ skipped: 'leased-or-paused' });
    expect(bumped).toBe(true);
    expect(stream('outgoing').last_run_at).toBe(DAY_NOW.toISOString());
  });

  it('dzierżawa: pauza klienta ustawiona tuż przed zapisem dzierżawy jest respektowana (warunek w samym UPDATE)', async () => {
    const base = historyClient(db);
    m.db = {
      ...base,
      from(table: string) {
        const q = base.from(table);
        if (table === 'ksef_history_sync') stream('outgoing').client_paused_at = '2026-10-22T09:59:59.000Z';
        return q;
      },
    };
    await expect(runKsefHistorySyncTenant(event, ctx)).resolves.toEqual({ skipped: 'leased-or-paused' });
    expect(stream('outgoing').lease_until).toBeNull();
    expect(m.fetch).not.toHaveBeenCalled();
  });

  it('wysyłka w toku — ustępuje bez wywołań KSeF', async () => {
    db.tables.invoices = [{ tenant_id: TENANT, direction: 'outgoing', ksef_status: 'sending' }];
    await expect(runKsefHistorySyncTenant(event, ctx)).resolves.toEqual({ yielded: ['wysyłka w toku'] });
    expect(m.fetch).not.toHaveBeenCalled();
    expect(m.credentials).not.toHaveBeenCalled();
  });

  it('pozycje dziennika bez rozstrzygnięcia — strumień zakupów bez stanu firmy (CHECK 00155)', async () => {
    db.tables.ksef_history_sync = [outgoing({ live_checked_at: '2026-10-22T09:55:00.000Z' }), incoming({ backfill_progress_at: '2026-10-21T00:00:00.000Z' })];
    db.tables.ksef_history_items = [itemRow({ tenant_id: TENANT, status: 'pending', next_attempt_at: '2026-10-23T00:00:00.000Z' })];
    m.fetch.mockRejectedValueOnce(new KsefApiError(429, '{}', 'KSeF API POST /invoices/query/metadata failed: 429', 60_000));
    await runKsefHistorySyncTenant(event, ctx);
    const incomingRow = stream('incoming');
    for (const key of ['paused_until', 'rate_limited_at', 'client_paused_at', 'lease_until', 'last_enqueued_at', 'last_error_code']) {
      expect(incomingRow[key], key).toBeNull();
    }
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';

import { historyClient, historyDb, streamRow, type HistoryDb, type Row } from './helpers/historia-ksef-baza';

/**
 * L1a (plan „zero zgubionych faktur”, 08.11.2026): skrzynka i historia KSeF
 * w pauzie firmy po 429.
 *
 * Do tej zmiany:
 *   - archiwum XML skrzynki logowało się POZA kolejką firmy (`getValidSession`),
 *     które zamieniało każdy błąd, także 429, w „Brak aktywnej sesji KSeF”:
 *     wynik `error` i zgłoszenie do Sentry przy każdej fakturze w pauzie;
 *   - cron `inbox-backfill` emitował zdarzenie co 15 min także dla firm w pauzie
 *     i za każdym razem zużywał próbę: pauza dłuższa niż ok. 75–90 min
 *     wyczerpywała `INBOX_BACKFILL_MAX_ATTEMPTS` i faktura zostawała bez XML
 *     na stałe;
 *   - log pauzy historii nie mówił, czy KSeF odpowiedział 429, czy żądanie
 *     w ogóle nie wyszło (lokalna pauza firmy).
 *
 * Atrapa KSeF to `fetch` (prawdziwy `ksefFetch`, kolejka per NIP, pamięć sesji,
 * logowanie tokenem — pamięć sesji pusta, więc pierwsze żądanie firmy to
 * `POST /auth/challenge`). Baza w pamięci (`historia-ksef-baza`), poświadczenia
 * z atrapy odczytu bazy, pliki (MinIO) i klasyfikator kosztów (AI) z atrap.
 * Zegar sztuczny (tylko `Date`).
 */

const NIP_A = '1234567890';
const NIP_B = '1234567891';
const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const INV_A = '11111111-1111-4111-8111-111111111111';
const INV_B = '22222222-2222-4222-8222-222222222222';
const T0 = new Date('2026-11-09T09:00:00.000Z');
const MIN = 60_000;

const m = vi.hoisted(() => ({
  db: null as unknown,
  credentials: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  waitingSql: vi.fn(),
  archive: vi.fn(),
  record: vi.fn(),
}));

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => m.db }));
vi.mock('@/lib/supabase/server', () => ({ createAdminClient: () => m.db }));
vi.mock('@/lib/supabase/admin-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/supabase/admin-queries')>()),
  getTenantKsefCredentials: m.credentials,
}));
// pg-boss (odczyt czekających zadań w `inbox-backfill`).
vi.mock('@/lib/jobs/boss', () => ({
  startBoss: async () => ({ getDb: () => ({ executeSql: m.waitingSql }) }),
}));
// Magazyn plików (MinIO) i wiersz `xml_documents`.
vi.mock('@/lib/import/ksef-xml-archive', () => ({ archiveImportedKsefXml: m.archive }));
vi.mock('@/lib/storage/xml-documents', () => ({ recordXmlDocument: m.record }));
// Klasyfikator kosztów (reguły + AI).
vi.mock('@/lib/categorization', () => ({
  categorizeExpense: async () => ({ kpir_column: 'col_13', category_label: 'Usługi', method: 'rule', confidence: 0.95 }),
}));
vi.mock('@/lib/audit/log-system', () => ({ logAuditSystem: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({
  captureException: m.captureException,
  captureMessage: m.captureMessage,
  addBreadcrumb: vi.fn(),
}));

import { runAutoCategorizeInbox } from '@/lib/jobs/runners/auto-categorize-inbox';
import { INBOX_BACKFILL_MAX_ATTEMPTS, runInboxBackfill } from '@/lib/jobs/runners/inbox-backfill';
import { runKsefHistorySyncTenant } from '@/lib/jobs/runners/ksef-history-sync';
import { archiveInboxInvoiceXml } from '@/lib/ksef/inbox-xml';
import { ksefPausedUntil } from '@/lib/ksef/rate-limit-pause';
import { KsefCredentialsError } from '@/lib/supabase/admin-queries';

/** Atrapa KSeF: 429 z `Retry-After`, dopóki `limited`; potem 503 (byle nie 2xx — logowanie nigdy się nie udaje). */
const atrapa = { limited: true, retryAfter: '30', calls: [] as string[] };
function stubKsef() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    atrapa.calls.push(String(url));
    if (atrapa.limited) {
      return new Response('{}', { status: 429, headers: { 'content-type': 'application/json', 'retry-after': atrapa.retryAfter } });
    }
    return new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } });
  }));
}

const at = (ms: number) => vi.setSystemTime(new Date(T0.getTime() + ms));

let db: HistoryDb;

function context() {
  const sendEvent = vi.fn(async (_name: string, _events: unknown) => undefined);
  const ctx: JobContext = {
    attempt: 0,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    step: { run: async (_n, fn) => fn(), sleep: vi.fn(async () => undefined), sendEvent, scheduleAfter: vi.fn() },
  };
  return { ctx, sendEvent };
}

function tenantRow(id: string, nip: string): Row {
  return {
    id, nip, ksef_verified_at: '2026-09-01T00:00:00Z', ksef_verified_environment: 'test',
    ksef_certificate_expiry: '2099-01-01T00:00:00Z', deleted_at: null, is_active: true, has_ksef_credentials: true,
    business_started_on: null, vat_exemption_basis: null,
  };
}

/** Faktura ze skrzynki z metadanymi, bez XML, z otwartym znacznikiem K2. */
function inboxInvoice(id: string, tenantId: string, fa3: Row = {}): Row {
  return {
    id, tenant_id: tenantId, direction: 'incoming', origin: 'ksef_inbox', ksef_status: 'accepted', ksef_environment: 'test',
    ksef_number: `5260001246-20261108-${id.slice(0, 12).toUpperCase()}-00`, internal_number: 'FV 1/11/2026',
    issue_date: '2026-11-08', seller_data: { name: 'Dostawca', nip: '5260001246' }, seller_nip: '5260001246',
    gross_total: 123, net_total: 100, vat_total: 23, currency: 'PLN', xml_storage_path: null,
    created_at: '2026-11-08T08:00:00.000Z',
    fa3_data: { _source: 'inbox-metadata', _pendingFullFetch: true, ...fa3 },
  };
}

const invoice = (id: string) => db.tables.invoices!.find((r) => r.id === id)!;
const fa3 = (id: string) => invoice(id).fa3_data as Row;
const archiveA = () => archiveInboxInvoiceXml({ tenantId: TENANT_A, invoiceId: INV_A, environment: 'test' });

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  vi.stubEnv('KSEF_ENV', 'test');
  atrapa.limited = true;
  atrapa.retryAfter = '30';
  atrapa.calls = [];
  stubKsef();
  db = historyDb({
    tenants: [tenantRow(TENANT_A, NIP_A), tenantRow(TENANT_B, NIP_B)],
    invoices: [inboxInvoice(INV_A, TENANT_A), inboxInvoice(INV_B, TENANT_B)],
    memberships: [{ organization_id: TENANT_A, user_id: USER, role: 'owner', status: 'active' }],
    expenses: [],
  });
  m.db = historyClient(db);
  m.credentials.mockImplementation(async (tenantId: string) =>
    ({ type: 'token', nip: tenantId === TENANT_B ? NIP_B : NIP_A, token: 'token-testowy' }));
  m.waitingSql.mockResolvedValue({ rows: [] });
  m.archive.mockResolvedValue({ storagePath: 'x.xml', sha256Hash: 'a'.repeat(64), sizeBytes: 10 });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('archiwum XML skrzynki w pauzie firmy', () => {
  it('429 przy logowaniu: wynik `rate_limited` bez Sentry; w pauzie bez żadnego żądania do KSeF; znacznik zostaje', async () => {
    await expect(archiveA()).resolves.toEqual({ archived: false, reason: 'rate_limited' });
    expect(atrapa.calls).toHaveLength(1);
    expect(atrapa.calls[0]).toContain('/auth/challenge');
    // Pauza firmy zapisana przez `ksefFetch` (pełny Retry-After: 30 s).
    await expect(ksefPausedUntil('test', NIP_A)).resolves.toBe(T0.getTime() + 30_000);

    at(10_000);
    await expect(archiveA()).resolves.toEqual({ archived: false, reason: 'rate_limited' });
    expect(atrapa.calls).toHaveLength(1);

    expect(m.captureException).not.toHaveBeenCalled();
    expect(m.archive).not.toHaveBeenCalled();
    expect(invoice(INV_A).xml_storage_path).toBeNull();
    expect(fa3(INV_A)._pendingFullFetch).toBe(true);
  });

  it('firma B nie czeka na pauzę firmy A', async () => {
    await archiveA();
    expect(atrapa.calls).toHaveLength(1);
    atrapa.limited = false;
    at(5_000);
    await archiveInboxInvoiceXml({ tenantId: TENANT_B, invoiceId: INV_B, environment: 'test' });
    expect(atrapa.calls).toHaveLength(2);
  });

  it('brak poświadczeń: jak dotąd błąd z Sentry (`Brak aktywnej sesji KSeF`), bez żądania do KSeF', async () => {
    m.credentials.mockRejectedValueOnce(new KsefCredentialsError('missing', 'brak certyfikatu'));
    await expect(archiveA()).resolves.toEqual({ archived: false, reason: 'error' });
    expect(atrapa.calls).toHaveLength(0);
    expect(m.captureException).toHaveBeenCalledOnce();
    const [error] = m.captureException.mock.calls[0]!;
    expect((error as Error).message).toBe('Brak aktywnej sesji KSeF');
    expect((error as Error).cause).toBeInstanceOf(KsefCredentialsError);
  });
});

describe('cron uzupełniający skrzynkę w pauzie firmy', () => {
  it('30 cykli w pauzie (co 15 min): bez emisji i bez zużycia próby; po pauzie emisja wraca', async () => {
    db.tables.invoices = [inboxInvoice(INV_A, TENANT_A)];
    // 429 w skrzynce z Retry-After: 8 h — dłużej niż 30 cykli crona.
    atrapa.retryAfter = String(8 * 3600);
    await archiveA();

    for (let cycle = 1; cycle <= 30; cycle += 1) {
      at(cycle * 15 * MIN);
      const { ctx, sendEvent } = context();
      await expect(runInboxBackfill(ctx)).resolves.toEqual({ scanned: 1, emitted: 0, paused: 1, exhausted: 0 });
      expect(sendEvent).not.toHaveBeenCalled();
    }
    expect(fa3(INV_A)._backfillAttempts).toBeUndefined();
    expect(fa3(INV_A)._pendingFullFetch).toBe(true);
    // Cron nie dotknął KSeF (tylko pierwsze żądanie z 429).
    expect(atrapa.calls).toHaveLength(1);

    at(8 * 3600_000 + MIN);
    const { ctx, sendEvent } = context();
    await expect(runInboxBackfill(ctx)).resolves.toEqual({ scanned: 1, emitted: 1, paused: 0, exhausted: 0 });
    expect(sendEvent).toHaveBeenCalledOnce();
    expect(fa3(INV_A)._backfillAttempts).toBe(1);
    expect(INBOX_BACKFILL_MAX_ATTEMPTS).toBeGreaterThan(1);
  });

  it('firma w pauzie nie wstrzymuje faktur innej firmy', async () => {
    atrapa.retryAfter = '3600';
    await archiveA();
    at(15 * MIN);
    const { ctx, sendEvent } = context();
    await expect(runInboxBackfill(ctx)).resolves.toEqual({ scanned: 2, emitted: 1, paused: 1, exhausted: 0 });
    const events = sendEvent.mock.calls[0]![1] as Array<{ data: Row }>;
    expect(events.map((e) => e.data.invoiceId)).toEqual([INV_B]);
    expect(fa3(INV_A)._backfillAttempts).toBeUndefined();
    expect(fa3(INV_B)._backfillAttempts).toBe(1);
  });

  it('pauza zaczęła się po emisji: kategoryzacja oddaje próbę (raz na emisję), znacznik zostaje, bez Sentry', async () => {
    db.tables.invoices = [inboxInvoice(INV_A, TENANT_A)];
    atrapa.retryAfter = '3600';
    // Cron przed pauzą: emisja i próba.
    const cron = context();
    await expect(runInboxBackfill(cron.ctx)).resolves.toMatchObject({ emitted: 1, paused: 0 });
    expect(fa3(INV_A)._backfillAttempts).toBe(1);
    const event = (cron.sendEvent.mock.calls[0]![1] as Array<{ data: { invoiceId: string; tenantId: string; environment: 'test' } }>)[0]!.data;

    // Zadanie z tej emisji trafia w 429 (pierwsze żądanie firmy) — koszt powstaje, XML czeka.
    at(MIN);
    await expect(runAutoCategorizeInbox(event, context().ctx)).resolves.toEqual({ success: true });
    expect(atrapa.calls).toHaveLength(1);
    expect(fa3(INV_A)).toMatchObject({ _pendingFullFetch: true, _backfillAttempts: 0 });
    expect(db.tables.expenses).toHaveLength(1);

    // Ponowienie od zera / dubel tego samego zadania: lokalna pauza, bez żądania
    // i bez drugiego oddania próby.
    at(2 * MIN);
    await runAutoCategorizeInbox(event, context().ctx);
    expect(atrapa.calls).toHaveLength(1);
    expect(fa3(INV_A)).toMatchObject({ _pendingFullFetch: true, _backfillAttempts: 0 });
    expect(db.tables.expenses).toHaveLength(1);
    expect(m.captureException).not.toHaveBeenCalled();
  });
});

describe('historia KSeF w pauzie firmy', () => {
  const event = { tenantId: TENANT_A, nip: NIP_A, environment: 'test' as const };

  function historySetup() {
    db.tables.invoices = [];
    db.tables.ksef_history_sync = [streamRow({
      tenant_id: TENANT_A, direction: 'outgoing', live_checked_at: new Date(T0.getTime() - 5 * MIN).toISOString(),
    })];
    db.tables.ksef_history_items = [];
    db.tables.ksef_inbox_cursor = [{ tenant_id: TENANT_A, window_to: new Date(T0.getTime() - 10 * MIN).toISOString() }];
  }
  const outgoing = () => db.tables.ksef_history_sync!.find((s) => s.direction === 'outgoing')!;
  const pauseLog = (ctx: JobContext) =>
    vi.mocked(ctx.logger.warn).mock.calls.find(([message]) => message === 'Historia KSeF: 429 — pauza firmy');

  it('firma w pauzie po 429 ze skrzynki: otwarcie sesji historii bez żądania, przebieg kończy się pauzą (`localPause` w logu)', async () => {
    await archiveA();
    expect(atrapa.calls).toHaveLength(1);
    historySetup();

    at(10_000);
    const { ctx } = context();
    await expect(runKsefHistorySyncTenant(event, ctx)).resolves.toMatchObject({ stopped: 'pause', succeededCalls: 0 });
    // Bramka z `session-cache` objęła logowanie historii — żadnego żądania.
    expect(atrapa.calls).toHaveLength(1);
    expect(outgoing().paused_until).not.toBeNull();
    expect(pauseLog(ctx)?.[1]).toMatchObject({ tenantId: TENANT_A, localPause: true });
  });

  it('429 przy otwarciu sesji historii zatrzymuje całą firmę: skrzynka potem bez żądania (`localPause: false` w logu)', async () => {
    historySetup();
    const { ctx } = context();
    await expect(runKsefHistorySyncTenant(event, ctx)).resolves.toMatchObject({ stopped: 'pause' });
    expect(atrapa.calls).toHaveLength(1);
    expect(atrapa.calls[0]).toContain('/auth/challenge');
    expect(pauseLog(ctx)?.[1]).toMatchObject({ localPause: false });
    await expect(ksefPausedUntil('test', NIP_A)).resolves.toBe(T0.getTime() + 30_000);

    at(10_000);
    db.tables.invoices = [inboxInvoice(INV_A, TENANT_A)];
    await expect(archiveA()).resolves.toEqual({ archived: false, reason: 'rate_limited' });
    expect(atrapa.calls).toHaveLength(1);
  });
});

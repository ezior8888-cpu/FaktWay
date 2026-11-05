import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';

import { historyClient, historyDb, itemRow, streamRow, type HistoryDb, type Row } from './helpers/historia-ksef-baza';

/**
 * Przetwarzanie dziennika historii KSeF (decyzja Bartosza 22.10.2026):
 * klasyfikacja tuż przed pobraniem (kroki 1, 1b, 2, 3, 4), odłożone
 * i zablokowane z ponownym sprawdzaniem, pobranie → archiwum → odczyt →
 * zgodność z metadanymi → silnik importu, liczenie prób i budżet pobrań.
 * Inwariant: faktury wysłanej przez FaktWay nie importujemy drugi raz,
 * a numeru wycofanego szkicu 440 nie przenosimy.
 */

const m = vi.hoisted(() => ({
  db: null as unknown,
  fetch: vi.fn(),
  getSession: vi.fn(),
  credentials: vi.fn(),
  audit: vi.fn(),
  archive: vi.fn(),
  parse: vi.fn(),
  engine: vi.fn(),
}));

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => m.db }));
vi.mock('@/lib/supabase/server', () => ({ createAdminClient: () => m.db }));
vi.mock('@/lib/ksef/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ksef/client')>()),
  ksefFetch: m.fetch,
}));
vi.mock('@/lib/ksef/session-cache', () => ({ ksefSessionCache: { getSession: m.getSession, invalidate: vi.fn() } }));
vi.mock('@/lib/ksef/rate-limiter', () => ({ ksefRateLimiter: { enqueue: (_nip: string, fn: () => unknown) => fn() } }));
vi.mock('@/lib/supabase/admin-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/supabase/admin-queries')>()),
  getTenantKsefCredentials: m.credentials,
}));
vi.mock('@/lib/audit/log-system', () => ({ logAuditSystem: m.audit }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('@/lib/import/ksef-xml-archive', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/import/ksef-xml-archive')>()),
  archiveImportedKsefXml: m.archive,
}));
vi.mock('@/lib/import/fa3-parser', () => ({ parseFa3Xml: m.parse }));
vi.mock('@/lib/import/import-engine', () => ({ processImportedInvoicesDetailed: m.engine }));

import { INVOICE_ORIGINS } from '@/lib/flo/functions/import-history';
import { KsefApiError } from '@/lib/ksef/client';
import { classifyDiscovered, classifyForProcessing, itemPatchFor, type ClassifyContext } from '@/lib/ksef/history-sync/classify';
import { KSEF_HISTORY_RECHECK_BLOCKED_REASONS } from '@/lib/ksef/history-sync/db';
import type { InvoiceMetadata } from '@/types/ksef';
import { KsefXmlArchiveConflictError } from '@/lib/import/ksef-xml-archive';
import { runKsefHistorySyncTenant } from '@/lib/jobs/runners/ksef-history-sync';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NIP = '1234567890';
const N = '1234567890-20260910-AAAAAAAAAAAA-01';
const DAY_NOW = new Date('2026-10-22T10:00:00.000Z');
const NIGHT_NOW = new Date('2026-10-22T21:00:00.000Z');
const event = { tenantId: TENANT, nip: NIP, environment: 'test' as const };
const HASH_B64 = Buffer.alloc(32, 7).toString('base64');
const HASH_HEX = Buffer.alloc(32, 7).toString('hex');

let db: HistoryDb;
let sleepAdvanceMs = 6_000;

const ctx: JobContext = {
  attempt: 0,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  step: {
    run: async (_n, fn) => fn(),
    sleep: vi.fn(async () => { vi.setSystemTime(Date.now() + sleepAdvanceMs); }),
    sendEvent: vi.fn(),
    scheduleAfter: vi.fn(),
  },
};

const rows = (table: string) => db.tables[table] ?? [];
const item = (n = N) => rows('ksef_history_items').find((r) => r.ksef_number === n)!;
const downloads = () => m.fetch.mock.calls.filter(([path]) => String(path).startsWith('/invoices/ksef/'));

function setNow(now: Date) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  if (db) db.tables.ksef_inbox_cursor = [{ tenant_id: TENANT, window_to: new Date(now.getTime() - 10 * 60_000).toISOString() }];
}

function parsed(patch: Row = {}): Row {
  return { invoiceNumber: 'FV/1/09/2026', issueDate: '2026-09-10', warnings: [], lines: [], ...patch };
}

function engineResult(patch: Row = {}) {
  return {
    invoicesImported: 1, invoicesFailed: 0, contractorsCreated: 0, contractorsUpdated: 0, productsCreated: 0,
    warnings: [], held: [], ...patch,
  };
}

/** Strumienie po zakończonym odkrywaniu (bez zapytań o metadane) — przebieg tylko pobiera. */
function completedStreams(): Row[] {
  const done = { backfill_completed_at: '2026-10-21T00:00:00.000Z', live_checked_at: '2026-10-22T09:59:00.000Z' };
  return [
    streamRow({ id: 'strumien-out', tenant_id: TENANT, direction: 'outgoing', ...done }),
    streamRow({ id: 'strumien-in', tenant_id: TENANT, direction: 'incoming', live_hwm: null, ...done }),
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  sleepAdvanceMs = 6_000;
  db = historyDb({
    tenants: [{
      id: TENANT, nip: NIP, ksef_verified_at: '2026-09-01T00:00:00Z', ksef_verified_environment: 'test',
      ksef_certificate_expiry: '2099-01-01T00:00:00Z', deleted_at: null, is_active: true, has_ksef_credentials: true,
    }],
    ksef_history_sync: completedStreams(),
    ksef_history_items: [],
    invoices: [],
    invoice_line_items: [],
    xml_documents: [],
    ksef_submissions: [],
  });
  setNow(DAY_NOW);
  m.db = historyClient(db);
  m.credentials.mockResolvedValue({ type: 'token', nip: NIP, token: 'token-testowy' });
  m.getSession.mockResolvedValue({ accessToken: 'sesja-testowa' });
  m.fetch.mockImplementation(async (path: string) => {
    if (path.startsWith('/invoices/ksef/')) return Buffer.from('<Faktura/>');
    return { invoices: [], hasMore: false, isTruncated: false, permanentStorageHwmDate: null };
  });
  m.archive.mockImplementation(async (tenantId: string, n: string, bytes: Buffer) => ({
    storagePath: `${tenantId}/ksef-import/${n}.xml`, sha256Hash: 'a'.repeat(64), sizeBytes: bytes.length,
  }));
  // Jak `parseFa3Xml`: numer KSeF z opcji trafia do wyniku.
  m.parse.mockImplementation((_xml: string, opts?: { ksefNumber?: string }) => parsed({ ksefNumber: opts?.ksefNumber }));
  m.engine.mockImplementation(async (params: { invoiceDirection: string; importJobId: string; invoices: Array<{ ksefNumber?: string; invoiceNumber: string }> }) => {
    const inv = params.invoices[0]!;
    const invoiceId = `inv-${inv.ksefNumber}`;
    // Pełny zapis silnika: nagłówek, pozycje i wiersz `xml_documents` (KOD I).
    db.tables.invoices!.push({
      id: invoiceId, tenant_id: TENANT, direction: params.invoiceDirection, origin: 'ksef_import', ksef_status: 'accepted',
      ksef_number: inv.ksefNumber ?? N, ksef_environment: 'test', internal_number: inv.invoiceNumber,
      xml_storage_path: 'x.xml', fa3_data: { annotations: {}, import: { importJobId: params.importJobId } },
    });
    db.tables.invoice_line_items!.push({ id: `l-${invoiceId}`, invoice_id: invoiceId });
    db.tables.xml_documents!.push({ id: `x-${invoiceId}`, tenant_id: TENANT, invoice_id: invoiceId });
    return engineResult();
  });
});

afterEach(() => vi.useRealTimers());

// ═══════════════════════════════════════════════════════════════
// Klasyfikacja przed pobraniem
// ═══════════════════════════════════════════════════════════════

describe('classifyForProcessing', () => {
  const ctxFor = (direction: 'outgoing' | 'incoming' = 'outgoing'): ClassifyContext => ({
    admin: historyClient(db) as never, tenantId: TENANT, environment: 'test', direction, streamId: 'strumien-out',
  });
  const ledger = (patch: Row = {}) => itemRow({ tenant_id: TENANT, ksef_number: N, invoice_hash: HASH_B64, ...patch }) as never;
  const local = (patch: Row): Row => ({
    id: 'lok-1', tenant_id: TENANT, direction: 'outgoing', ksef_number: null, ksef_environment: 'test', origin: 'app',
    internal_number: 'INNY/1', ksef_status: 'accepted', xml_storage_path: 'x.xml', fa3_data: { annotations: {} }, ...patch,
  });

  describe('krok 1 — ten sam numer KSeF', () => {
    it('faktura FaktWay → own_invoice', async () => {
      db.tables.invoices = [local({ ksef_number: N })];
      expect(await classifyForProcessing(ctxFor(), ledger())).toEqual({ action: 'resolve', status: 'skipped', reason: 'own_invoice', invoiceId: 'lok-1' });
    });
    it('dwa wiersze albo inne środowisko → local_conflict', async () => {
      db.tables.invoices = [local({ ksef_number: N }), local({ id: 'lok-2', ksef_number: N })];
      expect(await classifyForProcessing(ctxFor(), ledger())).toMatchObject({ action: 'block', reason: 'local_conflict' });
      db.tables.invoices = [local({ ksef_number: N, ksef_environment: 'production' })];
      expect(await classifyForProcessing(ctxFor(), ledger())).toMatchObject({ action: 'block', reason: 'local_conflict' });
    });
    /** Pełny zapis faktury `lok-1`: pozycja i wiersz `xml_documents` (KOD I). */
    const complete = () => {
      db.tables.invoice_line_items = [{ id: 'l-1', invoice_id: 'lok-1' }];
      db.tables.xml_documents = [{ id: 'x-1', tenant_id: TENANT, invoice_id: 'lok-1' }];
    };
    it('naprawa treści: brak XML → pobranie w trybie naprawy; po naprawie → imported/repaired', async () => {
      db.tables.invoices = [local({ ksef_number: N, origin: 'ksef_import', xml_storage_path: null })];
      expect(await classifyForProcessing(ctxFor(), ledger({ reason_code: 'repair_content' }))).toEqual({ action: 'download', repair: true });
      db.tables.invoices = [local({ ksef_number: N, origin: 'ksef_import' })];
      complete();
      expect(await classifyForProcessing(ctxFor(), ledger({ reason_code: 'repair_content' })))
        .toMatchObject({ action: 'resolve', status: 'imported', reason: 'repaired' });
    });
    it('naprawa treści: ścieżka XML jest, ale bez wiersza `xml_documents` → dalej naprawa, nie `repaired`', async () => {
      db.tables.invoices = [local({ ksef_number: N, origin: 'ksef_import' })];
      complete();
      db.tables.xml_documents = [];
      expect(await classifyForProcessing(ctxFor(), ledger({ reason_code: 'repair_content' }))).toEqual({ action: 'download', repair: true });
    });
    it('zapis tego strumienia (awaria po silniku) → imported; dawny import → already_present', async () => {
      db.tables.invoices = [local({ ksef_number: N, origin: 'ksef_import', fa3_data: { annotations: {}, import: { importJobId: 'strumien-out' } } })];
      complete();
      expect(await classifyForProcessing(ctxFor(), ledger())).toMatchObject({ action: 'resolve', status: 'imported', reason: null });
      db.tables.invoices = [local({ ksef_number: N, origin: 'ksef_import', fa3_data: { annotations: {}, import: { importJobId: 'stary' } } })];
      expect(await classifyForProcessing(ctxFor(), ledger())).toMatchObject({ action: 'resolve', status: 'skipped', reason: 'already_present' });
    });
    it('zapis tego strumienia NIEPEŁNY (bez `xml_documents` albo bez pozycji) → uzupełnienie przez silnik, nie `imported`', async () => {
      db.tables.invoices = [local({ ksef_number: N, origin: 'ksef_import', fa3_data: { annotations: {}, import: { importJobId: 'strumien-out' } } })];
      complete();
      db.tables.xml_documents = [];
      expect(await classifyForProcessing(ctxFor(), ledger())).toEqual({ action: 'download', repair: true });
      complete();
      db.tables.invoice_line_items = [];
      expect(await classifyForProcessing(ctxFor(), ledger())).toEqual({ action: 'download', repair: true });
    });
  });

  describe('krok 1b — zakup przepisany bez numeru KSeF', () => {
    it('ten sam sprzedawca, data i numer → already_present; inaczej pobieramy', async () => {
      const purchase = ledger({ direction: 'incoming', counterparty_nip: '526-000-12-46', invoice_number: ' FZ/9 ' });
      db.tables.invoices = [local({ direction: 'incoming', origin: 'ocr', seller_nip: '5260001246', issue_date: '2026-09-10', internal_number: 'FZ/9' })];
      expect(await classifyForProcessing(ctxFor('incoming'), purchase)).toMatchObject({ action: 'resolve', reason: 'already_present', invoiceId: 'lok-1' });
      db.tables.invoices = [local({ direction: 'incoming', origin: 'ocr', seller_nip: '5260001246', issue_date: '2026-09-11', internal_number: 'FZ/9' })];
      expect(await classifyForProcessing(ctxFor('incoming'), purchase)).toEqual({ action: 'download', repair: false });
    });
  });

  describe('krok 2 — nasza próba wysyłki', () => {
    const submission = (patch: Row): Row => ({
      id: 's-1', tenant_id: TENANT, invoice_id: 'szkic-1', status: 'sent', original_ksef_number: null,
      response_ksef_number: null, request_payload_hash: null, ...patch,
    });
    it('numer zajęty przez wycofany szkic 440 (number_taken) → retired_draft, nigdy import', async () => {
      db.tables.ksef_submissions = [submission({ original_ksef_number: N, status: 'number_taken' })];
      expect(await classifyForProcessing(ctxFor(), ledger())).toEqual({ action: 'resolve', status: 'skipped', reason: 'retired_draft', invoiceId: 'szkic-1' });
    });
    it('otwarty 440: blokada decyzji NULL → duplicate_decision (klient); inna → own_send_pending', async () => {
      db.tables.ksef_submissions = [submission({ original_ksef_number: N, status: 'intent' })];
      db.rpc = () => ({ data: null, error: null });
      expect(await classifyForProcessing(ctxFor(), ledger())).toMatchObject({ action: 'defer', reason: 'duplicate_decision', invoiceId: 'szkic-1' });
      db.rpc = () => ({ data: 'operator-reason', error: null });
      expect(await classifyForProcessing(ctxFor(), ledger())).toMatchObject({ action: 'defer', reason: 'own_send_pending' });
      expect(db.log.some((q) => q.table === 'rpc:ksef_duplicate_decision_blocker')).toBe(true);
    });
    it('numer z odpowiedzi KSeF albo ten sam plik (skrót) → own_send_pending', async () => {
      db.tables.ksef_submissions = [submission({ response_ksef_number: N })];
      expect(await classifyForProcessing(ctxFor(), ledger())).toMatchObject({ action: 'defer', reason: 'own_send_pending' });
      db.tables.ksef_submissions = [submission({ request_payload_hash: HASH_HEX.toUpperCase() })];
      expect(await classifyForProcessing(ctxFor(), ledger())).toMatchObject({ action: 'defer', reason: 'own_send_pending' });
    });
    it('próba innej firmy nie wpływa', async () => {
      db.tables.ksef_submissions = [submission({ tenant_id: 'inna', response_ksef_number: N })];
      expect(await classifyForProcessing(ctxFor(), ledger())).toEqual({ action: 'download', repair: false });
    });
  });

  describe('krok 3 — numer faktury zajęty w FaktWay', () => {
    const holder = (patch: Row) => { db.tables.invoices = [local({ internal_number: 'FV/1/09/2026', buyer_nip: '1111111111', issue_date: '2026-09-10', gross_total: 123, ...patch })]; };
    // ZAP-01: do 27.10 ten test wymagał `already_present` dla `ksef_status: 'draft'`
    // i utrwalał zgubienie sprzedaży (szkic z pliku nie liczy się w księgach).
    // `already_present` zostaje tylko dla wiersza przyjętego w tym środowisku.
    it('przeniesiona plikiem i przyjęta w tym środowisku, te same dane → already_present (wiersza nie ruszamy)', async () => {
      holder({ origin: 'file_import', ksef_status: 'accepted', ksef_environment: 'test' });
      expect(await classifyForProcessing(ctxFor(), ledger())).toMatchObject({ action: 'resolve', reason: 'already_present', invoiceId: 'lok-1' });
      expect(db.log.filter((q) => q.table === 'invoices' && q.op !== 'select')).toEqual([]);
    });
    it('przeniesiona plikiem i przyjęta, inne dane → file_import_mismatch', async () => {
      holder({ origin: 'file_import', gross_total: 124 });
      expect(await classifyForProcessing(ctxFor(), ledger())).toMatchObject({ action: 'block', reason: 'file_import_mismatch' });
    });
    it('ZAP-01: szkic z importu CSV (draft, bez środowiska) → number_conflict, nie already_present', async () => {
      holder({ origin: 'file_import', ksef_status: 'draft', ksef_environment: null });
      expect(await classifyForProcessing(ctxFor(), ledger())).toEqual({ action: 'block', reason: 'number_conflict', invoiceId: 'lok-1' });
      // Inne dane niż w KSeF — to dalej szkic poza księgami (do 27.10: `file_import_mismatch`
      // z alarmem operatora); prawnie wiąże oryginał z KSeF, więc ta sama droga: klient usuwa szkic.
      holder({ origin: 'file_import', ksef_status: 'draft', ksef_environment: null, gross_total: 124 });
      expect(await classifyForProcessing(ctxFor(), ledger())).toEqual({ action: 'block', reason: 'number_conflict', invoiceId: 'lok-1' });
      expect(db.log.filter((q) => q.table === 'invoices' && q.op !== 'select')).toEqual([]);
    });
    it('ZAP-01: wiersz spoza ksiąg, który nie jest szkicem (inne środowisko, bez środowiska, odrzucony) → local_conflict', async () => {
      for (const patch of [
        { ksef_status: 'accepted', ksef_environment: 'production' },
        { ksef_status: 'accepted', ksef_environment: null },
        { ksef_status: 'rejected', ksef_environment: null },
      ]) {
        holder({ origin: 'file_import', ...patch });
        expect(await classifyForProcessing(ctxFor(), ledger())).toEqual({ action: 'block', reason: 'local_conflict', invoiceId: 'lok-1' });
      }
    });
    // Recenzja #339: `number_conflict` każe klientowi usunąć szkic, a usunąć da się
    // tylko `draft` bez wycofania 440 (draft-actions.ts, wyzwalacz 00148).
    it('ZAP-01: szkic z pliku wysłany z FaktWay (440 bez numeru oryginału) → operator, nie „usuń szkic”', async () => {
      holder({ origin: 'file_import', ksef_status: 'draft', ksef_environment: null });
      db.tables.ksef_submissions = [{
        id: 's-440', tenant_id: TENANT, invoice_id: 'lok-1', status: 'number_taken',
        original_ksef_number: null, response_ksef_number: null, request_payload_hash: null,
      }];
      expect(await classifyForProcessing(ctxFor(), ledger())).toEqual({ action: 'block', reason: 'local_conflict', invoiceId: 'lok-1' });
    });
    it('ZAP-01: szkic z pliku w wysyłce → czekamy jak na fakturę FaktWay; po nieudanej wysyłce z próbą — też', async () => {
      holder({ origin: 'file_import', ksef_status: 'queued', ksef_environment: null });
      expect(await classifyForProcessing(ctxFor(), ledger())).toMatchObject({ action: 'defer', reason: 'own_send_pending', invoiceId: 'lok-1' });
      holder({ origin: 'file_import', ksef_status: 'failed', ksef_environment: null });
      db.tables.ksef_submissions = [{ id: 's-9', tenant_id: TENANT, invoice_id: 'lok-1', status: 'failed' }];
      expect(await classifyForProcessing(ctxFor(), ledger())).toMatchObject({ action: 'defer', reason: 'own_send_pending', invoiceId: 'lok-1' });
    });
    it('ZAP-01: wiersz spoza FaktWay bez statusu (NULL) → local_conflict — usunąć da się tylko `draft`', async () => {
      holder({ origin: 'file_import', ksef_status: null, ksef_environment: null });
      expect(await classifyForProcessing(ctxFor(), ledger())).toEqual({ action: 'block', reason: 'local_conflict', invoiceId: 'lok-1' });
    });
    it('inny numer KSeF przy tym numerze → number_taken_local', async () => {
      holder({ origin: 'file_import', ksef_number: 'INNY-KSEF' });
      expect(await classifyForProcessing(ctxFor(), ledger())).toMatchObject({ action: 'block', reason: 'number_taken_local' });
      holder({ origin: 'app', ksef_status: 'accepted', ksef_number: 'INNY-KSEF' });
      expect(await classifyForProcessing(ctxFor(), ledger())).toMatchObject({ action: 'block', reason: 'number_taken_local' });
    });
    it('zwykły szkic bez prób wysyłki → number_conflict (klient zmienia numer albo usuwa)', async () => {
      holder({ origin: 'app', ksef_status: 'draft' });
      expect(await classifyForProcessing(ctxFor(), ledger())).toMatchObject({ action: 'block', reason: 'number_conflict', invoiceId: 'lok-1' });
    });
    it('szkic z próbami wysyłki → number_taken_local; failed z próbami / w kolejce → own_send_pending', async () => {
      holder({ origin: 'app', ksef_status: 'draft' });
      db.tables.ksef_submissions = [{ id: 's-9', tenant_id: TENANT, invoice_id: 'lok-1', status: 'abandoned' }];
      expect(await classifyForProcessing(ctxFor(), ledger())).toMatchObject({ action: 'block', reason: 'number_taken_local' });
      holder({ origin: 'app', ksef_status: 'failed' });
      expect(await classifyForProcessing(ctxFor(), ledger())).toMatchObject({ action: 'defer', reason: 'own_send_pending' });
      holder({ origin: 'app', ksef_status: 'queued' });
      expect(await classifyForProcessing(ctxFor(), ledger())).toMatchObject({ action: 'defer', reason: 'own_send_pending' });
    });
  });

  it('krok 4 — nic nie zajmuje faktury → pobranie', async () => {
    expect(await classifyForProcessing(ctxFor(), ledger())).toEqual({ action: 'download', repair: false });
  });
});

describe('odłożone i zablokowane', () => {
  it('own_send_pending dłużej niż 48 h → own_send_unresolved (jak I5); duplicate_decision bez limitu', () => {
    const old = { invoice_id: null, first_deferred_at: '2026-10-19T00:00:00.000Z' };
    expect(itemPatchFor(old, { action: 'defer', reason: 'own_send_pending', invoiceId: 'x' }, DAY_NOW))
      .toMatchObject({ status: 'blocked', reason_code: 'own_send_unresolved' });
    expect(itemPatchFor(old, { action: 'defer', reason: 'duplicate_decision', invoiceId: 'x' }, DAY_NOW))
      .toMatchObject({ status: 'deferred', reason_code: 'duplicate_decision', first_deferred_at: old.first_deferred_at, next_attempt_at: '2026-10-22T11:00:00.000Z' });
    expect(itemPatchFor({ invoice_id: null, first_deferred_at: null }, { action: 'defer', reason: 'own_send_pending', invoiceId: 'x' }, DAY_NOW))
      .toMatchObject({ status: 'deferred', first_deferred_at: DAY_NOW.toISOString() });
  });

  it('po uzgodnieniu wysyłki ponowne sprawdzenie daje own_invoice — bez pobrania', async () => {
    db.tables.ksef_history_items = [itemRow({
      tenant_id: TENANT, status: 'deferred', reason_code: 'own_send_pending', next_attempt_at: '2026-10-22T09:00:00.000Z',
      first_deferred_at: '2026-10-22T08:00:00.000Z',
    })];
    db.tables.invoices = [{ id: 'nasza', tenant_id: TENANT, direction: 'outgoing', origin: 'app', ksef_number: N, ksef_environment: 'test' }];
    await runKsefHistorySyncTenant(event, ctx);
    expect(item()).toMatchObject({ status: 'skipped', reason_code: 'own_invoice', invoice_id: 'nasza', resolved_at: DAY_NOW.toISOString() });
    expect(downloads()).toEqual([]);
  });

  it('zablokowane z powodem lokalnym: sprawdzane najstarsze pierwsze, `updated_at` podbijany także bez zmiany', async () => {
    db.tables.invoices = [{ id: 'szkic', tenant_id: TENANT, direction: 'outgoing', origin: 'app', ksef_status: 'draft', internal_number: 'FV/1/09/2026' }];
    db.tables.ksef_history_items = [
      itemRow({ tenant_id: TENANT, status: 'blocked', reason_code: 'number_conflict', updated_at: '2026-10-22T05:00:00.000Z', resolved_at: '2026-10-22T05:00:00.000Z' }),
      itemRow({ tenant_id: TENANT, ksef_number: 'ŚWIEŻA-1', status: 'blocked', reason_code: 'number_conflict', updated_at: '2026-10-22T09:30:00.000Z' }),
      itemRow({ tenant_id: TENANT, ksef_number: 'WALUTA-1', status: 'blocked', reason_code: 'currency_not_supported', updated_at: '2026-10-20T00:00:00.000Z' }),
    ];
    await runKsefHistorySyncTenant(event, ctx);
    expect(item()).toMatchObject({ status: 'blocked', reason_code: 'number_conflict' });
    expect(String(item().updated_at) > '2026-10-22T05:00:00.000Z').toBe(true);
    expect(item('ŚWIEŻA-1').updated_at).toBe('2026-10-22T09:30:00.000Z');
    expect(item('WALUTA-1').updated_at).toBe('2026-10-20T00:00:00.000Z');

    // Klient zmienił numer szkicu — następne sprawdzenie odblokowuje i pobiera.
    db.tables.invoices![0]!.internal_number = 'FV/1/09/2026-szkic';
    item().updated_at = '2026-10-22T05:00:00.000Z';
    await runKsefHistorySyncTenant(event, ctx);
    expect(item()).toMatchObject({ status: 'imported' });
  });

  it('ZAP-01: szkic z importu CSV o tym numerze → blokada dla klienta, bez pobrania; po usunięciu szkicu pobieramy oryginał', async () => {
    db.tables.ksef_history_items = [itemRow({ tenant_id: TENANT })];
    db.tables.invoices = [{
      id: 'szkic-csv', tenant_id: TENANT, direction: 'outgoing', origin: 'file_import', ksef_status: 'draft',
      ksef_number: null, ksef_environment: null, internal_number: 'FV/1/09/2026', buyer_nip: '1111111111',
      issue_date: '2026-09-10', gross_total: 123, fa3_data: { import: { importJobId: 'import-csv-1' } },
    }];
    await runKsefHistorySyncTenant(event, ctx);
    expect(item()).toMatchObject({ status: 'blocked', reason_code: 'number_conflict', invoice_id: 'szkic-csv' });
    expect(downloads()).toEqual([]);
    expect(m.engine).not.toHaveBeenCalled();

    // Klient usuwa szkic (FK ON DELETE SET NULL) — następne sprawdzenie (co godzinę) odblokowuje i pobiera.
    db.tables.invoices = [];
    item().invoice_id = null;
    item().updated_at = '2026-10-22T05:00:00.000Z';
    await runKsefHistorySyncTenant(event, ctx);
    expect(item()).toMatchObject({ status: 'imported', reason_code: null, invoice_id: `inv-${N}` });
    expect(downloads()).toHaveLength(1);
  });

  it('wycofany szkic: sprawdzany raz na dobę; po przeniesieniu numeru przez PR C — do pobrania', async () => {
    db.tables.ksef_history_items = [itemRow({ tenant_id: TENANT, status: 'skipped', reason_code: 'retired_draft', updated_at: '2026-10-21T08:00:00.000Z', resolved_at: '2026-10-21T08:00:00.000Z' })];
    await runKsefHistorySyncTenant(event, ctx);
    expect(item()).toMatchObject({ status: 'imported' });
  });
});

// ═══════════════════════════════════════════════════════════════
// Strażnik ZAP-01: sprzedaż „już w FaktWay” = sprzedaż w księgach
// ═══════════════════════════════════════════════════════════════

/**
 * ZAP-01 (przegląd architektury 26.10.2026): historia uznawała sprzedaż za
 * obecną, gdy jakikolwiek wiersz miał jej numer i dane — także szkic z importu
 * CSV, którego nie liczy przychód, KPiR, JPK ani Pulpit. Oryginał z KSeF nie
 * trafiał do bazy, a sprzedaż znikała z ksiąg bez komunikatu.
 *
 * Strażnik przechodzi przez każdy kształt posiadacza (pochodzenie × status
 * KSeF × środowisko × numer KSeF × dane × zapis strumienia) w obu miejscach
 * klasyfikacji i pilnuje dwóch rzeczy w sprzedaży:
 *  1. `skipped/already_present` i `imported` tylko z posiadaczem w księgach —
 *     filtr przychodu, KPiR i Pulpitu: `ksef_status = 'accepted'` w środowisku
 *     strumienia (`lib/analytics-finance/sales.ts`, `lib/reports/kpir-data.ts`).
 *     Jedyny wyjątek: dawny import KSeF bez środowiska — Pulpit i przychód
 *     zatrzymują się na nim komunikatem (`assertAcceptedEnvironmentKnown`),
 *     operator widzi go w `ksef-historia.sh stan` (punkt 6).
 *  2. Posiadacz spoza ksiąg (i spoza FaktWay) nie kończy pozycji: blokada
 *     z powodem sprawdzanym ponownie co godzinę, odłożenie albo pobranie.
 *  3. Szkic bez numeru KSeF (klient może go usunąć) daje powód klienta
 *     `number_conflict`, nie operatorski `local_conflict`.
 */
describe('strażnik ZAP-01: sprzedaż „już w FaktWay” jest w księgach', () => {
  // CHECK invoices_ksef_status_check (00018) + NULL.
  const STATUSES = ['draft', 'queued', 'sending', 'accepted', 'rejected', 'received', 'failed', 'offline_queued', null];
  const ENVIRONMENTS = ['test', 'production', null];
  const KSEF_NUMBERS = [N, ` ${N}`, null, 'INNY-KSEF'];
  const STREAMS = ['strumien-out', 'stary'];
  const ctxFor = (): ClassifyContext => ({
    admin: historyClient(db) as never, tenantId: TENANT, environment: 'test', direction: 'outgoing', streamId: 'strumien-out',
  });
  const inBooks = (h: Row) => h.ksef_status === 'accepted'
    && (h.ksef_environment === 'test' || (h.ksef_environment === null && h.origin === 'ksef_import'));
  const shapes = (): Row[] => INVOICE_ORIGINS.flatMap((origin) => STATUSES.flatMap((ksef_status) =>
    ENVIRONMENTS.flatMap((ksef_environment) => STREAMS.map((importJobId) => ({
      id: 'lok-1', tenant_id: TENANT, direction: 'outgoing', origin, ksef_status, ksef_environment,
      internal_number: 'FV/1/09/2026', buyer_nip: '1111111111', issue_date: '2026-09-10', gross_total: 123,
      xml_storage_path: 'x.xml', fa3_data: { annotations: {}, import: { importJobId } },
    })))));
  const label = (h: Row) => `${String(h.origin)}/${String(h.ksef_status)}/${String(h.ksef_environment)}/${String(h.ksef_number)}/${String(h.gross_total)}/${String((h.fa3_data as { import: { importJobId: string } }).import.importJobId)}`;

  beforeEach(() => {
    // Pełny zapis posiadacza — gałęzie „zapis tego strumienia” i „naprawa” rozstrzygają, a nie pobierają.
    db.tables.invoice_line_items = [{ id: 'l-1', invoice_id: 'lok-1' }];
    db.tables.xml_documents = [{ id: 'x-1', tenant_id: TENANT, invoice_id: 'lok-1' }];
  });

  // Próby wysyłki posiadacza: brak albo wycofanie 440 bez numeru oryginału
  // (duplicate-decision.ts) — klient takiego szkicu nie usunie (wyzwalacz 00148).
  const ATTEMPTS: Row[][] = [[], [{
    id: 's-440', tenant_id: TENANT, invoice_id: 'lok-1', status: 'number_taken',
    original_ksef_number: null, response_ksef_number: null, request_payload_hash: null,
  }]];

  it('classifyForProcessing: już obecna tylko przy posiadaczu w księgach; posiadacz spoza ksiąg nie kończy pozycji', async () => {
    const violations: string[] = [];
    let present = 0;
    let clientDrafts = 0;
    for (const base of shapes()) {
      for (const ksef_number of KSEF_NUMBERS) {
        for (const gross_total of [123, 124]) {
          for (const attempts of ATTEMPTS) {
            for (const reason_code of [null, 'repair_content']) {
              const holder: Row = { ...base, ksef_number, gross_total };
              db.tables.invoices = [holder];
              db.tables.ksef_submissions = attempts;
              const outcome = await classifyForProcessing(ctxFor(), itemRow({ tenant_id: TENANT, reason_code }) as never);
              const at = `${label(holder)}/próby:${attempts.length} → ${outcome.action}/${String('reason' in outcome ? outcome.reason : '')}`;
              const counted = outcome.action === 'resolve'
                && (outcome.reason === 'already_present' || outcome.status === 'imported');
              if (counted) present += 1;
              // 1. „Już w FaktWay” tylko przy posiadaczu w księgach.
              if (counted && !inBooks(holder)) violations.push(at);
              const terminal = outcome.action === 'resolve'
                || (outcome.action === 'block' && !KSEF_HISTORY_RECHECK_BLOCKED_REASONS.includes(outcome.reason));
              // 2. Posiadacz spoza ksiąg nie kończy pozycji — blokada sprawdzana ponownie albo czekanie.
              if (holder.origin !== 'app' && !inBooks(holder) && terminal) violations.push(`koniec bez wyjścia: ${at}`);
              // 3. Szkic, który klient może usunąć (`draft`, bez prób wysyłki, bez numeru KSeF),
              //    dostaje powód klienta z tekstem i linkiem, nie operatora.
              const deletableDraft = holder.ksef_status === 'draft' && attempts.length === 0;
              const clientDraft = holder.origin !== 'app' && !inBooks(holder) && deletableDraft
                && !String(holder.ksef_number ?? '').trim();
              if (clientDraft) clientDrafts += 1;
              if (clientDraft && !(outcome.action === 'block' && outcome.reason === 'number_conflict')) {
                violations.push(`szkic bez drogi klienta: ${at}`);
              }
              // 4. „Usuń szkic” (`number_conflict`) tylko, gdy da się go usunąć: `deleteDraftInvoiceAction`
              //    usuwa wyłącznie `draft`, a wycofanego szkicu 440 klient nie usunie (recenzja #339).
              //    Reszta powodów sprawdzanych ponownie budzi operatora (ksef-historia-alarm.test.ts).
              if (outcome.action === 'block' && outcome.reason === 'number_conflict' && !deletableDraft) {
                violations.push(`„usuń szkic” bez możliwości usunięcia: ${at}`);
              }
            }
          }
        }
      }
    }
    expect(clientDrafts).toBeGreaterThan(0);
    expect(violations).toEqual([]);
    expect(present).toBeGreaterThan(0); // strażnik nie jest pusty
  });

  it('classifyDiscovered: już obecna tylko przy posiadaczu w księgach; posiadacz spoza ksiąg nie kończy pozycji', async () => {
    const page: InvoiceMetadata[] = [{
      ksefNumber: N, invoiceNumber: 'FV/1/09/2026', issueDate: '2026-09-10', invoicingDate: '2026-09-10T10:00:00Z',
      acquisitionDate: '2026-09-10T10:00:01Z', permanentStorageDate: '2026-09-10T10:00:05Z', invoicingMode: 'Online',
      invoiceType: 'Vat', seller: { nip: NIP, name: 'Sprzedawca' }, buyer: { identifier: { type: 'Nip', value: '1111111111' }, name: 'Nabywca' },
      netAmount: 100, grossAmount: 123, vatAmount: 23, currency: 'PLN', invoiceHash: HASH_B64,
      formCode: { systemCode: 'FA (3)', schemaVersion: '1-0E', value: 'FA' },
    } as InvoiceMetadata];
    const violations: string[] = [];
    let present = 0;
    for (const base of shapes()) {
      for (const xml_storage_path of ['x.xml', null]) {
        const holder: Row = { ...base, ksef_number: N, xml_storage_path };
        db.tables.invoices = [holder];
        const [row] = await classifyDiscovered(ctxFor(), page, DAY_NOW);
        if (!row) continue; // faktura FaktWay — bez wiersza
        const counted = (row.status === 'skipped' && row.reason_code === 'already_present') || row.status === 'imported';
        if (counted) present += 1;
        if (counted && !inBooks(holder)) violations.push(`${label(holder)}/${String(xml_storage_path)} → ${row.status}/${String(row.reason_code)}`);
        const terminal = row.status === 'skipped' || row.status === 'imported'
          || (row.status === 'blocked' && !(KSEF_HISTORY_RECHECK_BLOCKED_REASONS as readonly string[]).includes(String(row.reason_code)));
        if (holder.origin !== 'app' && !inBooks(holder) && terminal) {
          violations.push(`${label(holder)}/${String(xml_storage_path)} → koniec bez wyjścia: ${row.status}/${String(row.reason_code)}`);
        }
      }
    }
    expect(violations).toEqual([]);
    expect(present).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// Pobranie i zapis
// ═══════════════════════════════════════════════════════════════

describe('pobranie → archiwum → odczyt → silnik', () => {
  beforeEach(() => {
    db.tables.ksef_history_items = [itemRow({ tenant_id: TENANT })];
  });

  it('sukces: silnik dostaje chwilę nadania numeru w KSeF, pozycja `imported` z id faktury', async () => {
    await expect(runKsefHistorySyncTenant(event, ctx)).resolves.toMatchObject({ downloads: 1, imported: 1 });
    const params = m.engine.mock.calls[0]![0];
    expect(params).toMatchObject({
      importJobId: 'strumien-out', source: 'ksef_history', invoiceDirection: 'outgoing', invoiceKsefStatus: 'accepted',
      ksefEnvironment: 'test', catalogPolicy: { contractors: 'insert-only', products: 'insert-only' },
    });
    expect(params.invoices[0]).toMatchObject({ ksefAcceptedAt: '2026-09-10T10:00:00.000Z', xmlArchive: { storagePath: `${TENANT}/ksef-import/${N}.xml` } });
    expect(item()).toMatchObject({ status: 'imported', reason_code: null, invoice_id: `inv-${N}`, resolved_at: DAY_NOW.toISOString() });
    expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'ksef.history.download', metadata: expect.objectContaining({ count: 1, ksefNumbers: [N] }) }));
    expect(rows('ksef_history_sync').find((s) => s.direction === 'outgoing')).toMatchObject({ last_success_at: DAY_NOW.toISOString() });
  });

  it('zakupy z historii: archiwum bez katalogów; brak acquisition → permanent storage', async () => {
    db.tables.ksef_history_items = [itemRow({ tenant_id: TENANT, direction: 'incoming', acquisition_at: null })];
    await runKsefHistorySyncTenant(event, ctx);
    const params = m.engine.mock.calls[0]![0];
    expect(params).toMatchObject({ invoiceDirection: 'incoming', importJobId: 'strumien-in', catalogPolicy: { contractors: 'skip', products: 'skip' } });
    expect(params.invoices[0].ksefAcceptedAt).toBe('2026-09-10T10:00:05.000Z');
  });

  it('notatka JPK → `imported jpk_note`', async () => {
    m.engine.mockImplementationOnce(async () => {
      db.tables.invoices!.push({ id: 'inv-jpk', tenant_id: TENANT, direction: 'outgoing', ksef_number: N, ksef_environment: 'test' });
      return engineResult({ held: ['FV/1/09/2026: JPK_FA i JPK_V7M nie wykażą…'] });
    });
    await runKsefHistorySyncTenant(event, ctx);
    expect(item()).toMatchObject({ status: 'imported', reason_code: 'jpk_note', invoice_id: 'inv-jpk' });
  });

  it.each([
    ['archiwum z innym plikiem', () => m.archive.mockRejectedValueOnce(new KsefXmlArchiveConflictError(N)), 'archive_conflict'],
    ['waluta obca w pliku', () => m.parse.mockImplementationOnce(() => { throw new Error('faktura w walucie EUR — import obsługuje tylko złote'); }), 'currency_not_supported'],
    ['nieczytelny plik', () => m.parse.mockImplementationOnce(() => { throw new Error('XML parse error: zły znak'); }), 'parse_failed'],
    ['plik ≠ metadane', () => m.parse.mockImplementationOnce(() => parsed({ invoiceNumber: 'FV/999' })), 'metadata_mismatch'],
  ] as const)('%s → blocked %s, bez silnika', async (_label, arrange, reason) => {
    arrange();
    await runKsefHistorySyncTenant(event, ctx);
    expect(item()).toMatchObject({ status: 'blocked', reason_code: reason });
    expect(m.engine).not.toHaveBeenCalled();
  });

  it('KSeF 21165 (jeszcze niedostępna) — za 15 min, bez liczenia próby', async () => {
    m.fetch.mockImplementationOnce(async () => {
      throw new KsefApiError(400, JSON.stringify({ exception: { exceptionDetailList: [{ exceptionCode: 21165 }] } }), `KSeF API GET /invoices/ksef/${N} failed: 400`);
    });
    await runKsefHistorySyncTenant(event, ctx);
    expect(item()).toMatchObject({ status: 'pending', reason_code: 'ksef_not_ready', attempts: 0, next_attempt_at: '2026-10-22T10:15:00.000Z' });
  });

  it('inne 400/404 przy pobraniu — próba; po trzeciej `download_failed`', async () => {
    db.tables.ksef_history_items = [itemRow({ tenant_id: TENANT, attempts: 2 })];
    m.fetch.mockImplementationOnce(async () => {
      throw new KsefApiError(404, '', `KSeF API GET /invoices/ksef/${N} failed: 404`);
    });
    await runKsefHistorySyncTenant(event, ctx);
    expect(item()).toMatchObject({ status: 'blocked', reason_code: 'download_failed', attempts: 3 });
    expect(String(item().detail)).toBe('HTTP 404 /invoices/ksef/{n} kody:-');
  });

  it('nieudany zapis: najpierw ponowna klasyfikacja — gdy inna ścieżka zapisała fakturę, bez liczenia próby', async () => {
    m.engine.mockImplementationOnce(async () => {
      db.tables.invoices!.push({ id: 'skrzynka', tenant_id: TENANT, direction: 'outgoing', origin: 'app', ksef_number: N, ksef_environment: 'test' });
      return engineResult({ invoicesImported: 0, invoicesFailed: 1, warnings: ['FV/1: konflikt'] });
    });
    await runKsefHistorySyncTenant(event, ctx);
    expect(item()).toMatchObject({ status: 'skipped', reason_code: 'own_invoice', attempts: 0 });
  });

  it('trzy nieudane zapisy → `save_failed` (naprawa: `repair_failed`); szczegół = pierwsze ostrzeżenie', async () => {
    m.engine.mockResolvedValue(engineResult({ invoicesImported: 0, invoicesFailed: 1, warnings: ['Błąd zapisu faktury FV/1: unikalność'] }));
    for (let run = 0; run < 3; run++) {
      if (run > 0) item().next_attempt_at = null;
      await runKsefHistorySyncTenant(event, ctx);
    }
    expect(item()).toMatchObject({ status: 'blocked', reason_code: 'save_failed', attempts: 3, detail: 'Błąd zapisu faktury FV/1: unikalność' });

    db.tables.invoices = [{ id: 'stara', tenant_id: TENANT, direction: 'outgoing', origin: 'ksef_import', ksef_status: 'accepted', ksef_number: 'NAPRAWA-1', ksef_environment: 'test', xml_storage_path: null, fa3_data: {} }];
    db.tables.ksef_history_items = [itemRow({ tenant_id: TENANT, ksef_number: 'NAPRAWA-1', reason_code: 'repair_content', invoice_id: 'stara', attempts: 2 })];
    m.engine.mockResolvedValue(engineResult({ invoicesImported: 0, invoicesFailed: 1, warnings: ['nie uzupełniono'] }));
    await runKsefHistorySyncTenant(event, ctx);
    expect(item('NAPRAWA-1')).toMatchObject({ status: 'blocked', reason_code: 'repair_failed' });
    expect(m.engine.mock.calls.at(-1)![0].catalogPolicy).toEqual({ contractors: 'skip', products: 'skip' });
  });

  it('naprawa bez błędu → `imported repaired`', async () => {
    db.tables.invoices = [{ id: 'stara', tenant_id: TENANT, direction: 'outgoing', origin: 'ksef_import', ksef_status: 'accepted', ksef_number: N, ksef_environment: 'test', xml_storage_path: null, fa3_data: {} }];
    db.tables.ksef_history_items = [itemRow({ tenant_id: TENANT, reason_code: 'repair_content', invoice_id: 'stara' })];
    m.engine.mockResolvedValueOnce(engineResult({ invoicesImported: 0, invoicesFailed: 0 }));
    await runKsefHistorySyncTenant(event, ctx);
    expect(item()).toMatchObject({ status: 'imported', reason_code: 'repaired', invoice_id: 'stara' });
  });

  it('silnik zapisał fakturę, ale nie oryginał XML (`xml_documents`) — nie `imported`; następny przebieg uzupełnia ją silnikiem i liczy jako pobraną z notatką JPK', async () => {
    m.engine.mockImplementationOnce(async (params: { importJobId: string }) => {
      db.tables.invoices!.push({
        id: 'inv-czesciowa', tenant_id: TENANT, direction: 'outgoing', origin: 'ksef_import', ksef_status: 'accepted', ksef_number: N,
        ksef_environment: 'test', internal_number: 'FV/1/09/2026', xml_storage_path: 'x.xml',
        fa3_data: { annotations: {}, import: { importJobId: params.importJobId } },
      });
      db.tables.invoice_line_items!.push({ id: 'l-c', invoice_id: 'inv-czesciowa' });
      // Jak silnik przy błędzie `recordXmlDocument`: failed=1, faktura i pozycje zostają.
      return engineResult({
        invoicesImported: 0, invoicesFailed: 1,
        warnings: ['Faktura FV/1/09/2026: nie zapisano oryginału XML (KOD I) — ponów import (xml_documents: timeout)'],
        held: ['FV/1/09/2026: JPK_FA i JPK_V7M nie wykażą…'],
      });
    });
    await runKsefHistorySyncTenant(event, ctx);
    expect(item()).toMatchObject({ status: 'pending', attempts: 1 });

    item().next_attempt_at = null;
    m.engine.mockImplementationOnce(async () => {
      // Gałąź duplikatu silnika (`repairImportedXml`) dopisuje brakujący wiersz.
      db.tables.xml_documents!.push({ id: 'x-c', tenant_id: TENANT, invoice_id: 'inv-czesciowa' });
      return engineResult({ invoicesImported: 0, invoicesFailed: 0, held: ['FV/1/09/2026: JPK_FA i JPK_V7M nie wykażą…'] });
    });
    await runKsefHistorySyncTenant(event, ctx);
    expect(m.engine).toHaveBeenCalledTimes(2);
    expect(m.engine.mock.calls[1]![0].catalogPolicy).toEqual({ contractors: 'skip', products: 'skip' });
    expect(item()).toMatchObject({ status: 'imported', reason_code: 'jpk_note', invoice_id: 'inv-czesciowa' });
  });

  it('sam nagłówek bez pozycji (przerwany zapis) — nie `imported`; po 3 próbach uzupełnienia `save_failed` dla operatora', async () => {
    db.tables.invoices = [{
      id: 'inv-naglowek', tenant_id: TENANT, direction: 'outgoing', origin: 'ksef_import', ksef_status: 'accepted', ksef_number: N,
      ksef_environment: 'test', internal_number: 'FV/1/09/2026', xml_storage_path: 'x.xml',
      fa3_data: { annotations: {}, import: { importJobId: 'strumien-out' } },
    }];
    db.tables.xml_documents = [{ id: 'x-n', tenant_id: TENANT, invoice_id: 'inv-naglowek' }];
    // Gałąź duplikatu silnika: liczba pozycji ≠ plik → nieudane.
    m.engine.mockResolvedValue(engineResult({
      invoicesImported: 0, invoicesFailed: 1,
      warnings: [`FV/1/09/2026: nie można potwierdzić kompletności duplikatu KSeF ${N} (pozycje: niezgodna lub nieznana liczba)`],
    }));
    for (let run = 0; run < 3; run++) {
      if (run > 0) item().next_attempt_at = null;
      await runKsefHistorySyncTenant(event, ctx);
    }
    expect(m.engine).toHaveBeenCalledTimes(3);
    expect(m.engine.mock.calls.every(([params]) => params.catalogPolicy.contractors === 'skip')).toBe(true);
    expect(item()).toMatchObject({ status: 'blocked', reason_code: 'save_failed', attempts: 3 });
  });

  it('awaria po zapisie silnika i ponowienie → `imported` bez drugiego wywołania silnika', async () => {
    db.failures.add('ksef_history_items:update');
    await expect(runKsefHistorySyncTenant(event, ctx)).rejects.toThrow();
    expect(m.engine).toHaveBeenCalledTimes(1);
    db.failures.clear();
    await runKsefHistorySyncTenant(event, ctx);
    expect(m.engine).toHaveBeenCalledTimes(1);
    expect(item()).toMatchObject({ status: 'imported', invoice_id: `inv-${N}` });
  });
});

describe('budżet pobrań, odstęp i termin', () => {
  const pending = (n: number) => Array.from({ length: n }, (_, i) => itemRow({
    tenant_id: TENANT, ksef_number: `${NIP}-20260910-${String(i).padStart(12, '0')}-01`,
    invoice_number: 'FV/1/09/2026', issue_date: `2026-09-${String(10 + (i % 10)).padStart(2, '0')}`,
  }));

  it('dzień: najwyżej 5 pobrań, co 6 s (4 odstępy); najnowsze pierwsze', async () => {
    db.tables.ksef_history_items = pending(8);
    await runKsefHistorySyncTenant(event, ctx);
    expect(downloads()).toHaveLength(5);
    expect(ctx.step.sleep).toHaveBeenCalledTimes(4);
    expect(ctx.step.sleep).toHaveBeenCalledWith('history-download-spacing', 6000);
    const issueDates = downloads().map(([path]) => String(path).split('/').pop()!)
      .map((n) => rows('ksef_history_items').find((r) => r.ksef_number === decodeURIComponent(n))!.issue_date);
    expect([...issueDates]).toEqual([...issueDates].sort().reverse());
  });

  it('noc: najwyżej 10 pobrań', async () => {
    setNow(NIGHT_NOW);
    for (const s of rows('ksef_history_sync')) s.live_checked_at = '2026-10-22T20:59:00.000Z';
    db.tables.ksef_history_items = pending(12);
    await runKsefHistorySyncTenant(event, ctx);
    expect(downloads()).toHaveLength(10);
  });

  it('po 90 s od startu — bez nowych wywołań KSeF', async () => {
    sleepAdvanceMs = 40_000;
    db.tables.ksef_history_items = pending(5);
    await runKsefHistorySyncTenant(event, ctx);
    expect(downloads()).toHaveLength(3);
  });

  it('XML skrzynki w drodze — w tym przebiegu bez pobrań', async () => {
    db.tables.ksef_history_items = pending(3);
    db.tables.invoices = [{ tenant_id: TENANT, direction: 'incoming', created_at: '2026-10-22T09:30:00.000Z', fa3_data: { _pendingFullFetch: true } }];
    await runKsefHistorySyncTenant(event, ctx);
    expect(downloads()).toEqual([]);
  });

  it('429 przy pobraniu — pauza firmy, pozycja bez zmian (bez liczenia próby)', async () => {
    db.tables.ksef_history_items = pending(3);
    m.fetch.mockImplementationOnce(async () => {
      throw new KsefApiError(429, '', 'KSeF API GET /invoices/ksef/x failed: 429', 120_000);
    });
    await expect(runKsefHistorySyncTenant(event, ctx)).resolves.toMatchObject({ stopped: 'pause', downloads: 1 });
    expect(rows('ksef_history_items').every((r) => r.status === 'pending' && r.attempts === 0)).toBe(true);
    expect(rows('ksef_history_sync').find((s) => s.direction === 'outgoing')).toMatchObject({
      paused_until: '2026-10-22T10:02:00.000Z', rate_limit_hits: 1,
    });
  });
});

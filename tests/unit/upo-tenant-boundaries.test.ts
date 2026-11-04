import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobContext } from '@/lib/jobs/registry';

type Row = Record<string, unknown>;
type Query = { table: string; operation: 'select' | 'insert' | 'update'; filters: Array<[string, unknown]>; patch?: Row; columns?: string };
const mocks = vi.hoisted(() => ({ admin: vi.fn(), download: vi.fn(), xml: vi.fn(), pdf: vi.fn(), render: vi.fn(), audit: vi.fn(), sentry: vi.fn() }));
vi.mock('@/lib/ksef/submission-log', () => ({
  // A2: bez zamiarów wysyłki do rozstrzygnięcia — runner idzie jak dotąd.
  findOpenKsefSubmissionIntents: vi.fn(async () => []),
  promoteKsefSubmissionIntent: vi.fn(async () => false),
  abandonKsefSubmissionIntent: vi.fn(),
  recordKsefSubmissionIntent: vi.fn(),
  // D-A4-1: weryfikacja cudzego 440 — domyślnie bez sesji w historii i bez znanego numeru.
  findKsefSessionRow: vi.fn(async () => null),
  findSubmissionPayloads: vi.fn(async () => []),
  findTenantInvoiceByKsefNumber: vi.fn(async () => null),
  closeKsefAttempt: vi.fn(),
  markKsefSubmissionsNumberTaken: vi.fn(),
  recordKsefDuplicateCheck: vi.fn(),
  recordKsefAcceptedSession: vi.fn(),
  markKsefAttemptDuplicatePending: vi.fn(),
  recordKsefSubmissionSent: vi.fn(),
  markKsefSubmission: vi.fn(),
  findOpenKsefSubmission: vi.fn(async () => null),
  isOwnKsefSession: vi.fn(async () => false),
  findSessionReferenceForKsefNumber: vi.fn(async () => 'SESJA-TEST'),
}));
vi.mock('@/lib/supabase/server', () => ({ createAdminClient: mocks.admin }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: mocks.admin }));
vi.mock('@/lib/ksef/upo-client', () => ({ downloadUpoFromKsef: mocks.download }));
vi.mock('@/lib/ksef/upo-storage', () => ({ uploadUpoXml: mocks.xml, uploadUpoPdf: mocks.pdf }));
vi.mock('@/lib/ksef/upo-pdf-generator', () => ({ generateUpoPdf: mocks.render }));
vi.mock('@/lib/audit/log-system', () => ({ logAuditSystem: mocks.audit }));
vi.mock('@sentry/nextjs', () => ({ captureMessage: mocks.sentry, addBreadcrumb: vi.fn() }));
import { runDownloadUpo } from '@/lib/jobs/runners/download-upo';
import { runUpoRetryStale } from '@/lib/jobs/runners/upo-retry-stale';
import { UPO_IDENTITY_MISMATCH } from '@/lib/jobs/runners/upo-identity';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const RECEIPT = '33333333-3333-4333-8333-333333333333';
const REF = 'TEST-UPO-REFERENCE';
const event = { invoiceId: ID, tenantId: A, ksefNumber: REF, nip: '1234567890', environment: 'test' as const };
const invoice = (patch: Row = {}): Row => ({ id: ID, tenant_id: A, ksef_number: REF, ksef_status: 'accepted', ksef_environment: 'test',
  internal_number: 'TEST-1', issue_date: '2026-01-01', gross_total: 123, buyer_data: { name: 'Test buyer' },
  buyer_nip: '1234567890', seller_nip: '1234567890', tenants: { id: A, name: 'Test seller', nip: '1234567890' }, ...patch });
const oldInvoice = (patch: Row = {}): Row => invoice({
  direction: 'outgoing', created_at: '2000-01-01', updated_at: '2000-01-01',
  ksef_accepted_at: '2000-01-01', submitted_to_ksef_at: '2000-01-01', ...patch,
});
const receipt = (patch: Row = {}): Row => ({ id: RECEIPT, tenant_id: A, invoice_id: ID, ksef_number: REF, ksef_environment: 'test',
  status: 'pending', download_attempts: 0, last_error: null, created_at: '2000-01-01', ...patch });
let tables: Record<string, Row[]>;
/**
 * Lustro `public.ksef_upo_expected(invoices)` z 00155 (decyzja Bartosza
 * 22.10.2026): UPO tylko dla faktur wysłanych sesją FaktWay; wiersz z historii
 * KSeF (`origin = ksef_import`) — tylko gdy wskazuje go nasza próba wysyłki.
 */
function upoExpected(inv: Row | undefined): boolean {
  if (!inv) return false;
  if (inv.origin !== 'ksef_import') return true;
  return (tables.ksef_submissions ?? []).some((s) => s.tenant_id === inv.tenant_id && (s.invoice_id === inv.id
    || (inv.ksef_number != null && (s.response_ksef_number === inv.ksef_number || s.original_ksef_number === inv.ksef_number))));
}
let errors: Set<string>;
let calls: Query[];
let beforeQuery: ((query: Query) => void) | undefined;
const writes = () => calls.filter((q) => q.operation !== 'select');
function client() {
  return { from(table: string) {
    const q: Query = { table, operation: 'select', filters: [] };
    calls.push(q);
    const predicates: Array<(r: Row) => boolean> = [];
    let one = false;
    let max = Infinity;
    let joinInvoice = false;
    let ordered = false;
    let orderBy = 'created_at';
    const execute = () => {
      beforeQuery?.(q);
      if (errors.has(table)) return { data: null, error: { message: 'PRIVATE-DB-DIAGNOSTIC' } };
      let rows = (tables[table] ?? []).filter((r) => predicates.every((check) => check(r)));
      if (ordered) rows = rows.toSorted((a, b) => String(a[orderBy]).localeCompare(String(b[orderBy])));
      rows = rows.slice(0, max);
      if (q.operation === 'insert') {
        // Real schema has UNIQUE(invoice_id), including foreign-tenant records.
        if ((tables[table] ?? []).some((r) => r.invoice_id === q.patch?.invoice_id)) {
          return { data: null, error: { message: 'PRIVATE-UNIQUE-ERROR' } };
        }
        const inserted = receipt({ ...q.patch });
        (tables[table] ??= []).push(inserted);
        rows = [inserted];
      }
      if (q.operation === 'update') rows.forEach((r) => Object.assign(r, q.patch));
      const result = rows.map((r) => ({ ...r, ...(joinInvoice ? {
        invoices: tables.invoices.find((inv) => inv.id === r.invoice_id) ?? null,
      } : {}) }));
      return { data: one ? result[0] ?? null : result, error: null };
    };
    const builder = {
      select: (cols = '') => { q.columns = cols; joinInvoice = /invoices(!inner)?\(/.test(cols); return builder; },
      // Pole wyliczane PostgREST (00155): `.filter('ksef_upo_expected','eq','true')`
      // na fakturach i `.filter('invoices.ksef_upo_expected', …)` na osadzeniu `invoices!inner`.
      filter: (column: string, operator: string, value: unknown) => {
        expect(operator).toBe('eq'); expect(value).toBe('true');
        q.filters.push([`filter:${column}`, value]);
        if (column === 'ksef_upo_expected') {
          expect(q.table).toBe('invoices');
          predicates.push((r) => upoExpected(r));
        } else if (column === 'invoices.ksef_upo_expected') {
          expect(q.table).toBe('upo_receipts'); expect(q.columns).toContain('invoices!inner(');
          predicates.push((r) => upoExpected((tables.invoices ?? []).find((inv) => inv.id === r.invoice_id)));
        } else throw new Error(`Unexpected computed filter: ${column}`);
        return builder;
      },
      eq: (key: string, value: unknown) => { q.filters.push([key, value]); predicates.push((r) => r[key] === value); return builder; },
      gt: (key: string, value: string) => { q.filters.push([key, value]); predicates.push((r) => String(r[key]) > value); return builder; },
      in: (key: string, value: unknown[]) => { q.filters.push([key, value]); predicates.push((r) => value.includes(r[key])); return builder; },
      lt: (key: string, value: string) => { predicates.push((r) => String(r[key]) < value); return builder; },
      not: (key: string, operator: string, value: unknown) => {
        expect(operator).toBe('is'); expect(value).toBeNull();
        predicates.push((r) => r[key] != null); return builder;
      },
      is: (key: string, value: unknown) => {
        expect(value).toBeNull();
        if (key === 'upo_receipts') {
          expect(q.table).toBe('invoices'); expect(q.columns).toContain('upo_receipts()');
          predicates.push((r) => !(tables.upo_receipts ?? []).some((receiptRow) => receiptRow.invoice_id === r.id));
        } else if (key === 'ksef_accepted_at') {
          predicates.push((r) => r.ksef_accepted_at == null);
        } else throw new Error(`Unexpected is filter: ${key}`);
        return builder;
      },
      or: (filter: string) => {
        if (filter === 'last_error.is.null,last_error.neq.' + UPO_IDENTITY_MISMATCH) {
          predicates.push((r) => r.last_error == null || r.last_error !== UPO_IDENTITY_MISMATCH);
        } else if (filter.startsWith('submitted_to_ksef_at.lt.') && filter.includes(',and(submitted_to_ksef_at.is.null,or(updated_at.lt.')) {
          const [submittedCutoff, remainder] = filter.slice('submitted_to_ksef_at.lt.'.length).split(',and(submitted_to_ksef_at.is.null,or(updated_at.lt.');
          const updatedCutoff = remainder.slice(0, -',updated_at.is.null))'.length);
          predicates.push((r) =>
            (r.submitted_to_ksef_at != null && String(r.submitted_to_ksef_at) < submittedCutoff) ||
            (r.submitted_to_ksef_at == null && (r.updated_at == null || String(r.updated_at) < updatedCutoff)));
        } else throw new Error(`Unexpected or filter: ${filter}`);
        return builder;
      },
      order: (key: string) => { ordered = true; orderBy = key; return builder; },
      limit: (n: number) => { max = n; return builder; },
      update: (patch: Row) => { q.operation = 'update'; q.patch = patch; return builder; },
      insert: (patch: Row) => { q.operation = 'insert'; q.patch = patch; return builder; },
      maybeSingle: () => { one = true; return Promise.resolve(execute()); },
      single: () => { one = true; return Promise.resolve(execute()); },
      then: <T = ReturnType<typeof execute>, E = never>(resolve?: ((v: ReturnType<typeof execute>) => T | PromiseLike<T>) | null,
        reject?: ((e: unknown) => E | PromiseLike<E>) | null) => Promise.resolve(execute()).then(resolve, reject),
    };
    return builder;
  } };
}
const sendEvent = vi.fn();
const context: JobContext = { attempt: 0, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  step: { run: async (_name, fn) => fn(), sleep: vi.fn(), sendEvent, scheduleAfter: vi.fn() } };
function cachedContext(cache: Record<string, unknown>): JobContext {
  return { ...context, step: { ...context.step, run: async <T>(name: string, fn: () => T | Promise<T>): Promise<T> =>
    name in cache ? cache[name] as T : fn() } };
}
function expectNoExternalEffects() {
  for (const mock of [mocks.download, mocks.xml, mocks.pdf, mocks.render, mocks.audit]) expect(mock).not.toHaveBeenCalled();
  expect(sendEvent).not.toHaveBeenCalled();
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('KSEF_ENV', 'test'); calls = []; errors = new Set(); beforeQuery = undefined;
  tables = { invoices: [invoice()], upo_receipts: [] };
  mocks.admin.mockImplementation(client);
  mocks.download.mockResolvedValue({ success: true, upoXml: '<test/>', upoXmlHash: 'hash', upoId: 'test-upo', acceptanceTimestamp: '2026-01-01' });
  mocks.xml.mockResolvedValue('upo/' + A + '/' + ID + '.xml');
  mocks.render.mockResolvedValue(Buffer.from('test-pdf'));
  mocks.pdf.mockResolvedValue('upo/' + A + '/' + ID + '.pdf');
});
afterEach(() => vi.unstubAllEnvs());

describe('UPO worker boundaries', () => {
  it('rejects old or cross-environment UPO events before privileged reads', async () => {
    await expect(runDownloadUpo({ ...event, environment: 'demo' }, context)).rejects.toThrow('environment');
    await expect(runDownloadUpo({ ...event, environment: undefined } as unknown as typeof event, context)).rejects.toThrow('environment');
    expect(mocks.admin).not.toHaveBeenCalled();
    expectNoExternalEffects();
  });
  it('rejects a legacy accepted invoice without environment provenance', async () => {
    tables.invoices = [invoice({ ksef_environment: null })];
    await expect(runDownloadUpo(event, context)).rejects.toThrow('zaakceptowanej');
    expect(writes()).toEqual([]);
    expectNoExternalEffects();
  });
  it('rejects a legacy downloaded UPO without environment provenance', async () => {
    tables.upo_receipts = [receipt({ ksef_environment: null, status: 'downloaded' })];
    await expect(runDownloadUpo(event, context)).rejects.toThrow('zaakceptowanej');
    expect(writes()).toEqual([]);
    expectNoExternalEffects();
  });
  it('rejects malformed event identity before privileged reads', async () => {
    await expect(runDownloadUpo({ ...event, invoiceId: 'invalid' }, context)).rejects.toThrow('tożsamość');
    expect(mocks.admin).not.toHaveBeenCalled(); expectNoExternalEffects();
  });
  it.each([{ tenant_id: B }, { ksef_number: 'OTHER' }, { ksef_status: 'sending' }])('blocks inconsistent accepted invoice %j before writes', async (patch) => {
    tables.invoices = [invoice(patch)];
    await expect(runDownloadUpo(event, context)).rejects.toThrow('zaakceptowanej');
    expect(writes()).toEqual([]); expectNoExternalEffects();
  });
  it('does not trust a foreign downloaded receipt or overwrite it', async () => {
    tables.upo_receipts = [receipt({ tenant_id: B, status: 'downloaded' })];
    await expect(runDownloadUpo(event, context)).rejects.toThrow('utworzyć');
    expect(tables.upo_receipts[0].tenant_id).toBe(B);
    expect(tables.upo_receipts[0].status).toBe('downloaded'); expectNoExternalEffects();
  });
  it('rejects an own receipt with the wrong KSeF reference even if marked downloaded', async () => {
    tables.upo_receipts = [receipt({ ksef_number: 'OTHER', status: 'downloaded' })];
    await expect(runDownloadUpo(event, context)).rejects.toThrow('zaakceptowanej');
    expect(writes()).toEqual([]); expectNoExternalEffects();
  });
  it('validates the invoice before the already-downloaded fast path', async () => {
    tables.upo_receipts = [receipt({ status: 'downloaded' })]; tables.invoices[0].tenant_id = B;
    await expect(runDownloadUpo(event, context)).rejects.toThrow('zaakceptowanej');
    expectNoExternalEffects(); expect(writes()).toEqual([]);
  });
  it('preserves idempotent success for a verified downloaded receipt', async () => {
    tables.upo_receipts = [receipt({ status: 'downloaded' })];
    await expect(runDownloadUpo(event, context)).resolves.toMatchObject({ skipped: true });
    expectNoExternalEffects(); expect(writes()).toEqual([]);
  });
  it('fails closed on a transient invoice lookup failure without private diagnostics or mutation', async () => {
    errors.add('invoices');
    await expect(runDownloadUpo(event, context)).rejects.toThrow('Nie można sprawdzić faktury');
    expect(writes()).toEqual([]); expectNoExternalEffects();
  });
  it('rechecks a cached receipt against the current row before using a cached download', async () => {
    tables.upo_receipts = [receipt({ invoice_id: OTHER })];
    const cached = cachedContext({ 'upsert-upo-record': receipt(), 'download-from-ksef': { success: true, upoXml: '<cached/>' } });
    await expect(runDownloadUpo(event, cached)).rejects.toThrow('zaakceptowanej');
    expect(writes()).toEqual([]); expectNoExternalEffects();
  });
  it('rejects a cached upsert record from another organization before any effect', async () => {
    tables.upo_receipts = [receipt()];
    await expect(runDownloadUpo(event, cachedContext({ 'upsert-upo-record': receipt({ tenant_id: B }) }))).rejects.toThrow('zaakceptowanej');
    expect(writes()).toEqual([]); expectNoExternalEffects();
  });
  it('stops before storage if receipt ownership changes while KSeF is responding', async () => {
    tables.upo_receipts = [receipt()];
    mocks.download.mockImplementation(async () => {
      tables.upo_receipts[0].tenant_id = B;
      return { success: true, upoXml: '<test/>', upoXmlHash: 'hash', acceptanceTimestamp: '2026-01-01' };
    });
    await expect(runDownloadUpo(event, context)).rejects.toThrow('zaakceptowanej');
    expect(mocks.xml).not.toHaveBeenCalled(); expect(mocks.pdf).not.toHaveBeenCalled(); expect(mocks.audit).not.toHaveBeenCalled();
    expect(tables.upo_receipts[0].status).toBe('pending');
  });
  it('does not upload a PDF if the invoice changes during generation', async () => {
    mocks.render.mockImplementation(async () => { tables.invoices[0].tenant_id = B; return Buffer.from('test'); });
    await expect(runDownloadUpo(event, context)).rejects.toThrow('zaakceptowanej');
    expect(mocks.xml).toHaveBeenCalledTimes(1); expect(mocks.pdf).not.toHaveBeenCalled(); expect(mocks.audit).not.toHaveBeenCalled();
  });
  it('downloads and finalizes a valid receipt with every update scoped to all identity fields', async () => {
    await expect(runDownloadUpo(event, context)).resolves.toMatchObject({ success: true });
    // Numer sesji spoza zdarzenia — z historii wysyłek (AUD-17).
    expect(mocks.download).toHaveBeenCalledWith(A, REF, { invoiceId: ID, sessionReferenceNumber: 'SESJA-TEST' });
    expect(mocks.render).toHaveBeenCalledWith(expect.objectContaining({ sellerName: 'Test seller', buyerName: 'Test buyer' }));
    expect(tables.upo_receipts[0].status).toBe('downloaded');
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    for (const q of calls.filter((q) => q.table === 'invoices')) {
      for (const filter of [['id', ID], ['tenant_id', A], ['ksef_number', REF], ['ksef_status', 'accepted']]) expect(q.filters).toContainEqual(filter);
    }
    for (const q of writes().filter((q) => q.operation === 'update')) {
      for (const filter of [['id', RECEIPT], ['tenant_id', A], ['invoice_id', ID], ['ksef_number', REF]]) expect(q.filters).toContainEqual(filter);
    }
  });
  it('keeps retriable download failures and attempt accounting bounded to the receipt', async () => {
    tables.upo_receipts = [receipt({ status: 'failed', download_attempts: 3 })];
    mocks.download.mockResolvedValue({ success: false, error: 'test-downstream-failure', retryable: true });
    await expect(runDownloadUpo(event, context)).rejects.toThrow('test-downstream-failure');
    expect(tables.upo_receipts[0]).toMatchObject({ status: 'failed', download_attempts: 4 });
    expect(mocks.xml).not.toHaveBeenCalled(); expect(mocks.audit).not.toHaveBeenCalled();
  });
  it('can resume a corrected quarantined receipt only after complete validation', async () => {
    tables.upo_receipts = [receipt({ status: 'failed', last_error: UPO_IDENTITY_MISMATCH })];
    await runDownloadUpo(event, context);
    expect(tables.upo_receipts[0]).toMatchObject({ status: 'downloaded', last_error: null });
  });
});

describe('UPO retry cron boundaries', () => {
  // 00155 (decyzja Bartosza 22.10.2026): historia z KSeF nie ma UPO — przed
  // poprawką cron co godzinę zlecał pobranie UPO dla każdej takiej faktury.
  it('does not request UPO for an accepted invoice downloaded from KSeF history without our send', async () => {
    tables.invoices = [oldInvoice({ origin: 'ksef_import' })];
    await expect(runUpoRetryStale(context)).resolves.toMatchObject({ missing: 0, dispatched: 0 });
    expectNoExternalEffects();
    expect(calls.filter((q) => q.table === 'invoices' && q.operation === 'select')
      .every((q) => q.filters.some(([key]) => key === 'filter:ksef_upo_expected'))).toBe(true);
  });
  it('still requests UPO for a KSeF-history row linked to our send (440 original, PR C)', async () => {
    tables.invoices = [oldInvoice({ origin: 'ksef_import' })];
    tables.ksef_submissions = [{ tenant_id: A, invoice_id: OTHER, original_ksef_number: REF, response_ksef_number: null }];
    await expect(runUpoRetryStale(context)).resolves.toMatchObject({ missing: 1, dispatched: 1 });
  });
  it('does not retry a stale receipt of a KSeF-history invoice (embedded computed filter)', async () => {
    tables.invoices = [oldInvoice({ origin: 'ksef_import' })];
    tables.upo_receipts = [receipt()];
    await expect(runUpoRetryStale(context)).resolves.toMatchObject({ dispatched: 0 });
    expect(sendEvent).not.toHaveBeenCalled();
    const scan = calls.find((q) => q.table === 'upo_receipts' && q.columns?.includes('invoices!inner('));
    expect(scan?.filters).toContainEqual(['filter:invoices.ksef_upo_expected', 'true']);
  });
  it('finds an old accepted outgoing invoice without a receipt after the submit event was lost', async () => {
    tables.invoices = [oldInvoice()];
    await expect(runUpoRetryStale(context)).resolves.toMatchObject({ missing: 1, dispatched: 1 });
    expect(sendEvent).toHaveBeenCalledWith('re-request-upo', [
      { name: 'invoice/upo.requested', groupId: '1234567890', data: event },
    ]);
    expect(writes()).toEqual([]);
  });
  it('does not let accepted incoming, foreign-environment or fresh invoices generate UPO events', async () => {
    tables.invoices = [
      oldInvoice({ direction: 'incoming' }),
      oldInvoice({ id: OTHER, ksef_environment: 'demo' }),
      oldInvoice({ id: RECEIPT, ksef_accepted_at: new Date().toISOString() }),
    ];
    await expect(runUpoRetryStale(context)).resolves.toMatchObject({ dispatched: 0 });
    expectNoExternalEffects();
  });
  it.each([
    { seller_nip: null },
    { tenants: { id: A, nip: '9999999999' } },
  ])('requires a stored seller NIP consistent with the current tenant before emitting: %j', async (patch) => {
    tables.invoices = [oldInvoice(patch)];
    await expect(runUpoRetryStale(context)).resolves.toMatchObject({ missing: 1, dispatched: 0 });
    expect(sendEvent).not.toHaveBeenCalled();
    expect(mocks.sentry).toHaveBeenCalledWith(expect.stringContaining('NIP requires reconciliation'),
      expect.objectContaining({ level: 'warning' }));
  });
  it('recovers historical accepted rows with no acceptance timestamp only after their last known timestamp is old', async () => {
    tables.invoices = [oldInvoice({ ksef_accepted_at: null })];
    await expect(runUpoRetryStale(context)).resolves.toMatchObject({ dispatched: 1 });
    expect(sendEvent).toHaveBeenCalledTimes(1);
    sendEvent.mockClear();
    tables.invoices[0].submitted_to_ksef_at = null;
    tables.invoices[0].updated_at = new Date().toISOString();
    await expect(runUpoRetryStale(context)).resolves.toMatchObject({ dispatched: 0 });
    expect(sendEvent).not.toHaveBeenCalled();
  });
  it('uses a historical submit timestamp despite daily later updates', async () => {
    tables.invoices = [oldInvoice({ ksef_accepted_at: null, updated_at: new Date().toISOString() })];
    await expect(runUpoRetryStale(context)).resolves.toMatchObject({ missing: 1, dispatched: 1 });
    expect(sendEvent).toHaveBeenCalledWith('re-request-upo', [
      { name: 'invoice/upo.requested', groupId: '1234567890', data: event },
    ]);
  });
  it('filters freshly updated legacy rows before the page limit so they cannot starve an older missing UPO', async () => {
    tables.invoices = Array.from({ length: 100 }, (_, index) => oldInvoice({
      id: '44444444-4444-4444-8444-' + String(index).padStart(12, '0'),
      ksef_accepted_at: null, submitted_to_ksef_at: null, updated_at: new Date().toISOString(),
    }));
    tables.invoices.push(oldInvoice({ id: OTHER, ksef_accepted_at: null }));
    await expect(runUpoRetryStale(context)).resolves.toMatchObject({ missing: 1, dispatched: 1 });
    expect(sendEvent).toHaveBeenCalledWith('re-request-upo', [
      { name: 'invoice/upo.requested', groupId: '1234567890', data: { ...event, invoiceId: OTHER } },
    ]);
  });
  it('filters a recent historical submit before the page limit even with old created and updated times', async () => {
    tables.invoices = Array.from({ length: 100 }, (_, index) => oldInvoice({
      id: '44444444-4444-4444-8444-' + String(index).padStart(12, '0'),
      ksef_accepted_at: null, submitted_to_ksef_at: new Date().toISOString(),
    }));
    tables.invoices.push(oldInvoice({ id: OTHER, ksef_accepted_at: null }));
    await expect(runUpoRetryStale(context)).resolves.toMatchObject({ missing: 1, dispatched: 1 });
    expect(sendEvent).toHaveBeenCalledWith('re-request-upo', [
      { name: 'invoice/upo.requested', groupId: '1234567890', data: { ...event, invoiceId: OTHER } },
    ]);
  });
  it('anti-joins receipts before limiting the batch so old completed UPOs do not starve a missing one', async () => {
    tables.invoices = Array.from({ length: 100 }, (_, index) => oldInvoice({
      id: '44444444-4444-4444-8444-' + String(index).padStart(12, '0'),
    }));
    tables.upo_receipts = tables.invoices.map((row, index) => receipt({
      id: '55555555-5555-4555-8555-' + String(index).padStart(12, '0'),
      invoice_id: row.id, status: 'downloaded',
    }));
    tables.invoices.push(oldInvoice({ id: OTHER }));
    await expect(runUpoRetryStale(context)).resolves.toMatchObject({ missing: 1, dispatched: 1 });
    expect(sendEvent).toHaveBeenCalledWith('re-request-upo', [
      { name: 'invoice/upo.requested', groupId: '1234567890', data: { ...event, invoiceId: OTHER } },
    ]);
  });
  it('reserves dispatch capacity for a missing UPO even when stale receipts fill their page', async () => {
    tables.invoices = Array.from({ length: 50 }, (_, index) => oldInvoice({
      id: '44444444-4444-4444-8444-' + String(index).padStart(12, '0'),
    }));
    tables.upo_receipts = tables.invoices.map((row, index) => receipt({
      id: '55555555-5555-4555-8555-' + String(index).padStart(12, '0'),
      invoice_id: row.id,
    }));
    tables.invoices.push(oldInvoice({ id: OTHER }));
    await expect(runUpoRetryStale(context)).resolves.toMatchObject({ missing: 1, dispatched: 51 });
    const batch = sendEvent.mock.calls[0][1] as Array<{ data: { invoiceId: string } }>;
    expect(batch.some((item) => item.data.invoiceId === OTHER)).toBe(true);
  });
  it('reserves a legacy missing-receipt page when known acceptance dates fill their allocation', async () => {
    tables.invoices = Array.from({ length: 75 }, (_, index) => oldInvoice({
      id: '44444444-4444-4444-8444-' + String(index).padStart(12, '0'),
    }));
    tables.invoices.push(oldInvoice({ id: OTHER, ksef_accepted_at: null }));
    await expect(runUpoRetryStale(context)).resolves.toMatchObject({ dispatched: 76 });
    const batch = sendEvent.mock.calls[0][1] as Array<{ data: { invoiceId: string } }>;
    expect(batch.some((item) => item.data.invoiceId === OTHER)).toBe(true);
  });
  it.each([false, true])('keyset scans past more than one page of wrong NIPs (legacy=%s)', async (legacy) => {
    const lateId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    tables.invoices = Array.from({ length: 80 }, (_, index) => oldInvoice({
      id: '44444444-4444-4444-8444-' + String(index).padStart(12, '0'),
      ksef_accepted_at: legacy ? null : '2000-01-01',
      seller_nip: null,
    }));
    tables.invoices.push(oldInvoice({ id: lateId, ksef_accepted_at: legacy ? null : '2000-01-01' }));
    await expect(runUpoRetryStale(context)).resolves.toMatchObject({ missing: 81, dispatched: 1, scanTruncated: false });
    expect(sendEvent).toHaveBeenCalledWith('re-request-upo', [
      { name: 'invoice/upo.requested', groupId: '1234567890', data: { ...event, invoiceId: lateId } },
    ]);
    expect(mocks.sentry).toHaveBeenCalledTimes(1);
    expect(mocks.sentry).toHaveBeenCalledWith(expect.stringContaining('NIP requires reconciliation'),
      expect.objectContaining({ extra: { count: 80 } }));
  });
  it('alerts when the bounded missing-receipt scan reaches its limit', async () => {
    tables.invoices = Array.from({ length: 201 }, (_, index) => oldInvoice({
      id: '44444444-4444-4444-8444-' + String(index).padStart(12, '0'),
      seller_nip: null,
    }));
    await expect(runUpoRetryStale(context)).resolves.toMatchObject({
      missing: 200, dispatched: 0, scanTruncated: true,
    });
    expect(sendEvent).not.toHaveBeenCalled();
    expect(mocks.sentry).toHaveBeenCalledWith(
      expect.stringContaining('scan truncated'), expect.objectContaining({ level: 'warning' }),
    );
  });
  it.each([
    { direction: 'incoming' }, { tenant_id: B }, { ksef_environment: 'demo' },
    { ksef_status: 'sending' }, { ksef_number: 'DIFFERENT' },
  ])('rejects a cached missing-receipt candidate after its invoice changes: %j', async (patch) => {
    const candidate = { id: ID, tenant_id: A, ksef_number: REF };
    tables.invoices = [oldInvoice(patch)];
    await expect(runUpoRetryStale(cachedContext({ 'find-accepted-without-upo': [candidate] })))
      .resolves.toMatchObject({ dispatched: 0 });
    expectNoExternalEffects();
  });
  it('skips a receipt created after the anti-join snapshot, including one from another environment', async () => {
    tables.invoices = [oldInvoice()];
    beforeQuery = (q) => {
      if (q.table === 'upo_receipts' && q.filters.some(([key]) => key === 'invoice_id')) {
        tables.upo_receipts = [receipt({ ksef_environment: 'demo' })];
      }
    };
    await expect(runUpoRetryStale(context)).resolves.toMatchObject({ missing: 1, dispatched: 0 });
    expect(sendEvent).not.toHaveBeenCalled();
  });
  it('stops a missing-receipt recovery when the invoice or receipt recheck fails', async () => {
    tables.invoices = [oldInvoice()];
    beforeQuery = (q) => {
      if (q.table === 'invoices' && q.filters.some(([key]) => key === 'id')) errors.add('invoices');
    };
    await expect(runUpoRetryStale(context)).rejects.toThrow('zaakceptowanej faktury');
    expect(sendEvent).not.toHaveBeenCalled();
    beforeQuery = (q) => {
      if (q.table === 'upo_receipts' && q.filters.some(([key]) => key === 'invoice_id')) errors.add('upo_receipts');
    };
    errors.clear();
    await expect(runUpoRetryStale(context)).rejects.toThrow('rekordu UPO faktury');
    expect(sendEvent).not.toHaveBeenCalled();
  });
  it.each(['', ' '.repeat(3), 'X'.repeat(201)])('quarantines a freshly confirmed malformed reference without blocking its valid neighbor', async (ksef_number) => {
    tables.invoices = [invoice(), invoice({ id: OTHER })];
    tables.upo_receipts = [receipt({ ksef_number }), receipt({ id: OTHER, invoice_id: OTHER })];
    await expect(runUpoRetryStale(context)).resolves.toMatchObject({ dispatched: 1, quarantined: 1 });
    expect(tables.upo_receipts[0].last_error).toBe(UPO_IDENTITY_MISMATCH);
    expect(sendEvent).toHaveBeenCalledWith('re-request-upo', [{ name: 'invoice/upo.requested', groupId: event.nip, data: { ...event, invoiceId: OTHER } }]);
  });
  it('lets a valid receipt past malformed pages on a later run', async () => {
    tables.invoices = [invoice(), invoice({ id: OTHER })];
    tables.upo_receipts = Array.from({ length: 100 }, (_, i) => receipt({ id: '44444444-4444-4444-8444-' + String(i).padStart(12, '0'), ksef_number: '' }));
    tables.upo_receipts.push(receipt({ id: OTHER, invoice_id: OTHER }));
    await expect(runUpoRetryStale(context)).resolves.toMatchObject({ processed: 50, quarantined: 50, dispatched: 0 });
    await expect(runUpoRetryStale(context)).resolves.toMatchObject({ processed: 50, quarantined: 50, dispatched: 0 });
    await expect(runUpoRetryStale(context)).resolves.toMatchObject({ processed: 1, quarantined: 0, dispatched: 1 });
  });
  it('skips impossible cached UUIDs without blocking valid candidates or writing unknown rows', async () => {
    tables.upo_receipts = [receipt()];
    const valid = { ...receipt(), invoices: invoice() };
    await expect(runUpoRetryStale(cachedContext({ 'find-stale-upo': [{ ...valid, id: 'bad' }, valid] }))).resolves.toMatchObject({ dispatched: 1, quarantined: 0 });
    expect(writes()).toEqual([]);
  });

  it('quarantines a confirmed wrong-tenant relation and dispatches the valid neighboring receipt', async () => {
    tables.invoices = [invoice({ tenant_id: B }), invoice({ id: OTHER })];
    tables.upo_receipts = [receipt(), receipt({ id: OTHER, invoice_id: OTHER })];
    await expect(runUpoRetryStale(context)).resolves.toMatchObject({ dispatched: 1, quarantined: 1 });
    expect(tables.upo_receipts[0]).toMatchObject({ status: 'failed', last_error: UPO_IDENTITY_MISMATCH });
    expect(sendEvent).toHaveBeenCalledWith('re-request-upo', [{ name: 'invoice/upo.requested', groupId: event.nip, data: { ...event, invoiceId: OTHER } }]);
    expect(writes()[0].filters).toEqual([['id', RECEIPT], ['tenant_id', A], ['invoice_id', ID], ['ksef_number', REF], ['status', 'pending']]);
  });
  it.each([{ ksef_number: 'OTHER' }, { ksef_status: 'sending' }])('never dispatches a receipt whose invoice changed: %j', async (patch) => {
    tables.invoices = [invoice(patch)]; tables.upo_receipts = [receipt()];
    await expect(runUpoRetryStale(context)).resolves.toMatchObject({ dispatched: 0, quarantined: 1 });
    expect(sendEvent).not.toHaveBeenCalled();
  });
  it('does not starve a valid receipt behind fully invalid pages', async () => {
    tables.invoices = [invoice({ tenant_id: B }), invoice({ id: OTHER })];
    tables.upo_receipts = Array.from({ length: 100 }, (_, i) => receipt({ id: '44444444-4444-4444-8444-' + String(i).padStart(12, '0') }));
    tables.upo_receipts.push(receipt({ id: OTHER, invoice_id: OTHER }));
    await expect(runUpoRetryStale(context)).resolves.toMatchObject({ processed: 50, quarantined: 50, dispatched: 0 });
    await expect(runUpoRetryStale(context)).resolves.toMatchObject({ processed: 50, quarantined: 50, dispatched: 0 });
    await expect(runUpoRetryStale(context)).resolves.toMatchObject({ processed: 1, quarantined: 0, dispatched: 1 });
    expect(sendEvent).toHaveBeenCalledTimes(1);
  });
  it('never quarantines or dispatches when invoice verification is unavailable', async () => {
    tables.upo_receipts = [receipt()]; errors.add('invoices');
    await expect(runUpoRetryStale(context)).rejects.toThrow('Nie można sprawdzić faktury');
    expect(writes()).toEqual([]); expect(sendEvent).not.toHaveBeenCalled();
    expect(tables.upo_receipts[0].status).toBe('pending');
  });
  it('does not trust an old cached joined invoice after the database relation changes', async () => {
    const candidate = { ...receipt(), invoices: invoice() };
    tables.upo_receipts = [receipt()]; tables.invoices[0].tenant_id = B;
    await expect(runUpoRetryStale(cachedContext({ 'find-stale-upo': [candidate] }))).resolves.toMatchObject({ dispatched: 0, quarantined: 1 });
    expect(sendEvent).not.toHaveBeenCalled();
  });
  it('leaves a concurrently repaired receipt untouched by the quarantine write', async () => {
    tables.invoices = [invoice({ tenant_id: B }), invoice({ id: OTHER })];
    tables.upo_receipts = [receipt()];
    beforeQuery = (q) => {
      if (q.operation === 'update' && q.patch?.last_error === UPO_IDENTITY_MISMATCH) tables.upo_receipts[0].invoice_id = OTHER;
    };
    await expect(runUpoRetryStale(context)).resolves.toMatchObject({ quarantined: 0, dispatched: 0 });
    expect(tables.upo_receipts[0]).toMatchObject({ invoice_id: OTHER, status: 'pending', last_error: null });
    beforeQuery = undefined;
    await expect(runUpoRetryStale(context)).resolves.toMatchObject({ dispatched: 1 });
  });
  it('does not act on a cached candidate whose identity has already been repaired', async () => {
    const candidate = { ...receipt(), invoices: invoice({ tenant_id: B }) };
    tables.invoices = [invoice({ id: OTHER })]; tables.upo_receipts = [receipt({ invoice_id: OTHER })];
    await expect(runUpoRetryStale(cachedContext({ 'find-stale-upo': [candidate] }))).resolves.toMatchObject({ quarantined: 0, dispatched: 0 });
    expect(writes()).toEqual([]); expect(sendEvent).not.toHaveBeenCalled();
  });
  it('does not turn a receipt-query outage into a permanent marker', async () => {
    const candidate = { ...receipt(), invoices: invoice({ tenant_id: B }) };
    errors.add('upo_receipts');
    await expect(runUpoRetryStale(cachedContext({ 'find-stale-upo': [candidate] }))).rejects.toThrow('ponownie sprawdzić');
    expect(writes()).toEqual([]); expect(sendEvent).not.toHaveBeenCalled();
  });
});

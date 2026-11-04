import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobContext } from '@/lib/jobs/registry';
import type { Invoice } from '@/types/invoice';
import type { AdvanceInvoiceData } from '@/types/invoice-types';
import { sellerPartyFromSellerData } from '@/lib/invoices/map-buyer-party';
import { KsefApiError } from '@/lib/ksef/client';

type Row = Record<string, unknown>;
type Query = {
  table: string; operation: string; filters: Array<[string, unknown]>;
  exclusions?: Array<[string, unknown]>; inclusions?: Array<[string, unknown[]]>;
  nullableNonAccepted?: boolean; patch?: Row;
};
const mocks = vi.hoisted(() => ({
  admin: vi.fn(), download: vi.fn(), xml: vi.fn(), parseFa3Xml: vi.fn(), process: vi.fn(),
  photo: vi.fn(), ocr: vi.fn(), push: vi.fn(), email: vi.fn(), proposal: vi.fn(),
  health: vi.fn(), submit: vi.fn(), audit: vi.fn(), credentials: vi.fn(), offlineAdd: vi.fn(),
}));
vi.mock('@/lib/supabase/server', () => ({ createAdminClient: mocks.admin }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: mocks.admin }));
vi.mock('@/lib/import/file-storage', () => ({ downloadImportFile: mocks.download }));
vi.mock('@/lib/ksef/history-fetcher', () => ({ fetchInvoiceXmlBytes: mocks.xml }));
vi.mock('@/lib/import/ksef-xml-archive', () => ({
  archiveImportedKsefXml: async (tenantId: string, ksefNumber: string, bytes: Buffer) => ({
    storagePath: `${tenantId}/ksef-import/${ksefNumber}.xml`, sha256Hash: 'a'.repeat(64), sizeBytes: bytes.length,
  }),
  decodeKsefXml: (bytes: Buffer) => bytes.toString('utf8'),
}));
vi.mock('@/lib/import/fa3-parser', () => ({ parseFa3Xml: mocks.parseFa3Xml }));
vi.mock('@/lib/import/import-engine', () => ({ processImportedInvoices: mocks.process }));
vi.mock('@/lib/storage/expenses', () => ({ downloadExpensePhoto: mocks.photo }));
vi.mock('@/lib/ocr/engine', () => ({ extractInvoiceFromImage: mocks.ocr }));
vi.mock('@/lib/push/sender', () => ({ sendPushToUser: mocks.push, sendPushToTenant: vi.fn(async () => ({ sent: 0, failed: 0 })) }));
// AUD-15: alarm po terminie Offline24 (process-offline-queue) — bez sieci w teście.
vi.mock('@/lib/alerts/slack', () => ({ alertCritical: vi.fn(async () => undefined) }));
vi.mock('@/lib/email/send', () => ({ sendInvoiceAcceptedEmail: mocks.email, sendInvoiceFailedEmail: mocks.email }));
vi.mock('@/lib/flo/proposals', () => ({ createProposal: mocks.proposal }));
vi.mock('@/lib/ksef/health-check', () => ({ checkKsefAvailability: mocks.health, shouldUseOfflineMode: mocks.health }));
vi.mock('@/lib/ksef/submit-invoice-full', () => ({ submitInvoiceFullFlow: mocks.submit }));
vi.mock('@/lib/ksef/offline-queue', () => ({ addToOfflineQueue: mocks.offlineAdd }));
vi.mock('@/lib/audit/log-system', () => ({ logAuditSystem: mocks.audit }));
vi.mock('@/lib/analytics/server', () => ({ trackServer: vi.fn() }));
vi.mock('@/lib/categorization', () => ({ categorizeExpense: vi.fn() }));
vi.mock('@/lib/auth/ksef-verification-guard', () => ({
  requireKsefVerificationForBackgroundJob: vi.fn(),
  KsefNotVerifiedError: class KsefNotVerifiedError extends Error {},
}));
vi.mock('@/lib/xml/fa3-generator', () => ({ InvoiceValidationError: class InvoiceValidationError extends Error {} }));

import { requireInvoiceTenant, requireImportJobTenant } from '@/lib/jobs/runners/tenant-boundary';
import { getInvoiceForSubmit, updateInvoiceStatus } from '@/lib/supabase/admin-queries';
import { onBulkImportExhausted, runBulkImportFile } from '@/lib/jobs/runners/bulk-import';
import { runKsefHistorySyncTenant } from '@/lib/jobs/runners/ksef-history-sync';
import { runNotifySuccess, runNotifyFailure } from '@/lib/jobs/runners/notify-user';
import { runProcessOcr } from '@/lib/jobs/runners/process-ocr';
import { runSendReminder } from '@/lib/jobs/runners/send-reminder';
import { runProcessOfflineQueue, runOfflineQueueSuccess, runOfflineQueueFailure } from '@/lib/jobs/runners/process-offline-queue';
import { runSubmitInvoice, onSubmitInvoiceExhausted } from '@/lib/jobs/runners/submit-invoice';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
let tables: Record<string, Row[]>;
let errors: Set<string>;
let calls: Query[];
let beforeUpdate: (() => void) | null;
let claimHeldByOther = false;
const writes = () => calls.filter((q) => q.operation !== 'select');
function client() {
  return { from(table: string) {
    const q: Query = { table, operation: 'select', filters: [] };
    calls.push(q);
    let one = false;
    let maxRows = Infinity;
    let head = false;
    let orPredicate: ((row: Row) => boolean) | null = null;
    const execute = () => {
      if (errors.has(table)) return { data: null, error: { message: 'private-db-error' } };
      if (q.operation === 'update') beforeUpdate?.();
      const rows = (tables[table] ?? []).filter((row) =>
        q.filters.every(([key, val]) => (val === null ? row[key] == null : row[key] === val)) &&
        (q.exclusions ?? []).every(([key, val]) => row[key] != null && row[key] !== val) &&
        (q.inclusions ?? []).every(([key, vals]) => vals.includes(row[key])) &&
        (!q.nullableNonAccepted || row.ksef_status == null || row.ksef_status !== 'accepted') &&
        (!orPredicate || orPredicate(row))).slice(0, maxRows);
      if (q.operation === 'update') rows.forEach((row) => Object.assign(row, q.patch));
      if (q.operation === 'insert') { (tables[table] ??= []).push({ ...q.patch }); }
      // Supabase returns a JSON snapshot, not a live reference to the row.
      return {
        data: head ? null : one ? (rows[0] ? { ...rows[0] } : null) : rows.map((row) => ({ ...row })),
        error: null, count: rows.length,
      };
    };
    const builder = {
      select: (_columns?: string, options?: { head?: boolean }) => { head = Boolean(options?.head); return builder; },
      eq: (key: string, val: unknown) => { q.filters.push([key, val]); return builder; },
      is: (key: string, val: unknown) => { q.filters.push([key, val]); return builder; },
      neq: (key: string, val: unknown) => { (q.exclusions ??= []).push([key, val]); return builder; },
      in: (key: string, vals: unknown[]) => { (q.inclusions ??= []).push([key, vals]); return builder; },
      // Dwa filtry OR z obu stron scalenia: status bez `accepted` (main)
      // i środowisko KSeF (#63 Codexa).
      or: (filter: string) => {
        if (filter === 'ksef_status.is.null,ksef_status.neq.accepted') {
          q.nullableNonAccepted = true;
          return builder;
        }
        const match = /^ksef_environment\.is\.null,ksef_environment\.neq\.(test|demo|production)$/.exec(filter);
        if (!match) throw new Error(`Unexpected OR filter ${filter}`);
        orPredicate = (row) => row.ksef_environment == null || row.ksef_environment !== match[1];
        return builder;
      },
      update: (patch: Row) => { q.operation = 'update'; q.patch = patch; return builder; },
      insert: (patch: Row) => { q.operation = 'insert'; q.patch = patch; return builder; },
      lte: () => builder, order: () => builder, limit: (count: number) => { maxRows = count; return builder; },
      single: () => { one = true; return Promise.resolve(execute()); },
      maybeSingle: () => { one = true; return Promise.resolve(execute()); },
      then: <TResult1 = ReturnType<typeof execute>, TResult2 = never>(
        resolve?: ((value: ReturnType<typeof execute>) => TResult1 | PromiseLike<TResult1>) | null,
        reject?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ) => Promise.resolve(execute()).then(resolve, reject),
    };
    return builder;
  },
  // Przejęcie wysyłki (AUD-10, 00124): wolna albo ta sama próba; przyjęta
  // albo trzymana przez inną próbę (`claimHeldByOther`) — null.
  rpc: async (fn: string, args: Record<string, unknown>) => {
    calls.push({ table: `rpc:${fn}`, operation: 'rpc', filters: [], patch: args as Row });
    if (fn !== 'claim_ksef_send') return { data: null, error: null };
    beforeUpdate?.();
    const row = (tables.invoices ?? []).find((r) => r.id === args.p_invoice_id && r.tenant_id === args.p_tenant_id &&
      (r.direction ?? 'outgoing') === 'outgoing');
    if (!row || row.ksef_status === 'accepted' || claimHeldByOther) return { data: null, error: null };
    const now = new Date().toISOString();
    Object.assign(row, { ksef_status: 'sending', submitted_to_ksef_at: now, ksef_send_owner: args.p_owner ?? null });
    return { data: now, error: null };
  },
  auth: { admin: { getUserById: vi.fn() } } };
}
const sendEvent = vi.fn();
const ctx: JobContext = {
  attempt: 0,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  step: {
    run: async (_name, fn) => fn(), sleep: vi.fn(), sendEvent,
    scheduleAfter: vi.fn(),
  },
};
const fileEvent = { importJobId: ID, tenantId: A, source: 'jpk_fa' as const, filePath: 'imports/' + A + '/input.xml' };
// Synchronizacja historii KSeF (decyzja Bartosza 22.10.2026) zastąpiła Magiczny import.
const historyEvent = { tenantId: A, nip: '1234567890', environment: 'test' as const };
const submitEvent = { invoiceId: ID, tenantId: A, nip: '1234567890', environment: 'test' as const, invoice: { internalNumber: 'TEST-1' } as Invoice };
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('KSEF_ENV', 'test');
  tables = {}; errors = new Set(); calls = []; beforeUpdate = null; claimHeldByOther = false;
  mocks.admin.mockImplementation(client);
  mocks.health.mockResolvedValue({ available: true });
  mocks.xml.mockResolvedValue(Buffer.from('<Faktura/>'));
  mocks.parseFa3Xml.mockReturnValue({ invoiceNumber: 'TEST/1/2026' });
});
afterEach(() => vi.unstubAllEnvs());

describe('service-role job boundaries', () => {
  it('confirms a matching invoice update and normalizes empty timestamps', async () => {
    tables.invoices = [{ id: ID, tenant_id: A }];
    await updateInvoiceStatus(ID, { ksef_status: 'sending', submitted_to_ksef_at: '' }, A);
    expect(tables.invoices[0]).toMatchObject({ ksef_status: 'sending', submitted_to_ksef_at: null });
  });
  it('rejects legacy reminder consent before restoring an old durable fetch', async () => {
    const cached = { id: ID, tenant_id: A, invoice_id: OTHER, status: 'pending', invoices: { id: OTHER, tenant_id: B } };
    const cachedContext = { ...ctx, step: { ...ctx.step, run: vi.fn().mockResolvedValue(cached) } };
    await expect(runSendReminder({ reminderId: ID, approvalId: 'approved' }, cachedContext)).rejects.toThrow('zgody');
    expect(cachedContext.step.run).not.toHaveBeenCalled();
    expect(mocks.admin).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
  });
  it('rejects invalid IDs before constructing an admin client', async () => {
    await expect(requireInvoiceTenant('not-an-id', A)).rejects.toThrow('tożsamość');
    expect(mocks.admin).not.toHaveBeenCalled();
  });
  it('fails closed on lookup errors, without reflecting DB diagnostics', async () => {
    errors.add('invoices');
    await expect(requireInvoiceTenant(ID, A)).rejects.toThrow('Nie można sprawdzić');
    expect(writes()).toEqual([]);
  });
  it('checks the tenant of an invoice, not only the validity of its ID', async () => {
    tables.invoices = [{ id: ID, tenant_id: B }];
    await expect(requireInvoiceTenant(ID, A)).rejects.toThrow('nie należy');
    expect(calls[0].filters).toContainEqual(['tenant_id', A]);
  });
  it('requires the same source and file path as the import record', async () => {
    tables.import_jobs = [{ id: ID, tenant_id: A, source: 'jpk_fa', source_file_path: 'old-path' }];
    await expect(requireImportJobTenant(ID, A, 'jpk_fa', 'different-path')).rejects.toThrow('źródła');
    await expect(requireImportJobTenant(ID, A, 'ksef_history')).rejects.toThrow('źródła');
    expect(writes()).toEqual([]);
  });
  it('rejects a mismatched bulk job before progress writes or downloads', async () => {
    tables.import_jobs = [{ id: ID, tenant_id: B, source: 'jpk_fa' }];
    await expect(runBulkImportFile(fileEvent, ctx)).rejects.toThrow('nie należy');
    expect(writes()).toEqual([]);
    expect(mocks.download).not.toHaveBeenCalled();
  });
  it('never mutates an unrelated import in its failure callback', async () => {
    tables.import_jobs = [{ id: ID, tenant_id: B, status: 'pending' }];
    await expect(onBulkImportExhausted(new Error('private-error'), { importJobId: ID, tenantId: A })).rejects.toThrow('nie należy');
    expect(writes()).toEqual([]);
    expect(tables.import_jobs[0].status).toBe('pending');
  });
  it('preserves scoped import failure handling without leaking the exception', async () => {
    tables.import_jobs = [{ id: ID, tenant_id: A, status: 'pending' }];
    await onBulkImportExhausted(new Error('private-error'), { importJobId: ID, tenantId: A });
    expect(tables.import_jobs[0].status).toBe('failed');
    expect(writes()[0].filters).toContainEqual(['tenant_id', A]);
    expect(JSON.stringify(writes())).not.toContain('private-error');
  });
  it('rejects a KSeF history sync event from another environment before any DB or API effect (NonRetriable)', async () => {
    await expect(runKsefHistorySyncTenant({ ...historyEvent, environment: 'demo' }, ctx)).rejects.toMatchObject({
      name: 'NonRetriableError', message: expect.stringContaining('environment'),
    });
    expect(calls).toEqual([]);
    expect(mocks.xml).not.toHaveBeenCalled();
  });
  it('rejects a malformed tenant identity in a KSeF history sync event before any DB effect', async () => {
    await expect(runKsefHistorySyncTenant({ ...historyEvent, tenantId: 'nie-uuid' }, ctx)).rejects.toMatchObject({ name: 'NonRetriableError' });
    expect(calls).toEqual([]);
  });
  const verifiedTenant = (patch: Row = {}): Row => ({
    id: A, nip: '1234567890', ksef_verified_at: '2026-09-01T00:00:00Z', ksef_verified_environment: 'test',
    ksef_certificate_expiry: '2099-01-01T00:00:00Z', deleted_at: null, is_active: true, has_ksef_credentials: true, ...patch,
  });
  it.each([
    ['NIP z innej firmy', { nip: '9999999999' }],
    ['inne środowisko weryfikacji', { ksef_verified_environment: 'production' }],
    ['niezweryfikowany NIP', { ksef_verified_at: null }],
    ['firma nieaktywna', { is_active: false }],
    ['firma usunięta', { deleted_at: '2026-10-01T00:00:00Z' }],
    ['bez certyfikatu', { has_ksef_credentials: false }],
  ] as const)('skips a KSeF history sync for a tenant that no longer qualifies (%s) without writes', async (_label, patch) => {
    tables.tenants = [verifiedTenant(patch)];
    await expect(runKsefHistorySyncTenant(historyEvent, ctx)).resolves.toEqual({ skipped: 'tenant-state' });
    expect(writes()).toEqual([]);
    expect(calls.map((q) => q.table)).toEqual(['tenants']);
    expect(calls[0].filters).toContainEqual(['id', A]);
  });
  it.each(['success', 'failure'] as const)('rejects a mismatched %s notification before cards, mail or push', async (kind) => {
    tables.invoices = [{ id: ID, tenant_id: B }];
    await expect(kind === 'success'
      ? runNotifySuccess({ invoiceId: ID, tenantId: A, ksefNumber: 'test', environment: 'test' }, ctx)
      : runNotifyFailure({ invoiceId: ID, tenantId: A, error: 'test', environment: 'test' }, ctx)).rejects.toThrow('nie należy');
    expect(mocks.proposal).not.toHaveBeenCalled(); expect(mocks.email).not.toHaveBeenCalled(); expect(mocks.push).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
  });
  it.each([
    { status: 'sending', manualReconciliationRequired: true, reason: 'manual-reconciliation' },
    { status: 'failed', manualReconciliationRequired: false, reason: 'manual-reconciliation' },
    { status: 'accepted', manualReconciliationRequired: false, reason: 'already-accepted' },
  ])('suppresses a false failure notification for $reason', async ({ status, manualReconciliationRequired, reason }) => {
    tables.invoices = [{
      id: ID, tenant_id: A, ksef_status: status,
      ksef_number: status === 'accepted' ? 'TEST' : null,
      last_error_code: status === 'failed' ? 'ROZ_HOLD_RECONCILE' : null,
    }];
    await expect(runNotifyFailure({
      invoiceId: ID, tenantId: A, environment: 'test' as const, error: 'old timeout', manualReconciliationRequired,
    }, ctx)).resolves.toMatchObject({ skipped: true, reason });
    expect(mocks.proposal).not.toHaveBeenCalled();
    expect(mocks.email).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
  });
  it('rejects an own reminder joined to another organization invoice', async () => {
    tables.payment_reminders = [{
      id: ID, tenant_id: A, invoice_id: OTHER, status: 'pending',
      invoices: { id: OTHER, tenant_id: B, gross_total: 100, paid_amount: 0 },
    }];
    await expect(runSendReminder({ reminderId: ID, approvalId: 'approved' }, ctx)).rejects.toThrow('zgody');
    expect(writes()).toEqual([]);
    expect(calls).toEqual([]);
  });
  it('does not mutate a paid reminder when legacy queue data has no durable consent', async () => {
    tables.payment_reminders = [{
      id: ID, tenant_id: A, invoice_id: OTHER, status: 'pending',
      invoices: { id: OTHER, tenant_id: A, gross_total: 100, paid_amount: 100 },
    }];
    await expect(runSendReminder({ reminderId: ID, approvalId: 'approved' }, ctx)).rejects.toThrow('zgody');
    expect(writes()).toEqual([]);
    expect(tables.payment_reminders[0].status).toBe('pending');
  });
  it('blocks a tampered OCR created_by before photo download, AI or push', async () => {
    tables.ocr_jobs = [{ id: ID, tenant_id: A, created_by: USER, source_file_path: 'tenants/' + A + '/x.jpg' }];
    tables.memberships = [{ user_id: USER, organization_id: B, status: 'active' }];
    await expect(runProcessOcr({ ocrJobId: ID, tenantId: A }, ctx)).rejects.toThrow('Odbiorca nie należy');
    expect(mocks.photo).not.toHaveBeenCalled(); expect(mocks.ocr).not.toHaveBeenCalled(); expect(mocks.push).not.toHaveBeenCalled();
    expect(writes().every((q) => q.table === 'ocr_jobs')).toBe(true);
  });
  it.each(['runner', 'failure'] as const)('rejects mismatched submit %s before any write, mail, KSeF or event', async (kind) => {
    tables.invoices = [{ id: ID, tenant_id: B }];
    await expect(kind === 'runner' ? runSubmitInvoice(submitEvent, ctx) : onSubmitInvoiceExhausted(new Error('failed'), submitEvent, ctx)).rejects.toThrow('nie należy');
    expect(writes()).toEqual([]); expect(sendEvent).not.toHaveBeenCalled(); expect(mocks.submit).not.toHaveBeenCalled(); expect(mocks.audit).not.toHaveBeenCalled();
  });
  it('does not let a malformed event get privileged failure handling', async () => {
    await expect(onSubmitInvoiceExhausted(new Error('failed'), {} as typeof submitEvent, ctx)).resolves.toMatchObject({ handled: false });
    expect(mocks.admin).not.toHaveBeenCalled(); expect(sendEvent).not.toHaveBeenCalled();
  });
  it.each(['correction', 'advance', 'final'])('does not send an incomplete %s event as ordinary VAT', async (invoiceKind) => {
    tables.invoices = [{
      id: ID, tenant_id: A, ksef_status: 'draft', invoice_kind: invoiceKind,
      internal_number: 'TEST-1', parent_invoice_id: OTHER, advance_invoice_ids: [OTHER],
    }];
    // ROZ zatrzymuje wcześniej wstrzymanie z main; korekta i zaliczka — kontrola
    // dokumentu z #63. W każdym przypadku bez zapisu, sondy i wysyłki.
    await expect(runSubmitInvoice(submitEvent, ctx)).rejects.toThrow(
      /manual reconciliation|Wysyłka faktur rozliczających jest tymczasowo wstrzymana/,
    );
    expect(writes()).toEqual([]);
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(mocks.health).not.toHaveBeenCalled();
  });
  // Offline24 wstrzymany (decyzja 02.10.2026, #71): bez sondy zdrowia
  // i bez Offline24 — zaliczka idzie zwykłą wysyłką, którą job ponawia.
  it('sends an advance without an Offline24 detour on KSeF outage', async () => {
    const advanceInvoice = { type: 'ZAL', internalNumber: 'TEST-1' } as Invoice;
    tables.invoices = [{
      id: ID, tenant_id: A, direction: 'outgoing', ksef_status: 'draft', invoice_kind: 'advance',
      invoice_type: 'ZAL', internal_number: 'TEST-1', advance_invoice_ids: [],
      fa3_data: advanceInvoice,
    }];
    mocks.health.mockResolvedValue({ offline: true, reason: 'KSeF down', isMfOutage: true });
    const specialEvent = {
      ...submitEvent,
      invoice: advanceInvoice,
      advanceData: { invoiceType: 'advance', internalNumber: 'TEST-1' } as AdvanceInvoiceData,
    };
    await runSubmitInvoice(specialEvent, ctx).catch(() => undefined);
    expect(mocks.health).not.toHaveBeenCalled();
    expect(mocks.offlineAdd).not.toHaveBeenCalled();
  });
  it('does not create an Offline24 document for an ordinary PROD submit (AUD-14)', async () => {
    vi.stubEnv('KSEF_ENV', 'production');
    const regularInvoice = { type: 'VAT', internalNumber: 'TEST-1' } as Invoice;
    tables.invoices = [{
      id: ID, tenant_id: A, ksef_status: 'draft', invoice_kind: 'regular',
      invoice_type: 'VAT', internal_number: 'TEST-1', fa3_data: regularInvoice,
    }];
    mocks.health.mockResolvedValue({ offline: true, reason: 'KSeF down', isMfOutage: true });
    await runSubmitInvoice({
      ...submitEvent, environment: 'production', invoice: regularInvoice,
    }, ctx).catch(() => undefined);
    expect(mocks.health).not.toHaveBeenCalled();
    expect(mocks.offlineAdd).not.toHaveBeenCalled();
  });
  it('rejects a stale event whose legal document differs from stored fa3_data before KSeF I/O', async () => {
    const staleInvoice = {
      type: 'VAT', internalNumber: 'TEST-1', buyer: { name: 'Before edit' },
    } as Invoice;
    tables.invoices = [{
      id: ID, tenant_id: A, ksef_status: 'draft', invoice_kind: 'regular',
      invoice_type: 'VAT', internal_number: 'TEST-1',
      fa3_data: { type: 'VAT', internalNumber: 'TEST-1', buyer: { name: 'After edit' } },
    }];
    await expect(runSubmitInvoice({ ...submitEvent, invoice: staleInvoice }, ctx))
      .rejects.toThrow('manual reconciliation');
    expect(mocks.health).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(mocks.offlineAdd).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
  });
  it('rejects a replayed PROD Offline24 submit before privileged DB access', async () => {
    vi.stubEnv('KSEF_ENV', 'production');
    await expect(runSubmitInvoice({
      ...submitEvent, environment: 'production',
      fromOfflineQueue: true, offlineQueueId: OTHER,
    // Offline24 wstrzymany (decyzja 02.10.2026, #71): każde stare zdarzenie z kolejki.
    }, ctx)).rejects.toThrow('Offline24 automatic replay requires manual reconciliation');
    expect(mocks.admin).not.toHaveBeenCalled();
    expect(mocks.health).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
  });
  it('marks a regular PROD submit failed after retries without parking it in Offline24', async () => {
    vi.stubEnv('KSEF_ENV', 'production');
    tables.invoices = [{ id: ID, tenant_id: A, ksef_status: 'sending', invoice_kind: 'regular' }];
    const result = await onSubmitInvoiceExhausted(new Error('timeout'), {
      ...submitEvent, environment: 'production',
    }, ctx);
    expect(result).toMatchObject({ handled: true, finalStatus: 'failed' });
    expect(tables.invoices[0].ksef_status).toBe('failed');
    expect(mocks.offlineAdd).not.toHaveBeenCalled();
  });
  it('does not park a special document after retry exhaustion', async () => {
    tables.invoices = [{ id: ID, tenant_id: A, ksef_status: 'sending', invoice_kind: 'advance' }];
    const result = await onSubmitInvoiceExhausted(new Error('timeout'), submitEvent, ctx);
    expect(result).toMatchObject({ handled: true, finalStatus: 'failed' });
    expect(tables.invoices[0].ksef_status).toBe('failed');
    expect(mocks.offlineAdd).not.toHaveBeenCalled();
  });
  it('preserves submit idempotency for the matching tenant', async () => {
    tables.invoices = [{ id: ID, tenant_id: A, ksef_status: 'accepted', ksef_number: 'TEST', ksef_environment: 'test' }];
    await expect(runSubmitInvoice(submitEvent, ctx)).resolves.toEqual({ alreadyAccepted: true, ksefNumber: 'TEST' });
    expect(writes()).toEqual([]); expect(mocks.submit).not.toHaveBeenCalled();
  });
  it('stops a queued ROZ from an older event even when the event calls it VAT', async () => {
    tables.invoices = [{
      id: ID, tenant_id: A, ksef_status: 'queued', ksef_number: null,
      invoice_kind: 'final', invoice_type: 'ROZ',
    }];
    await expect(runSubmitInvoice({
      ...submitEvent,
      invoice: { ...submitEvent.invoice, type: 'VAT' },
    }, ctx)).rejects.toThrow(/Wysyłka faktur rozliczających jest tymczasowo wstrzymana/);
    expect(writes()).toEqual([]);
    expect(mocks.health).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(sendEvent).not.toHaveBeenCalled();
  });
  it('never parks a queued ROZ in Offline24 after a transient submit failure', async () => {
    tables.invoices = [{
      id: ID, tenant_id: A, ksef_status: 'queued', ksef_number: null,
      invoice_kind: 'final', invoice_type: 'ROZ',
    }];
    const result = await onSubmitInvoiceExhausted(new Error('ECONNRESET'), {
      ...submitEvent,
      invoice: { ...submitEvent.invoice, type: 'VAT' },
    }, ctx);
    expect(result).toMatchObject({ handled: true, finalStatus: 'failed' });
    expect(tables.invoices[0]).toMatchObject({
      ksef_status: 'failed', last_error_code: 'ROZ_HOLD_RECONCILE',
    });
    // A4b PR2b: ROZ_HOLD_RECONCILE nie ma przycisków klienta (decyzja a) ani
    // automatu (I7 wznawia tylko KSEF_PAUSED). `last_error` stoi nad
    // przyciskami — nie każe „ręcznie uzgodnić” i nie obiecuje wysyłki.
    expect(tables.invoices[0].last_error).not.toMatch(/ręcznie uzgodnij/);
    expect(tables.invoices[0].last_error).not.toMatch(/automatycznie/);
    expect(tables.invoices[0].last_error).toMatch(/sami nie wyślemy/);
    expect(tables.ksef_offline_queue).toBeUndefined();
    expect(sendEvent).toHaveBeenCalledWith('emit-failure', expect.objectContaining({
      data: expect.objectContaining({ terminal: true, manualReconciliationRequired: true }),
    }));
  });
  it('marks a legacy ROZ with NULL KSeF status for manual reconciliation', async () => {
    tables.invoices = [{
      id: ID, tenant_id: A, ksef_status: null, ksef_number: null,
      invoice_kind: 'final', invoice_type: 'ROZ',
    }];
    await onSubmitInvoiceExhausted(new Error('old timeout'), {
      ...submitEvent,
      invoice: { ...submitEvent.invoice, type: 'ROZ' },
    }, ctx);
    expect(tables.invoices[0]).toMatchObject({
      ksef_status: 'failed', last_error_code: 'ROZ_HOLD_RECONCILE',
    });
    // A4b PR2b: blokada ROZ klasyfikuje każdą porażkę joba ROZ po stanie,
    // także starego — ten sam prawdziwy tekst (bez „ręcznie uzgodnij”).
    expect(tables.invoices[0].last_error).not.toMatch(/ręcznie uzgodnij/);
    expect(tables.invoices[0].last_error).toMatch(/sami nie wyślemy/);
  });
  it('does not downgrade an already accepted ROZ when its event is replayed', async () => {
    tables.invoices = [{
      id: ID, tenant_id: A, ksef_status: 'accepted', ksef_number: 'TEST', ksef_environment: 'test',
      invoice_kind: 'final', invoice_type: 'ROZ',
    }];
    await expect(runSubmitInvoice({
      ...submitEvent,
      invoice: { ...submitEvent.invoice, type: 'ROZ' },
    }, ctx)).resolves.toEqual({ alreadyAccepted: true, ksefNumber: 'TEST' });
    expect(writes()).toEqual([]);
    expect(mocks.submit).not.toHaveBeenCalled();
  });
  it('reads the current acceptance after a cached queued Inngest guard', async () => {
    tables.invoices = [{
      id: ID, tenant_id: A, ksef_status: 'accepted', ksef_number: 'TEST', ksef_environment: 'test',
      invoice_kind: 'final', invoice_type: 'ROZ',
    }];
    const cachedCtx: JobContext = {
      ...ctx,
      step: {
        ...ctx.step,
        run: async <T>(name: string, fn: () => Promise<T> | T): Promise<T> =>
          name === 'idempotency-guard'
            ? { ksef_status: 'queued', ksef_number: null } as T
            : fn(),
      },
    };
    await expect(runSubmitInvoice({
      ...submitEvent,
      invoice: { ...submitEvent.invoice, type: 'ROZ' },
    }, cachedCtx)).resolves.toEqual({ alreadyAccepted: true, ksefNumber: 'TEST' });
    expect(writes()).toEqual([]);
    expect(mocks.submit).not.toHaveBeenCalled();
  });
  it('does not mark an already accepted ROZ as failed when handling an exhausted job', async () => {
    tables.invoices = [{
      id: ID, tenant_id: A, ksef_status: 'accepted', ksef_number: 'TEST', ksef_environment: 'test',
      invoice_kind: 'final', invoice_type: 'ROZ',
    }];
    await expect(onSubmitInvoiceExhausted(new Error('old timeout'), {
      ...submitEvent,
      invoice: { ...submitEvent.invoice, type: 'ROZ' },
    }, ctx)).resolves.toMatchObject({ handled: true, alreadyAccepted: true, ksefNumber: 'TEST' });
    expect(writes().filter((q) => q.table === 'invoices')).toEqual([]);
    expect(writes()).toEqual([expect.objectContaining({
      table: 'ksef_offline_queue', patch: { status: 'sent', last_error: null },
    })]);
    expect(sendEvent).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });
  it.each([
    { error: new Error('old timeout'), fromOfflineQueue: true, attemptedStatus: 'failed' },
    // `rejected` tylko dla odrzucenia TREŚCI przez KSeF (katalog kodów, PR 2 cyklu życia).
    { error: Object.assign(new Error('KSeF odrzucił fakturę (HTTP 400)'), { name: 'NonRetriableError', cause: new KsefApiError(400, 'x', 'Bad request') }), fromOfflineQueue: false, attemptedStatus: 'rejected' },
  ])('preserves an ordinary VAT acceptance racing with a $attemptedStatus update', async ({ error, fromOfflineQueue, attemptedStatus }) => {
    tables.invoices = [{
      id: ID, tenant_id: A, ksef_status: 'sending', ksef_number: null, ksef_environment: 'test',
      invoice_kind: 'regular', invoice_type: 'VAT',
    }];
    beforeUpdate = () => {
      tables.invoices[0].ksef_status = 'accepted';
      tables.invoices[0].ksef_number = 'TEST';
      beforeUpdate = null;
    };

    await expect(onSubmitInvoiceExhausted(error, {
      ...submitEvent,
      invoice: { ...submitEvent.invoice, type: 'VAT' },
      fromOfflineQueue,
    }, ctx)).resolves.toMatchObject({ handled: true, alreadyAccepted: true, ksefNumber: 'TEST' });

    expect(tables.invoices[0]).toMatchObject({ ksef_status: 'accepted', ksef_number: 'TEST' });
    const statusUpdate = writes().find((q) => q.table === 'invoices' && q.patch?.ksef_status === attemptedStatus);
    expect(statusUpdate?.nullableNonAccepted).toBe(true);
    expect(sendEvent).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });
  it('preserves VAT acceptance racing with the failed fallback after Offline24 is unavailable', async () => {
    tables.invoices = [{
      id: ID, tenant_id: A, ksef_status: 'sending', ksef_number: null, ksef_environment: 'test',
      invoice_kind: 'regular', invoice_type: 'VAT',
    }];
    beforeUpdate = () => {
      tables.invoices[0].ksef_status = 'accepted';
      tables.invoices[0].ksef_number = 'TEST';
      beforeUpdate = null;
    };
    await expect(onSubmitInvoiceExhausted(new Error('old timeout'), {
      ...submitEvent,
      invoice: { ...submitEvent.invoice, type: 'VAT' },
    }, ctx)).resolves.toMatchObject({ handled: true, alreadyAccepted: true, ksefNumber: 'TEST' });
    expect(tables.invoices[0]).toMatchObject({ ksef_status: 'accepted', ksef_number: 'TEST' });
    expect(writes().find((q) => q.table === 'invoices')?.nullableNonAccepted).toBe(true);
    expect(sendEvent).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });
  it('preserves acceptance if another worker completes ROZ during failure handling', async () => {
    tables.invoices = [{
      id: ID, tenant_id: A, ksef_status: 'sending', ksef_number: null, ksef_environment: 'test',
      invoice_kind: 'final', invoice_type: 'ROZ',
    }];
    beforeUpdate = () => {
      tables.invoices[0].ksef_status = 'accepted';
      tables.invoices[0].ksef_number = 'TEST';
    };
    await expect(onSubmitInvoiceExhausted(new Error('old timeout'), {
      ...submitEvent,
      invoice: { ...submitEvent.invoice, type: 'ROZ' },
    }, ctx)).resolves.toMatchObject({ handled: true, alreadyAccepted: true, ksefNumber: 'TEST' });
    expect(tables.invoices[0]).toMatchObject({ ksef_status: 'accepted', ksef_number: 'TEST' });
    expect(sendEvent).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });
  it('suppresses the failure event when ROZ is accepted after the hold update', async () => {
    tables.invoices = [{
      id: ID, tenant_id: A, ksef_status: 'sending', ksef_number: null, ksef_environment: 'test',
      invoice_kind: 'final', invoice_type: 'ROZ',
    }];
    const racingCtx: JobContext = {
      ...ctx,
      step: {
        ...ctx.step,
        run: async <T>(name: string, fn: () => Promise<T> | T): Promise<T> => {
          const result = await fn();
          if (name === 'mark-as-failed-roz-hold') {
            tables.invoices[0].ksef_status = 'accepted';
            tables.invoices[0].ksef_number = 'TEST';
          }
          return result;
        },
      },
    };
    await expect(onSubmitInvoiceExhausted(new Error('old timeout'), {
      ...submitEvent,
      invoice: { ...submitEvent.invoice, type: 'ROZ' },
    }, racingCtx)).resolves.toMatchObject({ handled: true, alreadyAccepted: true, ksefNumber: 'TEST' });
    expect(sendEvent).not.toHaveBeenCalled();
  });
  // AUD-10 (00124): przejęcie wysyłki z dzierżawą.
  // Jak w teście „cannot overwrite acceptance…”: pomijamy kroki poświadczeń.
  const claimCtx: JobContext = {
    ...ctx,
    step: {
      ...ctx.step,
      run: async <T>(name: string, fn: () => Promise<T> | T): Promise<T> =>
        name === 'load-credentials-meta' || name === 'verify-ksef-claimed'
          ? undefined as T
          : fn(),
    },
  };
  it('waits without sending when another attempt holds the send claim (AUD-10)', async () => {
    tables.invoices = [{
      id: ID, tenant_id: A, direction: 'outgoing', ksef_status: 'queued', ksef_number: null,
      ksef_environment: null, invoice_kind: 'regular', internal_number: 'TEST-1',
      fa3_data: { internalNumber: 'TEST-1' },
    }];
    claimHeldByOther = true;
    await expect(runSubmitInvoice(submitEvent, claimCtx)).rejects.toMatchObject({ name: 'RetryAfterError' });
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(tables.invoices[0].ksef_status).toBe('queued');
  });
  it('claims the send with the event attempt id as owner (AUD-10)', async () => {
    const SEND_ATTEMPT = '99999999-9999-4999-8999-999999999999';
    tables.invoices = [{
      id: ID, tenant_id: A, direction: 'outgoing', ksef_status: 'queued', ksef_number: null,
      ksef_environment: null, invoice_kind: 'regular', internal_number: 'TEST-1',
      fa3_data: { internalNumber: 'TEST-1' },
    }];
    await runSubmitInvoice({ ...submitEvent, sendAttemptId: SEND_ATTEMPT }, claimCtx).catch(() => undefined);
    const claim = calls.find((q) => q.table === 'rpc:claim_ksef_send');
    expect(claim?.patch).toMatchObject({
      p_invoice_id: ID, p_tenant_id: A, p_owner: SEND_ATTEMPT, p_lease_seconds: 900,
    });
  });
  it('cannot overwrite acceptance during the status transition to sending', async () => {
    // Faktura w bazie = treść zdarzenia (kontrola z #63).
    tables.invoices = [{
      id: ID, tenant_id: A, direction: 'outgoing', ksef_status: 'queued', ksef_number: null, ksef_environment: 'test',
      invoice_kind: 'regular', internal_number: 'TEST-1', fa3_data: { internalNumber: 'TEST-1' },
    }];
    beforeUpdate = () => {
      tables.invoices[0].ksef_status = 'accepted';
      tables.invoices[0].ksef_number = 'TEST';
    };
    const fastCtx: JobContext = {
      ...ctx,
      step: {
        ...ctx.step,
        run: async <T>(name: string, fn: () => Promise<T> | T): Promise<T> =>
          name === 'load-credentials-meta' || name === 'verify-ksef-claimed'
            ? undefined as T
            : fn(),
      },
    };
    await expect(runSubmitInvoice(submitEvent, fastCtx)).resolves.toEqual({
      alreadyAccepted: true, ksefNumber: 'TEST',
    });
    expect(tables.invoices[0]).toMatchObject({ ksef_status: 'accepted', ksef_number: 'TEST' });
    expect(mocks.submit).not.toHaveBeenCalled();
  });
  it.each([null, 'demo'] as const)('keeps accepted invoice with stored environment %s for reconciliation', async (storedEnvironment) => {
    tables.invoices = [{ id: ID, tenant_id: A, ksef_status: 'accepted', ksef_number: 'HISTORICAL', ksef_environment: storedEnvironment }];
    await expect(runSubmitInvoice(submitEvent, ctx)).rejects.toThrow('manual reconciliation');
    await expect(onSubmitInvoiceExhausted(new Error('manual reconciliation'), submitEvent, ctx))
      .resolves.toMatchObject({ handled: false, reason: 'accepted-reconciliation' });
    expect(tables.invoices[0].ksef_status).toBe('accepted');
    expect(writes()).toEqual([]);
    expect(mocks.submit).not.toHaveBeenCalled();
  });
  it('rejects a submit event without environment before DB or KSeF I/O', async () => {
    const legacy = { ...submitEvent, environment: undefined } as unknown as typeof submitEvent;
    await expect(runSubmitInvoice(legacy, ctx)).rejects.toThrow('Niepoprawny payload');
    expect(calls).toEqual([]);
    expect(mocks.submit).not.toHaveBeenCalled();
  });
  it('invoice read/write helpers require tenant and never affect a foreign row', async () => {
    tables.invoices = [{ id: ID, tenant_id: B, fa3_data: { internalNumber: 'PRIVATE' }, ksef_status: 'accepted' }];
    await expect(getInvoiceForSubmit(ID, A)).rejects.toThrow('no fa3_data');
    await expect(updateInvoiceStatus(ID, { ksef_status: 'failed' }, A)).rejects.toThrow('Nie udało się zaktualizować');
    expect(tables.invoices[0].ksef_status).toBe('accepted');
    await expect(updateInvoiceStatus(ID, { ksef_status: 'failed' }, '')).rejects.toThrow('Brak organizacji');
    expect(calls.filter((q) => q.table === 'invoices').every((q) => q.filters.some(([k,v]) => k === 'tenant_id' && v === A))).toBe(true);
  });
  // Offline24 wstrzymany (decyzja 02.10.2026, #71) — testy kolejki z #71.
  it('does not quarantine any row when invoice ownership lookup is unavailable', async () => {
    tables.ksef_offline_queue = [{ id: OTHER, tenant_id: A, invoice_id: ID, status: 'queued', ksef_environment: 'test', deadline: '2000-01-01' }];
    errors.add('invoices');
    await expect(runProcessOfflineQueue(ctx)).rejects.toThrow('Nie można sprawdzić');
    expect(writes()).toEqual([]); expect(sendEvent).not.toHaveBeenCalled();
    expect(tables.ksef_offline_queue[0].status).toBe('queued');
  });
  it('quarantines a full malicious batch so a valid row is not starved on the next run', async () => {
    tables.invoices = [{ id: ID, tenant_id: B }, {
      id: OTHER, tenant_id: A, ksef_status: 'offline_queued', submitted_to_ksef_at: null,
      invoice_kind: 'regular', invoice_type: 'VAT', fa3_data: { type: 'VAT' },
    }];
    tables.ksef_offline_queue = Array.from({ length: 10 }, (_, index) => ({
      id: '44444444-4444-4444-8444-' + String(index).padStart(12, '0'),
      tenant_id: A, invoice_id: ID, status: 'queued', ksef_environment: 'test', deadline: '2000-01-01',
    }));
    tables.ksef_offline_queue.push({ id: USER, tenant_id: A, invoice_id: OTHER, status: 'queued', ksef_environment: 'test', deadline: '2000-01-01' });
    await runProcessOfflineQueue(ctx);
    expect(tables.ksef_offline_queue.filter((r) => r.status === 'failed')).toHaveLength(10);
    expect(tables.ksef_offline_queue[10].status).toBe('queued');
    await runProcessOfflineQueue(ctx);
    expect(tables.ksef_offline_queue[10].status).toBe('expired');
    expect(tables.invoices[0]).toEqual({ id: ID, tenant_id: B });
  });
  it.each(['2000-01-01', '2099-01-01'])('ignores an own offline row referencing another tenant invoice, deadline=%s', async (deadline) => {
    tables.ksef_offline_queue = [{ id: OTHER, tenant_id: A, invoice_id: ID, status: 'queued', ksef_environment: 'test', deadline }];
    tables.invoices = [{ id: ID, tenant_id: B }];
    const result = await runProcessOfflineQueue(ctx);
    expect(result).toMatchObject({ processed: 1, results: [{ status: 'ownership-mismatch' }] });
    expect(writes()).toHaveLength(1);
    expect(writes()[0]).toMatchObject({ table: 'ksef_offline_queue', patch: { status: 'failed' } });
    expect(writes()[0].filters).toEqual([['id', OTHER], ['tenant_id', A], ['invoice_id', ID], ['status', 'queued']]);
    expect(tables.invoices[0]).toEqual({ id: ID, tenant_id: B });
    expect(sendEvent).not.toHaveBeenCalled();
  });
  it('does not emit or mutate legacy and foreign-environment offline rows', async () => {
    tables.ksef_offline_queue = [
      { id: ID, tenant_id: A, invoice_id: ID, status: 'queued', ksef_environment: null, deadline: '2099-01-01' },
      { id: OTHER, tenant_id: A, invoice_id: OTHER, status: 'queued', ksef_environment: 'demo', deadline: '2099-01-01' },
    ];
    await expect(runProcessOfflineQueue(ctx)).resolves.toMatchObject({ skipped: true, reason: 'Empty queue' });
    expect(writes()).toEqual([]);
    expect(sendEvent).not.toHaveBeenCalled();
    expect(ctx.logger.error).toHaveBeenCalledWith('Offline24 rows require environment reconciliation', {
      environment: 'test', blockedCount: 2,
    });
  });

  it('expires a valid offline row and scopes both updates', async () => {
    tables.ksef_offline_queue = [{ id: OTHER, tenant_id: A, invoice_id: ID, status: 'queued', ksef_environment: 'test', deadline: '2000-01-01' }];
    tables.invoices = [{
      id: ID, tenant_id: A, ksef_status: 'offline_queued', submitted_to_ksef_at: null,
      invoice_kind: 'regular', invoice_type: 'VAT', fa3_data: { type: 'VAT' },
    }];
    await runProcessOfflineQueue(ctx);
    expect(tables.ksef_offline_queue[0].status).toBe('expired');
    expect(tables.invoices[0].ksef_status).toBe('failed');
    for (const q of writes()) expect(q.filters).toContainEqual(['tenant_id', A]);
  });
  it('does not mark accepted invoice failed when Offline24 deadline races with acceptance', async () => {
    tables.ksef_offline_queue = [{
      id: OTHER, tenant_id: A, invoice_id: ID, status: 'queued',
      ksef_environment: 'test', deadline: '2000-01-01',
    }];
    tables.invoices = [{
      id: ID, tenant_id: A, ksef_status: 'offline_queued', submitted_to_ksef_at: null,
      invoice_kind: 'regular', invoice_type: 'VAT', fa3_data: { type: 'VAT' },
    }];
    const racingContext: JobContext = {
      ...ctx,
      step: {
        ...ctx.step,
        run: async <T,>(name: string, fn: () => Promise<T> | T): Promise<T> => {
          if (name.startsWith('expire-offline-queue-')) {
            tables.invoices[0].ksef_status = 'accepted';
            tables.invoices[0].ksef_number = 'TEST-KSEF-NUMBER';
          }
          return fn();
        },
      },
    };
    await expect(runProcessOfflineQueue(racingContext))
      .resolves.toMatchObject({ processed: 1, results: [{ status: 'expired-reconciliation' }] });
    expect(tables.invoices[0]).toMatchObject({
      ksef_status: 'accepted', ksef_number: 'TEST-KSEF-NUMBER',
    });
    expect(tables.ksef_offline_queue[0].status).toBe('expired');
    expect(sendEvent).not.toHaveBeenCalled();
  });
  it('expires a historical queue row without changing a sending invoice', async () => {
    tables.ksef_offline_queue = [{
      id: OTHER, tenant_id: A, invoice_id: ID, status: 'queued',
      ksef_environment: 'test', deadline: '2000-01-01',
    }];
    tables.invoices = [{
      id: ID, tenant_id: A, ksef_status: 'sending',
      submitted_to_ksef_at: '2026-09-27T00:00:00.000Z',
    }];
    await expect(runProcessOfflineQueue(ctx)).resolves.toMatchObject({
      processed: 1, results: [{ status: 'expired-reconciliation' }],
    });
    expect(tables.ksef_offline_queue[0].status).toBe('expired');
    expect(tables.invoices[0]).toMatchObject({
      ksef_status: 'sending', submitted_to_ksef_at: '2026-09-27T00:00:00.000Z',
    });
    expect(sendEvent).not.toHaveBeenCalled();
  });

  it('quarantines legacy PROD Offline24 rows without probing KSeF or sending', async () => {
    vi.stubEnv('KSEF_ENV', 'production');
    tables.ksef_offline_queue = [{
      id: OTHER, tenant_id: A, invoice_id: ID, status: 'queued',
      ksef_environment: 'production', deadline: '2099-01-01',
    }];
    tables.invoices = [{
      id: ID, tenant_id: A, ksef_status: 'offline_queued', submitted_to_ksef_at: null,
      invoice_kind: 'regular', invoice_type: 'VAT', fa3_data: { type: 'VAT' },
    }];
    await expect(runProcessOfflineQueue(ctx)).resolves.toMatchObject({
      processed: 1, results: [{ status: 'production-reconciliation' }],
    });
    expect(tables.ksef_offline_queue[0].status).toBe('failed');
    expect(tables.invoices[0]).toMatchObject({
      ksef_status: 'offline_queued', last_error_code: 'OFFLINE_PROD_QR_UNVERIFIED',
    });
    expect(mocks.health).not.toHaveBeenCalled();
    expect(sendEvent).not.toHaveBeenCalled();
    expect(writes()).toHaveLength(2);
    expect(ctx.logger.error).toHaveBeenCalledWith(
      'PROD Offline24 QR is unverified; queued rows require manual reconciliation',
      { environment: 'production', queuedCount: 1 },
    );
  });
  it('quarantines a historical special Offline24 row before replay', async () => {
    tables.ksef_offline_queue = [{
      id: OTHER, tenant_id: A, invoice_id: ID, status: 'queued',
      ksef_environment: 'test', deadline: '2099-01-01',
    }];
    tables.invoices = [{
      id: ID, tenant_id: A, invoice_kind: 'correction', invoice_type: 'KOR',
      fa3_data: { type: 'KOR' }, ksef_status: 'offline_queued',
    }];
    const result = await runProcessOfflineQueue(ctx);
    expect(result).toMatchObject({ processed: 1, results: [{ status: 'special-reconciliation' }] });
    expect(tables.ksef_offline_queue[0].status).toBe('failed');
    expect(tables.invoices[0]).toMatchObject({
      ksef_status: 'offline_queued', last_error_code: 'OFFLINE_SPECIAL_DOCUMENT',
    });
    expect(sendEvent).not.toHaveBeenCalled();
  });
  it('closes a regular unexpired Offline24 row without creating a sending attempt', async () => {
    tables.ksef_offline_queue = [{
      id: OTHER, tenant_id: A, invoice_id: ID, status: 'queued',
      ksef_environment: 'test', deadline: '2099-01-01', attempts: 0,
    }];
    tables.invoices = [{
      id: ID, tenant_id: A, ksef_status: 'offline_queued', submitted_to_ksef_at: null,
      invoice_kind: 'regular', invoice_type: 'VAT', fa3_data: { type: 'VAT' },
    }];
    await expect(runProcessOfflineQueue(ctx)).resolves.toMatchObject({
      processed: 1, results: [{ status: 'paused-reconciliation' }],
    });
    expect(tables.ksef_offline_queue[0]).toMatchObject({
      status: 'failed', attempts: 0, last_error: 'OFFLINE_REPLAY_PAUSED_REQUIRES_RECONCILIATION',
    });
    expect(tables.invoices[0]).toMatchObject({
      ksef_status: 'offline_queued', submitted_to_ksef_at: null,
      last_error_code: 'OFFLINE_REPLAY_PAUSED',
    });
    expect(writes().some((query) => query.patch?.status === 'sending')).toBe(false);
    expect(sendEvent).not.toHaveBeenCalled();
    await expect(runProcessOfflineQueue(ctx)).resolves.toMatchObject({ skipped: true, reason: 'Empty queue' });
  });
  it('completes an invoice marker after a previous attempt already quarantined the queue', async () => {
    tables.ksef_offline_queue = [{
      id: OTHER, tenant_id: A, invoice_id: ID, status: 'queued',
      ksef_environment: 'test', deadline: '2099-01-01',
    }];
    tables.invoices = [{
      id: ID, tenant_id: A, ksef_status: 'offline_queued', submitted_to_ksef_at: null,
      invoice_kind: 'regular', invoice_type: 'VAT', fa3_data: { type: 'VAT' },
    }];
    const retryContext: JobContext = {
      ...ctx,
      step: {
        ...ctx.step,
        run: async <T,>(name: string, fn: () => Promise<T> | T): Promise<T> => {
          const result = await fn();
          if (name.startsWith('fetch-queue-items-')) {
            tables.ksef_offline_queue[0].status = 'failed';
            tables.ksef_offline_queue[0].last_error = 'OFFLINE_REPLAY_PAUSED_REQUIRES_RECONCILIATION';
          }
          return result;
        },
      },
    };
    await runProcessOfflineQueue(retryContext);
    expect(tables.invoices[0]).toMatchObject({ last_error_code: 'OFFLINE_REPLAY_PAUSED' });
    expect(tables.ksef_offline_queue[0].status).toBe('failed');
    expect(sendEvent).not.toHaveBeenCalled();
  });
  it.each(['accepted', 'sending'] as const)(
    'quarantines an unexpired row without touching a %s invoice', async (status) => {
      tables.ksef_offline_queue = [{
        id: OTHER, tenant_id: A, invoice_id: ID, status: 'queued',
        ksef_environment: 'test', deadline: '2099-01-01',
      }];
      tables.invoices = [{
        id: ID, tenant_id: A, ksef_status: status,
        submitted_to_ksef_at: '2026-09-27T00:00:00.000Z', ksef_number: 'TEST-NUMBER',
      }];
      await runProcessOfflineQueue(ctx);
      expect(tables.ksef_offline_queue[0].status).toBe('failed');
      expect(tables.invoices[0]).toMatchObject({
        ksef_status: status, submitted_to_ksef_at: '2026-09-27T00:00:00.000Z',
        ksef_number: 'TEST-NUMBER',
      });
      expect(writes().filter((query) => query.table === 'invoices')).toEqual([]);
      expect(sendEvent).not.toHaveBeenCalled();
    },
  );
  it('quarantines queued Offline24 work even while KSeF health reports an outage', async () => {
    mocks.health.mockResolvedValue({ available: false, error: 'KSeF unavailable', isMfOutage: false });
    tables.ksef_offline_queue = [{
      id: OTHER, tenant_id: A, invoice_id: ID, status: 'queued',
      ksef_environment: 'test', deadline: '2099-01-01',
    }];
    tables.invoices = [{
      id: ID, tenant_id: A, ksef_status: 'offline_queued', submitted_to_ksef_at: null,
      invoice_kind: 'regular', invoice_type: 'VAT', fa3_data: { type: 'VAT' },
    }];
    await expect(runProcessOfflineQueue(ctx)).resolves.toMatchObject({
      processed: 1, results: [{ status: 'paused-reconciliation' }],
    });
    expect(tables.ksef_offline_queue[0].status).toBe('failed');
    expect(sendEvent).not.toHaveBeenCalled();
  });
  it('does not overwrite a newly sending invoice while quarantining its old queue row', async () => {
    tables.ksef_offline_queue = [{
      id: OTHER, tenant_id: A, invoice_id: ID, status: 'queued',
      ksef_environment: 'test', deadline: '2099-01-01',
    }];
    tables.invoices = [{
      id: ID, tenant_id: A, ksef_status: 'offline_queued', submitted_to_ksef_at: null,
      invoice_kind: 'regular', invoice_type: 'VAT', fa3_data: { type: 'VAT' },
    }];
    const racingContext: JobContext = {
      ...ctx,
      step: {
        ...ctx.step,
        run: async <T,>(name: string, fn: () => Promise<T> | T): Promise<T> => {
          if (name.startsWith('quarantine-paused-offline-')) {
            tables.invoices[0].ksef_status = 'sending';
            tables.invoices[0].submitted_to_ksef_at = '2026-09-27T00:00:00.000Z';
          }
          return fn();
        },
      },
    };
    await runProcessOfflineQueue(racingContext);
    expect(tables.ksef_offline_queue[0].status).toBe('failed');
    expect(tables.invoices[0]).toMatchObject({
      ksef_status: 'sending', submitted_to_ksef_at: '2026-09-27T00:00:00.000Z',
    });
    expect(sendEvent).not.toHaveBeenCalled();
  });
  it.each(['success', 'failure'] as const)('rejects mismatched offline %s callbacks', async (kind) => {
    tables.invoices = [{ id: ID, tenant_id: B }];
    await expect(kind === 'success'
      ? runOfflineQueueSuccess({ invoiceId: ID, tenantId: A, fromOfflineQueue: true, offlineQueueId: ID, environment: 'test', ksefNumber: 'test' }, ctx)
      : runOfflineQueueFailure({ invoiceId: ID, tenantId: A, fromOfflineQueue: true, offlineQueueId: ID, environment: 'test', error: 'test' }, ctx)).rejects.toThrow('nie należy');
    expect(writes()).toEqual([]);
  });
  it('scopes a valid success callback instead of completing a second tenant queue row', async () => {
    tables.invoices = [{ id: ID, tenant_id: A, ksef_status: 'accepted', ksef_environment: 'test' }];
    tables.ksef_offline_queue = [
      { id: ID, tenant_id: A, invoice_id: ID, status: 'sending', ksef_environment: 'test' },
      { id: OTHER, tenant_id: B, invoice_id: ID, status: 'sending', ksef_environment: 'test' },
    ];
    await runOfflineQueueSuccess({ invoiceId: ID, tenantId: A, fromOfflineQueue: true, offlineQueueId: ID, environment: 'test', ksefNumber: 'test' }, ctx);
    expect(tables.ksef_offline_queue.map((r) => r.status)).toEqual(['sent', 'sending']);
  });
  it('requires accepted invoice in current environment before a success callback', async () => {
    tables.invoices = [{ id: ID, tenant_id: A, ksef_status: 'sending', ksef_environment: 'test' }];
    tables.ksef_offline_queue = [{ id: ID, tenant_id: A, invoice_id: ID, status: 'sending', ksef_environment: 'test' }];
    await expect(runOfflineQueueSuccess({ invoiceId: ID, tenantId: A, fromOfflineQueue: true, offlineQueueId: ID, environment: 'test', ksefNumber: 'test' }, ctx))
      .rejects.toThrow('without accepted invoice');
    expect(tables.ksef_offline_queue[0].status).toBe('sending');
  });
  it('quarantines a stale Offline24 failure after invoice acceptance', async () => {
    tables.invoices = [{ id: ID, tenant_id: A, ksef_status: 'accepted', ksef_environment: 'test' }];
    tables.ksef_offline_queue = [{ id: ID, tenant_id: A, invoice_id: ID, status: 'sending', ksef_environment: 'test' }];
    await expect(runOfflineQueueFailure({ invoiceId: ID, tenantId: A, fromOfflineQueue: true, offlineQueueId: ID, environment: 'test', error: 'old failure' }, ctx))
      .rejects.toThrow('accepted invoice requires reconciliation');
    expect(tables.invoices[0].ksef_status).toBe('accepted');
    expect(tables.ksef_offline_queue[0].status).toBe('failed');
  });
  it('does not requeue an invoice accepted after the Offline24 failure read', async () => {
    tables.invoices = [{
      id: ID, tenant_id: A, ksef_status: 'failed', ksef_environment: 'test',
      invoice_kind: 'regular', invoice_type: 'VAT', fa3_data: { type: 'VAT' },
      submitted_to_ksef_at: null,
    }];
    tables.ksef_offline_queue = [{
      id: OTHER, tenant_id: A, invoice_id: ID, status: 'sending', ksef_environment: 'test', attempts: 1,
    }];
    const racingContext: JobContext = {
      ...ctx,
      step: {
        ...ctx.step,
        run: async <T,>(name: string, fn: () => Promise<T> | T): Promise<T> => {
          if (name === 'rollback-queue-status') {
            tables.invoices[0].ksef_status = 'accepted';
            tables.invoices[0].ksef_number = 'TEST-KSEF-NUMBER';
          }
          return fn();
        },
      },
    };
    expect(await runOfflineQueueFailure({
      invoiceId: ID, tenantId: A, fromOfflineQueue: true, offlineQueueId: OTHER,
      environment: 'test', error: 'old failure', terminal: false,
    }, racingContext)).toMatchObject({ success: false, reason: 'manual-reconciliation' });
    expect(tables.invoices[0]).toMatchObject({
      ksef_status: 'accepted', ksef_number: 'TEST-KSEF-NUMBER',
    });
    expect(tables.ksef_offline_queue[0].status).toBe('failed');
  });
  it('quarantines a legacy nonterminal Offline24 callback for failed invoice without a timestamp', async () => {
    tables.invoices = [{
      id: ID, tenant_id: A, ksef_status: 'failed', submitted_to_ksef_at: null,
      invoice_kind: 'regular', invoice_type: 'VAT', fa3_data: { type: 'VAT' },
    }];
    tables.ksef_offline_queue = [{
      id: OTHER, tenant_id: A, invoice_id: ID, status: 'sending', ksef_environment: 'test', attempts: 1,
    }];
    expect(await runOfflineQueueFailure({
      invoiceId: ID, tenantId: A, fromOfflineQueue: true, offlineQueueId: OTHER,
      environment: 'test', error: 'old timeout', terminal: false,
    }, ctx)).toMatchObject({ success: false, reason: 'manual-reconciliation' });
    expect(tables.invoices[0].ksef_status).toBe('failed');
    expect(tables.ksef_offline_queue[0].status).toBe('failed');
    expect(sendEvent).not.toHaveBeenCalled();
  });
  it('quarantines a historical regular PROD Offline24 failure instead of requeueing it', async () => {
    vi.stubEnv('KSEF_ENV', 'production');
    tables.invoices = [{
      id: ID, tenant_id: A, ksef_status: 'offline_queued', invoice_kind: 'regular',
      invoice_type: 'VAT', fa3_data: { type: 'VAT' },
    }];
    tables.ksef_offline_queue = [{
      id: OTHER, tenant_id: A, invoice_id: ID, status: 'sending', ksef_environment: 'production',
    }];
    const result = await runOfflineQueueFailure({
      invoiceId: ID, tenantId: A, fromOfflineQueue: true,
      offlineQueueId: OTHER, environment: 'production', error: 'old event',
    }, ctx);
    expect(result).toMatchObject({ success: false, reason: 'special-reconciliation' });
    expect(tables.invoices[0]).toMatchObject({
      ksef_status: 'failed', last_error_code: 'OFFLINE_PROD_QR_UNVERIFIED',
    });
    expect(tables.ksef_offline_queue[0].status).toBe('failed');
    expect(sendEvent).not.toHaveBeenCalled();
  });
  it.each(['failed', 'offline_queued'])(
    'does not requeue a historical special document with invoice status %s', async (status) => {
    tables.invoices = [{
      id: ID, tenant_id: A, ksef_status: status, invoice_kind: 'advance',
      invoice_type: 'ZAL', fa3_data: { type: 'ZAL' },
    }];
    tables.ksef_offline_queue = [{
      id: OTHER, tenant_id: A, invoice_id: ID, status: 'sending', ksef_environment: 'test',
    }];
    const result = await runOfflineQueueFailure({
      invoiceId: ID, tenantId: A, fromOfflineQueue: true,
      offlineQueueId: OTHER, environment: 'test', error: 'old event',
    }, ctx);
    expect(result).toMatchObject({ success: false, reason: 'special-reconciliation' });
    expect(tables.ksef_offline_queue[0].status).toBe('failed');
    expect(tables.invoices[0].ksef_status).toBe('failed');
    },
  );
});

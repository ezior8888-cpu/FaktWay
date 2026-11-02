import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';
import type { Invoice } from '@/types/invoice';

import { memoryDb, type MemoryDb, type Row } from '../helpers/fake-supabase-memory';
import { fakePosthog, lejekClient } from '../helpers/lejek-atrapy';

/**
 * first_invoice_sent na prawdziwym runnerze wysyłki. Warunkowy UPDATE
 * `tenants.first_invoice_accepted_at … WHERE IS NULL` rozstrzyga, kto wysyła,
 * a worker pg-boss powtarza cały handler od początku (AGENTS.md, punkt 5),
 * więc ponowienie po awarii musi wysłać to samo zdarzenie jeszcze raz, a nie zgubić je.
 * Mock: KSeF, kolejka, plik XML, PostHog i baza w pamięci. Wyzwalacze: rls-lejek-analityka.
 */

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_TENANT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OWNER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const FIRST = '11111111-1111-4111-8111-111111111111';
const SECOND = '33333333-3333-4333-8333-333333333333';
const ATTEMPT = '22222222-2222-4222-8222-222222222222';
const ACCEPTED_AT = '2026-10-01T10:00:00.000Z';
const LATER = '2026-10-05T10:00:00.000Z';

const m = vi.hoisted(() => ({
  db: null as unknown,
  posthog: null as unknown,
  fullFlow: vi.fn(),
  updateStatus: vi.fn(),
}));

vi.mock('@/lib/feature-flags/global-flags', () => ({ getGlobalFlagForExecution: async () => false }));
vi.mock('@/lib/audit/log-system', () => ({ logAuditSystem: vi.fn() }));
vi.mock('@/lib/auth/ksef-verification-guard', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/auth/ksef-verification-guard')>(),
  requireKsefVerificationForBackgroundJob: async () => undefined,
}));
vi.mock('@/lib/ksef/health-check', () => ({ shouldUseOfflineMode: async () => ({ offline: false }) }));
vi.mock('@/lib/ksef/offline-queue', () => ({ addToOfflineQueue: vi.fn() }));
vi.mock('@/lib/ksef/submit-invoice-full', () => ({ submitInvoiceFullFlow: m.fullFlow }));
vi.mock('@/lib/ksef/submit-reference-boundary', () => ({ assertSubmitReferences: async () => 'regular' }));
vi.mock('@/lib/ksef/submission-log', () => ({
  findOpenKsefSubmissionIntents: vi.fn(async () => []),
  promoteKsefSubmissionIntent: vi.fn(async () => false),
  abandonKsefSubmissionIntent: vi.fn(),
  recordKsefSubmissionIntent: vi.fn(),
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
  findOwnKsefSessionXmlPath: vi.fn(async () => null),
  isOwnKsefSession: vi.fn(async () => false),
  findSessionReferenceForKsefNumber: vi.fn(async () => null),
  findKsefNumberTaken: vi.fn(async () => null),
}));
vi.mock('@/lib/jobs/runners/tenant-boundary', () => ({ requireInvoiceTenant: vi.fn(), assertJobIdentity: vi.fn() }));
vi.mock('@/lib/supabase/admin-queries', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/supabase/admin-queries')>(),
  getTenantKsefCredentials: async () => ({ type: 'token', nip: '1234567890', token: 't' }),
  updateInvoiceStatus: m.updateStatus,
}));
vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: async () => {
    const client = lejekClient(m.db as MemoryDb, {
      claim_ksef_send: '2026-10-03T12:00:00.000000+00:00',
      ksef_has_contact_evidence: true,
    });
    return {
      ...client,
      from: (table: string) => Object.assign(client.from(table), { or() { return this; } }),
    };
  },
}));
vi.mock('@/lib/analytics/posthog-node-client', () => ({ getPostHogNodeClient: () => m.posthog }));
vi.mock('@/lib/storage/xml-documents', () => ({ recordXmlDocument: vi.fn() }));
vi.mock('@/lib/cache/invalidation', () => ({ invalidateTenantDashboard: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn(), addBreadcrumb: vi.fn() }));

import { recordFirstInvoiceAccepted } from '@/lib/analytics/funnel';
import { runSubmitInvoice } from '@/lib/jobs/runners/submit-invoice';

const ctx: JobContext = {
  attempt: 0,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  step: { run: async (_n, fn) => fn(), sleep: vi.fn(), sendEvent: vi.fn(), scheduleAfter: vi.fn() },
};

const event = (invoiceId = FIRST) => ({
  invoiceId, tenantId: TENANT, nip: '1234567890', environment: 'test' as const, sendAttemptId: ATTEMPT,
  invoice: { type: 'VAT', internalNumber: 'FV/1', issueDate: '2026-10-01' } as Invoice,
});

const accepted = (ksefNumber: string, acquisitionTimestamp: string) => ({
  ksefNumber, acquisitionTimestamp,
  xmlStoragePath: 'x.xml', xmlSha256Hash: 'h', xmlSizeBytes: 1, sessionReferenceNumber: 'S-2', invoiceReferenceNumber: 'R-2',
});

function invoiceRow(id: string, over: Row = {}): Row {
  return {
    id, tenant_id: TENANT, direction: 'outgoing', origin: 'app', ksef_status: 'queued', ksef_number: null,
    ksef_environment: 'test', ksef_accepted_at: null, invoice_type: 'VAT', invoice_kind: 'regular', fa3_data: {}, ...over,
  };
}

let posthog: ReturnType<typeof fakePosthog>;
let db: MemoryDb;

function tenant(): Row {
  return db.tables.tenants![0]!;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('KSEF_ENV', 'test');
  posthog = fakePosthog();
  m.posthog = posthog;
  db = memoryDb({
    tenants: [{ id: TENANT, first_invoice_accepted_at: null }, { id: OTHER_TENANT, first_invoice_accepted_at: null }],
    invoices: [invoiceRow(FIRST), invoiceRow(SECOND)],
    users: [{ id: OWNER, analytics_consent: 'granted', signup_source: { channel: 'referral', at: '2026-09-30' } }],
    memberships: [{ organization_id: TENANT, user_id: OWNER, role: 'owner', status: 'active', joined_at: '2026-09-30T00:00:00Z' }],
  });
  m.db = db;
  m.fullFlow.mockResolvedValue(accepted('K-1', ACCEPTED_AT));
  m.updateStatus.mockImplementation(async (id: string, patch: Row) => {
    Object.assign(db.tables.invoices!.find((r) => r.id === id)!, patch);
  });
});
afterEach(() => vi.unstubAllEnvs());

describe('first_invoice_sent w runnerze wysyłki', () => {
  it('pierwsza przyjęta faktura: data w firmie i jedno zdarzenie z chwilą akceptacji KSeF', async () => {
    await expect(runSubmitInvoice(event(), ctx)).resolves.toMatchObject({ success: true, ksefNumber: 'K-1' });

    expect(tenant().first_invoice_accepted_at).toBe(ACCEPTED_AT);
    const events = posthog.sklejone('first_invoice_sent');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      distinctId: OWNER,
      groups: { tenant: TENANT },
      properties: { ksef_env: 'test', source: 'referral', tenant_id: TENANT },
    });
    expect(events[0]!.timestamp?.toISOString()).toBe(ACCEPTED_AT);
    expect(posthog.nazwy()).toContain('invoice_accepted');
  });

  it('druga faktura tej samej firmy: invoice_accepted tak, first_invoice_sent nie, data bez zmian', async () => {
    await runSubmitInvoice(event(FIRST), ctx);
    m.fullFlow.mockResolvedValue(accepted('K-2', LATER));
    await runSubmitInvoice(event(SECOND), ctx);

    expect(tenant().first_invoice_accepted_at).toBe(ACCEPTED_AT);
    expect(posthog.sklejone('first_invoice_sent')).toHaveLength(1);
    expect(posthog.sklejone('invoice_accepted')).toHaveLength(2);
  });

  it('ponowienie przyjętej już faktury (ten sam job od początku): to samo zdarzenie, wykres liczy je raz', async () => {
    await runSubmitInvoice(event(), ctx);
    await expect(runSubmitInvoice(event(), ctx)).resolves.toMatchObject({ alreadyAccepted: true });

    expect(m.fullFlow).toHaveBeenCalledTimes(1);
    expect(posthog.sklejone('first_invoice_sent')).toHaveLength(1);
    const sent = posthog.messages.filter((x) => x.event === 'first_invoice_sent');
    expect(new Set(sent.map((x) => x.uuid)).size).toBe(1);
  });

  it('awaria po wygranym UPDATE, przed wysyłką: ponowienie nie gubi zdarzenia', async () => {
    let failing = true;
    const real = posthog.capture;
    posthog.capture = (message) => {
      if (failing && message.event === 'first_invoice_sent') throw new Error('PostHog niedostępny');
      real(message);
    };
    await runSubmitInvoice(event(), ctx);
    expect(tenant().first_invoice_accepted_at).toBe(ACCEPTED_AT);
    expect(posthog.sklejone('first_invoice_sent')).toHaveLength(0);

    failing = false;
    await runSubmitInvoice(event(), ctx);
    expect(posthog.sklejone('first_invoice_sent')).toHaveLength(1);
  });

  it('awaria między zapisem faktury a UPDATE firmy: ponowienie uzupełnia datę i wysyła', async () => {
    Object.assign(db.tables.invoices![0]!, { ksef_status: 'accepted', ksef_number: 'K-1', ksef_accepted_at: ACCEPTED_AT });
    await expect(runSubmitInvoice(event(), ctx)).resolves.toMatchObject({ alreadyAccepted: true });
    expect(tenant().first_invoice_accepted_at).toBe(ACCEPTED_AT);
    expect(posthog.sklejone('first_invoice_sent')).toHaveLength(1);
  });

  it('właściciel bez zgody: data w firmie jest (lejek zbiorczy nie zależy od zgód), zdarzenia brak', async () => {
    db.tables.users![0]!.analytics_consent = 'denied';
    await runSubmitInvoice(event(), ctx);
    expect(tenant().first_invoice_accepted_at).toBe(ACCEPTED_AT);
    expect(posthog.messages).toEqual([]);
  });

  it('awaria bazy przy UPDATE firmy nie cofa akceptacji faktury', async () => {
    db.failures['tenants:update'] = { code: '08006', message: 'zerwane' };
    await expect(runSubmitInvoice(event(), ctx)).resolves.toMatchObject({ success: true, ksefNumber: 'K-1' });
  });
});

describe('co liczy się jako pierwsza faktura', () => {
  const claim = (invoiceId: string, tenantId = TENANT) => recordFirstInvoiceAccepted({ tenantId, invoiceId });

  it.each([
    ['faktura zakupu', { direction: 'incoming', ksef_status: 'accepted', ksef_accepted_at: ACCEPTED_AT, origin: 'ksef_inbox' }],
    ['sprzedaż pobrana z historii KSeF', { ksef_status: 'accepted', ksef_accepted_at: ACCEPTED_AT, origin: 'ksef_import' }],
    ['faktura jeszcze nieprzyjęta', { ksef_status: 'sending', ksef_accepted_at: null }],
  ])('%s: nie liczy się', async (_name, patch) => {
    Object.assign(db.tables.invoices![0]!, patch);
    await claim(FIRST);
    expect(tenant().first_invoice_accepted_at).toBeNull();
    expect(posthog.messages).toEqual([]);
  });

  it('faktura innej firmy: identyfikator z cudzej firmy nic nie zmienia', async () => {
    Object.assign(db.tables.invoices![0]!, { ksef_status: 'accepted', ksef_accepted_at: ACCEPTED_AT });
    await claim(FIRST, OTHER_TENANT);
    expect(db.tables.tenants!.map((t) => t.first_invoice_accepted_at)).toEqual([null, null]);
    expect(posthog.messages).toEqual([]);
  });

  it('firma uzupełniona migracją: późniejsze faktury nie wysyłają zdarzenia', async () => {
    tenant().first_invoice_accepted_at = '2026-01-15T10:00:00.000Z';
    Object.assign(db.tables.invoices![0]!, { ksef_status: 'accepted', ksef_accepted_at: ACCEPTED_AT });
    await claim(FIRST);
    expect(tenant().first_invoice_accepted_at).toBe('2026-01-15T10:00:00.000Z');
    expect(posthog.messages).toEqual([]);
  });

  it('dwie faktury przyjęte równolegle: wygrywa jeden UPDATE, wysyła jeden worker', async () => {
    Object.assign(db.tables.invoices![0]!, { ksef_status: 'accepted', ksef_accepted_at: ACCEPTED_AT });
    Object.assign(db.tables.invoices![1]!, { ksef_status: 'accepted', ksef_accepted_at: LATER });
    await Promise.all([claim(FIRST), claim(SECOND)]);
    expect(posthog.sklejone('first_invoice_sent')).toHaveLength(1);
  });
});

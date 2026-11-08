import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * D-A4-1b-3 PR D (stos na #248): „Sprawdź ponownie” klienta na karcie faktury
 * w `failed / KSEF_DUPLICATE_RECONCILE`, gdy brakuje danych oryginału
 * (`recheckKsefDuplicateAction`). Do PR D klient czekał na cron I5 (48 h)
 * albo na „Tylko uzgodnij” operatora.
 *
 * Akcja (D4): rola właściciel/administrator → odczyt faktury SESJĄ (RLS) →
 * fakty i cooldown z `audit_logs` SESJĄ → ta sama polityka co karta →
 * `enqueueKsefSubmitAfterDraft` z `reconcileOnly: true` → audyt
 * `invoice.duplicate_recheck`. Klucz serwisowy w tej akcji nie czyta niczego
 * (mock rzuca), bo sesja widzi `ksef_submissions` i `audit_logs` własnej
 * firmy (00002:183-186, 00008).
 *
 * Prawdziwe: akcja, polityka, ładowarka faktów, `duplicate-check`.
 * Zastąpione: sesja Supabase (baza w pamięci), klucz serwisowy, kolejka
 * (`enqueueKsefSubmitAfterDraft` — jej wnętrze sprawdza
 * `sprawdz-ponownie-kolejka.test.ts`), audyt, środowisko KSeF, Sentry, cache.
 */

const m = vi.hoisted(() => ({
  db: null as null | import('./helpers/ponowienie-specjalne-baza').MemoryDb,
  role: 'owner',
  env: 'test' as string | null,
  enqueue: vi.fn(),
  logAudit: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  revalidate: vi.fn(),
  adminFrom: vi.fn(),
}));

vi.mock('@/lib/supabase/auth-context', () => {
  class ActionAuthError extends Error {}
  const ctx = async () => ({
    supabase: { from: (table: string) => m.db!.from(table), rpc: async () => ({ data: null, error: null }) },
    user: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
    tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    role: m.role,
  });
  return {
    ActionAuthError,
    requireUserAndActiveOrg: ctx,
    requireOrgRole: async () => {
      throw new Error('requireOrgRole: nieużywane w tej akcji (rola z requireUserAndActiveOrg)');
    },
  };
});
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    rpc: vi.fn(),
    from: (table: string) => {
      m.adminFrom(table);
      throw new Error(`akcja klienta: odczyt ${table} kluczem serwisowym zamiast sesją`);
    },
  }),
}));
vi.mock('@/lib/ksef/claim-environment', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ksef/claim-environment')>()),
  configuredKsefEnvironment: () => m.env,
}));
vi.mock('@sentry/nextjs', () => ({ captureMessage: m.captureMessage, captureException: m.captureException }));
vi.mock('next/cache', () => ({ revalidatePath: m.revalidate }));
vi.mock('@/lib/invoices/ksef-submit-enqueue', () => ({ enqueueKsefSubmitAfterDraft: m.enqueue }));
vi.mock('@/lib/audit/log', () => ({ logAudit: m.logAudit }));
vi.mock('@/lib/storage/r2', () => ({ downloadInvoiceXml: vi.fn() }));
vi.mock('@/lib/pdf/invoice-pdf', () => ({ generateInvoicePdf: vi.fn() }));
vi.mock('@/lib/pdf/invoice-data', () => ({ loadInvoiceForPdf: vi.fn() }));
vi.mock('@/lib/email/send', () => ({ sendInvoiceEmail: vi.fn() }));

import * as detailActions from '@/components/invoices/actions-detail';
import { KSEF_SEND_MESSAGES } from '@/lib/invoices/ksef-send-policy';
import { DUPLICATE_DECISION_TEXTS } from '@/lib/ksef/duplicate-decision';

import { K, duplicateCheck, knownNumberCheck, markerRow } from './helpers/decyzja-klienta';
import { memoryDb, type Row } from './helpers/ponowienie-specjalne-baza';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const X_ID = '22222222-2222-4222-8222-222222222221';
const OTHER_ID = '22222222-2222-4222-8222-222222222299';
const NR = 'FV/12/10/2026';
const NOW = new Date('2026-10-26T12:00:00.000Z');

type RecheckResult = { success: true; message: string } | { success: false; error: string };

const NO_ACTION = '(PR D: brak akcji recheckKsefDuplicateAction)';

async function recheck(invoiceId = X_ID): Promise<RecheckResult> {
  const action = (detailActions as unknown as Record<string, unknown>).recheckKsefDuplicateAction;
  if (typeof action !== 'function') return { success: false, error: NO_ACTION };
  return (action as (id: string) => Promise<RecheckResult>)(invoiceId);
}

const TEXTS = () => DUPLICATE_DECISION_TEXTS.RECHECK;

/** Faktura X: zwykła, failed `KSEF_DUPLICATE_RECONCILE`, z kopią danych do zdarzenia wysyłki. */
function invoiceRow(patch: Row = {}): Row {
  return {
    id: X_ID,
    tenant_id: TENANT,
    internal_number: NR,
    direction: 'outgoing',
    ksef_status: 'failed',
    last_error_code: 'KSEF_DUPLICATE_RECONCILE',
    last_error: 'KSeF ma już fakturę o tym numerze — do uzgodnienia.',
    ksef_number: null,
    invoice_kind: 'regular',
    invoice_type: 'VAT',
    stripe_invoice_id: null,
    offline_idempotency_key: null,
    offline_qr_offline: null,
    offline_qr_certyfikat: null,
    paid_amount: 0,
    issue_date: '2026-10-02',
    sale_date: null,
    buyer_nip: '1234567890',
    buyer_data: { nip: '1234567890', name: 'Nabywca testowy' },
    gross_total: 123,
    currency: 'PLN',
    fa3_data: { internalNumber: NR, lines: [], seller: { nip: '1234567890' } },
    special_data: null,
    ...patch,
  };
}

const NO_DATA_CHECKS: Array<[string, Row | null, string]> = [
  ['no-check', null, 'no-check'],
  ['download-refused', duplicateCheck({ reason: 'download-refused', httpStatus: 403 }), 'download-refused'],
  ['download-pending', duplicateCheck({ reason: 'download-pending', httpStatus: 503 }), 'download-pending'],
  ['storage-pending', duplicateCheck({ reason: 'storage-pending' }), 'storage-pending'],
  ['archive-pending', duplicateCheck({ reason: 'archive-pending' }), 'archive-pending'],
  ['env-mismatch', duplicateCheck({ env: 'production' }), 'env-mismatch'],
];

function seed(o: { invoice?: Row; check?: Row | null; submissions?: Row[]; audit?: Row[] } = {}) {
  const check = o.check === undefined ? duplicateCheck({ reason: 'download-pending', httpStatus: 503 }) : o.check;
  m.db = memoryDb({
    invoices: [o.invoice ?? invoiceRow()],
    ksef_submissions: o.submissions ?? [markerRow(TENANT, X_ID, { original_check: check })],
    audit_logs: o.audit ?? [],
    tenants: [{ id: TENANT, nip: '1234567890' }],
  });
}

const auditRow = (agoMs: number, patch: Row = {}): Row => ({
  id: `audit-${agoMs}`,
  tenant_id: TENANT,
  user_id: USER,
  action: 'invoice.duplicate_recheck',
  entity_type: 'invoice',
  entity_id: X_ID,
  created_at: new Date(NOW.getTime() - agoMs).toISOString(),
  ...patch,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  m.role = 'owner';
  m.env = 'test';
  seed();
  m.enqueue.mockResolvedValue({ ok: true, mode: 'online_queued', sendAttemptId: 'att-1' });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('PR D: recheckKsefDuplicateAction: sukces', () => {
  it.each(NO_DATA_CHECKS)('powód %s: kolejkuje uzgodnienie (reconcileOnly) i zapisuje audyt', async (_name, check, reason) => {
    seed({ check });
    const result = await recheck();
    expect(result).toEqual({ success: true, message: TEXTS().QUEUED(NR) });

    expect(m.enqueue).toHaveBeenCalledTimes(1);
    expect(m.enqueue.mock.calls[0]![0]).toMatchObject({
      tenantId: TENANT,
      userId: USER,
      invoiceId: X_ID,
      nip: '1234567890',
      auditKind: 'regular',
      // Tryb uzgodnienia: `requeue_ksef_send(p_reconcile_only = true)`, runner nigdy nie wysyła.
      mode: { kind: 'requeue', actorUserId: USER, reconcileOnly: true },
    });

    expect(m.logAudit).toHaveBeenCalledTimes(1);
    expect(m.logAudit.mock.calls[0]![0]).toMatchObject({
      action: 'invoice.duplicate_recheck',
      tenantId: TENANT,
      userId: USER,
      entityType: 'invoice',
      entityId: X_ID,
      metadata: { reason, originalKsefNumber: K, sendAttemptId: 'att-1' },
    });
    expect(m.revalidate).toHaveBeenCalledWith(`/invoices/${X_ID}`);
    // Sesja czyta wszystko: klucz serwisowy w tej akcji nie czyta niczego.
    expect(m.adminFrom).not.toHaveBeenCalled();
  });

  it('administrator też może', async () => {
    m.role = 'admin';
    expect(await recheck()).toEqual({ success: true, message: TEXTS().QUEUED(NR) });
  });
});

describe('PR D: recheckKsefDuplicateAction: odmowy', () => {
  it('członek firmy: zdanie o właścicielu, bez kolejki i audytu (D1)', async () => {
    m.role = 'member';
    const result = await recheck();
    expect(result).toEqual({ success: false, error: TEXTS().ROLE });
    expect(m.enqueue).not.toHaveBeenCalled();
    expect(m.logAudit).not.toHaveBeenCalled();
  });

  it('faktura z innej firmy albo nieistniejąca: „nie znaleziono”', async () => {
    expect(await recheck(OTHER_ID)).toEqual({ success: false, error: KSEF_SEND_MESSAGES.notFound });
    seed({ invoice: invoiceRow({ tenant_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }) });
    expect(await recheck()).toEqual({ success: false, error: KSEF_SEND_MESSAGES.notFound });
    expect(m.enqueue).not.toHaveBeenCalled();
  });

  it.each([
    ['no-own-file (panel decyzji)', duplicateCheck()],
    ['known-number (panel decyzji)', knownNumberCheck()],
    ['same-content-other-program', duplicateCheck({ reason: 'same-content-other-program' })],
    ['archive-conflict', duplicateCheck({ reason: 'archive-conflict' })],
  ] as const)('powód %s: bez przycisku, zdanie z numerem dokumentu', async (_name, check) => {
    seed({ check });
    expect(await recheck()).toEqual({ success: false, error: TEXTS().NOT_AVAILABLE(NR) });
    expect(m.enqueue).not.toHaveBeenCalled();
  });

  it('faktura nie jest w KSEF_DUPLICATE_RECONCILE: zdanie z numerem dokumentu', async () => {
    seed({ invoice: invoiceRow({ last_error_code: 'KSEF_NUMBER_TAKEN' }) });
    expect(await recheck()).toEqual({ success: false, error: TEXTS().NOT_AVAILABLE(NR) });
    expect(m.enqueue).not.toHaveBeenCalled();
  });

  it.each(['queued', 'sending'])('status %s: „Sprawdzamy ponownie w KSeF”, bez drugiego zlecenia', async (status) => {
    seed({ invoice: invoiceRow({ ksef_status: status, last_error_code: null }) });
    const result = await recheck();
    expect(result).toEqual({ success: false, error: `Sprawdzamy ponownie w KSeF dokument ${NR}. Odśwież stronę za kilka minut.` });
    expect(result).toEqual({ success: false, error: TEXTS().IN_FLIGHT(NR) });
    expect(m.enqueue).not.toHaveBeenCalled();
  });

  it('nieznane środowisko aplikacji: tekst o sprawdzaniu z numerem dokumentu (nie zdanie z wysyłki), bez kolejki', async () => {
    m.env = null;
    const result = await recheck();
    expect(result).toEqual({ success: false, error: TEXTS().ENV_UNKNOWN(NR) });
    expect((result as { error: string }).error).toContain(NR);
    expect((result as { error: string }).error).not.toBe(KSEF_SEND_MESSAGES.envUnknown);
    expect(m.enqueue).not.toHaveBeenCalled();
  });

  it('dokument specjalny bez kopii danych: zdanie z numerem dokumentu, bez kolejki', async () => {
    seed({ invoice: invoiceRow({ invoice_kind: 'correction', special_data: null }) });
    const result = await recheck();
    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain(NR);
    expect(m.enqueue).not.toHaveBeenCalled();
  });

  it('odczyt faktur lub wpisów nie powiódł się: ogólne zdanie i Sentry, bez kolejki', async () => {
    m.db = memoryDb({ invoices: [invoiceRow()], ksef_submissions: [], audit_logs: [] });
    const original = m.db.from.bind(m.db);
    m.db.from = ((table: string) => {
      if (table === 'ksef_submissions') throw new Error('baza nie odpowiada');
      return original(table);
    }) as typeof m.db.from;
    const result = await recheck();
    expect(result).toEqual({ success: false, error: TEXTS().GENERIC });
    expect(m.captureException).toHaveBeenCalledTimes(1);
    expect(m.enqueue).not.toHaveBeenCalled();
  });
});

describe('PR D: cooldown 10 minut (D3) i podwójne kliknięcie (D5)', () => {
  it('poprzednie sprawdzenie 5 minut temu: odmowa z minutami do końca', async () => {
    seed({ audit: [auditRow(5 * 60_000)] });
    expect(await recheck()).toEqual({ success: false, error: TEXTS().COOLDOWN(NR, 5) });
    expect(m.enqueue).not.toHaveBeenCalled();
    expect(m.logAudit).not.toHaveBeenCalled();
  });

  it('9:59 odmowa, 10:00 sukces (granica)', async () => {
    seed({ audit: [auditRow(9 * 60_000 + 59_000)] });
    expect((await recheck()).success).toBe(false);
    seed({ audit: [auditRow(10 * 60_000)] });
    expect((await recheck()).success).toBe(true);
  });

  it('liczy się najnowszy wpis tej faktury; cudze wpisy i inne akcje audytu nie blokują', async () => {
    seed({
      audit: [
        auditRow(20 * 60_000),
        auditRow(60_000, { entity_id: OTHER_ID, id: 'audit-inna-faktura' }),
        auditRow(60_000, { action: 'invoice.submit_requested', id: 'audit-inna-akcja' }),
      ],
    });
    expect((await recheck()).success).toBe(true);
    seed({ audit: [auditRow(20 * 60_000), auditRow(2 * 60_000, { id: 'audit-swieze' })] });
    expect(await recheck()).toEqual({ success: false, error: TEXTS().COOLDOWN(NR, 8) });
  });

  it('drugie kliknięcie po sukcesie: faktura jest w kolejce, więc odmowa „sprawdzamy ponownie”; zlecenie jedno', async () => {
    m.enqueue.mockImplementation(async () => {
      // Lustro `requeue_ksef_send` (00131): failed → queued, kod błędu czyszczony, w tej samej transakcji.
      Object.assign(m.db!.tables.invoices![0]!, { ksef_status: 'queued', last_error_code: null });
      return { ok: true, mode: 'online_queued', sendAttemptId: 'att-1' };
    });
    expect((await recheck()).success).toBe(true);
    expect(await recheck()).toEqual({ success: false, error: TEXTS().IN_FLIGHT(NR) });
    expect(m.enqueue).toHaveBeenCalledTimes(1);
  });

  it('po powrocie do failed w cooldownie (nowy werdykt): audyt z pierwszego kliknięcia blokuje kolejne', async () => {
    m.logAudit.mockImplementation(async (entry: Record<string, unknown>) => {
      m.db!.tables.audit_logs!.push({ ...entry, entity_id: entry.entityId, tenant_id: entry.tenantId, created_at: new Date().toISOString() });
    });
    expect((await recheck()).success).toBe(true);
    vi.setSystemTime(new Date(NOW.getTime() + 3 * 60_000));
    expect(await recheck()).toEqual({ success: false, error: TEXTS().COOLDOWN(NR, 7) });
    vi.setSystemTime(new Date(NOW.getTime() + 10 * 60_000));
    expect((await recheck()).success).toBe(true);
    expect(m.enqueue).toHaveBeenCalledTimes(2);
  });
});

describe('PR D: odmowy kolejki i błędy nieoczekiwane', () => {
  it('hamulec wysyłki (pauza operatora): zdanie z numerem dokumentu, bez audytu', async () => {
    m.enqueue.mockResolvedValue({ ok: false, error: TEXTS().PAUSED(NR) });
    const result = await recheck();
    expect(result).toEqual({ success: false, error: TEXTS().PAUSED(NR) });
    expect((result as { error: string }).error).toContain(NR);
    expect(m.logAudit).not.toHaveBeenCalled();
  });

  it('odmowa kolejki bez numeru dokumentu w tekście dostaje numer z przodu', async () => {
    m.enqueue.mockResolvedValue({ ok: false, error: 'Wymagane potwierdzenie drugim składnikiem.', code: 'MFA_REQUIRED' });
    const result = await recheck();
    expect(result).toEqual({ success: false, error: TEXTS().REFUSED(NR, 'Wymagane potwierdzenie drugim składnikiem.') });
    expect((result as { error: string }).error).toContain(NR);
    expect(m.logAudit).not.toHaveBeenCalled();
  });

  it('kolejka rzuca: Sentry i ogólne zdanie', async () => {
    m.enqueue.mockRejectedValue(new Error('pg-boss padł'));
    const result = await recheck();
    expect(result).toEqual({ success: false, error: TEXTS().GENERIC });
    expect(m.captureException).toHaveBeenCalledTimes(1);
    expect(m.captureException.mock.calls[0]![1]).toMatchObject({ tags: { area: 'ksef.duplicate-recheck' } });
    expect(m.logAudit).not.toHaveBeenCalled();
  });
});

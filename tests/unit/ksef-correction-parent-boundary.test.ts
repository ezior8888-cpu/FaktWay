import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  logAudit: vi.fn(),
  enqueue: vi.fn(),
}));
vi.mock('@/lib/supabase/auth-context', () => ({
  requireUserAndActiveOrg: mocks.requireAuth,
}));
vi.mock('@/lib/audit/log', () => ({ logAudit: mocks.logAudit }));
vi.mock('@/lib/invoices/ksef-submit-enqueue', () => ({
  enqueueKsefSubmitAfterDraft: mocks.enqueue,
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/xml/invoice-calculator', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/xml/invoice-calculator')>(),
  // Only fictional NIPs are used in this security fixture.
  validateNipChecksum: () => true,
}));

import {
  getCorrectionParentContextAction,
  saveAndSendCorrectionAction,
  saveCorrectionDraftAction,
} from '@/components/invoices/correction-actions';
import type { CorrectionInvoiceSchemaIn } from '@/lib/validators/invoice-validators';

const tenantId = '11111111-1111-4111-8111-111111111111';
const parentId = '22222222-2222-4222-8222-222222222222';
const sellerNip = '1234567890';
const parentNumber = 'TEST/2026/1';
const ksefNumber = '1234567890-20260926-ABCDEF';
const address = { countryCode: 'PL', addressLine1: 'Testowa 1', addressLine2: '00-000 Test' };
const seller = { nip: sellerNip, name: 'Fixture seller', address };
const buyer = { type: 'b2b' as const, idType: 'nip' as const, nip: sellerNip, name: 'Fixture buyer', address };
const originalLine = { name: 'Service', unit: 'szt', quantity: 1, unitPriceNet: 100, vatRate: '23' as const };

const basePayload: CorrectionInvoiceSchemaIn = {
  invoiceType: 'correction',
  internalNumber: 'KOR/2026/1',
  issueDate: '2026-09-26',
  paymentMethod: 'transfer',
  paymentDueDate: '2026-10-03',
  parentInvoiceId: parentId,
  parentInvoiceNumber: parentNumber,
  parentInvoiceIssueDate: '2026-09-10',
  parentKsefNumber: ksefNumber,
  correctionType: 'amount_change',
  correctionReason: 'Poprawa kwoty usługi',
  typKorekty: '2',
  seller,
  buyer,
  amountChange: { netDelta: -10, vatDelta: -2.3, grossDelta: -12.3, description: 'Zmniejszenie' },
};

type Row = Record<string, unknown>;
type QueryLog = { table: string; operation: string; filters: Record<string, unknown>; payload?: unknown };
let parent: Row;
let lines: Row[];
let queries: QueryLog[];

function from(table: string) {
  const record: QueryLog = { table, operation: 'select', filters: {} };
  queries.push(record);
  const result = () => {
    if (table === 'tenants') {
      return { data: { id: tenantId, nip: sellerNip, name: 'Fixture seller', address_json: address }, error: null };
    }
    if (table === 'invoices' && record.operation === 'insert') {
      return { data: { id: '33333333-3333-4333-8333-333333333333' }, error: null };
    }
    if (table === 'invoices') {
      const match = Object.entries(record.filters).every(([key, value]) => parent[key] === value);
      return { data: match ? parent : null, error: null };
    }
    if (table === 'invoice_line_items' && record.operation === 'select') {
      return { data: lines, error: null };
    }
    return { data: null, error: null };
  };
  const chain = {
    select: () => chain,
    eq: (key: string, value: unknown) => { record.filters[key] = value; return chain; },
    order: () => chain,
    insert: (payload: unknown) => { record.operation = 'insert'; record.payload = payload; return chain; },
    maybeSingle: async () => result(),
    single: async () => result(),
    then: <T,>(resolve: (value: ReturnType<typeof result>) => T) => Promise.resolve(result()).then(resolve),
  };
  return chain;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('KSEF_ENV', 'production');
  // Wysyłka przyjmuje tylko dzisiejszą datę wystawienia (A1, W5) — testy
  // działają w dniu daty z danych testowych (2026-09-26).
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-26T10:00:00Z'));
  queries = [];
  parent = {
    id: parentId, tenant_id: tenantId, direction: 'outgoing', invoice_kind: 'regular',
    ksef_status: 'accepted', ksef_environment: 'production',
    issue_date: '2026-09-10', internal_number: parentNumber, ksef_number: ksefNumber,
    seller_data: seller, buyer_data: buyer, net_total: 100, vat_total: 23, gross_total: 123,
  };
  lines = [{ name: originalLine.name, unit: originalLine.unit, quantity: 1, unit_price_net: 100, vat_rate: '23' }];
  mocks.requireAuth.mockResolvedValue({
    supabase: { from },
    user: { id: 'fixture-user' },
    tenantId,
    role: 'member',
  });
  mocks.enqueue.mockResolvedValue({ ok: true, mode: 'online_queued' });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function expectNoWrite() {
  expect(queries.some((query) => query.operation === 'insert')).toBe(false);
  expect(mocks.enqueue).not.toHaveBeenCalled();
}

describe('correction parent boundary', () => {
  it.each([
    ['parent context, MFA', () => getCorrectionParentContextAction(parentId), 'Wymagana weryfikacja dwuetapowa'],
    ['parent context, membership', () => getCorrectionParentContextAction(parentId), 'Brak dostępu do aktywnej organizacji'],
    ['draft, MFA', () => saveCorrectionDraftAction(basePayload, tenantId), 'Wymagana weryfikacja dwuetapowa'],
    ['draft, membership', () => saveCorrectionDraftAction(basePayload, tenantId), 'Brak dostępu do aktywnej organizacji'],
    ['send, MFA', () => saveAndSendCorrectionAction(basePayload, tenantId), 'Wymagana weryfikacja dwuetapowa'],
    ['send, membership', () => saveAndSendCorrectionAction(basePayload, tenantId), 'Brak dostępu do aktywnej organizacji'],
  ])('rejects %s before reading or writing', async (_label, action, reason) => {
    vi.stubEnv('KSEF_ENV', 'test');
    mocks.requireAuth.mockRejectedValueOnce(new Error(reason));
    const result = await action();
    expect(result).toMatchObject({ success: false, error: reason });
    expect(queries).toHaveLength(0);
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.logAudit).not.toHaveBeenCalled();
  });

  it.each(['draft', 'send'])('requires a proven parent before %s', async (kind) => {
    if (kind === 'send') {
      vi.stubEnv('KSEF_ENV', 'test');
      parent.ksef_environment = 'test';
    }
    const action = kind === 'draft' ? saveCorrectionDraftAction : saveAndSendCorrectionAction;
    const result = await action(basePayload, tenantId);
    expect(result).toMatchObject({ success: true });
    const parentRead = queries.find((query) => query.table === 'invoices' && query.operation === 'select');
    expect(parentRead?.filters).toMatchObject({
      id: parentId, tenant_id: tenantId, direction: 'outgoing',
      invoice_kind: 'regular', ksef_status: 'accepted',
      ksef_environment: kind === 'send' ? 'test' : 'production',
    });
    expect(queries).toContainEqual(expect.objectContaining({
      table: 'invoices', operation: 'insert',
      payload: expect.objectContaining({ parent_invoice_id: parentId, tenant_id: tenantId }),
    }));
    expect(mocks.enqueue).toHaveBeenCalledTimes(kind === 'send' ? 1 : 0);
  });

  it('does not create or enqueue an unproven legal correction in PROD', async () => {
    const result = await saveAndSendCorrectionAction(basePayload, tenantId);
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('PROD') });
    expectNoWrite();
  });

  it('stores the monetary delta that appears in amount-change KOR XML', async () => {
    const result = await saveCorrectionDraftAction(basePayload, tenantId);
    expect(result).toMatchObject({ success: true });
    expect(queries).toContainEqual(expect.objectContaining({
      table: 'invoices', operation: 'insert',
      payload: expect.objectContaining({
        net_total: -10, vat_total: -2.3, gross_total: -12.3,
        fa3_data: expect.objectContaining({ netTotal: -10, vatTotal: -2.3, grossTotal: -12.3 }),
      }),
    }));
  });

  it.each([
    ['gross differs from net plus VAT', { netDelta: -10, vatDelta: -2.3, grossDelta: -99 }],
    ['VAT has no supported rate', { netDelta: -10, vatDelta: -1.7, grossDelta: -11.7 }],
  ])('rejects an amount change when %s', async (_label, change) => {
    const result = await saveCorrectionDraftAction({
      ...basePayload, amountChange: { ...basePayload.amountChange!, ...change },
    }, tenantId);
    expect(result).toMatchObject({ success: false });
    expectNoWrite();
  });

  it('assigns a negative 8% amount change to 8%, not 23%', async () => {
    const result = await saveCorrectionDraftAction({
      ...basePayload,
      amountChange: {
        ...basePayload.amountChange!, netDelta: -100, vatDelta: -8, grossDelta: -108,
      },
    }, tenantId);
    expect(result).toMatchObject({ success: true });
    expect(queries).toContainEqual(expect.objectContaining({
      table: 'invoice_line_items', operation: 'insert',
      payload: expect.arrayContaining([expect.objectContaining({ vat_rate: '8' })]),
    }));
  });

  it.each([
    ['foreign tenant', { tenant_id: '44444444-4444-4444-8444-444444444444' }],
    ['TEST parent', { ksef_environment: 'test' }],
    ['legacy parent', { ksef_environment: null }],
    ['draft parent', { ksef_status: 'draft' }],
    ['incoming parent', { direction: 'incoming' }],
    ['correction parent', { invoice_kind: 'correction' }],
    ['no KSeF number', { ksef_number: null }],
  ])('rejects %s before a write', async (_label, patch) => {
    parent = { ...parent, ...patch };
    expect((await saveCorrectionDraftAction(basePayload, tenantId)).success).toBe(false);
    expectNoWrite();
  });

  it.each([
    ['number', { parentInvoiceNumber: 'FORGED/1' }],
    ['date', { parentInvoiceIssueDate: '2026-09-11' }],
    ['KSeF number', { parentKsefNumber: 'FORGED' }],
    ['seller NIP', { seller: { ...seller, nip: '9876543210' } }],
  ])('rejects a forged parent %s', async (_label, patch) => {
    const result = await saveCorrectionDraftAction({ ...basePayload, ...patch } as CorrectionInvoiceSchemaIn, tenantId);
    expect(result.success).toBe(false);
    expectNoWrite();
  });

  it('rejects tampered cancellation amounts before INSERT', async () => {
    const result = await saveCorrectionDraftAction({
      ...basePayload, correctionType: 'cancellation', amountChange: undefined,
      linesBefore: [{ ...originalLine, unitPriceNet: 1000 }],
    }, tenantId);
    expect(result).toMatchObject({ success: false });
    expectNoWrite();
  });

  it('rejects forged before-lines for a before/after correction', async () => {
    const result = await saveCorrectionDraftAction({
      ...basePayload, correctionType: 'before_after', amountChange: undefined,
      linesBefore: [{ ...originalLine, unitPriceNet: 1000 }],
      linesAfter: [{ ...originalLine, unitPriceNet: 90 }],
    }, tenantId);
    expect(result).toMatchObject({ success: false });
    expectNoWrite();
  });

  it('uses accepted parent lines for a valid before/after correction', async () => {
    const result = await saveCorrectionDraftAction({
      ...basePayload, correctionType: 'before_after', amountChange: undefined,
      linesBefore: [originalLine],
      linesAfter: [{ ...originalLine, unitPriceNet: 90 }],
    }, tenantId);
    expect(result).toMatchObject({ success: true });
    expect(queries).toContainEqual(expect.objectContaining({
      table: 'invoice_line_items', operation: 'select', filters: { invoice_id: parentId },
    }));
  });

  it.each(['amount_change', 'cancellation'] as const)(
    'rejects a forged %s buyer before INSERT', async (correctionType) => {
    const result = await saveCorrectionDraftAction({
      ...basePayload, correctionType,
      amountChange: correctionType === 'cancellation' ? undefined : basePayload.amountChange,
      buyer: { ...buyer, name: 'Inna firma' }, linesBefore: undefined,
    }, tenantId);
    expect(result).toMatchObject({ success: false });
    expectNoWrite();
    },
  );

  it('derives cancellation lines from the accepted parent when absent', async () => {
    const result = await saveCorrectionDraftAction({
      ...basePayload, correctionType: 'cancellation', amountChange: undefined, linesBefore: undefined,
    }, tenantId);
    expect(result.success).toBe(true);
    expect(queries).toContainEqual(expect.objectContaining({
      table: 'invoice_line_items', operation: 'select', filters: { invoice_id: parentId },
    }));
  });

  it.each([
    ['missing quantity', { quantity: null }],
    ['missing price', { unit_price_net: null }],
  ])('rejects accepted legacy lines with %s', async (_label, patch) => {
    lines = [{ ...lines[0], ...patch }];
    const result = await saveCorrectionDraftAction({
      ...basePayload, correctionType: 'cancellation', amountChange: undefined, linesBefore: undefined,
    }, tenantId);
    expect(result).toMatchObject({ success: false });
    expectNoWrite();
  });

  it('rejects cancellation when stored lines do not reconcile to the accepted header', async () => {
    parent.gross_total = 999;
    const result = await saveCorrectionDraftAction({
      ...basePayload, correctionType: 'cancellation', amountChange: undefined, linesBefore: undefined,
    }, tenantId);
    expect(result).toMatchObject({ success: false });
    expectNoWrite();
  });

  it('fails closed rather than converting historical VAT exemption to 23%', async () => {
    lines = [{ ...lines[0], vat_rate: 'zw' }];
    const result = await saveCorrectionDraftAction({
      ...basePayload, correctionType: 'cancellation', amountChange: undefined, linesBefore: undefined,
    }, tenantId);
    expect(result).toMatchObject({ success: false });
    expectNoWrite();
  });

  it('does not reveal a parent from another KSeF environment in context action', async () => {
    parent.ksef_environment = 'test';
    expect((await getCorrectionParentContextAction(parentId)).success).toBe(false);
    expectNoWrite();
  });
});

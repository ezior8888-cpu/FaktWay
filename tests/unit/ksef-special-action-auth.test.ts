import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  createClient: vi.fn(),
  enqueue: vi.fn(),
  logAudit: vi.fn(),
}));

vi.mock('@/lib/supabase/auth-context', () => ({
  requireUserAndActiveOrg: mocks.requireAuth,
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: mocks.createClient,
}));
vi.mock('@/lib/invoices/ksef-submit-enqueue', () => ({
  enqueueKsefSubmitAfterDraft: mocks.enqueue,
}));
vi.mock('@/lib/audit/log', () => ({ logAudit: mocks.logAudit }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/xml/invoice-calculator', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/xml/invoice-calculator')>(),
  // Fixture NIPs are deliberately fictional.
  validateNipChecksum: () => true,
}));

import {
  saveAdvanceAction,
  saveAndSendAdvanceAction,
} from '@/components/invoices/advance-actions';
import {
  saveFinalAction,
  saveAndSendFinalAction,
} from '@/components/invoices/final-actions';
import { generateAdvanceInvoiceXml } from '@/lib/ksef/fa3-advance-generator';
import { validateInvoiceXml } from '@/lib/xml/validator';
import { advanceInvoiceSchema, finalInvoiceSchema } from '@/lib/validators/invoice-validators';
import type { AdvanceInvoiceData } from '@/types/invoice-types';
import type { Invoice } from '@/types/invoice';

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('KSEF_ENV', 'test');
  // Wysyłka przyjmuje tylko dzisiejszą datę wystawienia (A1, W5) — testy
  // działają w dniu daty z danych testowych (2026-09-28).
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-28T10:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('special invoice actions', () => {
  it.each([
    ['advance draft', () => saveAdvanceAction({}, tenantId)],
    ['advance send', () => saveAndSendAdvanceAction({}, tenantId)],
    ['final draft', () => saveFinalAction({}, tenantId)],
    ['final send', () => saveAndSendFinalAction({}, tenantId)],
  ])('denies %s before any tenant read, write or enqueue when MFA is pending', async (_label, action) => {
    mocks.requireAuth.mockRejectedValueOnce(new Error('Wymagana weryfikacja dwuetapowa'));
    const result = await action();

    expect(result).toMatchObject({
      success: false,
      error: 'Wymagana weryfikacja dwuetapowa',
    });
    expect(mocks.requireAuth).toHaveBeenCalledTimes(1);
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.logAudit).not.toHaveBeenCalled();
  });
});

const tenantId = '11111111-1111-4111-8111-111111111111';
const advanceId = '22222222-2222-4222-8222-222222222222';
const invoiceId = '33333333-3333-4333-8333-333333333333';
const address = { countryCode: 'PL', addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa' };
const seller = { nip: '1234567890', name: 'Fixture seller', address };
const buyer = { type: 'b2b' as const, idType: 'nip' as const, nip: '1234567890', name: 'Fixture buyer', address };
const common = {
  internalNumber: 'SPEC/2026/1', issueDate: '2026-09-28', paymentMethod: 'transfer' as const,
  paymentDueDate: '2026-10-05', bankAccount: '1'.repeat(26), seller, buyer,
};
const advanceInput = {
  ...common, invoiceType: 'advance' as const, advanceAmount: 123,
  totalContractAmount: 1000, vatRate: '23' as const, description: 'Testowa zaliczka na usługę',
  splitPayment: false,
};
const finalInput = {
  ...common, invoiceType: 'final' as const, advanceInvoiceIds: [advanceId],
  totalAdvances: 123, splitPayment: false,
  lines: [{ name: 'Testowa usługa', unit: 'szt', quantity: 1, unitPriceNet: 1000, vatRate: '23' as const }],
};

type Query = { table: string; operation: 'select' | 'insert' | 'delete'; columns?: string; payload?: unknown };
let tenantRow: Record<string, unknown>;
let queries: Query[];
let cashMethodError: { code: string; message: string } | null;
/** ROZ already pointing at an advance (AUD-67). */
let settlingFinals: Array<{ id: string; internal_number: string; advance_invoice_ids: string[] }>;
let settledLookupError: { message: string } | null;

function from(table: string) {
  const query: Query = { table, operation: 'select' };
  queries.push(query);
  const result = () => {
    if (table === 'tenants') {
      if (query.columns === 'vat_cash_method' && cashMethodError) {
        return { data: null, error: cashMethodError };
      }
      return { data: tenantRow, error: null };
    }
    if (table === 'invoices' && query.operation === 'insert') {
      return { data: { id: invoiceId }, error: null };
    }
    if (table === 'invoices' && query.columns?.includes('advance_invoice_ids')) {
      if (settledLookupError) return { data: null, error: settledLookupError };
      return { data: settlingFinals, error: null };
    }
    if (table === 'invoices') {
      return { data: [{ id: advanceId, internal_number: 'ZAL/2026/1',
        ksef_number: 'KSEF-TEST-1', issue_date: '2026-09-20', advance_amount: 123,
        gross_total: 123, invoice_kind: 'advance' }], error: null };
    }
    return { data: null, error: null };
  };
  const chain = {
    select: (columns?: string) => { query.columns = columns; return chain; },
    eq: () => chain,
    or: () => chain,
    in: () => chain,
    overlaps: () => chain,
    insert: (payload: unknown) => { query.operation = 'insert'; query.payload = payload; return chain; },
    delete: () => { query.operation = 'delete'; return chain; },
    single: async () => result(),
    maybeSingle: async () => result(),
    then: <T,>(resolve: (value: ReturnType<typeof result>) => T) => Promise.resolve(result()).then(resolve),
  };
  return chain;
}

describe('ZAL/ROZ seller authority', () => {
  beforeEach(() => {
    tenantRow = { id: tenantId, nip: seller.nip, name: seller.name,
      address_json: address, vat_cash_method: false };
    queries = [];
    cashMethodError = null;
    settlingFinals = [];
    settledLookupError = null;
    mocks.requireAuth.mockResolvedValue({
      supabase: { from }, user: { id: 'fixture-user' }, tenantId, role: 'member',
    });
    mocks.enqueue.mockResolvedValue({ ok: true });
  });

  it.each([
    ['advance draft', () => saveAdvanceAction(advanceInput, tenantId)],
    ['advance send', () => saveAndSendAdvanceAction(advanceInput, tenantId)],
    ['final draft', () => saveFinalAction(finalInput, tenantId)],
  ])('uses the server tenant seller in %s', async (label, action) => {
    const result = await action();
    expect(result).toMatchObject({ success: true, invoiceId });
    const inserted = queries.find((q) => q.table === 'invoices' && q.operation === 'insert');
    expect(inserted?.payload).toMatchObject({
      seller_nip: seller.nip,
      seller_data: { nip: seller.nip, name: seller.name, address },
      fa3_data: { seller: { nip: seller.nip, name: seller.name, address } },
    });
    if (label.endsWith('send')) {
      expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({
        invoice: expect.objectContaining({ seller: expect.objectContaining({ nip: seller.nip, address }) }),
        [label.startsWith('advance') ? 'advanceData' : 'finalData']:
          expect.objectContaining({ seller: expect.objectContaining({ nip: seller.nip, address }) }),
      }));
    } else {
      expect(mocks.enqueue).not.toHaveBeenCalled();
    }
  });

  // Wysyłka ROZ jest w main wstrzymana do partii 15 audytu (AUD-23 ROZ, 67, 95)
  // — akcja nie zapisuje nowej faktury i nie zleca joba.
  it('final send stays on hold until settlement fixes (partia 15)', async () => {
    const result = await saveAndSendFinalAction(finalInput, tenantId);
    expect(result).toMatchObject({ success: false });
    expect(queries.some((q) => q.table === 'invoices' && q.operation === 'insert')).toBe(false);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it.each([
    ['NIP', { ...seller, nip: '9999999999' }],
    ['name', { ...seller, name: 'Other seller' }],
    ['address', { ...seller, address: { ...address, addressLine1: 'ul. Obca 2' } }],
  ])('rejects forged %s before writing an advance or final invoice', async (_field, forged) => {
    for (const [action, payload] of [
      [saveAndSendAdvanceAction, { ...advanceInput, seller: forged }],
      [saveAndSendFinalAction, { ...finalInput, seller: forged }],
    ] as const) {
      queries = [];
      const result = await action(payload, tenantId);
      expect(result).toMatchObject({ success: false });
      expect(queries.some((q) => q.table === 'invoices')).toBe(false);
      expect(mocks.enqueue).not.toHaveBeenCalled();
    }
  });

  it('rejects an incomplete or malformed tenant address without an XML placeholder', async () => {
    for (const malformed of [{ countryCode: 'PL', addressLine1: 'ul. Testowa 1' }, 42]) {
      tenantRow.address_json = malformed;
      queries = [];
      const result = await saveAndSendAdvanceAction(advanceInput, tenantId);
      expect(result).toMatchObject({ success: false });
      expect(queries.some((q) => q.table === 'invoices')).toBe(false);
      expect(mocks.enqueue).not.toHaveBeenCalled();
    }
  });

  it.each([
    ['cash method and MPP', true, true, '<P_16>1</P_16>', '<P_18A>1</P_18A>'],
    ['ordinary VAT and no MPP', false, false, '<P_16>2</P_16>', '<P_18A>2</P_18A>'],
  ])('freezes %s in draft/event and valid FA(3) XML', async (_label, cash, mpp, p16, p18a) => {
    tenantRow.vat_cash_method = cash;
    const result = await saveAndSendAdvanceAction({ ...advanceInput, splitPayment: mpp }, tenantId);
    expect(result).toMatchObject({ success: true, invoiceId });
    const event = mocks.enqueue.mock.calls[0]?.[0] as
      | { invoice: Invoice; advanceData: AdvanceInvoiceData }
      | undefined;
    expect(event).toBeDefined();
    expect(event?.invoice.annotations).toEqual({ cashMethod: cash ? 1 : 2, splitPayment: mpp ? 1 : 2 });
    expect(event?.advanceData.taxAnnotations).toEqual(event?.invoice.annotations);
    const inserted = queries.find((q) => q.table === 'invoices' && q.operation === 'insert');
    expect(inserted?.payload).toMatchObject({
      fa3_data: { annotations: event?.invoice.annotations },
    });
    const xml = generateAdvanceInvoiceXml(event!.advanceData);
    expect(xml).toContain(p16);
    expect(xml).toContain(p18a);
    const validation = await validateInvoiceXml(xml);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
    expect(() => generateAdvanceInvoiceXml({
      ...event!.advanceData,
      taxAnnotations: undefined as unknown as AdvanceInvoiceData['taxAnnotations'],
    })).toThrow('P_16/P_18A');
  });

  it('requires an explicit MPP answer and a bank transfer when MPP applies', async () => {
    const noAnswer: Partial<typeof advanceInput> = { ...advanceInput };
    delete noAnswer.splitPayment;
    expect(advanceInvoiceSchema.safeParse(noAnswer).success).toBe(false);
    expect(await saveAndSendAdvanceAction(noAnswer, tenantId)).toMatchObject({ success: false });
    expect(await saveAndSendAdvanceAction({ ...advanceInput, splitPayment: true, bankAccount: '' }, tenantId))
      .toMatchObject({ success: false });
    expect(await saveAndSendAdvanceAction({ ...advanceInput, splitPayment: true, paymentMethod: 'cash' }, tenantId))
      .toMatchObject({ success: false });
    expect(queries.some((q) => q.table === 'invoices')).toBe(false);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it.each([
    ['cash method and MPP', true, true],
    ['ordinary VAT and no MPP', false, false],
  ])('freezes %s in the ROZ draft (AUD-23)', async (_label, cash, mpp) => {
    tenantRow.vat_cash_method = cash;
    const result = await saveFinalAction({ ...finalInput, splitPayment: mpp }, tenantId);
    expect(result).toMatchObject({ success: true, invoiceId });
    const inserted = queries.find((q) => q.table === 'invoices' && q.operation === 'insert');
    expect(inserted?.payload).toMatchObject({
      fa3_data: { annotations: { cashMethod: cash ? 1 : 2, splitPayment: mpp ? 1 : 2 } },
    });
  });

  it('requires an explicit MPP answer on ROZ and a bank transfer when MPP applies (AUD-23)', async () => {
    const noAnswer: Partial<typeof finalInput> = { ...finalInput };
    delete noAnswer.splitPayment;
    expect(finalInvoiceSchema.safeParse(noAnswer).success).toBe(false);
    expect(await saveFinalAction(noAnswer, tenantId)).toMatchObject({ success: false });
    expect(await saveFinalAction({ ...finalInput, splitPayment: true, bankAccount: '' }, tenantId))
      .toMatchObject({ success: false });
    expect(await saveFinalAction({ ...finalInput, splitPayment: true, paymentMethod: 'cash' }, tenantId))
      .toMatchObject({ success: false });
    expect(queries.some((q) => q.table === 'invoices' && q.operation === 'insert')).toBe(false);
  });

  it('rejects an advance already settled by another ROZ before INSERT (AUD-67)', async () => {
    settlingFinals = [{ id: 'other-roz', internal_number: 'ROZ/2026/1', advance_invoice_ids: [advanceId] }];
    const result = await saveFinalAction(finalInput, tenantId);
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('ROZ/2026/1') });
    expect(queries.some((q) => q.table === 'invoices' && q.operation === 'insert')).toBe(false);
  });

  it('fails closed when the settled-advance lookup errors (AUD-67)', async () => {
    settledLookupError = { message: 'temporary-db-error' };
    const result = await saveFinalAction(finalInput, tenantId);
    expect(result).toMatchObject({ success: false });
    expect(queries.some((q) => q.table === 'invoices' && q.operation === 'insert')).toBe(false);
  });

  it('rejects missing 00094 or an unreadable cash-method value before INSERT/queue', async () => {
    cashMethodError = { code: '42703', message: 'missing vat_cash_method' };
    expect(await saveAndSendAdvanceAction(advanceInput, tenantId)).toMatchObject({
      success: false, error: expect.stringContaining('00094'),
    });
    cashMethodError = null;
    tenantRow.vat_cash_method = null;
    expect(await saveAndSendAdvanceAction(advanceInput, tenantId)).toMatchObject({ success: false });
    expect(queries.some((q) => q.table === 'invoices')).toBe(false);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
});

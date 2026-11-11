import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * F12-D8: zajęty numer (kod 23505, np. podwójne kliknięcie) w zaliczce, rozliczeniu
 * i korekcie ma dać klientowi polski komunikat z numerem dokumentu, nie surowy
 * błąd bazy („duplicate key value violates unique constraint ...”).
 * Atrapy tylko dla bazy i kolejki — akcje są prawdziwe.
 */

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  logAudit: vi.fn(),
  enqueue: vi.fn(),
}));
vi.mock('@/lib/supabase/auth-context', () => ({ requireUserAndActiveOrg: mocks.requireAuth }));
vi.mock('@/lib/audit/log', () => ({ logAudit: mocks.logAudit }));
vi.mock('@/lib/invoices/ksef-submit-enqueue', () => ({ enqueueKsefSubmitAfterDraft: mocks.enqueue }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/xml/invoice-calculator', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/xml/invoice-calculator')>(),
  validateNipChecksum: () => true,
}));

import { saveAdvanceAction } from '@/components/invoices/advance-actions';
import { saveCorrectionDraftAction } from '@/components/invoices/correction-actions';
import { saveFinalAction } from '@/components/invoices/final-actions';
import type { CorrectionInvoiceSchemaIn } from '@/lib/validators/invoice-validators';

const NOW = new Date('2026-10-01T22:30:00Z');
const tenantId = '11111111-1111-4111-8111-111111111111';
const parentId = '22222222-2222-4222-8222-222222222222';
const advanceId = '44444444-4444-4444-8444-444444444444';
const sellerNip = '1234567890';
const address = { countryCode: 'PL', addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa' };
const seller = { nip: sellerNip, name: 'Firma testowa', address };
const buyer = { type: 'b2b' as const, idType: 'nip' as const, nip: sellerNip, name: 'Nabywca testowy', address };

const common = (internalNumber: string) => ({
  internalNumber, issueDate: '2026-10-05', paymentMethod: 'transfer' as const,
  paymentDueDate: '2026-10-16', bankAccount: '1'.repeat(26), seller, buyer, splitPayment: false,
});
const advanceInput = () => ({
  ...common('ZAL/2026/10/1'), invoiceType: 'advance' as const, advanceAmount: 123,
  totalContractAmount: 1000, vatRate: '23' as const, description: 'Testowa zaliczka na usługę',
});
const finalInput = () => ({
  ...common('ROZ/2026/10/1'), invoiceType: 'final' as const, advanceInvoiceIds: [advanceId], totalAdvances: 123,
  lines: [{ name: 'Testowa usługa', unit: 'szt', quantity: 1, unitPriceNet: 1000, vatRate: '23' as const }],
});
const line = { name: 'Usługa', unit: 'szt', quantity: 1, unitPriceNet: 1000, vatRate: '23' as const };
const correctionInput = (): CorrectionInvoiceSchemaIn => ({
  invoiceType: 'correction', internalNumber: 'KOR/2026/10/1', issueDate: '2026-10-05',
  paymentMethod: 'transfer', paymentDueDate: '2026-10-16', parentInvoiceId: parentId,
  parentInvoiceNumber: 'FV/2026/9/1', parentInvoiceIssueDate: '2026-09-15',
  parentKsefNumber: '1234567890-20260915-ABCDEF', correctionType: 'before_after',
  correctionReason: 'Rabat po reklamacji', typKorekty: '2', seller, buyer,
  linesBefore: [line], linesAfter: [{ ...line, unitPriceNet: 800 }],
});

type Row = Record<string, unknown>;
type QueryLog = { table: string; operation: string; filters: Record<string, unknown> };
let queries: QueryLog[];
const parent: Row = {
  id: parentId, tenant_id: tenantId, direction: 'outgoing', invoice_kind: 'regular',
  ksef_status: 'accepted', ksef_environment: 'test', issue_date: '2026-09-15',
  internal_number: 'FV/2026/9/1', ksef_number: '1234567890-20260915-ABCDEF',
  seller_data: seller, buyer_data: { nip: sellerNip, name: 'Nabywca testowy', address, jst: 2, gv: 2 },
  buyer_nip: sellerNip, net_total: 1000, vat_total: 230, gross_total: 1230,
};

const DUPLICATE = {
  code: '23505',
  message: 'duplicate key value violates unique constraint "uq_invoices_tenant_outgoing_internal_number"',
};

function from(table: string) {
  const record: QueryLog = { table, operation: 'select', filters: {} };
  queries.push(record);
  const result = () => {
    if (table === 'tenants') {
      return { data: { id: tenantId, nip: sellerNip, name: 'Firma testowa', address_json: address, vat_cash_method: false }, error: null };
    }
    if (table === 'invoices' && record.operation === 'insert') return { data: null, error: DUPLICATE };
    if (table === 'invoices' && record.filters.id === parentId) {
      const match = Object.entries(record.filters).every(([key, value]) => parent[key] === value);
      return { data: match ? parent : null, error: null };
    }
    if (table === 'invoices' && Array.isArray(record.filters.id)) {
      return { data: [{ id: advanceId, internal_number: 'ZAL/2026/9/1', ksef_number: 'KSEF-TEST-1',
        issue_date: '2026-09-20', advance_amount: 123, gross_total: 123, invoice_kind: 'advance',
        buyer_nip: sellerNip, buyer_data: { nip: sellerNip, name: 'Nabywca testowy' } }], error: null };
    }
    if (table === 'invoices') return { data: [], error: null };
    if (table === 'invoice_line_items' && record.operation === 'select') {
      return { data: [{ name: 'Usługa', unit: 'szt', quantity: 1, unit_price_net: 1000, vat_rate: '23' }], error: null };
    }
    return { data: null, error: null };
  };
  const chain = {
    select: () => chain,
    eq: (key: string, value: unknown) => { record.filters[key] = value; return chain; },
    or: () => chain,
    in: (key: string, values: unknown[]) => { record.filters[key] = values; return chain; },
    overlaps: () => chain,
    order: () => chain,
    insert: () => { record.operation = 'insert'; return chain; },
    delete: () => { record.operation = 'delete'; return chain; },
    maybeSingle: async () => result(),
    single: async () => result(),
    then: <T,>(resolve: (value: ReturnType<typeof result>) => T) => Promise.resolve(result()).then(resolve),
  };
  return chain;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('KSEF_ENV', 'test');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  queries = [];
  mocks.requireAuth.mockResolvedValue({ supabase: { from }, user: { id: 'fixture-user' }, tenantId, role: 'owner' });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function expectFriendly(result: { success: boolean; error?: string }, number: string) {
  expect(result.success).toBe(false);
  expect(result.error).toContain(number);
  expect(result.error).toContain('już istnieje');
  expect(result.error).not.toMatch(/duplicate|constraint/i);
}

describe('zajęty numer (23505) — polski komunikat z numerem dokumentu', () => {
  it('zaliczka (ZAL)', async () => {
    expectFriendly(await saveAdvanceAction(advanceInput(), tenantId), 'ZAL/2026/10/1');
  });
  it('rozliczenie (ROZ)', async () => {
    expectFriendly(await saveFinalAction(finalInput(), tenantId), 'ROZ/2026/10/1');
  });
  it('korekta (KOR)', async () => {
    expectFriendly(await saveCorrectionDraftAction(correctionInput(), tenantId), 'KOR/2026/10/1');
  });
});

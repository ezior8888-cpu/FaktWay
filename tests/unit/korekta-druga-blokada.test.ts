import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * K4 z rewizji 03.10.2026: druga korekta tej samej faktury liczyła różnicę
 * od stanu pierwotnego, nie po poprzedniej KOR (podwójna korekta). Do czasu
 * łańcucha korekt akcje odmawiają, gdy rodzic ma korektę poza odrzuconą
 * przez KSeF — zanim cokolwiek zapiszą albo wyślą. Ta sama reguła w 00133.
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

import {
  getCorrectionParentContextAction,
  saveAndSendCorrectionAction,
  saveCorrectionDraftAction,
} from '@/components/invoices/correction-actions';
import { excludeParentsWithOpenCorrection, openCorrectionMessage } from '@/lib/invoices/correction-parents';
import type { CorrectionInvoiceSchemaIn } from '@/lib/validators/invoice-validators';

const tenantId = '11111111-1111-4111-8111-111111111111';
const parentId = '22222222-2222-4222-8222-222222222222';
const sellerNip = '1234567890';
const parentNumber = 'TEST/2026/1';
const ksefNumber = '1234567890-20260926-ABCDEF';
const address = { countryCode: 'PL', addressLine1: 'Testowa 1', addressLine2: '00-000 Test' };
const seller = { nip: sellerNip, name: 'Fixture seller', address };
const buyer = { type: 'b2b' as const, idType: 'nip' as const, nip: sellerNip, name: 'Fixture buyer', address };

const payload: CorrectionInvoiceSchemaIn = {
  invoiceType: 'correction',
  internalNumber: 'KOR/2026/2',
  issueDate: '2026-09-26',
  paymentMethod: 'transfer',
  paymentDueDate: '2026-10-03',
  parentInvoiceId: parentId,
  parentInvoiceNumber: parentNumber,
  parentInvoiceIssueDate: '2026-09-10',
  parentKsefNumber: ksefNumber,
  correctionType: 'amount_change',
  correctionReason: 'Druga poprawa kwoty',
  typKorekty: '2',
  seller,
  buyer,
  amountChange: { netDelta: -10, vatDelta: -2.3, grossDelta: -12.3, description: 'Zmniejszenie' },
};

type Row = Record<string, unknown>;
let parent: Row;
let corrections: Row[];
let inserts: number;

function from(table: string) {
  const filters: Record<string, unknown> = {};
  let operation = 'select';
  const result = () => {
    if (table === 'tenants') return { data: { id: tenantId, nip: sellerNip, name: 'Fixture seller', address_json: address }, error: null };
    if (table === 'invoices' && operation === 'insert') { inserts += 1; return { data: { id: '33333333-3333-4333-8333-333333333333' }, error: null }; }
    if (table === 'invoices' && 'parent_invoice_id' in filters) {
      return { data: corrections.filter((c) => c.parent_invoice_id === filters.parent_invoice_id && c.tenant_id === filters.tenant_id), error: null };
    }
    if (table === 'invoices') {
      const match = Object.entries(filters).every(([key, value]) => parent[key] === value);
      return { data: match ? parent : null, error: null };
    }
    if (table === 'invoice_line_items') return { data: [{ name: 'Service', unit: 'szt', quantity: 1, unit_price_net: 100, vat_rate: '23' }], error: null };
    return { data: null, error: null };
  };
  const chain = {
    select: () => chain,
    eq: (key: string, value: unknown) => { filters[key] = value; return chain; },
    order: () => chain,
    insert: () => { operation = 'insert'; return chain; },
    delete: () => chain,
    maybeSingle: async () => result(),
    single: async () => result(),
    then: <T,>(resolve: (value: ReturnType<typeof result>) => T) => Promise.resolve(result()).then(resolve),
  };
  return chain;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('KSEF_ENV', 'test');
  inserts = 0;
  parent = {
    id: parentId, tenant_id: tenantId, direction: 'outgoing', invoice_kind: 'regular',
    ksef_status: 'accepted', ksef_environment: 'test',
    issue_date: '2026-09-10', internal_number: parentNumber, ksef_number: ksefNumber,
    seller_data: seller, buyer_data: buyer, net_total: 100, vat_total: 23, gross_total: 123,
  };
  corrections = [];
  mocks.requireAuth.mockResolvedValue({ supabase: { from }, user: { id: 'fixture-user' }, tenantId, role: 'owner' });
  mocks.enqueue.mockResolvedValue({ ok: true, mode: 'online_queued' });
});
afterEach(() => vi.unstubAllEnvs());

const openKor = { id: 'kor-1', tenant_id: tenantId, parent_invoice_id: parentId, invoice_kind: 'correction', internal_number: 'KOR/2026/1', ksef_status: 'failed' };

describe('K4 — druga korekta tej samej faktury', () => {
  it.each([
    ['szkic', () => saveCorrectionDraftAction(payload, tenantId)],
    ['zapis i wysyłka', () => saveAndSendCorrectionAction(payload, tenantId)],
    ['kontekst rodzica dla formularza', () => getCorrectionParentContextAction(parentId)],
  ])('%s: rodzic z otwartą korektą → odmowa z numerem i stanem tej korekty, bez zapisu i zlecenia', async (_l, action) => {
    corrections = [openKor];
    const result = await action();
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe(openCorrectionMessage(parentNumber, { internal_number: 'KOR/2026/1', ksef_status: 'failed' }));
      expect(result.error).toContain('KOR/2026/1');
      expect(result.error).toContain('z błędem wysyłki');
    }
    expect(inserts).toBe(0);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('korekta odrzucona przez KSeF nie blokuje — szkic drugiej zapisuje się', async () => {
    corrections = [{ ...openKor, ksef_status: 'rejected' }];
    const result = await saveCorrectionDraftAction(payload, tenantId);
    expect(result.success).toBe(true);
    expect(inserts).toBe(1);
  });

  it('bez wcześniejszych korekt zapis przechodzi', async () => {
    const result = await saveCorrectionDraftAction(payload, tenantId);
    expect(result.success).toBe(true);
    expect(inserts).toBe(1);
  });

  it('excludeParentsWithOpenCorrection: otwarta korekta usuwa rodzica z listy, odrzucona nie', () => {
    const parents = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const out = excludeParentsWithOpenCorrection(parents, [
      { parent_invoice_id: 'a', ksef_status: 'draft' },
      { parent_invoice_id: 'b', ksef_status: 'rejected' },
      { parent_invoice_id: null, ksef_status: 'failed' },
    ]);
    expect(out.map((p) => p.id)).toEqual(['b', 'c']);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A1 z planu „zero zgubionych faktur” (W5 z rewizji 03.10.2026): faktura
 * w KSeF jest wystawiona w dniu przesłania (art. 106na ust. 1). Zwykła faktura
 * i szkic wymagały daty wystawienia = dziś (Europe/Warsaw), a zaliczka (ZAL),
 * korekta (KOR) i rozliczenie (ROZ) nie — 1 listopada o 00:30 zaliczka mogła
 * wyjść z P_1 = 31.10 (zły okres VAT, dokument „offline” bez oznaczeń).
 *
 * Ta sama reguła dla wszystkich dokumentów: wysyłka odmawia innej daty ZANIM
 * zapisze fakturę i zleci wysyłkę; szkic z inną datą nadal się zapisuje.
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
  // Fikcyjny NIP 1234567890 nie ma poprawnej sumy kontrolnej — jak w innych testach akcji.
  validateNipChecksum: () => true,
}));

import { saveAdvanceAction, saveAndSendAdvanceAction } from '@/components/invoices/advance-actions';
import {
  saveAndSendCorrectionAction,
  saveCorrectionDraftAction,
} from '@/components/invoices/correction-actions';
import { saveAndSendFinalAction, saveFinalAction } from '@/components/invoices/final-actions';
import { issueDateNotTodayError } from '@/lib/invoices/issue-date';
import { ROZ_SUBMISSION_HOLD_MESSAGE } from '@/lib/ksef/roz-submission-hold';
import type { CorrectionInvoiceSchemaIn } from '@/lib/validators/invoice-validators';

// 2026-10-02 00:30 czasu polskiego = 2026-10-01 22:30 UTC: w UTC jeszcze „wczoraj”.
const NOW = new Date('2026-10-01T22:30:00Z');
const TODAY = '2026-10-02';
const NOT_TODAY = [
  ['wczoraj w Polsce (w UTC jeszcze dziś)', '2026-10-01'],
  ['jutro', '2026-10-03'],
  ['dwa tygodnie temu', '2026-09-18'],
] as const;

const tenantId = '11111111-1111-4111-8111-111111111111';
const parentId = '22222222-2222-4222-8222-222222222222';
const advanceId = '44444444-4444-4444-8444-444444444444';
const newInvoiceId = '33333333-3333-4333-8333-333333333333';
const sellerNip = '1234567890';
const address = { countryCode: 'PL', addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa' };
const seller = { nip: sellerNip, name: 'Firma testowa', address };
const buyer = { type: 'b2b' as const, idType: 'nip' as const, nip: sellerNip, name: 'Nabywca testowy', address };

const common = (issueDate: string) => ({
  internalNumber: 'DOK/2026/10/1', issueDate, paymentMethod: 'transfer' as const,
  paymentDueDate: '2026-10-16', bankAccount: '1'.repeat(26), seller, buyer, splitPayment: false,
});
const advanceInput = (issueDate: string) => ({
  ...common(issueDate), invoiceType: 'advance' as const, advanceAmount: 123,
  totalContractAmount: 1000, vatRate: '23' as const, description: 'Testowa zaliczka na usługę',
});
const finalInput = (issueDate: string) => ({
  ...common(issueDate), invoiceType: 'final' as const, advanceInvoiceIds: [advanceId], totalAdvances: 123,
  lines: [{ name: 'Testowa usługa', unit: 'szt', quantity: 1, unitPriceNet: 1000, vatRate: '23' as const }],
});
const line = { name: 'Usługa', unit: 'szt', quantity: 1, unitPriceNet: 1000, vatRate: '23' as const };
const correctionInput = (issueDate: string): CorrectionInvoiceSchemaIn => ({
  invoiceType: 'correction',
  internalNumber: 'KOR/2026/10/1',
  issueDate,
  paymentMethod: 'transfer',
  paymentDueDate: '2026-10-16',
  parentInvoiceId: parentId,
  parentInvoiceNumber: 'FV/2026/9/1',
  parentInvoiceIssueDate: '2026-09-15',
  parentKsefNumber: '1234567890-20260915-ABCDEF',
  correctionType: 'before_after',
  correctionReason: 'Rabat po reklamacji',
  typKorekty: '2',
  seller,
  buyer,
  linesBefore: [line],
  linesAfter: [{ ...line, unitPriceNet: 800 }],
});

type Row = Record<string, unknown>;
type QueryLog = { table: string; operation: string; filters: Record<string, unknown> };
let queries: QueryLog[];
const parent: Row = {
  id: parentId, tenant_id: tenantId, direction: 'outgoing', invoice_kind: 'regular',
  ksef_status: 'accepted', ksef_environment: 'test', issue_date: '2026-09-15',
  internal_number: 'FV/2026/9/1', ksef_number: '1234567890-20260915-ABCDEF',
  seller_data: seller, buyer_data: { nip: sellerNip, name: 'Nabywca testowy', address, jst: 2, gv: 2 },
  net_total: 1000, vat_total: 230, gross_total: 1230,
};

function from(table: string) {
  const record: QueryLog = { table, operation: 'select', filters: {} };
  queries.push(record);
  const result = () => {
    if (table === 'tenants') {
      return { data: { id: tenantId, nip: sellerNip, name: 'Firma testowa', address_json: address, vat_cash_method: false }, error: null };
    }
    if (table === 'invoices' && record.operation === 'insert') return { data: { id: newInvoiceId }, error: null };
    if (table === 'invoices' && record.filters.id === parentId) {
      const match = Object.entries(record.filters).every(([key, value]) => parent[key] === value);
      return { data: match ? parent : null, error: null };
    }
    if (table === 'invoices' && Array.isArray(record.filters.id)) {
      // Zaliczki wybrane do rozliczenia (ROZ).
      return { data: [{ id: advanceId, internal_number: 'ZAL/2026/9/1', ksef_number: 'KSEF-TEST-1',
        issue_date: '2026-09-20', advance_amount: 123, gross_total: 123, invoice_kind: 'advance' }], error: null };
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

const inserted = () => queries.some((q) => q.table === 'invoices' && q.operation === 'insert');

function expectRefusedForDate(result: { success: boolean; error?: string }) {
  expect(result.success).toBe(false);
  // Ten sam komunikat co „Wystaw i wyślij” zwykłej faktury (components/invoices/actions.ts).
  expect(result.error).toContain(`dzisiejszą datą wystawienia (${TODAY})`);
  expect(inserted()).toBe(false);
  expect(mocks.enqueue).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('KSEF_ENV', 'test');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  queries = [];
  mocks.requireAuth.mockResolvedValue({ supabase: { from }, user: { id: 'fixture-user' }, tenantId, role: 'owner' });
  mocks.enqueue.mockResolvedValue({ ok: true, mode: 'online_queued' });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('zaliczka (ZAL) — wysyłka tylko z dzisiejszą datą wystawienia', () => {
  it.each(NOT_TODAY)('%s (%s) — odmowa bez zapisu i bez kolejki', async (_label, date) => {
    expectRefusedForDate(await saveAndSendAdvanceAction(advanceInput(date), tenantId));
  });

  it('dziś w Polsce (choć w UTC jeszcze wczoraj) — zapis i kolejka', async () => {
    const r = await saveAndSendAdvanceAction(advanceInput(TODAY), tenantId);
    expect(r).toMatchObject({ success: true, invoiceId: newInvoiceId });
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
  });

  it('szkic zaliczki z inną datą nadal się zapisuje', async () => {
    const r = await saveAdvanceAction(advanceInput('2026-10-05'), tenantId);
    expect(r).toMatchObject({ success: true });
    expect(inserted()).toBe(true);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
});

describe('korekta (KOR) — wysyłka tylko z dzisiejszą datą wystawienia', () => {
  it.each(NOT_TODAY)('%s (%s) — odmowa bez zapisu i bez kolejki', async (_label, date) => {
    expectRefusedForDate(await saveAndSendCorrectionAction(correctionInput(date), tenantId));
  });

  it('dziś w Polsce — zapis i kolejka', async () => {
    const r = await saveAndSendCorrectionAction(correctionInput(TODAY), tenantId);
    expect(r).toMatchObject({ success: true, invoiceId: newInvoiceId });
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
  });

  it('szkic korekty z inną datą nadal się zapisuje', async () => {
    const r = await saveCorrectionDraftAction(correctionInput('2026-10-05'), tenantId);
    expect(r).toMatchObject({ success: true });
    expect(inserted()).toBe(true);
  });
});

describe('rozliczenie (ROZ) — wysyłka tylko z dzisiejszą datą wystawienia', () => {
  // Wysyłka ROZ jest wstrzymana hamulcem ROZ_HOLD. Kontrola daty stoi przed
  // hamulcem, żeby przetrwała jego zdjęcie (C4) bez osobnej pamięci o niej.
  it.each(NOT_TODAY)('%s (%s) — odmowa z powodu daty, bez zapisu i bez kolejki', async (_label, date) => {
    expectRefusedForDate(await saveAndSendFinalAction(finalInput(date), tenantId));
  });

  it('dziś w Polsce — nadal hamulec ROZ, bez zapisu', async () => {
    const r = await saveAndSendFinalAction(finalInput(TODAY), tenantId);
    expect(r).toEqual({ success: false, error: ROZ_SUBMISSION_HOLD_MESSAGE });
    expect(inserted()).toBe(false);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('szkic rozliczenia z inną datą nadal się zapisuje', async () => {
    const r = await saveFinalAction(finalInput('2026-10-05'), tenantId);
    expect(r).toMatchObject({ success: true });
    expect(inserted()).toBe(true);
  });
});

describe('issueDateNotTodayError — jedna reguła, komunikat wg źródła wysyłki', () => {
  it('dziś w Polsce — bez błędu dla każdego źródła', () => {
    for (const source of ['form', 'draft', 'special'] as const) {
      expect(issueDateNotTodayError(TODAY, source, NOW)).toBeNull();
    }
  });

  it.each([
    ['form', 'zapisz fakturę jako szkic'],
    ['draft', 'Usuń szkic i wystaw fakturę ponownie'],
    ['special', 'Zmień datę wystawienia na dzisiejszą'],
  ] as const)('%s — mówi, co zrobić: „%s”', (source, nextStep) => {
    const message = issueDateNotTodayError('2026-10-01', source, NOW);
    expect(message).toContain(`(${TODAY})`);
    expect(message).toContain(nextStep);
  });

  it.each([undefined, null, '', 20261002])('brak albo zła wartość (%s) — odmowa, nie wyjątek', (value) => {
    expect(issueDateNotTodayError(value, 'special', NOW)).toContain('ma datę brak');
  });
});

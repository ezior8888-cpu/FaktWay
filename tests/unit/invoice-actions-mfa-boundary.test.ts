import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(), createAdminClient: vi.fn(), cookies: vi.fn(),
  getSession: vi.fn(), getUser: vi.fn(), getClaims: vi.fn(),
  from: vi.fn(), adminFrom: vi.fn(), memberEq: vi.fn(), memberSingle: vi.fn(),
  audit: vi.fn(), enqueue: vi.fn(), gus: vi.fn(),
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.createClient, createAdminClient: mocks.createAdminClient }));
vi.mock('next/headers', () => ({ cookies: mocks.cookies }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/audit/log', () => ({ logAudit: mocks.audit }));
vi.mock('@/lib/invoices/ksef-submit-enqueue', () => ({ enqueueKsefSubmitAfterDraft: mocks.enqueue }));
vi.mock('@/lib/gus/client', () => ({ lookupCompanyByNip: mocks.gus }));
vi.mock('@/lib/xml/invoice-calculator', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/xml/invoice-calculator')>(),
  // Keep fictional test NIPs while exercising the authorization boundary.
  validateNipChecksum: () => true,
}));
import {
  lookupBuyerAction, prefillFromLastInvoiceAction, saveDraftAction, saveAndSendInvoiceAction,
} from '@/components/invoices/actions';
import type { InvoiceFormValues } from '@/lib/schemas/invoice-form';
import { ACTIVE_ORG_COOKIE } from '@/lib/supabase/active-org';

// F-092: „Wystaw i wyślij” przyjmuje tylko dzisiejszą datę wystawienia —
// testy działają w dniu daty z fixture'a (`issueDate: '2026-09-15'`).
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-15T10:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

const org = '11111111-1111-4111-8111-111111111111';
const userId = 'fixture-user';
const token = 'synthetic-access-token';
const buyer = {
  nip: '1234567890', name: 'Fixture buyer', email: 'buyer@example.test',
  address: { countryCode: 'PL', addressLine1: 'Test 1', addressLine2: '00-000 Test' },
};
const lines = [{ ordinal: 1, name: 'Fixture service', unit: 'szt', quantity: 2, unit_price_net: 50, vat_rate: '23' }];
const form: InvoiceFormValues = {
  internalNumber: 'FIXTURE/1', issueDate: '2026-09-15', saleDate: '',
  buyerNip: buyer.nip, buyerName: buyer.name, buyerAddressLine1: 'Test 1',
  buyerAddressLine2: '00-000 Test', buyerEmail: buyer.email, buyerIsConsumer: false,
  buyerPesel: '', buyerIdDocument: '', paymentMethod: 'transfer', paymentDueDate: '2026-09-22',
  bankAccount: '61 1090 1014 0000 0712 1981 2874',
  lines: [{ name: 'Fixture service', unit: 'szt', quantity: 2, unitPriceNet: 50, vatRate: '23' }],
};
type QueryLog = { table: string; filters: Record<string, unknown>; operation: string; payload?: unknown };
let queries: QueryLog[];
let aal: string;
let factor: string | null;
let member: boolean;
let selectedOrg: string | null;
/** `tenants.vat_exemption_basis` (00091) — null = czynny podatnik VAT. */
let vatBasis: string | null;
/** `tenants.vat_cash_method` (00094) — false = metoda memoriałowa. */
let cashMethod: boolean;
let missingCashMethodColumn: boolean;

function query(table: string) {
  const record: QueryLog = { table, filters: {}, operation: 'select' };
  queries.push(record);
  let selectedColumns: string | undefined;
  const result = () => {
    if (table === 'tenants' && selectedColumns === 'vat_cash_method' && missingCashMethodColumn) {
      return { data: null, error: { code: '42703', message: 'missing vat_cash_method' } };
    }
    let data: unknown = null;
    if (table === 'tenants') data = { id: org, nip: '1234567890', name: 'Fixture seller', address_json: { countryCode: 'PL' }, vat_exemption_basis: vatBasis, vat_cash_method: cashMethod };
    if (table === 'contractors') data = { nip: buyer.nip, name: buyer.name, address: buyer.address };
    if (table === 'invoices') data = record.operation === 'insert' ? { id: 'new-invoice' } : {
      id: 'last-invoice',
      fa3_data: { buyer, payment: { method: 'transfer', bankAccount: 'fixture-bank-account' } },
    };
    if (table === 'invoice_line_items' && record.operation === 'select') data = lines;
    return { data, error: null };
  };
  const chain = {
    select: vi.fn((columns?: string) => { selectedColumns = columns; return chain; }),
    order: vi.fn(() => chain), limit: vi.fn(() => chain),
    eq: vi.fn((key: string, value: unknown) => { record.filters[key] = value; return chain; }),
    insert: vi.fn((payload: unknown) => { record.operation = 'insert'; record.payload = payload; return chain; }),
    update: vi.fn((payload: unknown) => { record.operation = 'update'; record.payload = payload; return chain; }),
    maybeSingle: vi.fn(async () => result()), single: vi.fn(async () => result()),
    then: (resolve: (value: ReturnType<typeof result>) => unknown) => Promise.resolve(result()).then(resolve),
  };
  return chain;
}
beforeEach(() => {
  vi.resetAllMocks(); queries = []; aal = 'aal2'; factor = 'totp'; member = true; selectedOrg = org; vatBasis = null; cashMethod = false; missingCashMethodColumn = false;
  mocks.getSession.mockResolvedValue({ data: { session: { access_token: token, user: { id: 'forged-cookie-user', factors: [] } } }, error: null });
  mocks.getUser.mockImplementation(async () => ({ data: { user: {
    id: userId, email: 'user@example.test',
    factors: factor ? [{ id: 'fixture-factor', factor_type: factor, status: 'verified' }] : [],
  } }, error: null }));
  mocks.getClaims.mockImplementation(async () => ({ data: { claims: { sub: userId, aal } }, error: null }));
  mocks.cookies.mockResolvedValue({ get: (key: string) => key === ACTIVE_ORG_COOKIE && selectedOrg ? { value: selectedOrg } : undefined });
  mocks.createClient.mockResolvedValue({ auth: {
    getSession: mocks.getSession, getUser: mocks.getUser, getClaims: mocks.getClaims,
  }, from: mocks.from });
  mocks.from.mockImplementation(query);
  const memberQuery = { select: vi.fn(), eq: mocks.memberEq, maybeSingle: mocks.memberSingle };
  memberQuery.select.mockReturnValue(memberQuery); mocks.memberEq.mockReturnValue(memberQuery);
  mocks.memberSingle.mockImplementation(async () => ({ data: member ? { role: 'owner', status: 'active' } : null, error: null }));
  mocks.adminFrom.mockReturnValue(memberQuery);
  mocks.createAdminClient.mockReturnValue({ from: mocks.adminFrom });
  mocks.enqueue.mockResolvedValue({ ok: true, mode: 'online' });
});
const entries = [
  { name: 'buyer lookup', invoke: () => lookupBuyerAction(buyer.nip), nullable: false },
  { name: 'draft', invoke: () => saveDraftAction(form, org), nullable: false },
  { name: 'save and send', invoke: () => saveAndSendInvoiceAction(form, org), nullable: false },
  { name: 'last invoice prefill', invoke: () => prefillFromLastInvoiceAction(), nullable: true },
];
function expectNoBusinessEffects() {
  expect(mocks.from).not.toHaveBeenCalled();
  expect(mocks.audit).not.toHaveBeenCalled();
  expect(mocks.enqueue).not.toHaveBeenCalled();
  expect(mocks.gus).not.toHaveBeenCalled();
}
describe.each(entries)('$name boundary', ({ invoke, nullable }) => {
  const expectDenied = async (message: string) => {
    if (nullable) await expect(invoke()).resolves.toBeNull();
    else await expect(invoke()).resolves.toEqual({ success: false, error: message });
    expectNoBusinessEffects();
  };
  it.each(['totp', 'phone'])('rejects AAL1 with verified %s before tenant or invoice access', async (factorType) => {
    aal = 'aal1'; factor = factorType;
    await expectDenied('Wymagana weryfikacja dwuetapowa');
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
    expect(mocks.cookies).not.toHaveBeenCalled();
    expect(mocks.getUser).toHaveBeenCalledWith(token);
    expect(mocks.getClaims).toHaveBeenCalledWith(token);
  });
  it('fails closed on Auth verification failure', async () => {
    mocks.getClaims.mockRejectedValue(new Error('internal-sensitive-auth-error'));
    await expectDenied('Nie udało się zweryfikować sesji. Zaloguj się ponownie.');
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
  });
  it('rejects revoked membership before invoice reads, writes or tenant snapshot', async () => {
    member = false;
    await expectDenied('Brak dostępu do aktywnej organizacji');
    expect(mocks.adminFrom).toHaveBeenCalledExactlyOnceWith('memberships');
    expect(mocks.memberEq.mock.calls).toEqual([['user_id', userId], ['organization_id', org], ['status', 'active']]);
  });
  it('rejects missing organization before service-role or business reads', async () => {
    selectedOrg = null;
    await expectDenied('Brak aktywnej organizacji');
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
  });
});
it.each(['aal2', 'no-factor'])('prefill uses the authenticated tenant snapshot and invoice scope for %s', async (state) => {
  if (state === 'no-factor') { aal = 'aal1'; factor = null; }
  await expect(prefillFromLastInvoiceAction()).resolves.toEqual({
    contractorName: buyer.name,
    values: {
      buyerNip: buyer.nip, buyerName: buyer.name, buyerAddressLine1: 'Test 1',
      buyerAddressLine2: '00-000 Test', buyerEmail: buyer.email,
      lines: [{ name: 'Fixture service', unit: 'szt', quantity: 2, unitPriceNet: 50, vatRate: '23' }],
      paymentMethod: 'transfer', bankAccount: 'fixture-bank-account',
    },
  });
  expect(mocks.adminFrom).toHaveBeenCalledExactlyOnceWith('memberships');
  expect(queries[0]).toEqual({ table: 'tenants', operation: 'select', filters: { id: org } });
  expect(queries[1]).toMatchObject({ table: 'invoices', filters: { tenant_id: org, direction: 'outgoing' } });
  expect(queries[2]).toMatchObject({ table: 'invoice_line_items', filters: { invoice_id: 'last-invoice' } });
  expect(mocks.memberSingle.mock.invocationCallOrder[0]).toBeLessThan(mocks.from.mock.invocationCallOrder[0]!);
});
it('buyer lookup still returns the current tenant contractor cache', async () => {
  await expect(lookupBuyerAction(buyer.nip)).resolves.toMatchObject({ success: true, source: 'cache', data: { name: buyer.name } });
  expect(queries).toContainEqual(expect.objectContaining({ table: 'contractors', filters: { tenant_id: org, nip: buyer.nip } }));
});
it.each(['draft', 'send'])('a verified user can still save %s through the session client', async (action) => {
  const result = action === 'draft' ? await saveDraftAction(form, org) : await saveAndSendInvoiceAction(form, org);
  expect(result).toMatchObject({ success: true, invoiceId: 'new-invoice' });
  expect(mocks.adminFrom).toHaveBeenCalledExactlyOnceWith('memberships');
  expect(queries).toContainEqual(expect.objectContaining({
    table: 'invoices', operation: 'insert', payload: expect.objectContaining({ tenant_id: org }),
  }));
  expect(mocks.enqueue).toHaveBeenCalledTimes(action === 'send' ? 1 : 0);
});

describe('zwolnienie z VAT przy wystawianiu (stawka zw)', () => {
  // Do 26.09 formularz nie miał „zw”, a generator FA(3) rzucał błędem —
  // firma zwolniona nie mogła wystawić poprawnej faktury.
  const zw: InvoiceFormValues = {
    ...form,
    lines: [{ name: 'Usługa zwolniona', unit: 'szt', quantity: 1, unitPriceNet: 100, vatRate: 'zw' }],
  };

  it('podstawa z ustawień firmy trafia do faktury (P_19A) i faktura idzie do kolejki', async () => {
    vatBasis = 'art. 113 ust. 1 ustawy o VAT';
    await expect(saveAndSendInvoiceAction(zw, org)).resolves.toMatchObject({ success: true });
    const invoice = mocks.enqueue.mock.calls[0]![0].invoice;
    expect(invoice.annotations).toEqual({ vatExemptionBasis: 'art. 113 ust. 1 ustawy o VAT' });
    expect(invoice.lines[0].vatRate).toBe('zw');
  });

  it('bez podstawy: odmowa od razu — bez zapisu faktury i bez kolejki KSeF', async () => {
    const result = await saveAndSendInvoiceAction(zw, org);
    expect(result).toMatchObject({ success: false });
    expect(result.success === false && result.error).toContain('podstawy prawnej zwolnienia');
    expect(queries.some((q) => q.table === 'invoices' && q.operation === 'insert')).toBe(false);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  // Szkic nie idzie do KSeF (w aplikacji nie ma wysyłki szkicu) — blokada
  // dotyczy tylko wysyłki.
  it('szkic bez podstawy wolno zapisać', async () => {
    await expect(saveDraftAction(zw, org)).resolves.toMatchObject({ success: true });
  });

  it('faktura bez „zw” nie dostaje P_19A, nawet gdy firma ma podstawę', async () => {
    vatBasis = 'art. 113 ust. 1 ustawy o VAT';
    await saveAndSendInvoiceAction(form, org);
    expect(mocks.enqueue.mock.calls[0]![0].invoice.annotations).toBeUndefined();
  });
});

describe('mechanizm podzielonej płatności (MPP, P_18A)', () => {
  const mpp: InvoiceFormValues = { ...form, bankAccount: 'PL61109010140000071219812874', splitPayment: true };

  it('zaznaczony MPP trafia do faktury w kolejce KSeF', async () => {
    await expect(saveAndSendInvoiceAction(mpp, org)).resolves.toMatchObject({ success: true });
    expect(mocks.enqueue.mock.calls[0]![0].invoice.annotations).toEqual({ splitPayment: 1 });
  });

  it('MPP bez rachunku — odmowa także na serwerze, bez kolejki', async () => {
    const result = await saveAndSendInvoiceAction({ ...mpp, bankAccount: '' }, org);
    expect(result).toMatchObject({ success: false });
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
});

describe('metoda kasowa firmy (P_16)', () => {
  it.each(['draft', 'send'])('brak 00094 blokuje %s przed zapisem i kolejką', async (action) => {
    missingCashMethodColumn = true;
    const result = action === 'draft' ? await saveDraftAction(form, org) : await saveAndSendInvoiceAction(form, org);
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('00094') });
    expect(queries.some((query) => query.table === 'invoices')).toBe(false);
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('firma na metodzie kasowej: P_16 w fakturze w kolejce KSeF', async () => {
    cashMethod = true;
    await expect(saveAndSendInvoiceAction(form, org)).resolves.toMatchObject({ success: true });
    expect(mocks.enqueue.mock.calls[0]![0].invoice.annotations).toEqual({ cashMethod: 1 });
  });

  it('firma zwolniona z VAT: metoda kasowa jej nie dotyczy — bez P_16', async () => {
    cashMethod = true;
    vatBasis = 'art. 113 ust. 1 ustawy o VAT';
    await saveAndSendInvoiceAction(form, org);
    expect(mocks.enqueue.mock.calls[0]![0].invoice.annotations).toBeUndefined();
  });

  it('metoda memoriałowa: bez P_16', async () => {
    await saveAndSendInvoiceAction(form, org);
    expect(mocks.enqueue.mock.calls[0]![0].invoice.annotations).toBeUndefined();
  });
});

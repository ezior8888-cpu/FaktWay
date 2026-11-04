import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Invoice } from '@/types/invoice';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({ rpc: mocks.rpc, from: mocks.from }),
}));

import { insertSelfInvoice } from '@/lib/billing/self-invoice';

const stripeInvoiceId = 'in_firstABCDEFGH';
const paymentId = '11111111-1111-4111-8111-111111111111';
const customerTenantId = '22222222-2222-4222-8222-222222222222';
const operatorTenantId = '33333333-3333-4333-8333-333333333333';
const internalNumber = 'FF/2026/09/ABCDEFGH';

function invoiceFor(id: string): Invoice {
  return {
    internalNumber,
    type: 'VAT',
    issueDate: '2026-09-24',
    seller: {
      nip: '1234567890',
      name: 'Operator',
      address: { countryCode: 'PL', addressLine1: 'Ulica 1', addressLine2: '00-001' },
    },
    buyer: {
      nip: '9876543210',
      name: 'Nabywca',
      address: { countryCode: 'PL', addressLine1: 'Ulica 2', addressLine2: '00-002' },
    },
    lines: [{
      ordinal: 1,
      name: 'FaktWay — subskrypcja miesięczna (wrzesień 2026)',
      unit: 'usł.',
      quantity: 1,
      unitPriceNet: 47.97,
      netAmount: 47.97,
      vatRate: '23',
      vatAmount: 11.03,
      grossAmount: 59,
    }],
    netTotal: 47.97,
    vatTotal: 11.03,
    grossTotal: 59,
    payment: { amountDue: 59, currency: 'PLN', dueDate: '2026-09-24', method: 'card' },
    notes: 'Faktura za subskrypcję FaktWay. Płatność Stripe: ' + id + '.',
  };
}

function insert(invoice: Invoice = invoiceFor(stripeInvoiceId), id = stripeInvoiceId) {
  return insertSelfInvoice(
    invoice, operatorTenantId, id, paymentId, customerTenantId,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.from.mockImplementation((table: string) => {
    throw new Error('Direct billing table access is forbidden: ' + table);
  });
  mocks.rpc.mockResolvedValue({
    data: [{ invoice_id: 'vat-invoice', internal_number: internalNumber, created: true }],
    error: null,
  });
});

describe('atomic billing VAT invoice RPC contract', () => {
  it('passes the complete payment, tenant, Stripe ID and draft to one RPC', async () => {
    const invoice = invoiceFor(stripeInvoiceId);

    await expect(insert(invoice)).resolves.toEqual({
      invoiceId: 'vat-invoice',
      internalNumber,
      created: true,
    });

    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith(
      'create_billing_vat_invoice',
      {
        p_payment_id: paymentId,
        p_customer_tenant_id: customerTenantId,
        p_operator_tenant_id: operatorTenantId,
        p_stripe_invoice_id: stripeInvoiceId,
        p_invoice: invoice,
      },
    );
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it('returns an existing exact invoice only when the RPC verifies it', async () => {
    mocks.rpc.mockResolvedValue({
      data: [{ invoice_id: 'existing-vat-invoice', internal_number: internalNumber, created: false }],
      error: null,
    });

    await expect(insert()).resolves.toEqual({
      invoiceId: 'existing-vat-invoice',
      internalNumber,
      created: false,
    });
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it('fails closed on an RPC rejection without trying direct inserts', async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { message: 'Refund requires VAT reconciliation' },
    });

    await expect(insert()).rejects.toThrow('Self-invoice transaction failed');
    expect(mocks.rpc).toHaveBeenCalledOnce();
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it.each([
    null,
    [],
    [
      { invoice_id: 'first', internal_number: internalNumber, created: true },
      { invoice_id: 'second', internal_number: internalNumber, created: true },
    ],
    [{ invoice_id: null, internal_number: internalNumber, created: true }],
    [{ invoice_id: 'vat-invoice', internal_number: 'other-number', created: true }],
    [{ invoice_id: 'vat-invoice', internal_number: internalNumber, created: null }],
  ])('rejects an incomplete or ambiguous RPC result: %j', async (data) => {
    mocks.rpc.mockResolvedValue({ data, error: null });

    await expect(insert()).rejects.toThrow('invalid result');
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it('rejects an incomplete local identity before contacting the database', async () => {
    await expect(insert(invoiceFor('bad-id'), 'bad-id')).rejects.toThrow(
      'Self-invoice identity requires reconciliation',
    );
    const invoice = invoiceFor(stripeInvoiceId);
    invoice.lines.push({ ...invoice.lines[0], ordinal: 2 });
    await expect(insert(invoice)).rejects.toThrow(
      'Self-invoice identity requires reconciliation',
    );

    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
  });
});

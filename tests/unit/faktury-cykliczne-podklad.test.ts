import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeSupabase, memoryDb, type MemoryDb, type Row } from '../helpers/fake-supabase-memory';

/**
 * Plan Finora N1: `prefillFromInvoiceAction(invoiceId)` — uogólnienie
 * `prefillFromLastInvoiceAction` na wskazaną fakturę („Duplikuj”, „Wystaw
 * teraz”). Treść ze wzoru, NIGDY jego numer ani daty: numer z podpowiedzi
 * serii, daty na dziś (Europe/Warsaw), termin = dziś + dni terminu wzoru.
 */

const TENANT = 'ten-1';
const TPL = '7f1c2d3e-4b5a-4c6d-8e7f-901234567890';

const mocks = vi.hoisted(() => ({ auth: vi.fn() }));

vi.mock('@/lib/supabase/auth-context', () => ({ requireUserAndActiveOrg: mocks.auth }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/audit/log', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/invoices/ksef-submit-enqueue', () => ({ enqueueKsefSubmitAfterDraft: vi.fn() }));
vi.mock('@/lib/gus/client', () => ({ lookupCompanyByNip: vi.fn() }));

import { prefillFromInvoiceAction } from '@/components/invoices/actions';
import { invoiceFormSchema, type InvoiceFormValues } from '@/lib/schemas/invoice-form';

let db: MemoryDb;

function wzor(extra: Row = {}, fa3: Row = {}): Row {
  return {
    id: TPL, tenant_id: TENANT, direction: 'outgoing', invoice_kind: 'regular', internal_number: 'FV/7/09/2026',
    issue_date: '2026-09-10', payment_due_date: '2026-09-24', days_to_payment: null, created_at: '2026-09-10T08:00:00Z',
    is_b2c: false, buyer_id_type: 'nip', buyer_pesel: null, buyer_id_number: null,
    fa3_data: {
      buyer: { nip: '5252241585', name: 'Klient sp. z o.o.', address: { countryCode: 'PL', addressLine1: 'ul. B 2', addressLine2: '00-002 Warszawa' }, email: 'faktury@klient.example' },
      payment: { method: 'transfer', bankAccount: 'PL61109010140000071219812874' },
      ...fa3,
    },
    ...extra,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  // 20.10.2026 00:30 w Polsce = 19.10 22:30 UTC — „dziś” to już 20.10.
  vi.setSystemTime(new Date('2026-10-19T22:30:00Z'));
  db = memoryDb({
    tenants: [{ id: TENANT, nip: '5260001246', name: 'Moja Firma', address_json: null }],
    invoices: [wzor()],
    invoice_line_items: [
      { id: 'l1', invoice_id: TPL, ordinal: 1, name: 'Abonament', unit: 'mies.', quantity: 1, unit_price_net: 500, vat_rate: '23' },
    ],
  });
  mocks.auth.mockResolvedValue({ supabase: fakeSupabase(db), user: { id: 'user-1' }, tenantId: TENANT, role: 'owner' });
});

describe('prefillFromInvoiceAction', () => {
  it('treść ze wzoru, numer z podpowiedzi, daty na dziś w Polsce, termin z dni wzoru', async () => {
    const p = await prefillFromInvoiceAction(TPL);
    expect(p).toEqual({
      invoiceId: TPL,
      contractorName: 'Klient sp. z o.o.',
      sourceNumber: 'FV/7/09/2026',
      values: {
        buyerNip: '5252241585',
        buyerName: 'Klient sp. z o.o.',
        buyerAddressLine1: 'ul. B 2',
        buyerAddressLine2: '00-002 Warszawa',
        buyerEmail: 'faktury@klient.example',
        lines: [{ name: 'Abonament', unit: 'mies.', quantity: 1, unitPriceNet: 500, vatRate: '23' }],
        paymentMethod: 'transfer',
        bankAccount: 'PL61109010140000071219812874',
        internalNumber: 'FV/1/10/2026',
        issueDate: '2026-10-20',
        saleDate: '2026-10-20',
        paymentDueDate: '2026-11-03',
        buyerIsConsumer: false,
        buyerConsumerIdType: undefined,
        buyerPesel: '',
        buyerIdDocument: '',
        splitPayment: false,
      },
    });
  });

  it('podkład przechodzi schemat formularza (od razu „Wystaw i wyślij”)', async () => {
    const p = await prefillFromInvoiceAction(TPL);
    const values: InvoiceFormValues = { notes: '', buyerIsEu: false, buyerVatUe: '', buyerCountryCode: '', ...p!.values };
    const r = invoiceFormSchema.safeParse(values);
    expect(r.success ? [] : r.error.issues.map((i) => i.message)).toEqual([]);
  });

  it('days_to_payment wzoru ma pierwszeństwo przed różnicą dat', async () => {
    db.tables.invoices = [wzor({ days_to_payment: 30 })];
    expect((await prefillFromInvoiceAction(TPL))?.values.paymentDueDate).toBe('2026-11-19');
  });

  it('nieczytelny termin wzoru → 14 dni jak w pustym formularzu', async () => {
    db.tables.invoices = [wzor({ payment_due_date: null })];
    expect((await prefillFromInvoiceAction(TPL))?.values.paymentDueDate).toBe('2026-11-03');
    db.tables.invoices = [wzor({ payment_due_date: '2026-09-01' })];
    expect((await prefillFromInvoiceAction(TPL))?.values.paymentDueDate).toBe('2026-11-03');
  });

  it('osoba prywatna wraca jako osoba prywatna z PESEL-em', async () => {
    db.tables.invoices = [wzor(
      { is_b2c: true, buyer_id_type: 'pesel', buyer_pesel: '44051401359' },
      { buyer: { name: 'Jan Kowalski', address: { countryCode: 'PL', addressLine1: 'ul. C 3', addressLine2: '00-003 Warszawa' }, pesel: '44051401359' } },
    )];
    const p = await prefillFromInvoiceAction(TPL);
    expect(p?.values).toMatchObject({
      buyerIsConsumer: true, buyerConsumerIdType: 'pesel', buyerPesel: '44051401359', buyerNip: '', buyerIdDocument: '',
    });
  });

  it('MPP ze wzoru', async () => {
    db.tables.invoices = [wzor({}, { annotations: { splitPayment: 1 } })];
    expect((await prefillFromInvoiceAction(TPL))?.values.splitPayment).toBe(true);
  });

  it('faktura za abonament opłacony BLIK-iem: forma „mobile” wraca jako „other”, którą zna formularz', async () => {
    db.tables.invoices = [wzor({}, { payment: { method: 'mobile' } })];
    const p = await prefillFromInvoiceAction(TPL);
    expect(p?.values.paymentMethod).toBe('other');
    const values: InvoiceFormValues = { notes: '', buyerIsEu: false, buyerVatUe: '', buyerCountryCode: '', ...p!.values };
    const r = invoiceFormSchema.safeParse(values);
    expect(r.success ? [] : r.error.issues.map((i) => i.message)).toEqual([]);
  });

  it.each([
    ['faktura innej firmy', () => { db.tables.invoices = [wzor({ tenant_id: 'ten-2' })]; }, TPL],
    ['faktura kosztowa', () => { db.tables.invoices = [wzor({ direction: 'incoming' })]; }, TPL],
    ['nieistniejąca', () => { db.tables.invoices = []; }, TPL],
    ['nie-uuid', () => {}, 'abc'],
  ])('%s → null', async (_opis, ustaw, id) => {
    ustaw();
    await expect(prefillFromInvoiceAction(id)).resolves.toBeNull();
  });
});

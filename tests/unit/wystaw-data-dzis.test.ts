import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * F-092 (audyt bloku 1): „Wystaw i wyślij” przyjmował datę wystawienia do
 * 30 dni w przód i dowolnie wstecz. KSeF odrzuca P_1 późniejszą niż dzień
 * przyjęcia (CIRFMF, faktury/weryfikacja-faktury.md), a wcześniejszą sam
 * oznacza jako fakturę offline (offline/automatyczne-okreslanie-trybu-offline.md).
 * Wysyłka przyjmuje więc tylko dzisiejszą datę (czas polski); inną datę
 * można zapisać jako szkic. Kontrola idzie po autoryzacji, przed zapisem.
 */

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  audit: vi.fn(),
  enqueue: vi.fn(),
  gus: vi.fn(),
  inserts: [] as string[],
}));

function fakeSupabase() {
  return {
    from(table: string) {
      let op = 'select';
      const q = {
        select: () => q,
        eq: () => q,
        insert: () => { op = 'insert'; mocks.inserts.push(table); return q; },
        maybeSingle: async () => ({
          data: table === 'tenants'
            ? { id: 'ten-1', nip: '5260001246', name: 'Moja Firma', address_json: { countryCode: 'PL', addressLine1: 'ul. A 1', addressLine2: '00-001 Warszawa' }, vat_exemption_basis: null, vat_cash_method: false }
            : null,
          error: null,
        }),
        single: async () => ({ data: op === 'insert' ? { id: 'inv-new' } : null, error: null }),
        then: (ok: (v: unknown) => unknown, fail?: (e: unknown) => unknown) =>
          Promise.resolve({ data: null, error: null }).then(ok, fail),
      };
      return q;
    },
  };
}

vi.mock('@/lib/supabase/auth-context', () => ({ requireUserAndActiveOrg: mocks.auth }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/audit/log', () => ({ logAudit: mocks.audit }));
vi.mock('@/lib/invoices/ksef-submit-enqueue', () => ({ enqueueKsefSubmitAfterDraft: mocks.enqueue }));
vi.mock('@/lib/gus/client', () => ({ lookupCompanyByNip: mocks.gus }));

import { saveAndSendInvoiceAction, saveDraftAction } from '@/components/invoices/actions';
import type { InvoiceFormValues } from '@/lib/schemas/invoice-form';

// 2026-10-02 00:30 czasu polskiego = 2026-10-01 22:30 UTC.
const NOW = new Date('2026-10-01T22:30:00Z');

const form = (issueDate: string): InvoiceFormValues => ({
  internalNumber: 'FV/1/10/2026', issueDate, saleDate: '',
  buyerNip: '5252241585', buyerName: 'Klient', buyerAddressLine1: 'ul. B 2',
  buyerAddressLine2: '00-002 Warszawa', buyerEmail: '', buyerIsConsumer: false,
  buyerPesel: '', buyerIdDocument: '', paymentMethod: 'transfer', paymentDueDate: '2026-10-31',
  bankAccount: 'PL61109010140000071219812874',
  lines: [{ name: 'Usługa', unit: 'szt', quantity: 1, unitPriceNet: 100, vatRate: '23' }],
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.inserts = [];
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  mocks.auth.mockResolvedValue({ supabase: fakeSupabase(), user: { id: 'user-1' }, tenantId: 'ten-1', role: 'owner' });
  mocks.enqueue.mockResolvedValue({ ok: true, mode: 'online_queued' });
});

describe('„Wystaw i wyślij” — data wystawienia = dziś (F-092)', () => {
  it.each(['2026-10-03', '2026-10-01', '2026-09-15'])('data %s — odmowa bez zapisu i bez kolejki', async (data) => {
    const r = await saveAndSendInvoiceAction(form(data), 'ten-1');
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toContain('2026-10-02');
    expect(mocks.inserts).toEqual([]);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('dzisiejsza data w Polsce (choć w UTC jeszcze wczoraj) — zapis i kolejka', async () => {
    const r = await saveAndSendInvoiceAction(form('2026-10-02'), 'ten-1');
    expect(r).toMatchObject({ success: true, invoiceId: 'inv-new' });
    expect(mocks.inserts).toContain('invoices');
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
  });

  it('szkic z inną datą nadal można zapisać', async () => {
    const r = await saveDraftAction(form('2026-10-05'), 'ten-1');
    expect(r).toMatchObject({ success: true });
    expect(mocks.inserts).toContain('invoices');
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
});

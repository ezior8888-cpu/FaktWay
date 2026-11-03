import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * F-042 (audyt bloku 1): `saveDraftAction` nie walidowała danych po stronie
 * serwera (robiła to tylko „Wystaw i wyślij”). Wywołanie akcji wprost zapisywało
 * szkic z błędnym NIP-em czy ujemną ilością — a szkic da się teraz wysłać do
 * KSeF (F-001). Walidacja odpada, zanim akcja dotknie bazy.
 */

const mocks = vi.hoisted(() => ({ createClient: vi.fn(), audit: vi.fn(), enqueue: vi.fn(), gus: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.createClient, createAdminClient: vi.fn() }));
vi.mock('next/headers', () => ({ cookies: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/audit/log', () => ({ logAudit: mocks.audit }));
vi.mock('@/lib/invoices/ksef-submit-enqueue', () => ({ enqueueKsefSubmitAfterDraft: mocks.enqueue }));
vi.mock('@/lib/gus/client', () => ({ lookupCompanyByNip: mocks.gus }));

import { saveDraftAction } from '@/components/invoices/actions';
import type { InvoiceFormValues } from '@/lib/schemas/invoice-form';

const form: InvoiceFormValues = {
  internalNumber: 'FV/1/10/2026', issueDate: '2026-10-02', saleDate: '',
  buyerNip: '5252241585', buyerName: 'Klient', buyerAddressLine1: 'ul. B 2',
  buyerAddressLine2: '00-002 Warszawa', buyerEmail: '', buyerIsConsumer: false,
  buyerPesel: '', buyerIdDocument: '', paymentMethod: 'transfer', paymentDueDate: '2026-10-16',
  bankAccount: 'PL61109010140000071219812874',
  lines: [{ name: 'Usługa', unit: 'szt', quantity: 1, unitPriceNet: 100, vatRate: '23' }],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createClient.mockRejectedValue(new Error('baza nie powinna być wołana'));
});

describe('saveDraftAction — walidacja serwerowa (F-042)', () => {
  it('błędny NIP nabywcy — odmowa bez zapisu', async () => {
    const r = await saveDraftAction({ ...form, buyerNip: '1234567891' }, '11111111-1111-4111-8111-111111111111');
    expect(r).toEqual({ success: false, error: 'NIP firmy — 10 cyfr i suma kontrolna' });
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it('ujemna ilość — odmowa bez zapisu', async () => {
    const r = await saveDraftAction({
      ...form,
      lines: [{ name: 'Usługa', unit: 'szt', quantity: -1, unitPriceNet: 100, vatRate: '23' }],
    }, '11111111-1111-4111-8111-111111111111');
    expect(r.success).toBe(false);
    expect(mocks.createClient).not.toHaveBeenCalled();
  });
});

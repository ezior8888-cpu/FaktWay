import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * AUD-21 (decyzja I1, 02.10.2026): `invoices.net_total / vat_total /
 * gross_total` korekty to RÓŻNICA — dla każdego typu, spójnie z P_13/P_15
 * w FA(3) KOR. Dotąd „przed/po” zapisywała wartość PO korekcie (KPiR liczył
 * przychód podwójnie), a kwotowa i anulowanie — zero (korekta bez wpływu,
 * anulowana faktura dalej w przychodzie). KPiR, CSV i pulpit sumują
 * `net_total` faktur sprzedaży, więc z różnicą liczą się poprawnie same.
 */

const st = vi.hoisted(() => ({ inserted: [] as Record<string, unknown>[] }));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
// Testowy NIP 1234567890 nie ma poprawnej sumy kontrolnej — jak w innych testach akcji.
vi.mock('@/lib/xml/invoice-calculator', async (orig) => ({
  ...(await orig<typeof import('@/lib/xml/invoice-calculator')>()),
  validateNipChecksum: () => true,
}));
vi.mock('@/lib/audit/log', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/invoices/ksef-submit-enqueue', () => ({ enqueueKsefSubmitAfterDraft: vi.fn() }));
vi.mock('@/lib/jobs/error-message', () => ({ formatJobSendError: () => 'x' }));
vi.mock('@/lib/supabase/active-org', () => ({ getActiveOrgIdFromCookies: async () => '11111111-1111-4111-8111-111111111111' }));
// Akcje dokumentów specjalnych idą przez sesję po MFA i członkostwo (#71).
vi.mock('@/lib/supabase/auth-context', () => ({
  requireUserAndActiveOrg: async () => {
    const { createClient } = await import('@/lib/supabase/server');
    return { supabase: await createClient(), user: { id: 'fixture-user' }, tenantId: '11111111-1111-4111-8111-111111111111' };
  },
  ActionAuthError: class ActionAuthError extends Error {},
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'fixture-user' } } }) },
    from: (table: string) => {
      const q = {
        select: () => q,
        eq: () => q,
        order: () => q,
        // Faktura pierwotna: przyjęta w KSeF, w bieżącym środowisku (#63).
        maybeSingle: async () => ({
          data: table === 'invoices'
            ? {
                id: '00000000-0000-4000-8000-000000000001', tenant_id: '11111111-1111-4111-8111-111111111111',
                issue_date: '2026-09-30', internal_number: 'FV 1/09/2026', ksef_number: 'KSEF-TEST-1',
                net_total: 1000, vat_total: 230, gross_total: 1230, fa3_data: null,
                seller_data: { nip: '1234567890', name: 'Firma testowa', address: { countryCode: 'PL', addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa' } },
                buyer_data: { nip: '1234567890', name: 'Nabywca testowy', address: { countryCode: 'PL', addressLine1: 'ul. Testowa 2', addressLine2: '00-002 Warszawa' } },
              }
            : { id: '11111111-1111-4111-8111-111111111111', nip: '1234567890', name: 'Firma testowa', address_json: null },
          error: null,
        }),
        // Pozycje faktury pierwotnej (#63 czyta je z bazy, nie z formularza).
        then: (ok: (v: unknown) => unknown) => Promise.resolve(table === 'invoice_line_items'
          ? { data: [{ name: 'Usługa', unit: 'szt.', quantity: 10, unit_price_net: 100, vat_rate: '23' }], error: null }
          : { data: [], error: null }).then(ok),
        insert: (payload: Record<string, unknown>) => {
          if (table === 'invoices') st.inserted.push(payload);
          return table === 'invoices'
            ? { select: () => ({ single: async () => ({ data: { id: 'inv-1' }, error: null }) }) }
            : Promise.resolve({ error: null });
        },
      };
      return q;
    },
  }),
}));

import { saveCorrectionDraftAction } from '@/components/invoices/correction-actions';

vi.stubEnv('KSEF_ENV', 'test');

const line = (o: Record<string, unknown> = {}) => ({ name: 'Usługa', unit: 'szt.', quantity: 10, unitPriceNet: 100, vatRate: '23', ...o });

function payload(o: Record<string, unknown>) {
  return {
    invoiceType: 'correction',
    internalNumber: 'FK/1/10/2026',
    issueDate: '2026-10-02',
    paymentMethod: 'transfer',
    paymentDueDate: '2026-10-16',
    parentInvoiceId: '00000000-0000-4000-8000-000000000001',
    parentInvoiceNumber: 'FV 1/09/2026',
    parentInvoiceIssueDate: '2026-09-30',
    parentKsefNumber: 'KSEF-TEST-1',
    correctionReason: 'Zmiana ilości po reklamacji',
    typKorekty: '2',
    seller: { nip: '1234567890', name: 'Firma testowa', address: { countryCode: 'PL', addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa' } },
    buyer: { type: 'b2b', idType: 'nip', nip: '1234567890', name: 'Nabywca testowy', address: { countryCode: 'PL', addressLine1: 'ul. Testowa 2', addressLine2: '00-002 Warszawa' } },
    ...o,
  } as never;
}

beforeEach(() => { st.inserted = []; });

describe('sumy korekty w bazie = różnica', () => {
  it('przed/po: różnica, nie wartość po korekcie', async () => {
    const r = await saveCorrectionDraftAction(payload({ correctionType: 'before_after', linesBefore: [line()], linesAfter: [line({ quantity: 8 })] }), '11111111-1111-4111-8111-111111111111');
    expect(r).toEqual({ success: true, invoiceId: 'inv-1' });
    expect(st.inserted[0]).toEqual(expect.objectContaining({ net_total: -200, vat_total: -46, gross_total: -246 }));
  });

  it('kwotowa: różnica z formularza, nie zero', async () => {
    await saveCorrectionDraftAction(payload({
      correctionType: 'amount_change',
      amountChange: { netDelta: -100, vatDelta: -23, grossDelta: -123, description: 'Rabat posprzedażowy' },
    }), '11111111-1111-4111-8111-111111111111');
    expect(st.inserted[0]).toEqual(expect.objectContaining({ net_total: -100, vat_total: -23, gross_total: -123 }));
  });

  it('anulowanie: minus cała faktura, nie zero', async () => {
    await saveCorrectionDraftAction(payload({ correctionType: 'cancellation', linesBefore: [line()] }), '11111111-1111-4111-8111-111111111111');
    expect(st.inserted[0]).toEqual(expect.objectContaining({ net_total: -1000, vat_total: -230, gross_total: -1230 }));
  });
});

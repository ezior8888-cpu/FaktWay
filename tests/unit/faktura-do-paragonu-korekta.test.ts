import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Korekta faktury do paragonu (plan kompletnej aplikacji, krok 1.2): generator
 * korekty nie pisze `FP`, a korekty są na produkcji wstrzymane (KOR_HOLD), więc
 * korekta FP zostaje na później. Do tego czasu odmowa z komunikatem i wyjściem,
 * zanim cokolwiek się zapisze: i dla FP wystawionej w FaktWay (`fa3_data.receipt`),
 * i dla FP z importu KSeF (`fa3_data.ksefMarkers.fp`). Prawdziwe akcje korekty,
 * baza w pamięci jak w `korekta-lancuch.test.ts`.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const PARENT = '00000000-0000-4000-8000-000000000001';

type Row = Record<string, unknown>;
const st = vi.hoisted(() => ({
  inserted: [] as Row[],
  parentExtra: {} as Row,
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/xml/invoice-calculator', async (orig) => ({
  ...(await orig<typeof import('@/lib/xml/invoice-calculator')>()),
  validateNipChecksum: () => true,
}));
vi.mock('@/lib/audit/log', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/invoices/ksef-submit-enqueue', () => ({ enqueueKsefSubmitAfterDraft: vi.fn() }));
vi.mock('@/lib/supabase/auth-context', () => ({
  requireUserAndActiveOrg: async () => {
    const { createClient } = await import('@/lib/supabase/server');
    return { supabase: await createClient(), user: { id: 'fixture-user' }, tenantId: TENANT, role: 'owner' };
  },
  ActionAuthError: class ActionAuthError extends Error {},
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      const parent = {
        id: PARENT, tenant_id: TENANT, issue_date: '2026-11-09', internal_number: 'FV 5/11/2026', ksef_number: 'KSEF-TEST-1',
        net_total: 1000, vat_total: 230, gross_total: 1230,
        seller_data: { nip: '1234567890', name: 'Firma testowa', address: { countryCode: 'PL', addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa' } },
        buyer_data: { nip: '1234567890', name: 'Nabywca testowy', address: { countryCode: 'PL', addressLine1: 'ul. Testowa 2', addressLine2: '00-002 Warszawa' } },
        ...st.parentExtra,
      };
      const result = () => {
        if (table === 'tenants') return { data: { id: TENANT, nip: '1234567890', name: 'Firma testowa', address_json: null }, error: null };
        if (table === 'invoice_line_items') {
          return { data: [{ name: 'Rower', unit: 'szt.', quantity: 1, unit_price_net: 1000, vat_rate: '23' }], error: null };
        }
        if (table === 'invoices' && 'parent_invoice_id' in filters) return { data: [], error: null };
        if (table === 'invoices') return { data: filters.id === PARENT ? parent : null, error: null };
        return { data: [], error: null };
      };
      const q = {
        select: () => q,
        eq: (k: string, v: unknown) => { filters[k] = v; return q; },
        order: () => q,
        maybeSingle: async () => result(),
        single: async () => result(),
        then: (ok: (v: unknown) => unknown) => Promise.resolve(result()).then(ok),
        insert: (payload: Row) => {
          if (table === 'invoices') st.inserted.push(payload);
          return table === 'invoices'
            ? { select: () => ({ single: async () => ({ data: { id: 'inv-new' }, error: null }) }) }
            : Promise.resolve({ error: null });
        },
        delete: () => q,
      };
      return q;
    },
  }),
}));

import { getCorrectionParentContextAction, saveCorrectionDraftAction } from '@/components/invoices/correction-actions';

vi.stubEnv('KSEF_ENV', 'test');

const line = { name: 'Rower', unit: 'szt.', quantity: 1, unitPriceNet: 1000, vatRate: '23' };

const payload = {
  invoiceType: 'correction',
  internalNumber: 'FK/1/11/2026',
  issueDate: '2026-11-09',
  paymentMethod: 'cash',
  paymentDueDate: '2026-11-09',
  parentInvoiceId: PARENT,
  parentInvoiceNumber: 'FV 5/11/2026',
  parentInvoiceIssueDate: '2026-11-09',
  parentKsefNumber: 'KSEF-TEST-1',
  correctionReason: 'Zwrot',
  typKorekty: '2',
  correctionType: 'before_after',
  linesBefore: [line],
  linesAfter: [{ ...line, unitPriceNet: 900 }],
  seller: { nip: '1234567890', name: 'Firma testowa', address: { countryCode: 'PL', addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa' } },
  buyer: { type: 'b2b', idType: 'nip', nip: '1234567890', name: 'Nabywca testowy', address: { countryCode: 'PL', addressLine1: 'ul. Testowa 2', addressLine2: '00-002 Warszawa' } },
} as never;

beforeEach(() => {
  st.inserted = [];
  st.parentExtra = {};
});

describe('korekta faktury do paragonu: odmowa przed zapisem', () => {
  it.each([
    ['FP wystawiona w FaktWay', { fp_paragon: '000123', fp_ksef: null }],
    ['FP z importu KSeF', { fp_paragon: null, fp_ksef: 'true' }],
  ])('%s: kontekst korekty i zapis szkicu odmawiają z komunikatem', async (_opis, extra) => {
    st.parentExtra = extra;
    const ctx = await getCorrectionParentContextAction(PARENT);
    expect(ctx).toEqual({ success: false, error: expect.stringMatching(/FV 5\/11\/2026.*do paragonu.*Pomoc/) });

    const r = await saveCorrectionDraftAction(payload, TENANT);
    expect(r).toMatchObject({ success: false, error: expect.stringMatching(/do paragonu/) });
    expect(st.inserted).toHaveLength(0);
  });

  it('zwykła faktura (bez paragonu): korekta działa jak dotąd', async () => {
    st.parentExtra = { fp_paragon: null, fp_ksef: null };
    const ctx = await getCorrectionParentContextAction(PARENT);
    expect(ctx.success).toBe(true);
  });
});

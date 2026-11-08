import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * K4 z rewizji 03.10.2026 — łańcuch korekt. Reprodukcja: FV 10×100 (1000
 * netto), KOR1 „przed/po” 10→8 przyjęta (różnica −200/−46/−246). KOR2 „8→7”
 * ma dać różnicę −100/−23/−123. Do tej zmiany „stan przed” brano z faktury
 * pierwotnej: KOR2 liczyła 10→7 (−300/−69/−369) — podwójna korekta, a klient
 * płaciłby karę za zaniżony VAT. Po korekcie kwotowej stan pozycji nie jest
 * jednoznaczny (tylko kwotowa), po anulowaniu nie ma czego korygować,
 * korekta w toku blokuje kolejną.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const PARENT = '00000000-0000-4000-8000-000000000001';
const KOR1 = '00000000-0000-4000-8000-000000000101';

type Row = Record<string, unknown>;
const st = vi.hoisted(() => ({
  inserted: [] as Row[],
  corrections: [] as Row[],
  linesByInvoice: {} as Record<string, Row[]>,
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
        id: PARENT, tenant_id: TENANT, issue_date: '2026-09-30', internal_number: 'FV 1/09/2026', ksef_number: 'KSEF-TEST-1',
        net_total: 1000, vat_total: 230, gross_total: 1230, fa3_data: null,
        seller_data: { nip: '1234567890', name: 'Firma testowa', address: { countryCode: 'PL', addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa' } },
        buyer_data: { nip: '1234567890', name: 'Nabywca testowy', address: { countryCode: 'PL', addressLine1: 'ul. Testowa 2', addressLine2: '00-002 Warszawa' } },
      };
      const result = () => {
        if (table === 'tenants') return { data: { id: TENANT, nip: '1234567890', name: 'Firma testowa', address_json: null }, error: null };
        if (table === 'invoice_line_items') return { data: st.linesByInvoice[String(filters.invoice_id)] ?? [], error: null };
        if (table === 'invoices' && 'parent_invoice_id' in filters) {
          return { data: st.corrections.filter((c) => c.parent_invoice_id === filters.parent_invoice_id), error: null };
        }
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
import { excludeParentsWithOpenCorrection } from '@/lib/invoices/correction-parents';

vi.stubEnv('KSEF_ENV', 'test');

const line = (quantity: number) => ({ name: 'Usługa', unit: 'szt.', quantity, unitPriceNet: 100, vatRate: '23' });
const dbLine = (quantity: number) => ({ name: 'Usługa', unit: 'szt.', quantity, unit_price_net: 100, vat_rate: '23' });

function payload(o: Record<string, unknown>) {
  return {
    invoiceType: 'correction',
    internalNumber: 'FK/2/10/2026',
    issueDate: '2026-10-03',
    paymentMethod: 'transfer',
    paymentDueDate: '2026-10-17',
    parentInvoiceId: PARENT,
    parentInvoiceNumber: 'FV 1/09/2026',
    parentInvoiceIssueDate: '2026-09-30',
    parentKsefNumber: 'KSEF-TEST-1',
    correctionReason: 'Kolejna reklamacja',
    typKorekty: '2',
    seller: { nip: '1234567890', name: 'Firma testowa', address: { countryCode: 'PL', addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa' } },
    buyer: { type: 'b2b', idType: 'nip', nip: '1234567890', name: 'Nabywca testowy', address: { countryCode: 'PL', addressLine1: 'ul. Testowa 2', addressLine2: '00-002 Warszawa' } },
    ...o,
  } as never;
}

const kor1 = (o: Row = {}): Row => ({
  id: KOR1, tenant_id: TENANT, parent_invoice_id: PARENT, invoice_kind: 'correction', internal_number: 'FK/1/10/2026',
  correction_type: 'before_after', ksef_status: 'accepted', ksef_accepted_at: '2026-10-02T10:00:00Z', created_at: '2026-10-02T09:00:00Z',
  net_total: -200, vat_total: -46, gross_total: -246, ...o,
});

beforeEach(() => {
  st.inserted = [];
  st.corrections = [];
  st.linesByInvoice = { [PARENT]: [dbLine(10)], [KOR1]: [dbLine(8)] };
});

describe('łańcuch korekt (K4)', () => {
  it('KOR2 po przyjętej KOR1 „10→8” liczy różnicę od stanu po KOR1: „8→7” = −100/−23/−123', async () => {
    st.corrections = [kor1()];
    const r = await saveCorrectionDraftAction(payload({ correctionType: 'before_after', linesBefore: [line(8)], linesAfter: [line(7)] }), TENANT);
    expect(r).toMatchObject({ success: true });
    expect(st.inserted[0]).toEqual(expect.objectContaining({ net_total: -100, vat_total: -23, gross_total: -123 }));
  });

  it('formularz dostaje „stan przed” = pozycje po KOR1 i sumę bieżącą (984), nie pierwotną', async () => {
    st.corrections = [kor1()];
    const ctx = await getCorrectionParentContextAction(PARENT);
    expect(ctx.success).toBe(true);
    if (ctx.success) {
      expect(ctx.linesBefore).toEqual([line(8)]);
      expect(ctx.grossTotal).toBe(984);
      expect(ctx.previousCorrection).toEqual({ internalNumber: 'FK/1/10/2026', correctionType: 'before_after' });
      expect(ctx.allowedCorrectionTypes).toBe('all');
    }
  });

  it('„stan przed” z formularza inny niż stan po KOR1 → odmowa (nie liczymy od pierwotnej)', async () => {
    st.corrections = [kor1()];
    const r = await saveCorrectionDraftAction(payload({ correctionType: 'before_after', linesBefore: [line(10)], linesAfter: [line(7)] }), TENANT);
    expect(r).toMatchObject({ success: false, error: expect.stringContaining('po korekcie FK/1/10/2026') });
    expect(st.inserted).toHaveLength(0);
  });

  it('niezgodność pozycji KOR1 z sumami faktury i korekt → odmowa, bez zgadywania', async () => {
    st.corrections = [kor1({ net_total: -100, vat_total: -23, gross_total: -123 })]; // wiersze KOR1 mówią 8, sumy mówią 9
    const r = await saveCorrectionDraftAction(payload({ correctionType: 'before_after', linesBefore: [line(8)], linesAfter: [line(7)] }), TENANT);
    expect(r).toMatchObject({ success: false, error: expect.stringContaining('nie zgadza się z sumami') });
  });

  it('po przyjętej korekcie kwotowej: „przed/po” odmawia, kwotowa przechodzi', async () => {
    st.corrections = [kor1({ correction_type: 'amount_change', net_total: -50, vat_total: -11.5, gross_total: -61.5 })];
    const beforeAfter = await saveCorrectionDraftAction(payload({ correctionType: 'before_after', linesBefore: [line(10)], linesAfter: [line(9)] }), TENANT);
    expect(beforeAfter).toMatchObject({ success: false, error: expect.stringContaining('tylko kwotowa') });
    const amount = await saveCorrectionDraftAction(payload({
      correctionType: 'amount_change',
      amountChange: { netDelta: -10, vatDelta: -2.3, grossDelta: -12.3, description: 'Rabat' },
    }), TENANT);
    expect(amount).toMatchObject({ success: true });
    expect(st.inserted[0]).toEqual(expect.objectContaining({ net_total: -10, vat_total: -2.3, gross_total: -12.3 }));
  });

  it('po przyjętym anulowaniu nic nie da się skorygować', async () => {
    st.corrections = [kor1({ correction_type: 'cancellation', net_total: -1000, vat_total: -230, gross_total: -1230 })];
    const r = await saveCorrectionDraftAction(payload({ correctionType: 'amount_change', amountChange: { netDelta: -10, vatDelta: -2.3, grossDelta: -12.3, description: 'x' } }), TENANT);
    expect(r).toMatchObject({ success: false, error: expect.stringContaining('anulowana') });
    const ctx = await getCorrectionParentContextAction(PARENT);
    expect(ctx).toMatchObject({ success: false, error: expect.stringContaining('anulowana') });
  });

  it('korekta w toku (failed) blokuje kolejną; odrzucona nie liczy się wcale', async () => {
    st.corrections = [kor1({ ksef_status: 'failed', ksef_accepted_at: null })];
    const blocked = await saveCorrectionDraftAction(payload({ correctionType: 'before_after', linesBefore: [line(10)], linesAfter: [line(9)] }), TENANT);
    expect(blocked).toMatchObject({ success: false, error: expect.stringContaining('w toku') });

    st.corrections = [kor1({ ksef_status: 'rejected', ksef_accepted_at: null })];
    const fresh = await saveCorrectionDraftAction(payload({ correctionType: 'before_after', linesBefore: [line(10)], linesAfter: [line(9)] }), TENANT);
    expect(fresh).toMatchObject({ success: true });
    expect(st.inserted[0]).toEqual(expect.objectContaining({ net_total: -100, vat_total: -23, gross_total: -123 }));
  });

  it('lista rodziców: tylko korekta w toku usuwa rodzica; przyjęta i odrzucona nie', () => {
    const out = excludeParentsWithOpenCorrection([{ id: 'a' }, { id: 'b' }, { id: 'c' }], [
      { parent_invoice_id: 'a', ksef_status: 'accepted' },
      { parent_invoice_id: 'b', ksef_status: 'queued' },
      { parent_invoice_id: 'c', ksef_status: 'rejected' },
    ]);
    expect(out.map((p) => p.id)).toEqual(['a', 'c']);
  });
});

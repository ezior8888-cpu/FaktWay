import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';

type Row = Record<string, unknown>;

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const INVOICE = '11111111-1111-4111-8111-111111111111';
const OCR_JOB = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';

const db = vi.hoisted(() => ({
  basis: null as string | null,
  inserts: [] as Record<string, unknown>[],
}));

// AUD-107: budżet AI firmy — tu zawsze w limicie (osobne testy: ai-limit-*).
vi.mock('@/lib/ksef/inbox-xml', () => ({ archiveInboxInvoiceXml: async () => ({ archived: false, reason: 'not-applicable' }) }));
vi.mock('@/lib/ai/tenant-ai-budget', () => ({
  checkTenantAiBudget: async () => ({ allowed: true }),
  recordTenantAiUsage: async () => undefined,
}));
vi.mock('@/lib/categorization', () => ({
  categorizeExpense: async () => ({ kpir_column: 'col_13', category_label: 'Usługi', method: 'rule', confidence: 0.5 }),
}));
vi.mock('@/lib/ocr/engine', () => ({
  extractInvoiceFromImage: async () => ({
    success: true,
    data: {
      seller_name: 'Dostawca',
      seller_nip: '5260001246',
      seller_address: null,
      document_number: 'FV/9',
      document_type: 'invoice',
      issue_date: '2026-09-20',
      net_amount: 100,
      vat_amount: 23,
      gross_amount: 123,
      vat_rate: '23',
      line_items: null,
      ocr_confidence: 0.9,
      notes: null,
    },
    inputTokens: 1,
    outputTokens: 1,
    processingTimeMs: 1,
  }),
}));
vi.mock('@/lib/storage/expenses', () => ({
  downloadExpensePhoto: async () => ({ buffer: Buffer.from('x'), mimeType: 'image/jpeg' }),
}));
vi.mock('@/lib/push/sender', () => ({ sendPushToUser: vi.fn() }));
vi.mock('@/lib/flo/proposals', () => ({ createProposal: vi.fn() }));
vi.mock('@/lib/jobs/runners/tenant-boundary', () => ({ requireTenantMember: vi.fn(async () => undefined) }));
vi.mock('@/lib/ksef/claim-environment', () => ({ requireConfiguredKsefEnvironment: () => 'test' }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      let insertRow: Row | null = null;
      // Historia sprzedawcy czyta stronami po `id` (sesja 29 planu skalowania).
      let pagedById = false;
      Object.assign(q, {
        select: () => q,
        eq: () => q,
        gt: () => q,
        order: (column: string) => {
          pagedById = column === 'id';
          return q;
        },
        limit: () => q,
        update: () => q,
        insert: (r: Row) => {
          insertRow = r;
          if (table === 'expenses') db.inserts.push(r);
          return q;
        },
        single: async () => {
          if (table === 'invoices') {
            return {
              data: {
                id: INVOICE,
                tenant_id: TENANT,
                direction: 'incoming',
                ksef_number: '5260001246-20260920-000000000009-00',
                internal_number: 'FV/9',
                issue_date: '2026-09-20',
                seller_data: { name: 'Dostawca', nip: '5260001246' },
                seller_nip: '5260001246',
                gross_total: 123,
                net_total: 100,
                vat_total: 23,
                currency: 'PLN',
                fa3_data: {},
                invoice_line_items: [],
              },
              error: null,
            };
          }
          if (table === 'ocr_jobs') {
            return {
              data: { id: OCR_JOB, tenant_id: TENANT, created_by: USER, source_file_path: 'r2/x.jpg', source_file_mime: 'image/jpeg' },
              error: null,
            };
          }
          return { data: insertRow ? { id: 'exp-1' } : null, error: null };
        },
        maybeSingle: async () => {
          if (table === 'invoices') return { data: { id: INVOICE }, error: null };
          if (table === 'tenants') return { data: { vat_exemption_basis: db.basis }, error: null };
          if (table === 'memberships') return { data: { user_id: USER }, error: null };
          return { data: null, error: null };
        },
        // Strona historii: pusta lista, jak sprzedawca bez wcześniejszych kosztów.
        then: (ok: (v: { data?: Row[]; error: null }) => unknown) =>
          Promise.resolve(pagedById ? { data: [], error: null } : { error: null }).then(ok),
      });
      return q;
    },
  }),
}));

import { runAutoCategorizeInbox } from '@/lib/jobs/runners/auto-categorize-inbox';
import { runProcessOcr } from '@/lib/jobs/runners/process-ocr';

/**
 * Firma zwolniona z VAT (#60) nie odlicza VAT-u. Nowe koszty dostają VAT do
 * odliczenia = 0 — wtedy KPiR liczy je brutto (#65), a JPK nic nie odlicza.
 * Czynny podatnik — bez zmian.
 */

const ctx: JobContext = {
  attempt: 0,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  step: { run: async (_n, fn) => fn(), sleep: vi.fn(), sendEvent: vi.fn(), scheduleAfter: vi.fn() },
};

beforeEach(() => {
  db.basis = null;
  db.inserts = [];
});

describe.each([
  ['skrzynka KSeF', () => runAutoCategorizeInbox({ invoiceId: INVOICE, tenantId: TENANT, environment: 'test' }, ctx)],
  ['zdjęcie (OCR)', () => runProcessOcr({ ocrJobId: OCR_JOB, tenantId: TENANT }, ctx)],
])('koszt ze ścieżki: %s', (_opis, run) => {
  it('firma zwolniona z VAT: VAT do odliczenia 0', async () => {
    db.basis = 'art. 113 ust. 1 ustawy o VAT';
    await run();
    expect(db.inserts).toHaveLength(1);
    expect(db.inserts[0]).toMatchObject({ vat_amount: 23, vat_deductible_amount: 0 });
  });

  it('czynny podatnik VAT: pełny VAT do odliczenia', async () => {
    await run();
    expect(db.inserts[0]).toMatchObject({ vat_amount: 23, vat_deductible_amount: 23 });
  });

  // AUD-68 (decyzja I2): zeruje tylko zwolnienie podmiotowe z art. 113.
  // Podstawa z art. 43 (sprzedaż zwolniona przedmiotowo) nie odbiera
  // czynnemu podatnikowi odliczenia od kosztów.
  it('podstawa z art. 43: odliczenie zostaje', async () => {
    db.basis = 'art. 43 ust. 1 pkt 19 ustawy o VAT';
    await run();
    expect(db.inserts[0]).toMatchObject({ vat_amount: 23, vat_deductible_amount: 23 });
  });

  it('art. 113 ust. 9 też zeruje', async () => {
    db.basis = 'art. 113 ust. 9 ustawy o VAT';
    await run();
    expect(db.inserts[0]).toMatchObject({ vat_deductible_amount: 0 });
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';

/**
 * AUD-107 (decyzja B7): OCR i klasyfikator AI nie miały limitu na firmę —
 * jedno konto (także trial) mogło wygenerować dowolny rachunek u Anthropic.
 * Job OCR pyta o budżet PRZED wywołaniem modelu i zapisuje zużycie po nim.
 */

type Row = Record<string, unknown>;

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OCR_JOB = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';

const budget = vi.hoisted(() => ({ check: vi.fn(), record: vi.fn(), extract: vi.fn() }));
const state = vi.hoisted(() => ({
  expenses: [] as Record<string, unknown>[],
  jobUpdates: [] as Record<string, unknown>[],
  lookupError: false,
  proposal: vi.fn(),
}));

vi.mock('@/lib/categorization', () => ({
  categorizeExpense: async () => ({ kpir_column: 'col_13', category_label: 'Paliwo', method: 'rule', confidence: 0.9 }),
}));
vi.mock('@/lib/ai/tenant-ai-budget', () => ({
  checkTenantAiBudget: budget.check,
  recordTenantAiUsage: budget.record,
}));
vi.mock('@/lib/ocr/engine', () => ({
  extractInvoiceFromImage: budget.extract.mockImplementation(async () => ({
    success: true,
    data: {
      seller_name: 'Stacja Paliw', seller_nip: '5260001246', seller_address: null,
      document_number: 'PAR/1', document_type: 'receipt', issue_date: '2026-09-28',
      net_amount: 100, vat_amount: 23, gross_amount: 123, vat_rate: '23',
      line_items: null, ocr_confidence: 0.95, notes: null, currency: 'PLN',
    },
    inputTokens: 1, outputTokens: 1, processingTimeMs: 1,
  })),
}));
vi.mock('@/lib/storage/expenses', () => ({
  downloadExpensePhoto: async () => ({ buffer: Buffer.from('x'), mimeType: 'image/jpeg' }),
}));
vi.mock('@/lib/push/sender', () => ({ sendPushToUser: vi.fn() }));
vi.mock('@/lib/flo/proposals', () => ({ createProposal: state.proposal }));
vi.mock('@/lib/flo/functions/expense-review', () => ({
  buildExpenseReviewProposal: () => ({}), buildOcrFailedProposal: () => ({}), readSellerHistory: async () => null,
  ocrFailedTopicKey: (ocrJobId: string) => `expense.review:ocr:${ocrJobId}`,
}));
vi.mock('@/lib/jobs/runners/tenant-boundary', () => ({ requireTenantMember: vi.fn(async () => undefined) }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const filters: Array<[string, unknown]> = [];
      let insertRow: Row | null = null;
      const q: Record<string, unknown> = {};
      const matching = () => state.expenses.filter((r) => filters.every(([k, v]) => r[k] === v));
      Object.assign(q, {
        select: () => q,
        eq: (k: string, v: unknown) => { filters.push([k, v]); return q; },
        limit: () => q,
        update: (v: Row) => { if (table === 'ocr_jobs') state.jobUpdates.push(v); return q; },
        insert: (r: Row) => { insertRow = r; return q; },
        single: async () => {
          if (table === 'ocr_jobs') {
            return {
              data: { id: OCR_JOB, tenant_id: TENANT, created_by: USER, source_file_path: 'r2/x.jpg', source_file_mime: 'image/jpeg' },
              error: null,
            };
          }
          if (table === 'expenses' && insertRow) {
            const row = { id: `exp-${state.expenses.length + 1}`, ...insertRow };
            state.expenses.push(row);
            return { data: { id: row.id }, error: null };
          }
          return { data: null, error: null };
        },
        maybeSingle: async () => {
          if (table === 'tenants') return { data: { vat_exemption_basis: null }, error: null };
          if (table === 'expenses') {
            if (state.lookupError) return { data: null, error: { message: 'database unavailable' } };
            return { data: matching()[0] ?? null, error: null };
          }
          return { data: null, error: null };
        },
        then: (ok: (v: { error: null }) => unknown) => Promise.resolve({ error: null }).then(ok),
      });
      return q;
    },
  }),
}));


import { runProcessOcr } from '@/lib/jobs/runners/process-ocr';

const ctx: JobContext = {
  attempt: 0,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  step: { run: async (_n, fn) => fn(), sleep: vi.fn(), sendEvent: vi.fn(), scheduleAfter: vi.fn() },
};
const event = { ocrJobId: OCR_JOB, tenantId: TENANT };

beforeEach(() => {
  state.expenses = [];
  state.jobUpdates = [];
  state.proposal.mockReset().mockResolvedValue({ status: 'created' });
  budget.check.mockReset().mockResolvedValue({ allowed: true });
  budget.record.mockReset().mockResolvedValue(undefined);
  budget.extract.mockClear();
});

describe('OCR a limit AI firmy', () => {
  it('limit wyczerpany — model nie jest wywoływany, zadanie kończy się czytelnym komunikatem', async () => {
    budget.check.mockResolvedValue({ allowed: false, message: 'Wykorzystano dzienny limit rozpoznawania dokumentów.' });
    expect(await runProcessOcr(event, ctx)).toEqual({ success: false });
    expect(budget.check).toHaveBeenCalledWith(TENANT, 'ocr');
    expect(budget.extract).not.toHaveBeenCalled();
    expect(state.jobUpdates).toContainEqual(expect.objectContaining({ status: 'failed', error_message: 'Wykorzystano dzienny limit rozpoznawania dokumentów.' }));
  });

  it('w limicie — wywołanie modelu i zapis zużycia', async () => {
    await runProcessOcr(event, ctx);
    expect(budget.extract).toHaveBeenCalledOnce();
    expect(budget.record).toHaveBeenCalledWith(TENANT, { inputTokens: 1, outputTokens: 1 });
  });
});

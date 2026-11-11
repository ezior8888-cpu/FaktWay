import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';

type Row = Record<string, unknown>;

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OCR_JOB = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';

const db = vi.hoisted(() => ({
  inserts: [] as Record<string, unknown>[],
  doc: {} as Record<string, unknown>,
  nbp: vi.fn(),
}));

// AUD-107: budżet AI firmy — tu zawsze w limicie (osobne testy: ai-limit-*).
vi.mock('@/lib/ai/tenant-ai-budget', () => ({
  checkTenantAiBudget: async () => ({ allowed: true }),
  recordTenantAiUsage: async () => undefined,
}));
vi.mock('@/lib/categorization', () => ({
  categorizeExpense: async () => ({ kpir_column: 'col_13', category_label: 'Oprogramowanie', method: 'rule', confidence: 0.5 }),
}));
vi.mock('@/lib/ocr/engine', () => ({
  extractInvoiceFromImage: async () => ({
    success: true,
    data: db.doc,
    inputTokens: 1,
    outputTokens: 1,
    processingTimeMs: 1,
  }),
}));
// Kurs z NBP bez sieci — test sprawdza, CO job z nim robi.
vi.mock('@/lib/nbp/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/nbp/client')>()),
  nbpRateForCost: db.nbp,
}));
vi.mock('@/lib/storage/expenses', () => ({
  downloadExpensePhoto: async () => ({ buffer: Buffer.from('x'), mimeType: 'image/jpeg' }),
}));
vi.mock('@/lib/push/sender', () => ({ sendPushToUser: vi.fn() }));
vi.mock('@/lib/flo/proposals', () => ({ createProposal: vi.fn() }));
vi.mock('@/lib/jobs/runners/tenant-boundary', () => ({ requireTenantMember: vi.fn(async () => undefined) }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      let insertRow: Row | null = null;
      Object.assign(q, {
        select: () => q,
        eq: () => q,
        limit: () => q,
        update: () => q,
        insert: (r: Row) => {
          insertRow = r;
          if (table === 'expenses') db.inserts.push(r);
          return q;
        },
        single: async () => {
          if (table === 'ocr_jobs') {
            return {
              data: { id: OCR_JOB, tenant_id: TENANT, created_by: USER, source_file_path: 'r2/x.jpg', source_file_mime: 'image/jpeg' },
              error: null,
            };
          }
          return { data: insertRow ? { id: 'exp-1' } : null, error: null };
        },
        maybeSingle: async () => {
          if (table === 'tenants') return { data: { vat_exemption_basis: null }, error: null };
          if (table === 'memberships') return { data: { user_id: USER }, error: null };
          return { data: null, error: null };
        },
        then: (ok: (v: { error: null }) => unknown) => Promise.resolve({ error: null }).then(ok),
      });
      return q;
    },
  }),
}));

import { runProcessOcr } from '@/lib/jobs/runners/process-ocr';
import { kpirCostAmount } from '@/lib/categorization/kpir-cost';
import { costDocumentType, vatDeductionForDocument } from '@/lib/expenses/vat-deduction-document';

/**
 * OCR zapisywał paragon z NIP (rozpoznany `simplified_invoice`) jako `invoice`;
 * rodzaj zostawał tylko w `ocr_extracted_data`. Zapisany rodzaj ma być zgodny
 * z rozpoznaniem, a wynik dla paragonu z NIP z 2026 r. bez zmian.
 */
const ctx: JobContext = {
  attempt: 0,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  step: { run: async (_n, fn) => fn(), sleep: vi.fn(), sendEvent: vi.fn(), scheduleAfter: vi.fn() },
};

const DOKUMENT = {
  seller_name: 'Sklep Przykład',
  seller_nip: '5260250995',
  seller_address: null,
  document_number: 'PAR/1',
  document_type: 'simplified_invoice',
  issue_date: '2026-11-03',
  net_amount: 100,
  vat_amount: 23,
  gross_amount: 123,
  vat_rate: '23',
  line_items: null,
  ocr_confidence: 0.95,
  notes: null,
};

beforeEach(() => {
  db.inserts = [];
  db.doc = { ...DOKUMENT };
});

describe('OCR: rodzaj zapisanego dokumentu', () => {
  it.each([
    ['simplified_invoice', 'simplified_invoice'],
    ['invoice', 'invoice'],
    ['receipt', 'receipt'],
    ['other', 'other'],
  ])('rozpoznane %s zapisane jako %s', async (rozpoznany, zapisany) => {
    db.doc = { ...DOKUMENT, document_type: rozpoznany };
    await runProcessOcr({ ocrJobId: OCR_JOB, tenantId: TENANT }, ctx);
    expect(db.inserts).toHaveLength(1);
    expect(db.inserts[0]!.document_type).toBe(zapisany);
  });

  it('paragon z NIP z 2026 r.: odliczenie VAT i koszt KPiR jak dotąd', async () => {
    await runProcessOcr({ ocrJobId: OCR_JOB, tenantId: TENANT }, ctx);
    const row = db.inserts[0]!;
    expect(row.vat_deductible_amount).toBe(23);
    const rodzaj = costDocumentType({
      document_type: row.document_type as string,
      source: 'ocr_photo',
      ocr_extracted_data: row.ocr_extracted_data,
    });
    expect(rodzaj).toBe('simplified_invoice');
    expect(vatDeductionForDocument({ documentType: rodzaj, issueDate: row.issue_date as string, grossAmount: row.gross_amount as number }).deductible).toBe(true);
    expect(
      kpirCostAmount({
        net_amount: 100,
        vat_amount: 23,
        vat_deductible_amount: 23,
        document_type: row.document_type as string,
      }),
    ).toBe(100);
  });
});

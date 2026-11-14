import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * F-084 (audyt bloku 1): poprawka kategorii wydatku od sprzedawcy bez NIP
 * (paragon) zapisywała regułę `name_exact` — toast mówił „apka się
 * nauczyła” — ale silnik reguł czytał tylko reguły `nip` i `keyword`.
 * Następny paragon od tego sprzedawcy znów szedł przez heurystykę albo AI.
 */

type Rule = Record<string, unknown>;
const st = vi.hoisted(() => ({ rules: [] as Rule[], updates: [] as Rule[], ai: vi.fn() }));

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const filters: Array<[string, unknown]> = [];
      let op: 'select' | 'update' = 'select';
      let patch: Rule = {};
      // Reguły nazwy czytane stronami po `id` (sesja 29 planu skalowania).
      let afterId: string | null = null;
      let limit: number | undefined;
      const rows = () =>
        table === 'categorization_rules'
          ? st.rules
              .filter((r) => filters.every(([k, v]) => r[k] === v))
              .filter((r) => afterId === null || String(r.id) > afterId)
              .slice(0, limit)
          : [];
      const q = {
        select: () => q,
        not: () => q,
        gt: (_k: string, v: string) => { afterId = v; return q; },
        order: () => q,
        limit: (n: number) => { limit = n; return q; },
        update: (p: Rule) => { op = 'update'; patch = p; return q; },
        eq: (k: string, v: unknown) => { filters.push([k, v]); return q; },
        maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
        then: (ok: (v: unknown) => unknown, fail?: (e: unknown) => unknown) => {
          if (op === 'update') st.updates.push({ ...patch, filters });
          return Promise.resolve({ data: op === 'update' ? null : rows(), error: null }).then(ok, fail);
        },
      };
      return q;
    },
  }),
}));
vi.mock('@/lib/ai/tenant-ai-budget', () => ({
  checkTenantAiBudget: async () => ({ allowed: true }),
  recordTenantAiUsage: vi.fn(),
}));
vi.mock('@/lib/categorization/ai-classifier', () => ({ classifyByAI: st.ai }));

import { categorizeExpense } from '@/lib/categorization';
import type { ExtractedInvoice } from '@/lib/ocr/schema';

const paragon = (seller_name: string, gross_amount = 30): ExtractedInvoice =>
  ({ seller_name, seller_nip: null, gross_amount }) as unknown as ExtractedInvoice;

beforeEach(() => {
  st.rules = [];
  st.updates = [];
  st.ai.mockReset();
  st.ai.mockResolvedValue(null);
});

describe('reguła „nazwa sprzedawcy” (F-084)', () => {
  it('wydatek bez NIP od sprzedawcy z regułą dostaje kategorię z reguły', async () => {
    st.rules = [{
      id: 'r1', tenant_id: 'ten-1', match_type: 'name_exact', match_value: 'Kawiarnia Pod Lipą',
      kpir_column: 'col_13', category_label: 'Spotkania z klientami', hit_count: 2, min_amount: null, max_amount: null,
    }];
    const r = await categorizeExpense('ten-1', paragon('  kawiarnia   pod LIPĄ '));
    expect(r).toMatchObject({ kpir_column: 'col_13', category_label: 'Spotkania z klientami', method: 'learned' });
    expect(st.ai).not.toHaveBeenCalled();
    expect(st.updates).toEqual([expect.objectContaining({ hit_count: 3 })]);
  });

  it('reguła innej firmy nie działa', async () => {
    st.rules = [{
      id: 'r1', tenant_id: 'ten-2', match_type: 'name_exact', match_value: 'Kawiarnia Pod Lipą',
      kpir_column: 'col_13', category_label: 'Spotkania z klientami', hit_count: 0,
    }];
    const r = await categorizeExpense('ten-1', paragon('Kawiarnia Pod Lipą'));
    expect(r.category_label).not.toBe('Spotkania z klientami');
  });

  it('kwota poza widełkami reguły — reguła pomijana', async () => {
    st.rules = [{
      id: 'r1', tenant_id: 'ten-1', match_type: 'name_exact', match_value: 'Sklep Komputerowy',
      kpir_column: 'col_13', category_label: 'Drobne akcesoria', hit_count: 0, min_amount: 0, max_amount: 500,
    }];
    const r = await categorizeExpense('ten-1', paragon('Sklep Komputerowy', 8000));
    expect(r.category_label).not.toBe('Drobne akcesoria');
  });
});

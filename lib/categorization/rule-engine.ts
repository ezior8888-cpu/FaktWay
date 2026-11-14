// Warstwa 1: dopasowanie po NIP lub keyword (najszybsze, najpewniejsze)

import { createAdminClient } from '@/lib/supabase/admin';
import type { Database } from '@/types/database';

import type { CategorizationMethod } from './methods';

export { CATEGORIZATION_METHODS, type CategorizationMethod } from './methods';

export type KpirColumn = Database['public']['Enums']['kpir_column'];

export interface CategorizationResult {
  kpir_column: KpirColumn;
  category_label: string;
  confidence: number;
  method: CategorizationMethod;
}

function normalizeNip(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  return digits.length === 10 ? digits : null;
}

/**
 * Próbuj sklasyfikować po NIP. Sprawdza najpierw per-tenant rules (uczone),
 * potem globalną bazę. Zwraca null jeśli żadna reguła nie pasuje.
 */
export async function classifyByNip(
  tenantId: string,
  nip: string,
  /**
   * Kwota brutto dokumentu. Reguły agenta FLO mają widełki kwotowe
   * (migracja 00063): reguła nauczona na zakupie za 200 zł nie ma prawa
   * księgować sama laptopa za 8000. Wydatek poza widełkami zwraca `null`,
   * czyli spada do kolejnej warstwy i kończy się pytaniem do człowieka.
   */
  grossAmount?: number,
): Promise<CategorizationResult | null> {
  const normalized = normalizeNip(nip);
  if (!normalized) return null;

  const supabase = createAdminClient();

  const { data: tenantRule } = await supabase
    .from('categorization_rules')
    .select('id, hit_count, kpir_column, category_label, min_amount, max_amount')
    .eq('tenant_id', tenantId)
    .eq('match_type', 'nip')
    .eq('match_value', normalized)
    .maybeSingle();

  if (tenantRule && grossAmount !== undefined && !withinBounds(tenantRule, grossAmount)) {
    return null;
  }

  if (tenantRule) {
    await supabase
      .from('categorization_rules')
      .update({
        hit_count: (tenantRule.hit_count ?? 0) + 1,
        last_used_at: new Date().toISOString(),
      })
      .eq('id', tenantRule.id);

    return {
      kpir_column: tenantRule.kpir_column,
      category_label: tenantRule.category_label,
      confidence: 0.98,
      method: 'learned',
    };
  }

  const { data: globalRule } = await supabase
    .from('kpir_global_rules')
    .select('kpir_column, category_label')
    .eq('nip', normalized)
    .maybeSingle();

  if (globalRule) {
    return {
      kpir_column: globalRule.kpir_column,
      category_label: globalRule.category_label,
      confidence: 0.95,
      method: 'rule_global_nip',
    };
  }

  return null;
}

/**
 * Próbuj sklasyfikować po keyword w nazwie sprzedawcy.
 */
export async function classifyByKeyword(
  tenantId: string,
  sellerName: string
): Promise<CategorizationResult | null> {
  if (!sellerName.trim()) return null;

  const supabase = createAdminClient();
  const nameLower = sellerName.toLowerCase();

  const { data: tenantRules } = await supabase
    .from('categorization_rules')
    .select('match_value, kpir_column, category_label')
    .eq('tenant_id', tenantId)
    .eq('match_type', 'keyword');

  if (tenantRules?.length) {
    const sorted = [...tenantRules].sort(
      (a, b) => b.match_value.length - a.match_value.length
    );
    for (const rule of sorted) {
      const needle = rule.match_value.toLowerCase();
      if (needle && nameLower.includes(needle)) {
        return {
          kpir_column: rule.kpir_column,
          category_label: rule.category_label,
          confidence: 0.92,
          method: 'rule_keyword',
        };
      }
    }
  }

  const { data: globalRules } = await supabase
    .from('kpir_global_rules')
    .select('keyword, kpir_column, category_label')
    .not('keyword', 'is', null);

  if (globalRules?.length) {
    const sorted = [...globalRules].sort(
      (a, b) => (b.keyword?.length ?? 0) - (a.keyword?.length ?? 0)
    );
    for (const rule of sorted) {
      const kw = rule.keyword?.toLowerCase();
      if (kw && nameLower.includes(kw)) {
        return {
          kpir_column: rule.kpir_column,
          category_label: rule.category_label,
          confidence: 0.88,
          method: 'rule_global_keyword',
        };
      }
    }
  }

  return null;
}

/**
 * Czy kwota mieści się w widełkach reguły.
 *
 * Reguły sprzed migracji 00063 nie mają widełek (NULL po obu stronach)
 * i obowiązują jak dotąd — nie zmieniamy zachowania rzeczy, które działają.
 */
function withinBounds(
  rule: { min_amount?: number | null; max_amount?: number | null },
  grossAmount: number,
): boolean {
  const min = rule.min_amount ?? null;
  const max = rule.max_amount ?? null;
  if (min !== null && grossAmount < Number(min)) return false;
  if (max !== null && grossAmount > Number(max)) return false;
  return true;
}

// Warstwa 1b: reguła nauczona po nazwie sprzedawcy (`name_exact`)

import { readAllById } from '@/lib/pagination/keyset';
import { createAdminClient } from '@/lib/supabase/admin';

import type { CategorizationResult, KpirColumn } from './rule-engine';

interface NameRule {
  id: string;
  match_value: string;
  hit_count: number | null;
  kpir_column: KpirColumn;
  category_label: string;
  min_amount: number | string | null;
  max_amount: number | string | null;
}

/** Nazwa sprzedawcy do porównań: bez wielkości liter i nadmiarowych spacji. */
function normalizeSellerName(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toLocaleLowerCase('pl-PL');
}

/**
 * Reguła nauczona po nazwie sprzedawcy (`name_exact`) — zapisuje ją poprawka
 * kategorii wydatku bez NIP (`learnFromCorrection`), np. paragonu. Do
 * 02.10.2026 nikt jej nie czytał, choć użytkownik słyszał „apka się
 * nauczyła” (F-084). Porównanie po znormalizowanej nazwie (reguły zapisane
 * wcześniej mają surową nazwę), widełki kwot jak przy regule NIP.
 */
export async function classifyByExactName(
  tenantId: string,
  sellerName: string,
  grossAmount?: number,
): Promise<CategorizationResult | null> {
  const wanted = normalizeSellerName(sellerName);
  if (!wanted) return null;

  const supabase = createAdminClient();
  // Sesja 29 planu skalowania: wszystkie reguły stronami po `id`. Jedno
  // zapytanie oddawało najwyżej 1000 wierszy (`PGRST_DB_MAX_ROWS`) bez
  // błędu, więc reguła spoza tego kawałka nie działała. Błąd odczytu dalej
  // znaczy „brak reguły” (dalsze warstwy), jak przed zmianą: kategoryzacja
  // idzie w jobie OCR przed zapisem wydatku, a wyjątek ponowiłby płatny OCR.
  let rules: NameRule[];
  try {
    rules = await readAllById<NameRule>('reguły nazwy sprzedawcy', (afterId, limit) => {
      let query = supabase
        .from('categorization_rules')
        .select('id, match_value, hit_count, kpir_column, category_label, min_amount, max_amount')
        .eq('tenant_id', tenantId)
        .eq('match_type', 'name_exact');
      if (afterId) query = query.gt('id', afterId);
      return query.order('id', { ascending: true }).limit(limit);
    });
  } catch {
    return null;
  }

  const rule = rules.find((r) => normalizeSellerName(r.match_value) === wanted);
  if (!rule) return null;
  if (grossAmount !== undefined) {
    if (rule.min_amount != null && grossAmount < Number(rule.min_amount)) return null;
    if (rule.max_amount != null && grossAmount > Number(rule.max_amount)) return null;
  }

  await supabase
    .from('categorization_rules')
    .update({
      hit_count: (rule.hit_count ?? 0) + 1,
      last_used_at: new Date().toISOString(),
    })
    .eq('id', rule.id);

  return {
    kpir_column: rule.kpir_column,
    category_label: rule.category_label,
    confidence: 0.96,
    method: 'learned',
  };
}

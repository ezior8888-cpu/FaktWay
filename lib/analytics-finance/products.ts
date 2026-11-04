import { rankProducts, type ProductLine } from '@/lib/dashboard/rankings';

import { topWithOther, type BreakdownSlice } from './breakdown';

/**
 * „Sprzedaż według produktów” i „Najlepsze produkty i usługi” (plan Finora
 * P11 ← Spend by Category / Top Categories). Pozycje z `fetchProductLines`
 * (§2.4 pkt 13: tylko faktury `regular` i `final`, bez korekt i zaliczek),
 * grupowane przez `rankProducts` (nazwa + j.m.), top `limit` + „Pozostałe”
 * jako SUMA pozostałych grup.
 */

export const OTHER_PRODUCTS_LABEL = 'Pozostałe';

export function productBreakdown(lines: readonly ProductLine[], limit = 5): BreakdownSlice[] {
  const all = rankProducts(lines, Number.POSITIVE_INFINITY);
  return topWithOther(
    all.map((p) => ({ key: p.key, label: p.unit ? `${p.name} (${p.unit})` : p.name, amount: p.net })),
    limit,
    OTHER_PRODUCTS_LABEL,
  );
}

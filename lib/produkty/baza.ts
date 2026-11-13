import type { ProductListItem } from '@/lib/produkty/model';

/**
 * Odczyt katalogu produktów klientem z sesji (RLS 00013 zawęża do firmy, a
 * zapytanie filtruje jeszcze `tenant_id`). PostgREST ucina odpowiedź do 1000
 * wierszy bez błędu, więc lista idzie stronami po `count: 'exact'`; błąd albo
 * niepełna strona rzuca (częściowa lista to nie „brak produktów”).
 * Sortowanie jak autocomplete: `last_used_at` malejąco (puste na końcu),
 * `use_count` malejąco, `id` dla stabilności stron.
 */

export const PRODUCTS_PAGE_SIZE = 500;
/** Pułap bezpieczeństwa: 100 tys. wierszy; więcej to błąd, nie ciche ucięcie. */
const MAX_PAGES = 200;

export const PRODUCT_COLUMNS =
  'id, name, unit, default_price_net, default_vat_rate, pkwiu_code, gtu_code, description, is_archived, use_count, last_used_at';

interface ProductRow {
  id: string;
  name: string;
  unit: string;
  default_price_net: number | string | null;
  default_vat_rate: string;
  pkwiu_code: string | null;
  gtu_code: string | null;
  description: string | null;
  is_archived: boolean;
  use_count: number | null;
  last_used_at: string | null;
}

/** Minimalny kształt klienta: wystarczy `from(...)` z łańcuchem zapytania. */
interface QueryLike {
  select: (cols: string, opts?: { count: 'exact' }) => QueryLike;
  eq: (col: string, value: unknown) => QueryLike;
  ilike: (col: string, pattern: string) => QueryLike;
  order: (col: string, opts?: { ascending?: boolean; nullsFirst?: boolean }) => QueryLike;
  range: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: unknown[] | null; count: number | null; error: { message: string } | null }>;
}
interface ClientLike {
  from: (table: string) => unknown;
}

function price(value: number | string | null): number | null {
  if (value === null) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function toItem(r: ProductRow): ProductListItem {
  return {
    id: r.id,
    name: r.name,
    unit: r.unit,
    defaultPriceNet: price(r.default_price_net),
    defaultVatRate: r.default_vat_rate,
    pkwiuCode: r.pkwiu_code,
    gtuCode: r.gtu_code,
    description: r.description,
    isArchived: r.is_archived,
    useCount: r.use_count ?? 0,
    lastUsedAt: r.last_used_at,
  };
}

/** Fraza szukania do `ilike`: bez znaków specjalnych PostgREST i wzorca. */
function likePattern(q: string): string {
  const clean = q.replace(/[,()"\\%*_]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
  return `%${clean}%`;
}

export async function listProducts(
  client: unknown,
  tenantId: string,
  opts: { q: string; archived: boolean },
): Promise<ProductListItem[]> {
  const db = client as ClientLike;
  const rows: ProductRow[] = [];
  const seen = new Set<string>();
  let total: number | null = null;

  for (let page = 0; total === null || page * PRODUCTS_PAGE_SIZE < total; page += 1) {
    if (page >= MAX_PAGES) throw new Error('produkty: lista przekracza dopuszczalny rozmiar');
    const from = page * PRODUCTS_PAGE_SIZE;
    let query = (db.from('products') as QueryLike)
      .select(PRODUCT_COLUMNS, { count: 'exact' })
      .eq('tenant_id', tenantId)
      .eq('is_archived', opts.archived);
    if (opts.q.trim()) query = query.ilike('name', likePattern(opts.q));
    const res = await query
      .order('last_used_at', { ascending: false, nullsFirst: false })
      .order('use_count', { ascending: false })
      .order('id', { ascending: true })
      .range(from, from + PRODUCTS_PAGE_SIZE - 1);

    if (res.error) throw new Error(`produkty: ${res.error.message}`);
    if (!res.data || typeof res.count !== 'number' || res.count < 0 || (total !== null && res.count !== total)) {
      throw new Error('produkty: nie można potwierdzić liczby rekordów');
    }
    total = res.count;
    if (res.data.length !== Math.min(PRODUCTS_PAGE_SIZE, Math.max(0, total - from))) {
      throw new Error('produkty: niepełna strona danych');
    }
    for (const row of res.data as ProductRow[]) {
      if (seen.has(row.id)) continue; // zmiana między stronami nie dubluje wiersza
      seen.add(row.id);
      rows.push(row);
    }
  }
  return rows.map(toItem);
}

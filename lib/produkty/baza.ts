import {
  isProductVatRate,
  PRODUCT_SUGGESTIONS_LIMIT,
  PRODUCT_SUGGESTIONS_MIN_QUERY,
  type ProductListItem,
  type ProductSuggestion,
} from '@/lib/produkty/model';

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

/** Fraza szukania bez znaków specjalnych PostgREST i wzorca `ilike`. */
function cleanPhrase(q: string): string {
  return q.replace(/[,()"\\%*_]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
}

/** Fraza szukania do `ilike`: bez znaków specjalnych PostgREST i wzorca. */
function likePattern(q: string): string {
  return `%${cleanPhrase(q)}%`;
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

/** Ilu kandydatów z bazy układamy, zanim lista utnie się do `PRODUCT_SUGGESTIONS_LIMIT`. */
const SUGGESTION_CANDIDATES = 50;

interface SuggestQueryLike {
  select: (cols: string) => SuggestQueryLike;
  eq: (col: string, value: unknown) => SuggestQueryLike;
  ilike: (col: string, pattern: string) => SuggestQueryLike;
  order: (col: string, opts?: { ascending?: boolean; nullsFirst?: boolean }) => SuggestQueryLike;
  limit: (n: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;
}

type SuggestionRow = Pick<ProductRow, 'id' | 'name' | 'unit' | 'default_price_net' | 'default_vat_rate'>;

/** 0: nazwa zaczyna się od frazy, 1: któreś słowo nazwy zaczyna się od frazy, 2: fraza w środku słowa. */
function suggestionRank(name: string, phrase: string): number {
  const n = name.toLocaleLowerCase('pl');
  const p = phrase.toLocaleLowerCase('pl');
  if (n.startsWith(p)) return 0;
  return n.split(/[\s,.;:()/-]+/).some((word) => word.startsWith(p)) ? 1 : 2;
}

/**
 * Podpowiedź produktów przy nazwie pozycji faktury (plan kompletnej aplikacji,
 * krok 2.6, część 2a): aktywne produkty firmy, których nazwa zawiera frazę.
 * Kolejność: nazwa od frazy, słowo od frazy, reszta; w każdej grupie jak na
 * liście katalogu (ostatnio używane, częściej używane), potem nazwa. Fraza
 * krótsza niż `PRODUCT_SUGGESTIONS_MIN_QUERY` po usunięciu znaków wzorca nie
 * pyta bazy. Błąd bazy rzuca (pusta lista to nie „brak produktów”).
 */
export async function suggestProducts(client: unknown, tenantId: string, q: string): Promise<ProductSuggestion[]> {
  const phrase = cleanPhrase(q);
  if (phrase.length < PRODUCT_SUGGESTIONS_MIN_QUERY) return [];
  const db = client as ClientLike;
  const res = await (db.from('products') as SuggestQueryLike)
    .select('id, name, unit, default_price_net, default_vat_rate')
    .eq('tenant_id', tenantId)
    .eq('is_archived', false)
    .ilike('name', `%${phrase}%`)
    .order('last_used_at', { ascending: false, nullsFirst: false })
    .order('use_count', { ascending: false })
    .order('name', { ascending: true })
    .limit(SUGGESTION_CANDIDATES);
  if (res.error) throw new Error(`produkty: ${res.error.message}`);

  return ((res.data ?? []) as SuggestionRow[])
    .map((row, order) => ({ row, order, rank: suggestionRank(row.name, phrase) }))
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .slice(0, PRODUCT_SUGGESTIONS_LIMIT)
    .map(({ row }) => ({
      id: row.id,
      name: row.name,
      unit: row.unit,
      priceNet: price(row.default_price_net),
      vatRate: isProductVatRate(row.default_vat_rate) ? row.default_vat_rate : null,
    }));
}

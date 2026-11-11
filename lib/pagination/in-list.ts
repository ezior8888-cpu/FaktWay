/**
 * Odczyt po liście wartości z wejścia — pliku importu, listy numerów
 * (sesja 32 planu skalowania, F-089).
 *
 * Po co: filtr `.in('kolumna', lista)` trafia do adresu GET. Lista z pliku
 * importu (1500 numerów faktur) to adres ok. 35 tys. znaków, a bramka
 * (Kong/nginx: domyślnie 8 KB na wiersz żądania; postgrest-js ostrzega od
 * 8000 znaków) go odrzuca. Do tego produkcja ucina każdą odpowiedź do 1000
 * wierszy (`PGRST_DB_MAX_ROWS`) bez błędu, więc paczka, która dopasuje
 * więcej wierszy, po cichu by je zgubiła.
 *
 * Jak: lista bez powtórzeń idzie paczkami — najwyżej 100 wartości i najwyżej
 * 4000 znaków po zakodowaniu w adresie (numer faktury z pliku bywa długi,
 * a polska litera to 6 znaków w adresie). Każdą paczkę czyta
 * `forEachPageById` stronami po `id`, z tymi samymi gwarancjami: błąd albo
 * niepewna odpowiedź to wyjątek `KeysetPageError`, nigdy częściowa lista.
 *
 * Wywołujący buduje zapytanie strony dla paczki (świeży builder za każdym
 * razem, jak w `keyset.ts`):
 *
 *   (values, afterId, limit) => {
 *     let query = client.from('invoices').select('id, internal_number')
 *       .eq('tenant_id', tenantId).in('internal_number', values);
 *     if (afterId) query = query.gt('id', afterId);
 *     return query.order('id', { ascending: true }).limit(limit);
 *   }
 *
 * Koszt: każda paczka kończy się pustą stroną (+1 zapytanie), więc 1500
 * wartości to co najmniej 30 zapytań. Paczki idą po kolei.
 *
 * Bez importów `@/…` i bez `server-only` (skrypty, jak `keyset.ts`).
 */

import { forEachPageById, type KeysetOptions, type KeysetPage } from './keyset';

/** Najwięcej wartości w jednym `.in()` (jak `LOOKUP_CHUNK` w innych modułach). */
export const IN_LIST_MAX_VALUES = 100;

/** Najwięcej znaków listy wartości w adresie po zakodowaniu — połowa progu bramki. */
export const IN_LIST_MAX_CHARS = 4000;

/** Przecinek między wartościami w adresie (`%2C`). */
const SEPARATOR_CHARS = 3;

export interface InListOptions {
  /** Domyślnie 100. */
  maxValues?: number;
  /** Domyślnie 4000. */
  maxChars?: number;
}

/**
 * Długość wartości w adresie w najgorszym przypadku: w cudzysłowie
 * (postgrest-js cytuje wartość z `,`, `(` albo `)`) i zakodowana jak
 * parametr formularza (`URLSearchParams`, którego używa postgrest-js).
 */
function encodedLength(value: string): number {
  return new URLSearchParams({ v: `"${value}"` }).toString().length - 'v='.length;
}

/**
 * Lista bez powtórzeń (kolejność pierwszego wystąpienia) w paczkach po
 * najwyżej `maxValues` wartości i `maxChars` znaków w adresie. Wartość
 * dłuższa niż `maxChars` dostaje własną paczkę (nie da się jej podzielić).
 */
export function inListChunks(values: readonly string[], options: InListOptions = {}): string[][] {
  const maxValues = options.maxValues ?? IN_LIST_MAX_VALUES;
  const maxChars = options.maxChars ?? IN_LIST_MAX_CHARS;
  if (!Number.isInteger(maxValues) || maxValues < 1) throw new RangeError(`paczka ${maxValues} wartości musi być dodatnią liczbą całkowitą`);
  if (!Number.isInteger(maxChars) || maxChars < 1) throw new RangeError(`paczka ${maxChars} znaków musi być dodatnią liczbą całkowitą`);

  const chunks: string[][] = [];
  let current: string[] = [];
  let chars = 0;
  for (const value of new Set(values)) {
    const length = encodedLength(value);
    if (current.length > 0 && (current.length >= maxValues || chars + SEPARATOR_CHARS + length > maxChars)) {
      chunks.push(current);
      current = [];
      chars = 0;
    }
    chars += (current.length > 0 ? SEPARATOR_CHARS : 0) + length;
    current.push(value);
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** Zapytanie o stronę jednej paczki: wiersze z wartością z `values` i `id > afterId`, rosnąco po `id`, najwyżej `limit`. */
export type InListFetchPage<T> = (values: string[], afterId: string | null, limit: number) => PromiseLike<KeysetPage<T>>;

/**
 * Wszystkie wiersze pasujące do listy wartości: paczki z `inListChunks`,
 * każda stronami po `id`. Pusta lista = żadnego zapytania. Wiersz o tym
 * samym `id` z dwóch paczek (wartość zmieniła się między zapytaniami)
 * liczy się raz.
 */
export async function readAllByIdInList<T extends { id: string }>(
  label: string,
  values: readonly string[],
  fetchPage: InListFetchPage<T>,
  options: KeysetOptions & InListOptions = {},
): Promise<T[]> {
  const { pageSize, maxPages, maxValues, maxChars } = options;
  const all: T[] = [];
  const seen = new Set<string>();
  for (const chunk of inListChunks(values, { maxValues, maxChars })) {
    await forEachPageById(label, (afterId, limit) => fetchPage(chunk, afterId, limit), (rows) => {
      for (const row of rows) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        all.push(row);
      }
    }, { pageSize, maxPages });
  }
  return all;
}

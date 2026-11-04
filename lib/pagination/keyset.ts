/**
 * Pełny odczyt listy stronami po kluczu (sesja 27 planu skalowania, JOB-11).
 *
 * Po co: produkcja ma `PGRST_DB_MAX_ROWS` = 1000. PostgREST ucina każdą
 * odpowiedź do 1000 wierszy BEZ błędu — zapytanie bez stron oddaje
 * `data.length === 1000`, `error === null`. Crony i skrypty, które czytały
 * całą listę firm jednym zapytaniem, od ok. 1000 firm po cichu pomijały
 * resztę.
 *
 * Jak: wywołujący buduje zapytanie strony (świeży builder za każdym razem —
 * builder supabase-js dopisuje filtry do siebie, więc drugie `.gt()` na tym
 * samym obiekcie nałożyłoby się na pierwsze):
 *
 *   (afterId, limit) => {
 *     let query = client.from('tenants').select('id, nip').eq(…);
 *     if (afterId) query = query.gt('id', afterId);
 *     return query.order('id', { ascending: true }).limit(limit);
 *   }
 *
 * Helper pilnuje, żeby „nie wiem” nie zamieniło się w „nie ma”:
 *   - błąd strony albo odpowiedź bez danych (`data: null`) → wyjątek
 *     z etykietą (nigdy częściowa lista),
 *   - strona dłuższa niż `limit` → wyjątek (zapytanie zignorowało limit),
 *   - identyfikatory ściśle rosnące, także względem kursora → inaczej
 *     wyjątek (brak `order('id')` albo zignorowane `gt('id')` — bez tego
 *     pętla kręciłaby się w miejscu),
 *   - koniec TYLKO na pustej stronie, nie na krótkiej: krótsza strona
 *     znaczy też „serwer uciął” (gdyby `PGRST_DB_MAX_ROWS` spadło poniżej
 *     rozmiaru strony), więc pytamy dalej; kosztuje to jedno zapytanie
 *     na przebieg,
 *   - więcej niż `maxPages` niepustych stron → wyjątek, nie ciche ucięcie.
 *
 * Klucz: `id` typu uuid. Postgres porównuje uuid bajtowo, co odpowiada
 * porównaniu napisów z małymi literami hex w JS — tym samym, którym helper
 * sprawdza kolejność. Dla kluczy liczbowych albo tekstowych z kolacją
 * helper się nie nadaje (rzuci „identyfikatory nie rosną”).
 *
 * Bez importów `@/…` i bez `server-only`: skrypty w `scripts/` importują
 * `lib/` ścieżką względną.
 *
 * Nie mylić z `readCompletePages` (`lib/accounting/read-complete-pages.ts`):
 * tamten to OFFSET + `count: 'exact'` dla odczytów jednej firmy i rzuca, gdy
 * zbiór zmieni się między stronami — w cronie na żywej liście firm to by
 * wywracało cały przebieg.
 */

/** Limit wierszy odpowiedzi PostgREST na produkcji (`PGRST_DB_MAX_ROWS`). */
export const POSTGREST_MAX_ROWS = 1000;

/** Domyślny i największy rozmiar strony — połowa limitu serwera. */
export const KEYSET_PAGE_SIZE = 500;

/** Domyślny pułap niepustych stron (500 tys. wierszy przy stronie 500). */
export const KEYSET_MAX_PAGES = 1000;

export interface KeysetPage<T> {
  data: T[] | null;
  error: { message: string } | null;
}

/** Zapytanie o jedną stronę: wiersze o `id > afterId` (bez kursora — od początku), rosnąco po `id`, najwyżej `limit`. */
export type KeysetFetchPage<T> = (afterId: string | null, limit: number) => PromiseLike<KeysetPage<T>>;

export interface KeysetOptions {
  /** 1–500, domyślnie 500. */
  pageSize?: number;
  /** Domyślnie 1000. */
  maxPages?: number;
}

/**
 * Błąd odczytu stronami: błąd bazy albo odpowiedź, której nie da się uznać
 * za pełną. `reason` — sam powód, bez etykiety (do własnych komunikatów).
 */
export class KeysetPageError extends Error {
  constructor(readonly label: string, readonly reason: string) {
    super(`${label}: ${reason}`);
    this.name = 'KeysetPageError';
  }
}

function checkOptions(label: string, options: KeysetOptions): { pageSize: number; maxPages: number } {
  const pageSize = options.pageSize ?? KEYSET_PAGE_SIZE;
  const maxPages = options.maxPages ?? KEYSET_MAX_PAGES;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > KEYSET_PAGE_SIZE) {
    throw new KeysetPageError(label, `rozmiar strony ${pageSize} spoza 1–${KEYSET_PAGE_SIZE}`);
  }
  if (!Number.isInteger(maxPages) || maxPages < 1) {
    throw new KeysetPageError(label, `pułap stron ${maxPages} musi być dodatnią liczbą całkowitą`);
  }
  return { pageSize, maxPages };
}

/**
 * Czyta wszystkie wiersze stronami po `id` i oddaje każdą stronę `onPage`,
 * zanim zapyta o następną (pamięć: jedna strona naraz). Wyjątek z `onPage`
 * przerywa odczyt.
 */
export async function forEachPageById<T extends { id: string }>(
  label: string,
  fetchPage: KeysetFetchPage<T>,
  onPage: (rows: T[]) => void | Promise<void>,
  options: KeysetOptions = {},
): Promise<{ pages: number; rows: number }> {
  const { pageSize, maxPages } = checkOptions(label, options);
  let afterId: string | null = null;
  let pages = 0;
  let rows = 0;

  for (;;) {
    const page = await fetchPage(afterId, pageSize);
    if (page.error) throw new KeysetPageError(label, page.error.message);
    // `data: null` bez błędu (np. pusta treść odpowiedzi pośrednika) to nie
    // „pusta strona” — nie wiadomo, czy lista się skończyła.
    if (!Array.isArray(page.data)) throw new KeysetPageError(label, 'odpowiedź bez danych i bez błędu — nie wiadomo, czy to koniec listy');
    const data = page.data;
    if (data.length === 0) return { pages, rows };
    if (data.length > pageSize) {
      throw new KeysetPageError(label, `strona ma ${data.length} wierszy przy limicie ${pageSize} (zapytanie bez limit?)`);
    }
    let previous: string | null = afterId;
    for (const row of data) {
      if (typeof row.id !== 'string' || row.id === '' || (previous !== null && row.id <= previous)) {
        throw new KeysetPageError(
          label,
          `identyfikatory nie rosną po ${previous ?? 'początku'} (zapytanie bez order('id') albo bez gt('id'))`,
        );
      }
      previous = row.id;
    }
    if (pages >= maxPages) {
      throw new KeysetPageError(label, `ponad ${maxPages} stron po ${pageSize} wierszy — odczyt przerwany, lista niepełna`);
    }
    pages += 1;
    rows += data.length;
    await onPage(data);
    afterId = previous;
  }
}

/** Jak `forEachPageById`, ale zbiera wszystkie wiersze do jednej tablicy. */
export async function readAllById<T extends { id: string }>(
  label: string,
  fetchPage: KeysetFetchPage<T>,
  options: KeysetOptions = {},
): Promise<T[]> {
  const all: T[] = [];
  await forEachPageById(label, fetchPage, (rows) => { all.push(...rows); }, options);
  return all;
}

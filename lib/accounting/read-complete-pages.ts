/** PostgREST may cap a successful response. A partial accounting read is an error. */
export const ACCOUNTING_PAGE_SIZE = 500;

type Page<T> = {
  data: T[] | null;
  count: number | null;
  error: { message: string } | null;
};

export async function readCompletePages<T extends { id: string }>(
  label: string,
  fetchPage: (from: number, to: number) => PromiseLike<Page<T>>,
): Promise<T[]> {
  const rows: T[] = [];
  let total: number | null = null;
  let lastId: string | null = null;

  for (let from = 0; total === null || from < total; from += ACCOUNTING_PAGE_SIZE) {
    const page = await fetchPage(from, from + ACCOUNTING_PAGE_SIZE - 1);
    if (page.error) throw new Error(`${label}: ${page.error.message}`);
    if (!page.data || typeof page.count !== 'number' ||
        !Number.isSafeInteger(page.count) || page.count < 0 ||
        (total !== null && page.count !== total)) {
      throw new Error(`${label}: nie można potwierdzić liczby rekordów`);
    }
    total = page.count;
    if (page.data.length !== Math.min(ACCOUNTING_PAGE_SIZE, Math.max(0, total - from))) {
      throw new Error(`${label}: niepełna strona danych`);
    }
    for (const row of page.data) {
      // Callers page by immutable id; a duplicate/reordered row must not be
      // counted twice as a different invoice or cost.
      if (typeof row.id !== 'string' || !row.id ||
          (lastId !== null && row.id <= lastId)) {
        throw new Error(`${label}: niestabilna kolejność stron danych`);
      }
      rows.push(row);
      lastId = row.id;
    }
  }

  return rows;
}

/** Strona odczytu po kluczu: `count` tylko tam, gdzie zapytanie go prosiło. */
type KeysetPage<T> = {
  data: T[] | null;
  count?: number | null;
  error: { message: string } | null;
};

/**
 * Zapytanie strony dla `readCompletePagesByKey`. Za każdym razem świeży
 * builder z tymi samymi filtrami:
 * `select(kolumny, count ? { count: 'exact', head } : undefined)`, potem
 * `gt('id', afterId)` przy `afterId !== null`, `order('id')` i `limit(limit)`.
 */
export type KeysetPageQuery = {
  afterId: string | null;
  limit: number;
  /** `count: 'exact'` — pierwsza strona i licznik kontrolny. */
  count: boolean;
  /** Sam licznik, bez wierszy (licznik kontrolny po kilku stronach). */
  head: boolean;
};

const validCount = (count: number | null | undefined): count is number =>
  typeof count === 'number' && Number.isSafeInteger(count) && count >= 0;

/**
 * To samo co `readCompletePages` — komplet wierszy albo błąd — taniej przy
 * kilku stronach (QRY-07, sesja 19 planu skalowania): `count` liczy baza
 * tylko przy pierwszej stronie, kolejne strony idą po kluczu
 * (`id > ostatni`, bez OFFSET), a przy więcej niż jednej stronie na końcu
 * jeden licznik kontrolny (`head`). `readCompletePages` liczy COUNT nad
 * całym filtrem przy KAŻDEJ stronie i przewija OFFSET-em; zostaje bez zmian
 * dla KPiR i eksportów, dopóki ich nie przeniesie osobna sesja z testami.
 *
 * Bezpieczniki (te same komunikaty co w `readCompletePages`):
 * - błąd strony → `${label}: <treść błędu>`;
 * - brak liczby rekordów na pierwszej stronie albo w liczniku kontrolnym, albo
 *   licznik kontrolny inny niż pierwszy (zapis w trakcie odczytu) →
 *   „nie można potwierdzić liczby rekordów”;
 * - strona krótsza albo dłuższa niż brakuje do licznika (cichy limit wierszy
 *   serwera, usunięcie w trakcie odczytu) → „niepełna strona danych”;
 * - id nie rosną (zignorowane `gt` albo `order`) → „niestabilna kolejność
 *   stron danych”.
 *
 * Jedna strona to jedna migawka: licznik i wiersze przychodzą w tej samej
 * odpowiedzi, więc licznika kontrolnego wtedy nie ma.
 */
export async function readCompletePagesByKey<T extends { id: string }>(
  label: string,
  fetchPage: (page: KeysetPageQuery) => PromiseLike<KeysetPage<T>>,
): Promise<T[]> {
  const rows: T[] = [];
  let total: number | null = null;
  let lastId: string | null = null;
  let pages = 0;

  while (total === null || rows.length < total) {
    const page = await fetchPage({ afterId: lastId, limit: ACCOUNTING_PAGE_SIZE, count: total === null, head: false });
    pages += 1;
    if (page.error) throw new Error(`${label}: ${page.error.message}`);
    if (!page.data || (total === null && !validCount(page.count))) {
      throw new Error(`${label}: nie można potwierdzić liczby rekordów`);
    }
    if (total === null) total = page.count as number;
    if (page.data.length !== Math.min(ACCOUNTING_PAGE_SIZE, total - rows.length)) {
      throw new Error(`${label}: niepełna strona danych`);
    }
    for (const row of page.data) {
      if (typeof row.id !== 'string' || !row.id ||
          (lastId !== null && row.id <= lastId)) {
        throw new Error(`${label}: niestabilna kolejność stron danych`);
      }
      rows.push(row);
      lastId = row.id;
    }
  }

  if (pages > 1) {
    const check = await fetchPage({ afterId: null, limit: ACCOUNTING_PAGE_SIZE, count: true, head: true });
    if (check.error) throw new Error(`${label}: ${check.error.message}`);
    if (!validCount(check.count) || check.count !== total) {
      throw new Error(`${label}: nie można potwierdzić liczby rekordów`);
    }
  }

  return rows;
}

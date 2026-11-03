import { describe, expect, it } from 'vitest';

import { readCompletePagesByKey, type KeysetPageQuery } from '@/lib/accounting/read-complete-pages';
import { fakePostgrest } from '@/lib/demo/fake-postgrest';

/**
 * `readCompletePagesByKey` (sesja 19 planu skalowania, QRY-07): komplet
 * wierszy albo błąd, jak `readCompletePages`, ale `count` liczy baza tylko
 * przy pierwszej stronie, kolejne strony idą po kluczu (`id > ostatni`),
 * a po kilku stronach jest jeden licznik kontrolny.
 */

type Row = { id: string };

const id = (i: number) => `row-${String(i).padStart(5, '0')}`;
const rowsOf = (n: number): Row[] => Array.from({ length: n }, (_, i) => ({ id: id(i) }));

/** Źródło stron po kluczu z zapamiętanymi zapytaniami; `zmiana` modyfikuje dane przed zapytaniem nr N. */
function source(initial: Row[], zmiana?: { przed: number; rows: (rows: Row[]) => Row[] }) {
  let rows = initial;
  const queries: KeysetPageQuery[] = [];
  const fetchPage = (q: KeysetPageQuery) => {
    if (zmiana && queries.length === zmiana.przed) rows = zmiana.rows(rows);
    queries.push(q);
    const after = rows.filter((r) => q.afterId === null || r.id > q.afterId);
    return Promise.resolve({
      data: q.head ? null : after.slice(0, q.limit),
      count: q.count ? rows.length : null,
      error: null,
    });
  };
  return { fetchPage, queries };
}

describe('readCompletePagesByKey', () => {
  it('zero wierszy: jedno zapytanie z licznikiem', async () => {
    const { fetchPage, queries } = source([]);
    await expect(readCompletePagesByKey('faktury', fetchPage)).resolves.toEqual([]);
    expect(queries).toEqual([{ afterId: null, limit: 500, count: true, head: false }]);
  });

  it('dokładnie 500 wierszy: jedna strona, bez licznika kontrolnego (licznik i wiersze z jednej odpowiedzi)', async () => {
    const { fetchPage, queries } = source(rowsOf(500));
    expect(await readCompletePagesByKey('faktury', fetchPage)).toHaveLength(500);
    expect(queries).toHaveLength(1);
  });

  it('1001 wierszy: licznik tylko na pierwszej stronie, dalej po kluczu, na końcu jeden licznik kontrolny', async () => {
    const all = rowsOf(1001);
    const { fetchPage, queries } = source(all);
    expect(await readCompletePagesByKey('faktury', fetchPage)).toEqual(all);
    expect(queries).toEqual([
      { afterId: null, limit: 500, count: true, head: false },
      { afterId: id(499), limit: 500, count: false, head: false },
      { afterId: id(999), limit: 500, count: false, head: false },
      { afterId: null, limit: 500, count: true, head: true },
    ]);
  });

  it('1000 wierszy: bez pustej strony na końcu', async () => {
    const { fetchPage, queries } = source(rowsOf(1000));
    expect(await readCompletePagesByKey('faktury', fetchPage)).toHaveLength(1000);
    expect(queries.map((q) => q.head)).toEqual([false, false, true]);
  });

  it('serwer ucina odpowiedź poniżej rozmiaru strony — błąd, nie cichy brak', async () => {
    await expect(readCompletePagesByKey('faktury', () => Promise.resolve({
      data: rowsOf(400),
      count: 600,
      error: null,
    }))).rejects.toThrow('faktury: niepełna strona danych');
  });

  it('brak liczby rekordów na pierwszej stronie', async () => {
    await expect(readCompletePagesByKey('faktury', () => Promise.resolve({ data: rowsOf(3), count: null, error: null })))
      .rejects.toThrow('faktury: nie można potwierdzić liczby rekordów');
    await expect(readCompletePagesByKey('faktury', () => Promise.resolve({ data: null, count: 3, error: null })))
      .rejects.toThrow('faktury: nie można potwierdzić liczby rekordów');
  });

  it('błąd strony i błąd licznika kontrolnego idą z etykietą', async () => {
    await expect(readCompletePagesByKey('faktury', () => Promise.resolve({ data: null, count: null, error: { message: 'timeout' } })))
      .rejects.toThrow('faktury: timeout');
    const { fetchPage } = source(rowsOf(700));
    await expect(readCompletePagesByKey('faktury', (q) => (q.head
      ? Promise.resolve({ data: null, count: null, error: { message: 'timeout' } })
      : fetchPage(q)))).rejects.toThrow('faktury: timeout');
  });

  it('wiersz dopisany w przeczytanej części w trakcie odczytu — licznik kontrolny się nie zgadza', async () => {
    const { fetchPage } = source(rowsOf(700), { przed: 2, rows: (rows) => [{ id: 'row-00000a' }, ...rows].sort((a, b) => (a.id < b.id ? -1 : 1)) });
    await expect(readCompletePagesByKey('faktury', fetchPage)).rejects.toThrow('faktury: nie można potwierdzić liczby rekordów');
  });

  it('wiersz dopisany w nieprzeczytanej części — ostatnia strona dłuższa niż brakuje do licznika', async () => {
    const { fetchPage } = source(rowsOf(700), { przed: 1, rows: (rows) => [...rows, { id: 'row-99999' }] });
    await expect(readCompletePagesByKey('faktury', fetchPage)).rejects.toThrow('faktury: niepełna strona danych');
  });

  it('wiersz usunięty w nieprzeczytanej części — strona krótsza', async () => {
    const { fetchPage } = source(rowsOf(700), { przed: 1, rows: (rows) => rows.filter((r) => r.id !== id(650)) });
    await expect(readCompletePagesByKey('faktury', fetchPage)).rejects.toThrow('faktury: niepełna strona danych');
  });

  it('zignorowany kursor (ta sama strona drugi raz) — niestabilna kolejność', async () => {
    const all = rowsOf(700);
    await expect(readCompletePagesByKey('faktury', (q) => Promise.resolve({
      data: q.afterId === null ? all.slice(0, 500) : all.slice(300, 500),
      count: q.count ? 700 : null,
      error: null,
    }))).rejects.toThrow('faktury: niestabilna kolejność stron danych');
  });

  it('atrapa PostgREST (tryb „przykład” na produkcji): strony po kluczu z tekstowym `gt`', async () => {
    // Identyfikatory danych przykładowych to napisy (`f-10-3`), nie uuid — porządek tekstowy jak w atrapie.
    const tabela = Array.from({ length: 1234 }, (_, i) => ({ id: `f-${(i * 7919) % 1234}-x`, firma: 'a' }));
    const client = fakePostgrest({ invoices: tabela });
    const rows = await readCompletePagesByKey<{ id: string }>('faktury', ({ afterId, limit, count, head }) => {
      let query = client.from('invoices').select('id', count ? { count: 'exact', head } : undefined).eq('firma', 'a');
      if (afterId !== null) query = query.gt('id', afterId);
      return query.order('id', { ascending: true }).limit(limit) as unknown as PromiseLike<{
        data: { id: string }[] | null; count?: number | null; error: { message: string } | null;
      }>;
    });
    expect(rows).toHaveLength(1234);
    expect(new Set(rows.map((r) => r.id)).size).toBe(1234);
  });

  it('uuid małymi literami: porządek napisów w JS to porządek bajtów (jak uuid w Postgresie)', () => {
    const hex = (n: number) => n.toString(16).padStart(32, '0');
    const uuids = [0x0, 0x9, 0xa, 0xf, 0x10, 0xa0, 0xff].map((n) => {
      const h = hex(n * 0x1000000000);
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    });
    const posortowane = [...uuids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const bajtami = [...uuids].sort((a, b) => Buffer.compare(Buffer.from(a.replace(/-/g, ''), 'hex'), Buffer.from(b.replace(/-/g, ''), 'hex')));
    expect(posortowane).toEqual(bajtami);
  });
});

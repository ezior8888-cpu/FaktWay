import { describe, expect, it } from 'vitest';

import {
  forEachPageById,
  KEYSET_PAGE_SIZE,
  KeysetPageError,
  POSTGREST_MAX_ROWS,
  readAllById,
  type KeysetFetchPage,
} from '@/lib/pagination/keyset';

/**
 * Helper stron po kluczu (sesja 27 planu skalowania, JOB-11). Produkcja ucina
 * każdą odpowiedź PostgREST do 1000 wierszy bez błędu, więc pełna lista musi
 * iść stronami, a każda niepewność („nie wiem, czy to wszystko”) ma rzucać,
 * a nie oddawać krótszą listę.
 */

type Row = { id: string; n: number };

/** uuid małymi literami — porządek napisów w JS = porządek uuid w Postgresie. */
const id = (n: number) => `${String(n).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
const rows = (count: number): Row[] => Array.from({ length: count }, (_, i) => ({ id: id(i + 1), n: i + 1 }));

interface SourceOptions {
  /** Limit serwera (`PGRST_DB_MAX_ROWS`), domyślnie 1000. */
  serverCap?: number;
  ignoreGt?: boolean;
  ignoreOrder?: boolean;
  ignoreLimit?: boolean;
  /** Numer wywołania (od 1), które kończy się błędem bazy. */
  failOnCall?: number;
}

/** Atrapa tabeli za PostgREST: gt/order/limit jak w bazie, odpowiedź ucięta do limitu serwera. */
function source(table: Row[], options: SourceOptions = {}) {
  const calls: Array<{ afterId: string | null; limit: number }> = [];
  const fetchPage: KeysetFetchPage<Row> = async (afterId, limit) => {
    calls.push({ afterId, limit });
    if (options.failOnCall === calls.length) return { data: null, error: { message: 'canceling statement due to statement timeout' } };
    let hits = table.filter((r) => options.ignoreGt || afterId === null || r.id > afterId);
    if (!options.ignoreOrder) hits = [...hits].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (!options.ignoreLimit) hits = hits.slice(0, limit);
    return { data: hits.slice(0, options.serverCap ?? POSTGREST_MAX_ROWS), error: null };
  };
  return { fetchPage, calls };
}

describe('readAllById — komplet', () => {
  it('2503 wiersze przy limicie serwera 1000: wszystkie, po kolei, 6 stron + pusta', async () => {
    const { fetchPage, calls } = source(rows(2503));
    const all = await readAllById('test', fetchPage);
    expect(all).toHaveLength(2503);
    expect(all.map((r) => r.n)).toEqual(rows(2503).map((r) => r.n));
    expect(calls).toHaveLength(7);
    expect(calls.every((c) => c.limit === KEYSET_PAGE_SIZE)).toBe(true);
    expect(calls[0]!.afterId).toBeNull();
    expect(calls[1]!.afterId).toBe(id(500));
  });

  it('koniec na PUSTEJ stronie, nie na krótkiej: serwer ucina do 300 przy stronie 500 — nadal komplet', async () => {
    const { fetchPage, calls } = source(rows(1203), { serverCap: 300 });
    const all = await readAllById('test', fetchPage);
    expect(all).toHaveLength(1203);
    expect(calls).toHaveLength(6); // 300 + 300 + 300 + 300 + 3 + pusta
  });

  it('pusta tabela: jedno zapytanie, pusta lista', async () => {
    const { fetchPage, calls } = source([]);
    await expect(readAllById('test', fetchPage)).resolves.toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('dokładnie pełna strona: pyta jeszcze raz i kończy na pustej', async () => {
    const { fetchPage, calls } = source(rows(500));
    await expect(readAllById('test', fetchPage)).resolves.toHaveLength(500);
    expect(calls).toHaveLength(2);
  });
});

describe('readAllById — „nie wiem” to nie „nie ma”', () => {
  it('zapytanie ignoruje gt(id): wyjątek zamiast pętli w miejscu', async () => {
    const { fetchPage, calls } = source(rows(1200), { ignoreGt: true });
    const read = readAllById('Lista firm', fetchPage);
    await expect(read).rejects.toBeInstanceOf(KeysetPageError);
    await expect(read).rejects.toThrow(/Lista firm: identyfikatory nie rosną/);
    expect(calls).toHaveLength(2);
  });

  it('zapytanie bez order(id): wyjątek', async () => {
    const shuffled = rows(30).reverse();
    const { fetchPage } = source(shuffled, { ignoreOrder: true });
    await expect(readAllById('test', fetchPage)).rejects.toThrow(/identyfikatory nie rosną/);
  });

  it('błąd bazy na stronie 2: wyjątek z etykietą, bez częściowej listy', async () => {
    const { fetchPage } = source(rows(1200), { failOnCall: 2 });
    const read = readAllById('Historia KSeF: odczyt firm', fetchPage);
    await expect(read).rejects.toThrow('Historia KSeF: odczyt firm: canceling statement due to statement timeout');
    await expect(read).rejects.toMatchObject({ label: 'Historia KSeF: odczyt firm', reason: 'canceling statement due to statement timeout' });
  });

  it('zapytanie bez limit(): strona dłuższa niż limit = wyjątek', async () => {
    const { fetchPage } = source(rows(1200), { ignoreLimit: true });
    await expect(readAllById('test', fetchPage)).rejects.toThrow(/strona ma 1000 wierszy przy limicie 500/);
  });

  it('powtórzony identyfikator na granicy stron: wyjątek', async () => {
    const table = rows(3);
    let call = 0;
    const fetchPage: KeysetFetchPage<Row> = async () => {
      call += 1;
      return { data: call === 1 ? table.slice(0, 2) : call === 2 ? table.slice(1) : [], error: null };
    };
    await expect(readAllById('test', fetchPage, { pageSize: 2 })).rejects.toThrow(/identyfikatory nie rosną po 00000002/);
  });

  it('strona 2 bez danych i bez błędu (data: null): wyjątek, nie koniec listy', async () => {
    const { fetchPage } = source(rows(700));
    let call = 0;
    const nullOnSecond: KeysetFetchPage<Row> = async (afterId, limit) => {
      call += 1;
      return call === 2 ? { data: null, error: null } : fetchPage(afterId, limit);
    };
    await expect(readAllById('test', nullOnSecond)).rejects.toThrow(/odpowiedź bez danych i bez błędu/);
  });

  it('wiersz bez id: wyjątek', async () => {
    const fetchPage: KeysetFetchPage<Row> = async () => ({ data: [{ id: '', n: 1 }], error: null });
    await expect(readAllById('test', fetchPage)).rejects.toThrow(/identyfikatory nie rosną/);
  });

  it('pułap stron: wyjątek zamiast cichego ucięcia', async () => {
    const { fetchPage, calls } = source(rows(1500));
    await expect(readAllById('test', fetchPage, { maxPages: 2 })).rejects.toThrow(/ponad 2 stron po 500 wierszy/);
    expect(calls).toHaveLength(3);
  });

  it('pułap stron równy liczbie stron: komplet (pusta strona nie liczy się do pułapu)', async () => {
    const { fetchPage } = source(rows(1000));
    await expect(readAllById('test', fetchPage, { maxPages: 2 })).resolves.toHaveLength(1000);
  });

  it.each([0, 501, 2.5])('rozmiar strony %s: wyjątek przed pierwszym zapytaniem', async (pageSize) => {
    const { fetchPage, calls } = source(rows(10));
    await expect(readAllById('test', fetchPage, { pageSize })).rejects.toThrow(/rozmiar strony/);
    expect(calls).toHaveLength(0);
  });
});

describe('forEachPageById — strona po stronie', () => {
  it('każda strona trafia do onPage, zanim padnie zapytanie o następną', async () => {
    const events: string[] = [];
    const { fetchPage } = source(rows(450));
    const tracked: KeysetFetchPage<Row> = (afterId, limit) => {
      events.push(`fetch ${afterId ? afterId.slice(0, 8) : 'start'}`);
      return fetchPage(afterId, limit);
    };
    const result = await forEachPageById('test', tracked, (page) => { events.push(`page ${page.length}`); }, { pageSize: 200 });
    expect(events).toEqual(['fetch start', 'page 200', 'fetch 00000200', 'page 200', 'fetch 00000400', 'page 50', 'fetch 00000450']);
    expect(result).toEqual({ pages: 3, rows: 450 });
  });

  it('wyjątek z onPage przerywa odczyt', async () => {
    const { fetchPage, calls } = source(rows(1200));
    await expect(forEachPageById('test', fetchPage, () => { throw new Error('zapis nie wyszedł'); })).rejects.toThrow('zapis nie wyszedł');
    expect(calls).toHaveLength(1);
  });
});

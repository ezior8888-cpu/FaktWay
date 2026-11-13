import { describe, expect, it } from 'vitest';

import {
  KEYSET_PAGE_SIZE,
  KeysetPageError,
  POSTGREST_MAX_ROWS,
  readAllByKey,
  type KeysetFetchPageByKey,
} from '@/lib/pagination/keyset';

/**
 * Strony po kluczu TEKSTOWYM (sesja 29 planu skalowania, część 2): tabele
 * bez `id`, jak `flo_decisions` z kluczem głównym `(tenant_id, kind)`.
 *
 * Kolejność ustala kolacja bazy, która nie musi być bajtowa — porządek
 * w Postgresie różni się wtedy od porządku napisów w JS. Helper nie może więc
 * sprawdzać kolejności w JS (rzuciłby przy poprawnej odpowiedzi); pilnuje,
 * żeby żaden klucz nie wrócił drugi raz.
 */

const collator = new Intl.Collator('pl');
/** Jak kolacja deterministyczna w Postgresie: porządek językowy, remis rozstrzyga porównanie bajtowe. */
const collate = (a: string, b: string) => collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);

type Row = { kind: string; n: number };

const NAMES = ['adobe', 'Zeta', 'Łódź', 'żabka', 'Beta', 'ćma', 'Ósemka', 'expense.rule', 'expense.rule:A'];
/** Klucze w kolejności wstawiania innej niż kolejność klucza (sterta). */
const rows = (count: number): Row[] =>
  Array.from({ length: count }, (_, i) => {
    const n = ((i * 7919) % count) + 1;
    return { kind: `${NAMES[n % NAMES.length]} ${String(n).padStart(5, '0')}`, n };
  });

interface SourceOptions {
  serverCap?: number;
  ignoreGt?: boolean;
  ignoreOrder?: boolean;
  ignoreLimit?: boolean;
  /** Numer wywołania (od 1), które kończy się błędem bazy. */
  failOnCall?: number;
  /** Numer wywołania, które oddaje `data: null` bez błędu. */
  nullOnCall?: number;
}

/** Atrapa tabeli za PostgREST: gt/order tą samą kolacją, limit, odpowiedź ucięta do limitu serwera. */
function source(table: Row[], options: SourceOptions = {}) {
  const calls: Array<{ afterKey: string | null; limit: number }> = [];
  const fetchPage: KeysetFetchPageByKey<Row> = async (afterKey, limit) => {
    calls.push({ afterKey, limit });
    if (options.failOnCall === calls.length) return { data: null, error: { message: 'canceling statement due to statement timeout' } };
    if (options.nullOnCall === calls.length) return { data: null, error: null };
    let hits = table.filter((r) => options.ignoreGt || afterKey === null || collate(r.kind, afterKey) > 0);
    if (!options.ignoreOrder) hits = [...hits].sort((a, b) => collate(a.kind, b.kind));
    if (!options.ignoreLimit) hits = hits.slice(0, limit);
    return { data: hits.slice(0, options.serverCap ?? POSTGREST_MAX_ROWS), error: null };
  };
  return { fetchPage, calls };
}

const read = (fetchPage: KeysetFetchPageByKey<Row>, options = {}) =>
  readAllByKey('test', (row: Row) => row.kind, fetchPage, options);

describe('readAllByKey — komplet', () => {
  it('2503 klucze z kolacją inną niż w JS: wszystkie, w kolejności bazy, 6 stron + pusta', async () => {
    const table = rows(2503);
    const { fetchPage, calls } = source(table);

    const all = await read(fetchPage);

    expect(all).toHaveLength(2503);
    expect(all.map((r) => r.kind)).toEqual([...table].sort((a, b) => collate(a.kind, b.kind)).map((r) => r.kind));
    // Kolejność bazy naprawdę różni się od kolejności w JS — inaczej test nie dowodziłby niczego.
    expect(all.map((r) => r.kind)).not.toEqual(all.map((r) => r.kind).sort());
    expect(calls).toHaveLength(7);
    expect(calls.every((c) => c.limit === KEYSET_PAGE_SIZE)).toBe(true);
    expect(calls[0]!.afterKey).toBeNull();
    expect(calls[1]!.afterKey).toBe(all[KEYSET_PAGE_SIZE - 1]!.kind);
  });

  it('pusta tabela: jedno zapytanie, pusta lista', async () => {
    const { fetchPage, calls } = source([]);
    await expect(read(fetchPage)).resolves.toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('serwer ucina poniżej rozmiaru strony: krótka strona to nie koniec, czytamy dalej', async () => {
    const { fetchPage, calls } = source(rows(1000), { serverCap: 300 });
    await expect(read(fetchPage)).resolves.toHaveLength(1000);
    expect(calls).toHaveLength(5);
  });
});

describe('readAllByKey — niepewność to wyjątek, nie krótsza lista', () => {
  it('błąd bazy na trzeciej stronie: KeysetPageError z etykietą', async () => {
    const { fetchPage } = source(rows(2503), { failOnCall: 3 });
    const error = await read(fetchPage).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KeysetPageError);
    expect((error as KeysetPageError).message).toBe('test: canceling statement due to statement timeout');
  });

  it('odpowiedź bez danych i bez błędu', async () => {
    const { fetchPage } = source(rows(800), { nullOnCall: 2 });
    await expect(read(fetchPage)).rejects.toThrow(/odpowiedź bez danych/);
  });

  it('zapytanie bez limit: strona dłuższa niż rozmiar strony', async () => {
    const { fetchPage } = source(rows(800), { ignoreLimit: true });
    await expect(read(fetchPage)).rejects.toThrow(/strona ma 800 wierszy przy limicie 500/);
  });

  it('zapytanie bez gt: klucz wraca drugi raz, zamiast pętli bez końca', async () => {
    const { fetchPage } = source(rows(800), { ignoreGt: true });
    await expect(read(fetchPage)).rejects.toThrow(/klucz wrócił drugi raz/);
  });

  it('zapytanie bez order: powtórka zamiast cichej luki', async () => {
    const { fetchPage } = source(rows(800), { ignoreOrder: true });
    await expect(read(fetchPage)).rejects.toThrow(/klucz wrócił drugi raz/);
  });

  it('komunikat nie zawiera wartości klucza (klucze tematów niosą nazwy kontrahentów)', async () => {
    const { fetchPage } = source([{ kind: 'expense.rule:Kowalski Jan', n: 1 }], { ignoreGt: true });
    const error = await read(fetchPage).catch((e: unknown) => e);
    expect(String((error as Error).message)).not.toContain('Kowalski');
  });

  it('wiersz bez klucza albo z pustym kluczem', async () => {
    const empty: KeysetFetchPageByKey<Row> = async () => ({ data: [{ kind: '', n: 1 }], error: null });
    await expect(read(empty)).rejects.toThrow(/wiersz bez klucza/);
    const missing: KeysetFetchPageByKey<Row> = async () => ({ data: [{ n: 1 } as unknown as Row], error: null });
    await expect(read(missing)).rejects.toThrow(/wiersz bez klucza/);
  });

  it('pułap stron: wyjątek, nie ucięta lista', async () => {
    const { fetchPage } = source(rows(1200));
    await expect(read(fetchPage, { pageSize: 100, maxPages: 5 })).rejects.toThrow(/ponad 5 stron po 100 wierszy/);
  });

  it('rozmiar strony spoza 1–500', async () => {
    const { fetchPage } = source(rows(10));
    await expect(read(fetchPage, { pageSize: 600 })).rejects.toThrow(/rozmiar strony 600/);
  });
});

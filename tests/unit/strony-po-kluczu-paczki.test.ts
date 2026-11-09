import { createClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import { IN_LIST_MAX_CHARS, IN_LIST_MAX_VALUES, inListChunks, readAllByIdInList, type InListFetchPage } from '@/lib/pagination/in-list';
import { KeysetPageError, POSTGREST_MAX_ROWS } from '@/lib/pagination/keyset';

/**
 * Odczyt po liście wartości (sesja 32 planu skalowania, F-089): paczki po
 * najwyżej 100 wartości i 4000 znaków w adresie, każda stronami po `id`.
 * Długość adresu sprawdzana na prawdziwym budowniczym supabase-js (nic nie
 * wysyła) — to on koduje `.in()` w adresie GET.
 */

type Row = { id: string; value: string };

const id = (n: number) => `${String(n).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;

const shadowClient = createClient('http://kong:8000', 'klucz-testowy', {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

/** Znaki, które paczka dokłada do adresu: parametr `kolumna=in.(…)` bez nazwy kolumny i nawiasów. */
function inListCharsInUrl(values: string[]): number {
  const base = (shadowClient.from('t').select('id') as unknown as { url: URL }).url.search.length;
  const withIn = (shadowClient.from('t').select('id').in('c', values) as unknown as { url: URL }).url.search.length;
  return withIn - base - '&c=in.%28%29'.length;
}

/** Atrapa tabeli za PostgREST: `in`, `gt`, `order('id')`, `limit` jak w bazie, odpowiedź ucięta do 1000 wierszy. */
function source(table: Row[], options: { failOnCall?: number } = {}) {
  const calls: Array<{ values: string[]; afterId: string | null; limit: number }> = [];
  const fetchPage: InListFetchPage<Row> = async (values, afterId, limit) => {
    calls.push({ values, afterId, limit });
    if (options.failOnCall === calls.length) return { data: null, error: { message: 'canceling statement due to statement timeout' } };
    const wanted = new Set(values);
    const hits = table
      .filter((r) => wanted.has(r.value) && (afterId === null || r.id > afterId))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, limit);
    return { data: hits.slice(0, POSTGREST_MAX_ROWS), error: null };
  };
  return { fetchPage, calls };
}

describe('inListChunks', () => {
  it('1500 numerów faktur: 15 paczek po 100, kolejność z wejścia, bez powtórzeń', () => {
    const numbers = Array.from({ length: 1500 }, (_, i) => `FV/${i + 1}/11/2026`);
    const chunks = inListChunks([...numbers, ...numbers.slice(0, 40)]);
    expect(chunks).toHaveLength(15);
    expect(chunks.every((c) => c.length === IN_LIST_MAX_VALUES)).toBe(true);
    expect(chunks.flat()).toEqual(numbers);
  });

  it('długie numery z polskimi literami i znakami zarezerwowanymi: każda paczka mieści się w budżecie znaków adresu', () => {
    const numbers = Array.from({ length: 300 }, (_, i) => `Faktura sprzedaży (zaliczkowa), żółć ${i + 1}/${'ą'.repeat(40)}`);
    const chunks = inListChunks(numbers);
    expect(chunks.length).toBeGreaterThan(3);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(IN_LIST_MAX_VALUES);
      expect(inListCharsInUrl(chunk)).toBeLessThanOrEqual(IN_LIST_MAX_CHARS);
    }
    expect(chunks.flat()).toEqual(numbers);
  });

  it('wartość dłuższa niż budżet dostaje własną paczkę', () => {
    const long = 'X'.repeat(IN_LIST_MAX_CHARS + 1);
    expect(inListChunks(['A', long, 'B'])).toEqual([['A'], [long], ['B']]);
  });

  it('pusta lista: żadnej paczki; złe ustawienia: wyjątek', () => {
    expect(inListChunks([])).toEqual([]);
    expect(() => inListChunks(['A'], { maxValues: 0 })).toThrow(RangeError);
    expect(() => inListChunks(['A'], { maxChars: 1.5 })).toThrow(RangeError);
  });
});

describe('readAllByIdInList', () => {
  it('paczka dopasowuje 1200 wierszy przy limicie serwera 1000: komplet, żadne .in() ponad 100 wartości', async () => {
    const values = Array.from({ length: 250 }, (_, i) => `V${i}`);
    // 1200 wierszy dla 12 wartości z pierwszej paczki, po jednym dla pozostałych.
    const table: Row[] = [
      ...Array.from({ length: 1200 }, (_, i) => ({ id: id(((i + 1) * 7919) % 100_000), value: `V${i % 12}` })),
      ...values.slice(12).map((value, i) => ({ id: id(200_000 + i), value })),
    ];
    const { fetchPage, calls } = source(table);
    const all = await readAllByIdInList('test', values, fetchPage);
    expect(all).toHaveLength(table.length);
    expect(new Set(all.map((r) => r.id)).size).toBe(table.length);
    expect(Math.max(...calls.map((c) => c.values.length))).toBeLessThanOrEqual(IN_LIST_MAX_VALUES);
    // Pierwsza paczka: 1200 + 88 wierszy = 3 strony + pusta; kolejne paczki: strona + pusta.
    expect(calls.filter((c) => c.values[0] === 'V0')).toHaveLength(4);
    expect(calls.filter((c) => c.afterId === null)).toHaveLength(3);
  });

  it('błąd strony w drugiej paczce: wyjątek z etykietą, nie część listy', async () => {
    const values = Array.from({ length: 250 }, (_, i) => `V${i}`);
    const { fetchPage } = source(values.map((value, i) => ({ id: id(i + 1), value })), { failOnCall: 3 });
    const read = readAllByIdInList('Faktury: odczyt duplikatów (numer)', values, fetchPage);
    await expect(read).rejects.toBeInstanceOf(KeysetPageError);
    await expect(read).rejects.toMatchObject({ label: 'Faktury: odczyt duplikatów (numer)', reason: 'canceling statement due to statement timeout' });
  });

  it('pusta lista: żadnego zapytania', async () => {
    const { fetchPage, calls } = source([]);
    await expect(readAllByIdInList('test', [], fetchPage)).resolves.toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('ten sam wiersz z dwóch paczek liczy się raz', async () => {
    const values = Array.from({ length: 150 }, (_, i) => `V${i}`);
    const shared: Row = { id: id(1), value: 'V0' };
    let first = true;
    const fetchPage: InListFetchPage<Row> = async (chunk, afterId) => {
      if (afterId !== null) return { data: [], error: null };
      // Wartość wiersza zmieniła się między paczkami: oddają go obie.
      if (first) { first = false; return { data: [shared], error: null }; }
      return { data: chunk.includes('V120') ? [shared] : [], error: null };
    };
    await expect(readAllByIdInList('test', values, fetchPage)).resolves.toEqual([shared]);
  });
});

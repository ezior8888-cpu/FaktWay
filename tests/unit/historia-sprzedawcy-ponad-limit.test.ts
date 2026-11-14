import { describe, expect, it } from 'vitest';

import { readSellerHistory } from '@/lib/flo/functions/expense-review';

/**
 * Sesja 29 planu skalowania: historia sprzedawcy dla karty przeglądu wydatku
 * szła jednym zapytaniem bez stron. PostgREST na produkcji
 * (`PGRST_DB_MAX_ROWS = 1000`) ucina odpowiedź bez błędu, więc u stałego
 * dostawcy z ponad 1000 paragonami (flota tankująca na jednej stacji) karta
 * liczyła liczbę dokumentów i medianę z przypadkowych 1000. Atrapa ucina
 * KAŻDĄ odpowiedź do 1000 wierszy jak produkcja: bez `order` w kolejności
 * sterty, z `order('id')`, `gt('id')` i `limit` stronami jak baza.
 */

type Row = Record<string, unknown>;
type HistoryClient = NonNullable<Parameters<typeof readSellerHistory>[2]>;

const MAX_ROWS = 1000;
const TENANT = '33333333-3333-4333-8333-333333333333';
const OTHER_TENANT = '44444444-4444-4444-8444-444444444444';
const SELLER = 'Stacja Paliw Testowa';

/** uuid małymi literami: porządek napisów w JS = porządek uuid w Postgresie. */
const uuid = (n: number, x = 'a') => `${String(n).padStart(8, '0')}-${x.repeat(4)}-4${x.repeat(3)}-8${x.repeat(3)}-${x.repeat(12)}`;
/** Kolejność wstawiania ≠ kolejność id (7919 jest pierwsze, więc to permutacja 1..count). */
const heapOrder = (count: number) => Array.from({ length: count }, (_, i) => ((i * 7919) % count) + 1);
const byte = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function cappedExpenses(rows: Row[], options: { insertAfterFirstRequest?: Row } = {}) {
  let requests = 0;
  const client = {
    from: () => {
      const filters: Array<(row: Row) => boolean> = [];
      let byId = false;
      let limit: number | null = null;
      const run = () => {
        requests += 1;
        let hits = rows.filter((row) => filters.every((f) => f(row)));
        if (byId) hits = [...hits].sort((a, b) => byte(String(a.id), String(b.id)));
        hits = hits.slice(0, limit ?? hits.length).slice(0, MAX_ROWS);
        if (options.insertAfterFirstRequest && requests === 1) rows.push(options.insertAfterFirstRequest);
        return { data: hits.map((row) => ({ ...row })), error: null };
      };
      const query = {
        select: () => query,
        eq: (column: string, value: unknown) => { filters.push((row) => row[column] === value); return query; },
        gt: (column: string, value: string) => { filters.push((row) => String(row[column]) > value); return query; },
        order: (column: string) => { byId = column === 'id'; return query; },
        limit: (n: number) => { limit = n; return query; },
        then: <A, B>(ok: (value: ReturnType<typeof run>) => A, fail?: (error: unknown) => B) =>
          Promise.resolve().then(run).then(ok, fail),
      };
      return query;
    },
  };
  return { client: client as unknown as HistoryClient };
}

/**
 * 1200 paragonów sprzedawcy. Kolejność sterty: najpierw 600 tankowań po 100 zł,
 * potem 600 po 300 zł. Ucięte 1000 to 600 × 100 i 400 × 300 (mediana 100),
 * komplet ma medianę 200. Cudze wiersze (inna firma, inny sprzedawca) leżą
 * pomiędzy i przeplatają się w kolejności id: filtr musi iść na każdej stronie.
 */
function fleetReceipts(): Row[] {
  const own = heapOrder(1200).map((n, i) => ({
    id: uuid(n), tenant_id: TENANT, seller_name: SELLER, gross_amount: i < 600 ? 100 : 300,
    is_deductible: true, currency: 'PLN', fx: null,
  }));
  const foreign = [
    { id: uuid(7, 'b'), tenant_id: OTHER_TENANT, seller_name: SELLER, gross_amount: 99_999, is_deductible: true, currency: 'PLN', fx: null },
    { id: uuid(8, 'b'), tenant_id: TENANT, seller_name: 'Inny Sprzedawca', gross_amount: 99_999, is_deductible: true, currency: 'PLN', fx: null },
  ];
  return [...own.slice(0, 300), ...foreign, ...own.slice(300)];
}

describe('historia sprzedawcy ponad limit wierszy PostgREST (sesja 29)', () => {
  it('stały dostawca z 1200 paragonami: liczba i mediana z kompletu, nie z pierwszych 1000', async () => {
    const { client } = cappedExpenses(fleetReceipts());

    const history = await readSellerHistory(TENANT, SELLER, client);

    expect(history.count).toBe(1200);
    expect(history.medianBasis).toBe(1200);
    expect(history.medianGross).toBe(200);
    expect(new Set(history.entries?.map((entry) => entry.expenseId))).toEqual(new Set(heapOrder(1200).map((n) => uuid(n))));
  });

  it('paragon tego sprzedawcy dopisany w trakcie odczytu (zdjęcia wgrane paczką) nie wywraca karty', async () => {
    const late = {
      id: uuid(5000), tenant_id: TENANT, seller_name: SELLER, gross_amount: 300, is_deductible: true, currency: 'PLN', fx: null,
    };
    const { client } = cappedExpenses(fleetReceipts(), { insertAfterFirstRequest: late });

    const history = await readSellerHistory(TENANT, SELLER, client);

    // Odczyt kończy się na pustej stronie, nie na liczbie z pierwszej: późny
    // paragon (najwyższe id) wchodzi, a odczyt nie rzuca „liczba się zmieniła”.
    expect(history.count).toBe(1201);
    expect(history.medianGross).toBe(300);
    expect(history.entries?.some((entry) => entry.expenseId === late.id)).toBe(true);
  });
});

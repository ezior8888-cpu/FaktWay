import { describe, expect, it } from 'vitest';

import type { FloDbClient } from '@/lib/flo/db-types';
import { recordShadow } from '@/lib/flo/shadow';

/**
 * Tryb cichy: jedna sprawa = jeden wpis, także gdy wpisów jest ponad 1000
 * (sesja 29 planu skalowania, część 2).
 *
 * `recordShadow` szukał powtórki wśród WSZYSTKICH nierozstrzygniętych wpisów
 * rodzaju, czytanych jednym zapytaniem. Produkcja ucina odpowiedź do 1000
 * wierszy bez błędu (`PGRST_DB_MAX_ROWS`), więc sprawa spoza pierwszego
 * tysiąca dostawała drugi wpis przy każdym przebiegu pulsu, a próbka
 * trafności liczyła tę samą sprawę wiele razy.
 */

const MAX_ROWS = 1000;
const T = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const KIND = 'expense.missing' as const;

type Row = {
  id: string;
  tenant_id: string;
  kind: string;
  proposal: { topicKey: string; fingerprint: string };
  matched: boolean | null;
};

function shadowRow(n: number, patch: Partial<Row> = {}): Row {
  return {
    id: `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`,
    tenant_id: T,
    kind: KIND,
    proposal: { topicKey: `${KIND}:dokument ${n}`, fingerprint: `odcisk-${n}` },
    matched: null,
    ...patch,
  };
}

/** Wartość kolumny albo ścieżki JSON (`proposal->>topicKey` oddaje tekst, jak w Postgresie). */
function columnValue(row: Row, column: string): unknown {
  const [root, key] = column.split('->>');
  const value = (row as Record<string, unknown>)[root!];
  if (key === undefined) return value;
  const inner = value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
  return inner == null ? null : String(inner);
}

/** Atrapa `flo_shadow` za PostgREST: eq (też po ścieżce JSON), is, limit; każda odpowiedź ucięta do 1000 wierszy. */
function fakeDb(table: Row[], options: { failOnSelect?: boolean } = {}) {
  const inserts: unknown[] = [];
  let selects = 0;
  const client = {
    from(name: string) {
      if (name !== 'flo_shadow') throw new Error(`atrapa zna tylko flo_shadow, nie ${name}`);
      return {
        select() {
          const preds: Array<(row: Row) => boolean> = [];
          let limit: number | null = null;
          const builder = {
            eq(column: string, value: unknown) {
              preds.push((row) => columnValue(row, column) === value);
              return builder;
            },
            is(column: string, value: null | boolean) {
              preds.push((row) => (columnValue(row, column) ?? null) === value);
              return builder;
            },
            order: () => builder,
            limit(count: number) {
              limit = count;
              return builder;
            },
            then(ok: (value: unknown) => unknown, fail?: (error: unknown) => unknown) {
              selects += 1;
              if (options.failOnSelect) {
                return Promise.resolve({ data: null, error: { message: 'canceling statement due to statement timeout' } }).then(ok, fail);
              }
              let hits = table.filter((row) => preds.every((pred) => pred(row)));
              if (limit !== null) hits = hits.slice(0, limit);
              return Promise.resolve({ data: hits.slice(0, MAX_ROWS).map((row) => ({ ...row })), error: null }).then(ok, fail);
            },
          };
          return builder;
        },
        insert(payload: unknown) {
          return {
            then(ok: (value: unknown) => unknown, fail?: (error: unknown) => unknown) {
              inserts.push(payload);
              return Promise.resolve({ data: null, error: null }).then(ok, fail);
            },
          };
        },
      };
    },
  };
  return { db: client as unknown as FloDbClient, inserts, selects: () => selects };
}

const record = (topicKey: string, db: FloDbClient) =>
  recordShadow({ tenantId: T, kind: KIND, proposal: { topicKey, fingerprint: 'nowy-odcisk' } }, db);

describe('tryb cichy ponad 1000 nierozstrzygniętych wpisów', () => {
  it('sprawa za tysięcznym wpisem nie dostaje drugiego wpisu', async () => {
    const table = Array.from({ length: 1500 }, (_, i) => shadowRow(i + 1));
    const { db, inserts } = fakeDb(table);

    await expect(record(`${KIND}:dokument 1500`, db)).resolves.toBe(false);
    expect(inserts).toEqual([]);
  });

  it('nowa sprawa dostaje jeden wpis', async () => {
    const { db, inserts } = fakeDb(Array.from({ length: 1500 }, (_, i) => shadowRow(i + 1)));

    await expect(record(`${KIND}:dokument nowy`, db)).resolves.toBe(true);
    expect(inserts).toEqual([
      { tenant_id: T, kind: KIND, proposal: { topicKey: `${KIND}:dokument nowy`, fingerprint: 'nowy-odcisk' } },
    ]);
  });

  it('sprawa rozstrzygnięta i wracająca to nowa sprawa, a cudza firma nie blokuje', async () => {
    const table = [
      shadowRow(1, { matched: true }),
      shadowRow(2, { matched: false }),
      shadowRow(3, { tenant_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }),
    ];
    const { db, inserts } = fakeDb(table);

    await expect(record(`${KIND}:dokument 1`, db)).resolves.toBe(true);
    await expect(record(`${KIND}:dokument 2`, db)).resolves.toBe(true);
    await expect(record(`${KIND}:dokument 3`, db)).resolves.toBe(true);
    expect(inserts).toHaveLength(3);
  });

  it('błąd odczytu to błąd, nie zgoda na drugi wpis', async () => {
    const { db, inserts } = fakeDb([shadowRow(1)], { failOnSelect: true });

    await expect(record(`${KIND}:dokument 1`, db)).rejects.toThrow(/statement timeout/);
    expect(inserts).toEqual([]);
  });
});

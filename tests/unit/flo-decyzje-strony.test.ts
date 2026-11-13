import { describe, expect, it } from 'vitest';

import {
  CROWD_MUTE_SUBJECTS,
  isSilenced,
  listMutedKinds,
  listMutedSubjects,
  readDecisionRows,
} from '@/lib/flo/decisions';
import type { FloDbClient } from '@/lib/flo/db-types';

/**
 * Pamięć decyzji Flo czytana stronami (sesja 29 planu skalowania, część 2).
 *
 * Produkcja ucina każdą odpowiedź PostgREST do 1000 wierszy bez błędu
 * (`PGRST_DB_MAX_ROWS`). Wierszy decyzji jest tyle, ile rodzajów plus spraw,
 * o których klient coś powiedział, a u firmy, która od miesięcy odrzuca
 * karty o regułach kosztów, to tysiące. Odczyt jednym zapytaniem brał
 * pierwsze 1000 i rodzaj wyciszony „Nigdy więcej takich” wracał.
 *
 * Klucz `kind` jest tekstem, a kolacja bazy nie musi być bajtowa: porządek
 * w Postgresie (tu `Intl.Collator('pl')`) różni się od porządku napisów
 * w JS. Atrapa porównuje tą samą kolacją w `order` i w `gt`, jak baza.
 */

const MAX_ROWS = 1000;
const T = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NOW = new Date('2026-11-12T10:00:00.000Z');
const DAY = 86_400_000;
const iso = (days: number) => new Date(NOW.getTime() + days * DAY).toISOString();

const collator = new Intl.Collator('pl');
/** Jak kolacja deterministyczna w Postgresie: porządek językowy, remis rozstrzyga porównanie bajtowe. */
const collate = (a: string, b: string) => collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);

type Row = {
  tenant_id: string;
  kind: string;
  accepted: number;
  dismissed: number;
  muted_until: string | null;
  last_at: string;
};

/** Nazwy sprzedawców, przy których porządek językowy różni się od porządku napisów w JS. */
const NAMES = ['adobe', 'Zeta', 'Łódź', 'żabka', 'Beta', 'ćma', 'Ósemka'];

function decision(kind: string, patch: Partial<Row> = {}): Row {
  return { tenant_id: T, kind, accepted: 0, dismissed: 1, muted_until: null, last_at: iso(-200), ...patch };
}

/** Tło: `count` dawnych spraw innego rodzaju (W-03), które zapychają pierwszy tysiąc wierszy. */
function background(count: number): Row[] {
  return Array.from({ length: count }, (_, i) =>
    decision(`expense.rule:${NAMES[i % NAMES.length]} ${String(i).padStart(5, '0')}`));
}

/** Wiersze innej firmy, które ucichłyby wszystko, gdyby przeciekły przez filtr firmy. */
const otherTenant: Row[] = [
  { ...decision('payment.confirm', { muted_until: iso(60) }), tenant_id: OTHER },
  { ...decision('expense.review', { muted_until: iso(60) }), tenant_id: OTHER },
];

interface Call { filters: string[]; order: string | null; limit: number | null }

/** Atrapa `flo_decisions` za PostgREST: eq/gt/order/limit jak w bazie, każda odpowiedź ucięta do 1000 wierszy. */
function fakeDb(table: Row[], options: { failOnSelect?: number } = {}) {
  const calls: Call[] = [];
  const client = {
    from(name: string) {
      if (name !== 'flo_decisions') throw new Error(`atrapa zna tylko flo_decisions, nie ${name}`);
      const preds: Array<(row: Row) => boolean> = [];
      const call: Call = { filters: [], order: null, limit: null };
      let ascending = true;
      const builder = {
        select: () => builder,
        eq(column: keyof Row, value: unknown) {
          call.filters.push(`${column}.eq`);
          preds.push((row) => row[column] === value);
          return builder;
        },
        gt(column: keyof Row, value: string) {
          call.filters.push(`${column}.gt`);
          preds.push(column === 'kind'
            ? (row) => collate(row.kind, value) > 0
            : (row) => row[column] !== null && Date.parse(String(row[column])) > Date.parse(value));
          return builder;
        },
        order(column: string, opts?: { ascending?: boolean }) {
          if (column !== 'kind') throw new Error(`atrapa sortuje tylko po kind, nie ${column}`);
          call.order = column;
          ascending = opts?.ascending ?? true;
          return builder;
        },
        limit(count: number) {
          call.limit = count;
          return builder;
        },
        then(ok: (value: unknown) => unknown, fail?: (error: unknown) => unknown) {
          calls.push(call);
          if (options.failOnSelect === calls.length) {
            return Promise.resolve({ data: null, error: { message: 'canceling statement due to statement timeout' } }).then(ok, fail);
          }
          let hits = table.filter((row) => preds.every((pred) => pred(row)));
          if (call.order) hits = [...hits].sort((a, b) => (ascending ? 1 : -1) * collate(a.kind, b.kind));
          if (call.limit !== null) hits = hits.slice(0, call.limit);
          return Promise.resolve({ data: hits.slice(0, MAX_ROWS).map((row) => ({ ...row })), error: null }).then(ok, fail);
        },
      };
      return builder;
    },
  };
  return { db: client as unknown as FloDbClient, calls };
}

describe('pamięć decyzji Flo ponad 1000 wierszy', () => {
  it('wyciszony rodzaj zostaje wyciszony przy 1500 wierszach decyzji', async () => {
    const table = [...otherTenant, ...background(1499), decision('payment.confirm', { dismissed: 2, muted_until: iso(60), last_at: iso(-1) })];
    const { db } = fakeDb(table);

    await expect(isSilenced(T, 'payment.confirm', 'payment.confirm:FV 7/2026', NOW, db))
      .resolves.toEqual({ silenced: true, reason: 'kind' });
  });

  it('wyciszona sprawa za tysięcznym wierszem zostaje wyciszona', async () => {
    const table = [...background(1499), decision('payment.confirm:FV 9/2026', { dismissed: 2, muted_until: iso(60), last_at: iso(-1) })];
    const { db } = fakeDb(table);

    await expect(isSilenced(T, 'payment.confirm', 'payment.confirm:FV 9/2026', NOW, db))
      .resolves.toEqual({ silenced: true, reason: 'subject' });
  });

  it('reguła tłumu liczy sprawy z całej pamięci, nie z pierwszego tysiąca', async () => {
    expect(CROWD_MUTE_SUBJECTS).toBe(4);
    const crowd = (n: number) => decision(`payment.confirm:FV ${n}/2026`, { dismissed: 1, last_at: iso(-2) });
    // Dwie odrzucone sprawy w pierwszym tysiącu, dwie za nim: razem próg tłumu.
    const table = [crowd(1), crowd(2), ...background(1496), crowd(3), crowd(4)];
    const { db } = fakeDb(table);

    await expect(isSilenced(T, 'payment.confirm', 'payment.confirm:FV 99/2026', NOW, db))
      .resolves.toEqual({ silenced: true, reason: 'crowd' });
  });

  it('readDecisionRows oddaje wszystkie wiersze firmy, stronami po kluczu', async () => {
    const { db, calls } = fakeDb([...otherTenant, ...background(1500)]);

    const rows = await readDecisionRows(T, db);

    expect(rows).toHaveLength(1500);
    expect(new Set(rows.map((row) => row.kind)).size).toBe(1500);
    // Każda strona: posortowana po kluczu, najwyżej połowa limitu serwera, zawsze z filtrem firmy.
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.every((call) => call.order === 'kind' && call.limit !== null && call.limit <= MAX_ROWS / 2)).toBe(true);
    expect(calls.every((call) => call.filters.includes('tenant_id.eq'))).toBe(true);
  });

  it('ekran ustawień widzi wszystkie wyciszenia, także za tysięcznym wierszem', async () => {
    const mutedSubjects = Array.from({ length: 1200 }, (_, i) =>
      decision(`expense.rule:${NAMES[i % NAMES.length]} ${i}`, { muted_until: iso(30) }));
    const mutedKinds = ['payment.confirm', 'expense.review', 'ksef.status'].map((kind) => decision(kind, { muted_until: iso(30) }));
    // Cisza, która już wygasła, nie jest wyciszeniem.
    const expired = decision('expense.missing', { muted_until: iso(-1) });
    const { db } = fakeDb([...otherTenant, ...mutedSubjects, expired, ...mutedKinds]);

    expect((await listMutedKinds(T, NOW, db)).sort()).toEqual(['expense.review', 'ksef.status', 'payment.confirm']);
    expect(await listMutedSubjects(T, NOW, db)).toHaveLength(1200);
  });

  it('błąd na dalszej stronie to błąd, nie „nic nie wyciszone”', async () => {
    const table = [...background(1499), decision('payment.confirm', { muted_until: iso(60) })];

    await expect(isSilenced(T, 'payment.confirm', 'payment.confirm:FV 7/2026', NOW, fakeDb(table, { failOnSelect: 2 }).db))
      .rejects.toThrow(/statement timeout/);
    const muted = Array.from({ length: 1200 }, (_, i) => decision(`expense.rule:${i}`, { muted_until: iso(30) }));
    await expect(listMutedKinds(T, NOW, fakeDb(muted, { failOnSelect: 2 }).db)).rejects.toThrow(/statement timeout/);
  });
});

import { createClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IN_LIST_MAX_VALUES } from '@/lib/pagination/in-list';
import { POSTGREST_MAX_ROWS } from '@/lib/pagination/keyset';

/**
 * Lista wyciszeń w ustawieniach Flo przy setkach spraw (ustalenie 1 z PR #660,
 * plan skalowania 3000).
 *
 * `listSilenced` brał tytuły kart jednym zapytaniem `.in('topic_key', …)`
 * ze WSZYSTKIMI kluczami spraw z pamięci decyzji, bez paczek i bez stron:
 *  - lista trafia do adresu GET, więc od ok. 150 spraw adres ma ponad 8 tys.
 *    znaków, bramka (Kong/nginx) go odrzuca i ekran ustawień Flo kończy się
 *    błędem (klasa F-089);
 *  - PostgREST ucina każdą odpowiedź do 1000 wierszy bez błędu
 *    (`PGRST_DB_MAX_ROWS`), więc przy kilku kartach na sprawę starsze sprawy
 *    tracą tytuł i na liście stoją jednakowe wpisy „…: jedna sprawa”.
 *
 * Atrapa gra PostgREST POD prawdziwym klientem supabase-js (to on koduje
 * zapytanie w adresie): `eq`, `in`, `gt`, `order`, `limit` jak w bazie,
 * odpowiedź ucięta do 1000 wierszy, adres ponad 8000 znaków → 414 jak bramka.
 * Zapisuje każde żądanie: tabelę, adres i listę `in`. Pamięć decyzji czyta
 * zarówno jednym zapytaniem (dzisiejszy `main`), jak i stronami po `kind`
 * (PR #660), więc test nie zależy od kolejności scalania.
 */

const env = vi.hoisted(() => ({
  client: null as unknown,
  tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
}));

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

vi.mock('@/lib/supabase/auth-context', () => ({
  requireUserAndActiveOrg: async () => ({ tenantId: env.tenantId, user: { id: 'user-1' } }),
}));

vi.mock('@/lib/flo/db-types', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/flo/db-types')>()),
  floDb: () => env.client,
}));

import { listSilenced } from '@/app/actions/flo';

const T = env.tenantId;
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NOW = new Date('2026-11-12T10:00:00.000Z');
const MINUTE = 60_000;
const DAY = 86_400_000;
/** Bramka przed PostgREST (Kong/nginx): ok. 8 KB na wiersz żądania, jak w `lib/pagination/in-list.ts`. */
const GATEWAY_MAX_URL = 8000;

const iso = (ms: number) => new Date(ms).toISOString();
const hex = (n: number, width: number) => n.toString(16).padStart(width, '0');
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);

type Row = Record<string, string | number | null>;

/** Klucz sprawy jak u producenta: rodzaj i uuid faktury (52 znaki). */
const subject = (n: number) => `payment.confirm:${hex(n, 8)}-1111-4111-8111-${hex(n, 12)}`;

/** Początek `id` kart naszej firmy; obca firma dostaje mniejsze `id` (wcześniej na stronach). */
const OWN_IDS = 0x10000000;

/** `id` karty: uuid z małymi literami hex, jak z Postgresa; porządek napisów = porządek w bazie. */
const cardId = (prefix: number, n: number, rank: number) => `${hex(prefix + n, 8)}-2222-4222-8222-${hex(rank, 12)}`;

/**
 * Miejsce karty w kolejności `id` w obrębie sprawy: permutacja rozjechana
 * z datą. Przy 12 kartach najnowsza nie jest ani pierwsza, ani ostatnia po
 * `id`, więc naprawa „pierwsza/ostatnia karta ze stron” nie przejdzie.
 */
const idRank = (card: number, perSubject: number) => (card * 7 + 3) % perSubject;

const title = (n: number, card: number) => `Czy kontrahent ${n} zapłacił za FV ${n}/2026? (karta ${card + 1})`;

/** Wiersz pamięci decyzji; domyślnie sprawa wyciszona po dwóch „nie” na 30 dni naprzód. */
function decision(kind: string, patch: Row = {}): Row {
  return {
    tenant_id: T,
    kind,
    accepted: 0,
    dismissed: 2,
    muted_until: iso(NOW.getTime() + 30 * DAY),
    last_at: iso(NOW.getTime() - DAY),
    ...patch,
  };
}

/**
 * `perSubject` kart każdej sprawy z `subjects`, najstarsze sprawy najpierw
 * (jak u klienta: dawno wyciszona sprawa ma dawne karty). W obrębie sprawy
 * data rośnie z numerem karty, a `id` idzie w innej kolejności (`idRank`).
 */
function cards(subjects: readonly number[], perSubject: number, tenantId = T, idPrefix = OWN_IDS): Row[] {
  const total = subjects.length * perSubject;
  return Array.from({ length: total }, (_, seq) => {
    const n = subjects[Math.floor(seq / perSubject)]!;
    const card = seq % perSubject;
    return {
      id: cardId(idPrefix, n, idRank(card, perSubject)),
      tenant_id: tenantId,
      kind: 'payment.confirm',
      topic_key: subject(n),
      status: card === perSubject - 1 ? 'dismissed' : 'expired',
      title: title(n, card),
      created_at: iso(NOW.getTime() - (total - seq) * MINUTE),
    };
  });
}

const COLUMNS: Record<string, readonly string[]> = {
  flo_decisions: ['tenant_id', 'kind', 'accepted', 'dismissed', 'muted_until', 'last_at'],
  flo_proposals: ['id', 'tenant_id', 'kind', 'topic_key', 'status', 'title', 'created_at'],
};

interface Call {
  table: string;
  url: URL;
  /** Ścieżka z zapytaniem, tak jak widzi je bramka (po zakodowaniu). */
  urlChars: number;
  inValues: string[] | null;
}

/** Podmiana odpowiedzi: `nth` = numer żądania do tej samej tabeli, od 1. */
type Fault = (call: Call, nth: number) => Response | null;

/** Lista z `in.(…)`: przecinki poza cudzysłowem, cudzysłów jak w postgrest-js. */
function parseInList(arg: string): string[] {
  if (!arg.startsWith('(') || !arg.endsWith(')')) throw new Error('lista in bez nawiasów');
  const values: string[] = [];
  let current = '';
  let quoted = false;
  for (const char of arg.slice(1, -1)) {
    if (char === '"') quoted = !quoted;
    else if (char === ',' && !quoted) {
      values.push(current);
      current = '';
    } else current += char;
  }
  values.push(current);
  return values;
}

function postgrest(tables: Record<string, Row[]>, fault?: Fault) {
  const calls: Call[] = [];

  async function fakeFetch(input: RequestInfo | URL): Promise<Response> {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const table = url.pathname.replace(/^\/rest\/v1\//, '');
    const columns = COLUMNS[table] ?? [];
    let rows = [...(tables[table] ?? [])];
    let select: readonly string[] = columns;
    let order: Array<{ column: string; ascending: boolean }> = [];
    let limit = Infinity;
    let inValues: string[] | null = null;
    const unknown: string[] = columns.length === 0 ? [`tabela ${table}`] : [];

    for (const [key, value] of url.searchParams) {
      if (key === 'select') {
        select = value === '*' ? columns : value.split(',').map((column) => column.trim());
      } else if (key === 'order') {
        order = value.split(',').map((part) => {
          const [column = '', direction] = part.split('.');
          return { column, ascending: direction !== 'desc' };
        });
      } else if (key === 'limit') {
        limit = Number(value);
      } else {
        if (!columns.includes(key)) unknown.push(`kolumna ${key}`);
        const dot = value.indexOf('.');
        const operator = value.slice(0, dot);
        const arg = value.slice(dot + 1);
        if (operator === 'eq') rows = rows.filter((row) => String(row[key]) === arg);
        else if (operator === 'gt') rows = rows.filter((row) => row[key] !== null && String(row[key]) > arg);
        else if (operator === 'in') {
          inValues = parseInList(arg);
          const wanted = new Set(inValues);
          rows = rows.filter((row) => wanted.has(String(row[key])));
        } else unknown.push(`operator ${operator}`);
      }
    }
    for (const column of [...select, ...order.map((o) => o.column)]) {
      if (!columns.includes(column)) unknown.push(`kolumna ${column}`);
    }

    const call: Call = { table, url, urlChars: url.pathname.length + url.search.length, inValues };
    calls.push(call);
    if (call.urlChars > GATEWAY_MAX_URL) {
      return new Response('<html><head><title>414 Request-URI Too Large</title></head></html>', {
        status: 414,
        headers: { 'content-type': 'text/html' },
      });
    }
    const injected = fault?.(call, calls.filter((c) => c.table === table).length);
    if (injected) return injected;
    // Błąd zamiast rzuconego wyjątku: wyjątek w `fetch` supabase-js ponawia z odczekaniem.
    if (unknown.length > 0) return Response.json({ message: `atrapa nie zna: ${unknown.join(', ')}` }, { status: 400 });

    rows.sort((a, b) => {
      for (const { column, ascending } of order) {
        const x = String(a[column]);
        const y = String(b[column]);
        if (x !== y) return (x < y ? -1 : 1) * (ascending ? 1 : -1);
      }
      return 0;
    });
    const page = rows.slice(0, limit).slice(0, POSTGREST_MAX_ROWS);
    return Response.json(page.map((row) => Object.fromEntries(select.map((column) => [column, row[column] ?? null]))));
  }

  const client = createClient('http://kong:8000', 'klucz-testowy', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: fakeFetch },
  });
  return { client, calls };
}

let calls: Call[] = [];

function serve(tables: Record<string, Row[]>, fault?: Fault) {
  const fake = postgrest(tables, fault);
  env.client = fake.client;
  calls = fake.calls;
}

const titleReads = () => calls.filter((call) => call.table === 'flo_proposals');

/** Klucz sprawy → co klient przeczyta na liście. */
const subjectLabels = (list: Awaited<ReturnType<typeof listSilenced>>) =>
  Object.fromEntries(list.filter((entry) => !entry.wholeKind).map((entry) => [entry.key, entry.label]));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('lista wyciszeń Flo przy setkach spraw', () => {
  it('250 wyciszonych spraw: ekran się otwiera, każda sprawa ma tytuł, adres mieści się w bramce', async () => {
    serve({
      flo_decisions: range(0, 250).map((n) => decision(subject(n))),
      flo_proposals: cards(range(0, 250), 1),
    });

    const list = await listSilenced();

    expect(subjectLabels(list)).toEqual(Object.fromEntries(range(0, 250).map((n) => [subject(n), title(n, 0)])));
    expect(titleReads().length).toBeGreaterThan(1);
    for (const read of titleReads()) {
      expect(read.inValues?.length).toBeLessThanOrEqual(IN_LIST_MAX_VALUES);
      expect(read.urlChars).toBeLessThanOrEqual(GATEWAY_MAX_URL);
    }
  });

  it('1200 kart: każda sprawa podpisana NAJNOWSZĄ kartą, także za tysięcznym wierszem', async () => {
    // 100 spraw po 12 kart. Dawne jedno zapytanie (1200 wierszy) produkcja ucina do 1000.
    // Po naprawie dwie paczki (63 i 37 kluczy), a najnowsza karta sprawy 41 leży dopiero
    // na drugiej stronie pierwszej paczki, więc liczy się wybór przez granicę stron.
    serve({
      flo_decisions: [decision('payment.chase'), ...range(0, 100).map((n) => decision(subject(n)))],
      flo_proposals: cards(range(0, 100), 12),
    });

    const list = await listSilenced();

    expect(list.filter((entry) => entry.wholeKind).map((entry) => entry.key)).toEqual(['payment.chase']);
    expect(subjectLabels(list)).toEqual(Object.fromEntries(range(0, 100).map((n) => [subject(n), title(n, 11)])));
  });

  it('ponad 1000 kart w jednej paczce: tytuł także dla sprawy spoza pierwszego tysiąca', async () => {
    // Trzy sprawy to jedna paczka, ale 1201 kart. Jedno `.in()` na paczkę, bez stron,
    // dostałoby 1000 wierszy i bez błędu zgubiło resztę. Samotna karta sprawy 7 jest
    // najstarsza, ma największe `id` i leży na końcu tabeli, więc odpada po dacie
    // malejąco (jak w dawnym zapytaniu), po `id` rosnąco i bez porządku.
    const busy = cards([1, 2], 600);
    const lonely: Row = {
      id: cardId(0xf0000000, 7, 0),
      tenant_id: T,
      kind: 'payment.confirm',
      topic_key: subject(7),
      status: 'dismissed',
      title: title(7, 0),
      created_at: iso(NOW.getTime() - 10 * DAY),
    };
    expect(busy.length + 1).toBeGreaterThan(POSTGREST_MAX_ROWS);
    serve({
      flo_decisions: [1, 2, 7].map((n) => decision(subject(n))),
      flo_proposals: [...busy, lonely],
    });

    const list = await listSilenced();

    expect(subjectLabels(list)).toEqual({
      [subject(1)]: title(1, 599),
      [subject(2)]: title(2, 599),
      [subject(7)]: title(7, 0),
    });
    // Jedna paczka: ponad 1000 wierszy przeszło wyłącznie dzięki stronom.
    expect(new Set(titleReads().map((read) => (read.inValues ?? []).join(','))).size).toBe(1);
  });

  it('o tytuły pyta tylko dla spraw, które ekran pokaże', async () => {
    const muted = range(0, 12);
    // Pamięć decyzji trzyma też sprawy bez ciszy; tych u starego klienta są tysiące.
    const oneNo = range(100, 140);
    const expired = range(200, 215);
    const accepted = range(300, 308);
    serve({
      flo_decisions: [
        ...muted.map((n) => decision(subject(n))),
        ...oneNo.map((n) => decision(subject(n), { dismissed: 1, muted_until: null })),
        ...expired.map((n) => decision(subject(n), { muted_until: iso(NOW.getTime() - DAY) })),
        ...accepted.map((n) => decision(subject(n), { accepted: 1, dismissed: 0, muted_until: null })),
      ],
      flo_proposals: cards([...muted, ...oneNo, ...expired, ...accepted], 2),
    });

    const list = await listSilenced();

    const asked = titleReads().flatMap((read) => read.inValues ?? []);
    expect([...new Set(asked)].sort()).toEqual(muted.map(subject).sort());
    expect(subjectLabels(list)).toEqual(Object.fromEntries(muted.map((n) => [subject(n), title(n, 1)])));
  });

  it('błąd na dalszej stronie to błąd, nie lista bez tytułów', async () => {
    serve(
      {
        flo_decisions: range(0, 100).map((n) => decision(subject(n))),
        flo_proposals: cards(range(0, 100), 12),
      },
      (call, nth) => (call.table === 'flo_proposals' && nth === 2
        ? Response.json({ code: '57014', message: 'canceling statement due to statement timeout' }, { status: 500 })
        : null),
    );

    await expect(listSilenced()).rejects.toThrow(/statement timeout/);
  });

  it('pusta odpowiedź bez błędu to błąd, nie lista bez tytułów', async () => {
    // Pusta treść (np. od pośrednika) daje w supabase-js `data: null` i `error: null`.
    serve(
      {
        flo_decisions: range(0, 5).map((n) => decision(subject(n))),
        flo_proposals: cards(range(0, 5), 2),
      },
      (call) => (call.table === 'flo_proposals' ? new Response('', { status: 200 }) : null),
    );

    await expect(listSilenced()).rejects.toThrow(/bez danych/);
  });

  it('BEZPIECZEŃSTWO: tytuł nigdy z karty innej firmy, na żadnej stronie', async () => {
    // Klucz tematu bywa wspólny między firmami. Obce karty są nowsze i mają mniejsze `id`,
    // więc bez filtra firmy wygrałyby i w kolejności stron, i w wyborze najnowszej.
    const own = cards(range(0, 60), 12);
    const foreign = cards(range(0, 60), 12, OTHER, 0).map((row) => ({
      ...row,
      title: `TAJNY KONTRAHENT ${String(row.title)}`,
      created_at: iso(NOW.getTime() - 1000),
    }));
    serve({
      flo_decisions: range(0, 60).map((n) => decision(subject(n))),
      flo_proposals: [...foreign, ...own],
    });

    const list = await listSilenced();

    expect(subjectLabels(list)).toEqual(Object.fromEntries(range(0, 60).map((n) => [subject(n), title(n, 11)])));
    expect(titleReads().length).toBeGreaterThan(0);
    expect(titleReads().every((read) => read.url.searchParams.get('tenant_id') === `eq.${T}`)).toBe(true);
  });
});

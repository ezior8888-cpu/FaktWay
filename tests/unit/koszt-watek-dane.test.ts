import { beforeEach, describe, expect, it } from 'vitest';

/**
 * Odczyt wątku przy koszcie (plan kompletnej aplikacji, krok 6.2, część 3,
 * 00192): klient sesji (RLS: wątek tylko przy koszcie widocznym dla
 * czytającego), jawny filtr firmy i kosztu, 100 najnowszych wpisów pokazanych
 * od najstarszego. Nazwy autorów z `users` (RLS: osoby ze wspólnej firmy);
 * kto nie jest już widoczny, ma rolę z chwili wpisu.
 */

const { loadExpenseThread } = await import('@/lib/expenses/expense-thread-load');
const T = await import('@/lib/expenses/expense-thread');

type Call = {
  table: string;
  select: string | null;
  eqs: Array<[string, unknown]>;
  ins: Array<[string, unknown[]]>;
  orders: Array<[string, boolean]>;
  limit: number | null;
};

const TENANT = '33333333-3333-4333-8333-333333333333';
const EXPENSE = '11111111-1111-4111-8111-111111111111';
const ME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ANNA = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const GONE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const st = {
  calls: [] as Call[],
  comments: [] as Record<string, unknown>[],
  commentsError: null as null | { message: string },
  users: [] as Record<string, unknown>[],
  usersError: null as null | { message: string },
};

function fakeDb() {
  return {
    from: (table: string) => {
      const call: Call = { table, select: null, eqs: [], ins: [], orders: [], limit: null };
      st.calls.push(call);
      const q: Record<string, unknown> = {};
      Object.assign(q, {
        select: (columns: string) => ((call.select = columns), q),
        eq: (k: string, v: unknown) => (call.eqs.push([k, v]), q),
        in: (k: string, v: unknown[]) => (call.ins.push([k, v]), q),
        order: (k: string, o?: { ascending?: boolean }) => (call.orders.push([k, o?.ascending ?? true]), q),
        limit: (n: number) => ((call.limit = n), q),
        then: (ok: (v: unknown) => unknown, fail?: (e: unknown) => unknown) =>
          Promise.resolve(
            table === 'users'
              ? { data: st.usersError ? null : st.users, error: st.usersError }
              : { data: st.commentsError ? null : st.comments, error: st.commentsError },
          ).then(ok, fail),
      });
      return q;
    },
  };
}

// Baza oddaje wpisy od najnowszego (order desc + limit); ekran pokazuje od najstarszego.
const ROWS = [
  {
    id: 'w3', kind: 'comment', body: 'Dołączę zdjęcie.', author_id: ME, author_role: 'member',
    created_at: '2026-11-11T10:00:00Z', resolved_at: null, resolved_by: null,
  },
  {
    id: 'w2', kind: 'document_request', body: 'Proszę o fakturę zamiast paragonu.', author_id: ANNA, author_role: 'accountant',
    created_at: '2026-11-10T09:00:00Z', resolved_at: '2026-11-11T08:00:00Z', resolved_by: ME,
  },
  {
    id: 'w1', kind: 'comment', body: 'Czy to koszt firmowy?', author_id: GONE, author_role: 'owner',
    created_at: '2026-11-09T08:00:00Z', resolved_at: null, resolved_by: null,
  },
];

const load = () => loadExpenseThread(fakeDb() as never, { tenantId: TENANT, expenseId: EXPENSE, userId: ME });

beforeEach(() => {
  st.calls = [];
  st.comments = ROWS;
  st.commentsError = null;
  st.users = [{ id: ANNA, name: '  Anna Księgowa ' }];
  st.usersError = null;
});

describe('loadExpenseThread', () => {
  it('wpisy od najstarszego, filtr firmy i kosztu, 100 najnowszych; „Ty” dla siebie, nazwa ze wspólnej firmy, rola dla osoby spoza firmy', async () => {
    const wynik = await load();

    expect(wynik).toEqual({
      ok: true,
      truncated: false,
      entries: [
        {
          id: 'w1', kind: 'comment', body: 'Czy to koszt firmowy?', createdAt: '2026-11-09T08:00:00Z',
          authorLabel: 'Właściciel', authorRoleLabel: null, mine: false, resolvedAt: null, resolvedByLabel: null,
        },
        {
          id: 'w2', kind: 'document_request', body: 'Proszę o fakturę zamiast paragonu.', createdAt: '2026-11-10T09:00:00Z',
          authorLabel: 'Anna Księgowa', authorRoleLabel: 'księgowy', mine: false, resolvedAt: '2026-11-11T08:00:00Z', resolvedByLabel: 'Ty',
        },
        {
          id: 'w3', kind: 'comment', body: 'Dołączę zdjęcie.', createdAt: '2026-11-11T10:00:00Z',
          authorLabel: 'Ty', authorRoleLabel: 'członek', mine: true, resolvedAt: null, resolvedByLabel: null,
        },
      ],
    });

    const [watek, nazwy] = st.calls;
    expect(watek).toMatchObject({
      table: 'expense_comments',
      select: 'id, kind, body, author_id, author_role, created_at, resolved_at, resolved_by',
      eqs: [['tenant_id', TENANT], ['expense_id', EXPENSE]],
      orders: [['created_at', false], ['id', false]],
      limit: T.EXPENSE_THREAD_LIMIT,
    });
    expect(T.EXPENSE_THREAD_LIMIT).toBe(100);
    // Nazwy tylko innych osób (siebie podpisujemy „Ty”), każda raz.
    expect(nazwy).toMatchObject({ table: 'users', select: 'id, name' });
    expect(nazwy!.ins).toEqual([['id', [GONE, ANNA]]]);
    expect(st.calls).toHaveLength(2);
  });

  it('usunięte konto, prośba załatwiona przez osobę spoza firmy, nieznany rodzaj i zły wiersz z bazy', async () => {
    st.comments = [
      {
        id: 'x1', kind: 'document_request', body: 'Faktura?', author_id: null, author_role: 'accountant',
        created_at: '2026-11-09T08:00:00Z', resolved_at: '2026-11-10T08:00:00Z', resolved_by: GONE,
      },
      {
        id: 'x2', kind: 'document_request', body: 'Paragon?', author_id: ANNA, author_role: 'accountant',
        created_at: '2026-11-09T09:00:00Z', resolved_at: '2026-11-10T09:00:00Z', resolved_by: null,
      },
      { id: 'x3', kind: 'notatka', body: 'Inny rodzaj', author_id: ANNA, author_role: 'member', created_at: '2026-11-09T10:00:00Z', resolved_at: null, resolved_by: null },
      { id: 'x4', kind: 'comment', body: null, author_id: ANNA, author_role: 'member', created_at: '2026-11-09T11:00:00Z', resolved_at: null, resolved_by: null },
    ];

    const wynik = await load();
    expect(wynik.ok && wynik.entries.map((e) => [e.id, e.authorLabel, e.authorRoleLabel, e.resolvedByLabel])).toEqual([
      ['x2', 'Anna Księgowa', 'księgowy', 'Konto usunięte'],
      ['x1', 'Konto usunięte', 'księgowy', 'Osoba spoza firmy'],
    ]);
  });

  it('błąd odczytu wątku: stan błędu z wyjściem, nie pusta lista i bez drugiego zapytania', async () => {
    st.commentsError = { message: 'relation "expense_comments" does not exist' };

    await expect(load()).resolves.toEqual({ ok: false, error: T.THREAD_LOAD_ERROR });
    expect(st.calls).toHaveLength(1);
  });

  it('błąd odczytu nazw: wpisy z rolą zamiast nazwy (wątek dalej widoczny)', async () => {
    st.usersError = { message: 'timeout' };

    const wynik = await load();
    expect(wynik.ok && wynik.entries.map((e) => e.authorLabel)).toEqual(['Właściciel', 'Księgowy', 'Ty']);
  });

  it('pełny limit: znacznik „widać tylko ostatnie”; bez wpisów: bez zapytania o nazwy', async () => {
    st.comments = Array.from({ length: 100 }, (_, i) => ({
      id: `k${i}`, kind: 'comment', body: `Wpis ${i}`, author_id: ME, author_role: 'owner',
      created_at: new Date(Date.UTC(2026, 10, 11, 10, 0, 100 - i)).toISOString(), resolved_at: null, resolved_by: null,
    }));
    const pelny = await load();
    expect(pelny.ok && pelny.truncated).toBe(true);
    expect(pelny.ok && pelny.entries[0]!.id).toBe('k99');
    expect(st.calls.filter((c) => c.table === 'users')).toEqual([]);

    st.calls = [];
    st.comments = [];
    await expect(load()).resolves.toEqual({ ok: true, entries: [], truncated: false });
    expect(st.calls.map((c) => c.table)).toEqual(['expense_comments']);
  });
});

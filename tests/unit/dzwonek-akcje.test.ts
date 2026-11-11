import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Akcje dzwonka (plan kompletnej aplikacji, krok 8.1, część 2, 00188):
 * odczyt ostatnich 20 wpisów i liczby nieprzeczytanych oraz oznaczanie jako
 * przeczytane. Klient sesji (RLS) z jawnym filtrem firmy i użytkownika;
 * datę przeczytania ustawia tylko RPC `app_notifications_mark_read`.
 * Polityki i RPC na prawdziwej bazie: `tests/rls-powiadomienia-w-aplikacji.test.ts`.
 */

type Call = {
  table: string;
  select: string | null;
  head: boolean;
  eqs: Array<[string, unknown]>;
  is: Array<[string, unknown]>;
  orders: Array<[string, boolean]>;
  limit: number | null;
};

const st = vi.hoisted(() => ({
  auth: vi.fn(),
  calls: [] as Call[],
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  rows: [] as Record<string, unknown>[],
  count: 0,
  listError: null as null | { message: string },
  countError: null as null | { message: string },
  rpcResult: { data: 1, error: null } as { data: unknown; error: null | { message: string } },
}));

function fakeSupabase() {
  return {
    from: (table: string) => {
      const call: Call = { table, select: null, head: false, eqs: [], is: [], orders: [], limit: null };
      st.calls.push(call);
      const q: Record<string, unknown> = {};
      Object.assign(q, {
        select: (columns: string, opts?: { head?: boolean }) => ((call.select = columns), (call.head = Boolean(opts?.head)), q),
        eq: (k: string, v: unknown) => (call.eqs.push([k, v]), q),
        is: (k: string, v: unknown) => (call.is.push([k, v]), q),
        order: (k: string, o?: { ascending?: boolean }) => (call.orders.push([k, o?.ascending ?? true]), q),
        limit: (n: number) => ((call.limit = n), q),
        then: (ok: (v: unknown) => unknown, fail?: (e: unknown) => unknown) =>
          Promise.resolve(
            call.head
              ? { data: null, count: st.countError ? null : st.count, error: st.countError }
              : { data: st.listError ? null : st.rows, error: st.listError },
          ).then(ok, fail),
      });
      return q;
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      st.rpcCalls.push({ fn, args });
      return st.rpcResult;
    },
  };
}

vi.mock('@/lib/supabase/auth-context', () => {
  class ActionAuthError extends Error {}
  return { ActionAuthError, requireUserAndActiveOrg: st.auth };
});

const { loadAppNotificationsAction, markAppNotificationsReadAction } = await import('@/app/actions/app-notifications');
const { ActionAuthError } = await import('@/lib/supabase/auth-context');

const N1 = '11111111-1111-4111-8111-111111111111';
const N2 = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  vi.clearAllMocks();
  st.calls = [];
  st.rpcCalls = [];
  st.rows = [];
  st.count = 0;
  st.listError = null;
  st.countError = null;
  st.rpcResult = { data: 1, error: null };
  st.auth.mockResolvedValue({ supabase: fakeSupabase(), tenantId: 'ten-1', user: { id: 'u-1' }, role: 'member' });
});

describe('loadAppNotificationsAction', () => {
  it('ostatnie 20 wpisów użytkownika w aktywnej firmie, od najnowszych, i liczba nieprzeczytanych', async () => {
    st.rows = [
      { id: N1, kind: 'inbox_new', title: 'Nowa faktura zakupu', body: 'FV 1', link: '/expenses/e1', created_at: '2026-11-11T07:00:00Z', read_at: null },
      { id: N2, kind: 'tax_deadline', title: 'Termin', body: null, link: '/reports/ten-miesiac?month=10&year=2026', created_at: '2026-11-10T07:00:00Z', read_at: '2026-11-10T08:00:00Z' },
    ];
    st.count = 7;
    await expect(loadAppNotificationsAction()).resolves.toEqual({
      success: true,
      unread: 7,
      items: [
        { id: N1, kind: 'inbox_new', title: 'Nowa faktura zakupu', body: 'FV 1', link: '/expenses/e1', createdAt: '2026-11-11T07:00:00Z', read: false },
        { id: N2, kind: 'tax_deadline', title: 'Termin', body: null, link: '/reports/ten-miesiac?month=10&year=2026', createdAt: '2026-11-10T07:00:00Z', read: true },
      ],
    });
    const lista = st.calls.find((c) => !c.head)!;
    const licznik = st.calls.find((c) => c.head)!;
    expect(lista).toMatchObject({ table: 'app_notifications', limit: 20 });
    expect(lista.eqs).toEqual([['tenant_id', 'ten-1'], ['user_id', 'u-1']]);
    expect(lista.orders[0]).toEqual(['created_at', false]);
    expect(licznik.eqs).toEqual([['tenant_id', 'ten-1'], ['user_id', 'u-1']]);
    expect(licznik.is).toEqual([['read_at', null]]);
  });

  it('link spoza aplikacji i nieznany rodzaj z bazy nie trafiają do przeglądarki', async () => {
    st.rows = [
      { id: N1, kind: 'inbox_new', title: 'A', body: null, link: 'https://evil.example', created_at: '2026-11-11T07:00:00Z', read_at: null },
      { id: N2, kind: 'cos_innego', title: 'B', body: null, link: null, created_at: '2026-11-10T07:00:00Z', read_at: null },
    ];
    const wynik = await loadAppNotificationsAction();
    expect(wynik.success && wynik.items).toEqual([
      { id: N1, kind: 'inbox_new', title: 'A', body: null, link: null, createdAt: '2026-11-11T07:00:00Z', read: false },
    ]);
  });

  it('bez sesji albo firmy: komunikat, bez zapytań', async () => {
    st.auth.mockRejectedValue(new ActionAuthError('Brak aktywnej organizacji'));
    await expect(loadAppNotificationsAction()).resolves.toEqual({ success: false, error: 'Brak aktywnej organizacji' });
    expect(st.calls).toEqual([]);
  });

  it('błąd bazy (np. tabela jeszcze niewgrana): komunikat z wyjściem, nie wyjątek', async () => {
    st.listError = { message: 'relation "app_notifications" does not exist' };
    await expect(loadAppNotificationsAction()).resolves.toEqual({
      success: false,
      error: 'Nie udało się wczytać powiadomień. Spróbuj ponownie za chwilę.',
    });
  });
});

describe('markAppNotificationsReadAction', () => {
  it('bez listy: wszystkie nieprzeczytane w aktywnej firmie (p_ids = null)', async () => {
    st.rpcResult = { data: 3, error: null };
    await expect(markAppNotificationsReadAction()).resolves.toEqual({ success: true, updated: 3 });
    expect(st.rpcCalls).toEqual([{ fn: 'app_notifications_mark_read', args: { p_ids: null } }]);
  });

  it('jeden wpis po kliknięciu', async () => {
    await expect(markAppNotificationsReadAction([N1])).resolves.toEqual({ success: true, updated: 1 });
    expect(st.rpcCalls).toEqual([{ fn: 'app_notifications_mark_read', args: { p_ids: [N1] } }]);
  });

  it('zła lista z przeglądarki: odmowa bez zapytania', async () => {
    for (const ids of [['nie-uuid'], Array.from({ length: 21 }, () => N1), 'x' as unknown as string[]]) {
      await expect(markAppNotificationsReadAction(ids)).resolves.toMatchObject({ success: false });
    }
    expect(st.rpcCalls).toEqual([]);
  });

  it('błąd bazy: komunikat, nie wyjątek', async () => {
    st.rpcResult = { data: null, error: { message: 'x' } };
    await expect(markAppNotificationsReadAction()).resolves.toEqual({
      success: false,
      error: 'Nie udało się oznaczyć powiadomień. Spróbuj ponownie za chwilę.',
    });
  });
});

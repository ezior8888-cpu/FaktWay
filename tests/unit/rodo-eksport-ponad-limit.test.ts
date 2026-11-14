import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

/**
 * Sesja 29 planu skalowania: eksport danych konta (art. 15 i 20 RODO) czytał
 * każdą sekcję jednym zapytaniem z `limit(1000)`. PostgREST na produkcji
 * (`PGRST_DB_MAX_ROWS = 1000`) i tak ucina odpowiedź bez błędu, więc osoba
 * z 1500 wpisami audytu dostawała 1000 najnowszych, a biuro rachunkowe
 * w 1001 firmach traciło jedno członkostwo. Atrapa niżej ucina KAŻDĄ
 * odpowiedź SELECT do 1000 wierszy jak produkcja. Eksport ma oddać komplet
 * albo błąd, nigdy cichy kawałek.
 */

const pg = vi.hoisted(() => {
  type R = Record<string, unknown>;
  const MAX_ROWS = 1000;
  const state = {
    tables: {} as Record<string, R[]>,
    /** Każde zapytanie: tabela, liczba wartości w `in(...)` i czy to sam licznik. */
    requests: [] as Array<{ table: string; inValues: number; head: boolean }>,
    /** n-te zapytanie (od 1) do tabeli kończy się błędem bazy. */
    failure: null as null | { table: string; nth: number },
    /** Zapisy w trakcie eksportu: po n-tym zapytaniu (od 1) do tabeli dochodzi wiersz. */
    inserts: [] as Array<{ table: string; nth: number; row: R }>,
  };
  // Porządek bajtów jak w Postgresie (uuid, znaczniki czasu ISO), nie localeCompare.
  const cmp = (a: unknown, b: unknown) => {
    const x = String(a ?? '');
    const y = String(b ?? '');
    return x < y ? -1 : x > y ? 1 : 0;
  };
  function from(table: string) {
    const filters: Array<(row: R) => boolean> = [];
    const orders: Array<[string, boolean]> = [];
    let columns: string[] = [];
    let counted = false;
    let head = false;
    let limit: number | null = null;
    let inValues = 0;
    const run = () => {
      const nth = state.requests.filter((r) => r.table === table).length + 1;
      state.requests.push({ table, inValues, head });
      if (state.failure?.table === table && state.failure.nth === nth) {
        return { data: null, count: null, error: { message: 'canceling statement due to statement timeout' } };
      }
      const hits = (state.tables[table] ?? []).filter((row) => filters.every((f) => f(row)));
      hits.sort((a, b) => {
        for (const [key, ascending] of orders) {
          const c = cmp(a[key], b[key]);
          if (c !== 0) return ascending ? c : -c;
        }
        return 0;
      });
      const total = hits.length;
      const page = hits.slice(0, limit ?? hits.length).slice(0, MAX_ROWS);
      const data = page.map((row) => Object.fromEntries(columns.filter((c) => c in row).map((c) => [c, row[c]])));
      for (const insert of state.inserts) {
        if (insert.table === table && insert.nth === nth) state.tables[table]!.push(insert.row);
      }
      return { data: head ? null : data, count: counted ? total : null, error: null };
    };
    const query = {
      select(cols: string, options?: { count?: string; head?: boolean }) {
        columns = cols.split(',').map((c) => c.trim());
        counted = options?.count === 'exact';
        head = options?.head === true;
        return query;
      },
      eq(key: string, value: unknown) { filters.push((row) => row[key] === value); return query; },
      in(key: string, values: unknown[]) {
        inValues = values.length;
        filters.push((row) => values.includes(row[key]));
        return query;
      },
      gt(key: string, value: unknown) { filters.push((row) => cmp(row[key], value) > 0); return query; },
      order(key: string, options?: { ascending?: boolean }) { orders.push([key, options?.ascending ?? true]); return query; },
      limit(n: number) { limit = n; return query; },
      returns() { return query; },
      then<A, B>(ok: (v: ReturnType<typeof run>) => A, fail?: (e: unknown) => B) {
        return Promise.resolve().then(run).then(ok, fail);
      },
    };
    return query;
  }
  return { state, from };
});

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const EMAIL = 'wlasciciel@example.test';

vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: () => ({
    auth: {
      admin: {
        getUserById: async (id: string) => ({
          data: { user: { id, email: EMAIL, created_at: '2026-01-01T00:00:00.000Z', last_sign_in_at: null, user_metadata: {} } },
          error: null,
        }),
      },
    },
    from: pg.from,
  }),
}));

import { collectUserData } from '@/lib/gdpr/data-collector';

type Row = Record<string, unknown>;

/** uuid małymi literami: porządek napisów w JS = porządek uuid w Postgresie. */
const uuid = (n: number, x = 'a') => `${String(n).padStart(8, '0')}-${x.repeat(4)}-4${x.repeat(3)}-8${x.repeat(3)}-${x.repeat(12)}`;
/**
 * Kolejność wstawiania ≠ kolejność id: bez ORDER BY baza oddaje wiersze
 * w kolejności sterty. 7919 jest liczbą pierwszą, więc dla liczności
 * niepodzielnych przez 7919 to permutacja 1..count.
 */
const heapOrder = (count: number) => Array.from({ length: count }, (_, i) => ((i * 7919) % count) + 1);
const at = (second: number) => new Date(Date.UTC(2026, 0, 1) + second * 1000).toISOString();
const byte = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Wpisy audytu osoby: czas niezależny od id (inna permutacja), parami ten
 * sam stempel, żeby sprawdzić rozstrzyganie remisu po id.
 */
function ownAudit(count: number): Row[] {
  return heapOrder(count).map((n) => ({
    id: uuid(n), user_id: USER, action: `akcja-${n}`, entity_type: null, entity_id: null, metadata: null,
    created_at: at(Math.floor(((n * 3571) % count) / 2)),
  }));
}

beforeEach(() => {
  pg.state.requests = [];
  pg.state.failure = null;
  pg.state.inserts = [];
  pg.state.tables = {
    users: [{ id: USER, name: 'Jan Testowy', last_login: null, created_at: at(0) }],
    memberships: [], audit_logs: [], email_preferences: [], push_subscriptions: [], user_passkeys: [],
    support_conversations: [], support_messages: [], organization_join_requests: [], organization_invitations: [],
    gdpr_deletion_requests: [], newsletter_subscribers: [], email_bounces: [],
  };
});

describe('eksport danych konta ponad limit wierszy PostgREST (sesja 29)', () => {
  it('1500 wpisów audytu: plik ma wszystkie, od najnowszego, z pełnym pokryciem', async () => {
    const own = ownAudit(1500);
    // Cudze wpisy przeplatają się z własnymi w kolejności id: filtr osoby musi iść na każdej stronie.
    const foreign = heapOrder(300).map((n) => ({
      id: uuid(n, 'b'), user_id: OTHER, action: 'cudza-akcja', entity_type: null, entity_id: null, metadata: null, created_at: at(n),
    }));
    pg.state.tables.audit_logs = [...own.slice(0, 700), ...foreign, ...own.slice(700)];

    const data = await collectUserData(USER);

    const newestFirst = [...own]
      .sort((a, b) => byte(String(b.created_at), String(a.created_at)) || byte(String(a.id), String(b.id)))
      .map((row) => row.id);
    expect(data.audit_logs).toHaveLength(1500);
    expect(data.audit_logs.map((a) => a.id)).toEqual(newestFirst);
    expect(data.coverage.audit_logs).toEqual({ returned: 1500, total: 1500, truncated: false });
    expect(JSON.stringify(data.audit_logs)).not.toContain('cudza-akcja');
  });

  it('biuro rachunkowe w 1001 firmach: wszystkie członkostwa i wszystkie firmy, których jest właścicielem', async () => {
    pg.state.tables.memberships = [
      ...heapOrder(1001).map((n) => ({
        id: uuid(n), user_id: USER, organization_id: uuid(n, 'c'), role: n % 2 ? 'owner' : 'admin',
        status: 'active', joined_at: at(n), revoked_at: null,
      })),
      { id: uuid(5, 'b'), user_id: OTHER, organization_id: uuid(5, 'd'), role: 'owner', status: 'active', joined_at: at(5), revoked_at: null },
    ];

    const data = await collectUserData(USER);

    expect(data.memberships).toHaveLength(1001);
    expect(data.memberships.map((m) => m.id)).toEqual(heapOrder(1001).map((n) => uuid(n)).sort(byte));
    expect(data.organizations_owned).toHaveLength(501);
    expect(data.coverage.memberships).toEqual({ returned: 1001, total: 1001, truncated: false });
  });

  it('1200 odbić poczty i 1100 wiadomości pomocy: komplet, chronologicznie, bez klucza stron w pliku', async () => {
    pg.state.tables.email_bounces = heapOrder(1200).map((n) => ({
      id: uuid(n), email: EMAIL, bounce_type: 'soft', reason: `skrzynka pełna ${n}`, occurred_at: at(n), raw_payload: { s: 'sekret' },
    }));
    const conversations = heapOrder(150).map((n) => ({
      id: uuid(n), user_id: USER, status: 'closed', category: 'faktury', subject: `Pytanie ${n}`, created_at: at(n),
    }));
    const foreignConversation = { id: uuid(1, 'b'), user_id: OTHER, status: 'open', category: 'inne', subject: 'cudza rozmowa', created_at: at(1) };
    pg.state.tables.support_conversations = [...conversations, foreignConversation];
    pg.state.tables.support_messages = [
      ...heapOrder(1100).map((n) => ({
        id: uuid(n), conversation_id: uuid((n % 150) + 1), role: n % 2 ? 'user' : 'assistant',
        content: `wiadomość ${n}`, created_at: at(5000 - n),
      })),
      { id: uuid(1, 'b'), conversation_id: foreignConversation.id, role: 'user', content: 'cudza wiadomość', created_at: at(1) },
    ];

    const data = await collectUserData(USER);

    expect(data.email_bounces).toHaveLength(1200);
    expect(data.email_bounces.some((bounce) => 'id' in bounce)).toBe(false);
    expect(data.coverage.email_bounces).toEqual({ returned: 1200, total: 1200, truncated: false });

    expect(data.support_conversations).toHaveLength(150);
    const messages = data.support_conversations.flatMap((conversation) => conversation.messages);
    expect(messages).toHaveLength(1100);
    expect(messages.some((message) => 'id' in message)).toBe(false);
    for (const conversation of data.support_conversations) {
      const times = conversation.messages.map((message) => String(message.created_at));
      expect(times).toEqual([...times].sort(byte));
    }
    expect(data.coverage.support_messages).toEqual({ returned: 1100, total: 1100, truncated: false });
    expect(JSON.stringify(data)).not.toContain('cudza');
    expect(JSON.stringify(data)).not.toContain('sekret');

    // Lista rozmów idzie w adresie zapytania: najwyżej 100 identyfikatorów naraz.
    const inSizes = pg.state.requests.filter((r) => r.table === 'support_messages').map((r) => r.inValues);
    expect(Math.max(...inSizes)).toBeLessThanOrEqual(100);
  });

  it('błąd bazy na dalszej stronie audytu: odmowa zamiast pliku z częścią wpisów', async () => {
    pg.state.tables.audit_logs = ownAudit(1500);
    pg.state.failure = { table: 'audit_logs', nth: 2 };

    await expect(collectUserData(USER)).rejects.toThrow(/^account_export_data_unavailable$/);
    // Błąd bazy to nie zmiana danych: bez ponownej próby (dwie strony, koniec).
    expect(pg.state.requests.filter((request) => request.table === 'audit_logs')).toHaveLength(2);
  });

  /** Nowy wpis audytu tej osoby (logowanie w drugiej karcie, job). */
  const login = (n: number): Row => ({
    id: uuid(n), user_id: USER, action: 'auth.login', entity_type: null, entity_id: null, metadata: null, created_at: at(9000 + n),
  });

  it('wpis audytu dopisany w trakcie odczytu: sekcja jeszcze raz od początku, plik z kompletem', async () => {
    pg.state.tables.audit_logs = ownAudit(1500);
    pg.state.inserts = [{ table: 'audit_logs', nth: 1, row: login(9999) }];

    const data = await collectUserData(USER);

    expect(data.audit_logs).toHaveLength(1501);
    expect(data.audit_logs[0]?.id).toBe(uuid(9999));
    expect(data.coverage.audit_logs).toEqual({ returned: 1501, total: 1501, truncated: false });
    // Pierwszy odczyt: 3 strony i licznik kontrolny (1501 ≠ 1500); drugi: 4 strony i licznik.
    expect(pg.state.requests.filter((request) => request.table === 'audit_logs')).toHaveLength(9);
  });

  it('wpisy dopisywane w trakcie obu odczytów: odmowa, bez trzeciej próby', async () => {
    pg.state.tables.audit_logs = ownAudit(1500);
    // Drugi wpis ma najmniejsze id: drugi odczyt nie widzi go na stronach, widzi go licznik kontrolny.
    pg.state.inserts = [
      { table: 'audit_logs', nth: 1, row: login(9999) },
      { table: 'audit_logs', nth: 5, row: login(0) },
    ];

    await expect(collectUserData(USER)).rejects.toThrow(/^account_export_count_unavailable$/);
    expect(pg.state.requests.filter((request) => request.table === 'audit_logs')).toHaveLength(9);
  });

  it('zwykłe konto: każda tabela jednym zapytaniem, bez licznika kontrolnego', async () => {
    pg.state.tables.audit_logs = ownAudit(40);
    pg.state.tables.memberships = [
      { id: uuid(1), user_id: USER, organization_id: uuid(1, 'c'), role: 'owner', status: 'active', joined_at: at(1), revoked_at: null },
    ];

    const data = await collectUserData(USER);

    expect(data.audit_logs).toHaveLength(40);
    const perTable = new Map<string, number>();
    for (const request of pg.state.requests) perTable.set(request.table, (perTable.get(request.table) ?? 0) + 1);
    expect([...perTable.values()].every((count) => count === 1)).toBe(true);
    expect(pg.state.requests.some((request) => request.head)).toBe(false);
  });
});

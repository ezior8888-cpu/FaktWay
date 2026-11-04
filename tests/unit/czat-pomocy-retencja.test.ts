/**
 * Retencja rozmów z czatem pomocy.
 *
 * Polityka prywatności (pkt 3, wiersz „Kontakt i pomoc techniczna, w tym czat
 * z asystentem AI”) obiecuje: „do 24 miesięcy od ostatniej wiadomości”. Do
 * 15.10.2026 nic tych tabel nie czyściło, a po usunięciu konta rozmowy
 * zostawały z `user_id = NULL` (ON DELETE SET NULL, migracja 00054) — z pełną
 * treścią wiadomości, na zawsze.
 *
 * Atrapa bazy stosuje filtry do wierszy (lt/gte/gt/is/not/in/eq) i kasuje
 * wiadomości kaskadowo, jak `ON DELETE CASCADE` w 00054 — pominięty albo
 * zły filtr zmienia wynik testu.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';

const mocks = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
  captureMessage: vi.fn(),
  addBreadcrumb: vi.fn(),
}));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: mocks.createAdminClient }));
vi.mock('@sentry/nextjs', () => ({
  captureMessage: mocks.captureMessage,
  addBreadcrumb: mocks.addBreadcrumb,
}));

import { runSupportChatRetention } from '@/lib/jobs/runners/support-chat-retention';
import {
  purgeExpiredSupportConversations,
  SUPPORT_CHAT_RETENTION_MONTHS,
  SUPPORT_RETENTION_PAGE,
  supportChatCutoff,
} from '@/lib/support/retention';

type AdminClient = Parameters<typeof purgeExpiredSupportConversations>[0];

interface Conversation {
  id: string;
  user_id: string | null;
  created_at: string;
  updated_at: string;
}
interface Message {
  id: string;
  conversation_id: string;
  created_at: string;
}
type Row = Conversation | Message;
type Table = 'support_conversations' | 'support_messages';

const NOW = new Date('2026-10-15T01:30:00.000Z');
// 24 miesiące wstecz od NOW.
const CUTOFF = '2024-10-15T01:30:00.000Z';
const minutes = (iso: string, delta: number) =>
  new Date(new Date(iso).getTime() + delta * 60_000).toISOString();

const USER = 'synthetic-user-a';
const OTHER = 'synthetic-user-b';

/** Id w formacie UUID, rosnące jak w kolejności `ORDER BY id`. */
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function database(state: { conversations: Conversation[]; messages: Message[] }) {
  const calls: Array<{ table: Table; op: 'select' | 'delete' }> = [];
  const failures: Partial<Record<`${Table}:${'select' | 'delete'}`, string>> = {};
  let ignoreGt = false;

  const from = vi.fn((table: Table) => {
    const filters: Array<(row: Row) => boolean> = [];
    let op: 'select' | 'delete' = 'select';
    let orderBy: string | null = null;
    let limit = Number.POSITIVE_INFINITY;
    const field = (row: Row, key: string) => Reflect.get(row, key) as string | null;

    const execute = () => {
      calls.push({ table, op });
      const failure = failures[`${table}:${op}`];
      if (failure) return { data: null, error: { message: failure }, count: null };
      const rows: Row[] = table === 'support_conversations' ? state.conversations : state.messages;
      let matching = rows.filter((row) => filters.every((f) => f(row)));
      if (orderBy) {
        const key = orderBy;
        matching = [...matching].sort((a, b) => String(field(a, key)).localeCompare(String(field(b, key))));
      }
      matching = matching.slice(0, limit);
      if (op === 'delete') {
        const ids = new Set(matching.map((row) => row.id));
        if (table === 'support_conversations') {
          state.conversations = state.conversations.filter((row) => !ids.has(row.id));
          // ON DELETE CASCADE z 00054.
          state.messages = state.messages.filter((m) => !ids.has(m.conversation_id));
        } else {
          state.messages = state.messages.filter((row) => !ids.has(row.id));
        }
        return { data: null, error: null, count: ids.size };
      }
      return { data: matching.map((row) => ({ ...row })), error: null, count: null };
    };

    const query = {
      select: () => query,
      delete: () => { op = 'delete'; return query; },
      eq: (key: string, value: string) => { filters.push((r) => field(r, key) === value); return query; },
      is: (key: string, value: null) => { filters.push((r) => field(r, key) === value); return query; },
      not: (key: string, operator: string, value: null) => {
        expect(operator).toBe('is');
        filters.push((r) => field(r, key) !== value);
        return query;
      },
      lt: (key: string, value: string) => { filters.push((r) => String(field(r, key)) < value); return query; },
      gte: (key: string, value: string) => { filters.push((r) => String(field(r, key)) >= value); return query; },
      gt: (key: string, value: string) => {
        if (!ignoreGt) filters.push((r) => String(field(r, key)) > value);
        return query;
      },
      in: (key: string, values: string[]) => {
        filters.push((r) => values.includes(String(field(r, key))));
        return query;
      },
      order: (key: string) => { orderBy = key; return query; },
      limit: (n: number) => { limit = n; return query; },
      then: (
        onfulfilled: (value: ReturnType<typeof execute>) => unknown,
        onrejected?: (reason: unknown) => unknown,
      ) => Promise.resolve().then(execute).then(onfulfilled, onrejected),
    };
    return query;
  });

  return {
    client: { from } as unknown as AdminClient,
    state,
    calls,
    fail: (key: `${Table}:${'select' | 'delete'}`, message: string) => { failures[key] = message; },
    ignoreKeyset: () => { ignoreGt = true; },
  };
}

function conversation(n: number, userId: string | null, createdAt: string, updatedAt = createdAt): Conversation {
  return { id: uuid(n), user_id: userId, created_at: createdAt, updated_at: updatedAt };
}
function message(n: number, conversationN: number, createdAt: string): Message {
  return { id: `msg-${n}`, conversation_id: uuid(conversationN), created_at: createdAt };
}
const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('termin retencji czatu pomocy', () => {
  it('24 miesiące — ta sama liczba co w polityce prywatności', () => {
    expect(SUPPORT_CHAT_RETENTION_MONTHS).toBe(24);
    expect(supportChatCutoff(NOW).toISOString()).toBe(CUTOFF);
  });
});

describe('purgeExpiredSupportConversations — „24 miesiące od ostatniej wiadomości”', () => {
  it('usuwa rozmowę (z wiadomościami), której ostatnia wiadomość jest starsza niż 24 miesiące', async () => {
    const db = database({
      conversations: [conversation(1, USER, '2023-05-01T10:00:00.000Z')],
      messages: [
        message(1, 1, '2023-05-01T10:00:01.000Z'),
        message(2, 1, minutes(CUTOFF, -1)),
      ],
    });

    const result = await purgeExpiredSupportConversations(db.client, NOW);

    expect(db.state.conversations).toEqual([]);
    expect(db.state.messages).toEqual([]);
    expect(result).toMatchObject({ cutoff: CUTOFF, deleted_expired: 1, deleted_orphaned: 0, kept_active: 0 });
  });

  it('zostawia rozmowę sprzed 24 miesięcy, w której ostatnia wiadomość jest świeższa', async () => {
    const db = database({
      conversations: [conversation(1, USER, '2023-05-01T10:00:00.000Z')],
      messages: [
        message(1, 1, '2023-05-01T10:00:01.000Z'),
        message(2, 1, '2024-01-01T10:00:00.000Z'),
        message(3, 1, minutes(CUTOFF, 1)),
      ],
    });

    const result = await purgeExpiredSupportConversations(db.client, NOW);

    expect(ids(db.state.conversations)).toEqual([uuid(1)]);
    expect(db.state.messages).toHaveLength(3);
    expect(result).toMatchObject({ deleted_expired: 0, kept_active: 1 });
  });

  it('liczy od WIADOMOŚCI, nie od `updated_at`: nieudane podbicie nie kasuje aktywnej rozmowy', async () => {
    // `appendMessage` podbija `updated_at` osobnym zapytaniem i ignoruje błąd,
    // więc stare `updated_at` nie dowodzi, że rozmowa milczy.
    const db = database({
      conversations: [conversation(1, USER, '2023-05-01T10:00:00.000Z', '2023-05-01T10:00:00.000Z')],
      messages: [message(1, 1, '2026-10-14T09:00:00.000Z')],
    });

    await purgeExpiredSupportConversations(db.client, NOW);

    expect(ids(db.state.conversations)).toEqual([uuid(1)]);
  });

  it('świeże `updated_at` bez nowej wiadomości nie przedłuża przechowywania', async () => {
    const db = database({
      conversations: [conversation(1, USER, '2023-05-01T10:00:00.000Z', '2026-10-01T00:00:00.000Z')],
      messages: [message(1, 1, '2023-05-01T10:00:01.000Z')],
    });

    await purgeExpiredSupportConversations(db.client, NOW);

    expect(db.state.conversations).toEqual([]);
  });

  it('usuwa starą rozmowę bez żadnej wiadomości (zapis odpowiedzi padł po utworzeniu wątku)', async () => {
    const db = database({
      conversations: [conversation(1, USER, minutes(CUTOFF, -5))],
      messages: [],
    });

    await purgeExpiredSupportConversations(db.client, NOW);

    expect(db.state.conversations).toEqual([]);
  });

  it('zostawia świeżą rozmowę, do której wiadomość jeszcze nie doszła', async () => {
    // `createConversation` i `appendMessage` to dwa osobne zapisy — między
    // nimi rozmowa nie ma wiadomości, ale nie jest „po terminie”.
    const db = database({
      conversations: [conversation(1, USER, minutes(NOW.toISOString(), -1))],
      messages: [],
    });

    await purgeExpiredSupportConversations(db.client, NOW);

    expect(ids(db.state.conversations)).toEqual([uuid(1)]);
  });

  it('nie rusza świeżych rozmów ani cudzych wiadomości', async () => {
    const db = database({
      conversations: [
        conversation(1, USER, '2023-05-01T10:00:00.000Z'),
        conversation(2, OTHER, '2026-09-01T10:00:00.000Z'),
      ],
      messages: [
        message(1, 1, '2023-05-01T10:00:01.000Z'),
        message(2, 2, '2026-09-01T10:00:01.000Z'),
      ],
    });

    await purgeExpiredSupportConversations(db.client, NOW);

    expect(ids(db.state.conversations)).toEqual([uuid(2)]);
    expect(ids(db.state.messages)).toEqual(['msg-2']);
  });

  it('usuwa od razu rozmowy bez właściciela (konto już usunięte) — niezależnie od wieku', async () => {
    const db = database({
      conversations: [
        conversation(1, null, '2026-10-10T10:00:00.000Z'),
        conversation(2, USER, '2026-10-10T10:00:00.000Z'),
      ],
      messages: [
        message(1, 1, '2026-10-10T10:00:01.000Z'),
        message(2, 2, '2026-10-10T10:00:01.000Z'),
      ],
    });

    const result = await purgeExpiredSupportConversations(db.client, NOW);

    expect(ids(db.state.conversations)).toEqual([uuid(2)]);
    expect(ids(db.state.messages)).toEqual(['msg-2']);
    expect(result).toMatchObject({ deleted_orphaned: 1, deleted_expired: 0 });
  });
});

describe('purgeExpiredSupportConversations — paczki i stronicowanie', () => {
  it('przechodzi wszystkie strony, gdy aktywne stare rozmowy NIE wypadają z filtra', async () => {
    // Stare (created_at < cutoff), ale ze świeżą wiadomością: zostają w bazie
    // i dalej pasują do filtra kandydatów. Stronicowanie po przesunięciu
    // (offset) albo „od początku” zapętliłoby się albo pominęło resztę.
    const total = SUPPORT_RETENTION_PAGE * 2 + 7;
    const conversations: Conversation[] = [];
    const messages: Message[] = [];
    for (let n = 1; n <= total; n++) {
      conversations.push(conversation(n, USER, '2023-05-01T10:00:00.000Z'));
      // Co trzecia aktywna, reszta milczy od ponad 24 miesięcy.
      messages.push(message(n, n, n % 3 === 0 ? '2026-10-01T10:00:00.000Z' : '2023-05-01T10:00:01.000Z'));
    }
    const db = database({ conversations, messages });

    const result = await purgeExpiredSupportConversations(db.client, NOW);

    const active = Math.floor(total / 3);
    expect(db.state.conversations).toHaveLength(active);
    expect(db.state.conversations.every((c) => Number(c.id.slice(-12)) % 3 === 0)).toBe(true);
    expect(result).toMatchObject({ deleted_expired: total - active, kept_active: active, truncated: false });
    // Paczki: jedno DELETE na stronę, nie jedno na rozmowę.
    const deletes = db.calls.filter((c) => c.table === 'support_conversations' && c.op === 'delete');
    expect(deletes.length).toBeLessThanOrEqual(3);
  });

  it('bezpiecznik: strona, która nie przesuwa odczytu, przerywa przebieg zamiast kręcić się w kółko', async () => {
    const conversations: Conversation[] = [];
    const messages: Message[] = [];
    for (let n = 1; n <= SUPPORT_RETENTION_PAGE; n++) {
      conversations.push(conversation(n, USER, '2023-05-01T10:00:00.000Z'));
      messages.push(message(n, n, '2026-10-01T10:00:00.000Z'));
    }
    const db = database({ conversations, messages });
    db.ignoreKeyset();

    await expect(purgeExpiredSupportConversations(db.client, NOW)).rejects.toThrow(/nie posuwa się naprzód/);
    expect(db.state.conversations).toHaveLength(SUPPORT_RETENTION_PAGE);
  });
});

describe('purgeExpiredSupportConversations — błędy nie udają pustej bazy', () => {
  it('błąd odczytu rozmów rzuca i niczego nie kasuje', async () => {
    const db = database({
      conversations: [conversation(1, USER, '2023-05-01T10:00:00.000Z')],
      messages: [],
    });
    db.fail('support_conversations:select', 'synthetic read failure');

    await expect(purgeExpiredSupportConversations(db.client, NOW)).rejects.toThrow('synthetic read failure');
    expect(db.state.conversations).toHaveLength(1);
  });

  it('błąd sprawdzenia wiadomości rzuca i NIE kasuje rozmów, których nie dało się sprawdzić', async () => {
    const db = database({
      conversations: [conversation(1, USER, '2023-05-01T10:00:00.000Z')],
      messages: [message(1, 1, '2026-10-01T10:00:00.000Z')],
    });
    db.fail('support_messages:select', 'synthetic messages failure');

    await expect(purgeExpiredSupportConversations(db.client, NOW)).rejects.toThrow('synthetic messages failure');
    expect(db.state.conversations).toHaveLength(1);
    expect(db.calls.some((c) => c.op === 'delete')).toBe(false);
  });

  it('błąd usuwania rzuca (ponowienie joba dokończy — przebieg jest idempotentny)', async () => {
    const db = database({
      conversations: [conversation(1, USER, '2023-05-01T10:00:00.000Z')],
      messages: [],
    });
    db.fail('support_conversations:delete', 'synthetic delete failure');

    await expect(purgeExpiredSupportConversations(db.client, NOW)).rejects.toThrow('synthetic delete failure');
  });

  it('drugi przebieg po udanym nic nie znajduje (ponowienie od zera jest bezpieczne)', async () => {
    const db = database({
      conversations: [conversation(1, USER, '2023-05-01T10:00:00.000Z'), conversation(2, null, '2026-10-01T00:00:00.000Z')],
      messages: [],
    });
    await purgeExpiredSupportConversations(db.client, NOW);

    const again = await purgeExpiredSupportConversations(db.client, NOW);

    expect(again).toMatchObject({ deleted_expired: 0, deleted_orphaned: 0, kept_active: 0 });
  });
});

describe('cron.support-chat-retention — runner', () => {
  it('liczy termin od bieżącej daty i korzysta z klienta service_role', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const db = database({
        conversations: [conversation(1, USER, '2023-05-01T10:00:00.000Z')],
        messages: [message(1, 1, minutes(CUTOFF, -1))],
      });
      mocks.createAdminClient.mockReturnValue(db.client);
      const ctx = {
        step: { run: async (_name: string, fn: () => unknown) => fn() },
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        attempt: 0,
      } as unknown as JobContext;

      const result = await runSupportChatRetention(ctx);

      expect(result).toMatchObject({ cutoff: CUTOFF, deleted_expired: 1 });
      expect(db.state.conversations).toEqual([]);
      expect(mocks.captureMessage).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('rejestr jobów — cron retencji czatu', () => {
  it('kolejka jest w CRON_JOBS (codziennie) i ma zarejestrowany handler', async () => {
    const { CRON_JOBS } = await import('@/lib/jobs/queues');
    const { getRegisteredJobs } = await import('@/lib/jobs/registry');
    await import('@/lib/jobs/handlers/package-a');

    const cron = CRON_JOBS.find((c) => c.queue === 'cron.support-chat-retention');
    expect(cron, 'brak cron.support-chat-retention w CRON_JOBS').toBeDefined();
    // Codziennie: przy przebiegu raz w miesiącu rozmowa żyłaby do 25 miesięcy.
    expect(cron?.cron.split(/\s+/).slice(2)).toEqual(['*', '*', '*']);
    expect(getRegisteredJobs().map((j) => j.queue)).toContain('cron.support-chat-retention');
  });
});

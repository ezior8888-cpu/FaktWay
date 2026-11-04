import type { createAdminClient } from '@/lib/supabase/server';

/**
 * Retencja rozmów z czatem pomocy (`support_conversations` +
 * `support_messages`, migracja 00054).
 *
 * Polityka prywatności, pkt 3 (wiersz „Kontakt i pomoc techniczna, w tym czat
 * z asystentem AI”): „do 24 miesięcy od ostatniej wiadomości”. Do 15.10.2026
 * nic tych tabel nie czyściło, a FK `user_id … ON DELETE SET NULL` zostawiał
 * po usuniętym koncie rozmowy z pełną treścią, bez właściciela.
 *
 * Dwie reguły:
 * 1. Rozmowa, której ostatnia wiadomość jest starsza niż 24 miesiące
 *    (albo bez wiadomości i założona wcześniej) — usuwana.
 * 2. Rozmowa bez właściciela (`user_id IS NULL`, czyli konto już usunięte
 *    poza `deleteUserSupportConversations`, np. w Supabase Studio) — usuwana
 *    od razu. Wiadomości znikają kaskadowo (ON DELETE CASCADE).
 *
 * „Ostatnia wiadomość” to `support_messages.created_at`, NIE
 * `support_conversations.updated_at`: `appendMessage` podbija `updated_at`
 * osobnym zapytaniem i ignoruje jego błąd, więc stare `updated_at` nie dowodzi,
 * że rozmowa milczy.
 */

type AdminClient = ReturnType<typeof createAdminClient>;

export const SUPPORT_CHAT_RETENTION_MONTHS = 24;

/**
 * Strona kandydatów. Lista id idzie w `in(...)` w URL-u DELETE, więc trzymamy
 * ją krótką (100 × 36 znaków); i tak poniżej `max-rows` PostgREST-a.
 */
export const SUPPORT_RETENTION_PAGE = 100;

/**
 * Pułap stron na jedną regułę w jednym przebiegu (100 000 rozmów). Po nim
 * przebieg kończy się z `truncated: true`, a resztę bierze następna doba.
 */
const MAX_PAGES = 1000;

export interface SupportChatRetentionResult {
  cutoff: string;
  /** Rozmowy, których ostatnia wiadomość jest starsza niż termin. */
  deleted_expired: number;
  /** Rozmowy bez właściciela (konto usunięte). */
  deleted_orphaned: number;
  /** Założone przed terminem, ale z wiadomością po nim — zostają. */
  kept_active: number;
  /** Przebieg doszedł do pułapu stron; reszta w następnym. */
  truncated: boolean;
}

export function supportChatCutoff(now: Date): Date {
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - SUPPORT_CHAT_RETENTION_MONTHS);
  return cutoff;
}

interface CandidateRow {
  id: string;
}

function candidateQuery(db: AdminClient) {
  return db.from('support_conversations').select('id');
}
type CandidateQuery = ReturnType<typeof candidateQuery>;

/**
 * Stronicowanie po kluczu (`id > ostatnie`), nie po przesunięciu: rozmowy
 * aktywne zostają w bazie i dalej pasują do filtra, a usunięte z niego
 * wypadają — `range(from, …)` pomijałby wtedy wiersze.
 *
 * `onPage` dostaje stronę i zwraca dopiero po jej obsłużeniu; wyjątek
 * przerywa przebieg (worker ponowi go od zera — każda strona jest
 * idempotentna).
 */
async function forEachCandidatePage(
  db: AdminClient,
  label: string,
  narrow: (query: CandidateQuery) => CandidateQuery,
  onPage: (ids: string[]) => Promise<void>,
): Promise<{ truncated: boolean }> {
  let afterId: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    let query = narrow(candidateQuery(db));
    if (afterId !== null) query = query.gt('id', afterId);
    const { data, error } = await query.order('id', { ascending: true }).limit(SUPPORT_RETENTION_PAGE);
    if (error) throw new Error(`support_conversations (${label}): ${error.message}`);

    const rows = (data ?? []) as CandidateRow[];
    if (rows.length > 0) await onPage(rows.map((row) => row.id));
    if (rows.length < SUPPORT_RETENTION_PAGE) return { truncated: false };

    const lastId = rows[rows.length - 1]!.id;
    // Bezpiecznik: strona, która nie przesuwa odczytu, zajęłaby worker na
    // zawsze (aktywne rozmowy nie wypadają z filtra).
    if (afterId !== null && lastId <= afterId) {
      throw new Error(`support_conversations (${label}): stronicowanie nie posuwa się naprzód`);
    }
    afterId = lastId;
  }
  return { truncated: true };
}

async function hasMessageSince(db: AdminClient, conversationId: string, cutoff: string): Promise<boolean> {
  const { data, error } = await db
    .from('support_messages')
    .select('id')
    .eq('conversation_id', conversationId)
    .gte('created_at', cutoff)
    .limit(1);
  if (error) throw new Error(`support_messages: ${error.message}`);
  return (data ?? []).length > 0;
}

async function deleteConversations(db: AdminClient, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const { error, count } = await db
    .from('support_conversations')
    .delete({ count: 'exact' })
    .in('id', ids);
  if (error) throw new Error(`support_conversations delete: ${error.message}`);
  return count ?? 0;
}

/**
 * Jeden przebieg retencji. Idempotentny: ponowienie po błędzie usuwa tylko
 * to, co jeszcze zostało.
 */
export async function purgeExpiredSupportConversations(
  db: AdminClient,
  now: Date,
): Promise<SupportChatRetentionResult> {
  const cutoff = supportChatCutoff(now).toISOString();
  const result: SupportChatRetentionResult = {
    cutoff,
    deleted_expired: 0,
    deleted_orphaned: 0,
    kept_active: 0,
    truncated: false,
  };

  const orphaned = await forEachCandidatePage(
    db,
    'bez właściciela',
    (query) => query.is('user_id', null),
    async (ids) => {
      result.deleted_orphaned += await deleteConversations(db, ids);
    },
  );

  // Kandydaci: założone przed terminem (wiadomość nie może być starsza od
  // rozmowy). Rozstrzyga ostatnia wiadomość — sprawdzana dla każdej rozmowy
  // przed usunięciem; błąd sprawdzenia przerywa przebieg BEZ usuwania strony.
  const expired = await forEachCandidatePage(
    db,
    'po terminie',
    (query) => query.lt('created_at', cutoff).not('user_id', 'is', null),
    async (ids) => {
      const stale: string[] = [];
      for (const id of ids) {
        if (await hasMessageSince(db, id, cutoff)) result.kept_active += 1;
        else stale.push(id);
      }
      result.deleted_expired += await deleteConversations(db, stale);
    },
  );

  result.truncated = orphaned.truncated || expired.truncated;
  return result;
}

/**
 * Usuwa wszystkie rozmowy użytkownika (z wiadomościami — kaskada) przy
 * usunięciu konta. Wołać PRZED `auth.admin.deleteUser`: potem `user_id` jest
 * już NULL i rozmów nie da się przypisać. Idempotentne.
 */
export async function deleteUserSupportConversations(db: AdminClient, userId: string): Promise<number> {
  const { error, count } = await db
    .from('support_conversations')
    .delete({ count: 'exact' })
    .eq('user_id', userId);
  if (error) throw new Error('support_conversations_delete_failed');
  return count ?? 0;
}

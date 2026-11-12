import 'server-only';

import { readCompletePagesByKey, type KeysetPageQuery } from '@/lib/accounting/read-complete-pages';
import { createAdminClient } from '@/lib/supabase/server';

/**
 * Identyfikatory rozmów w jednym `in(...)`. Lista idzie w adresie zapytania
 * (36 znaków na uuid), więc paczki po 100 jak w innych odczytach (`LOOKUP_CHUNK`).
 */
const CONVERSATIONS_PER_QUERY = 100;

interface MembershipRecord {
  id: string;
  user_id: string;
  organization_id: string;
  role: string;
  status: string;
  joined_at: string;
  revoked_at: string | null;
}
interface AuditRecord {
  id: string;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}
interface CollectionCoverage {
  returned: number;
  total: number;
  truncated: boolean;
}

type Rows = Array<Record<string, unknown>>;

export interface UserDataExport {
  format_version: 3;
  exported_at: string;
  user: {
    id: string;
    email: string | null;
    created_at: string;
    last_sign_in_at: string | null;
    metadata: Record<string, unknown>;
  };
  /** Profil w aplikacji (`public.users`): imię, ostatnie logowanie, zgoda na analitykę i źródło wejścia. */
  profile: Record<string, unknown> | null;
  memberships: MembershipRecord[];
  audit_logs: AuditRecord[];
  organizations_owned: Array<{ organization_id: string; role: string }>;
  email_preferences: Rows;
  /** Urządzenia z powiadomieniami — bez adresu i kluczy szyfrowania. */
  push_devices: Rows;
  /** Urządzenia do logowania biometrią — nazwa i daty, bez klucza i identyfikatora poświadczenia. */
  passkey_devices: Rows;
  support_conversations: Array<Record<string, unknown> & { messages: Rows }>;
  join_requests: Rows;
  invitations_received: Rows;
  deletion_requests: Rows;
  newsletter: Rows;
  email_bounces: Rows;
  coverage: Record<
    | 'memberships'
    | 'audit_logs'
    | 'email_preferences'
    | 'push_devices'
    | 'passkey_devices'
    | 'support_conversations'
    | 'support_messages'
    | 'join_requests'
    | 'invitations_received'
    | 'deletion_requests'
    | 'newsletter'
    | 'email_bounces',
    CollectionCoverage
  >;
  organization_invoices: { included: false; reason: string };
  notes: string;
}

/**
 * Sekcja czytana przez `readAllRows` jest kompletna (liczbę rekordów
 * potwierdza baza), inaczej eksport kończy się błędem. Pola pokrycia
 * zostają w formacie 3.
 */
function complete(rows: readonly unknown[]): CollectionCoverage {
  return { returned: rows.length, total: rows.length, truncated: false };
}

/**
 * Kolumny dobrane ręcznie: sekrety (klucze push, skróty tokenów zaproszeń
 * i anulowania, surowe zdarzenia dostawcy poczty) i identyfikatory innych
 * osób (`invited_by`, `decided_by`) zostają poza plikiem.
 */
const SECTIONS = {
  email_preferences: { table: 'email_preferences', columns: 'category, unsubscribed_at, source, reason', by: 'user_id' },
  push_devices: {
    table: 'push_subscriptions',
    columns: 'id, tenant_id, device_type, device_name, user_agent, notify_invoice_accepted, notify_invoice_rejected, notify_payment_received, notify_cert_expiry, notify_inbox_new, last_used_at, is_active, created_at',
    by: 'user_id',
  },
  passkey_devices: {
    table: 'user_passkeys',
    columns: 'id, device_label, backed_up, created_at, last_used_at',
    by: 'user_id',
  },
  support_conversations: {
    table: 'support_conversations',
    columns: 'id, tenant_id, status, category, subject, csat_positive, csat_comment, escalated_at, escalation_reason, created_at',
    by: 'user_id',
  },
  join_requests: {
    table: 'organization_join_requests',
    columns: 'id, organization_id, message, status, decided_at, created_at',
    by: 'requested_by_user_id',
  },
  invitations_received: {
    table: 'organization_invitations',
    columns: 'id, organization_id, role, invited_at, expires_at, accepted_at, revoked_at',
    by: 'email',
  },
  deletion_requests: {
    table: 'gdpr_deletion_requests',
    columns: 'id, status, scheduled_for, processing_started_at, executed_at, cancel_reason, ip_address, user_agent, created_at',
    by: 'user_id',
  },
  newsletter: { table: 'newsletter_subscribers', columns: 'email, source, created_at, unsubscribed_at', by: 'email' },
  email_bounces: { table: 'email_bounces', columns: 'email, bounce_type, reason, occurred_at', by: 'email' },
} as const;

type SectionName = keyof typeof SECTIONS;

/** Wiersz strony: `id` (uuid) jest kluczem stron. */
type KeyedRow = Record<string, unknown> & { id: string };

/**
 * Zapytanie strony dla tabeli i kolumn z `SECTIONS`. Typowany klient nie
 * zawęża tabeli ani kolumn z mapy, więc zapytanie idzie przez wąski,
 * jawny interfejs — tylko metody, których tu używamy.
 */
interface PageQuery {
  eq(column: string, value: string): PageQuery;
  in(column: string, values: readonly string[]): PageQuery;
  gt(column: string, value: string): PageQuery;
  order(column: string, options: { ascending: boolean }): PageQuery;
  limit(count: number): PromiseLike<{ data: KeyedRow[] | null; count?: number | null; error: { message: string } | null }>;
}

/** Tak kończy się komunikat `readCompletePagesByKey`, gdy baza nie potwierdzi liczby rekordów. */
const COUNT_UNCONFIRMED = 'nie można potwierdzić liczby rekordów';

/**
 * Cała sekcja stronami po kluczu (sesja 29 planu skalowania). Do niej każda
 * sekcja szła jednym zapytaniem z `limit(1000)`, a PostgREST na produkcji
 * (`PGRST_DB_MAX_ROWS = 1000`) ucina odpowiedź bez błędu: osoba z 1500
 * wpisami audytu dostawała 1000. Teraz komplet albo błąd: błąd bazy,
 * niepełna strona albo zapis w trakcie odczytu kończą eksport odmową.
 *
 * Strony idą zawsze po `id`; kolejność w pliku ustala `order`. Sekcja,
 * która nie eksportuje `id`, dostaje je tylko jako klucz stron, a do pliku
 * idzie bez niego.
 */
async function readAllRows<T = Record<string, unknown>>(
  supabase: ReturnType<typeof createAdminClient>,
  table: string,
  columns: string,
  filter: (query: PageQuery) => PageQuery,
  order?: (a: KeyedRow, b: KeyedRow) => number,
): Promise<T[]> {
  const pageKeyOnly = !columns.split(',').map((column) => column.trim()).includes('id');
  const select = pageKeyOnly ? `id, ${columns}` : columns;
  let rows: KeyedRow[];
  try {
    rows = await readCompletePagesByKey<KeyedRow>(`account_export ${table}`, (page: KeysetPageQuery) => {
      const base = (supabase.from(table as 'memberships') as unknown as {
        select(columns: string, options?: { count: 'exact'; head: boolean }): PageQuery;
      }).select(select, page.count ? { count: 'exact', head: page.head } : undefined);
      let query = filter(base);
      if (page.afterId !== null) query = query.gt('id', page.afterId);
      return query.order('id', { ascending: true }).limit(page.limit);
    });
  } catch (error) {
    // Stały komunikat bez przyczyny: błąd SDK może nieść cudze wiersze (zob. trasa eksportu).
    const countUnconfirmed = error instanceof Error && error.message.endsWith(COUNT_UNCONFIRMED);
    throw new Error(countUnconfirmed ? 'account_export_count_unavailable' : 'account_export_data_unavailable');
  }
  if (order) rows.sort(order);
  const result = pageKeyOnly ? rows.map(({ id: _pageKey, ...row }) => row) : rows;
  return result as unknown as T[];
}

/**
 * Kolejność jak `ORDER BY created_at` w bazie. PostgREST oddaje stemple ISO
 * z mikrosekundami: najpierw czas (do milisekundy), przy remisie napis
 * (mikrosekundy w tym samym zapisie strefy).
 */
function byCreatedAt(a: KeyedRow, b: KeyedRow): number {
  const x = String(a.created_at ?? '');
  const y = String(b.created_at ?? '');
  const byTime = Date.parse(x) - Date.parse(y);
  if (byTime) return byTime; // 0 albo NaN (stempel nie do odczytania): rozstrzyga napis
  return x < y ? -1 : x > y ? 1 : 0;
}

const byId = (a: KeyedRow, b: KeyedRow): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
/** Audyt od najnowszego, remis po `id` (dawne `order('created_at', desc).order('id')`). */
const newestFirst = (a: KeyedRow, b: KeyedRow): number => byCreatedAt(b, a) || byId(a, b);
/** Wiadomości w rozmowie po kolei (dawne `order('created_at')`), remis po `id`. */
const chronological = (a: KeyedRow, b: KeyedRow): number => byCreatedAt(a, b) || byId(a, b);

/**
 * Snapshot of the verified account's personal data (art. 15/20 GDPR).
 * Caller must pass the user ID from getVerifiedUserContext(), never a request ID.
 * Invoice rows belong to organizations; the schema has no "issued_by_user_id".
 * Company invoices use the separately authorized organization export.
 *
 * Do 02.10 plik miał tylko profil, członkostwa i audyt (AUD-76). Do sesji 29
 * planu skalowania każda sekcja kończyła się na 1000 wierszy; teraz idzie
 * stronami w komplecie albo eksport kończy się błędem.
 */
export async function collectUserData(userId: string): Promise<UserDataExport> {
  const supabase = createAdminClient();
  const authResult = await supabase.auth.admin.getUserById(userId);
  const authUser = authResult.data?.user;
  if (authResult.error || !authUser || authUser.id !== userId) {
    throw new Error('account_export_user_unavailable');
  }
  const email = authUser.email ?? null;

  const readSection = async (name: SectionName): Promise<Rows> => {
    const section = SECTIONS[name];
    const value = section.by === 'email' ? email : userId;
    if (!value) return [];
    return readAllRows(supabase, section.table, section.columns, (query) => query.eq(section.by, value));
  };

  const [memberships, audit, profile, ...sections] = await Promise.all([
    readAllRows<MembershipRecord>(supabase, 'memberships', 'id, user_id, organization_id, role, status, joined_at, revoked_at',
      (query) => query.eq('user_id', userId)),
    readAllRows<AuditRecord>(supabase, 'audit_logs', 'id, action, entity_type, entity_id, metadata, created_at',
      (query) => query.eq('user_id', userId), newestFirst),
    supabase.from('users')
      .select('id, name, last_login, created_at, analytics_consent, analytics_consent_at, signup_source', { count: 'exact' })
      .eq('id', userId).order('id').limit(1).returns<Rows>(),
    ...(Object.keys(SECTIONS) as SectionName[]).map((name) => readSection(name)),
  ]);
  if (profile.error || !profile.data) {
    throw new Error('account_export_data_unavailable');
  }
  const byName = Object.fromEntries(
    (Object.keys(SECTIONS) as SectionName[]).map((name, i) => [name, sections[i]!]),
  ) as Record<SectionName, Rows>;

  // Wiadomości tylko z rozmów tej osoby, paczkami identyfikatorów.
  const conversationIds = byName.support_conversations.map((c) => String(c.id));
  const chunks: string[][] = [];
  for (let i = 0; i < conversationIds.length; i += CONVERSATIONS_PER_QUERY) {
    chunks.push(conversationIds.slice(i, i + CONVERSATIONS_PER_QUERY));
  }
  const messageChunks = await Promise.all(chunks.map((chunk) =>
    readAllRows(supabase, 'support_messages', 'conversation_id, role, content, created_at',
      (query) => query.in('conversation_id', chunk), chronological)));
  const messages = messageChunks.flat();
  // Rozmowa jest w jednej paczce, więc jej wiadomości zostają po kolei.
  const messagesByConversation = new Map<unknown, Rows>();
  for (const message of messages) {
    const list = messagesByConversation.get(message.conversation_id);
    if (list) list.push(message);
    else messagesByConversation.set(message.conversation_id, [message]);
  }

  return {
    format_version: 3,
    exported_at: new Date().toISOString(),
    user: {
      id: authUser.id,
      email,
      created_at: authUser.created_at,
      last_sign_in_at: authUser.last_sign_in_at ?? null,
      metadata: authUser.user_metadata,
    },
    profile: profile.data[0] ?? null,
    memberships,
    audit_logs: audit,
    organizations_owned: memberships
      .filter((membership) => membership.status === 'active' && membership.role === 'owner')
      .map(({ organization_id, role }) => ({ organization_id, role })),
    email_preferences: byName.email_preferences,
    push_devices: byName.push_devices,
    passkey_devices: byName.passkey_devices,
    support_conversations: byName.support_conversations.map((conversation) => ({
      ...conversation,
      messages: messagesByConversation.get(conversation.id) ?? [],
    })),
    join_requests: byName.join_requests,
    invitations_received: byName.invitations_received,
    deletion_requests: byName.deletion_requests,
    newsletter: byName.newsletter,
    email_bounces: byName.email_bounces,
    coverage: {
      memberships: complete(memberships),
      audit_logs: complete(audit),
      email_preferences: complete(byName.email_preferences),
      push_devices: complete(byName.push_devices),
      passkey_devices: complete(byName.passkey_devices),
      support_conversations: complete(byName.support_conversations),
      support_messages: complete(messages),
      join_requests: complete(byName.join_requests),
      invitations_received: complete(byName.invitations_received),
      deletion_requests: complete(byName.deletion_requests),
      newsletter: complete(byName.newsletter),
      email_bounces: complete(byName.email_bounces),
    },
    organization_invoices: {
      included: false,
      reason: 'Faktury należą do organizacji. Pobierz je przez eksport w panelu wybranej firmy.',
    },
    notes: 'Zestawienie obejmuje profil konta, członkostwa, wszystkie zachowane wpisy audytu ' +
      'oraz dane zapisane o Tobie w aplikacji: preferencje poczty, urządzenia z powiadomieniami, ' +
      'urządzenia do logowania biometrią, rozmowy z pomocą, prośby o dołączenie, otrzymane zaproszenia, żądania usunięcia konta, ' +
      'zapis na newsletter i odbicia poczty. ' +
      'Pola coverage podają liczbę zwróconych i dostępnych rekordów. Plik powstaje tylko w komplecie. ' +
      'Klucze techniczne (np. klucze szyfrowania powiadomień, skróty tokenów) nie są danymi o Tobie i nie trafiają do pliku. ' +
      'Dane firm (faktury, kontrahenci, koszty) pobierzesz eksportem w panelu firmy.',
  };
}

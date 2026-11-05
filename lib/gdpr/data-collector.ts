import 'server-only';

import { createAdminClient } from '@/lib/supabase/server';

const ROW_LIMIT = 1000;

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

function coverage(returned: number, total: number | null): CollectionCoverage {
  // Unknown totals must not be presented as a complete export.
  if (total === null || total < returned) throw new Error('account_export_count_unavailable');
  return { returned, total, truncated: returned < total };
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

/**
 * Odczyt sekcji z kolumnami i tabelą z `SECTIONS`. Typowany klient nie
 * zawęża tabeli ani kolumn z mapy, więc zapytanie idzie przez wąski,
 * jawny interfejs — tylko metody, których tu używamy.
 */
interface SectionQuery {
  eq(column: string, value: string): SectionQuery;
  in(column: string, values: string[]): SectionQuery;
  order(column: string): SectionQuery;
  limit(count: number): { returns<T>(): Promise<{ data: T | null; count: number | null; error: unknown }> };
}

function sectionQuery(
  supabase: ReturnType<typeof createAdminClient>,
  table: string,
  columns: string,
): SectionQuery {
  return (supabase.from(table as 'memberships') as unknown as {
    select(columns: string, options: { count: 'exact' }): SectionQuery;
  }).select(columns, { count: 'exact' });
}

/**
 * Snapshot of the verified account's personal data (art. 15/20 GDPR).
 * Caller must pass the user ID from getVerifiedUserContext(), never a request ID.
 * Invoice rows belong to organizations; the schema has no "issued_by_user_id".
 * Company invoices use the separately authorized organization export.
 *
 * Do 02.10 plik miał tylko profil, członkostwa i audyt (AUD-76).
 */
export async function collectUserData(userId: string): Promise<UserDataExport> {
  const supabase = createAdminClient();
  const authResult = await supabase.auth.admin.getUserById(userId);
  const authUser = authResult.data?.user;
  if (authResult.error || !authUser || authUser.id !== userId) {
    throw new Error('account_export_user_unavailable');
  }
  const email = authUser.email ?? null;

  const readSection = async (name: SectionName): Promise<{ rows: Rows; coverage: CollectionCoverage }> => {
    const section = SECTIONS[name];
    const value = section.by === 'email' ? email : userId;
    if (!value) return { rows: [], coverage: { returned: 0, total: 0, truncated: false } };
    const result = await sectionQuery(supabase, section.table, section.columns)
      .eq(section.by, value)
      .order(section.table === 'newsletter_subscribers' || section.table === 'email_bounces' ? 'email' : 'id')
      .limit(ROW_LIMIT)
      .returns<Rows>();
    if (result.error || !result.data) throw new Error('account_export_data_unavailable');
    return { rows: result.data, coverage: coverage(result.data.length, result.count) };
  };

  const [memberships, audit, profile, ...sections] = await Promise.all([
    supabase.from('memberships')
      .select('id, user_id, organization_id, role, status, joined_at, revoked_at', { count: 'exact' })
      .eq('user_id', userId).order('id').limit(ROW_LIMIT).returns<MembershipRecord[]>(),
    supabase.from('audit_logs')
      .select('id, action, entity_type, entity_id, metadata, created_at', { count: 'exact' })
      .eq('user_id', userId).order('created_at', { ascending: false })
      .order('id').limit(ROW_LIMIT).returns<AuditRecord[]>(),
    supabase.from('users')
      .select('id, name, last_login, created_at, analytics_consent, analytics_consent_at, signup_source', { count: 'exact' })
      .eq('id', userId).order('id').limit(1).returns<Rows>(),
    ...(Object.keys(SECTIONS) as SectionName[]).map((name) => readSection(name)),
  ]);
  if (memberships.error || audit.error || !memberships.data || !audit.data || profile.error || !profile.data) {
    throw new Error('account_export_data_unavailable');
  }
  const byName = Object.fromEntries(
    (Object.keys(SECTIONS) as SectionName[]).map((name, i) => [name, sections[i]!]),
  ) as Record<SectionName, { rows: Rows; coverage: CollectionCoverage }>;

  // Wiadomości tylko z rozmów tej osoby.
  const conversationIds = byName.support_conversations.rows.map((c) => String(c.id));
  let messages: Rows = [];
  let messagesCoverage: CollectionCoverage = { returned: 0, total: 0, truncated: false };
  if (conversationIds.length > 0) {
    const result = await sectionQuery(supabase, 'support_messages', 'conversation_id, role, content, created_at')
      .in('conversation_id', conversationIds)
      .order('created_at')
      .limit(ROW_LIMIT)
      .returns<Rows>();
    if (result.error || !result.data) throw new Error('account_export_data_unavailable');
    messages = result.data;
    messagesCoverage = coverage(result.data.length, result.count);
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
    memberships: memberships.data,
    audit_logs: audit.data,
    organizations_owned: memberships.data
      .filter((membership) => membership.status === 'active' && membership.role === 'owner')
      .map(({ organization_id, role }) => ({ organization_id, role })),
    email_preferences: byName.email_preferences.rows,
    push_devices: byName.push_devices.rows,
    passkey_devices: byName.passkey_devices.rows,
    support_conversations: byName.support_conversations.rows.map((conversation) => ({
      ...conversation,
      messages: messages.filter((m) => m.conversation_id === conversation.id),
    })),
    join_requests: byName.join_requests.rows,
    invitations_received: byName.invitations_received.rows,
    deletion_requests: byName.deletion_requests.rows,
    newsletter: byName.newsletter.rows,
    email_bounces: byName.email_bounces.rows,
    coverage: {
      memberships: coverage(memberships.data.length, memberships.count),
      audit_logs: coverage(audit.data.length, audit.count),
      email_preferences: byName.email_preferences.coverage,
      push_devices: byName.push_devices.coverage,
      passkey_devices: byName.passkey_devices.coverage,
      support_conversations: byName.support_conversations.coverage,
      support_messages: messagesCoverage,
      join_requests: byName.join_requests.coverage,
      invitations_received: byName.invitations_received.coverage,
      deletion_requests: byName.deletion_requests.coverage,
      newsletter: byName.newsletter.coverage,
      email_bounces: byName.email_bounces.coverage,
    },
    organization_invoices: {
      included: false,
      reason: 'Faktury należą do organizacji. Pobierz je przez eksport w panelu wybranej firmy.',
    },
    notes: 'Zestawienie obejmuje profil konta, członkostwa, maksymalnie 1000 ostatnich wpisów audytu ' +
      'oraz dane zapisane o Tobie w aplikacji: preferencje poczty, urządzenia z powiadomieniami, ' +
      'urządzenia do logowania biometrią, rozmowy z pomocą, prośby o dołączenie, otrzymane zaproszenia, żądania usunięcia konta, ' +
      'zapis na newsletter i odbicia poczty (do 1000 pozycji w każdej sekcji). ' +
      'Pola coverage podają liczbę zwróconych i dostępnych rekordów oraz informację o ograniczeniu wyników. ' +
      'Klucze techniczne (np. klucze szyfrowania powiadomień, skróty tokenów) nie są danymi o Tobie i nie trafiają do pliku. ' +
      'Dane firm (faktury, kontrahenci, koszty) pobierzesz eksportem w panelu firmy.',
  };
}

/**
 * Admin /support dashboard queries (Faza 24 Krok 4).
 *
 * Day-to-day operations widgets:
 *   - Recent signups (24h) — sprawdzić czy nikt się nie zaciął na onboardingu
 *   - Inactive users (14d) — kandydaci do re-engagement campaign (po Fazie 26)
 *   - Recently failed invoices (24h) — błędy KSeF wymagające ręcznej interwencji
 *   - Pending join requests — czekają na zatwierdzenie ownerów
 */

import 'server-only';

import type { User } from '@supabase/supabase-js';

import { requireAdmin } from '@/lib/auth/admin-guard';
import { scanAuthUsers } from '@/lib/auth/auth-users';
import { createAdminClient } from '@/lib/supabase/admin';

// ─── 1. Recent signups ─────────────────────────────────────────────

export interface RecentSignup {
  userId: string;
  email: string | null;
  createdAt: string;
  emailConfirmed: boolean;
  hasOrganization: boolean;
  primaryOrgName: string | null;
}

/**
 * Userzy zarejestrowani w ostatnich N godzinach. `auth.admin.listUsers`
 * sortuje DESC by created_at — bierzemy pierwsze 100 i filtrujemy po cutoff.
 */
export async function getRecentSignups(
  hours = 24,
  limit = 100,
): Promise<RecentSignup[]> {
  await requireAdmin();
  const supabase = createAdminClient();
  const cutoff = Date.now() - hours * 60 * 60 * 1000;

  const { data: usersList, error } = await supabase.auth.admin.listUsers({
    page: 1,
    perPage: Math.min(limit, 200),
  });
  if (error) {
    throw new Error(`auth.admin.listUsers failed: ${error.message}`);
  }

  const recent = usersList.users
    .filter((u) => new Date(u.created_at).getTime() >= cutoff)
    .slice(0, limit);

  if (recent.length === 0) return [];

  // Doczytaj membership pierwszej org (czy user faktycznie ukończył onboarding).
  const userIds = recent.map((u) => u.id);
  const { data: memberships } = await supabase
    .from('memberships')
    .select('user_id, joined_at, tenants(name)')
    .in('user_id', userIds)
    .eq('status', 'active')
    .order('joined_at', { ascending: false });

  type MembershipRow = {
    user_id: string;
    joined_at: string;
    tenants: { name: string } | { name: string }[] | null;
  };
  const byUser = new Map<string, MembershipRow>();
  for (const m of (memberships ?? []) as MembershipRow[]) {
    if (!byUser.has(m.user_id)) byUser.set(m.user_id, m);
  }

  return recent.map((u) => {
    const m = byUser.get(u.id);
    const tenant = m ? (Array.isArray(m.tenants) ? m.tenants[0] : m.tenants) : null;
    return {
      userId: u.id,
      email: u.email ?? null,
      createdAt: u.created_at,
      emailConfirmed: Boolean(u.email_confirmed_at),
      hasOrganization: Boolean(m),
      primaryOrgName: tenant?.name ?? null,
    };
  });
}

// ─── 2. Inactive users ──────────────────────────────────────────────

export interface InactiveUser {
  userId: string;
  email: string | null;
  lastSignInAt: string | null;
  createdAt: string;
  daysInactive: number;
}

/**
 * Userzy: aktywni (email confirmed + nie zawieszeni) ale bez logowania
 * przez >= N dni. Kandydaci do re-engagement campaign / churn analytics.
 *
 * Wymaga `auth.admin.listUsers` przeskanowania wszystkich userów — dla
 * MVP wystarczy, przy 5k+ trzeba RPC po `auth.users`.
 */
export async function getInactiveUsers(
  days = 14,
  limit = 100,
): Promise<InactiveUser[]> {
  await requireAdmin();
  const supabase = createAdminClient();
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  // Wszystkie strony, nie pierwsze 1000 kont (AUD-125).
  const allUsers: User[] = [];
  try {
    await scanAuthUsers(supabase, (u) => {
      allUsers.push(u);
    });
  } catch (e) {
    throw new Error(`auth.admin.listUsers failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  const filtered = allUsers
    .filter((u) => {
      // Skip nie-potwierdzeni email (nigdy się nie zalogowali = oczekiwane)
      if (!u.email_confirmed_at) return false;
      // Skip zawieszeni
      const banned = (u as unknown as { banned_until?: string | null }).banned_until;
      if (banned) return false;
      // Konto musi istnieć dłużej niż próg (świeży user nie jest "inactive")
      if (new Date(u.created_at).getTime() > cutoff) return false;
      // Brak last_sign_in_at LUB starszy niż cutoff
      const lastSignIn = u.last_sign_in_at
        ? new Date(u.last_sign_in_at).getTime()
        : 0;
      return lastSignIn < cutoff;
    })
    .map((u) => ({
      userId: u.id,
      email: u.email ?? null,
      lastSignInAt: u.last_sign_in_at ?? null,
      createdAt: u.created_at,
      daysInactive: u.last_sign_in_at
        ? Math.floor((Date.now() - new Date(u.last_sign_in_at).getTime()) / (24 * 60 * 60 * 1000))
        : Math.floor((Date.now() - new Date(u.created_at).getTime()) / (24 * 60 * 60 * 1000)),
    }))
    .sort((a, b) => b.daysInactive - a.daysInactive)
    .slice(0, limit);

  return filtered;
}

// ─── 3. Recently failed invoices ────────────────────────────────────

export interface FailedInvoice {
  invoiceId: string;
  tenantId: string;
  tenantName: string | null;
  tenantNip: string | null;
  internalNumber: string | null;
  ksefStatus: string | null;
  lastError: string | null;
  lastAttemptAt: string | null;
  createdAt: string;
}

export async function getRecentlyFailedInvoices(
  hours = 24,
  limit = 50,
): Promise<FailedInvoice[]> {
  await requireAdmin();
  const supabase = createAdminClient();
  const cutoffIso = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('invoices')
    .select(
      'id, tenant_id, internal_number, ksef_status, last_error, last_attempt_at, created_at, tenants(name, nip)',
    )
    .in('ksef_status', ['failed', 'rejected'])
    .or(`last_attempt_at.gte.${cutoffIso},created_at.gte.${cutoffIso}`)
    .order('last_attempt_at', { ascending: false, nullsFirst: false })
    .limit(limit);

  if (error) {
    throw new Error(`invoices failed lookup: ${error.message}`);
  }

  type Row = {
    id: string;
    tenant_id: string;
    internal_number: string | null;
    ksef_status: string | null;
    last_error: string | null;
    last_attempt_at: string | null;
    created_at: string;
    tenants: { name: string; nip: string } | { name: string; nip: string }[] | null;
  };

  return ((data ?? []) as Row[]).map((row) => {
    const t = Array.isArray(row.tenants) ? row.tenants[0] : row.tenants;
    return {
      invoiceId: row.id,
      tenantId: row.tenant_id,
      tenantName: t?.name ?? null,
      tenantNip: t?.nip ?? null,
      internalNumber: row.internal_number,
      ksefStatus: row.ksef_status,
      lastError: row.last_error,
      lastAttemptAt: row.last_attempt_at,
      createdAt: row.created_at,
    };
  });
}

// ─── 4. Pending join requests ───────────────────────────────────────

export interface PendingJoinRequest {
  id: string;
  requesterUserId: string;
  organizationId: string;
  organizationName: string | null;
  organizationNip: string | null;
  message: string | null;
  createdAt: string;
}

export async function getPendingJoinRequests(
  limit = 50,
): Promise<PendingJoinRequest[]> {
  await requireAdmin();
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from('organization_join_requests')
    .select('id, requested_by_user_id, organization_id, message, created_at, tenants(name, nip)')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(limit);

  if (error) {
    throw new Error(`join_requests lookup: ${error.message}`);
  }

  type Row = {
    id: string;
    requested_by_user_id: string;
    organization_id: string;
    message: string | null;
    created_at: string;
    tenants: { name: string; nip: string } | { name: string; nip: string }[] | null;
  };

  return ((data ?? []) as Row[]).map((row) => {
    const t = Array.isArray(row.tenants) ? row.tenants[0] : row.tenants;
    return {
      id: row.id,
      // Kolumna nazywa się `requested_by_user_id` (migracja 00036). Do 25.09
      // zapytanie pytało o `requester_user_id` — PostgREST odrzucał je, a lista
      // próśb o dołączenie w panelu wsparcia kończyła się wyjątkiem.
      requesterUserId: row.requested_by_user_id,
      organizationId: row.organization_id,
      organizationName: t?.name ?? null,
      organizationNip: t?.nip ?? null,
      message: row.message,
      createdAt: row.created_at,
    };
  });
}

// ─── 5. AI support conversations (Faza 30) ─────────────────────────

export interface AdminSupportConversation {
  id: string;
  status: 'open' | 'escalated' | 'resolved' | 'closed';
  category: string | null;
  subject: string | null;
  csatPositive: boolean | null;
  /** `user_requested` (klient kliknął „Połącz z człowiekiem”) albo `ai_uncertain`. */
  escalationReason: string | null;
  escalatedAt: string | null;
  createdAt: string;
  /** Adres, na który odpowiadamy; `null`, gdy GoTrue go nie zwróciło. */
  userEmail: string | null;
}

interface SupportConvRow {
  id: string;
  user_id: string | null;
  status: 'open' | 'escalated' | 'resolved' | 'closed';
  category: string | null;
  subject: string | null;
  csat_positive: boolean | null;
  escalation_reason: string | null;
  escalated_at: string | null;
  created_at: string;
}

const SUPPORT_CONV_COLUMNS =
  'id, user_id, status, category, subject, csat_positive, escalation_reason, escalated_at, created_at';

/** Górna granica listy eskalowanych: nie ma jeszcze zamykania rozmów, więc wiersze się zbierają. */
const ESCALATED_LIMIT = 200;
/** Tyle adresów naraz: panel admina nie może zalać GoTrue setką równoległych zapytań. */
const EMAIL_LOOKUP_BATCH = 10;

interface SupportConvQuery {
  eq: (k: string, v: string) => SupportConvQuery;
  order: (k: string, o: { ascending: boolean }) => SupportConvQuery;
  limit: (n: number) => PromiseLike<{
    data: SupportConvRow[] | null;
    error: { message: string } | null;
  }>;
}

/**
 * `support_conversations` to nowa tabela (00054), nieobecna w
 * `types/database.ts` — stąd cast przez `unknown`.
 */
function supportConversations(supabase: ReturnType<typeof createAdminClient>): SupportConvQuery {
  return (
    supabase as unknown as {
      from: (n: string) => { select: (c: string) => SupportConvQuery };
    }
  )
    .from('support_conversations')
    .select(SUPPORT_CONV_COLUMNS);
}

/** Adresy klientów: każdego pytamy raz, a błąd odczytu nie wywraca panelu. */
async function emailsByUserId(
  supabase: ReturnType<typeof createAdminClient>,
  rows: SupportConvRow[],
): Promise<Map<string, string | null>> {
  const ids = [...new Set(rows.map((r) => r.user_id).filter((id): id is string => Boolean(id)))];
  const emails = new Map<string, string | null>();
  for (let i = 0; i < ids.length; i += EMAIL_LOOKUP_BATCH) {
    await Promise.all(
      ids.slice(i, i + EMAIL_LOOKUP_BATCH).map(async (id) => {
        try {
          const { data } = await supabase.auth.admin.getUserById(id);
          emails.set(id, data?.user?.email ?? null);
        } catch {
          emails.set(id, null);
        }
      }),
    );
  }
  return emails;
}

function toAdminConversation(
  row: SupportConvRow,
  emails: Map<string, string | null>,
): AdminSupportConversation {
  return {
    id: row.id,
    status: row.status,
    category: row.category,
    subject: row.subject,
    csatPositive: row.csat_positive,
    escalationReason: row.escalation_reason,
    escalatedAt: row.escalated_at,
    createdAt: row.created_at,
    userEmail: row.user_id ? (emails.get(row.user_id) ?? null) : null,
  };
}

/** Ostatnie konwersacje AI support. */
export async function getSupportConversations(
  limit = 25,
): Promise<AdminSupportConversation[]> {
  await requireAdmin();
  const supabase = createAdminClient();
  const res = await supportConversations(supabase)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (res.error) {
    throw new Error(`support_conversations lookup: ${res.error.message}`);
  }

  const rows = res.data ?? [];
  const emails = await emailsByUserId(supabase, rows);
  return rows.map((row) => toAdminConversation(row, emails));
}

/**
 * Rozmowy czekające na człowieka, niezależnie od listy najnowszych: bez tego
 * eskalacja starsza niż 25 nowszych rozmów znikała z panelu, a przy braku
 * Slacka nikt by o niej nie wiedział. Prośby klienta są na górze.
 */
export async function getEscalatedConversations(
  limit = ESCALATED_LIMIT,
): Promise<AdminSupportConversation[]> {
  await requireAdmin();
  const supabase = createAdminClient();
  const res = await supportConversations(supabase)
    .eq('status', 'escalated')
    .order('escalated_at', { ascending: false })
    .limit(limit);

  if (res.error) {
    throw new Error(`support_conversations escalated lookup: ${res.error.message}`);
  }

  const rows = res.data ?? [];
  const emails = await emailsByUserId(supabase, rows);
  const prosba = (row: SupportConvRow) => (row.escalation_reason === 'user_requested' ? 0 : 1);
  return [...rows]
    .sort((a, b) => prosba(a) - prosba(b))
    .map((row) => toAdminConversation(row, emails));
}

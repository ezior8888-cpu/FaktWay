import { TeamManagement } from '@/components/team/team-management';
import { emailsForUserIds } from '@/lib/auth/auth-users';
import { getPageContextWithRole } from '@/lib/supabase/page-context';
import { createAdminClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

export interface TeamMember {
  membershipId: string;
  userId: string;
  email: string;
  name: string;
  role: 'owner' | 'admin' | 'member' | 'accountant';
  status: string;
  joinedAt: string;
  isYou: boolean;
}

export interface PendingInvitation {
  id: string;
  email: string;
  role: string;
  invitedAt: string;
  expiresAt: string;
}

export interface PendingJoinRequest {
  id: string;
  userId: string;
  email: string;
  name: string;
  message: string | null;
  createdAt: string;
}

export default async function TeamSettingsPage() {
  const { supabase, tenantId, role, user } = await getPageContextWithRole(
    ['owner', 'admin'],
    '/settings',
  );

  // Lista członków org. Cross-schema email tylko przez admin client.
  const { data: memberships } = await supabase
    .from('memberships')
    .select('id, user_id, role, status, joined_at, users!inner(name)')
    .eq('organization_id', tenantId)
    .order('joined_at', { ascending: true });

  const { data: pendingInvitations } = await supabase
    .from('organization_invitations')
    .select('id, email, role, invited_at, expires_at')
    .eq('organization_id', tenantId)
    .is('accepted_at', null)
    .is('revoked_at', null)
    .order('invited_at', { ascending: false });

  const { data: pendingJoinRequests } = await supabase
    .from('organization_join_requests')
    .select(
      'id, requested_by_user_id, message, created_at, users!inner(name)',
    )
    .eq('organization_id', tenantId)
    .eq('status', 'pending')
    .order('created_at', { ascending: false });

  // Email map z auth.users (admin client; jedyny sposób na email).
  const admin = createAdminClient();
  const userIds = new Set<string>();
  (memberships ?? []).forEach((m) => userIds.add(m.user_id));
  (pendingJoinRequests ?? []).forEach((r) =>
    userIds.add(r.requested_by_user_id),
  );

  // Po identyfikatorach, nie z pierwszej strony wszystkich kont (AUD-125).
  const emailMap = userIds.size > 0 ? await emailsForUserIds(admin, userIds) : new Map<string, string>();

  type MembershipRow = {
    id: string;
    user_id: string;
    role: string;
    status: string;
    joined_at: string;
    users: { name: string | null } | { name: string | null }[] | null;
  };

  const members: TeamMember[] = ((memberships ?? []) as MembershipRow[]).map(
    (m) => {
      const u = Array.isArray(m.users) ? m.users[0] : m.users;
      return {
        membershipId: m.id,
        userId: m.user_id,
        email: emailMap.get(m.user_id) ?? '',
        name: u?.name ?? '(bez nazwy)',
        role: m.role as TeamMember['role'],
        status: m.status,
        joinedAt: m.joined_at,
        isYou: m.user_id === user.id,
      };
    },
  );

  const invitations: PendingInvitation[] = (pendingInvitations ?? []).map(
    (i) => ({
      id: i.id,
      email: i.email as unknown as string,
      role: i.role,
      invitedAt: i.invited_at,
      expiresAt: i.expires_at,
    }),
  );

  type JoinRow = {
    id: string;
    requested_by_user_id: string;
    message: string | null;
    created_at: string;
    users: { name: string | null } | { name: string | null }[] | null;
  };

  const joinRequests: PendingJoinRequest[] = (
    (pendingJoinRequests ?? []) as JoinRow[]
  ).map((r) => {
    const u = Array.isArray(r.users) ? r.users[0] : r.users;
    return {
      id: r.id,
      userId: r.requested_by_user_id,
      email: emailMap.get(r.requested_by_user_id) ?? '',
      name: u?.name ?? '(bez nazwy)',
      message: r.message,
      createdAt: r.created_at,
    };
  });

  // Zakładka „Zespół” (plan P14, bez odpowiednika w Finorze) — sekcje
  // i wiersze Finory w `TeamManagement`.
  return (
    <TeamManagement
      members={members}
      invitations={invitations}
      joinRequests={joinRequests}
      currentRole={role}
    />
  );
}

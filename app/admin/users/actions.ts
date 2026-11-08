'use server';

import { revalidatePath } from 'next/cache';

import { requireAdmin } from '@/lib/auth/admin-guard';
import { logAuditSystem } from '@/lib/audit/log-system';
import { anonymizeUserAuditLogs, findUserDeletionForeignKeyBlockers } from '@/lib/gdpr/account-deletion-steps';
import { findOrganizationsBlockingDeletion } from '@/lib/gdpr/deletion-blockers';
import { createAdminClient } from '@/lib/supabase/admin';
import { deleteUserSupportConversations } from '@/lib/support/retention';

/**
 * Server actions dla `/admin/users/[userId]` (Faza 24).
 *
 * Każda akcja:
 *   1. Wywołuje `requireAdmin()` na początku (defense-in-depth — strona
 *      sama też jest pre-guarded przez layout, ale akcja może być
 *      teoretycznie wywołana z innej strony).
 *   2. Robi operację przez `createAdminClient` (service_role).
 *   3. Zapisuje audyt do `audit_logs` z prefixem `admin.*`.
 *   4. `revalidatePath` żeby UI dostał świeże dane bez F5.
 *
 * Discriminated result zamiast rzucania — UI klient odbiera `success: false`
 * i pokazuje toast/banner.
 */

export type AdminActionResult =
  | { success: true; message?: string }
  | { success: false; error: string };

// ─── 1. Suspend / Unsuspend ─────────────────────────────────────────

export async function suspendUserAction(
  userId: string,
): Promise<AdminActionResult> {
  const admin = await requireAdmin();
  if (admin.userId === userId) {
    return { success: false, error: 'Nie możesz zawiesić własnego konta' };
  }

  const supabase = createAdminClient();
  // `ban_duration` w Supabase admin API: '24h' / '7d' / 'forever' / '0s' (unban).
  const { error } = await supabase.auth.admin.updateUserById(userId, {
    ban_duration: '876000h', // 100 lat — de facto forever, bez końcowej daty Y10K
  });
  if (error) {
    return { success: false, error: error.message };
  }

  // A successful ban does not prove that existing sessions were revoked.

  await logAuditSystem({
    action: 'admin.user.suspended',
    tenantId: null,
    userId: admin.userId,
    entityType: 'user',
    entityId: userId,
    metadata: { adminEmail: admin.email, action: 'ban', sessionRevocation: 'unverified' },
  });

  revalidatePath(`/admin/users/${userId}`);
  revalidatePath('/admin/users');

  return {
    success: true,
    message: 'Konto zawieszone. Odwołanie istniejących sesji nie zostało potwierdzone.',
  };
}

export async function unsuspendUserAction(
  userId: string,
): Promise<AdminActionResult> {
  const admin = await requireAdmin();
  const supabase = createAdminClient();

  const { error } = await supabase.auth.admin.updateUserById(userId, {
    ban_duration: 'none',
  });
  if (error) {
    return { success: false, error: error.message };
  }

  await logAuditSystem({
    action: 'admin.user.unsuspended',
    tenantId: null,
    userId: admin.userId,
    entityType: 'user',
    entityId: userId,
    metadata: { adminEmail: admin.email },
  });

  revalidatePath(`/admin/users/${userId}`);
  revalidatePath('/admin/users');

  return { success: true, message: 'User odblokowany' };
}

// ─── 2. Force logout ────────────────────────────────────────────────

export async function forceLogoutAction(
  userId: string,
): Promise<AdminActionResult> {
  await requireAdmin();
  // Preserve the Server Action input contract while the operation is unavailable.
  void userId;

  // Auth admin.signOut requires a session JWT, not a user UUID. Keep this
  // action unavailable until a user-wide revocation flow is verified.
  return {
    success: false,
    error: 'Wymuszenie wylogowania jest obecnie niedostępne. Skontaktuj się z operatorem.',
  };
}

// ─── 3. Password reset trigger ──────────────────────────────────────

export async function sendPasswordResetAction(
  userId: string,
): Promise<AdminActionResult> {
  await requireAdmin();
  // Preserve the Server Action contract without creating an unusable bearer link.
  void userId;

  // generateLink does not send mail. A PKCE reset started by the operator binds
  // its verifier to the wrong browser. Implicit/OTP sessions do not establish
  // the trusted recovery proof required by our password-reset endpoint.
  return {
    success: false,
    error: 'Resetowanie hasła z panelu administratora jest niedostępne. Użytkownik może sam rozpocząć reset na stronie /forgot-password.',
  };
}

// ─── 4. GDPR delete ─────────────────────────────────────────────────

export async function deleteUserGdprAction(
  userId: string,
  confirmation: string,
): Promise<AdminActionResult> {
  const admin = await requireAdmin();
  if (admin.userId === userId) {
    return { success: false, error: 'Nie możesz usunąć własnego konta tym kanałem' };
  }
  if (confirmation !== 'DELETE') {
    return {
      success: false,
      error: 'Wymagane potwierdzenie — wpisz dokładnie DELETE',
    };
  }

  const supabase = createAdminClient();

  // Krok 0: te same sprawdzenia co ścieżka samoobsługowa (`executeGdprRequest`),
  // przed pierwszym zapisem — odmowa zostawia konto, firmy i dziennik nietknięte.
  // Subskrypcja jest przypięta do firmy: bez jedynej osoby, która nią zarządza,
  // Stripe dalej pobiera opłaty, a nikt nie może ich zatrzymać.
  let billingBlocked: string[];
  try {
    billingBlocked = await findOrganizationsBlockingDeletion(supabase, userId);
  } catch {
    return { success: false, error: 'Nie udało się sprawdzić subskrypcji firm użytkownika; konto nie zostało usunięte' };
  }
  if (billingBlocked.length > 0) {
    const names = billingBlocked.map((name) => `„${name}”`).join(', ');
    return {
      success: false,
      error: `Usunięcie wstrzymane: subskrypcja firmy ${names} dalej pobiera opłaty, a ten użytkownik jest jedyną osobą, która może nią zarządzać. Anuluj subskrypcję w Stripe albo dodaj firmie innego właściciela lub administratora i spróbuj ponownie. Konto nie zostało usunięte.`,
    };
  }
  // AUD-41: klucz obcy bez ON DELETE wywróciłby deleteUser PO odwołaniu
  // członkostw i anonimizacji dziennika.
  let foreignKeyBlockers: string[];
  try {
    foreignKeyBlockers = await findUserDeletionForeignKeyBlockers(supabase, userId);
  } catch {
    return { success: false, error: 'Nie udało się sprawdzić powiązań konta w bazie; konto nie zostało usunięte' };
  }
  if (foreignKeyBlockers.length > 0) {
    return {
      success: false,
      error: `Usunięcie wstrzymane: konto jest jeszcze wskazywane w ${foreignKeyBlockers.join(', ')} (klucz obcy bez ON DELETE). Przepisz albo usuń te wpisy i spróbuj ponownie. Konto nie zostało usunięte.`,
    };
  }

  // Krok 1: firmy, których user jest właścicielem — tylko do komunikatu
  // i audytu. Firm NIE ruszamy, jak ścieżka samoobsługowa
  // (`executeGdprRequest`). Przed tą zmianą panel stawiał tu `deleted_at`,
  // `hard_delete_at` (+30 dni) i `is_active = false` z obietnicą „hard delete
  // po 30 dniach” przez job `retention-delete` — a ten usuwa tylko faktury po
  // `invoices.scheduled_deletion_at` (10 lat), firm nie czyta. Tych flag nie
  // sprawdza też logowanie ani RLS, więc firma działała dalej.
  // Usunięcie firmy: docs/support/escalation-matrix.md („Usunięcie firmy”).
  const { data: ownerMemberships, error: membershipsReadError } = await supabase
    .from('memberships')
    .select('organization_id, role')
    .eq('user_id', userId)
    .eq('role', 'owner')
    .eq('status', 'active');

  // Revoked memberships retain their historical role, including owner.
  // Never infer an empty ownership scope from a failed read.
  if (membershipsReadError || !ownerMemberships) {
    return { success: false, error: 'Nie udało się odczytać aktywnych organizacji użytkownika' };
  }

  const ownerOrgIds = ownerMemberships.map((m) => m.organization_id);

  // Krok 2: usuń wszystkie membership usera (revoked).
  const { error: membershipsUpdateError } = await supabase
    .from('memberships')
    .update({ revoked_at: new Date().toISOString(), status: 'revoked' })
    .eq('user_id', userId);
  if (membershipsUpdateError) {
    return { success: false, error: 'Nie udało się odwołać członkostw; konto nie zostało usunięte' };
  }

  // Krok 3: rozmowy z czatem pomocy. FK user_id ma ON DELETE SET NULL, więc
  // po deleteUser zostałyby z treścią bez właściciela. Tuż przed kontem —
  // to nieodwracalne, a wcześniejsze kroki da się cofnąć.
  try {
    await deleteUserSupportConversations(supabase, userId);
  } catch {
    return { success: false, error: 'Nie udało się usunąć rozmów z czatem pomocy; konto nie zostało usunięte' };
  }

  // Krok 4: usuń konto z auth.users (cascada wpieprza notki, kontrahentów
  // gdzie user był created_by, etc.). Audyt zachowuje user_id w `audit_logs`
  // (snapshot ID po deletion).
  //
  // Najpierw anonimizacja dotychczasowych wpisów dziennika (polityka: „po
  // usunięciu Konta wpisy są anonimizowane”) — user_id, IP i przeglądarka
  // znikają; ID konta zostaje tylko we wpisie `admin.user.deleted` niżej.
  // Jak w ścieżce samoobsługowej: nieodwracalna, więc po krokach, które da się
  // cofnąć, i tuż przed deleteUser.
  try {
    await anonymizeUserAuditLogs(supabase, userId);
  } catch {
    return { success: false, error: 'Nie udało się zanonimizować dziennika zdarzeń; konto nie zostało usunięte' };
  }
  const { error } = await supabase.auth.admin.deleteUser(userId);
  if (error) {
    return { success: false, error: error.message };
  }

  await logAuditSystem({
    action: 'admin.user.deleted',
    tenantId: null,
    userId: admin.userId,
    entityType: 'user',
    entityId: userId,
    metadata: {
      adminEmail: admin.email,
      ownedOrgsLeftActive: ownerOrgIds.length,
      gdprDeletion: true,
    },
  });

  revalidatePath('/admin/users');
  return {
    success: true,
    message:
      ownerOrgIds.length > 0
        ? `Konto usunięte. Firmy, których był właścicielem (${ownerOrgIds.length}), działają dalej — usunięcie firmy to osobna procedura (docs/support/escalation-matrix.md).`
        : 'Konto usunięte.',
  };
}

// ─── 5. Internal notes — CRUD ───────────────────────────────────────

export async function addUserNoteAction(
  userId: string,
  body: string,
): Promise<AdminActionResult> {
  const admin = await requireAdmin();
  const trimmed = body.trim();
  if (trimmed.length < 1 || trimmed.length > 5000) {
    return { success: false, error: 'Notatka musi mieć 1-5000 znaków' };
  }

  const supabase = createAdminClient();
  const { error } = await supabase.from('admin_user_notes').insert({
    user_id: userId,
    author_user_id: admin.userId,
    author_email: admin.email,
    body: trimmed,
  });

  if (error) {
    return { success: false, error: error.message };
  }

  await logAuditSystem({
    action: 'admin.note.created',
    tenantId: null,
    userId: admin.userId,
    entityType: 'user',
    entityId: userId,
    metadata: { adminEmail: admin.email, bodyPreview: trimmed.slice(0, 80) },
  });

  revalidatePath(`/admin/users/${userId}`);
  return { success: true };
}

export async function archiveUserNoteAction(
  noteId: string,
): Promise<AdminActionResult> {
  const admin = await requireAdmin();
  const supabase = createAdminClient();

  const { data: note, error: selErr } = await supabase
    .from('admin_user_notes')
    .select('user_id')
    .eq('id', noteId)
    .single();

  if (selErr || !note) {
    return { success: false, error: 'Notatka nie istnieje' };
  }

  const { error } = await supabase
    .from('admin_user_notes')
    .update({ archived_at: new Date().toISOString() })
    .eq('id', noteId);

  if (error) {
    return { success: false, error: error.message };
  }

  await logAuditSystem({
    action: 'admin.note.archived',
    tenantId: null,
    userId: admin.userId,
    entityType: 'admin_user_notes',
    entityId: noteId,
    metadata: { adminEmail: admin.email, targetUserId: note.user_id },
  });

  revalidatePath(`/admin/users/${note.user_id}`);
  return { success: true };
}

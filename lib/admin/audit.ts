/**
 * Audit log search dla `/admin/audit` (Faza 24 Krok 5).
 *
 * `audit_logs` rośnie ~10k/dzień per aktywny tenant, więc widok admin wymaga
 * eksponowanej filtracji (user / action / tenant / date range). Indeksy z
 * migracji 00008 + 00042 (`idx_audit_logs_tenant_time`, `idx_audit_logs_action_time`,
 * BRIN na `created_at`) pokrywają główne osie filtrów.
 *
 * Pagination: limit+offset zamiast cursor — admin scrolluje rzadko poza
 * pierwszą stronę, a UX z numerami stron jest czytelniejszy w panelu.
 */

import 'server-only';

import { requireAdmin } from '@/lib/auth/admin-guard';
import { createAdminClient } from '@/lib/supabase/admin';

export interface AuditLogRow {
  id: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  tenantId: string | null;
  userId: string | null;
  metadata: unknown;
  createdAt: string;
  userAgent: string | null;
}

export interface AuditLogSearchOptions {
  /** Free-text na action (LIKE) — np. 'ksef.' albo 'admin.user'. */
  action?: string;
  /** Exact user UUID. */
  userId?: string;
  /** Exact tenant UUID. */
  tenantId?: string;
  /** ISO datetime lower bound. */
  from?: string;
  /** ISO datetime upper bound. */
  to?: string;
  page?: number;
  pageSize?: number;
}

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;

export async function searchAuditLogs(
  opts: AuditLogSearchOptions = {},
): Promise<{ items: AuditLogRow[]; total: number; page: number; pageSize: number }> {
  // Autoryzacja przy danych: layout nie gwarantuje kolejności odczytów potomka.
  await requireAdmin();
  const supabase = createAdminClient();
  const page = opts.page ?? 0;
  const pageSize = Math.min(opts.pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

  let query = supabase
    .from('audit_logs')
    .select(
      'id, action, entity_type, entity_id, tenant_id, user_id, metadata, created_at, user_agent',
      { count: 'exact' },
    );

  if (opts.action) {
    // PostgREST LIKE matching: `like` wymaga wildcards explicit. Wpisujemy `*`
    // przez `%` żeby user nie musiał myśleć — natural matching „contains".
    query = query.ilike('action', `%${opts.action}%`);
  }
  if (opts.userId) {
    query = query.eq('user_id', opts.userId);
  }
  if (opts.tenantId) {
    query = query.eq('tenant_id', opts.tenantId);
  }
  if (opts.from) {
    query = query.gte('created_at', opts.from);
  }
  if (opts.to) {
    query = query.lte('created_at', opts.to);
  }

  const from = page * pageSize;
  const to = from + pageSize - 1;

  const { data, count, error } = await query
    .order('created_at', { ascending: false })
    .range(from, to);

  if (error) {
    throw new Error(`audit_logs search failed: ${error.message}`);
  }

  return {
    items: (data ?? []).map((r) => ({
      id: r.id,
      action: r.action,
      entityType: r.entity_type,
      entityId: r.entity_id,
      tenantId: r.tenant_id,
      userId: r.user_id,
      metadata: r.metadata,
      createdAt: r.created_at,
      userAgent: r.user_agent,
    })),
    total: count ?? 0,
    page,
    pageSize,
  };
}

/**
 * Lista znanych akcji audytu (do dropdown'a / suggestion box w UI). Zwracamy
 * `AuditAction` union jako static array — synchronizacja ręczna z `lib/audit/log.ts`.
 */
export const KNOWN_AUDIT_ACTIONS = [
  // Auth
  'auth.login',
  'auth.logout',
  'auth.signup',
  'auth.password_reset_requested',
  'auth.passkey_added',
  'auth.passkey_removed',
  'auth.session_revoked',
  'auth.other_sessions_revoked',
  // Tenants
  'tenant.created',
  'tenant.updated',
  'tenant.user_role_changed',
  'tenant.ksef_verified',
  'tenant.ksef_nip_ownership_claimed',
  // Invoices
  'invoice.draft_created',
  'invoice.draft_updated',
  'invoice.draft_deleted',
  'invoice.submit_requested',
  'invoice.submit_redirected_offline',
  'invoice.submit_succeeded',
  'invoice.submit_failed',
  'invoice.upo_downloaded',
  'invoice.xml_downloaded',
  'invoice.share_link_created',
  'invoice.share_link_revoked',
  'invoice.resubmit_requested',
  // KSeF integration
  'ksef.credentials_uploaded',
  'ksef.credentials_removed',
  'ksef.environment_changed',
  'ksef.session.open',
  'ksef.session.close',
  'ksef.invoice.send',
  'ksef.invoice.poll',
  'ksef.upo.download',
  'ksef.inbox.poll',
  'ksef.auth.token',
  // Synchronizacja historii KSeF (decyzja Bartosza 22.10.2026).
  'ksef.history.query',
  'ksef.history.download',
  'ksef.history.paused',
  'ksef.history.resumed',
  'ksef.history.operator',
  // Accountants
  'accountant.expense_file_viewed',
  'accountant.expense_file_downloaded',
  'accountant.token_created',
  'accountant.token_revoked',
  'accountant.access_used',
  // Admin
  'admin.user.suspended',
  'admin.user.unsuspended',
  'admin.user.force_logout',
  'admin.user.password_reset_triggered',
  'admin.user.deleted',
  'admin.note.created',
  'admin.note.archived',
  'admin.flag.toggled',
  // Stripe refunds
  'billing.refund.issued',
  'billing.refund.reconciliation_required',
] as const;

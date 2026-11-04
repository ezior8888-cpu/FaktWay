import { createHash, randomBytes } from 'crypto';
import { createAdminClient } from '@/lib/supabase/server';
import type { createClient } from '@/lib/supabase/server';
import { deleteUserSupportConversations } from '@/lib/support/retention';
import { findOrganizationsBlockingDeletion, GdprDeletionBlockedError } from './deletion-blockers';

import { GDPR_COOLING_OFF_DAYS } from './deletion-constants';

export { GDPR_COOLING_OFF_DAYS };

type GdprStatus = 'pending' | 'processing' | 'canceled' | 'executed' | 'failed';
interface GdprRequestRow {
  id: string;
  user_id: string | null;
  user_email: string;
  scheduled_for: string;
  status: GdprStatus;
  cancel_token_hash: string;
  processing_started_at: string | null;
  executed_at: string | null;
  failure_reason: string | null;
  cancel_reason: string | null;
  ip_address: string | null;
  user_agent: string | null;
}
interface QueryResult<T> {
  data: T | null;
  error: { message: string; code?: string } | null;
}
interface GdprSelectChain extends PromiseLike<QueryResult<GdprRequestRow[]>> {
  eq: (key: string, value: string) => GdprSelectChain;
  in: (key: string, values: string[]) => GdprSelectChain;
  lte: (key: string, value: string) => GdprSelectChain;
  maybeSingle: () => Promise<QueryResult<GdprRequestRow>>;
}
interface GdprUpdateChain extends PromiseLike<QueryResult<GdprRequestRow[]>> {
  eq: (key: string, value: string) => GdprUpdateChain;
  lte: (key: string, value: string) => GdprUpdateChain;
  select: (columns: string) => GdprSelectChain;
}
interface GdprTable {
  from: (name: 'gdpr_deletion_requests') => {
    select: (columns: string) => GdprSelectChain;
    insert: (rows: Array<Partial<GdprRequestRow>>) => {
      select: (columns: string) => GdprSelectChain;
    };
    update: (patch: Partial<GdprRequestRow>) => GdprUpdateChain;
  };
}

export interface CreateGdprRequestInput {
  userId: string;
  userEmail: string;
  ipAddress?: string;
  userAgent?: string;
}
export interface CreatedGdprRequest {
  id: string;
  scheduledFor: Date;
  /** Tylko dla nowego żądania; istniejącego tokenu nie odzyskujemy ani nie obracamy. */
  cancelToken: string | null;
  alreadyScheduled: boolean;
}
export type ActiveGdprRequest = Pick<GdprRequestRow, 'id' | 'scheduled_for'> & {
  status: 'pending' | 'processing';
};

async function readActiveRequest(admin: GdprTable, userId: string): Promise<ActiveGdprRequest | null> {
  const result = await admin.from('gdpr_deletion_requests')
    .select('id, scheduled_for, status')
    .eq('user_id', userId)
    .in('status', ['pending', 'processing'])
    .maybeSingle();
  // Duplikaty w starej bazie też powodują błąd maybeSingle: nie tworzymy następnego.
  if (result.error) throw new Error('gdpr_request_lookup_failed');
  if (!result.data) return null;
  if (result.data.status !== 'pending' && result.data.status !== 'processing') {
    throw new Error('gdpr_request_invalid_state');
  }
  return { id: result.data.id, scheduled_for: result.data.scheduled_for, status: result.data.status };
}

/** userId musi pochodzić ze zweryfikowanej sesji wywołującego. */
export async function getActiveGdprRequest(
  supabase: Awaited<ReturnType<typeof createClient>>, userId: string,
): Promise<ActiveGdprRequest | null> {
  return readActiveRequest(supabase as unknown as GdprTable, userId);
}

function existingRequest(request: ActiveGdprRequest): CreatedGdprRequest {
  if (request.status === 'processing') throw new Error('gdpr_request_processing');
  return { id: request.id, scheduledFor: new Date(request.scheduled_for), cancelToken: null, alreadyScheduled: true };
}

/**
 * Wymaga UNIQUE aktywnego user_id z propozycji schematu GDPR dla właściciela repo.
 * Rzuca `GdprDeletionBlockedError`, gdy po usunięciu konta subskrypcja firmy
 * pobierałaby opłaty bez nikogo, kto może ją anulować.
 */
export async function createGdprRequest(input: CreateGdprRequestInput): Promise<CreatedGdprRequest> {
  const client = createAdminClient();
  const admin = client as unknown as GdprTable;
  const existing = await readActiveRequest(admin, input.userId);
  if (existing) return existingRequest(existing);

  const blocking = await findOrganizationsBlockingDeletion(client, input.userId);
  if (blocking.length > 0) throw new GdprDeletionBlockedError(blocking);

  const cancelToken = randomBytes(32).toString('hex');
  const scheduledFor = new Date(Date.now() + GDPR_COOLING_OFF_DAYS * 24 * 60 * 60 * 1000);
  const inserted = await admin.from('gdpr_deletion_requests').insert([{
    user_id: input.userId,
    user_email: input.userEmail,
    scheduled_for: scheduledFor.toISOString(),
    cancel_token_hash: createHash('sha256').update(cancelToken).digest('hex'),
    ip_address: input.ipAddress ?? null,
    user_agent: input.userAgent ?? null,
  }]).select('id, scheduled_for').maybeSingle();

  if (inserted.error?.code === '23505') {
    // Inne równoległe żądanie wygrało UNIQUE. Nie podmieniamy jego tokenu.
    const winner = await readActiveRequest(admin, input.userId);
    if (winner) return existingRequest(winner);
    throw new Error('gdpr_request_conflict_retry');
  }
  if (inserted.error || !inserted.data) throw new Error('gdpr_request_insert_failed');
  return { id: inserted.data.id, scheduledFor: new Date(inserted.data.scheduled_for), cancelToken, alreadyScheduled: false };
}

type CancelResult = { ok: true; requestId: string } | { ok: false };
export async function cancelGdprRequest(cancelToken: string, reason: string | null): Promise<CancelResult> {
  if (!/^[a-f0-9]{64}$/.test(cancelToken)) return { ok: false };
  const admin = createAdminClient() as unknown as GdprTable;
  const result = await admin.from('gdpr_deletion_requests')
    .update({ status: 'canceled', cancel_reason: reason })
    .eq('cancel_token_hash', createHash('sha256').update(cancelToken).digest('hex'))
    .eq('status', 'pending').select('id').maybeSingle();
  if (result.error || !result.data) return { ok: false };
  return { ok: true, requestId: result.data.id };
}

/** Wyłącznie po uwierzytelnieniu userId i ponownym potwierdzeniu hasła w akcji. */
export async function cancelOwnGdprRequest(userId: string): Promise<CancelResult> {
  const admin = createAdminClient() as unknown as GdprTable;
  const result = await admin.from('gdpr_deletion_requests')
    .update({ status: 'canceled', cancel_reason: 'authenticated_user_confirmed' })
    .eq('user_id', userId).eq('status', 'pending').select('id').maybeSingle();
  if (result.error || !result.data) return { ok: false };
  return { ok: true, requestId: result.data.id };
}

export async function findDueGdprRequests(): Promise<Array<Pick<GdprRequestRow, 'id' | 'scheduled_for' | 'status'>>> {
  const admin = createAdminClient() as unknown as GdprTable;
  const result = await admin.from('gdpr_deletion_requests')
    .select('id, scheduled_for, status')
    .eq('status', 'pending').lte('scheduled_for', new Date().toISOString());
  if (result.error) throw new Error('gdpr_due_requests_lookup_failed');
  return result.data ?? [];
}

/**
 * Tylko zwycięzca atomowego pending -> processing może usuwać dane.
 * Anulowanie też wymaga pending. Osierocony processing wymaga ręcznej kontroli;
 * automatyczne ponowienie byłoby niebezpieczne po częściowo wykonanym usunięciu.
 */
export async function executeGdprRequest(requestId: string): Promise<{ ok: boolean; error?: string }> {
  const admin = createAdminClient();
  const now = new Date().toISOString();
  const claimed = await (admin as unknown as GdprTable).from('gdpr_deletion_requests')
    .update({ status: 'processing', processing_started_at: now })
    .eq('id', requestId).eq('status', 'pending').lte('scheduled_for', now)
    .select('id, user_id').maybeSingle();
  if (claimed.error) return { ok: false, error: 'request_claim_failed' };
  if (!claimed.data) return { ok: false, error: 'request_not_pending_or_not_due' };

  try {
    const userId = claimed.data.user_id;
    if (!userId) throw new Error('user_id_missing');
    // Subskrypcja mogła wrócić w okresie na wycofanie decyzji. Sprawdzamy
    // przed jakimkolwiek skutkiem; odmowa zostawia konto nietknięte.
    if ((await findOrganizationsBlockingDeletion(admin, userId)).length > 0) {
      throw new Error('active_subscription_sole_billing_manager');
    }
    // Klucz obcy bez ON DELETE wywróciłby deleteUser PO nieodwracalnej
    // anonimizacji dziennika (AUD-41). Sprawdzamy przed nią.
    const fkCheck = await (
      admin.rpc as unknown as (
        fn: 'gdpr_user_deletion_blockers', args: { p_user_id: string },
      ) => Promise<{ data: unknown; error: { message: string } | null }>
    )('gdpr_user_deletion_blockers', { p_user_id: userId });
    if (fkCheck.error || !Array.isArray(fkCheck.data)) throw new Error('deletion_blockers_check_failed');
    if (fkCheck.data.length > 0) throw new Error(`user_still_referenced: ${fkCheck.data.join(', ')}`);
    // Czat pomocy: FK user_id ma ON DELETE SET NULL, więc deleteUser zostawiłby
    // rozmowy z treścią bez właściciela. Po sprawdzeniach (odmowa = brak skutków),
    // przed anonimizacją i deleteUser; błąd zostawia konto nietknięte.
    await deleteUserSupportConversations(admin, userId);
    const anonRpc = await (
      admin.rpc as unknown as (
        fn: 'anonymize_user_audit_logs', args: { p_user_id: string },
      ) => Promise<{ data: unknown; error: { message: string } | null }>
    )('anonymize_user_audit_logs', { p_user_id: userId });
    if (anonRpc.error) throw new Error('audit_anonymize_failed');
    const { error: authDelErr } = await admin.auth.admin.deleteUser(userId);
    if (authDelErr) throw new Error('auth_delete_failed');
    const completed = await (admin as unknown as GdprTable).from('gdpr_deletion_requests')
      .update({ status: 'executed', executed_at: new Date().toISOString() })
      .eq('id', requestId).eq('status', 'processing').select('id').maybeSingle();
    if (completed.error || !completed.data) throw new Error('request_completion_failed');
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown_error';
    await (admin as unknown as GdprTable).from('gdpr_deletion_requests')
      .update({ status: 'failed', failure_reason: message })
      .eq('id', requestId).eq('status', 'processing');
    return { ok: false, error: message };
  }
}

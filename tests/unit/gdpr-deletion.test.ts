import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cancelGdprRequest, cancelOwnGdprRequest, createGdprRequest,
  executeGdprRequest, findDueGdprRequests, getActiveGdprRequest,
} from '@/lib/gdpr/deletion';

import { GdprDeletionBlockedError } from '@/lib/gdpr/deletion-blockers';

const mocks = vi.hoisted(() => ({ createAdminClient: vi.fn() }));
vi.mock('@/lib/supabase/server', () => mocks);
const blockers = vi.hoisted(() => ({ find: vi.fn<() => Promise<string[]>>() }));
vi.mock('@/lib/gdpr/deletion-blockers', async (orig) => ({
  ...(await orig<typeof import('@/lib/gdpr/deletion-blockers')>()),
  findOrganizationsBlockingDeletion: blockers.find,
}));

type Row = Record<string, string | null>;
type DbResult = { data: Row[] | null; error: { message: string; code?: string } | null };
type Operation = {
  kind: 'select' | 'insert' | 'update'; values: Row | null;
  filters: Array<[string, string]>; included: Array<[string, string[]]>;
};
function database() {
  const rows: Row[] = [];
  const operations: Operation[] = [];
  // Sprawdzenie blokad (AUD-41) domyślnie: nic nie blokuje.
  const rpc = vi.fn(async (fn: string, _args?: unknown) => ({
    data: (fn === 'gdpr_user_deletion_blockers' ? [] : null) as unknown,
    error: null as { message: string } | null,
  }));
  const deleteUser = vi.fn<(userId: string) => Promise<{ error: { message: string } | null }>>()
    .mockResolvedValue({ error: null });
  let lookupError = false;
  let pageSize = 1000;
  let sequence = 0;
  // Rozmowy z czatem pomocy (00054): user_id ON DELETE SET NULL — bez
  // jawnego usunięcia zostają z treścią po skasowaniu konta.
  const support: Array<{ id: string; user_id: string | null }> = [];
  const effects: string[] = [];
  let supportDeleteError = false;
  rpc.mockImplementation(async (fn: string) => {
    effects.push(fn);
    return { data: (fn === 'gdpr_user_deletion_blockers' ? [] : null) as unknown, error: null };
  });
  deleteUser.mockImplementation(async () => {
    effects.push('deleteUser');
    return { error: null };
  });
  function supportTable() {
    let userId: string | undefined;
    let deleting = false;
    const execute = () => {
      effects.push('support_conversations.delete');
      expect(deleting).toBe(true);
      if (supportDeleteError) return { data: null, error: { message: 'synthetic chat delete failure' }, count: null };
      const before = support.length;
      // DELETE bez WHERE kasuje wszystko — pominięty filtr zmienia wynik.
      for (let i = support.length - 1; i >= 0; i--) {
        if (userId === undefined || support[i].user_id === userId) support.splice(i, 1);
      }
      return { data: null, error: null, count: before - support.length };
    };
    const query = {
      delete: () => { deleting = true; return query; },
      eq: (key: string, value: string) => { expect(key).toBe('user_id'); userId = value; return query; },
      then: (
        onfulfilled: (value: ReturnType<typeof execute>) => unknown,
        onrejected?: (reason: unknown) => unknown,
      ) => Promise.resolve().then(execute).then(onfulfilled, onrejected),
    };
    return query;
  }
  const from = vi.fn((table?: string) => {
    if (table === 'support_conversations') return supportTable() as never;
    let fields = '*';
    let due: string | undefined;
    const operation: Operation = { kind: 'select', values: null, filters: [], included: [] };
    const project = (row: Row): Row => fields === '*' ? { ...row }
      : Object.fromEntries(fields.split(',').map((key) => [key.trim(), row[key.trim()]]));
    const execute = (): DbResult => {
      operations.push(structuredClone(operation));
      if (operation.kind === 'select' && lookupError) return { data: null, error: { message: 'database unavailable' } };
      if (operation.kind === 'insert') {
        // Model wymaganego UNIQUE z propozycji schematu; nie wykonujemy SQL.
        if (rows.some((row) => row.user_id === operation.values?.user_id
          && ['pending', 'processing'].includes(row.status ?? ''))) {
          return { data: null, error: { code: '23505', message: 'active user constraint' } };
        }
        const row = { id: 'request-' + ++sequence, status: 'pending', ...operation.values };
        rows.push(row);
        return { data: [project(row)], error: null };
      }
      const matching = rows.filter((row) => operation.filters.every(([key, value]) => row[key] === value)
        && operation.included.every(([key, values]) => values.includes(row[key] ?? ''))
        && (!due || (row.scheduled_for ?? '') <= due));
      if (operation.kind === 'update') {
        for (const row of matching) Object.assign(row, operation.values);
      }
      return { data: matching.slice(0, pageSize).map(project), error: null };
    };
    const query = {
      select(columns: string) { fields = columns; return query; },
      eq(key: string, value: string) { operation.filters.push([key, value]); return query; },
      in(key: string, values: string[]) { operation.included.push([key, values]); return query; },
      insert(values: Row[]) { operation.kind = 'insert'; operation.values = values[0]; return query; },
      update(values: Row) { operation.kind = 'update'; operation.values = values; return query; },
      lte(_key: string, value: string) { due = value; return query; },
      then<TResult1 = DbResult, TResult2 = never>(
        onfulfilled?: ((value: DbResult) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ): Promise<TResult1 | TResult2> { return Promise.resolve(execute()).then(onfulfilled, onrejected); },
      async maybeSingle() {
        const result = execute();
        if ((result.data?.length ?? 0) > 1) return { data: null, error: { code: 'PGRST116', message: 'multiple rows' } };
        return { data: result.data?.[0] ?? null, error: result.error };
      },
    };
    return query;
  });
  return {
    rows, operations, from, rpc, auth: { admin: { deleteUser } }, support, effects,
    failLookup: () => { lookupError = true; },
    setPageSize: (size: number) => { pageSize = size; },
    failSupportDelete: () => { supportDeleteError = true; },
  };
}
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const input = { userId: 'user-1', userEmail: 'owner@example.test' };
let db: ReturnType<typeof database>;
beforeEach(() => {
  vi.clearAllMocks(); db = database(); mocks.createAdminClient.mockReturnValue(db);
  blockers.find.mockReset().mockResolvedValue([]);
});

function dueRequest() {
  const token = 'ab'.repeat(32);
  db.rows.push({ id: 'due-request', status: 'pending', user_id: input.userId,
    user_email: input.userEmail, scheduled_for: '2020-01-01', cancel_token_hash: hash(token) });
  return token;
}

describe('GDPR token and request safety', () => {
  it('stores only SHA-256 and returns plaintext only for a new email', async () => {
    const created = await createGdprRequest(input);
    expect(created.cancelToken).toMatch(/^[a-f0-9]{64}$/);
    expect(created.alreadyScheduled).toBe(false);
    expect(db.rows[0].cancel_token_hash).toBe(hash(created.cancelToken!));
    expect(db.rows[0]).not.toHaveProperty('cancel_token');
    expect(JSON.stringify(db.operations)).not.toContain(created.cancelToken);
  });

  it('accepts the raw link once but never a hash stolen from the database', async () => {
    const created = await createGdprRequest(input);
    expect(await cancelGdprRequest(db.rows[0].cancel_token_hash!, null)).toEqual({ ok: false });
    expect(db.rows[0].status).toBe('pending');
    expect(await cancelGdprRequest(created.cancelToken!, 'confirmed')).toEqual({ ok: true, requestId: created.id });
    expect(await cancelGdprRequest(created.cancelToken!, null)).toEqual({ ok: false });
  });

  it('keeps old email links usable after a hash backfill', async () => {
    const token = dueRequest();
    expect((await cancelGdprRequest(token, null)).ok).toBe(true);
  });

  it('repeated requests preserve the previous token and deadline without a new email token', async () => {
    const first = await createGdprRequest(input);
    const savedHash = db.rows[0].cancel_token_hash;
    const second = await createGdprRequest(input);
    expect(db.rows).toHaveLength(1);
    expect(second).toEqual({ id: first.id, scheduledFor: first.scheduledFor, cancelToken: null, alreadyScheduled: true });
    expect(db.rows[0].cancel_token_hash).toBe(savedHash);
    expect((await cancelGdprRequest(first.cancelToken!, null)).ok).toBe(true);
  });

  it('handles a concurrent UNIQUE conflict by reusing the winning request without rotating its token', async () => {
    const results = await Promise.all([createGdprRequest(input), createGdprRequest(input)]);
    expect(db.rows).toHaveLength(1);
    const created = results.find((result) => !result.alreadyScheduled)!;
    const repeated = results.find((result) => result.alreadyScheduled)!;
    expect(repeated.id).toBe(created.id);
    expect(repeated.cancelToken).toBeNull();
    expect((await cancelGdprRequest(created.cancelToken!, null)).ok).toBe(true);
    expect(db.rows.every((row) => row.status === 'canceled')).toBe(true);
  });

  it('refuses to create another request when lookup fails or legacy active duplicates exist', async () => {
    db.failLookup();
    await expect(createGdprRequest(input)).rejects.toThrow('gdpr_request_lookup_failed');
    expect(db.rows).toHaveLength(0);
    db = database(); mocks.createAdminClient.mockReturnValue(db);
    dueRequest(); db.rows.push({ ...db.rows[0], id: 'legacy-duplicate' });
    await expect(createGdprRequest(input)).rejects.toThrow('gdpr_request_lookup_failed');
    expect(db.rows).toHaveLength(2);
  });

  it('refuses a new request while the subscription would keep billing after deletion', async () => {
    blockers.find.mockResolvedValue(['Firma Testowa']);
    const refused = await createGdprRequest(input).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(GdprDeletionBlockedError);
    expect((refused as GdprDeletionBlockedError).organizations).toEqual(['Firma Testowa']);
    expect(blockers.find).toHaveBeenCalledWith(db, input.userId);
    expect(db.rows).toHaveLength(0);
  });

  it('returns an already scheduled request without re-checking or touching it', async () => {
    dueRequest(); blockers.find.mockResolvedValue(['Firma Testowa']);
    expect(await createGdprRequest(input)).toMatchObject({ id: 'due-request', alreadyScheduled: true });
    expect(db.rows).toHaveLength(1);
  });

  it('does not create a new request while deletion is processing', async () => {
    dueRequest(); db.rows[0].status = 'processing';
    await expect(createGdprRequest(input)).rejects.toThrow('gdpr_request_processing');
    expect(db.rows).toHaveLength(1);
  });

  it('allows own authenticated cancellation without an email token and leaves other users untouched', async () => {
    dueRequest();
    db.rows.push({ ...db.rows[0], id: 'other-request', user_id: 'other-user' });
    expect(await cancelOwnGdprRequest(input.userId)).toEqual({ ok: true, requestId: 'due-request' });
    expect(db.rows[0].status).toBe('canceled');
    expect(db.rows[1].status).toBe('pending');
  });

  it('active request UI data excludes the token hash and email', async () => {
    dueRequest();
    expect(await getActiveGdprRequest(db as unknown as Parameters<typeof getActiveGdprRequest>[0], input.userId)).toEqual({ id: 'due-request', scheduled_for: '2020-01-01', status: 'pending' });
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
  });

  it('rejects malformed tokens before accessing the database', async () => {
    for (const token of ['', 'short', '../token', 'a'.repeat(65)]) expect(await cancelGdprRequest(token, null)).toEqual({ ok: false });
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
  });

  it('filters pending before the database page limit so old completed rows cannot starve work', async () => {
    db.setPageSize(2);
    for (let index = 0; index < 3; index++) db.rows.push({ id: 'old-' + index, status: 'executed', scheduled_for: '2020-01-01' });
    dueRequest();
    expect(await findDueGdprRequests()).toEqual([{ id: 'due-request', scheduled_for: '2020-01-01', status: 'pending' }]);
  });

  it('reports failure to read due requests instead of silently reporting an empty queue', async () => {
    db.failLookup();
    await expect(findDueGdprRequests()).rejects.toThrow('gdpr_due_requests_lookup_failed');
  });
});

describe('GDPR atomic processing claim', () => {
  it('does not claim or delete before the cooling-off deadline', async () => {
    dueRequest(); db.rows[0].scheduled_for = '2099-01-01';
    expect((await executeGdprRequest('due-request')).ok).toBe(false);
    expect(db.rows[0].status).toBe('pending');
    expect(db.rpc).not.toHaveBeenCalled();
    expect(db.auth.admin.deleteUser).not.toHaveBeenCalled();
  });

  it('does not delete if cancellation won the row first', async () => {
    const token = dueRequest();
    expect((await cancelGdprRequest(token, null)).ok).toBe(true);
    expect((await executeGdprRequest('due-request')).ok).toBe(false);
    expect(db.rpc).not.toHaveBeenCalled();
    expect(db.auth.admin.deleteUser).not.toHaveBeenCalled();
  });

  it('allows only one worker and rejects both cancellation paths after its claim', async () => {
    const token = dueRequest();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    db.rpc.mockImplementation(async (fn: string) => {
      if (fn === 'anonymize_user_audit_logs') await gate;
      return { data: fn === 'gdpr_user_deletion_blockers' ? [] : null, error: null };
    });
    const first = executeGdprRequest('due-request');
    await Promise.resolve();
    expect(db.rows[0].status).toBe('processing');
    expect(db.rows[0].processing_started_at).toBeTruthy();
    expect((await cancelGdprRequest(token, null)).ok).toBe(false);
    expect((await cancelOwnGdprRequest(input.userId)).ok).toBe(false);
    expect((await executeGdprRequest('due-request')).ok).toBe(false);
    expect(db.auth.admin.deleteUser).not.toHaveBeenCalled();
    release();
    expect(await first).toEqual({ ok: true });
    expect(db.rpc.mock.calls.filter(([fn]) => fn === 'anonymize_user_audit_logs')).toHaveLength(1);
    expect(db.auth.admin.deleteUser).toHaveBeenCalledExactlyOnceWith(input.userId);
    expect(db.rows[0].status).toBe('executed');
  });

  it('never reclaims processing left by a crashed worker', async () => {
    dueRequest(); db.rows[0].status = 'processing'; db.rows[0].processing_started_at = '2020-01-01';
    expect((await executeGdprRequest('due-request')).ok).toBe(false);
    expect(db.rows[0].status).toBe('processing');
    expect(db.rpc).not.toHaveBeenCalled();
    expect(db.auth.admin.deleteUser).not.toHaveBeenCalled();
  });

  it('does not anonymize or delete when the subscription would keep billing nobody', async () => {
    dueRequest(); blockers.find.mockResolvedValue(['Firma Testowa']);
    expect(await executeGdprRequest('due-request')).toEqual({ ok: false, error: 'active_subscription_sole_billing_manager' });
    expect(blockers.find).toHaveBeenCalledWith(db, input.userId);
    expect(db.rpc).not.toHaveBeenCalled();
    expect(db.auth.admin.deleteUser).not.toHaveBeenCalled();
    expect(db.rows[0]).toMatchObject({ status: 'failed', failure_reason: 'active_subscription_sole_billing_manager' });
  });

  it('stops before any effect when the subscription check cannot be read', async () => {
    dueRequest(); blockers.find.mockRejectedValue(new Error('gdpr_blocker_lookup_failed'));
    expect(await executeGdprRequest('due-request')).toEqual({ ok: false, error: 'gdpr_blocker_lookup_failed' });
    expect(db.rpc).not.toHaveBeenCalled();
    expect(db.auth.admin.deleteUser).not.toHaveBeenCalled();
  });

  // AUD-41: klucz obcy bez ON DELETE wywracał deleteUser PO nieodwracalnej
  // anonimizacji dziennika. Sprawdzenie idzie przed anonimizacją.
  it('does not anonymize when another foreign key would still stop the deletion', async () => {
    dueRequest();
    db.rpc.mockImplementation(async (fn: string) => ({
      data: fn === 'gdpr_user_deletion_blockers' ? ['public.stripe_financial_case_reviews.reviewer_user_id'] : null,
      error: null,
    }));
    expect(await executeGdprRequest('due-request')).toEqual({
      ok: false, error: 'user_still_referenced: public.stripe_financial_case_reviews.reviewer_user_id',
    });
    expect(db.rpc).toHaveBeenCalledWith('gdpr_user_deletion_blockers', { p_user_id: input.userId });
    expect(db.rpc).not.toHaveBeenCalledWith('anonymize_user_audit_logs', expect.anything());
    expect(db.auth.admin.deleteUser).not.toHaveBeenCalled();
    expect(db.rows[0].status).toBe('failed');
  });

  it.each([
    ['błąd odczytu', { data: null, error: { message: 'boom' } }],
    ['odpowiedź nie jest listą', { data: null, error: null }],
  ])('stops before anonymization when the foreign key check fails (%s)', async (_label, response) => {
    dueRequest();
    db.rpc.mockImplementation(async (fn: string) => (
      fn === 'gdpr_user_deletion_blockers' ? response : { data: null, error: null }
    ));
    expect(await executeGdprRequest('due-request')).toEqual({ ok: false, error: 'deletion_blockers_check_failed' });
    expect(db.rpc).not.toHaveBeenCalledWith('anonymize_user_audit_logs', expect.anything());
    expect(db.auth.admin.deleteUser).not.toHaveBeenCalled();
  });

  it('checks foreign keys before anonymizing, then deletes', async () => {
    dueRequest();
    expect(await executeGdprRequest('due-request')).toEqual({ ok: true });
    expect(db.rpc.mock.calls.map(([fn]) => fn)).toEqual(['gdpr_user_deletion_blockers', 'anonymize_user_audit_logs']);
  });

  // Polityka prywatności: rozmowy z czatem pomocy „do 24 miesięcy od ostatniej
  // wiadomości”. FK `support_conversations.user_id` ma ON DELETE SET NULL, więc
  // samo deleteUser zostawiało rozmowy z treścią bez właściciela na zawsze.
  it('deletes the user support chat before the account, leaving other users chats', async () => {
    dueRequest();
    db.support.push(
      { id: 'chat-own-1', user_id: input.userId },
      { id: 'chat-own-2', user_id: input.userId },
      { id: 'chat-other', user_id: 'other-user' },
    );
    expect(await executeGdprRequest('due-request')).toEqual({ ok: true });
    expect(db.support).toEqual([{ id: 'chat-other', user_id: 'other-user' }]);
    // Po sprawdzeniach (odmowa nie ma skutków), przed anonimizacją i deleteUser.
    expect(db.effects).toEqual([
      'gdpr_user_deletion_blockers', 'support_conversations.delete', 'anonymize_user_audit_logs', 'deleteUser',
    ]);
  });

  it('stops before anonymization and account deletion when the support chat cannot be deleted', async () => {
    dueRequest(); db.failSupportDelete();
    expect(await executeGdprRequest('due-request')).toEqual({ ok: false, error: 'support_conversations_delete_failed' });
    expect(db.rpc).not.toHaveBeenCalledWith('anonymize_user_audit_logs', expect.anything());
    expect(db.auth.admin.deleteUser).not.toHaveBeenCalled();
    expect(db.rows[0]).toMatchObject({ status: 'failed', failure_reason: 'support_conversations_delete_failed' });
  });

  it('keeps the support chat when a foreign key check refuses the deletion', async () => {
    dueRequest();
    db.support.push({ id: 'chat-own-1', user_id: input.userId });
    db.rpc.mockImplementation(async (fn: string) => ({
      data: fn === 'gdpr_user_deletion_blockers' ? ['public.some_table.user_id'] : null,
      error: null,
    }));
    expect((await executeGdprRequest('due-request')).ok).toBe(false);
    expect(db.support).toHaveLength(1);
  });

  it('records an uncertain failure without automatically repeating deletion', async () => {
    dueRequest(); db.auth.admin.deleteUser.mockResolvedValueOnce({ error: { message: 'response lost' } });
    expect(await executeGdprRequest('due-request')).toEqual({ ok: false, error: 'auth_delete_failed' });
    expect(db.rows[0].status).toBe('failed');
    expect((await executeGdprRequest('due-request')).ok).toBe(false);
    expect(db.auth.admin.deleteUser).toHaveBeenCalledOnce();
  });
});

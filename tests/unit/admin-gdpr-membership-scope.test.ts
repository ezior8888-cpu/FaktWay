import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  admin: vi.fn(),
  deleteUser: vi.fn(),
  audit: vi.fn(),
  revalidate: vi.fn(),
  rpc: vi.fn(),
  blockers: vi.fn<() => Promise<string[]>>(),
}));
vi.mock('@/lib/auth/admin-guard', () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: mocks.admin }));
vi.mock('@/lib/audit/log-system', () => ({ logAuditSystem: mocks.audit }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }));
// Ta sama blokada subskrypcji co w ścieżce samoobsługowej; jej zapytania
// testuje gdpr-subscription-blocker.test.ts.
vi.mock('@/lib/gdpr/deletion-blockers', async (orig) => ({
  ...(await orig<typeof import('@/lib/gdpr/deletion-blockers')>()),
  findOrganizationsBlockingDeletion: mocks.blockers,
}));

import { deleteUserGdprAction } from '@/app/admin/users/actions';

const USER = 'synthetic-target-user';
const OTHER_USER = 'synthetic-other-user';
const OPERATOR = 'synthetic-admin';
const activeOrg = 'synthetic-active-org';
const formerOrg = 'synthetic-former-org';
const memberOrg = 'synthetic-member-org';
const foreignOrg = 'synthetic-foreign-org';

interface Membership {
  user_id: string;
  organization_id: string;
  role: string;
  status: string;
  revoked_at: string | null;
}

interface Tenant {
  id: string;
  is_active: boolean;
  deleted_at: string | null;
  hard_delete_at: string | null;
}

interface SupportConversation {
  id: string;
  user_id: string | null;
}

type Table = 'memberships' | 'tenants' | 'support_conversations';
type Filters = Map<string, string | string[]>;
type QueryResult = { data: Membership[] | null; error: { message: string } | null; count?: number | null };

function fixtures(): Membership[] {
  return [
    { user_id: USER, organization_id: activeOrg, role: 'owner', status: 'active', revoked_at: null },
    // Migration 00038 revokes status without clearing the historical owner role.
    { user_id: USER, organization_id: formerOrg, role: 'owner', status: 'revoked', revoked_at: '2026-09-01T00:00:00Z' },
    { user_id: USER, organization_id: memberOrg, role: 'member', status: 'active', revoked_at: null },
    { user_id: OTHER_USER, organization_id: foreignOrg, role: 'owner', status: 'active', revoked_at: null },
  ];
}

/** Applies query filters to synthetic rows, so omitted scope filters change outcomes. */
function database(memberships: Membership[] = fixtures()) {
  const state = {
    memberships,
    tenants: [activeOrg, formerOrg, memberOrg, foreignOrg].map((id): Tenant => ({
      id, is_active: true, deleted_at: null, hard_delete_at: null,
    })),
    // Czat pomocy (00054): user_id ON DELETE SET NULL — deleteUser sam ich nie usunie.
    supportConversations: [
      { id: 'synthetic-chat-target', user_id: USER },
      { id: 'synthetic-chat-other', user_id: OTHER_USER },
    ] as SupportConversation[],
    writeAttempts: [] as Table[],
    readFailure: 'none' as 'none' | 'error' | 'missing',
    updateFailure: null as Table | null,
  };
  const matches = (row: object, filters: Filters) => [...filters].every(([column, value]) =>
    Array.isArray(value) ? value.includes(Reflect.get(row, column)) : Reflect.get(row, column) === value);

  const from = vi.fn((table: Table) => {
    const filters: Filters = new Map();
    let patch: Record<string, unknown> | null = null;
    let deleting = false;
    const execute = async (): Promise<QueryResult> => {
      if (deleting) {
        expect(table).toBe('support_conversations');
        state.writeAttempts.push(table);
        if (state.updateFailure === table) {
          return { data: null, error: { message: 'synthetic delete failure' }, count: null };
        }
        const before = state.supportConversations.length;
        state.supportConversations = state.supportConversations.filter((row) => !matches(row, filters));
        return { data: null, error: null, count: before - state.supportConversations.length };
      }
      if (patch === null) {
        expect(table).toBe('memberships');
        const selected = state.memberships.filter((row) => matches(row, filters));
        if (state.readFailure === 'error') {
          // Even partial data accompanying an error must never authorize writes.
          return { data: selected, error: { message: 'synthetic membership read failure' } };
        }
        return { data: state.readFailure === 'missing' ? null : selected, error: null };
      }

      state.writeAttempts.push(table);
      if (state.updateFailure === table) {
        return { data: null, error: { message: 'synthetic update failure' } };
      }
      const rows = table === 'memberships' ? state.memberships : state.tenants;
      for (const row of rows) {
        if (matches(row, filters)) Object.assign(row, patch);
      }
      return { data: null, error: null };
    };
    const then: Promise<QueryResult>['then'] = (onfulfilled, onrejected) =>
      execute().then(onfulfilled, onrejected);
    const query = {
      select: () => query,
      eq: (column: string, value: string) => { filters.set(column, value); return query; },
      in: (column: string, value: string[]) => { filters.set(column, value); return query; },
      update: (value: Record<string, unknown>) => { patch = value; return query; },
      delete: () => { deleting = true; return query; },
      then,
    };
    return query;
  });

  mocks.admin.mockReturnValue({ from, rpc: mocks.rpc, auth: { admin: { deleteUser: mocks.deleteUser } } });
  return state;
}

/** Kolejność wywołań między atrapami (vitest numeruje je globalnie). */
function callOrder(mock: { mock: { invocationCallOrder: number[] } }, index = 0): number {
  return mock.mock.invocationCallOrder.at(index) ?? Number.NaN;
}
function rpcOrder(fn: string): number {
  const index = mocks.rpc.mock.calls.findIndex(([name]) => name === fn);
  return index < 0 ? Number.NaN : callOrder(mocks.rpc, index);
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireAdmin.mockResolvedValue({ userId: OPERATOR, email: 'operator@example.test' });
  mocks.deleteUser.mockResolvedValue({ error: null });
  mocks.audit.mockResolvedValue(undefined);
  mocks.blockers.mockResolvedValue([]);
  // Kształty odpowiedzi jak w 00113 (lista „tabela.kolumna”) i 00052 ({updated_rows}).
  mocks.rpc.mockImplementation(async (fn: string) => ({
    data: fn === 'gdpr_user_deletion_blockers' ? [] : { updated_rows: 3 },
    error: null,
  }));
});

function expectNoSuccessEffects() {
  expect(mocks.audit).not.toHaveBeenCalled();
  expect(mocks.revalidate).not.toHaveBeenCalled();
}

describe('admin GDPR deletion membership scope', () => {
  // Przegląd prawny 15.10.2026: panel oznaczał firmy usuwanego właściciela
  // (`deleted_at`, `hard_delete_at` +30 dni, `is_active = false`) i obiecywał
  // „hard delete po 30 dniach”. Tych flag nie sprawdza logowanie, RLS ani
  // żaden job (`retention-delete` usuwa tylko faktury po 10 latach) — firma
  // działała dalej, a obietnica była pusta. Teraz panel, jak ścieżka
  // samoobsługowa (`executeGdprRequest`), usuwa konto i nie rusza firm.
  it('usuwa konto, nie rusza firm właściciela i mówi to wprost', async () => {
    const db = database();

    const result = await deleteUserGdprAction(USER, 'DELETE');

    expect(result).toMatchObject({ success: true });
    for (const tenant of db.tenants) {
      expect(tenant).toMatchObject({ is_active: true, deleted_at: null, hard_delete_at: null });
    }
    expect(db.writeAttempts).not.toContain('tenants');
    expect(db.memberships.filter((row) => row.user_id === USER).every((row) => row.status === 'revoked')).toBe(true);
    expect(db.memberships.find((row) => row.user_id === OTHER_USER)).toMatchObject({
      status: 'active', revoked_at: null,
    });
    expect(mocks.deleteUser).toHaveBeenCalledExactlyOnceWith(USER);
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'admin.user.deleted',
      entityId: USER,
      metadata: expect.objectContaining({ ownedOrgsLeftActive: 1 }),
    }));
    const message = 'message' in result ? String(result.message) : '';
    expect(message).toContain('działają dalej');
    expect(message).not.toMatch(/30 dni|hard delete|retencj/i);
  });

  it('can delete a former owner account without deactivating its former organization', async () => {
    const db = database(fixtures().filter((row) => row.organization_id === formerOrg));

    expect(await deleteUserGdprAction(USER, 'DELETE')).toMatchObject({ success: true });

    // Rozmowy z czatem pomocy usuwane tuż przed kontem (od 15.10.2026).
    expect(db.writeAttempts).toEqual(['memberships', 'support_conversations']);
    expect(db.tenants.every((row) => row.is_active && row.deleted_at === null)).toBe(true);
    expect(mocks.deleteUser).toHaveBeenCalledExactlyOnceWith(USER);
  });

  it('does not borrow another user active ownership when the target has no owner role', async () => {
    const db = database(fixtures().filter((row) => row.user_id === OTHER_USER || row.role === 'member'));

    expect(await deleteUserGdprAction(USER, 'DELETE')).toMatchObject({ success: true });

    expect(db.writeAttempts).toEqual(['memberships', 'support_conversations']);
    expect(db.tenants.every((row) => row.is_active)).toBe(true);
    expect(db.memberships.find((row) => row.user_id === OTHER_USER)?.status).toBe('active');
    expect(mocks.deleteUser).toHaveBeenCalledExactlyOnceWith(USER);
  });

  it.each(['error', 'missing'] as const)('stops before every write on a %s membership read', async (failure) => {
    const db = database();
    db.readFailure = failure;
    const before = structuredClone({ memberships: db.memberships, tenants: db.tenants });

    expect(await deleteUserGdprAction(USER, 'DELETE')).toMatchObject({ success: false });

    expect(db.writeAttempts).toEqual([]);
    expect(db.memberships).toEqual(before.memberships);
    expect(db.tenants).toEqual(before.tenants);
    expect(mocks.deleteUser).not.toHaveBeenCalled();
    expectNoSuccessEffects();
  });

  it('nie zapisuje do tenants — awaria zapisu firm nie może zatrzymać usunięcia konta', async () => {
    const db = database();
    db.updateFailure = 'tenants';

    expect(await deleteUserGdprAction(USER, 'DELETE')).toMatchObject({ success: true });

    expect(db.writeAttempts).toEqual(['memberships', 'support_conversations']);
    expect(mocks.deleteUser).toHaveBeenCalledExactlyOnceWith(USER);
    expect(db.tenants.every((row) => row.is_active && row.deleted_at === null)).toBe(true);
  });

  // Polityka prywatności: czat pomocy „do 24 miesięcy od ostatniej wiadomości”;
  // FK user_id ON DELETE SET NULL zostawiał rozmowy z treścią bez właściciela.
  it('deletes only the target user support chat, before the auth account', async () => {
    const db = database();
    mocks.deleteUser.mockImplementation(async () => {
      expect(db.supportConversations.map((row) => row.id)).toEqual(['synthetic-chat-other']);
      return { error: null };
    });

    expect(await deleteUserGdprAction(USER, 'DELETE')).toMatchObject({ success: true });

    expect(db.supportConversations).toEqual([{ id: 'synthetic-chat-other', user_id: OTHER_USER }]);
    expect(mocks.deleteUser).toHaveBeenCalledExactlyOnceWith(USER);
  });

  it('does not delete the auth account when the support chat cannot be deleted', async () => {
    const db = database();
    db.updateFailure = 'support_conversations';

    expect(await deleteUserGdprAction(USER, 'DELETE')).toMatchObject({ success: false });

    expect(db.writeAttempts).toEqual(['memberships', 'support_conversations']);
    expect(mocks.deleteUser).not.toHaveBeenCalled();
    expectNoSuccessEffects();
  });

  it('does not delete auth or claim success when membership revocation fails', async () => {
    const db = database();
    db.updateFailure = 'memberships';

    expect(await deleteUserGdprAction(USER, 'DELETE')).toMatchObject({ success: false });

    expect(db.writeAttempts).toEqual(['memberships']);
    expect(mocks.deleteUser).not.toHaveBeenCalled();
    expect(db.tenants.find((row) => row.id === activeOrg)?.is_active).toBe(true);
    expectNoSuccessEffects();
  });

  it('does not log a successful deletion when the auth service rejects it', async () => {
    database();
    mocks.deleteUser.mockResolvedValue({ error: { message: 'synthetic auth delete failure' } });

    expect(await deleteUserGdprAction(USER, 'DELETE')).toMatchObject({ success: false });

    expect(mocks.deleteUser).toHaveBeenCalledExactlyOnceWith(USER);
    expectNoSuccessEffects();
  });

  it('retains the confirmation and self-deletion guards before creating the admin client', async () => {
    expect(await deleteUserGdprAction(USER, 'delete')).toMatchObject({ success: false });
    expect(await deleteUserGdprAction(OPERATOR, 'DELETE')).toMatchObject({ success: false });

    expect(mocks.admin).not.toHaveBeenCalled();
    expect(mocks.deleteUser).not.toHaveBeenCalled();
    expectNoSuccessEffects();
  });

  it('awaits administrator authorization before allowing any privileged operation', async () => {
    mocks.requireAdmin.mockRejectedValue(new Error('synthetic unauthorized'));

    await expect(deleteUserGdprAction(USER, 'DELETE')).rejects.toThrow('synthetic unauthorized');

    expect(mocks.admin).not.toHaveBeenCalled();
    expect(mocks.deleteUser).not.toHaveBeenCalled();
    expectNoSuccessEffects();
  });
});

/**
 * Ścieżka admina ma robić to samo co samoobsługowa (`executeGdprRequest`,
 * lib/gdpr/deletion.ts): sprawdzenia bez skutków PRZED pierwszym zapisem,
 * anonimizacja dziennika (polityka: „po usunięciu Konta wpisy są
 * anonimizowane”) tuż przed deleteUser. Do 15.10.2026 nie robiła żadnej z
 * tych trzech rzeczy (CYB-F03-05: „nie zamyka przeglądu GDPR”).
 */
describe('admin GDPR deletion — te same zabezpieczenia co ścieżka samoobsługowa', () => {
  function expectUntouched(db: ReturnType<typeof database>) {
    expect(db.writeAttempts).toEqual([]);
    expect(db.tenants.every((row) => row.is_active && row.deleted_at === null)).toBe(true);
    expect(db.memberships.every((row) => row.revoked_at === null || row.organization_id === formerOrg)).toBe(true);
    expect(mocks.rpc).not.toHaveBeenCalledWith('anonymize_user_audit_logs', expect.anything());
    expect(mocks.deleteUser).not.toHaveBeenCalled();
    expectNoSuccessEffects();
  }

  it('odmawia przed pierwszym zapisem, gdy subskrypcja pobierałaby opłaty bez nikogo, kto ją anuluje', async () => {
    const db = database();
    mocks.blockers.mockResolvedValue(['Firma Testowa Sp. z o.o.']);

    const result = await deleteUserGdprAction(USER, 'DELETE');

    expect(result).toMatchObject({ success: false });
    expect(!result.success && result.error).toContain('Firma Testowa Sp. z o.o.');
    // Wyjście dla operatora: komunikat mówi, co zrobić.
    expect(!result.success && result.error).toContain('subskrypcj');
    expect(mocks.blockers).toHaveBeenCalledWith(expect.objectContaining({ from: expect.any(Function) }), USER);
    expectUntouched(db);
  });

  it('odmawia przed pierwszym zapisem, gdy nie da się sprawdzić subskrypcji', async () => {
    const db = database();
    mocks.blockers.mockRejectedValue(new Error('gdpr_blocker_lookup_failed'));

    expect(await deleteUserGdprAction(USER, 'DELETE')).toMatchObject({ success: false });

    expectUntouched(db);
  });

  // AUD-41: klucz obcy bez ON DELETE wywraca deleteUser PO odwołaniu członkostw,
  // wyłączeniu firm i anonimizacji.
  it('odmawia przed pierwszym zapisem, gdy klucz obcy zatrzymałby usunięcie konta', async () => {
    const db = database();
    mocks.rpc.mockImplementation(async (fn: string) => ({
      data: fn === 'gdpr_user_deletion_blockers' ? ['public.stripe_financial_case_reviews.reviewer_user_id'] : null,
      error: null,
    }));

    const result = await deleteUserGdprAction(USER, 'DELETE');

    expect(result).toMatchObject({ success: false });
    expect(!result.success && result.error).toContain('public.stripe_financial_case_reviews.reviewer_user_id');
    expect(mocks.rpc).toHaveBeenCalledWith('gdpr_user_deletion_blockers', { p_user_id: USER });
    expectUntouched(db);
  });

  it.each([
    ['błąd odczytu', { data: null, error: { message: 'synthetic rpc failure' } }],
    ['odpowiedź nie jest listą', { data: null, error: null }],
  ])('odmawia przed pierwszym zapisem, gdy sprawdzenie kluczy obcych zawiedzie (%s)', async (_label, response) => {
    const db = database();
    mocks.rpc.mockImplementation(async (fn: string) => (
      fn === 'gdpr_user_deletion_blockers' ? response : { data: null, error: null }
    ));

    expect(await deleteUserGdprAction(USER, 'DELETE')).toMatchObject({ success: false });

    expectUntouched(db);
  });

  it('anonimizuje dziennik po krokach odwracalnych, a przed usunięciem konta', async () => {
    database();

    expect(await deleteUserGdprAction(USER, 'DELETE')).toMatchObject({ success: true });

    expect(mocks.rpc).toHaveBeenCalledWith('anonymize_user_audit_logs', { p_user_id: USER });
    // `from` atrapy: pierwsze wywołanie = odczyt członkostw, ostatnie = ich odwołanie.
    const from = (mocks.admin.mock.results[0]!.value as { from: Parameters<typeof callOrder>[0] }).from;
    const firstWrite = callOrder(from);
    const lastWrite = callOrder(from, -1);
    // Sprawdzenia przed pierwszym odczytem/zapisem członkostw…
    expect(callOrder(mocks.blockers)).toBeLessThan(firstWrite);
    expect(rpcOrder('gdpr_user_deletion_blockers')).toBeLessThan(firstWrite);
    // …anonimizacja po odwołaniu członkostw, przed deleteUser.
    expect(rpcOrder('anonymize_user_audit_logs')).toBeGreaterThan(lastWrite);
    expect(rpcOrder('anonymize_user_audit_logs')).toBeLessThan(callOrder(mocks.deleteUser));
    expect(mocks.deleteUser).toHaveBeenCalledExactlyOnceWith(USER);
  });

  it('nie usuwa konta ani nie zgłasza sukcesu, gdy anonimizacja dziennika zawiedzie', async () => {
    database();
    mocks.rpc.mockImplementation(async (fn: string) => ({
      data: fn === 'gdpr_user_deletion_blockers' ? [] : null,
      error: fn === 'anonymize_user_audit_logs' ? { message: 'synthetic anonymize failure' } : null,
    }));

    expect(await deleteUserGdprAction(USER, 'DELETE')).toMatchObject({ success: false });

    expect(mocks.deleteUser).not.toHaveBeenCalled();
    expectNoSuccessEffects();
  });
});

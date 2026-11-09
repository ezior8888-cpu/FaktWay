import { createHash } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Krok 7.1, część 1: klucze API w Ustawieniach.
 *
 * Akcje tworzenia i odwołania klucza: właściciel albo administrator, utworzenie
 * z kodem 2FA (jak link dla księgowej), pełny klucz tylko w odpowiedzi akcji,
 * w bazie skrót i prefiks. Zapis klientem z sesji (RLS); audyt pisze wyzwalacz
 * w bazie (00181), co sprawdza `tests/rls-api-klucze.test.ts`.
 */

const mocks = vi.hoisted(() => ({
  requireOrgRole: vi.fn(),
  stepUp: vi.fn(),
  flag: vi.fn(),
  revalidate: vi.fn(),
  calls: [] as Array<{ op: string; args: unknown[] }>,
  results: {
    count: { count: 0, error: null } as { count: number | null; error: { message: string } | null },
    insert: { data: { id: 'abcdabcd-0000-4000-8000-000000000001' }, error: null } as {
      data: { id: string } | null; error: { message: string; code?: string } | null;
    },
    update: { data: [{ id: 'abcdabcd-0000-4000-8000-000000000001' }], error: null } as {
      data: { id: string }[] | null; error: { message: string } | null;
    },
  },
}));

class FakeActionAuthError extends Error {}

vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }));
vi.mock('@/lib/supabase/auth-context', () => ({
  requireOrgRole: mocks.requireOrgRole,
  ActionAuthError: FakeActionAuthError,
}));
vi.mock('@/lib/auth/access-grant-mfa', () => ({ requireCodeForAccessGrant: mocks.stepUp }));
vi.mock('@/lib/feature-flags/global-flags', () => ({
  getGlobalFlag: mocks.flag,
  getGlobalFlagForExecution: mocks.flag,
}));

/** Klient z sesji: zapisuje każde wywołanie i zwraca ustawione wyniki. */
function sessionClient() {
  return {
    from(table: string) {
      mocks.calls.push({ op: 'from', args: [table] });
      let kind: 'count' | 'insert' | 'update' = 'count';
      const builder: Record<string, unknown> = {};
      const chain = (op: string) => (...args: unknown[]) => {
        mocks.calls.push({ op, args });
        if (op === 'insert') kind = 'insert';
        if (op === 'update') kind = 'update';
        return builder;
      };
      for (const op of ['select', 'insert', 'update', 'eq', 'is', 'single', 'maybeSingle', 'order', 'limit']) {
        builder[op] = chain(op);
      }
      builder.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve(mocks.results[kind]).then(resolve, reject);
      return builder;
    },
    rpc: vi.fn(() => { throw new Error('akcje kluczy nie wołają RPC'); }),
  };
}

const TENANT = 'aaaaaaaa-0000-4000-8000-000000000001';
const USER = 'cccccccc-0000-4000-8000-000000000003';

function asRole(role: 'owner' | 'admin' | 'member' | 'accountant') {
  mocks.requireOrgRole.mockImplementation(async (roles: string | string[]) => {
    const allowed = Array.isArray(roles) ? roles : [roles];
    if (!allowed.includes(role)) throw new FakeActionAuthError('Niewystarczające uprawnienia');
    return { supabase: sessionClient(), tenantId: TENANT, user: { id: USER }, role };
  });
}

const { createApiKeyAction, revokeApiKeyAction } = await import('@/components/settings/api-keys-actions');
const { settingsTabsForRole } = await import('@/components/settings/finora/settings-tabs');

const ops = (op: string) => mocks.calls.filter((c) => c.op === op);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.calls.length = 0;
  mocks.results.count = { count: 0, error: null };
  mocks.results.insert = { data: { id: 'abcdabcd-0000-4000-8000-000000000001' }, error: null };
  mocks.results.update = { data: [{ id: 'abcdabcd-0000-4000-8000-000000000001' }], error: null };
  mocks.flag.mockResolvedValue(true);
  mocks.stepUp.mockResolvedValue(null);
  asRole('owner');
});

describe('utworzenie klucza API', () => {
  it.each(['owner', 'admin'] as const)('%s: klucz pokazany raz, w bazie tylko skrót i prefiks', async (role) => {
    asRole(role);
    const result = await createApiKeyAction({ name: '  Program magazynowy  ', scopes: ['expenses:read', 'invoices:read'] });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.key).toMatch(/^fwk_[A-Za-z0-9_-]{43}$/);
    expect(result.prefix).toBe(result.key.slice(0, 12));
    expect(mocks.requireOrgRole).toHaveBeenCalledWith(['owner', 'admin']);
    expect(mocks.stepUp).toHaveBeenCalledWith(expect.anything(), USER, 'Utworzenie klucza API');

    const [insert] = ops('insert');
    expect(insert?.args[0]).toEqual({
      tenant_id: TENANT,
      name: 'Program magazynowy',
      key_prefix: result.key.slice(0, 12),
      key_hash: createHash('sha256').update(result.key).digest('hex'),
      scopes: ['invoices:read', 'expenses:read'],
    });
    // Pełny klucz nie trafia do bazy w żadnym polu.
    expect(JSON.stringify(mocks.calls)).not.toContain(result.key);
    expect(mocks.revalidate).toHaveBeenCalledWith('/settings/api');
  });

  it('każdy klucz jest inny', async () => {
    const first = await createApiKeyAction({ name: 'A', scopes: ['invoices:read'] });
    const second = await createApiKeyAction({ name: 'B', scopes: ['invoices:read'] });
    expect(first.success && second.success).toBe(true);
    if (first.success && second.success) expect(first.key).not.toBe(second.key);
  });

  it.each(['member', 'accountant'] as const)('%s: odmowa bez zapisu', async (role) => {
    asRole(role);
    const result = await createApiKeyAction({ name: 'Program', scopes: ['invoices:read'] });
    expect(result).toEqual({ success: false, error: 'Niewystarczające uprawnienia' });
    expect(ops('insert')).toEqual([]);
  });

  it('sesja po biometrii na koncie z 2FA: przejście na ekran kodu, bez zapisu', async () => {
    mocks.stepUp.mockResolvedValue({ success: false, mfaStepUp: true, error: 'Utworzenie klucza API wymaga potwierdzenia kodem z aplikacji.' });
    const result = await createApiKeyAction({ name: 'Program', scopes: ['invoices:read'] });
    expect(result).toEqual({ success: false, mfaStepUp: true, error: 'Utworzenie klucza API wymaga potwierdzenia kodem z aplikacji.' });
    expect(ops('insert')).toEqual([]);
  });

  it('API nieudostępnione: odmowa bez zapisu', async () => {
    mocks.flag.mockResolvedValue(false);
    const result = await createApiKeyAction({ name: 'Program', scopes: ['invoices:read'] });
    expect(result.success).toBe(false);
    expect(mocks.flag).toHaveBeenCalledWith('publicApiEnabled');
    expect(ops('insert')).toEqual([]);
  });

  it.each([
    ['pusta nazwa', { name: '   ', scopes: ['invoices:read'] }],
    ['za długa nazwa', { name: 'x'.repeat(81), scopes: ['invoices:read'] }],
    ['bez zakresu', { name: 'Program', scopes: [] }],
    ['nieznany zakres', { name: 'Program', scopes: ['invoices:write'] }],
  ])('%s: odmowa bez zapisu', async (_name, input) => {
    const result = await createApiKeyAction(input as { name: string; scopes: string[] });
    expect(result.success).toBe(false);
    expect(ops('insert')).toEqual([]);
  });

  it('najwyżej 10 aktywnych kluczy na firmę', async () => {
    mocks.results.count = { count: 10, error: null };
    const result = await createApiKeyAction({ name: 'Program', scopes: ['invoices:read'] });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('10');
    expect(ops('insert')).toEqual([]);
    expect(ops('is')).toContainEqual({ op: 'is', args: ['revoked_at', null] });
  });

  it('błąd bazy: ogólny komunikat bez treści błędu', async () => {
    mocks.results.insert = { data: null, error: { message: 'private-db-error: api_keys_key_hash_key' } };
    const result = await createApiKeyAction({ name: 'Program', scopes: ['invoices:read'] });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).not.toContain('private-db-error');
  });
});

describe('odwołanie klucza API', () => {
  const KEY_ID = 'abcdabcd-0000-4000-8000-000000000001';

  it.each(['owner', 'admin'] as const)('%s: odwołuje aktywny klucz swojej firmy', async (role) => {
    asRole(role);
    expect(await revokeApiKeyAction(KEY_ID)).toEqual({ success: true });
    const [update] = ops('update');
    expect(Object.keys(update?.args[0] as object)).toEqual(['revoked_at']);
    expect(ops('eq')).toEqual(expect.arrayContaining([
      { op: 'eq', args: ['id', KEY_ID] },
      { op: 'eq', args: ['tenant_id', TENANT] },
    ]));
    expect(ops('is')).toContainEqual({ op: 'is', args: ['revoked_at', null] });
    expect(mocks.revalidate).toHaveBeenCalledWith('/settings/api');
  });

  it('nie wymaga kodu 2FA: odwołanie tylko zabiera dostęp', async () => {
    await revokeApiKeyAction(KEY_ID);
    expect(mocks.stepUp).not.toHaveBeenCalled();
  });

  it.each(['member', 'accountant'] as const)('%s: odmowa bez zapisu', async (role) => {
    asRole(role);
    const result = await revokeApiKeyAction(KEY_ID);
    expect(result.success).toBe(false);
    expect(ops('update')).toEqual([]);
  });

  it('klucz innej firmy, już odwołany albo nieistniejący: odmowa', async () => {
    mocks.results.update = { data: [], error: null };
    const result = await revokeApiKeyAction(KEY_ID);
    expect(result.success).toBe(false);
  });

  it('zły identyfikator: odmowa bez zapisu', async () => {
    const result = await revokeApiKeyAction('nie-uuid');
    expect(result.success).toBe(false);
    expect(ops('update')).toEqual([]);
  });

  it('błąd bazy: ogólny komunikat bez treści błędu', async () => {
    mocks.results.update = { data: null, error: { message: 'private-db-error' } };
    const result = await revokeApiKeyAction(KEY_ID);
    expect(JSON.stringify(result)).not.toContain('private-db-error');
  });
});

describe('zakładka „API” w Ustawieniach', () => {
  it.each(['owner', 'admin'] as const)('%s widzi ją po „Abonament”, gdy API jest udostępnione', (role) => {
    const tabs = settingsTabsForRole(role, { publicApi: true });
    const at = tabs.findIndex((t) => t.href === '/settings/billing');
    expect(tabs[at + 1]).toEqual({ href: '/settings/api', label: 'API' });
  });

  it.each(['member', 'accountant'] as const)('%s jej nie widzi', (role) => {
    expect(settingsTabsForRole(role, { publicApi: true }).map((t) => t.href)).not.toContain('/settings/api');
  });

  it('przed udostępnieniem nikt jej nie widzi, reszta zakładek bez zmian', () => {
    expect(settingsTabsForRole('owner', { publicApi: false })).toEqual(settingsTabsForRole('owner'));
    expect(settingsTabsForRole('owner').map((t) => t.href)).not.toContain('/settings/api');
  });
});

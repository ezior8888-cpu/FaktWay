import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Krok 7.1, część 3: webhooki w Ustawieniach → API.
 *
 * Dodanie: właściciel albo administrator, kod 2FA (jak klucz API), adres
 * sprawdzony przed zapisem (https, port 443, nazwa domeny, DNS bez adresów
 * prywatnych), najwyżej 5 webhooków. Sekret podpisu wraca tylko w odpowiedzi
 * akcji; do bazy trafia szyfrogram (AES-256-GCM, klucz spoza bazy).
 * Usunięcie i ponowne włączenie: właściciel albo administrator, bez kodu.
 * Zapis klientem z sesji (RLS z 00187, audyt wyzwalaczem: `tests/rls-webhooki.test.ts`).
 */

const m = vi.hoisted(() => ({
  requireOrgRole: vi.fn(),
  stepUp: vi.fn(),
  flag: vi.fn(),
  revalidate: vi.fn(),
  resolve: vi.fn(),
  calls: [] as Array<{ op: string; args: unknown[] }>,
  results: {
    count: { count: 0, error: null } as { count: number | null; error: { message: string } | null },
    insert: { data: { id: 'x' }, error: null } as { data: { id: string } | null; error: { message: string; code?: string } | null },
    update: { data: [{ id: 'x' }], error: null } as { data: { id: string }[] | null; error: { message: string } | null },
    delete: { data: [{ id: 'x' }], error: null } as { data: { id: string }[] | null; error: { message: string } | null },
  },
}));

class FakeActionAuthError extends Error {}

vi.mock('next/cache', () => ({ revalidatePath: m.revalidate }));
vi.mock('@/lib/supabase/auth-context', () => ({ requireOrgRole: m.requireOrgRole, ActionAuthError: FakeActionAuthError }));
vi.mock('@/lib/auth/access-grant-mfa', () => ({ requireCodeForAccessGrant: m.stepUp }));
vi.mock('@/lib/feature-flags/global-flags', () => ({ getGlobalFlag: m.flag, getGlobalFlagForExecution: m.flag }));
vi.mock('@/lib/webhooks/network', () => ({ resolveHost: m.resolve, httpsTransport: vi.fn() }));

function sessionClient() {
  return {
    from(table: string) {
      m.calls.push({ op: 'from', args: [table] });
      let kind: 'count' | 'insert' | 'update' | 'delete' = 'count';
      const builder: Record<string, unknown> = {};
      const chain = (op: string) => (...args: unknown[]) => {
        m.calls.push({ op, args });
        if (op === 'insert' || op === 'update' || op === 'delete') kind = op;
        return builder;
      };
      for (const op of ['select', 'insert', 'update', 'delete', 'eq', 'is', 'not', 'single', 'maybeSingle', 'limit']) builder[op] = chain(op);
      builder.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve(m.results[kind]).then(resolve, reject);
      return builder;
    },
    rpc: vi.fn(() => { throw new Error('akcje webhooków nie wołają RPC'); }),
  };
}

const TENANT = 'aaaaaaaa-0000-4000-8000-000000000001';
const USER = 'cccccccc-0000-4000-8000-000000000003';
const HOOK = 'bbbbbbbb-0000-4000-8000-000000000002';

function asRole(role: 'owner' | 'admin' | 'member' | 'accountant') {
  m.requireOrgRole.mockImplementation(async (roles: string | string[]) => {
    const allowed = Array.isArray(roles) ? roles : [roles];
    if (!allowed.includes(role)) throw new FakeActionAuthError('Niewystarczające uprawnienia');
    return { supabase: sessionClient(), tenantId: TENANT, user: { id: USER }, role };
  });
}

const { createWebhookAction, deleteWebhookAction, enableWebhookAction } = await import('@/components/settings/webhooks-actions');
const { decryptWebhookSecret } = await import('@/lib/webhooks/secret-box');

const ops = (op: string) => m.calls.filter((c) => c.op === op);
const VALID = { url: 'https://hooks.example.com/faktway', events: ['payment.recorded', 'invoice.ksef_accepted'] };

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv('WEBHOOK_SECRETS_ENCRYPTION_KEY', 'k'.repeat(44));
  m.calls.length = 0;
  m.results.count = { count: 0, error: null };
  m.results.insert = { data: { id: 'x' }, error: null };
  m.results.update = { data: [{ id: HOOK }], error: null };
  m.results.delete = { data: [{ id: HOOK }], error: null };
  m.flag.mockResolvedValue(true);
  m.stepUp.mockResolvedValue(null);
  m.resolve.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  asRole('owner');
});

describe('dodanie webhooka', () => {
  it.each(['owner', 'admin'] as const)('%s: sekret pokazany raz, w bazie tylko szyfrogram', async (role) => {
    asRole(role);
    const result = await createWebhookAction({ ...VALID, url: ' https://Hooks.Example.com/faktway ' });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.signingSecret).toMatch(/^fwws_[A-Za-z0-9_-]{43}$/);
    expect(result.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(m.requireOrgRole).toHaveBeenCalledWith(['owner', 'admin']);
    expect(m.stepUp).toHaveBeenCalledWith(expect.anything(), USER, 'Dodanie webhooka');
    expect(m.resolve).toHaveBeenCalledWith('hooks.example.com');

    const [insert] = ops('insert');
    const row = insert?.args[0] as Record<string, string | string[]>;
    expect(row).toEqual({
      id: result.id,
      tenant_id: TENANT,
      url: 'https://hooks.example.com/faktway',
      events: ['invoice.ksef_accepted', 'payment.recorded'],
      secret_ciphertext: expect.stringMatching(/^[A-Za-z0-9+/]+={0,2}$/),
    });
    expect(decryptWebhookSecret(String(row.secret_ciphertext), { tenantId: TENANT, webhookId: result.id })).toBe(result.signingSecret);
    // Jawny sekret nie trafia do bazy w żadnym polu.
    expect(JSON.stringify(m.calls)).not.toContain(result.signingSecret);
    expect(m.revalidate).toHaveBeenCalledWith('/settings/api');
  });

  it('każdy webhook ma inny sekret', async () => {
    const first = await createWebhookAction(VALID);
    const second = await createWebhookAction(VALID);
    expect(first.success && second.success).toBe(true);
    if (first.success && second.success) expect(first.signingSecret).not.toBe(second.signingSecret);
  });

  it.each(['member', 'accountant'] as const)('%s: odmowa bez zapisu', async (role) => {
    asRole(role);
    expect(await createWebhookAction(VALID)).toEqual({ success: false, error: 'Niewystarczające uprawnienia' });
    expect(ops('insert')).toEqual([]);
  });

  it('flaga publicApiEnabled wyłączona: odmowa przed sprawdzeniem roli i bez zapisu', async () => {
    m.flag.mockResolvedValue(false);
    expect(await createWebhookAction(VALID)).toEqual({ success: false, error: 'Webhooki nie są jeszcze dostępne.' });
    expect(m.requireOrgRole).not.toHaveBeenCalled();
    expect(ops('insert')).toEqual([]);
  });

  it('sesja po biometrii przy koncie z 2FA: przejście do kodu, bez zapisu', async () => {
    m.stepUp.mockResolvedValue({ success: false, error: 'Dodanie webhooka wymaga kodu.', mfaStepUp: true });
    expect(await createWebhookAction(VALID)).toEqual({ success: false, error: 'Dodanie webhooka wymaga kodu.', mfaStepUp: true });
    expect(ops('insert')).toEqual([]);
  });

  it.each([
    ['http://hooks.example.com/x', /https/],
    ['https://localhost/x', /lokaln|domen/],
    ['https://10.0.0.1/x', /IP/],
    ['https://hooks.example.com:8443/x', /443/],
  ])('adres %s: odmowa z opisem, bez DNS i bez zapisu', async (url, message) => {
    const result = await createWebhookAction({ ...VALID, url });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(message);
    expect(m.resolve).not.toHaveBeenCalled();
    expect(ops('insert')).toEqual([]);
  });

  it('DNS wskazuje adres prywatny: odmowa bez zapisu', async () => {
    m.resolve.mockResolvedValue([{ address: '192.168.0.10', family: 4 }]);
    const result = await createWebhookAction(VALID);
    expect(result).toEqual({ success: false, error: expect.stringMatching(/prywatn/) });
    expect(ops('insert')).toEqual([]);
  });

  it('DNS bez odpowiedzi: odmowa bez zapisu', async () => {
    m.resolve.mockRejectedValue(new Error('ENOTFOUND'));
    const result = await createWebhookAction(VALID);
    expect(result).toEqual({ success: false, error: expect.stringMatching(/Nie znaleźliśmy/) });
    expect(ops('insert')).toEqual([]);
  });

  it('bez zdarzeń: odmowa', async () => {
    const result = await createWebhookAction({ ...VALID, events: [] });
    expect(result.success).toBe(false);
    expect(ops('insert')).toEqual([]);
  });

  it('nieznane zdarzenie: odmowa', async () => {
    const result = await createWebhookAction({ ...VALID, events: ['invoice.deleted'] });
    expect(result.success).toBe(false);
    expect(ops('insert')).toEqual([]);
  });

  it('limit 5 webhooków na firmę', async () => {
    m.results.count = { count: 5, error: null };
    const result = await createWebhookAction(VALID);
    expect(result).toEqual({ success: false, error: expect.stringMatching(/najwyżej 5/) });
    expect(ops('insert')).toEqual([]);
  });

  it('brak klucza szyfrowania na serwerze: odmowa bez zapisu (sekretu nie zapiszemy jawnie)', async () => {
    vi.stubEnv('WEBHOOK_SECRETS_ENCRYPTION_KEY', '');
    expect(await createWebhookAction(VALID)).toEqual({ success: false, error: 'Webhooki nie są jeszcze dostępne.' });
    expect(ops('insert')).toEqual([]);
  });

  it('błąd zapisu: ogólny komunikat bez treści błędu bazy', async () => {
    m.results.insert = { data: null, error: { message: 'new row violates row-level security policy', code: '42501' } };
    const result = await createWebhookAction(VALID);
    expect(result).toEqual({ success: false, error: 'Nie udało się dodać webhooka. Spróbuj ponownie za chwilę.' });
  });
});

describe('usunięcie i ponowne włączenie', () => {
  it.each(['owner', 'admin'] as const)('%s usuwa webhook swojej firmy', async (role) => {
    asRole(role);
    expect(await deleteWebhookAction(HOOK)).toEqual({ success: true });
    expect(ops('delete')).toHaveLength(1);
    expect(ops('eq').map((c) => c.args)).toEqual(expect.arrayContaining([['id', HOOK], ['tenant_id', TENANT]]));
    expect(m.revalidate).toHaveBeenCalledWith('/settings/api');
  });

  it.each(['member', 'accountant'] as const)('%s: usunięcie i włączenie odmówione', async (role) => {
    asRole(role);
    expect(await deleteWebhookAction(HOOK)).toEqual({ success: false, error: 'Niewystarczające uprawnienia' });
    expect(await enableWebhookAction(HOOK)).toEqual({ success: false, error: 'Niewystarczające uprawnienia' });
    expect(ops('delete')).toEqual([]);
    expect(ops('update')).toEqual([]);
  });

  it('usunięcie nieistniejącego: komunikat', async () => {
    m.results.delete = { data: [], error: null };
    expect(await deleteWebhookAction(HOOK)).toEqual({ success: false, error: 'Nie znaleziono webhooka w tej firmie.' });
    expect(await deleteWebhookAction('nie-uuid')).toEqual({ success: false, error: 'Nie znaleziono webhooka w tej firmie.' });
  });

  it('włączenie wyłączonego: tylko disabled_at = null, licznik porażek zeruje baza', async () => {
    expect(await enableWebhookAction(HOOK)).toEqual({ success: true });
    const [update] = ops('update');
    expect(update?.args[0]).toEqual({ disabled_at: null });
    expect(ops('not').map((c) => c.args)).toEqual([['disabled_at', 'is', null]]);
  });

  it('włączenie przy wyłączonej fladze: odmowa', async () => {
    m.flag.mockResolvedValue(false);
    expect(await enableWebhookAction(HOOK)).toEqual({ success: false, error: 'Webhooki nie są jeszcze dostępne.' });
    expect(ops('update')).toEqual([]);
  });

  it('włączenie webhooka, który nie jest wyłączony: komunikat', async () => {
    m.results.update = { data: [], error: null };
    expect(await enableWebhookAction(HOOK)).toEqual({ success: false, error: 'Nie znaleziono wyłączonego webhooka w tej firmie.' });
  });
});

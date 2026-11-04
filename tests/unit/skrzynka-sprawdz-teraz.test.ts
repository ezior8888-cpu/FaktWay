import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Odświeżenie przez aktywność (FaktWay 1.0, decyzja 4): wejście do Skrzynki albo
 * przycisk „Sprawdź teraz” przyspiesza `next_poll_at`, najwyżej raz na 5 min na
 * firmę, przez `lib/rate-limit`. Aktywność kogokolwiek z firmy (layout panelu)
 * zapisujemy najwyżej raz na godzinę na firmę i proces.
 */

const m = vi.hoisted(() => ({
  rpc: vi.fn(),
  checkRateLimit: vi.fn(),
  requireUser: vi.fn(),
}));

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ rpc: m.rpc }) }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: m.checkRateLimit }));
vi.mock('@/lib/supabase/auth-context', () => ({
  requireUserAndActiveOrg: m.requireUser,
  ActionAuthError: class ActionAuthError extends Error {},
}));

import { requestInboxCheckAction } from '@/app/actions/ksef-inbox';
import { noteTenantActivityThrottled, requestInboxPollOnVisit } from '@/lib/ksef/inbox-activity';
import { INBOX_ACTIVITY_NOTE_SECONDS, INBOX_ACTIVITY_PULL_SECONDS, INBOX_NUDGE_MIN_SECONDS } from '@/lib/ksef/inbox-schedule';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function rpcReturns(status: string, retryAfter = 0) {
  m.rpc.mockResolvedValue({
    data: [{ status, retry_after_seconds: retryAfter, next_poll_at: '2026-11-02T11:00:00Z' }],
    error: null,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  m.requireUser.mockResolvedValue({ tenantId: TENANT, user: { id: 'u-1' } });
  m.checkRateLimit.mockResolvedValue({ allowed: true, remaining: 0, retryAfter: 0 });
  rpcReturns('accepted');
});

describe('przycisk „Sprawdź teraz”', () => {
  it('przyjęte: termin przyspieszony, limit na firmę przez lib/rate-limit', async () => {
    await expect(requestInboxCheckAction()).resolves.toMatchObject({ status: 'accepted' });
    expect(m.checkRateLimit).toHaveBeenCalledWith({
      bucket: 'ksef_inbox_check',
      identifier: TENANT,
      limit: 1,
      windowSeconds: INBOX_NUDGE_MIN_SECONDS,
    });
    expect(m.rpc).toHaveBeenCalledWith('note_ksef_inbox_activity', {
      p_tenant_id: TENANT,
      p_request_poll: true,
      p_min_gap_seconds: INBOX_NUDGE_MIN_SECONDS,
      p_pull_seconds: INBOX_ACTIVITY_PULL_SECONDS,
    });
  });

  it('za szybko: bez wywołania bazy, klient wie, ile czekać', async () => {
    m.checkRateLimit.mockResolvedValue({ allowed: false, remaining: 0, retryAfter: 240 });
    const result = await requestInboxCheckAction();
    expect(result).toMatchObject({ status: 'too_soon', retryAfterSeconds: 240 });
    expect(result.message).toContain('4 min');
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it('warunek w bazie też mówi „za szybko” (po restarcie procesu limit w pamięci jest pusty)', async () => {
    rpcReturns('too_soon', 90);
    const result = await requestInboxCheckAction();
    expect(result).toMatchObject({ status: 'too_soon', retryAfterSeconds: 90 });
    expect(result.message).toContain('2 min');
  });

  it('zadanie już czeka: mówimy, że sprawdzamy', async () => {
    rpcReturns('in_flight');
    await expect(requestInboxCheckAction()).resolves.toMatchObject({ status: 'in_flight' });
  });

  it('firma bez KSeF: brak wiersza harmonogramu, prosimy o podłączenie', async () => {
    m.rpc.mockResolvedValue({ data: [], error: null });
    const result = await requestInboxCheckAction();
    expect(result).toMatchObject({ status: 'no_ksef' });
  });

  it('błąd bazy: komunikat po polsku, bez treści wyjątku', async () => {
    m.rpc.mockResolvedValue({ data: null, error: { message: 'relation does not exist' } });
    const result = await requestInboxCheckAction();
    expect(result.status).toBe('error');
    expect(result.message).not.toContain('relation');
  });

  it('brak sesji: bez limitu i bez bazy', async () => {
    const { ActionAuthError } = await import('@/lib/supabase/auth-context');
    m.requireUser.mockRejectedValue(new ActionAuthError('Niezalogowany'));
    const result = await requestInboxCheckAction();
    expect(result).toMatchObject({ status: 'error', message: 'Niezalogowany' });
    expect(m.checkRateLimit).not.toHaveBeenCalled();
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it('żaden komunikat nie ma długiego myślnika', async () => {
    const results = [];
    for (const status of ['accepted', 'in_flight', 'too_soon']) {
      rpcReturns(status, 60);
      results.push(await requestInboxCheckAction());
    }
    m.rpc.mockResolvedValue({ data: [], error: null });
    results.push(await requestInboxCheckAction());
    for (const result of results) expect(result.message).not.toMatch(/[—–]/);
  });
});

describe('wejście do Skrzynki', () => {
  it('przyspiesza termin z tym samym limitem co przycisk', async () => {
    await requestInboxPollOnVisit(TENANT);
    expect(m.checkRateLimit).toHaveBeenCalledWith(expect.objectContaining({ bucket: 'ksef_inbox_check', identifier: TENANT }));
    expect(m.rpc).toHaveBeenCalledWith('note_ksef_inbox_activity', expect.objectContaining({ p_request_poll: true }));
  });

  it('limit wyczerpany: nic nie robi', async () => {
    m.checkRateLimit.mockResolvedValue({ allowed: false, remaining: 0, retryAfter: 100 });
    await requestInboxPollOnVisit(TENANT);
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it('błąd nie psuje strony', async () => {
    m.rpc.mockRejectedValue(new Error('baza padła'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(requestInboxPollOnVisit(TENANT)).resolves.toBeUndefined();
    spy.mockRestore();
  });
});

describe('znacznik aktywności z layoutu panelu', () => {
  it('najwyżej raz na godzinę na firmę i proces', async () => {
    const tenant = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const t0 = 1_800_000_000_000;
    await noteTenantActivityThrottled(tenant, t0);
    await noteTenantActivityThrottled(tenant, t0 + 60_000);
    await noteTenantActivityThrottled(tenant, t0 + (INBOX_ACTIVITY_NOTE_SECONDS - 1) * 1000);
    expect(m.rpc).toHaveBeenCalledTimes(1);
    expect(m.rpc).toHaveBeenCalledWith('note_ksef_inbox_activity', expect.objectContaining({
      p_tenant_id: tenant,
      p_request_poll: false,
    }));
    await noteTenantActivityThrottled(tenant, t0 + (INBOX_ACTIVITY_NOTE_SECONDS + 1) * 1000);
    expect(m.rpc).toHaveBeenCalledTimes(2);
  });

  it('nieudany zapis można powtórzyć przy następnym wejściu, a strona nie pada', async () => {
    const tenant = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const t0 = 1_800_000_000_000;
    m.rpc.mockResolvedValueOnce({ data: null, error: { message: 'chwilowo' } });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(noteTenantActivityThrottled(tenant, t0)).resolves.toBeUndefined();
    spy.mockRestore();
    await noteTenantActivityThrottled(tenant, t0 + 60_000);
    expect(m.rpc).toHaveBeenCalledTimes(2);
  });

  it('pamięć ma sufit przy wielu firmach', async () => {
    const t0 = 1_800_000_000_000;
    for (let i = 0; i < 25_000; i += 1) {
      await noteTenantActivityThrottled(`f-${i}`, t0);
    }
    const { inboxActivityMemorySize } = await import('@/lib/ksef/inbox-activity');
    expect(inboxActivityMemorySize()).toBeLessThanOrEqual(20_000);
  });
});

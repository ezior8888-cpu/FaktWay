import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';

const mocks = vi.hoisted(() => ({
  email: vi.fn(),
  push: vi.fn(),
  proposal: vi.fn(),
  audit: vi.fn(),
  captureException: vi.fn(),
  order: [] as string[],
}));

vi.mock('@sentry/nextjs', () => ({ captureException: mocks.captureException }));
vi.mock('@/lib/supabase/admin-queries', () => ({
  readTenantOwnerContact: async (id: string) => ({ ownerUserId: `user-${id}`, email: `admin-${id}@firma.test` }),
}));
vi.mock('@/lib/email/send', () => ({ sendCertExpiryAlert: mocks.email }));
vi.mock('@/lib/push/sender', () => ({ sendPushToTenant: mocks.push }));
vi.mock('@/lib/flo/proposals', () => ({ createProposal: mocks.proposal }));
vi.mock('@/lib/alerts/slack', () => ({ sendSlackAlert: vi.fn() }));
vi.mock('@/lib/audit/log-system', () => ({ logAuditSystem: mocks.audit }));
vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: async () => {
    const query = (table: string) => {
      const q: Record<string, unknown> = {};
      // Lista firm idzie stronami po kluczu (sesja 27): kursor `gt('id', …)`
      // musi działać, inaczej każda strona oddaje te same firmy.
      let afterId: string | null = null;
      Object.assign(q, {
        select: () => q,
        eq: () => q,
        in: () => q,
        gt: (column: string, value: string) => {
          if (column === 'id') afterId = value;
          return q;
        },
        gte: () => q,
        lte: () => q,
        order: () => q,
        limit: () => q,
        maybeSingle: async () => ({ data: null, error: null }),
        // Dwie firmy z certyfikatem na ostatnim progu, bez wysłanych ostrzeżeń
        // — wystarczy do sprawdzenia kanałów.
        then: (ok: (v: unknown) => unknown) =>
          Promise.resolve({
            data:
              table === 'tenants'
                ? [
                    { id: 't1', nip: '1', name: 'Firma 1', ksef_certificate_expiry: new Date(Date.now() + 6.5 * 864e5).toISOString() },
                    { id: 't2', nip: '2', name: 'Firma 2', ksef_certificate_expiry: new Date(Date.now() + 6.5 * 864e5).toISOString() },
                  ].filter((t) => afterId === null || t.id > afterId)
                : [],
            error: null,
          }).then(ok),
      });
      return q;
    };
    return { from: query };
  },
}));

import { runCertExpiryAlert } from '@/lib/jobs/runners/cert-expiry-alert';

/**
 * Ostrzeżenie o wygasającym certyfikacie jest krytyczne. Karta Flo
 * (X-03) to dodatek — jej awaria nie może zablokować maila ani pusha,
 * ani kolejnych firm. (Uwaga recenzji ChatGPT nr 6, 25.09.2026.)
 */

const ctx: JobContext = {
  attempt: 0,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  step: {
    run: async (name, fn) => {
      mocks.order.push(name);
      return fn();
    },
    sleep: vi.fn(),
    sendEvent: vi.fn(),
    scheduleAfter: vi.fn(),
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.order = [];
  mocks.email.mockResolvedValue({ sent: true });
  mocks.push.mockResolvedValue({ sent: 1, failed: 0 });
});

describe('certyfikat KSeF: kanały ostrzeżenia', () => {
  it('awaria karty Flo nie blokuje maili ani kolejnych firm', async () => {
    mocks.proposal.mockRejectedValue(new Error('flo_proposals niedostępne'));

    await expect(runCertExpiryAlert(ctx)).resolves.toBeDefined();

    const adresaci = mocks.email.mock.calls.map((c) => c[0]);
    expect(adresaci).toContain('admin-t1@firma.test');
    expect(adresaci).toContain('admin-t2@firma.test');
    expect(mocks.push).toHaveBeenCalled();
  });

  it('push pada (błąd odczytu bazy) po wysłanym mailu → ostrzeżenie dostarczone mailem i zapisane, bez wyjątku (ponowienie zdublowałoby mail); Sentry z firmą', async () => {
    mocks.proposal.mockResolvedValue({ status: 'created' });
    const readError = Object.assign(new Error('Nie można odczytać subskrypcji push: connection terminated'), { name: 'PushReadError' });
    mocks.push.mockRejectedValue(readError);

    await expect(runCertExpiryAlert(ctx)).resolves.toBeDefined();

    expect(mocks.email).toHaveBeenCalledTimes(2);
    const zapisane = mocks.audit.mock.calls.map((c) => c[0] as { tenantId: string; metadata: Record<string, unknown> });
    expect(zapisane.map((a) => a.tenantId)).toEqual(['t1', 't2']);
    expect(zapisane[0]!.metadata).toMatchObject({ emailed: true, push_sent: 0 });
    expect(mocks.captureException).toHaveBeenCalledWith(readError, expect.objectContaining({
      tags: expect.objectContaining({ job: 'cert-expiry-alert', step: 'push' }), extra: { tenantId: 't1' },
    }));
  });

  it('mail i push idą PRZED kartą (karta nie może ich opóźnić)', async () => {
    mocks.proposal.mockResolvedValue({ status: 'created' });
    await runCertExpiryAlert(ctx);

    const t1 = mocks.order.filter((n) => n.includes('t1'));
    expect(t1[0]).toMatch(/^alert-t1-/);
    expect(t1[1]).toMatch(/^flo-cert-card-t1-/);
  });
});

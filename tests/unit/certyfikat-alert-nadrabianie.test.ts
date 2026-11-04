import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';

type Row = Record<string, unknown>;

const mocks = vi.hoisted(() => ({
  tenants: [] as Row[],
  audit: [] as Row[],
  auditReadError: null as { message: string } | null,
  adminEmail: (id: string) => `admin-${id}@firma.test` as string | null,
  // Błąd odczytu właściciela albo adresu (baza, GoTrue) dla danej firmy; `null` — odczyt udany.
  contactError: ((): Error | null => null) as (id: string) => Error | null,
  email: vi.fn(),
  push: vi.fn(),
  proposal: vi.fn(),
  slack: vi.fn(),
  queriedTables: [] as string[],
}));

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('@/lib/supabase/admin-queries', () => ({
  // Jak prawdziwe helpery: łagodny zamienia błąd odczytu na „brak adresu”, ścisły rzuca.
  getTenantAdminEmail: async (id: string) => (mocks.contactError(id) ? null : mocks.adminEmail(id)),
  readTenantOwnerContact: async (id: string) => {
    const error = mocks.contactError(id);
    if (error) throw error;
    const email = mocks.adminEmail(id);
    return { ownerUserId: email ? `user-${id}` : null, email };
  },
}));
vi.mock('@/lib/email/send', () => ({ sendCertExpiryAlert: mocks.email }));
vi.mock('@/lib/push/sender', () => ({ sendPushToTenant: mocks.push }));
vi.mock('@/lib/flo/proposals', () => ({ createProposal: mocks.proposal }));
vi.mock('@/lib/alerts/slack', () => ({ sendSlackAlert: mocks.slack }));
vi.mock('@/lib/audit/log-system', () => ({
  logAuditSystem: async (entry: Row) => {
    mocks.audit.push({
      tenant_id: entry.tenantId,
      action: entry.action,
      metadata: entry.metadata,
      created_at: new Date().toISOString(),
    });
  },
}));
vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: async () => ({
    from(table: string) {
      mocks.queriedTables.push(table);
      const predicates: Array<(r: Row) => boolean> = [];
      // Lista firm idzie stronami po kluczu (sesja 27): order i limit działają
      // jak w bazie, inaczej strony nie dowodziłyby niczego.
      let sortKey: string | null = null;
      let limitN: number | null = null;
      const q = {
        select: () => q,
        eq(k: string, v: unknown) { predicates.push((r) => r[k] === v); return q; },
        in(k: string, v: unknown[]) { predicates.push((r) => v.includes(r[k])); return q; },
        gt(k: string, v: string) { predicates.push((r) => String(r[k]) > v); return q; },
        gte(k: string, v: string) { predicates.push((r) => String(r[k]) >= v); return q; },
        lte(k: string, v: string) { predicates.push((r) => String(r[k]) <= v); return q; },
        not() { return q; },
        order(k: string) { sortKey = k; return q; },
        limit(n: number) { limitN = n; return q; },
        then(ok: (v: unknown) => unknown) {
          if (table === 'audit_logs' && mocks.auditReadError) {
            return Promise.resolve({ data: null, error: mocks.auditReadError }).then(ok);
          }
          const source = table === 'tenants' ? mocks.tenants : table === 'audit_logs' ? mocks.audit : [];
          let rows = source.filter((r) => predicates.every((p) => p(r)));
          if (sortKey) {
            const key = sortKey;
            rows = [...rows].sort((a, b) => (String(a[key]) < String(b[key]) ? -1 : String(a[key]) > String(b[key]) ? 1 : 0));
          }
          if (limitN !== null) rows = rows.slice(0, limitN);
          return Promise.resolve({ data: rows, error: null }).then(ok);
        },
      };
      return q;
    },
  }),
}));

import { runCertExpiryAlert } from '@/lib/jobs/runners/cert-expiry-alert';

/**
 * AUD-53: ostrzeżenie o certyfikacie KSeF szło tylko w jednodniowych oknach
 * 30/14/7 dni. Jeden pominięty przebieg (awaria workera, wdrożenie w porze
 * crona) i firma nie dostawała ostrzeżenia na tym progu wcale; operator nie
 * wiedział nic. Teraz zadanie nadrabia najpilniejszy przekroczony próg,
 * pamięta wysłane (audit_logs) i zgłasza operatorowi pilne i niedostarczone.
 */

const DAY = 86_400_000;
const NOW = new Date('2026-10-02T06:00:00Z');
const za = (dni: number) => new Date(NOW.getTime() + dni * DAY).toISOString();

const ctx: JobContext = {
  attempt: 0,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  step: { run: async (_n, fn) => fn(), sleep: vi.fn(), sendEvent: vi.fn(), scheduleAfter: vi.fn() },
};

const firma = (id: string, expiry: string): Row => ({ id, nip: '1234567890', name: `Firma ${id}`, ksef_certificate_expiry: expiry });
const wyslany = (tenantId: string, threshold: number, expiry: string): Row => ({
  tenant_id: tenantId,
  action: 'ksef.cert_expiry_alert',
  metadata: { threshold, expiry },
  created_at: new Date(NOW.getTime() - 10 * DAY).toISOString(),
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  mocks.tenants = [];
  mocks.audit = [];
  mocks.auditReadError = null;
  mocks.queriedTables = [];
  mocks.adminEmail = (id) => `admin-${id}@firma.test`;
  mocks.contactError = () => null;
  mocks.email.mockResolvedValue({ sent: true });
  mocks.push.mockResolvedValue({ sent: 1, failed: 0 });
  mocks.proposal.mockResolvedValue({ status: 'created' });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('certyfikat KSeF — nadrabianie progów (AUD-53)', () => {
  it('pominięte okno 30 dni: przy 20 dniach ostrzeżenie przychodzi, z prawdziwą liczbą dni', async () => {
    mocks.tenants = [firma('t1', za(19.5))];

    await runCertExpiryAlert(ctx);

    expect(mocks.email).toHaveBeenCalledTimes(1);
    expect(mocks.email.mock.calls[0]![1]).toMatchObject({ daysRemaining: 20 });
    expect(mocks.audit).toEqual([
      expect.objectContaining({ tenant_id: 't1', action: 'ksef.cert_expiry_alert', metadata: expect.objectContaining({ threshold: 30 }) }),
    ]);
  });

  it('próg już wysłany dla tej daty wygaśnięcia — następnego dnia cisza', async () => {
    mocks.tenants = [firma('t1', za(18.5))];
    mocks.audit = [wyslany('t1', 30, za(18.5))];

    await runCertExpiryAlert(ctx);

    expect(mocks.email).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it('pominięty próg 14: przy 6,5 dnia idzie od razu najpilniejszy (7), jeden mail', async () => {
    const expiry = za(6.5);
    mocks.tenants = [firma('t1', expiry)];
    mocks.audit = [wyslany('t1', 30, expiry)];

    await runCertExpiryAlert(ctx);

    expect(mocks.email).toHaveBeenCalledTimes(1);
    expect(mocks.email.mock.calls[0]![1]).toMatchObject({ daysRemaining: 7 });
    expect(mocks.audit.at(-1)).toMatchObject({ metadata: expect.objectContaining({ threshold: 7 }) });
  });

  it('nowy certyfikat (inna data wygaśnięcia) zaczyna progi od nowa', async () => {
    mocks.tenants = [firma('t1', za(25))];
    mocks.audit = [wyslany('t1', 7, za(-40))];

    await runCertExpiryAlert(ctx);

    expect(mocks.email).toHaveBeenCalledTimes(1);
  });

  it('certyfikat dalej niż 30 dni albo już wygasły — bez ostrzeżenia o progu', async () => {
    mocks.tenants = [firma('daleko', za(45)), firma('wygasl', za(-1))];

    await runCertExpiryAlert(ctx);

    expect(mocks.email).not.toHaveBeenCalled();
  });

  it('niedostarczone (brak maila i pusha) nie jest zapisane — jutro kolejna próba, operator wie dziś', async () => {
    mocks.tenants = [firma('t1', za(20))];
    mocks.adminEmail = () => null;
    mocks.push.mockResolvedValue({ sent: 0, failed: 0 });

    await runCertExpiryAlert(ctx);

    expect(mocks.audit).toEqual([]);
    expect(mocks.slack).toHaveBeenCalledTimes(1);
    expect(mocks.slack.mock.calls[0]![0]).toMatchObject({ channel: 'urgent' });
    expect(JSON.stringify(mocks.slack.mock.calls[0]![0])).toContain('t1');
  });

  it('ostatni próg (7 dni) zgłaszany operatorowi także po dostarczeniu', async () => {
    mocks.tenants = [firma('pilna', za(5)), firma('spokojna', za(25))];

    await runCertExpiryAlert(ctx);

    expect(mocks.slack).toHaveBeenCalledTimes(1);
    const wiadomosc = JSON.stringify(mocks.slack.mock.calls[0]![0]);
    expect(wiadomosc).toContain('pilna');
    expect(wiadomosc).not.toContain('spokojna');
  });

  it('spokojny dzień — operator nie dostaje nic', async () => {
    mocks.tenants = [firma('t1', za(25))];

    await runCertExpiryAlert(ctx);

    expect(mocks.slack).not.toHaveBeenCalled();
  });

  it('błąd odczytu wysłanych ostrzeżeń przerywa, zamiast wysłać wszystkim ponownie', async () => {
    mocks.tenants = [firma('t1', za(20))];
    mocks.auditReadError = { message: 'timeout' };

    await expect(runCertExpiryAlert(ctx)).rejects.toThrow(/timeout/);
    expect(mocks.email).not.toHaveBeenCalled();
  });

  it('karta FLO powstaje na nadrobionym progu i nie pyta globalnego ksef_health_log', async () => {
    mocks.tenants = [firma('t1', za(20))];

    await runCertExpiryAlert(ctx);

    expect(mocks.proposal).toHaveBeenCalledTimes(1);
    expect(mocks.queriedTables).not.toContain('ksef_health_log');
  });
});

/**
 * A5: błąd odczytu adresu właściciela (baza, GoTrue) był „brakiem adresu”:
 * mail pomijany, a gdy doszedł push, próg zapisany jako dostarczony — mail
 * o tym progu nie wychodził już nigdy, a operator widział „brak adresu”.
 * Teraz błąd odczytu ponawia zadanie (jak błąd Resend), a mail ma klucz
 * idempotencji: ponowienie przechodzi pętlę od nowa, a zapis w audit_logs
 * jest fail-open.
 */
describe('certyfikat KSeF — błąd odczytu adresu i ponowienie (A5)', () => {
  it('błąd odczytu adresu — ta firma bez maila i pusha (bez zapisu progu), pozostałe dostają; operator wie; zadanie rzuca na końcu, ponowienie wysyła jej mail, innym nie drugi raz', async () => {
    const expiry = za(6.5);
    mocks.tenants = [firma('t1', expiry), firma('t2', expiry), firma('t3', expiry)];
    let failures = 1;
    mocks.contactError = (id) =>
      id === 't2' && failures-- > 0 ? new Error('Nie można odczytać e-maila właściciela firmy: upstream timeout') : null;

    await expect(runCertExpiryAlert(ctx)).rejects.toThrow(/adresu właściciela \(1 firm: t2\)/);
    expect(mocks.email.mock.calls.map((c) => c[0])).toEqual(['admin-t1@firma.test', 'admin-t3@firma.test']);
    expect(mocks.push.mock.calls.map((c) => c[0])).toEqual(['t1', 't3']);
    expect(mocks.audit.map((a) => a.tenant_id)).toEqual(['t1', 't3']);
    expect(mocks.slack).toHaveBeenCalledTimes(1);
    expect(mocks.slack.mock.calls[0]![0]).toMatchObject({
      channel: 'urgent',
      context: expect.objectContaining({ t2: expect.stringContaining('błąd odczytu adresu') }),
    });
    expect(ctx.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('nie można odczytać adresu właściciela'),
      expect.objectContaining({ tenantId: 't2', error: expect.stringContaining('upstream timeout') }),
    );

    // Ponowienie zadania — pg-boss wykonuje cały handler od nowa.
    await runCertExpiryAlert(ctx);

    expect(mocks.email.mock.calls.map((c) => c[0])).toEqual(['admin-t1@firma.test', 'admin-t3@firma.test', 'admin-t2@firma.test']);
    expect(mocks.audit.map((a) => a.tenant_id)).toEqual(['t1', 't3', 't2']);
    expect(mocks.audit[2]!.metadata).toMatchObject({ threshold: 7, emailed: true });
  });

  it('prawdziwy brak adresu (konto bez e-maila) — bez wyjątku, push wystarcza jak dotąd', async () => {
    mocks.tenants = [firma('t1', za(20))];
    mocks.adminEmail = () => null;

    await runCertExpiryAlert(ctx);

    expect(mocks.email).not.toHaveBeenCalled();
    expect(mocks.audit).toEqual([expect.objectContaining({ tenant_id: 't1', metadata: expect.objectContaining({ emailed: false, push_sent: 1 }) })]);
  });

  it('mail z kluczem idempotencji: firma, data wygaśnięcia, próg i liczba dni — ponowienie tego dnia ten sam klucz, następny dzień inny', async () => {
    const expiry = za(6.5);
    mocks.tenants = [firma('t1', expiry)];
    // Niedostarczone (adres na liście odbić, bez pusha) — bez zapisu, więc każdy przebieg próbuje znowu.
    mocks.email.mockResolvedValue({ sent: false, reason: 'bounced' });
    mocks.push.mockResolvedValue({ sent: 0, failed: 0 });

    await runCertExpiryAlert(ctx);
    await runCertExpiryAlert(ctx);
    vi.setSystemTime(new Date(NOW.getTime() + DAY));
    await runCertExpiryAlert(ctx);

    const keys = mocks.email.mock.calls.map((c) => (c[2] as { idempotencyKey?: string } | undefined)?.idempotencyKey);
    expect(keys).toEqual([
      `cert-expiry/t1/${Date.parse(expiry)}/7/7`,
      `cert-expiry/t1/${Date.parse(expiry)}/7/7`,
      `cert-expiry/t1/${Date.parse(expiry)}/7/6`,
    ]);
  });
});

import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Ten sam błąd co w `logAudit` (#506): adres klienta brany z PIERWSZEGO wpisu
 * `X-Forwarded-For`, który podaje sam klient. Dwa kolejne miejsca: akcja
 * usunięcia konta (adres w `gdpr_deletion_requests`) i eksport portalu księgowej
 * (adres w metadanych audytu). Prawdziwe: akcja i trasa; atrapy: baza, HTTP.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const m = vi.hoisted(() => ({
  headers: new Headers(),
  createGdprRequest: vi.fn(),
  logAuditSystem: vi.fn(),
}));

vi.mock('next/headers', () => ({ headers: async () => m.headers }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({ captureException: () => 'err-1' }));
vi.mock('@/lib/audit/log', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/audit/log-system', () => ({ logAuditSystem: m.logAuditSystem }));
vi.mock('@/lib/auth/reauth', () => ({ reauthenticateWithPassword: async () => ({ ok: true }) }));
vi.mock('@/lib/auth/verified-mfa', () => ({
  getVerifiedMfaState: async () => ({ status: 'verified', user: { id: 'u1', email: 'user@example.test' } }),
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({}) }));
vi.mock('@/lib/email/send', () => ({ sendGdprDeletionScheduledEmail: async () => ({ sent: true }) }));
vi.mock('@/lib/gdpr/deletion', () => ({ createGdprRequest: m.createGdprRequest, cancelOwnGdprRequest: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: { id: 'acc-1', tenant_id: TENANT, access_level: 'download', revoked_at: null, expires_at: null },
            error: null,
          }),
        }),
      }),
    }),
  }),
}));
vi.mock('@/lib/exports/data-fetcher', () => ({
  fetchInvoicesForExport: async () => ({
    issuer: { nip: '5260001246', name: 'ACME' },
    issuedInvoices: [], receivedInvoices: [], expenses: [],
  }),
}));
vi.mock('@/lib/exports/kpir-generator', () => ({ generateKpirXlsx: async () => Buffer.from('xlsx') }));

const { requestGdprDeletionAction } = await import('@/app/(dashboard)/settings/account/actions');
const { POST } = await import('@/app/api/portal/exports/generate/route');

const FAKE = '198.51.100.7';
const REAL = '83.21.104.77';

async function ipZAkcjiUsuniecia(h: Record<string, string>): Promise<unknown> {
  m.headers = new Headers(h);
  const data = new FormData();
  data.set('current_password', 'test-password');
  await requestGdprDeletionAction(data);
  expect(m.createGdprRequest).toHaveBeenCalledTimes(1);
  return m.createGdprRequest.mock.calls[0]![0].ipAddress;
}

async function ipZEksportu(h: Record<string, string>): Promise<unknown> {
  const res = await POST(new NextRequest('https://app.example.test/api/portal/exports/generate', {
    method: 'POST',
    headers: { 'x-accountant-token': 'token-ksiegowej', ...h },
    body: JSON.stringify({ tenantId: TENANT, format: 'kpir_excel', periodStart: '2026-09-01', periodEnd: '2026-09-30' }),
  }));
  expect(res.status).toBe(200);
  expect(m.logAuditSystem).toHaveBeenCalledTimes(1);
  return m.logAuditSystem.mock.calls[0]![0].metadata.ip_address;
}

beforeEach(() => {
  vi.resetAllMocks();
  m.createGdprRequest.mockResolvedValue({
    id: 'r1', scheduledFor: new Date('2030-01-16'), cancelToken: null, alreadyScheduled: true,
  });
  m.logAuditSystem.mockResolvedValue(undefined);
});

describe('usunięcie konta: adres IP w żądaniu', () => {
  it('X-Real-Ip wygrywa z podrobionym pierwszym wpisem X-Forwarded-For', async () => {
    await expect(ipZAkcjiUsuniecia({ 'x-forwarded-for': `${FAKE}, ${REAL}`, 'x-real-ip': REAL })).resolves.toBe(REAL);
  });
  it('bez X-Real-Ip: ostatni wpis X-Forwarded-For', async () => {
    await expect(ipZAkcjiUsuniecia({ 'x-forwarded-for': `${FAKE}, ${REAL}` })).resolves.toBe(REAL);
  });
  it('wartość, która nie jest adresem, to brak adresu', async () => {
    await expect(ipZAkcjiUsuniecia({ 'x-forwarded-for': 'x' })).resolves.toBeUndefined();
  });
});

describe('eksport portalu księgowej: adres IP w audycie', () => {
  it('X-Real-Ip wygrywa z podrobionym pierwszym wpisem X-Forwarded-For', async () => {
    await expect(ipZEksportu({ 'x-forwarded-for': `${FAKE}, ${REAL}`, 'x-real-ip': REAL })).resolves.toBe(REAL);
  });
  it('bez X-Real-Ip: ostatni wpis X-Forwarded-For', async () => {
    await expect(ipZEksportu({ 'x-forwarded-for': `${FAKE}, ${REAL}` })).resolves.toBe(REAL);
  });
  it('wartość, która nie jest adresem, to „unknown”', async () => {
    await expect(ipZEksportu({ 'x-forwarded-for': 'x' })).resolves.toBe('unknown');
  });
});

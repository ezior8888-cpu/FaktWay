import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * E8 (PLAN-PRAWDZIWE-DANE, Z11): po udanym `finalize_ksef_certificate_claim`
 * akcja wgrania certyfikatu czyści zapisany błąd certyfikatu strumienia
 * sprzedaży firmy — stan E znika od razu, nie po najbliższym cronie. Test
 * idzie prawdziwą ścieżką: akcja → `clearKsefHistoryCertificateErrors` →
 * (atrapa) tabela `ksef_history_sync`; mockowane są tylko granice (baza, KSeF).
 */

type StreamRow = {
  tenant_id: string;
  environment: string;
  direction: string;
  last_error_code: string | null;
  last_error_detail: string | null;
  last_error_at: string | null;
  consecutive_failures: number;
};

const state = vi.hoisted(() => ({
  streams: [] as unknown[],
  historyThrows: false,
}));

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  createAdminClient: vi.fn(),
  membershipResult: vi.fn(),
  tenantResult: vi.fn(),
  rpc: vi.fn(),
  mfa: vi.fn(),
  ksefAuth: vi.fn(),
  encrypt: vi.fn(),
  rateLimit: vi.fn(),
  revalidate: vi.fn(),
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => ({ value: '11111111-1111-4111-8111-111111111111' }) }),
}));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: mocks.createClient,
  createAdminClient: mocks.createAdminClient,
}));
vi.mock('@/lib/auth/verified-mfa', () => ({ getVerifiedMfaState: mocks.mfa }));
vi.mock('@/lib/ksef/auth', () => ({ authenticateWithXades: mocks.ksefAuth }));
vi.mock('@/lib/ksef/credentials-crypto', () => ({ encryptCredentials: mocks.encrypt }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: mocks.rateLimit }));

import { uploadCertificateAction } from '@/components/settings/actions';
import { makeSelfSignedCertificate } from '../helpers/self-signed-cert';

const tenantId = '11111111-1111-4111-8111-111111111111';
const otherTenant = '33333333-3333-4333-8333-333333333333';
const user = { id: '22222222-2222-4222-8222-222222222222', email: 'owner@example.test' };
// Akcja czyta pliki naprawdę (PEM/DER), więc fixture to prawdziwy certyfikat samopodpisany.
const material = makeSelfSignedCertificate({ kind: 'ec', nip: '1234567890' });
const pem = {
  certificate: Buffer.from(material.certPem).toString('base64'),
  privateKey: Buffer.from(material.keyPem).toString('base64'),
};

const rows = () => state.streams as StreamRow[];

function stream(over: Partial<StreamRow>): StreamRow {
  return {
    tenant_id: tenantId,
    environment: 'test',
    direction: 'outgoing',
    last_error_code: 'certificate_expired',
    last_error_detail: 'Certyfikat wygasł',
    last_error_at: '2026-10-22T10:00:00.000Z',
    consecutive_failures: 4,
    ...over,
  };
}

/** Minimalna atrapa łańcucha `update().eq()...in().select()` na tablicy wierszy. */
function historyTable() {
  if (state.historyThrows) throw new Error('baza niedostępna');
  const filters: ((r: StreamRow) => boolean)[] = [];
  let patch: Partial<StreamRow> | null = null;
  const builder = {
    update(p: Partial<StreamRow>) {
      patch = p;
      return builder;
    },
    eq(column: keyof StreamRow, value: unknown) {
      filters.push((r) => r[column] === value);
      return builder;
    },
    in(column: keyof StreamRow, values: unknown[]) {
      filters.push((r) => values.includes(r[column]));
      return builder;
    },
    select() {
      const matched = rows().filter((r) => filters.every((f) => f(r)));
      if (patch) for (const r of matched) Object.assign(r, patch);
      return Promise.resolve({ data: matched.map(() => ({ id: 'x' })), error: null });
    },
  };
  return builder;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('KSEF_ENV', 'test');
  state.historyThrows = false;
  state.streams = [
    stream({}),
    stream({ tenant_id: otherTenant }),
    stream({ last_error_code: 'rate_limited', consecutive_failures: 2 }),
    stream({ direction: 'incoming' }),
    stream({ environment: 'production' }),
  ];
  const membershipQuery = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: mocks.membershipResult,
  };
  const tenantQuery = { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), single: mocks.tenantResult };
  mocks.createClient.mockResolvedValue({ from: vi.fn(() => tenantQuery) });
  mocks.createAdminClient.mockReturnValue({
    from: vi.fn((table: string) => {
      if (table === 'memberships') return membershipQuery;
      if (table === 'ksef_history_sync') return historyTable();
      throw new Error(`Unexpected admin table ${table}`);
    }),
    rpc: mocks.rpc,
  });
  mocks.membershipResult.mockResolvedValue({ data: { role: 'owner', status: 'active' }, error: null });
  mocks.tenantResult.mockResolvedValue({ data: { nip: '1234567890' }, error: null });
  mocks.mfa.mockResolvedValue({ status: 'verified', user });
  mocks.rateLimit.mockResolvedValue({ allowed: true, fallback: false, retryAfter: 0 });
  const exp = Math.floor(Date.now() / 1000) + 3600;
  mocks.ksefAuth.mockResolvedValue({
    accessToken: 'header.' + Buffer.from(JSON.stringify({ per: 'Owner', exp })).toString('base64url') + '.signature',
    accessTokenExpiresAt: (exp - 60) * 1000,
    refreshToken: 'fixture-refresh',
    refreshTokenExpiresAt: (exp + 3600) * 1000,
    nip: '1234567890',
  });
  mocks.encrypt.mockReturnValue(Buffer.alloc(64, 1));
  mocks.rpc.mockResolvedValue({ data: 'claimed', error: null });
});

afterEach(() => vi.unstubAllEnvs());

describe('uploadCertificateAction czyści błąd certyfikatu historii (Z11)', () => {
  it('po udanym claimie strumień sprzedaży firmy w tym środowisku traci błąd certyfikatu', async () => {
    await expect(uploadCertificateAction(pem)).resolves.toMatchObject({ success: true });

    const [mine, otherFirm, otherError, incoming, prod] = rows();
    expect(mine).toMatchObject({ last_error_code: null, last_error_detail: null, last_error_at: null, consecutive_failures: 0 });
    // Cudze wiersze i inne błędy zostają nietknięte.
    expect(otherFirm?.last_error_code).toBe('certificate_expired');
    expect(otherError).toMatchObject({ last_error_code: 'rate_limited', consecutive_failures: 2 });
    expect(incoming?.last_error_code).toBe('certificate_expired');
    expect(prod?.last_error_code).toBe('certificate_expired');
  });

  it('czyści też przy odnowieniu własnego certyfikatu (already_claimed_by_self)', async () => {
    mocks.rpc.mockResolvedValue({ data: 'already_claimed_by_self', error: null });
    await expect(uploadCertificateAction(pem)).resolves.toMatchObject({ success: true, wasFirstClaim: false });
    expect(rows()[0]?.last_error_code).toBeNull();
  });

  it('bez udanego claimu nic nie czyści', async () => {
    mocks.rpc.mockResolvedValue({ data: 'already_claimed_by_other', error: null });
    await expect(uploadCertificateAction(pem)).resolves.toMatchObject({ success: false });
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'x' } });
    await expect(uploadCertificateAction(pem)).resolves.toMatchObject({ success: false });
    expect(rows()[0]?.last_error_code).toBe('certificate_expired');
  });

  it('błąd czyszczenia nie psuje wgrania', async () => {
    state.historyThrows = true;
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(uploadCertificateAction(pem)).resolves.toMatchObject({ success: true });
    expect(mocks.revalidate).toHaveBeenCalledWith('/settings/ksef');
    log.mockRestore();
  });
});

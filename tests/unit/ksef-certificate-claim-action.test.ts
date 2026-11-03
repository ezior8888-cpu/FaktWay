import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
import { KsefAuthRejectedError } from '@/lib/ksef/auth-errors';
import { KsefApiError } from '@/lib/ksef/client';
import { X509Certificate as X509, type KeyObject } from 'node:crypto';
import { CERTIFICATE_HEADER, makeRsaPrivateKey, makeSelfSignedCertificate, PKCS8_HEADER } from '../helpers/self-signed-cert';

const tenantId = '11111111-1111-4111-8111-111111111111';
const user = { id: '22222222-2222-4222-8222-222222222222', email: 'owner@example.test' };
const NIP = '1234567890';
const PKCS8_START = new RegExp('^' + PKCS8_HEADER);
const CERT_START = new RegExp('^' + CERTIFICATE_HEADER);
const PASSWORD = 'Haslo-testowe-15-znakow!';

// Akcja czyta pliki naprawdę (PEM/DER), więc fixture to prawdziwy certyfikat samopodpisany.
const b64 = (value: string | Buffer) => Buffer.from(value).toString('base64');
const material = makeSelfSignedCertificate({ kind: 'ec', nip: NIP });
const pem = { certificate: b64(material.certPem), privateKey: b64(material.keyPem) };
const encryptedKey = (key: KeyObject) =>
  b64(key.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: PASSWORD }) as string);

function ksefSession(permissions: unknown = 'Owner') {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  return {
    accessToken: 'header.' + Buffer.from(JSON.stringify({ per: permissions, exp })).toString('base64url') + '.signature',
    accessTokenExpiresAt: (exp - 60) * 1000,
    refreshToken: 'fixture-refresh',
    refreshTokenExpiresAt: (exp + 3600) * 1000,
    nip: '1234567890',
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('KSEF_ENV', 'test');
  const membershipQuery = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: mocks.membershipResult,
  };
  const tenantQuery = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: mocks.tenantResult,
  };
  mocks.createClient.mockResolvedValue({
    from: vi.fn((table: string) => {
      if (table !== 'tenants') throw new Error(`Unexpected client table ${table}`);
      return tenantQuery;
    }),
  });
  mocks.createAdminClient.mockReturnValue({
    from: vi.fn((table: string) => {
      if (table !== 'memberships') throw new Error(`Unexpected admin table ${table}`);
      return membershipQuery;
    }),
    rpc: mocks.rpc,
  });
  mocks.membershipResult.mockResolvedValue({ data: { role: 'owner', status: 'active' }, error: null });
  mocks.tenantResult.mockResolvedValue({ data: { nip: '1234567890' }, error: null });
  mocks.mfa.mockResolvedValue({ status: 'verified', user });
  mocks.rateLimit.mockResolvedValue({ allowed: true, fallback: false, retryAfter: 0 });
  mocks.ksefAuth.mockImplementation(async () => ksefSession());
  mocks.encrypt.mockReturnValue(Buffer.alloc(64, 1));
  mocks.rpc.mockResolvedValue({ data: 'claimed', error: null });
});

afterEach(() => vi.unstubAllEnvs());

function expectNoKsefEffects() {
  expect(mocks.ksefAuth).not.toHaveBeenCalled();
  expect(mocks.encrypt).not.toHaveBeenCalled();
  expect(mocks.rpc).not.toHaveBeenCalled();
  expect(mocks.revalidate).not.toHaveBeenCalled();
}

describe('KSeF certificate claim action', () => {
  it.each(['admin', 'member', 'accountant'])('rejects %s before external I/O or privileged RPC', async (role) => {
    mocks.membershipResult.mockResolvedValue({ data: { role, status: 'active' }, error: null });

    await expect(uploadCertificateAction(pem)).resolves.toMatchObject({ success: false });
    expectNoKsefEffects();
    expect(mocks.rateLimit).not.toHaveBeenCalled();
  });

  it.each(['enrollment_required', 'challenge_required'])('requires completed MFA when status is %s', async (status) => {
    mocks.mfa.mockResolvedValue({ status, user });

    await expect(uploadCertificateAction(pem)).resolves.toMatchObject({ success: false });
    expectNoKsefEffects();
  });

  // Logowanie biometrią (FW1): panel przepuścił sesję ze znacznikiem, a tu dalej
  // trzeba prawdziwego kodu. Klient dostaje przejście na ekran kodu, nie „włącz 2FA”.
  it('a passkey session past the panel gate gets the code-screen path, without KSeF effects', async () => {
    mocks.mfa.mockResolvedValueOnce({ status: 'verified', user })
      .mockResolvedValueOnce({ status: 'challenge_required', user });

    await expect(uploadCertificateAction(pem)).resolves.toEqual({
      success: false,
      reason: 'mfa_required',
      mfaStepUp: true,
      error: 'Zmiana certyfikatu KSeF wymaga potwierdzenia kodem z aplikacji.',
    });
    expectNoKsefEffects();
  });

  it('an owner without 2FA still gets the enable-2FA message and no code-screen path', async () => {
    mocks.mfa.mockResolvedValueOnce({ status: 'verified', user })
      .mockResolvedValueOnce({ status: 'enrollment_required', user });

    const result = await uploadCertificateAction(pem);
    expect(result).toMatchObject({ success: false, error: 'Przed zmianą certyfikatu KSeF włącz i potwierdź logowanie dwuetapowe.' });
    expect(result).not.toHaveProperty('mfaStepUp');
    expectNoKsefEffects();
  });

  it('refuses an MFA identity mismatch before authentication with KSeF', async () => {
    mocks.mfa.mockResolvedValueOnce({ status: 'verified', user })
      .mockResolvedValueOnce({ status: 'verified', user: { ...user, id: 'other-user' } });

    await expect(uploadCertificateAction(pem)).resolves.toMatchObject({ success: false });
    expectNoKsefEffects();
  });

  it('does not authenticate against an implicit or invalid KSeF environment', async () => {
    vi.stubEnv('KSEF_ENV', 'unknown');

    await expect(uploadCertificateAction(pem)).resolves.toMatchObject({ success: false });
    expectNoKsefEffects();
  });
  it('rejects a production endpoint override before the XAdES exchange', async () => {
    vi.stubEnv('KSEF_ENV', 'production');
    vi.stubEnv('KSEF_PROD_URL', 'https://api-test.ksef.mf.gov.pl/v2');
    await expect(uploadCertificateAction(pem)).resolves.toMatchObject({ success: false });
    expectNoKsefEffects();
  });

  it('rejects delegated permissions after XAdES without persisting credentials', async () => {
    mocks.ksefAuth.mockResolvedValue(ksefSession(['InvoiceRead', 'CredentialsManage']));
    await expect(uploadCertificateAction(pem)).resolves.toMatchObject({ success: false });
    expect(mocks.encrypt).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('does not turn the in-memory limiter (no Redis on production) into a denial, but still enforces it', async () => {
    // Produkcja ma wyłączony Upstash, więc `fallback: true` jest tam zawsze. Dawniej oznaczało to
    // odmowę dla KAŻDEGO wgrania certyfikatu. Limit w pamięci procesu nadal obowiązuje.
    mocks.rateLimit.mockResolvedValueOnce({ allowed: true, fallback: true, remaining: 4, retryAfter: 0 });
    await expect(uploadCertificateAction(pem)).resolves.toMatchObject({ success: true });

    mocks.rateLimit.mockResolvedValueOnce({ allowed: false, fallback: true, remaining: 0, retryAfter: 600 });
    mocks.ksefAuth.mockClear();
    await expect(uploadCertificateAction(pem)).resolves.toMatchObject({
      success: false,
      reason: 'rate_limited',
      error: expect.stringContaining('10 min'),
    });
    expect(mocks.ksefAuth).not.toHaveBeenCalled();
  });

  it('does not claim ownership if KSeF rejects the certificate or leaks its exception', async () => {
    mocks.ksefAuth.mockRejectedValue(new Error('private_schema.cert_detail'));

    const result = await uploadCertificateAction(pem);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).not.toContain('private_schema');
    expect(mocks.encrypt).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('sends one atomic service-role RPC only after owner, MFA and KSeF succeed', async () => {
    const result = await uploadCertificateAction(pem);

    expect(result).toMatchObject({ success: true, wasFirstClaim: true });
    expect(mocks.ksefAuth).toHaveBeenCalledExactlyOnceWith({
      type: 'xades', nip: '1234567890',
      certificatePem: expect.stringMatching(CERT_START),
      privateKeyPem: expect.stringMatching(PKCS8_START),
    }, 'test');
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith('finalize_ksef_certificate_claim', {
      p_tenant_id: tenantId,
      p_actor_user_id: user.id,
      p_expected_nip: '1234567890',
      p_encrypted_credentials: `\\x${Buffer.alloc(64, 1).toString('hex')}`,
      p_certificate_expiry: new Date(new X509(material.certPem).validTo).toISOString(),
      p_environment: 'test',
    });
    expect(mocks.rateLimit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ bucket: 'ksef_certificate', limit: 5 }));
    expect(mocks.revalidate).toHaveBeenCalledWith('/settings/ksef');
  });

  it('does not leak a database error or report an unrecognized RPC result as success', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: 'private_schema.secret_detail' } })
      .mockResolvedValueOnce({ data: 'unknown', error: null });

    const first = await uploadCertificateAction(pem);
    const second = await uploadCertificateAction(pem);
    expect(first.success).toBe(false);
    if (!first.success) expect(first.error).not.toContain('private_schema');
    expect(second).toMatchObject({ success: false });
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });
});

describe('kreator podłączenia KSeF: pliki klienta (PEM, DER, hasło)', () => {
  const day = 24 * 3600 * 1000;
  const other = makeSelfSignedCertificate({ kind: 'ec', nip: NIP });
  const weakRsa = makeRsaPrivateKey(1024);

  it.each([
    ['brak hasła do zaszyfrowanego klucza', () => ({ certificate: pem.certificate, privateKey: encryptedKey(material.privateKey) }), 'password_required', /chroniony hasłem/],
    ['złe hasło', () => ({ certificate: pem.certificate, privateKey: encryptedKey(material.privateKey), password: 'inne-haslo-12345!' }), 'password_wrong', /nie pasuje do klucza/],
    ['klucz z innego wniosku', () => ({ certificate: pem.certificate, privateKey: b64(other.keyPem) }), 'key_mismatch', /nie pasuje do tego certyfikatu/],
    ['niedozwolony rodzaj klucza', () => ({ certificate: pem.certificate, privateKey: b64(weakRsa.export({ type: 'pkcs8', format: 'pem' })) }), 'key_unsupported', /RSA 2048 oraz EC P-256/],
    ['pomylone pliki', () => ({ certificate: pem.privateKey, privateKey: pem.certificate }), 'cert_unreadable', /odczytać pliku certyfikatu/],
    ['nieczytelny klucz', () => ({ certificate: pem.certificate, privateKey: b64('to nie jest klucz') }), 'key_unreadable', /odczytać pliku klucza/],
    ['plik zbyt duży', () => ({ certificate: pem.certificate, privateKey: 'A'.repeat(200_000) }), 'files_too_large', /za duży/],
    ['brak plików', () => ({ certificate: '', privateKey: '' }), 'invalid_input', /oba pliki/],
  ])('%s: konkretny komunikat, zero prób KSeF i zero zużytego limitu', async (_name, input, reason, message) => {
    await expect(uploadCertificateAction(input())).resolves.toMatchObject({
      success: false,
      reason,
      error: expect.stringMatching(message),
    });
    expectNoKsefEffects();
    expect(mocks.rateLimit).not.toHaveBeenCalled();
  });

  it('certyfikat wygasły, jeszcze nieważny i typu Offline mają osobne komunikaty', async () => {
    const expired = makeSelfSignedCertificate({ kind: 'ec', nip: NIP, notBefore: new Date(Date.now() - 30 * day), notAfter: new Date(Date.now() - day) });
    const future = makeSelfSignedCertificate({ kind: 'ec', nip: NIP, notBefore: new Date(Date.now() + 5 * day) });
    const offline = makeSelfSignedCertificate({ kind: 'ec', nip: NIP, usage: 'offline' });
    const files = (m: typeof expired) => ({ certificate: b64(m.certPem), privateKey: b64(m.keyPem) });

    await expect(uploadCertificateAction(files(expired))).resolves.toMatchObject({ reason: 'cert_expired', error: expect.stringContaining('wygasł') });
    await expect(uploadCertificateAction(files(future))).resolves.toMatchObject({ reason: 'cert_not_yet_valid', error: expect.stringContaining('zacznie obowiązywać') });
    await expect(uploadCertificateAction(files(offline))).resolves.toMatchObject({ reason: 'cert_offline', error: expect.stringContaining('Offline') });
    expectNoKsefEffects();
  });

  it('klucz EC zaszyfrowany hasłem: do KSeF i do bazy idzie klucz bez hasła, a hasło nigdzie nie zostaje', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await uploadCertificateAction({
      certificate: pem.certificate,
      privateKey: encryptedKey(material.privateKey),
      password: PASSWORD,
    });

    expect(result).toMatchObject({ success: true, wasFirstClaim: true });
    expect(mocks.ksefAuth.mock.calls[0]![0]).toMatchObject({ privateKeyPem: expect.stringMatching(PKCS8_START) });
    expect(mocks.encrypt.mock.calls[0]![0]).toMatchObject({ privateKeyPem: expect.stringMatching(PKCS8_START) });
    const everything = JSON.stringify([
      result, mocks.ksefAuth.mock.calls, mocks.encrypt.mock.calls, mocks.rpc.mock.calls, mocks.rateLimit.mock.calls, log.mock.calls,
    ]);
    expect(everything).not.toContain(PASSWORD);
    log.mockRestore();
  });

  it('pliki w DER (certyfikat i klucz PKCS#8) działają tak samo jak PEM', async () => {
    const der = {
      certificate: b64(material.certDer),
      privateKey: b64(material.privateKey.export({ type: 'pkcs8', format: 'der' })),
    };
    await expect(uploadCertificateAction(der)).resolves.toMatchObject({ success: true });
    expect(mocks.ksefAuth.mock.calls[0]![0]).toMatchObject({ privateKeyPem: expect.stringMatching(PKCS8_START) });
  });

  it('klucz RSA działa jak dotąd', async () => {
    const rsa = makeSelfSignedCertificate({ kind: 'rsa', nip: NIP });
    await expect(uploadCertificateAction({ certificate: b64(rsa.certPem), privateKey: b64(rsa.keyPem) })).resolves.toMatchObject({ success: true });
  });

  it.each([
    ['brak uprawnień do NIP (415)', new KsefAuthRejectedError(415, 'Uwierzytelnianie zakończone niepowodzeniem', ['Brak przypisanych uprawnień']), 'no_permission', /NIP 1234567890/],
    ['certyfikat odwołany (460)', new KsefAuthRejectedError(460, 'Uwierzytelnianie zakończone niepowodzeniem z powodu błędu certyfikatu', ['Certyfikat odwołany']), 'revoked', /unieważniony/],
    ['certyfikat zawieszony (460)', new KsefAuthRejectedError(460, 'Błąd certyfikatu', ['Certyfikat zawieszony']), 'revoked', /zawieszony/],
    ['inne środowisko (460)', new KsefAuthRejectedError(460, 'Błąd certyfikatu', ['Niezaufany łańcuch certyfikatów']), 'untrusted_issuer', /inne(go)? środowisk/],
    ['blokada (480)', new KsefAuthRejectedError(480, 'Uwierzytelnienie zablokowane', []), 'blocked', /zablokował/],
    ['KSeF niedostępny (503)', new KsefApiError(503, 'private_schema.detail', 'KSeF API POST /auth failed: 503'), 'unavailable', /Spróbuj ponownie za kilka minut/],
    ['za dużo żądań (429)', new KsefApiError(429, 'private_schema.detail', 'KSeF API 429'), 'unavailable', /ponownie/],
    ['błąd sieci', new TypeError('fetch failed'), 'unavailable', /chwilowo niedostępny/],
    ['odmowa KSeF z nieznanym kodem (400)', new KsefAuthRejectedError(400, 'private_schema.cert_detail', ['private_schema.detail']), 'rejected', /nie potwierdził tego certyfikatu/],
    ['odpowiedź HTTP 400', new KsefApiError(400, 'private_schema.detail', 'KSeF API POST /auth failed: 400'), 'rejected', /nie potwierdził tego certyfikatu/],
  ])('odpowiedź KSeF: %s ma konkretny komunikat i nic nie zapisuje', async (_name, error, reason, message) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.ksefAuth.mockRejectedValue(error);

    const result = await uploadCertificateAction(pem);
    expect(result).toMatchObject({ success: false, reason, error: expect.stringMatching(message) });
    if (!result.success) expect(result.error).not.toContain('private_schema');
    expect(mocks.encrypt).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
    // Do limitu liczy się próba, która doszła do KSeF.
    expect(mocks.rateLimit).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });

  it('certyfikat bez uprawnień właścicielskich daje osobny komunikat', async () => {
    mocks.ksefAuth.mockResolvedValue(ksefSession(['InvoiceRead']));
    await expect(uploadCertificateAction(pem)).resolves.toMatchObject({
      success: false,
      reason: 'not_owner',
      error: expect.stringContaining('właściciel'),
    });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});

/**
 * Recenzja #361, pkt 3: wyjątek spoza KSeF dawał "KSeF nie potwierdził tego certyfikatu" i
 * w logu tylko `reason` z `code: null`, a błąd RPC i zewnętrzny catch nie logowały nic.
 * Teraz: osobny powód z komunikatem "to nie wina plików" i ślad z etapem, klasą błędu i kodem.
 * Treść wyjątku, klucz, hasło i certyfikat nigdy nie trafiają do logu.
 */
describe('błędy po naszej stronie: komunikat bez obwiniania certyfikatu i ślad w logu', () => {
  const SECRET = 'SEKRET-z-wyjatku';
  const protectedFiles = () => ({ certificate: pem.certificate, privateKey: encryptedKey(material.privateKey), password: PASSWORD });
  let log: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    log = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => log.mockRestore());

  /** Wszystko, co poszło do console.error, jako jeden tekst do sprawdzania wycieków. */
  const logged = () => JSON.stringify(log.mock.calls);

  it('wyjątek spoza KSeF: osobny powód, "to nie wina plików", spróbuj za chwilę, bez adresu pomocy', async () => {
    mocks.ksefAuth.mockRejectedValue(new TypeError(`Cannot read properties of undefined ${SECRET}`));

    const result = await uploadCertificateAction(protectedFiles());

    expect(result).toMatchObject({ success: false, reason: 'internal_error' });
    if (result.success) return;
    expect(result.error).toMatch(/nie wina Twoich plików/);
    expect(result.error).toMatch(/Spróbuj ponownie za chwilę/);
    expect(result.error).not.toMatch(/nie potwierdził tego certyfikatu/);
    expect(result.error).not.toContain('@');
    expect(result.error).not.toContain(SECRET);
    expect(mocks.encrypt).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('ślad w logu: etap, powód, klasa błędu i kod; bez treści wyjątku, klucza, hasła i certyfikatu', async () => {
    mocks.ksefAuth.mockRejectedValue(new TypeError(`${SECRET} ${PASSWORD} ${material.keyPem} ${material.certPem}`));

    await uploadCertificateAction(protectedFiles());

    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('[uploadCertificateAction]'),
      { stage: 'ksef_login', reason: 'internal_error', errorClass: 'TypeError', code: null },
    );
    const everything = logged();
    for (const secret of [SECRET, PASSWORD, material.keyPem.trim().split('\n')[1]!, material.certPem.trim().split('\n')[1]!]) {
      expect(everything).not.toContain(secret);
    }
  });

  it('odmowa KSeF: w logu kod, opis i szczegóły z odpowiedzi KSeF, ale nie to, co wysłaliśmy', async () => {
    mocks.ksefAuth.mockRejectedValue(
      new KsefAuthRejectedError(460, 'Uwierzytelnianie zakończone niepowodzeniem z powodu błędu certyfikatu', ['Certyfikat odwołany']),
    );

    await uploadCertificateAction(protectedFiles());

    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('[uploadCertificateAction]'),
      {
        stage: 'ksef_login',
        reason: 'revoked',
        errorClass: 'KsefAuthRejectedError',
        code: 460,
        description: 'Uwierzytelnianie zakończone niepowodzeniem z powodu błędu certyfikatu',
        details: ['Certyfikat odwołany'],
      },
    );
    expect(logged()).not.toContain(PASSWORD);
  });

  it('błąd zapisu (RPC): ślad z etapem i kodem, bez message, details i hint', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: 'PGRST202', message: `private_schema.${SECRET}`, details: SECRET, hint: SECRET },
    });

    const result = await uploadCertificateAction(pem);

    expect(result).toMatchObject({ success: false, reason: 'save_failed' });
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('[uploadCertificateAction]'),
      { stage: 'finalize_rpc', reason: 'save_failed', errorClass: 'object', code: 'PGRST202' },
    );
    expect(logged()).not.toContain(SECRET);
  });

  it('nierozpoznany wynik RPC: ślad z etapem, bez udawania sukcesu', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: 'zupelnie_nowy_wynik', error: null });

    await expect(uploadCertificateAction(pem)).resolves.toMatchObject({ success: false, reason: 'save_failed' });
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('[uploadCertificateAction]'),
      { stage: 'finalize_rpc', reason: 'save_failed', result: 'zupelnie_nowy_wynik' },
    );
  });

  it('nieoczekiwany wyjątek poza KSeF (zewnętrzny catch): ślad z klasą błędu, bez treści', async () => {
    mocks.encrypt.mockImplementation(() => {
      throw new RangeError(`klucz szyfrowania: ${SECRET}`);
    });

    await expect(uploadCertificateAction(pem)).resolves.toMatchObject({ success: false, reason: 'save_failed' });
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('[uploadCertificateAction]'),
      { stage: 'unexpected', reason: 'save_failed', errorClass: 'RangeError', code: null },
    );
    expect(logged()).not.toContain(SECRET);
  });

  it('brak bezpiecznie skonfigurowanego KSEF_ENV: ślad w logu (to błąd po naszej stronie)', async () => {
    vi.stubEnv('KSEF_ENV', 'unknown');

    await expect(uploadCertificateAction(pem)).resolves.toMatchObject({ success: false, reason: 'save_failed' });
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('[uploadCertificateAction]'),
      { stage: 'environment', reason: 'save_failed' },
    );
  });

  it('porażki z winy klienta (zły plik, hasło, uprawnienia) nie wchodzą do logu błędów', async () => {
    await uploadCertificateAction({ certificate: pem.certificate, privateKey: b64('to nie jest klucz') });
    mocks.membershipResult.mockResolvedValue({ data: { role: 'member', status: 'active' }, error: null });
    await uploadCertificateAction(pem);

    expect(log).not.toHaveBeenCalled();
  });
});

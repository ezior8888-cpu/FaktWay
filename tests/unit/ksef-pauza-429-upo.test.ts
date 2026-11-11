import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSelfSignedCertificate } from '../helpers/self-signed-cert';

/**
 * L1a (plan „zero zgubionych faktur”, 08.11.2026), zakres UPO: pauza firmy
 * po 429 w kliencie UPO (`lib/ksef/upo-client.ts`).
 *
 * Samo żądanie UPO idzie surowym `fetch` (XML), z pominięciem `ksefFetch`,
 * więc bramka pauzy klienta KSeF go nie obejmuje: przy sesji w pamięci (bez
 * logowania) UPO firmy w pauzie wychodziło do KSeF i wydłużało blokadę MF.
 * 429 przy logowaniu w `getSession` kończył się błędem ostatecznym „sprawdź
 * certyfikat”, a 429 z samego UPO nie zapisywał pauzy firmy.
 *
 * Atrapa KSeF to `fetch`: prawdziwe `ksefFetch`, logowanie tokenem
 * (szyfrowanie kluczem z certyfikatu atrapy), pamięć sesji i kolejka per NIP.
 * Atrapa bazy: tylko poświadczenia firmy.
 */

const NIP_A = '1234567890';
const NIP_B = '1234567891';
const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SESJA = '20261109-SO-0000000000-0000000000-01';
const NUMER_A = '1234567890-20261109-0100A0B0C0D0-1A';
const NUMER_B = '1234567891-20261109-0100A0B0C0D0-1B';
const OPCJE = { env: 'test' as const, sessionReferenceNumber: SESJA };

vi.mock('@/lib/supabase/admin-queries', () => ({
  getTenantKsefCredentials: async (tenantId: string) =>
    ({ type: 'token', nip: tenantId === TENANT_B ? NIP_B : NIP_A, token: 'token-testowy' }),
}));
vi.mock('@/lib/audit/log-system', () => ({ logAuditSystem: vi.fn() }));

import { KsefApiError, ksefFetch } from '@/lib/ksef/client';
import { ksefPausedUntil } from '@/lib/ksef/rate-limit-pause';
import { ksefRateLimiter } from '@/lib/ksef/rate-limiter';
import { ksefSessionCache } from '@/lib/ksef/session-cache';
import { downloadUpoFromKsef, type UpoDownloadResponse } from '@/lib/ksef/upo-client';

/** Klucz publiczny „MF” z atrapy: logowanie tokenem szyfruje nim token. */
const KLUCZ_MF = makeSelfSignedCertificate({ kind: 'rsa', nip: NIP_A });

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** Zwykły przebieg KSeF: logowanie tokenem i UPO z zasobów sesji. */
function zwyklaOdpowiedz(path: string): Response {
  const later = new Date(Date.now() + 3_600_000).toISOString();
  if (path.endsWith('/security/public-key-certificates')) {
    return json(200, [{
      certificate: KLUCZ_MF.certDer.toString('base64'),
      usage: ['KsefTokenEncryption', 'SymmetricKeyEncryption'],
      validFrom: '2026-01-01T00:00:00Z',
      validTo: later,
    }]);
  }
  if (path.endsWith('/auth/challenge')) {
    return json(200, { challenge: 'CH-1', timestamp: new Date().toISOString(), timestampMs: Date.now(), clientIp: '127.0.0.1' });
  }
  if (path.endsWith('/auth/ksef-token')) {
    return json(202, { referenceNumber: 'AUTH-1', authenticationToken: { token: 'auth-token', validUntil: later } });
  }
  if (path.endsWith('/auth/AUTH-1')) return json(200, { status: { code: 200, description: 'Uwierzytelnianie zakończone sukcesem' } });
  if (path.endsWith('/auth/token/redeem')) {
    return json(200, { accessToken: { token: 'access', validUntil: later }, refreshToken: { token: 'refresh', validUntil: later } });
  }
  if (path.endsWith('/upo')) {
    return new Response('<UPO><NumerUPO>UPO-1</NumerUPO></UPO>', { status: 200, headers: { 'content-type': 'application/xml' } });
  }
  return json(503, { message: 'atrapa: nieznana ścieżka' });
}

const atrapa = {
  calls: [] as string[],
  /** Odpowiedź inna niż zwykła dla wybranej ścieżki; `null` = zwykły przebieg. */
  override: null as null | ((path: string) => Response | null | Promise<Response | null>),
};
const upoCalls = () => atrapa.calls.filter((path) => path.endsWith('/upo'));
const limit = (retryAfterSeconds: string) => json(429, { message: 'atrapa: limit' }, { 'retry-after': retryAfterSeconds });

/** Inne żądanie firmy (np. skrzynka) idzie prawdziwą ścieżką: kolejka firmy + `ksefFetch`. */
const zapytanieSkrzynki = (nip: string) =>
  ksefRateLimiter.enqueue(nip, () => ksefFetch('/invoices/query/metadata', { method: 'POST', env: 'test' }));

function pauza(wynik: UpoDownloadResponse): { retryAfterMs?: number; error: string } {
  expect(wynik).toMatchObject({ success: false, retryable: true, errorCode: 'KSEF_RATE_LIMIT_PAUSE' });
  if (wynik.success) throw new Error('oczekiwana pauza');
  return wynik;
}

beforeEach(() => {
  vi.stubEnv('KSEF_ENV', 'test');
  atrapa.calls = [];
  atrapa.override = null;
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
    const path = new URL(String(input)).pathname;
    atrapa.calls.push(path);
    return (await atrapa.override?.(path)) ?? zwyklaOdpowiedz(path);
  }));
  ksefSessionCache.invalidate(NIP_A, 'test');
  ksefSessionCache.invalidate(NIP_B, 'test');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('UPO w pauzie firmy po 429 (L1a)', () => {
  it('429 przy logowaniu w getSession: wynik do ponowienia z kodem pauzy (nie „sprawdź certyfikat”), bez żądania UPO', async () => {
    atrapa.override = (path) => (path.endsWith('/auth/challenge') ? limit('45') : null);

    const wynik = pauza(await downloadUpoFromKsef(TENANT_A, NUMER_A, OPCJE));
    expect(wynik.retryAfterMs).toBeGreaterThan(40_000);
    expect(wynik.retryAfterMs).toBeLessThanOrEqual(45_000);
    expect(wynik.error).not.toContain('certyfikat');
    expect(upoCalls()).toHaveLength(0);
    // Pauzę zapisał `ksefFetch` przy logowaniu (kontekst NIP z `getSession`).
    expect(await ksefPausedUntil('test', NIP_A)).not.toBeNull();

    // Kolejne pobranie w pauzie: ani logowania, ani UPO.
    const przed = atrapa.calls.length;
    pauza(await downloadUpoFromKsef(TENANT_A, NUMER_A, OPCJE));
    expect(atrapa.calls).toHaveLength(przed);
  });

  it('sesja w pamięci i pauza firmy: brak GET …/upo (żądanie UPO omija ksefFetch), druga firma pobiera od razu', async () => {
    await expect(downloadUpoFromKsef(TENANT_A, NUMER_A, OPCJE)).resolves.toMatchObject({ success: true });
    expect(upoCalls()).toHaveLength(1);

    // Inne żądanie firmy A dostaje 429 z KSeF — pauza firmy.
    atrapa.override = (path) => (path.endsWith('/invoices/query/metadata') ? limit('30') : null);
    const odmowa = await zapytanieSkrzynki(NIP_A).catch((e: unknown) => e);
    expect(odmowa).toBeInstanceOf(KsefApiError);
    expect((odmowa as KsefApiError).status).toBe(429);

    // Sesja firmy A jest w pamięci, więc `getSession` nie pyta KSeF; bez
    // sprawdzenia pauzy w kliencie UPO poszłoby surowe GET …/upo.
    const przed = atrapa.calls.length;
    pauza(await downloadUpoFromKsef(TENANT_A, NUMER_A, OPCJE));
    expect(atrapa.calls).toHaveLength(przed);
    expect(upoCalls()).toHaveLength(1);

    // Firma B w tym samym czasie: UPO bez czekania na pauzę firmy A.
    await expect(downloadUpoFromKsef(TENANT_B, NUMER_B, OPCJE)).resolves.toMatchObject({ success: true });
    expect(upoCalls()).toHaveLength(2);
  });

  it('pauza zapisana w trakcie logowania (inne żądanie firmy dostało 429): drugi odczyt pauzy tuż przed żądaniem UPO', async () => {
    atrapa.override = async (path) => {
      if (path.endsWith('/invoices/query/metadata')) return limit('30');
      if (path.endsWith('/auth/token/redeem')) {
        // Zanim KSeF wyda tokeny, inne zadanie tej firmy dostaje 429.
        await zapytanieSkrzynki(NIP_A).catch(() => undefined);
      }
      return null;
    };

    pauza(await downloadUpoFromKsef(TENANT_A, NUMER_A, OPCJE));
    expect(atrapa.calls.some((path) => path.endsWith('/auth/token/redeem'))).toBe(true);
    expect(upoCalls()).toHaveLength(0);
  });

  it('prawdziwy 429 z żądania UPO: pauza firmy na pełny Retry-After (bez obcięcia do godziny), następne UPO czeka bez żądania', async () => {
    atrapa.override = (path) => (path.endsWith('/upo') ? limit('7200') : null);
    const start = Date.now();

    const wynik = await downloadUpoFromKsef(TENANT_A, NUMER_A, OPCJE);
    // Klasyfikacja samego 429 z UPO bez zmian (błąd ostateczny HTTP_429):
    // zmienia ją sesja D1 planu „zero zgubionych faktur”, nie L1a.
    expect(wynik).toMatchObject({ success: false, errorCode: 'HTTP_429', retryable: false });
    const until = await ksefPausedUntil('test', NIP_A);
    expect(until).not.toBeNull();
    expect(until!).toBeGreaterThanOrEqual(start + 7_200_000);

    const przed = atrapa.calls.length;
    const kolejne = pauza(await downloadUpoFromKsef(TENANT_A, NUMER_A, OPCJE));
    expect(kolejne.retryAfterMs).toBeGreaterThan(7_100_000);
    expect(atrapa.calls).toHaveLength(przed);
  });
});

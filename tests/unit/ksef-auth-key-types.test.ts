import { DOMParser } from '@xmldom/xmldom';
import * as xadesjs from 'xadesjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSelfSignedCertificate, type TestKeyKind } from '../helpers/self-signed-cert';

/**
 * Logowanie do KSeF podpisem XAdES musi działać dla obu rodzajów kluczy, które
 * dopuszcza MF: RSA 2048 i EC P-256 (zalecany, a klienci dostają go z Aplikacji
 * Podatnika). Test idzie prawdziwą ścieżką `authenticateWithXades`: mockowany
 * jest tylko HTTP, a podpis z wysłanego żądania sprawdza biblioteka XML-DSig.
 */

const mocks = vi.hoisted(() => ({ ksefFetch: vi.fn() }));
vi.mock('@/lib/ksef/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ksef/client')>()),
  ksefFetch: mocks.ksefFetch,
}));

import { KsefApiError } from '@/lib/ksef/client';

import { authenticateWithXades } from '@/lib/ksef/auth';

const DSIG = 'http://www.w3.org/2000/09/xmldsig#';
const inOneHour = () => new Date(Date.now() + 3600_000).toISOString();

let posted = '';

beforeEach(() => {
  posted = '';
  mocks.ksefFetch.mockReset();
  // Jak prawdziwy KSeF (OpenAPI): status i wymiana tokenu wymagają Bearer = authenticationToken
  // z odpowiedzi na wysłanie podpisu, a odpowiedź ze statusem nie niesie żadnego tokenu.
  // Prawdziwy przebieg na KSeF TEST (02.11.2026) pokazał 401 przy odpytywaniu statusu bez niego.
  const unauthorized = () => new KsefApiError(401, 'Wymagane jest uwierzytelnienie.', 'KSeF API failed: 401');
  mocks.ksefFetch.mockImplementation(async (path: string, init?: { body?: string; accessToken?: string }) => {
    if (path === '/auth/challenge') return { challenge: 'challenge-1', timestamp: inOneHour(), clientIp: '203.0.113.7' };
    if (path === '/auth/xades-signature') {
      posted = String(init?.body ?? '');
      return { referenceNumber: 'ref-1', authenticationToken: { token: 'auth', validUntil: inOneHour() } };
    }
    if (path === '/auth/ref-1') {
      if (init?.accessToken !== 'auth') throw unauthorized();
      return { status: { code: 200, description: 'Uwierzytelnianie zakończone sukcesem' } };
    }
    if (path === '/auth/token/redeem') {
      if (init?.accessToken !== 'auth') throw unauthorized();
      return { accessToken: { token: 'access', validUntil: inOneHour() }, refreshToken: { token: 'refresh', validUntil: inOneHour() } };
    }
    throw new Error(`Unexpected KSeF path ${path}`);
  });
});

describe('podpis XAdES logowania do KSeF', () => {
  it.each<[TestKeyKind, string, number]>([
    ['rsa', 'rsa-sha256', 256],
    ['ec', 'ecdsa-sha256', 64],
  ])('podpisuje kluczem %s algorytmem %s, a podpis się weryfikuje', async (kind, algorithm, signatureBytes) => {
    const material = makeSelfSignedCertificate({ kind, nip: '1234567890' });

    const session = await authenticateWithXades(
      { type: 'xades', nip: '1234567890', certificatePem: material.certPem, privateKeyPem: material.keyPem },
      'test',
    );

    expect(session.accessToken).toBe('access');
    const doc = new DOMParser().parseFromString(posted, 'application/xml');
    const signature = doc.getElementsByTagNameNS(DSIG, 'Signature')[0]!;
    const method = doc.getElementsByTagNameNS(DSIG, 'SignatureMethod')[0]!.getAttribute('Algorithm');
    expect(method).toContain(algorithm);

    // ECDSA w XML-DSig to R||S (64 bajty dla P-256), nie DER; RSA-2048 daje 256 bajtów.
    const value = doc.getElementsByTagNameNS(DSIG, 'SignatureValue')[0]!.textContent!.replace(/\s/g, '');
    expect(Buffer.from(value, 'base64').length).toBe(signatureBytes);

    const signed = new xadesjs.SignedXml(doc as unknown as Document);
    signed.LoadXml(signature as unknown as Element);
    await expect(signed.Verify()).resolves.toBe(true);
  });
});

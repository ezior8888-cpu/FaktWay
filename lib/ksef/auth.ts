import { createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Crypto } from '@peculiar/webcrypto';
import * as xadesjs from 'xadesjs';
import * as XmlCore from 'xml-core';
import { DOMParser, XMLSerializer, DOMImplementation } from '@xmldom/xmldom';
import { isSensitiveDebugAllowed } from '@/lib/security/debug';
import { KsefAuthRejectedError } from './auth-errors';
import { ksefFetch } from './client';
import { ksefNumericStatusCode } from './normalize-status-code';
import type {
  AuthChallengeResponse,
  AuthTokenResponse,
  AuthStatusResponse,
  AccessTokenResponse,
  KsefEnvironment,
} from '@/types/ksef';

// Jednorazowa konfiguracja xadesjs dla Node.js:
// 1. WebCrypto polyfill (do kryptografii)
// 2. DOMParser/XMLSerializer (xml-core nie potrafi sam ich zaimportować)
xadesjs.Application.setEngine('NodeJS', new Crypto());
(XmlCore as unknown as {
  setNodeDependencies: (deps: Record<string, unknown>) => void;
}).setNodeDependencies({
  DOMParser,
  XMLSerializer,
  DOMImplementation: new DOMImplementation(),
});

export interface KsefXadesCredentials {
  /** Discriminator dla KsefAuth union. */
  type: 'xades';
  /** NIP kontekstu (firmy, dla której robimy operacje) */
  nip: string;
  /** PEM-encoded certyfikat (np. odczytany z test-cert.pem) */
  certificatePem: string;
  /** PEM-encoded klucz prywatny (np. odczytany z test-key.pem) */
  privateKeyPem: string;
}

/**
 * @deprecated Używaj `KsefXadesCredentials` (nazwa wprowadza discriminator)
 * lub `KsefAuth` (union token+cert). Alias zachowany dla backward compat.
 */
export type KsefCredentials = KsefXadesCredentials;

/**
 * Unia wszystkich sposobów uwierzytelnienia do KSeF 2.0.
 * Zaimportuj też `KsefTokenCredentials` z `./auth-token` dla wariantu tokenowego.
 *
 * Discriminator `type` jest obowiązkowy - TS wymusi explicit wybór sposobu auth.
 */
export type KsefAuth = KsefXadesCredentials | import('./auth-token').KsefTokenCredentials;

export interface KsefAuthSession {
  /** Access token do wywołań API (bearer) */
  accessToken: string;
  /** Refresh token do odnowienia dostępu */
  refreshToken: string;
  /** Kiedy accessToken wygasa (timestamp) */
  accessTokenExpiresAt: number;
  /** Kiedy refreshToken wygasa (timestamp) */
  refreshTokenExpiresAt: number;
  /** NIP kontekstu */
  nip: string;
}

export { KsefAuthRejectedError };

/**
 * Klucz do podpisu i algorytm wynikają z samego klucza: RSA (2048+) podpisuje
 * RSASSA-PKCS1-v1_5/SHA-256, EC P-256 (zalecany przez MF i dawany klientom przez
 * Aplikację Podatnika) podpisuje ECDSA/SHA-256 w układzie R||S, jak chce XML-DSig.
 * PKCS#8 DER bierzemy z `node:crypto`, więc zapis klucza (PKCS#1, SEC1, PKCS#8)
 * nie ma znaczenia. Zapisane wcześniej poświadczenia RSA działają bez zmian.
 */
async function importSigningKey(privateKeyPem: string): Promise<{
  key: CryptoKey;
  signatureAlgorithm: Algorithm | EcdsaParams;
}> {
  const keyObject = createPrivateKey(privateKeyPem);
  const pkcs8 = keyObject.export({ type: 'pkcs8', format: 'der' });
  const keyData = pkcs8.buffer.slice(pkcs8.byteOffset, pkcs8.byteOffset + pkcs8.byteLength) as ArrayBuffer;
  const subtle = xadesjs.Application.crypto.subtle;

  if (keyObject.asymmetricKeyType === 'rsa') {
    return {
      key: await subtle.importKey('pkcs8', keyData, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']),
      signatureAlgorithm: { name: 'RSASSA-PKCS1-v1_5' },
    };
  }
  if (keyObject.asymmetricKeyType === 'ec' && keyObject.asymmetricKeyDetails?.namedCurve === 'prime256v1') {
    return {
      key: await subtle.importKey('pkcs8', keyData, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']),
      signatureAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
    };
  }
  throw new Error('Nieobsługiwany rodzaj klucza do podpisu KSeF (dozwolone: RSA 2048 i EC P-256)');
}

/**
 * Wyciąga ciało certyfikatu jako czysty base64 (bez headers, bez whitespace).
 * Używane dla <X509Certificate> i xades:SigningCertificate.
 */
function certPemToBase64(pem: string): string {
  return pem
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s/g, '');
}

/**
 * Krok 1: pobierz challenge od KSeF.
 */
async function fetchChallenge(env?: KsefEnvironment): Promise<AuthChallengeResponse> {
  return ksefFetch<AuthChallengeResponse>('/auth/challenge', {
    method: 'POST',
    env,
  });
}

/**
 * Krok 2-3: zbuduj XML AuthTokenRequest i podpisz go profilem XAdES-BES.
 *
 * Różnica vs zwykły XML-DSig:
 * - dorzuca <xades:QualifyingProperties> z SigningTime i SigningCertificate
 * - dodaje drugą <ds:Reference> wskazującą na SignedProperties
 * - wymagane przez KSeF 2.0 (profil zgodny z ETSI TS 101 903)
 */
async function buildSignedAuthXml(
  challenge: AuthChallengeResponse,
  credentials: KsefCredentials
): Promise<string> {
  const { nip, certificatePem, privateKeyPem } = credentials;

  const ksefNamespace = 'http://ksef.mf.gov.pl/auth/token/2.0';

  // KSeF 2.0 struktura (różna od 1.0):
  // - brak atrybutu Id na root
  // - ContextIdentifier ma bezpośrednio <Nip>/<InternalId>/<NipVatUe>/<PeppolId>
  const unsignedXml = `<?xml version="1.0" encoding="UTF-8"?>
<ns3:AuthTokenRequest xmlns:ns3="${ksefNamespace}">
  <ns3:Challenge>${challenge.challenge}</ns3:Challenge>
  <ns3:ContextIdentifier>
    <ns3:Nip>${nip}</ns3:Nip>
  </ns3:ContextIdentifier>
  <ns3:SubjectIdentifierType>certificateSubject</ns3:SubjectIdentifierType>
  <ns3:AuthorizationPolicy>
    <ns3:AllowedIps>
      <ns3:Ip4Address>${challenge.clientIp}</ns3:Ip4Address>
    </ns3:AllowedIps>
  </ns3:AuthorizationPolicy>
</ns3:AuthTokenRequest>`;

  const doc = new DOMParser().parseFromString(unsignedXml, 'application/xml');

  // Import prywatnego klucza do WebCrypto (RSA albo EC P-256, zob. wyżej)
  const { key: privateKey, signatureAlgorithm } = await importSigningKey(privateKeyPem);

  const certBase64 = certPemToBase64(certificatePem);

  // Podpisanie XAdES-BES
  const signedXml = new xadesjs.SignedXml();
  const signature = await signedXml.Sign(
    signatureAlgorithm,
    privateKey,
    doc as unknown as Document,
    {
      references: [
        {
          hash: 'SHA-256',
          transforms: ['enveloped', 'exc-c14n'],
          // Pusty URI = "cały dokument bez <ds:Signature>" (enveloped transform).
          // KSeF 2.0 tak to interpretuje; unikamy atrybutu Id niezadeklarowanego w XSD.
          uri: '',
        },
      ],
      x509: [certBase64],
      signingCertificate: certBase64,
    }
  );

  // Dokleić <ds:Signature> do korzenia AuthTokenRequest
  const sigElement = signature.GetXml();
  if (!sigElement) {
    throw new Error('xadesjs: nie udało się wygenerować elementu podpisu');
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  doc.documentElement!.appendChild(sigElement as any);

  const serialized = new XMLSerializer().serializeToString(doc);

  // DEBUG: loguj podpisany XML jeśli DEBUG_KSEF=1.
  // SEC-4: dodatkowo NIGDY na produkcji — podpisany XML to materiał
  // kryptograficzny (token autoryzacyjny KSeF), nie może trafić do logów prod
  // nawet przez pomyłkowe ustawienie flagi debug.
  if (process.env.DEBUG_KSEF === '1' && isSensitiveDebugAllowed()) {
    console.log('\n--- PODPISANY XML ---\n' + serialized + '\n--- KONIEC ---\n');
  }

  return serialized;
}

/**
 * Krok 4: wyślij podpisany XML do KSeF.
 */
async function submitSignedAuth(
  signedXml: string,
  env?: KsefEnvironment
): Promise<AuthTokenResponse> {
  return ksefFetch<AuthTokenResponse>('/auth/xades-signature', {
    method: 'POST',
    headers: {
      // KSeF 2.0 wymaga tego konkretnego mediatype dla podpisanego XAdES
      'Content-Type': 'application/xades+xml',
    },
    body: signedXml, // raw XML body, ksefFetch nie robi JSON.stringify na stringach
    env,
  });
}

/**
 * Krok 5: polling statusu żądania uwierzytelniania. Status wymaga nagłówka
 * Authorization z `authenticationToken` z odpowiedzi na wysłanie podpisu
 * (OpenAPI KSeF 2.0: GET /auth/{referenceNumber}, schemat Bearer). Bez niego
 * KSeF zwraca 401, co wyszło dopiero na pierwszym prawdziwym przebiegu na KSeF TEST.
 */
async function pollAuthStatus(
  referenceNumber: string,
  authenticationToken: string,
  env?: KsefEnvironment,
  maxAttempts = 20,
  intervalMs = 1000
): Promise<AuthStatusResponse> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const status = await ksefFetch<AuthStatusResponse>(`/auth/${referenceNumber}`, {
      accessToken: authenticationToken,
      env,
    });

    // Kody statusu KSeF:
    // 100 - w trakcie
    // 200 - zaakceptowane
    // 400 - odrzucone
    const code = ksefNumericStatusCode(status.status?.code);
    if (code === 200) return status;
    if (Number.isFinite(code) && code >= 400) {
      throw new KsefAuthRejectedError(code, status.status.description, status.status.details ?? []);
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`KSeF auth polling timed out after ${maxAttempts} attempts`);
}

/**
 * Krok 6: wymień authenticationToken na accessToken.
 */
async function redeemAuthToken(
  authenticationToken: string,
  env?: KsefEnvironment
): Promise<AccessTokenResponse> {
  return ksefFetch<AccessTokenResponse>('/auth/token/redeem', {
    method: 'POST',
    accessToken: authenticationToken,
    env,
  });
}

/**
 * GŁÓWNA FUNKCJA: pełny flow autentykacji XAdES.
 * Zwraca gotową sesję do robienia kolejnych wywołań.
 */
export async function authenticateWithXades(
  credentials: KsefCredentials,
  env?: KsefEnvironment
): Promise<KsefAuthSession> {
  // 1. Challenge
  const challenge = await fetchChallenge(env);

  // 2. Podpisany XML (XAdES-BES)
  const signedXml = await buildSignedAuthXml(challenge, credentials);

  // 3. Submit: odpowiedź niesie numer referencyjny i token operacji (do statusu i do wymiany)
  const { referenceNumber, authenticationToken } = await submitSignedAuth(signedXml, env);

  // 4. Polling statusu tym tokenem
  await pollAuthStatus(referenceNumber, authenticationToken.token, env);

  // 5. Redeem -> accessToken (tym samym tokenem operacji; odpowiedź ze statusem go nie zawiera)
  const tokens = await redeemAuthToken(authenticationToken.token, env);

  return {
    accessToken: tokens.accessToken.token,
    refreshToken: tokens.refreshToken.token,
    accessTokenExpiresAt: new Date(tokens.accessToken.validUntil).getTime(),
    refreshTokenExpiresAt: new Date(tokens.refreshToken.validUntil).getTime(),
    nip: credentials.nip,
  };
}

/**
 * Helper: ładowanie credentials z plików PEM (dev / test).
 * W produkcji credentials pochodzą z tabeli tenants (zaszyfrowane w bazie).
 */
export function loadCredentialsFromFiles(
  nip: string,
  certPath: string,
  keyPath: string
): KsefXadesCredentials {
  return {
    type: 'xades',
    nip,
    certificatePem: readFileSync(certPath, 'utf8'),
    privateKeyPem: readFileSync(keyPath, 'utf8'),
  };
}

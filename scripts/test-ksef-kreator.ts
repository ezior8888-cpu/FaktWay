/**
 * Prawdziwe logowanie na KSeF TEST z kluczami RSA i EC, zwykłymi i zaszyfrowanymi
 * hasłem, w PEM i DER: ta sama droga co akcja kreatora podłączenia KSeF
 * (`prepareKsefCredentials` -> `authenticateWithXades` -> `hasFreshKsefOwnerProof`),
 * tylko bez bazy i bez logowania do FaktWay.
 *
 * Uruchom (bez sekretów, wszystko powstaje w locie):
 *   pnpm tsx scripts/test-ksef-kreator.ts
 *
 * Co robi i czego NIE robi:
 * - rozmawia wyłącznie z https://api-test.ksef.mf.gov.pl/v2 (środowisko TEST dopuszcza
 *   certyfikaty samopodpisane; dokumentacja MF: srodowiska.md, uwierzytelnianie.md),
 *   a przy `KSEF_ENV=production` odmawia startu,
 * - używa losowych, fikcyjnych NIP-ów z poprawną sumą kontrolną, nigdy prawdziwych,
 * - klucze i certyfikaty generuje w pamięci, nic nie zapisuje na dysku ani w repo.
 *
 * Opcjonalnie: KSEF_KREATOR_SUBJECT=person, żeby podmiot certyfikatu był osobą (serialNumber
 * TINPL-NIP) zamiast pieczęci firmowej (organizationIdentifier VATPL-NIP).
 */

import { randomInt } from 'node:crypto';

import { authenticateWithXades } from '../lib/ksef/auth';
import { KsefAuthRejectedError } from '../lib/ksef/auth-errors';
import { getKsefBaseUrl, KsefApiError } from '../lib/ksef/client';
import { prepareKsefCredentials } from '../lib/ksef/connect-credentials';
import { classifyKsefAuthFailure, ksefFailureMessage } from '../lib/ksef/connect-messages';
import { hasFreshKsefOwnerProof } from '../lib/ksef/owner-claim';
import { makeSelfSignedCertificate, type TestKeyKind } from '../tests/helpers/self-signed-cert';

const PASSWORD = 'Testowe-Haslo-123!';
const SUBJECT = process.env.KSEF_KREATOR_SUBJECT === 'person' ? 'person' : 'seal';

interface Case {
  label: string;
  kind: TestKeyKind;
  encrypted: boolean;
  der: boolean;
  /** Kontekst (NIP firmy) inny niż NIP z certyfikatu: kontrola, że brak uprawnień daje 415. */
  foreignContext?: boolean;
}

const CASES: Case[] = [
  { label: 'RSA 2048, PEM bez hasła', kind: 'rsa', encrypted: false, der: false },
  { label: 'EC P-256, PEM bez hasła', kind: 'ec', encrypted: false, der: false },
  { label: 'RSA 2048, PEM z hasłem', kind: 'rsa', encrypted: true, der: false },
  { label: 'EC P-256, PEM z hasłem', kind: 'ec', encrypted: true, der: false },
  { label: 'EC P-256, DER z hasłem', kind: 'ec', encrypted: true, der: true },
  { label: 'EC P-256, DER bez hasła', kind: 'ec', encrypted: false, der: true },
  { label: 'EC P-256, certyfikat innego NIP-u niż kontekst (oczekiwane odrzucenie)', kind: 'ec', encrypted: false, der: false, foreignContext: true },
];

/** Fikcyjny NIP z poprawną sumą kontrolną (wagi 6,5,7,2,3,4,5,6,7, modulo 11). */
function fictionalNip(): string {
  const weights = [6, 5, 7, 2, 3, 4, 5, 6, 7];
  for (;;) {
    const digits = Array.from({ length: 9 }, (_, i) => randomInt(i === 0 ? 1 : 0, 10));
    const control = digits.reduce((sum, digit, i) => sum + digit * weights[i]!, 0) % 11;
    if (control !== 10) return `${digits.join('')}${control}`;
  }
}

function jwtClaims(token: string): Record<string, unknown> {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

interface Outcome {
  label: string;
  expectedFailure: boolean;
  passed: boolean;
}

async function runCase(testCase: Case): Promise<Outcome> {
  const startedAt = Date.now();
  const nip = fictionalNip();
  const contextNip = testCase.foreignContext ? fictionalNip() : nip;
  const material = makeSelfSignedCertificate({ kind: testCase.kind, nip, subject: SUBJECT });

  const key = testCase.encrypted
    ? testCase.der
      ? material.privateKey.export({ type: 'pkcs8', format: 'der', cipher: 'aes-256-cbc', passphrase: PASSWORD })
      : Buffer.from(material.privateKey.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: PASSWORD }))
    : testCase.der
      ? material.privateKey.export({ type: 'pkcs8', format: 'der' })
      : Buffer.from(material.keyPem);
  const certificate = testCase.der ? material.certDer : Buffer.from(material.certPem);

  console.log(`\n--- ${testCase.label}`);
  console.log(`    NIP certyfikatu ${nip}, kontekst ${contextNip}, podmiot: ${SUBJECT === 'person' ? 'osoba (TINPL)' : 'pieczęć firmowa (VATPL)'}`);

  const prepared = prepareKsefCredentials({
    certificate,
    privateKey: key,
    password: testCase.encrypted ? PASSWORD : undefined,
  });
  if (!prepared.ok) {
    console.log(`[FAIL] sprawdzenie lokalne: ${prepared.problem}`);
    return { label: testCase.label, expectedFailure: Boolean(testCase.foreignContext), passed: false };
  }
  console.log(`    lokalnie OK: klucz ${prepared.keyKind}, do bazy poszedłby PKCS#8 bez hasła, certyfikat ważny do ${prepared.validTo.toISOString()}`);

  try {
    const session = await authenticateWithXades(
      { type: 'xades', nip: contextNip, certificatePem: prepared.certificatePem, privateKeyPem: prepared.privateKeyPem },
      'test',
    );
    const claims = jwtClaims(session.accessToken);
    const owner = hasFreshKsefOwnerProof(session, contextNip);
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`[${testCase.foreignContext ? 'FAIL' : 'PASS'}] KSeF TEST wydał sesję w ${seconds}s, uprawnienia (per): ${JSON.stringify(claims.per)}, Owner: ${owner}`);
    return { label: testCase.label, expectedFailure: Boolean(testCase.foreignContext), passed: !testCase.foreignContext && owner };
  } catch (error) {
    const reason = classifyKsefAuthFailure(error);
    if (error instanceof KsefAuthRejectedError) {
      console.log(`    KSeF TEST odrzucił: kod ${error.code}, opis "${error.description}", szczegóły ${JSON.stringify(error.details)}`);
    } else if (error instanceof KsefApiError) {
      console.log(`    KSeF TEST odpowiedział HTTP ${error.status}: ${JSON.stringify(error.body).slice(0, 400)}`);
    } else {
      console.log(`    błąd: ${error instanceof Error ? error.message : String(error)}`);
    }
    console.log(`    powód dla kreatora: ${reason}`);
    console.log(`    komunikat dla klienta: ${ksefFailureMessage(reason, { nip: contextNip, env: 'test' })}`);
    console.log(`[${testCase.foreignContext ? 'PASS' : 'FAIL'}] ${testCase.foreignContext ? 'odrzucenie zgodne z oczekiwaniem' : 'logowanie nie powiodło się'}`);
    return { label: testCase.label, expectedFailure: Boolean(testCase.foreignContext), passed: Boolean(testCase.foreignContext) };
  }
}

async function main() {
  if (process.env.KSEF_ENV === 'production') {
    console.error('Odmowa: ten skrypt rozmawia tylko z KSeF TEST (KSEF_ENV=production jest ustawione).');
    process.exit(2);
  }
  const base = getKsefBaseUrl('test');
  if (base !== 'https://api-test.ksef.mf.gov.pl/v2') {
    console.error(`Odmowa: oczekiwano oficjalnego adresu KSeF TEST, jest ${base}.`);
    process.exit(2);
  }
  console.log(`=== KSeF TEST: logowanie kluczami RSA i EC (kreator podłączenia) ===\n${base}\n${new Date().toISOString()}`);

  const outcomes: Outcome[] = [];
  for (const testCase of CASES) outcomes.push(await runCase(testCase));

  console.log('\n=== Podsumowanie ===');
  for (const outcome of outcomes) console.log(`${outcome.passed ? 'PASS' : 'FAIL'}  ${outcome.label}`);
  process.exit(outcomes.every((outcome) => outcome.passed) ? 0 : 1);
}

void main();

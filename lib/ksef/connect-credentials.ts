import { X509Certificate, createPrivateKey, type KeyObject } from 'node:crypto';

import {
  certificateKeyUsage,
  classifyKsefFile,
  isCertificateBlock,
  isPrivateKeyBlock,
  pemBlocks,
  readTlv,
  tlvChildren,
  type PemBlock,
  type Tlv,
} from './certificate-files';

/**
 * Sprawdzenia lokalne PRZED wywołaniem KSeF: każda porażka ma własny powód,
 * z którego kreator robi konkretny komunikat (zob. `connect-messages.ts`).
 * Do bazy trafia wyłącznie wynik tej funkcji: certyfikat w PEM i klucz
 * w PKCS#8 BEZ hasła (potem szyfrowany `encryptCredentials`). Hasło żyje tylko
 * w tym wywołaniu: nie wraca w wyniku, nie trafia do logów ani do audytu.
 */

export type CredentialProblem =
  | 'cert_unreadable'
  | 'key_unreadable'
  | 'password_required'
  | 'password_wrong'
  | 'key_unsupported'
  | 'key_mismatch'
  | 'cert_expired'
  | 'cert_not_yet_valid'
  | 'cert_offline';

export type PreparedCredentials =
  | {
      ok: true;
      certificatePem: string;
      privateKeyPem: string;
      keyKind: 'rsa' | 'ec';
      validFrom: Date;
      validTo: Date;
    }
  | { ok: false; problem: CredentialProblem; validTo?: Date; validFrom?: Date };

interface PrepareInput {
  certificate: Buffer;
  privateKey: Buffer;
  password?: string;
}

const MIN_RSA_BITS = 2048;
const EC_CURVE = 'prime256v1';

function readCertificates(bytes: Buffer): X509Certificate[] {
  try {
    if (bytes[0] === 0x30) return [new X509Certificate(bytes)];
    const blocks = pemBlocks(bytes.toString('utf8')).filter(isCertificateBlock);
    return blocks.map((block) => new X509Certificate(block.text));
  } catch {
    return [];
  }
}

class KeyProblem extends Error {
  constructor(readonly problem: 'key_unreadable' | 'password_required' | 'password_wrong') {
    super(problem);
  }
}

// ── Koszt wyprowadzania klucza z hasła ───────────────────────────────────────
//
// `createPrivateKey` z hasłem jest synchroniczne: PBKDF2 liczy się w wątku, który
// obsługuje wszystkie żądania procesu, a liczbę iteracji podaje plik klienta. Zaszyfrowany
// klucz ma ok. 150 bajtów, a plik z 100 mln iteracji zatrzymuje pętlę zdarzeń na 7,5 s
// (2 mld to ponad dwie minuty), i to PRZED limitem prób. Dlatego algorytm i liczbę
// iteracji czytamy z DER sami, a OpenSSL dostaje tylko klucz, który policzy się w
// rozsądnym czasie. Niczego poza tym nie czytamy: ani soli, ani zaszyfrowanych danych.

/** Prawdziwe klucze mają od 2 tys. (domyślne OpenSSL) do kilkuset tys. iteracji; 2 mln to ok. 0,15 s dla SHA-256. */
const MAX_KDF_ITERATIONS = 2_000_000;

const SEQUENCE = 0x30;
const INTEGER = 0x02;
const OCTET_STRING = 0x04;
const OBJECT_IDENTIFIER = 0x06;

const OID_PBES2 = '1.2.840.113549.1.5.13';
const OID_PBKDF2 = '1.2.840.113549.1.5.12';
const OID_SCRYPT = '1.3.6.1.4.1.11591.4.11';
/** PBES1 (PKCS#5 v1.5: MD2, MD5 albo SHA-1 z DES lub RC2) i PBE z PKCS#12: parametry to { sól, liczba iteracji }. */
const LEGACY_PBE = /^(?:1\.2\.840\.113549\.1\.5\.(?:1|3|4|6|10|11)|1\.2\.840\.113549\.1\.12\.1\.[1-6])$/;

function objectIdentifier(der: Uint8Array, node: Tlv | undefined): string | null {
  if (!node || node.tag !== OBJECT_IDENTIFIER || node.end <= node.start) return null;
  const arcs: number[] = [];
  let value = 0;
  let open = false;
  for (let i = node.start; i < node.end; i += 1) {
    if (value > 2 ** 40) return null;
    const byte = der[i]!;
    value = value * 128 + (byte & 0x7f);
    open = (byte & 0x80) !== 0;
    if (!open) {
      arcs.push(value);
      value = 0;
    }
  }
  if (open) return null;
  const head = arcs[0]!;
  const first = head < 80 ? [Math.floor(head / 40), head % 40] : [2, head - 80];
  return [...first, ...arcs.slice(1)].join('.');
}

/** Nieujemna liczba całkowita z DER; `Infinity`, gdy nie mieści się w liczbie bezpiecznej. */
function integerValue(der: Uint8Array, node: Tlv | undefined): number | null {
  if (!node || node.tag !== INTEGER || node.end <= node.start || (der[node.start]! & 0x80) !== 0) return null;
  let value = 0;
  for (let i = node.start; i < node.end; i += 1) {
    value = value * 256 + der[i]!;
    if (value > Number.MAX_SAFE_INTEGER) return Infinity;
  }
  return value;
}

/** Parametry { sól, liczba iteracji, ... } (PBKDF2, PBES1, PKCS#12): liczba iteracji ma być sensowna i niewielka. */
function requireAffordableIterations(der: Uint8Array, parameters: Tlv | undefined): void {
  if (parameters?.tag !== SEQUENCE) throw new KeyProblem('key_unreadable');
  const iterations = integerValue(der, tlvChildren(der, parameters)[1]);
  if (iterations === null || iterations < 1 || iterations > MAX_KDF_ITERATIONS) throw new KeyProblem('key_unreadable');
}

/**
 * Wołaj PRZED `createPrivateKey` dla każdego klucza, do którego może trafić hasło.
 * DER zaczynający się od INTEGER (PKCS#8, PKCS#1, SEC1) nie używa hasła, więc przechodzi.
 * EncryptedPrivateKeyInfo = { AlgorithmIdentifier, OCTET STRING } przechodzi tylko z
 * PBES2 (PBKDF2 w granicach limitu albo scrypt, który ma limit pamięci w OpenSSL) albo
 * starszym PBES1 / PKCS#12 w granicach limitu. Reszta jest dla nas nieczytelna.
 */
function assertAffordableKeyDerivation(der: Uint8Array): void {
  const root = readTlv(der, 0);
  if (!root || root.tag !== SEQUENCE) throw new KeyProblem('key_unreadable');
  const first = readTlv(der, root.start, root.end);
  if (!first) throw new KeyProblem('key_unreadable');
  if (first.tag === INTEGER) return;
  const data = first.tag === SEQUENCE ? readTlv(der, first.end, root.end) : null;
  if (data?.tag !== OCTET_STRING) throw new KeyProblem('key_unreadable');

  const [algorithmId, parameters] = tlvChildren(der, first);
  const algorithm = objectIdentifier(der, algorithmId);
  if (algorithm === OID_PBES2) {
    if (parameters?.tag !== SEQUENCE) throw new KeyProblem('key_unreadable');
    const keyDerivation = tlvChildren(der, parameters)[0];
    if (keyDerivation?.tag !== SEQUENCE) throw new KeyProblem('key_unreadable');
    const [kdfId, kdfParameters] = tlvChildren(der, keyDerivation);
    const kdf = objectIdentifier(der, kdfId);
    if (kdf === OID_PBKDF2) requireAffordableIterations(der, kdfParameters);
    else if (kdf !== OID_SCRYPT) throw new KeyProblem('key_unreadable');
    return;
  }
  if (algorithm !== null && LEGACY_PBE.test(algorithm)) {
    requireAffordableIterations(der, parameters);
    return;
  }
  throw new KeyProblem('key_unreadable');
}

/** Treść bloku PEM jako DER (bez linii BEGIN i END oraz nagłówków w rodzaju Proc-Type). */
function pemBlockDer(block: PemBlock): Buffer {
  const base64 = block.text
    .replace(/^-----BEGIN [A-Z0-9 ]+-----/, '')
    .replace(/-----END [A-Z0-9 ]+-----$/, '')
    .replace(/^[ \t]*[A-Za-z0-9-]+:.*$/gm, '')
    .replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new KeyProblem('key_unreadable');
  return Buffer.from(base64, 'base64');
}

function errorCode(error: unknown): string {
  return typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : '';
}

/** Czy błąd odczytu klucza z hasłem to „złe hasło”, a nie uszkodzony plik. */
function isWrongPassword(error: unknown): boolean {
  const text = `${errorCode(error)} ${error instanceof Error ? error.message : ''}`.toLowerCase();
  return text.includes('bad_decrypt') || text.includes('bad decrypt') || text.includes('bad password')
    || text.includes('wrong tag');
}

function parseKey(source: { key: string | Buffer; format: 'pem' | 'der'; type?: 'pkcs8' | 'pkcs1' | 'sec1' }, password: string | undefined, encrypted: boolean): KeyObject {
  // OpenSSL 3 dla PEM bez hasła zgłasza „interrupted or cancelled”, a dla DER „missing passphrase”:
  // zaszyfrowany klucz bez hasła rozpoznajemy więc sami, po treści pliku.
  if (encrypted && !password) throw new KeyProblem('password_required');
  try {
    return createPrivateKey({ ...source, passphrase: password } as Parameters<typeof createPrivateKey>[0]);
  } catch (error) {
    if (errorCode(error) === 'ERR_MISSING_PASSPHRASE') throw new KeyProblem('password_required');
    if (encrypted && password && isWrongPassword(error)) throw new KeyProblem('password_wrong');
    throw new KeyProblem('key_unreadable');
  }
}

function readPrivateKey(bytes: Buffer, password: string | undefined): KeyObject {
  if (bytes[0] === 0x30) {
    assertAffordableKeyDerivation(bytes);
    const encrypted = classifyKsefFile(bytes) === 'encrypted-private-key';
    let firstProblem: KeyProblem | null = null;
    for (const type of ['pkcs8', 'pkcs1', 'sec1'] as const) {
      try {
        return parseKey({ key: bytes, format: 'der', type }, password, encrypted);
      } catch (error) {
        // Błąd hasła jest rozstrzygający (to ten sam plik), „nieczytelny” znaczy tylko „nie ten układ DER”.
        if (error instanceof KeyProblem && error.problem !== 'key_unreadable') throw error;
        firstProblem ??= error instanceof KeyProblem ? error : null;
      }
    }
    throw firstProblem ?? new KeyProblem('key_unreadable');
  }
  const block = pemBlocks(bytes.toString('utf8')).find(isPrivateKeyBlock);
  if (!block) throw new KeyProblem('key_unreadable');
  // Tradycyjny PEM (Proc-Type, DEK-Info) szyfruje jedną rundą MD5, więc nie ma tu czego sprawdzać.
  const traditional = block.encrypted && block.label !== 'ENCRYPTED PRIVATE KEY';
  if (!traditional) assertAffordableKeyDerivation(pemBlockDer(block));
  return parseKey({ key: block.text, format: 'pem' }, password, block.encrypted);
}

export function prepareKsefCredentials(input: PrepareInput, now: Date = new Date()): PreparedCredentials {
  const certificates = readCertificates(input.certificate);
  if (certificates.length === 0) return { ok: false, problem: 'cert_unreadable' };

  const password = input.password && input.password.length > 0 ? input.password : undefined;
  let key: KeyObject;
  try {
    key = readPrivateKey(input.privateKey, password);
  } catch (error) {
    return { ok: false, problem: error instanceof KeyProblem ? error.problem : 'key_unreadable' };
  }

  // Rodzaj klucza sprawdzamy przed porównaniem z certyfikatem: „zły rodzaj” mówi klientowi więcej niż „nie pasuje”.
  const kind = key.asymmetricKeyType;
  const supported =
    (kind === 'rsa' && (key.asymmetricKeyDetails?.modulusLength ?? 0) >= MIN_RSA_BITS) ||
    (kind === 'ec' && key.asymmetricKeyDetails?.namedCurve === EC_CURVE);
  if (!supported || (kind !== 'rsa' && kind !== 'ec')) return { ok: false, problem: 'key_unsupported' };

  const certificate = certificates.find((candidate) => candidate.checkPrivateKey(key));
  if (!certificate) return { ok: false, problem: 'key_mismatch' };

  // Typ Offline ma tylko Non-Repudiation i nie pozwala się uwierzytelnić (dokumentacja MF, certyfikaty-KSeF).
  const usage = certificateKeyUsage(certificate.raw);
  if (usage && !usage.digitalSignature && usage.nonRepudiation) return { ok: false, problem: 'cert_offline' };

  const validFrom = new Date(certificate.validFrom);
  const validTo = new Date(certificate.validTo);
  if (Number.isNaN(validFrom.getTime()) || Number.isNaN(validTo.getTime())) return { ok: false, problem: 'cert_unreadable' };
  if (now < validFrom) return { ok: false, problem: 'cert_not_yet_valid', validFrom, validTo };
  if (now > validTo) return { ok: false, problem: 'cert_expired', validFrom, validTo };

  return {
    ok: true,
    certificatePem: certificate.toString(),
    privateKeyPem: key.export({ type: 'pkcs8', format: 'pem' }).toString(),
    keyKind: kind,
    validFrom,
    validTo,
  };
}

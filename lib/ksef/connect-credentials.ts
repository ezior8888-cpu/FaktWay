import { X509Certificate, createPrivateKey, type KeyObject } from 'node:crypto';

import {
  certificateKeyUsage,
  classifyKsefFile,
  isCertificateBlock,
  isPrivateKeyBlock,
  pemBlocks,
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

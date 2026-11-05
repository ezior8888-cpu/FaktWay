import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  scryptSync,
} from 'node:crypto';

/**
 * Szyfruje credentials KSeF tenanta przed zapisem do `tenants.ksef_credentials_encrypted`.
 * AES-256-GCM.
 *
 * FORMAT v2 (od 02.10.2026, AUD-52):
 *   [4 B „KSC2”][8 B odcisk klucza głównego][16 B sól][12 B IV][16 B tag][N B szyfrogram(JSON)]
 *   - klucz danych = HKDF-SHA256(klucz główny, sól rekordu) — każdy rekord
 *     ma własny klucz, a nie jeden wspólny ze stałej soli,
 *   - AAD = identyfikator firmy — blob przeniesiony do innej firmy się nie
 *     odszyfruje,
 *   - odcisk klucza pozwala rotować: nowy w `KSEF_CREDENTIALS_ENCRYPTION_KEY`,
 *     stary w `KSEF_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS` do czasu
 *     przeszyfrowania (`scripts/reencrypt-ksef-credentials.ts`).
 *
 * FORMAT v1 (dotychczasowy, tylko odczyt): [12 B IV][16 B tag][szyfrogram],
 * klucz = scrypt(sekret, stała sól), bez AAD.
 *
 * TenantKsefCredentials to discriminated union po `type`:
 *   - 'xades' - klasyczna para cert+key z pliku .pem (legacy, silniejsze uwierzytelnienie)
 *   - 'token' - long-lived token wygenerowany w portalu ap-test.ksef.mf.gov.pl
 *     (mniej silne: jeden stringin KSeF ma zapisany, brak PKI)
 *
 * `decryptCredentials` zwraca union - caller dispatcha po `type` (w `admin-queries.ts`
 * zamieniamy to na `KsefAuth` dla submit-invoice-full).
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
/** Sól wyprowadzenia klucza GŁÓWNEGO z sekretu (v1 i v2). Sól rekordu — osobno, w v2. */
const SALT = Buffer.from('ksef-saas-credentials-v1');

const V2_MAGIC = Buffer.from('KSC2', 'ascii');
const FINGERPRINT_LENGTH = 8;
const RECORD_SALT_LENGTH = 16;
const V2_HEADER = V2_MAGIC.length + FINGERPRINT_LENGTH + RECORD_SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH;
const HKDF_INFO = Buffer.from('ksef-credentials-v2');

interface MasterKey {
  key: Buffer;
  fingerprint: Buffer;
}

/** scrypt jest celowo kosztowny — klucz główny liczymy raz na sekret. */
const masterKeyCache = new Map<string, MasterKey>();

function masterKey(secret: string): MasterKey {
  const cached = masterKeyCache.get(secret);
  if (cached) return cached;
  const key = scryptSync(secret, SALT, 32);
  const fingerprint = createHash('sha256').update(key).digest().subarray(0, FINGERPRINT_LENGTH);
  const entry = { key, fingerprint };
  masterKeyCache.set(secret, entry);
  return entry;
}

function currentKey(): MasterKey {
  const secret = process.env.KSEF_CREDENTIALS_ENCRYPTION_KEY;
  if (!secret) {
    throw new Error('KSEF_CREDENTIALS_ENCRYPTION_KEY nie jest ustawione w .env');
  }
  return masterKey(secret);
}

/** Klucze do odczytu: bieżący, potem poprzedni (rotacja). */
function decryptionKeys(): MasterKey[] {
  const keys = [currentKey()];
  const previous = process.env.KSEF_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS?.trim();
  if (previous) keys.push(masterKey(previous));
  return keys;
}

function aad(tenantId: string): Buffer {
  if (!tenantId) throw new Error('credentials-crypto: brak identyfikatora firmy (AAD)');
  return Buffer.from(`ksef-credentials:v2:${tenantId}`, 'utf8');
}

function recordKey(master: Buffer, salt: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', master, salt, HKDF_INFO, 32));
}

/** Czy blob jest w formacie v2 (do raportu przeszyfrowania). */
export function isCredentialsV2(blob: Buffer): boolean {
  return blob.length > V2_HEADER && blob.subarray(0, V2_MAGIC.length).equals(V2_MAGIC);
}

/**
 * Czy blob jest w v2 i zaszyfrowany BIEŻĄCYM kluczem — tylko taki
 * przeszyfrowanie może pominąć. Sama magia „KSC2” nie wystarcza: przy
 * rotacji v2 zaszyfrowane kluczem z `_PREVIOUS` też ją ma, a po usunięciu
 * starego klucza nie dałoby się go odczytać.
 */
export function isEncryptedWithCurrentKey(blob: Buffer): boolean {
  if (!isCredentialsV2(blob)) return false;
  const fingerprint = blob.subarray(V2_MAGIC.length, V2_MAGIC.length + FINGERPRINT_LENGTH);
  return fingerprint.equals(currentKey().fingerprint);
}

// ═══════════════════════════════════════════════════════════════
// TYPY
// ═══════════════════════════════════════════════════════════════

export interface TenantKsefXadesCredentials {
  type: 'xades';
  nip: string;
  certificatePem: string;
  privateKeyPem: string;
}

export interface TenantKsefTokenCredentials {
  type: 'token';
  nip: string;
  /** Long-lived token (format KSeF: `reference|nip-NIP|secret`). */
  token: string;
}

export type TenantKsefCredentials =
  | TenantKsefXadesCredentials
  | TenantKsefTokenCredentials;

// ═══════════════════════════════════════════════════════════════
// SZYFROWANIE
// ═══════════════════════════════════════════════════════════════

export function encryptCredentials(creds: TenantKsefCredentials, tenantId: string): Buffer {
  const master = currentKey();
  const salt = randomBytes(RECORD_SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, recordKey(master.key, salt), iv);
  cipher.setAAD(aad(tenantId));

  const plaintext = Buffer.from(JSON.stringify(creds), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([V2_MAGIC, master.fingerprint, salt, iv, authTag, encrypted]);
}

function decryptV2(blob: Buffer, tenantId: string): Buffer {
  let offset = V2_MAGIC.length;
  const fingerprint = blob.subarray(offset, (offset += FINGERPRINT_LENGTH));
  const salt = blob.subarray(offset, (offset += RECORD_SALT_LENGTH));
  const iv = blob.subarray(offset, (offset += IV_LENGTH));
  const authTag = blob.subarray(offset, (offset += AUTH_TAG_LENGTH));
  const ciphertext = blob.subarray(offset);

  const master = decryptionKeys().find((k) => k.fingerprint.equals(fingerprint));
  if (!master) throw new Error('decryptCredentials: brak klucza, którym zaszyfrowano dane (rotacja?)');

  const decipher = createDecipheriv(ALGORITHM, recordKey(master.key, salt), iv);
  decipher.setAAD(aad(tenantId));
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function decryptV1(blob: Buffer): Buffer {
  const iv = blob.subarray(0, IV_LENGTH);
  const authTag = blob.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = blob.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  let lastError: unknown = null;
  for (const master of decryptionKeys()) {
    try {
      const decipher = createDecipheriv(ALGORITHM, master.key, iv);
      decipher.setAuthTag(authTag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('decryptCredentials: odszyfrowanie nieudane');
}

export function decryptCredentials(encryptedBlob: Buffer, tenantId: string): TenantKsefCredentials {
  // v1 zaczyna się losowym IV — 4 bajty „KSC2” wypadną tam raz na 2^32.
  // Wtedy v2 nie przejdzie tagu GCM i próbujemy jeszcze jako v1.
  let decrypted: Buffer;
  if (isCredentialsV2(encryptedBlob)) {
    try {
      decrypted = decryptV2(encryptedBlob, tenantId);
    } catch (v2Error) {
      try {
        decrypted = decryptV1(encryptedBlob);
      } catch {
        throw v2Error;
      }
    }
  } else {
    decrypted = decryptV1(encryptedBlob);
  }

  const parsed = JSON.parse(decrypted.toString('utf8')) as TenantKsefCredentials;

  // Defensywna walidacja - jeśli kiedyś zmienimy kształt, stare rekordy będą
  // wymagały migracji, a nie silent corruption.
  if (parsed.type !== 'xades' && parsed.type !== 'token') {
    throw new Error(
      `decryptCredentials: nieznany type "${(parsed as { type?: unknown }).type}"`,
    );
  }
  return parsed;
}

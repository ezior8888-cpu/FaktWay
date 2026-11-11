import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Sekret podpisu webhooka: wygenerowanie i przechowanie (00187).
 *
 * DLACZEGO SZYFROGRAM, A NIE SKRÓT. Klucz API sprawdzamy (porównujemy skrót
 * z bazy ze skrótem klucza z żądania), więc wystarcza skrót. Sekretem webhooka
 * PODPISUJEMY każde żądanie (HMAC-SHA256), więc przy każdej wysyłce potrzebny
 * jest sam sekret; ze skrótu, także z kluczem, go nie odtworzymy. Wariant
 * „sekret = HMAC(klucz serwera, identyfikator webhooka)” wiązałby wszystkie
 * sekrety z jednym kluczem: jego zmiana unieważniłaby naraz wszystkie
 * integracje klientów. Dlatego szyfrowanie z uwierzytelnieniem:
 *
 * - AES-256-GCM, klucz rekordu = HKDF-SHA256(klucz główny, losowa sól rekordu),
 *   klucz główny w zmiennej `WEBHOOK_SECRETS_ENCRYPTION_KEY` (aplikacja i worker),
 *   NIGDY w bazie: zrzut bazy albo kopia zapasowa nie zdradza sekretów,
 * - AAD = firma i identyfikator webhooka: szyfrogram przeniesiony do innego
 *   wiersza (albo firmy) się nie odszyfruje,
 * - odcisk klucza w nagłówku: rotacja przez `WEBHOOK_SECRETS_ENCRYPTION_KEY_PREVIOUS`
 *   (tylko odczyt starych zapisów), jak przy danych dostępowych KSeF,
 * - osobny klucz, nie `KSEF_CREDENTIALS_ENCRYPTION_KEY`: rotacja jednego nie psuje drugiego.
 *
 * Format (base64): [4 B „FWW1”][8 B odcisk klucza][16 B sól][12 B IV][16 B tag][szyfrogram].
 * Klient widzi sekret raz (odpowiedź akcji „Dodaj webhook”); szyfrogram nie
 * wraca do przeglądarki (grant kolumnowy w 00187). Tylko serwer.
 */

export const WEBHOOK_SECRETS_KEY_ENV = 'WEBHOOK_SECRETS_ENCRYPTION_KEY';
const PREVIOUS_KEY_ENV = 'WEBHOOK_SECRETS_ENCRYPTION_KEY_PREVIOUS';
/** Krótszą wartość traktujemy jak brak (wygeneruj: `openssl rand -base64 32`). */
const MIN_KEY_LENGTH = 32;

const ALGORITHM = 'aes-256-gcm';
const MAGIC = Buffer.from('FWW1', 'ascii');
const FINGERPRINT_LENGTH = 8;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const HEADER_LENGTH = MAGIC.length + FINGERPRINT_LENGTH + SALT_LENGTH + IV_LENGTH + TAG_LENGTH;
const HKDF_INFO = Buffer.from('faktway-webhook-signing-v1');

type Env = Record<string, string | undefined>;

export interface WebhookSecretBinding {
  tenantId: string;
  webhookId: string;
}

/** Brak klucza szyfrowania na serwerze: webhooka nie dodamy, a dostawy nie podpiszemy. */
export class WebhookSecretsUnavailableError extends Error {
  constructor() {
    super(`${WEBHOOK_SECRETS_KEY_ENV} nie jest ustawione (albo jest krótsze niż ${MIN_KEY_LENGTH} znaki)`);
    this.name = 'WebhookSecretsUnavailableError';
  }
}

function keyValue(raw: string | undefined): string | null {
  const value = raw?.trim();
  return value && value.length >= MIN_KEY_LENGTH ? value : null;
}

/** Czy serwer może szyfrować sekrety webhooków (zmienna ustawiona i dość długa). */
export function webhookSecretsConfigured(env: Env = process.env): boolean {
  return keyValue(env[WEBHOOK_SECRETS_KEY_ENV]) !== null;
}

interface WrapKey {
  material: Buffer;
  fingerprint: Buffer;
}

function wrapKey(value: string): WrapKey {
  const material = Buffer.from(value, 'utf8');
  const fingerprint = createHmac('sha256', material).update('faktway-webhook-key-fingerprint').digest().subarray(0, FINGERPRINT_LENGTH);
  return { material, fingerprint };
}

function recordKey(material: Buffer, salt: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', material, salt, HKDF_INFO, 32));
}

function aad(binding: WebhookSecretBinding): Buffer {
  if (!binding.tenantId || !binding.webhookId) throw new Error('secret-box: brak firmy albo webhooka (AAD)');
  return Buffer.from(`faktway-webhook:v1:${binding.tenantId}:${binding.webhookId}`, 'utf8');
}

/** `fwws_` i 43 znaki base64url (32 losowe bajty). Pokazany klientowi raz. */
export function generateWebhookSecret(): string {
  return `fwws_${randomBytes(32).toString('base64url')}`;
}

export function encryptWebhookSecret(signingSecret: string, binding: WebhookSecretBinding, env: Env = process.env): string {
  const value = keyValue(env[WEBHOOK_SECRETS_KEY_ENV]);
  if (!value) throw new WebhookSecretsUnavailableError();
  const key = wrapKey(value);
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, recordKey(key.material, salt), iv);
  cipher.setAAD(aad(binding));
  const encrypted = Buffer.concat([cipher.update(signingSecret, 'utf8'), cipher.final()]);
  return Buffer.concat([MAGIC, key.fingerprint, salt, iv, cipher.getAuthTag(), encrypted]).toString('base64');
}

export function decryptWebhookSecret(ciphertext: string, binding: WebhookSecretBinding, env: Env = process.env): string {
  const blob = Buffer.from(ciphertext, 'base64');
  if (blob.length <= HEADER_LENGTH || !blob.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('secret-box: nieznany format szyfrogramu');
  }
  let offset = MAGIC.length;
  const fingerprint = blob.subarray(offset, (offset += FINGERPRINT_LENGTH));
  const salt = blob.subarray(offset, (offset += SALT_LENGTH));
  const iv = blob.subarray(offset, (offset += IV_LENGTH));
  const tag = blob.subarray(offset, (offset += TAG_LENGTH));
  const encrypted = blob.subarray(offset);

  const candidates = [keyValue(env[WEBHOOK_SECRETS_KEY_ENV]), keyValue(env[PREVIOUS_KEY_ENV])]
    .filter((value): value is string => value !== null)
    .map(wrapKey);
  if (candidates.length === 0) throw new WebhookSecretsUnavailableError();
  const key = candidates.find((candidate) => candidate.fingerprint.equals(fingerprint));
  if (!key) throw new Error('secret-box: brak klucza, którym zaszyfrowano sekret (rotacja?)');

  const decipher = createDecipheriv(ALGORITHM, recordKey(key.material, salt), iv);
  decipher.setAAD(aad(binding));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

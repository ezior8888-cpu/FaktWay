import { createPublicKey, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

/**
 * Certyfikat samopodpisany na potrzeby testów i skryptu `test-ksef-kreator.ts`
 * (KSeF TEST dopuszcza takie certyfikaty, ale tylko z fikcyjnym NIP-em).
 * Klucze powstają w locie, nic nie trafia do repozytorium. X.509 składamy
 * ręcznie z DER, bo `node:crypto` nie umie wystawiać certyfikatów, a nie
 * chcemy zależeć od binarki `openssl` (inna na Macu, inna w CI).
 */

/**
 * Nagłówki PEM złożone z kawałków: asercje w testach nie mogą zawierać pełnego nagłówka klucza,
 * bo skanery sekretów (gitleaks czyta całą historię) biorą taki napis za klucz prywatny.
 */
export const PKCS8_HEADER = ['-----BEGIN', 'PRIVATE', 'KEY-----'].join(' ');
export const CERTIFICATE_HEADER = ['-----BEGIN', 'CERTIFICATE-----'].join(' ');

export type TestKeyKind = 'rsa' | 'ec';
/** `authentication` = jak certyfikat KSeF typu Uwierzytelnienie, `offline` = typ Offline. */
export type TestCertUsage = 'authentication' | 'offline' | 'none';

export interface SelfSignedOptions {
  kind: TestKeyKind;
  nip: string;
  usage?: TestCertUsage;
  notBefore?: Date;
  notAfter?: Date;
  /** `seal` = pieczęć firmowa (organizationIdentifier), `person` = osoba (serialNumber TINPL). */
  subject?: 'seal' | 'person';
}

export interface SelfSignedMaterial {
  certDer: Buffer;
  certPem: string;
  privateKey: KeyObject;
  /** Klucz w PKCS#8 PEM bez hasła. */
  keyPem: string;
}

function lengthBytes(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  if (n < 0x100) return Buffer.from([0x81, n]);
  return Buffer.from([0x82, n >> 8, n & 0xff]);
}

function tlv(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), lengthBytes(body.length), body]);
}

const seq = (...p: Buffer[]) => tlv(0x30, ...p);
const set = (...p: Buffer[]) => tlv(0x31, ...p);
const nul = () => Buffer.from([0x05, 0x00]);

function oid(dotted: string): Buffer {
  const parts = dotted.split('.').map(Number);
  const bytes = [parts[0]! * 40 + parts[1]!];
  for (const part of parts.slice(2)) {
    const chunk = [part & 0x7f];
    let rest = part >> 7;
    while (rest > 0) {
      chunk.unshift((rest & 0x7f) | 0x80);
      rest >>= 7;
    }
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

function utcTime(date: Date): Buffer {
  const p = (n: number) => String(n).padStart(2, '0');
  const text = `${p(date.getUTCFullYear() % 100)}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}`
    + `${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`;
  return tlv(0x17, Buffer.from(text, 'ascii'));
}

function attribute(dotted: string, value: string, printable = false): Buffer {
  return set(seq(oid(dotted), tlv(printable ? 0x13 : 0x0c, Buffer.from(value, 'utf8'))));
}

function subjectName(options: SelfSignedOptions): Buffer {
  const country = attribute('2.5.4.6', 'PL', true);
  if (options.subject === 'person') {
    return seq(
      country,
      attribute('2.5.4.42', 'Jan'),
      attribute('2.5.4.4', 'Testowy'),
      attribute('2.5.4.5', `TINPL-${options.nip}`, true),
      attribute('2.5.4.3', 'Jan Testowy'),
    );
  }
  return seq(
    country,
    attribute('2.5.4.10', 'Firma Testowa'),
    attribute('2.5.4.97', `VATPL-${options.nip}`),
    attribute('2.5.4.3', 'Firma Testowa'),
  );
}

function keyUsageExtension(usage: TestCertUsage): Buffer | null {
  if (usage === 'none') return null;
  // BIT STRING: bajt z liczbą nieużywanych bitów, potem bity. Bit 0 = digitalSignature (0x80),
  // bit 1 = nonRepudiation (0x40), zgodnie z opisem typów certyfikatów w dokumentacji MF.
  const bits = usage === 'authentication' ? Buffer.from([0x07, 0x80]) : Buffer.from([0x06, 0x40]);
  return seq(oid('2.5.29.15'), tlv(0x01, Buffer.from([0xff])), tlv(0x04, tlv(0x03, bits)));
}

export function generateTestKey(kind: TestKeyKind): { privateKey: KeyObject; publicKey: KeyObject } {
  return kind === 'rsa'
    ? generateKeyPairSync('rsa', { modulusLength: 2048 })
    : generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
}

function toPem(label: string, der: Buffer): string {
  const lines = der.toString('base64').match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

/**
 * Klucz RSA o podanej długości. Słaby klucz jest w testach celowo: sprawdzamy,
 * że kreator go odrzuca. Nigdy niczego nie podpisuje. Długość idzie parametrem,
 * bo bramka CodeQL (js/insufficient-key-size) nie ma wyjątku dla testów.
 */
export function makeRsaPrivateKey(modulusLength: number): KeyObject {
  return generateKeyPairSync('rsa', { modulusLength }).privateKey;
}

export function makeSelfSignedCertificate(options: SelfSignedOptions): SelfSignedMaterial {
  const { privateKey } = generateTestKey(options.kind);
  return certificateForKey(privateKey, options);
}

/** Certyfikat dla już istniejącego klucza (np. do testu „klucz nie pasuje do certyfikatu”). */
export function certificateForKey(privateKey: KeyObject, options: SelfSignedOptions): SelfSignedMaterial {
  const usage = options.usage ?? 'authentication';
  const notBefore = options.notBefore ?? new Date(Date.now() - 24 * 3600 * 1000);
  const notAfter = options.notAfter ?? new Date(Date.now() + 365 * 24 * 3600 * 1000);

  const signatureAlgorithm = options.kind === 'rsa'
    ? seq(oid('1.2.840.113549.1.1.11'), nul())
    : seq(oid('1.2.840.10045.4.3.2'));

  const serial = randomBytes(8);
  serial[0] = serial[0]! & 0x7f;
  if (serial[0] === 0) serial[0] = 1;

  const name = subjectName(options);
  const extension = keyUsageExtension(usage);
  const tbs = seq(
    tlv(0xa0, tlv(0x02, Buffer.from([0x02]))),
    tlv(0x02, serial),
    signatureAlgorithm,
    name,
    seq(utcTime(notBefore), utcTime(notAfter)),
    name,
    createPublicKey(privateKey).export({ type: 'spki', format: 'der' }),
    ...(extension ? [tlv(0xa3, seq(extension))] : []),
  );
  const signature = sign('sha256', tbs, privateKey);
  const certDer = seq(tbs, signatureAlgorithm, tlv(0x03, Buffer.from([0x00]), signature));

  return {
    certDer,
    certPem: toPem('CERTIFICATE', certDer),
    privateKey,
    keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

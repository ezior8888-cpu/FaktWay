/**
 * Rozpoznawanie plików z Aplikacji Podatnika po TREŚCI, nie po rozszerzeniu
 * (klient dostaje `.crt` i `.key`, ale iPhone wyszarza pliki spoza `accept`,
 * a „Wgraj oba naraz” nie może zależeć od nazw). Moduł jest czysty, bez
 * `node:*`, bo korzysta z niego i przeglądarka (kreator), i serwer (akcja).
 * Serwer niczego tu nie przyjmuje na wiarę: pełny odczyt robi
 * `connect-credentials.ts`, a klasyfikacja służy do wyboru pola i do pytania
 * o hasło tylko wtedy, gdy klucz jest zaszyfrowany.
 */

export type KsefFileKind =
  | 'certificate'
  | 'private-key'
  | 'encrypted-private-key'
  /** Jeden plik PEM z certyfikatem i kluczem naraz. */
  | 'bundle'
  | 'unknown';

/** Certyfikat KSeF ma kilka kilobajtów; to zapas na łańcuch certyfikatów, nie plik dowolnej wielkości. */
export const MAX_KSEF_FILE_BYTES = 64 * 1024;

export interface PemBlock {
  label: string;
  /** Tekst bloku razem z liniami BEGIN/END. */
  text: string;
  /** Nagłówki tradycyjnego PEM (np. `Proc-Type: 4,ENCRYPTED`) albo PKCS#8 zaszyfrowany. */
  encrypted: boolean;
}

const PEM_BLOCK = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/g;
const CERT_LABELS = new Set(['CERTIFICATE', 'X509 CERTIFICATE', 'TRUSTED CERTIFICATE']);
const KEY_LABELS = new Set(['PRIVATE KEY', 'RSA PRIVATE KEY', 'EC PRIVATE KEY', 'ENCRYPTED PRIVATE KEY']);

export function pemBlocks(text: string): PemBlock[] {
  const blocks: PemBlock[] = [];
  for (const match of text.matchAll(PEM_BLOCK)) {
    const label = match[1]!;
    blocks.push({
      label,
      text: match[0],
      encrypted: label === 'ENCRYPTED PRIVATE KEY' || /Proc-Type:\s*4,\s*ENCRYPTED/i.test(match[2]!),
    });
  }
  return blocks;
}

export function isCertificateBlock(block: PemBlock): boolean {
  return CERT_LABELS.has(block.label);
}

export function isPrivateKeyBlock(block: PemBlock): boolean {
  return KEY_LABELS.has(block.label);
}

// ── Minimalny czytnik DER (tylko nagłówki TLV, na potrzeby rozpoznania typu) ──

export interface Tlv {
  tag: number;
  /** Początek treści. */
  start: number;
  end: number;
}

export function readTlv(bytes: Uint8Array, offset: number, limit = bytes.length): Tlv | null {
  if (offset + 2 > limit) return null;
  const tag = bytes[offset]!;
  const first = bytes[offset + 1]!;
  let length = first;
  let headerLength = 2;
  if (first & 0x80) {
    const count = first & 0x7f;
    if (count < 1 || count > 3 || offset + 2 + count > limit) return null;
    length = 0;
    for (let i = 0; i < count; i += 1) length = length * 256 + bytes[offset + 2 + i]!;
    headerLength = 2 + count;
  }
  const start = offset + headerLength;
  const end = start + length;
  return end > limit ? null : { tag, start, end };
}

export function tlvChildren(bytes: Uint8Array, parent: Tlv): Tlv[] {
  const children: Tlv[] = [];
  let offset = parent.start;
  while (offset < parent.end) {
    const child = readTlv(bytes, offset, parent.end);
    if (!child) return [];
    children.push(child);
    offset = child.end;
  }
  return children;
}

const SEQUENCE = 0x30;
const INTEGER = 0x02;
const BIT_STRING = 0x03;
const OCTET_STRING = 0x04;

function classifyDer(bytes: Uint8Array): KsefFileKind {
  const root = readTlv(bytes, 0);
  if (!root || root.tag !== SEQUENCE || root.end !== bytes.length) return 'unknown';
  const kids = tlvChildren(bytes, root);
  const [first, second, third] = kids;
  if (!first || !second) return 'unknown';

  if (first.tag === SEQUENCE) {
    // EncryptedPrivateKeyInfo: { AlgorithmIdentifier, OCTET STRING }
    if (kids.length === 2 && second.tag === OCTET_STRING) return 'encrypted-private-key';
    // Certificate: { tbsCertificate, signatureAlgorithm, signatureValue }
    if (kids.length === 3 && second.tag === SEQUENCE && third?.tag === BIT_STRING) return 'certificate';
    return 'unknown';
  }
  if (first.tag === INTEGER) {
    // PKCS#8 { version, AlgorithmIdentifier, OCTET STRING }, PKCS#1 { version, n, ... }, SEC1 { version, OCTET STRING, ... }
    if (second.tag === SEQUENCE && third?.tag === OCTET_STRING) return 'private-key';
    if (second.tag === INTEGER || second.tag === OCTET_STRING) return 'private-key';
  }
  return 'unknown';
}

export interface KsefFileInfo {
  kind: KsefFileKind;
  /** Klucz (osobny albo w pakiecie) jest zaszyfrowany hasłem, więc kreator pyta o hasło. */
  encrypted: boolean;
}

function describePem(text: string): KsefFileInfo {
  const blocks = pemBlocks(text);
  const hasCertificate = blocks.some(isCertificateBlock);
  const keys = blocks.filter(isPrivateKeyBlock);
  const encrypted = keys.some((key) => key.encrypted);
  if (hasCertificate && keys.length > 0) return { kind: 'bundle', encrypted };
  if (hasCertificate) return { kind: 'certificate', encrypted: false };
  if (keys.length > 0) return { kind: encrypted ? 'encrypted-private-key' : 'private-key', encrypted };
  return { kind: 'unknown', encrypted: false };
}

export function describeKsefFile(bytes: Uint8Array): KsefFileInfo {
  if (bytes.length === 0 || bytes.length > MAX_KSEF_FILE_BYTES) return { kind: 'unknown', encrypted: false };
  // DER zaczyna się od SEQUENCE (0x30); PEM to tekst zaczynający się od „-----BEGIN” (po ewentualnych białych znakach).
  if (bytes[0] !== SEQUENCE) {
    return describePem(new TextDecoder('utf-8', { fatal: false }).decode(bytes));
  }
  const kind = classifyDer(bytes);
  return { kind, encrypted: kind === 'encrypted-private-key' };
}

export function classifyKsefFile(bytes: Uint8Array): KsefFileKind {
  return describeKsefFile(bytes).kind;
}

/** Z certyfikatu DER: czy rozszerzenie keyUsage zawiera Digital Signature i Non-Repudiation. */
export function certificateKeyUsage(der: Uint8Array): { digitalSignature: boolean; nonRepudiation: boolean } | null {
  const root = readTlv(der, 0);
  if (!root || root.tag !== SEQUENCE) return null;
  const tbs = tlvChildren(der, root)[0];
  if (!tbs || tbs.tag !== SEQUENCE) return null;
  const extensionsWrapper = tlvChildren(der, tbs).find((child) => child.tag === 0xa3);
  const extensionList = extensionsWrapper ? tlvChildren(der, extensionsWrapper)[0] : undefined;
  if (!extensionList) return null;

  for (const extension of tlvChildren(der, extensionList)) {
    const [oid, ...rest] = tlvChildren(der, extension);
    // OID 2.5.29.15 (keyUsage) = 55 1D 0F
    const isKeyUsage = oid?.tag === 0x06 && oid.end - oid.start === 3
      && der[oid.start] === 0x55 && der[oid.start + 1] === 0x1d && der[oid.start + 2] === 0x0f;
    if (!isKeyUsage) continue;
    const value = rest.find((child) => child.tag === OCTET_STRING);
    const bits = value ? readTlv(der, value.start, value.end) : null;
    if (!bits || bits.tag !== BIT_STRING || bits.end - bits.start < 2) return null;
    const flags = der[bits.start + 1]!;
    return { digitalSignature: (flags & 0x80) !== 0, nonRepudiation: (flags & 0x40) !== 0 };
  }
  return null;
}

/** Base64 bez `Buffer` (działa w przeglądarce); porcjami, żeby nie przepełnić stosu. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

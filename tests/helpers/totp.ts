import { createHmac } from 'node:crypto';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function fromBase32(secret: string): Buffer {
  let bits = '';
  for (const character of secret.replace(/=+$/, '').toUpperCase()) {
    const value = BASE32.indexOf(character);
    if (value < 0) throw new Error('TOTP: sekret nie jest w base32');
    bits += value.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) {
    bytes.push(parseInt(bits.slice(offset, offset + 8), 2));
  }
  return Buffer.from(bytes);
}

/** Kod RFC 6238 (SHA-1, 6 cyfr, 30 s), jak aplikacja uwierzytelniająca. Tylko testy. */
export function totpCode(secret: string, now: number = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 1000 / 30)));
  const digest = createHmac('sha1', fromBase32(secret)).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 1_000_000).padStart(6, '0');
}

// TOTP (RFC 6238, HMAC-SHA1, 30 s, 6 cyfr) — drugi czynnik dla /wdroz.
// Bez zależności: node:crypto. Sekret w Base32, jak w aplikacjach typu
// Google Authenticator / 1Password.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Decode(input) {
  const clean = input.toUpperCase().replace(/[\s=-]/g, '');
  if (!/^[A-Z2-7]+$/.test(clean)) throw new Error('Sekret TOTP nie jest poprawnym Base32');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    value = (value << 5) | ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function hotp(key, counter, digits = 6) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', key).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const code = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return code.toString().padStart(digits, '0');
}

export function counterAt(timeMs, stepSeconds = 30) {
  return Math.floor(timeMs / 1000 / stepSeconds);
}

/**
 * Weryfikator z ochroną przed ponownym użyciem kodu i zgadywaniem.
 * - okno ±1 krok (zegar telefonu może się spóźniać),
 * - ten sam albo starszy krok nie przejdzie drugi raz (replay),
 * - 5 błędnych kodów w 15 min blokuje weryfikację na 15 min.
 */
export function createTotpVerifier(secretBase32, { now = () => Date.now(), maxFailures = 5, lockMs = 15 * 60_000 } = {}) {
  const key = base32Decode(secretBase32);
  if (key.length < 10) throw new Error('Sekret TOTP za krótki (min. 80 bitów)');
  let lastUsedCounter = -1;
  let failures = [];
  let lockedUntil = 0;

  return function verify(code) {
    const t = now();
    if (t < lockedUntil) return { ok: false, reason: 'locked', retryAfterMs: lockedUntil - t };
    failures = failures.filter((at) => t - at < lockMs);
    if (typeof code !== 'string' || !/^\d{6}$/.test(code)) {
      return fail(t, 'format');
    }
    const current = counterAt(t);
    for (const c of [current - 1, current, current + 1]) {
      if (c <= lastUsedCounter) continue;
      const expected = hotp(key, c);
      if (timingSafeEqual(Buffer.from(expected), Buffer.from(code))) {
        lastUsedCounter = c;
        failures = [];
        return { ok: true };
      }
    }
    return fail(t, 'mismatch');
  };

  function fail(t, reason) {
    failures.push(t);
    if (failures.length >= maxFailures) {
      lockedUntil = t + lockMs;
      failures = [];
      return { ok: false, reason: 'locked', retryAfterMs: lockMs };
    }
    return { ok: false, reason };
  }
}

/** Nowy sekret (160 bitów) i URI do zeskanowania w aplikacji uwierzytelniającej. */
export function newTotpSecret(label = 'FaktWay bramka') {
  const secret = base32Encode(randomBytes(20));
  const uri = `otpauth://totp/${encodeURIComponent(label)}?secret=${secret}&issuer=FaktWay&algorithm=SHA1&digits=6&period=30`;
  return { secret, uri };
}

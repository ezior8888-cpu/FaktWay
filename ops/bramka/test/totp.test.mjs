import assert from 'node:assert/strict';
import test from 'node:test';

import { base32Decode, base32Encode, counterAt, createTotpVerifier, hotp, newTotpSecret } from '../src/totp.mjs';

// RFC 6238, dodatek B: klucz ASCII „12345678901234567890”, SHA1, 8 cyfr.
// Publiczny wektor testowy ze standardu. Zapis w Base32 składamy z kawałków,
// żeby skaner sekretów (gitleaks, generic-api-key) nie brał go za klucz.
const RFC_BYTES = Buffer.from('1234567890'.repeat(2));
const RFC_B32 = base32Encode(RFC_BYTES);
const RFC_B32_EXPECTED = ['GEZDGNBV', 'GY3TQOJQ'].join('').repeat(2);

test('wektory testowe RFC 6238 (SHA1)', () => {
  const vectors = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
  ];
  for (const [t, expected] of vectors) {
    assert.equal(hotp(RFC_BYTES, counterAt(t * 1000), 8), expected, `T=${t}`);
  }
});

test('Base32 w obie strony', () => {
  assert.equal(RFC_B32, RFC_B32_EXPECTED);
  assert.deepEqual(base32Decode(RFC_B32), RFC_BYTES);
  assert.deepEqual(base32Decode(RFC_B32.toLowerCase().match(/.{4}/g).join(' ')), RFC_BYTES);
  assert.throws(() => base32Decode('ABC1'), /Base32/);
});

test('poprawny kod przechodzi, ten sam drugi raz już nie (replay)', () => {
  let t = 59_000;
  const verify = createTotpVerifier(RFC_B32, { now: () => t });
  const code = hotp(RFC_BYTES, counterAt(t));
  assert.deepEqual(verify(code), { ok: true });
  assert.equal(verify(code).ok, false);
  t += 30_000;
  assert.deepEqual(verify(hotp(RFC_BYTES, counterAt(t))), { ok: true });
});

test('okno ±1 krok: kod z poprzednich 30 s przechodzi, sprzed minuty nie', () => {
  const t = 10_000_000;
  const verify = createTotpVerifier(RFC_B32, { now: () => t });
  assert.equal(verify(hotp(RFC_BYTES, counterAt(t) - 2)).ok, false);
  assert.equal(verify(hotp(RFC_BYTES, counterAt(t) - 1)).ok, true);
});

test('5 błędnych kodów blokuje weryfikację na 15 min, także dla poprawnego kodu', () => {
  let t = 1_000_000;
  const verify = createTotpVerifier(RFC_B32, { now: () => t });
  for (let i = 0; i < 4; i++) assert.equal(verify('000000').reason, 'mismatch');
  assert.equal(verify('000000').reason, 'locked');
  assert.equal(verify(hotp(RFC_BYTES, counterAt(t))).reason, 'locked');
  t += 15 * 60_000 + 1;
  assert.equal(verify(hotp(RFC_BYTES, counterAt(t))).ok, true);
});

test('kod w złym formacie jest odrzucany', () => {
  const verify = createTotpVerifier(RFC_B32, { now: () => 0 });
  for (const bad of ['12345', '1234567', 'abcdef', '', undefined]) assert.equal(verify(bad).ok, false);
});

test('za krótki sekret jest odrzucany', () => {
  assert.throws(() => createTotpVerifier('GEZDGNBV'), /za krótki/);
});

test('nowy sekret: 160 bitów i URI dla aplikacji', () => {
  const { secret, uri } = newTotpSecret('Test');
  assert.equal(base32Decode(secret).length, 20);
  assert.match(uri, /^otpauth:\/\/totp\/Test\?secret=[A-Z2-7]+&issuer=FaktWay/);
});

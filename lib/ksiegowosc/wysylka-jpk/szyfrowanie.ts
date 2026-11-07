/**
 * Szyfrowanie paczki JPK dla bramki MF (specyfikacja interfejsów usług JPK
 * 5.6.0, rozdziały 1.2.1-1.2.3 i 1.3.2):
 *
 * - plik XML w archiwum ZIP (DEFLATE, jeden dokument, bez dzielenia ZIP);
 * - archiwum zaszyfrowane AES-256-CBC z dopełnieniem PKCS#7, kluczem i IV
 *   losowanymi na każdą wysyłkę;
 * - klucz AES zaszyfrowany kluczem publicznym MF: RSA, ECB, PKCS#1 v1.5;
 * - dane autoryzujące tym samym kluczem i IV co archiwum (jedyny IV
 *   w metadanych to ten z `FileSignatureList/Encryption`).
 *
 * Klucz i IV żyją tylko w pamięci jednej wysyłki; nic stąd nie trafia do
 * bazy ani do logów.
 */

import { constants, createCipheriv, createHash, publicEncrypt, randomBytes, type KeyObject } from 'node:crypto';

/** Klucz i wektor AES-256-CBC jednej wysyłki. */
export interface KluczSesji {
  klucz: Buffer;
  iv: Buffer;
}

export function nowyKluczSesji(): KluczSesji {
  return { klucz: randomBytes(32), iv: randomBytes(16) };
}

/** AES-256-CBC; Node dopełnia PKCS#7 domyślnie. */
export function zaszyfrujAes(dane: Buffer, { klucz, iv }: KluczSesji): Buffer {
  const szyfr = createCipheriv('aes-256-cbc', klucz, iv);
  return Buffer.concat([szyfr.update(dane), szyfr.final()]);
}

/** Klucz AES zaszyfrowany kluczem publicznym MF (RSA/ECB/PKCS#1), w Base64. */
export function zaszyfrujKlucz(klucz: Buffer, kluczMf: KeyObject): string {
  return publicEncrypt({ key: kluczMf, padding: constants.RSA_PKCS1_PADDING }, klucz).toString('base64');
}

/** Skrót pliku z metadanych: Base64 z bajtów skrótu, nie z zapisu szesnastkowego (5.6.0, s. 25). */
export function skrotBase64(algorytm: 'md5' | 'sha256', dane: Buffer): string {
  return createHash(algorytm).update(dane).digest('base64');
}

import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  bytesToBase64,
  certificateKeyUsage,
  classifyKsefFile,
  MAX_KSEF_FILE_BYTES,
} from '@/lib/ksef/certificate-files';
import { prepareKsefCredentials } from '@/lib/ksef/connect-credentials';
import { makeRsaPrivateKey, makeSelfSignedCertificate, PKCS8_HEADER, type TestKeyKind } from '../helpers/self-signed-cert';

const NIP = '1234567890';
const PASSWORD = 'Haslo-testowe-15-znakow!';
const run = (certificate: Buffer, privateKey: Buffer, password?: string) =>
  prepareKsefCredentials({ certificate, privateKey, password });
const pem = (text: string) => Buffer.from(text, 'utf8');
function encryptedPkcs8(key: KeyObject, format: 'pem'): string;
function encryptedPkcs8(key: KeyObject, format: 'der'): Buffer;
function encryptedPkcs8(key: KeyObject, format: 'pem' | 'der'): string | Buffer {
  const options = { type: 'pkcs8' as const, cipher: 'aes-256-cbc', passphrase: PASSWORD };
  return format === 'pem' ? key.export({ ...options, format: 'pem' }) : key.export({ ...options, format: 'der' });
}

describe('rozpoznawanie plików z Aplikacji Podatnika po treści', () => {
  const rsa = makeSelfSignedCertificate({ kind: 'rsa', nip: NIP });
  const ec = makeSelfSignedCertificate({ kind: 'ec', nip: NIP });

  it('odróżnia certyfikat, klucz i klucz zaszyfrowany, w PEM i w DER', () => {
    expect(classifyKsefFile(pem(rsa.certPem))).toBe('certificate');
    expect(classifyKsefFile(rsa.certDer)).toBe('certificate');
    expect(classifyKsefFile(pem(ec.keyPem))).toBe('private-key');
    expect(classifyKsefFile(ec.privateKey.export({ type: 'pkcs8', format: 'der' }))).toBe('private-key');
    expect(classifyKsefFile(ec.privateKey.export({ type: 'sec1', format: 'der' }))).toBe('private-key');
    expect(classifyKsefFile(rsa.privateKey.export({ type: 'pkcs1', format: 'der' }))).toBe('private-key');
    expect(classifyKsefFile(pem(encryptedPkcs8(ec.privateKey, 'pem') as string))).toBe('encrypted-private-key');
    expect(classifyKsefFile(encryptedPkcs8(ec.privateKey, 'der') as Buffer)).toBe('encrypted-private-key');
    const traditional = rsa.privateKey.export({ type: 'pkcs1', format: 'pem', cipher: 'aes-256-cbc', passphrase: PASSWORD });
    expect(classifyKsefFile(pem(traditional as string))).toBe('encrypted-private-key');
  });

  it('plik z certyfikatem i kluczem naraz to pakiet, a śmieci i zbyt duże pliki są nieznane', () => {
    expect(classifyKsefFile(pem(rsa.certPem + rsa.keyPem))).toBe('bundle');
    expect(classifyKsefFile(pem('to nie jest certyfikat'))).toBe('unknown');
    expect(classifyKsefFile(new Uint8Array(0))).toBe('unknown');
    expect(classifyKsefFile(Buffer.alloc(MAX_KSEF_FILE_BYTES + 1, 0x30))).toBe('unknown');
    expect(classifyKsefFile(Buffer.from([0x30, 0x03, 0x02, 0x01, 0x00]))).toBe('unknown');
  });

  it('czyta przeznaczenie certyfikatu z rozszerzenia keyUsage', () => {
    const usage = (kind: 'authentication' | 'offline' | 'none') =>
      certificateKeyUsage(makeSelfSignedCertificate({ kind: 'ec', nip: NIP, usage: kind }).certDer);
    expect(usage('authentication')).toEqual({ digitalSignature: true, nonRepudiation: false });
    expect(usage('offline')).toEqual({ digitalSignature: false, nonRepudiation: true });
    expect(usage('none')).toBeNull();
  });

  it('koduje base64 tak samo jak Buffer', () => {
    expect(bytesToBase64(rsa.certDer)).toBe(rsa.certDer.toString('base64'));
  });
});

describe('przygotowanie poświadczeń KSeF z plików klienta', () => {
  it.each<TestKeyKind>(['rsa', 'ec'])('przyjmuje certyfikat i klucz %s w PEM i zapisuje klucz jako PKCS#8 bez hasła', (kind) => {
    const m = makeSelfSignedCertificate({ kind, nip: NIP });
    const result = run(pem(m.certPem), pem(m.keyPem));
    expect(result).toMatchObject({ ok: true, keyKind: kind });
    if (!result.ok) return;
    expect(result.privateKeyPem.startsWith(PKCS8_HEADER)).toBe(true);
    expect(result.certificatePem).toContain('BEGIN CERTIFICATE');
    expect(result.validTo.getTime()).toBeGreaterThan(Date.now());
  });

  it.each<TestKeyKind>(['rsa', 'ec'])('przyjmuje certyfikat i klucz %s w DER', (kind) => {
    const m = makeSelfSignedCertificate({ kind, nip: NIP });
    const result = run(m.certDer, m.privateKey.export({ type: 'pkcs8', format: 'der' }));
    expect(result).toMatchObject({ ok: true, keyKind: kind });
  });

  it('przyjmuje klucz EC w układzie SEC1 i klucz RSA w PKCS#1', () => {
    const ec = makeSelfSignedCertificate({ kind: 'ec', nip: NIP });
    const rsa = makeSelfSignedCertificate({ kind: 'rsa', nip: NIP });
    expect(run(pem(ec.certPem), pem(ec.privateKey.export({ type: 'sec1', format: 'pem' }) as string)).ok).toBe(true);
    expect(run(rsa.certDer, rsa.privateKey.export({ type: 'pkcs1', format: 'der' })).ok).toBe(true);
  });

  it.each<TestKeyKind>(['rsa', 'ec'])('rozszyfrowuje klucz %s zaszyfrowany hasłem (PEM i DER)', (kind) => {
    const m = makeSelfSignedCertificate({ kind, nip: NIP });
    const fromPem = run(pem(m.certPem), pem(encryptedPkcs8(m.privateKey, 'pem') as string), PASSWORD);
    const fromDer = run(m.certDer, encryptedPkcs8(m.privateKey, 'der') as Buffer, PASSWORD);
    for (const result of [fromPem, fromDer]) {
      expect(result).toMatchObject({ ok: true, keyKind: kind });
      if (result.ok) {
        // Do bazy idzie klucz bez hasła, a hasło nie zostaje w wyniku.
        expect(result.privateKeyPem.startsWith(PKCS8_HEADER)).toBe(true);
        expect(JSON.stringify(result)).not.toContain(PASSWORD);
      }
    }
  });

  it('rozszyfrowuje tradycyjny PEM RSA z nagłówkiem Proc-Type', () => {
    const m = makeSelfSignedCertificate({ kind: 'rsa', nip: NIP });
    const key = m.privateKey.export({ type: 'pkcs1', format: 'pem', cipher: 'aes-256-cbc', passphrase: PASSWORD }) as string;
    expect(run(pem(m.certPem), pem(key), PASSWORD).ok).toBe(true);
  });

  it('prosi o hasło, gdy klucz jest zaszyfrowany, a hasła brak lub jest puste', () => {
    const m = makeSelfSignedCertificate({ kind: 'ec', nip: NIP });
    const key = pem(encryptedPkcs8(m.privateKey, 'pem') as string);
    expect(run(pem(m.certPem), key)).toEqual({ ok: false, problem: 'password_required' });
    expect(run(pem(m.certPem), key, '')).toEqual({ ok: false, problem: 'password_required' });
  });

  it('odróżnia złe hasło od braku hasła i nie zdradza hasła w wyniku', () => {
    const m = makeSelfSignedCertificate({ kind: 'ec', nip: NIP });
    const result = run(pem(m.certPem), pem(encryptedPkcs8(m.privateKey, 'pem') as string), 'zupelnie-inne-haslo-1!');
    expect(result).toEqual({ ok: false, problem: 'password_wrong' });
  });

  // Recenzja #361, pkt 5: ok. 0,3% błędnych haseł daje po rozszyfrowaniu śmieci, które przypadkiem mają
  // poprawne dopełnienie, i OpenSSL zgłasza ERR_OSSL_UNSUPPORTED zamiast ERR_OSSL_BAD_DECRYPT. Klient
  // dostawał wtedy "nie możemy odczytać klucza" i szedł generować nowy certyfikat zamiast poprawić literówkę.
  it.each<[string, TestKeyKind, 'pem' | 'der']>([
    ['EC w PEM', 'ec', 'pem'],
    ['RSA w DER', 'rsa', 'der'],
  ])('klucz %s: 3000 błędnych haseł to zawsze password_wrong, także gdy OpenSSL nie mówi "bad decrypt"', (_name, kind, format) => {
    const m = makeSelfSignedCertificate({ kind, nip: NIP });
    const key = format === 'pem' ? pem(encryptedPkcs8(m.privateKey, 'pem')) : encryptedPkcs8(m.privateKey, 'der');
    const unexpected: Array<{ password: string; problem: string }> = [];

    for (let attempt = 0; attempt < 3000; attempt += 1) {
      const password = `zle-haslo-${attempt}`;
      const result = run(m.certDer, key, password);
      if (result.ok || result.problem !== 'password_wrong') unexpected.push({ password, problem: result.ok ? 'ok' : result.problem });
    }

    expect(unexpected).toEqual([]);
  });

  it('prawidłowe hasło po serii błędnych nadal otwiera klucz', () => {
    const m = makeSelfSignedCertificate({ kind: 'ec', nip: NIP });
    const key = pem(encryptedPkcs8(m.privateKey, 'pem'));
    for (let attempt = 0; attempt < 50; attempt += 1) run(m.certDer, key, `zle-haslo-${attempt}`);
    expect(run(m.certDer, key, PASSWORD)).toMatchObject({ ok: true, keyKind: 'ec' });
  });

  it('odrzuca klucz, który nie pasuje do certyfikatu', () => {
    const a = makeSelfSignedCertificate({ kind: 'ec', nip: NIP });
    const b = makeSelfSignedCertificate({ kind: 'ec', nip: NIP });
    expect(run(pem(a.certPem), pem(b.keyPem))).toEqual({ ok: false, problem: 'key_mismatch' });
  });

  it('z łańcucha certyfikatów wybiera ten, do którego pasuje klucz', () => {
    const leaf = makeSelfSignedCertificate({ kind: 'ec', nip: NIP });
    const other = makeSelfSignedCertificate({ kind: 'ec', nip: NIP });
    const result = run(pem(other.certPem + leaf.certPem), pem(leaf.keyPem));
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.certificatePem.replace(/\s/g, '')).toBe(leaf.certPem.replace(/\s/g, ''));
  });

  it('przyjmuje jeden plik PEM z certyfikatem i kluczem podany w obu polach', () => {
    const m = makeSelfSignedCertificate({ kind: 'ec', nip: NIP });
    const bundle = pem(m.certPem + m.keyPem);
    expect(run(bundle, bundle).ok).toBe(true);
  });

  it('odrzuca certyfikat wygasły i jeszcze nieważny', () => {
    const day = 24 * 3600 * 1000;
    const expired = makeSelfSignedCertificate({
      kind: 'ec', nip: NIP, notBefore: new Date(Date.now() - 30 * day), notAfter: new Date(Date.now() - day),
    });
    const future = makeSelfSignedCertificate({
      kind: 'ec', nip: NIP, notBefore: new Date(Date.now() + 5 * day), notAfter: new Date(Date.now() + 400 * day),
    });
    expect(run(pem(expired.certPem), pem(expired.keyPem))).toMatchObject({ ok: false, problem: 'cert_expired' });
    expect(run(pem(future.certPem), pem(future.keyPem))).toMatchObject({ ok: false, problem: 'cert_not_yet_valid' });
  });

  it('odrzuca certyfikat typu Offline, a certyfikat bez keyUsage przepuszcza', () => {
    const offline = makeSelfSignedCertificate({ kind: 'ec', nip: NIP, usage: 'offline' });
    const plain = makeSelfSignedCertificate({ kind: 'ec', nip: NIP, usage: 'none' });
    expect(run(pem(offline.certPem), pem(offline.keyPem))).toMatchObject({ ok: false, problem: 'cert_offline' });
    expect(run(pem(plain.certPem), pem(plain.keyPem)).ok).toBe(true);
  });

  it('odrzuca niedozwolone rodzaje kluczy zanim porówna je z certyfikatem', () => {
    const cert = makeSelfSignedCertificate({ kind: 'ec', nip: NIP });
    const weakRsa = makeRsaPrivateKey(1024);
    const p384 = generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).privateKey;
    const ed25519 = generateKeyPairSync('ed25519').privateKey;
    for (const key of [weakRsa, p384, ed25519]) {
      expect(run(pem(cert.certPem), pem(key.export({ type: 'pkcs8', format: 'pem' }) as string))).toEqual({
        ok: false,
        problem: 'key_unsupported',
      });
    }
  });

  it('odróżnia pomylone i nieczytelne pliki', () => {
    const m = makeSelfSignedCertificate({ kind: 'ec', nip: NIP });
    expect(run(pem(m.keyPem), pem(m.keyPem))).toEqual({ ok: false, problem: 'cert_unreadable' });
    expect(run(pem(m.certPem), pem(m.certPem))).toEqual({ ok: false, problem: 'key_unreadable' });
    expect(run(pem('śmieci'), pem(m.keyPem))).toEqual({ ok: false, problem: 'cert_unreadable' });
    expect(run(pem(m.certPem), Buffer.from([0x30, 0x82, 0x00]))).toEqual({ ok: false, problem: 'key_unreadable' });
  });
});

import { createCipheriv, pbkdf2Sync, randomBytes, scryptSync, type KeyObject } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { prepareKsefCredentials } from '@/lib/ksef/connect-credentials';
import { makeSelfSignedCertificate, type TestKeyKind } from '../helpers/self-signed-cert';

/**
 * Recenzja #361, pkt 1: `createPrivateKey` z hasłem jest synchroniczne, a liczbę
 * iteracji PBKDF2 podaje plik klienta. Zaszyfrowany klucz ma ok. 150 bajtów, więc
 * mały plik z ogromnym `iterationCount` zatrzymałby pętlę zdarzeń całego procesu
 * na minuty, i to PRZED limitem prób. Dlatego koszt wyprowadzania klucza czytamy
 * z DER sami, a OpenSSL dostaje tylko to, co policzy w rozsądnym czasie.
 *
 * `createPrivateKey` podstawiamy szpiegiem: w testach „bomby” szpieg kończy od razu,
 * bo prawdziwy OpenSSL liczyłby te iteracje do końca. W testach prawdziwych kluczy
 * deleguje do prawdziwej funkcji.
 */

const openssl = vi.hoisted(() => ({ createPrivateKey: vi.fn() }));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, createPrivateKey: openssl.createPrivateKey };
});

const real = await vi.importActual<typeof import('node:crypto')>('node:crypto');

const NIP = '1234567890';
const PASSWORD = 'Haslo-testowe-15-znakow!';

/** Jak OpenSSL, gdy hasło nie pasuje: kończy od razu, nic nie liczy. */
function failFast(): never {
  throw Object.assign(new Error('error:1C800064:Provider routines::bad decrypt'), { code: 'ERR_OSSL_BAD_DECRYPT' });
}

// ── Minimalny koder DER (tylko to, czego potrzebuje EncryptedPrivateKeyInfo) ──

const lengthBytes = (n: number) =>
  n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 0xff]);
const tlv = (tag: number, ...parts: Buffer[]) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), lengthBytes(body.length), body]);
};
const seq = (...parts: Buffer[]) => tlv(0x30, ...parts);
const octets = (bytes: Buffer) => tlv(0x04, bytes);
const nul = Buffer.from([0x05, 0x00]);

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

/** Liczba całkowita DER; `Buffer` podaje surowe bajty wartości (dla liczb, których nie mieści `number`). */
function integer(value: Buffer | number): Buffer {
  if (Buffer.isBuffer(value)) return tlv(0x02, value);
  const bytes: number[] = [];
  let rest = value;
  do {
    bytes.unshift(rest % 256);
    rest = Math.floor(rest / 256);
  } while (rest > 0);
  if (bytes[0]! & 0x80) bytes.unshift(0);
  return tlv(0x02, Buffer.from(bytes));
}

const OID = {
  pbes2: '1.2.840.113549.1.5.13',
  pbkdf2: '1.2.840.113549.1.5.12',
  scrypt: '1.3.6.1.4.1.11591.4.11',
  hmacSha256: '1.2.840.113549.2.9',
  aes256Cbc: '2.16.840.1.101.3.4.1.42',
  pbeSha1Des: '1.2.840.113549.1.5.10',
  pkcs12Sha1TripleDes: '1.2.840.113549.1.12.1.3',
};

function aes(key: Buffer, iv: Buffer, plain: Buffer): Buffer {
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([cipher.update(plain), cipher.final()]);
}

/** PBES2 z PBKDF2-HMAC-SHA256 i AES-256-CBC. Bez `plain` dane są losowe: plik „bomba” nigdy nie jest odszyfrowywany. */
function pbkdf2Key(iterations: Buffer | number, plain?: Buffer, password = PASSWORD): Buffer {
  const salt = randomBytes(16);
  const iv = randomBytes(16);
  if (plain && typeof iterations !== 'number') throw new Error('prawdziwe szyfrowanie wymaga liczby iteracji jako number');
  const data = plain && typeof iterations === 'number'
    ? aes(pbkdf2Sync(password, salt, iterations, 32, 'sha256'), iv, plain)
    : randomBytes(48);
  return seq(
    seq(
      oid(OID.pbes2),
      seq(
        seq(oid(OID.pbkdf2), seq(octets(salt), integer(iterations), seq(oid(OID.hmacSha256), nul))),
        seq(oid(OID.aes256Cbc), octets(iv)),
      ),
    ),
    octets(data),
  );
}

/** PBES2 ze scrypt: OpenSSL ma dla niego limit pamięci, więc zostaje bez sprawdzania. */
function scryptKey(plain: Buffer, password = PASSWORD): Buffer {
  const salt = randomBytes(16);
  const iv = randomBytes(16);
  const key = scryptSync(password, salt, 32, { N: 1024, r: 8, p: 1 });
  return seq(
    seq(
      oid(OID.pbes2),
      seq(
        seq(oid(OID.scrypt), seq(octets(salt), integer(1024), integer(8), integer(1), integer(32))),
        seq(oid(OID.aes256Cbc), octets(iv)),
      ),
    ),
    octets(aes(key, iv, plain)),
  );
}

/** Starsze schematy: PBES1 (PKCS#5 v1.5) i PBE z PKCS#12 mają tylko sól i liczbę iteracji. */
function legacyKey(algorithm: string, iterations: number): Buffer {
  return seq(seq(oid(algorithm), seq(octets(randomBytes(8)), integer(iterations))), octets(randomBytes(24)));
}

const pemOf = (label: string, der: Buffer) =>
  `-----BEGIN ${label}-----\n${(der.toString('base64').match(/.{1,64}/g) ?? []).join('\n')}\n-----END ${label}-----\n`;

/** Ten sam klucz jako DER i jako PEM z etykietą zaszyfrowanego klucza. */
const FORMS: ReadonlyArray<readonly [string, (der: Buffer) => Buffer]> = [
  ['DER', (der) => der],
  ['PEM', (der) => Buffer.from(pemOf('ENCRYPTED PRIVATE KEY', der))],
];

function prepare(kind: TestKeyKind, privateKey: (material: ReturnType<typeof makeSelfSignedCertificate>) => Buffer, password?: string) {
  const material = makeSelfSignedCertificate({ kind, nip: NIP });
  return prepareKsefCredentials({ certificate: material.certDer, privateKey: privateKey(material), password });
}

const pkcs8 = (key: KeyObject) => key.export({ type: 'pkcs8', format: 'der' });

beforeEach(() => {
  openssl.createPrivateKey.mockReset();
});

describe('klucz z hasłem: koszt wyprowadzania klucza sprawdzamy przed OpenSSL', () => {
  beforeEach(() => {
    openssl.createPrivateKey.mockImplementation(failFast);
  });

  const BOMBS: ReadonlyArray<readonly [string, () => Buffer]> = [
    ['PBKDF2, 2 000 001 iteracji (o jedną ponad limit)', () => pbkdf2Key(2_000_001)],
    ['PBKDF2, 2^31 - 1 iteracji (ok. dwóch minut pracy OpenSSL)', () => pbkdf2Key(2 ** 31 - 1)],
    ['PBKDF2, liczba iteracji większa niż 64 bity (11 bajtów)', () => pbkdf2Key(Buffer.concat([Buffer.from([0x01]), Buffer.alloc(10)]))],
    ['PBES1 (SHA-1 i DES), 50 mln iteracji', () => legacyKey(OID.pbeSha1Des, 50_000_000)],
    ['PKCS#12 (SHA-1 i 3DES), 50 mln iteracji', () => legacyKey(OID.pkcs12Sha1TripleDes, 50_000_000)],
  ];

  describe.each(FORMS)('plik %s', (_format, wrap) => {
    it.each(BOMBS)('%s: key_unreadable i OpenSSL nie dostaje klucza', (_name, build) => {
      expect(prepare('ec', () => wrap(build()), PASSWORD)).toEqual({ ok: false, problem: 'key_unreadable' });
      expect(openssl.createPrivateKey).not.toHaveBeenCalled();
    });

    it('bez hasła „bomba” też jest nieczytelnym plikiem, a nie prośbą o hasło', () => {
      expect(prepare('ec', () => wrap(pbkdf2Key(2 ** 31 - 1)))).toEqual({ ok: false, problem: 'key_unreadable' });
      expect(openssl.createPrivateKey).not.toHaveBeenCalled();
    });

    const UNREADABLE: ReadonlyArray<readonly [string, () => Buffer]> = [
      ['zero iteracji', () => pbkdf2Key(0)],
      ['ujemna liczba iteracji', () => seq(seq(oid(OID.pbes2), seq(seq(oid(OID.pbkdf2), seq(octets(randomBytes(16)), tlv(0x02, Buffer.from([0x80])))), seq(oid(OID.aes256Cbc), octets(randomBytes(16))))), octets(randomBytes(48)))],
      ['PBKDF2 bez liczby iteracji', () => seq(seq(oid(OID.pbes2), seq(seq(oid(OID.pbkdf2), seq(octets(randomBytes(16)))), seq(oid(OID.aes256Cbc), octets(randomBytes(16))))), octets(randomBytes(48)))],
      ['PBES2 bez parametrów', () => seq(seq(oid(OID.pbes2)), octets(randomBytes(48)))],
      ['nieznana funkcja wyprowadzania klucza w PBES2', () => seq(seq(oid(OID.pbes2), seq(seq(oid('1.2.3.4'), seq(octets(randomBytes(16)), integer(1000))), seq(oid(OID.aes256Cbc), octets(randomBytes(16))))), octets(randomBytes(48)))],
      ['nieznany algorytm szyfrowania', () => legacyKey('1.2.3.4', 1000)],
      ['brak zaszyfrowanych danych', () => seq(seq(oid(OID.pbes2), seq(seq(oid(OID.pbkdf2), seq(octets(randomBytes(16)), integer(1000))))))],
      ['uszkodzony identyfikator algorytmu', () => seq(seq(tlv(0x06, Buffer.from([0x2a, 0x86]))), octets(randomBytes(48)))],
    ];

    it.each(UNREADABLE)('%s: key_unreadable bez OpenSSL', (_name, build) => {
      expect(prepare('ec', () => wrap(build()), PASSWORD)).toEqual({ ok: false, problem: 'key_unreadable' });
      expect(openssl.createPrivateKey).not.toHaveBeenCalled();
    });

    it('limit to 2 000 000 iteracji: dokładnie tyle OpenSSL jeszcze dostaje', () => {
      expect(prepare('ec', () => wrap(pbkdf2Key(2_000_000)), PASSWORD)).toEqual({ ok: false, problem: 'password_wrong' });
      expect(openssl.createPrivateKey).toHaveBeenCalledTimes(1);
    });

    it('starsze schematy w granicach limitu dochodzą do OpenSSL', () => {
      for (const algorithm of [OID.pbeSha1Des, OID.pkcs12Sha1TripleDes]) {
        openssl.createPrivateKey.mockClear();
        expect(prepare('ec', () => wrap(legacyKey(algorithm, 2048)), PASSWORD)).toEqual({ ok: false, problem: 'password_wrong' });
        expect(openssl.createPrivateKey).toHaveBeenCalledTimes(1);
      }
    });
  });
});

describe('klucze, które mają nadal działać (prawdziwy OpenSSL)', () => {
  beforeEach(() => {
    openssl.createPrivateKey.mockImplementation(real.createPrivateKey);
  });

  it.each<TestKeyKind>(['rsa', 'ec'])('klucz %s z hasłem z generateKeyPairSync, w PEM i w DER', (kind) => {
    const material = makeSelfSignedCertificate({ kind, nip: NIP });
    const options = { type: 'pkcs8' as const, cipher: 'aes-256-cbc', passphrase: PASSWORD };
    const forms = [
      Buffer.from(material.privateKey.export({ ...options, format: 'pem' }) as string),
      material.privateKey.export({ ...options, format: 'der' }),
    ];
    for (const privateKey of forms) {
      expect(prepareKsefCredentials({ certificate: material.certDer, privateKey, password: PASSWORD })).toMatchObject({ ok: true, keyKind: kind });
    }
    expect(openssl.createPrivateKey).toHaveBeenCalledTimes(2);
  });

  it.each([2048, 600_000, 2_000_000])('klucz z %i iteracji PBKDF2 (do limitu włącznie) jest odczytywany', (iterations) => {
    const material = makeSelfSignedCertificate({ kind: 'ec', nip: NIP });
    const key = pbkdf2Key(iterations, pkcs8(material.privateKey));
    for (const [, wrap] of FORMS) {
      expect(prepareKsefCredentials({ certificate: material.certDer, privateKey: wrap(key), password: PASSWORD })).toMatchObject({ ok: true, keyKind: 'ec' });
    }
  });

  it('klucz ze scrypt zostaje jak dotąd (OpenSSL pilnuje jego pamięci)', () => {
    const material = makeSelfSignedCertificate({ kind: 'ec', nip: NIP });
    const key = scryptKey(pkcs8(material.privateKey));
    for (const [, wrap] of FORMS) {
      expect(prepareKsefCredentials({ certificate: material.certDer, privateKey: wrap(key), password: PASSWORD })).toMatchObject({ ok: true, keyKind: 'ec' });
    }
  });

  it('zwykły klucz bez hasła i tradycyjny PEM z Proc-Type nie mają czego sprawdzać i działają jak dotąd', () => {
    const material = makeSelfSignedCertificate({ kind: 'rsa', nip: NIP });
    const traditional = material.privateKey.export({ type: 'pkcs1', format: 'pem', cipher: 'aes-256-cbc', passphrase: PASSWORD }) as string;

    expect(prepareKsefCredentials({ certificate: material.certDer, privateKey: Buffer.from(traditional), password: PASSWORD })).toMatchObject({ ok: true });
    expect(prepareKsefCredentials({ certificate: material.certDer, privateKey: Buffer.from(material.keyPem) })).toMatchObject({ ok: true });
  });
});

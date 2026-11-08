import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

/**
 * Programowy uwierzytelniacz dla testów końcówek logowania biometrią.
 *
 * Buduje prawdziwe struktury WebAuthn (authenticatorData, attestationObject
 * `none`, podpis ES256), żeby `@simplewebauthn/server` weryfikował je tak jak
 * w produkcji. Przez to testy końcówek mockują tylko bazę i GoTrue, a nie
 * samą kryptografię (AGENTS.md, „Protokół naprawy błędu”, pkt 2).
 * Przeglądarkę i wirtualny uwierzytelniacz CDP sprawdza `e2e/tests/09-biometria.spec.ts`.
 */

const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;
const FLAG_BACKUP_ELIGIBLE = 0x08;
const FLAG_BACKED_UP = 0x10;
const FLAG_ATTESTED = 0x40;
const ZERO_AAGUID = Buffer.alloc(16);

type Cbor = number | string | Uint8Array | Map<Cbor, Cbor>;

function cborHead(major: number, length: number): Buffer {
  if (length < 24) return Buffer.from([(major << 5) | length]);
  if (length < 256) return Buffer.from([(major << 5) | 24, length]);
  const out = Buffer.alloc(3);
  out[0] = (major << 5) | 25;
  out.writeUInt16BE(length, 1);
  return out;
}

/** Tyle CBOR, ile trzeba na klucz COSE i attestationObject. */
function cbor(value: Cbor): Buffer {
  if (typeof value === 'number') return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
  if (typeof value === 'string') {
    const text = Buffer.from(value, 'utf8');
    return Buffer.concat([cborHead(3, text.length), text]);
  }
  if (value instanceof Map) {
    const parts = [...value.entries()].flatMap(([key, entry]) => [cbor(key), cbor(entry)]);
    return Buffer.concat([cborHead(5, value.size), ...parts]);
  }
  return Buffer.concat([cborHead(2, value.length), Buffer.from(value)]);
}

const sha256 = (data: Uint8Array): Buffer => createHash('sha256').update(data).digest();
const base64url = (data: Uint8Array): string => Buffer.from(data).toString('base64url');

export interface SoftAuthenticatorOptions {
  rpId: string;
  origin: string;
  /** `false` udaje urządzenie bez biometrii i PIN-u (brak flagi UV). */
  userVerified?: boolean;
}

export class SoftAuthenticator {
  readonly credentialId: Buffer = randomBytes(32);
  readonly id: string = this.credentialId.toString('base64url');
  /** Klucz publiczny COSE w base64url: tak leży w `user_passkeys.public_key`. */
  readonly publicKey: string;
  counter = 0;
  rpId: string;
  origin: string;
  userVerified: boolean;
  private readonly privateKey: KeyObject;
  private readonly coseKey: Buffer;

  constructor(options: SoftAuthenticatorOptions) {
    this.rpId = options.rpId;
    this.origin = options.origin;
    this.userVerified = options.userVerified ?? true;
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.privateKey = privateKey;
    const jwk = publicKey.export({ format: 'jwk' });
    this.coseKey = cbor(new Map<Cbor, Cbor>([
      [1, 2], // kty: EC2
      [3, -7], // alg: ES256
      [-1, 1], // crv: P-256
      [-2, Buffer.from(jwk.x!, 'base64url')],
      [-3, Buffer.from(jwk.y!, 'base64url')],
    ]));
    this.publicKey = this.coseKey.toString('base64url');
  }

  private flags(extra = 0): number {
    return FLAG_USER_PRESENT | (this.userVerified ? FLAG_USER_VERIFIED : 0) | FLAG_BACKUP_ELIGIBLE | FLAG_BACKED_UP | extra;
  }

  private clientData(type: 'webauthn.create' | 'webauthn.get', challenge: string): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin: this.origin, crossOrigin: false }), 'utf8');
  }

  private counterBytes(): Buffer {
    const out = Buffer.alloc(4);
    out.writeUInt32BE(this.counter, 0);
    return out;
  }

  /** Odpowiedź `navigator.credentials.create()` w formacie JSON (attestation `none`). */
  register(challenge: string) {
    const clientDataJSON = this.clientData('webauthn.create', challenge);
    const credentialLength = Buffer.alloc(2);
    credentialLength.writeUInt16BE(this.credentialId.length, 0);
    const authData = Buffer.concat([
      sha256(Buffer.from(this.rpId, 'utf8')),
      Buffer.from([this.flags(FLAG_ATTESTED)]),
      this.counterBytes(),
      ZERO_AAGUID,
      credentialLength,
      this.credentialId,
      this.coseKey,
    ]);
    const attestationObject = cbor(new Map<Cbor, Cbor>([
      ['fmt', 'none'],
      ['attStmt', new Map<Cbor, Cbor>()],
      ['authData', authData],
    ]));
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key' as const,
      response: {
        clientDataJSON: base64url(clientDataJSON),
        attestationObject: base64url(attestationObject),
        transports: ['internal' as const],
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform' as const,
    };
  }

  /** Odpowiedź `navigator.credentials.get()`; każde użycie podbija licznik, chyba że `keepCounter`. */
  assert(challenge: string, options: { keepCounter?: boolean } = {}) {
    if (!options.keepCounter) this.counter += 1;
    const clientDataJSON = this.clientData('webauthn.get', challenge);
    const authenticatorData = Buffer.concat([
      sha256(Buffer.from(this.rpId, 'utf8')),
      Buffer.from([this.flags()]),
      this.counterBytes(),
    ]);
    const signature = sign('sha256', Buffer.concat([authenticatorData, sha256(clientDataJSON)]), this.privateKey);
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key' as const,
      response: {
        clientDataJSON: base64url(clientDataJSON),
        authenticatorData: base64url(authenticatorData),
        signature: base64url(signature),
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform' as const,
    };
  }
}

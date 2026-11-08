import { createSign, generateKeyPairSync } from 'node:crypto';

/**
 * Token GoTrue podpisany kluczem asymetrycznym i JWKS do niego. Przy takim
 * tokenie `getClaims()` weryfikuje podpis lokalnie, bez `/auth/v1/user`. Przy
 * HS256 ten sam `getClaims()` woła GoTrue, więc oba tryby mają inne wyjścia
 * z `updateSession`.
 */
const KID = 'fixture-es256';
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });

export function signEs256Jwt(payload: Record<string, unknown>): string {
  const b64url = (value: string) => Buffer.from(value).toString('base64url');
  const signed = `${b64url(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid: KID }))}.${b64url(JSON.stringify(payload))}`;
  const signature = createSign('SHA256').update(signed).sign({ key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `${signed}.${signature.toString('base64url')}`;
}

export const ES256_JWKS = {
  keys: [{ ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'ES256', use: 'sig', key_ops: ['verify'] }],
};

import { z } from 'zod';

/**
 * Kształt odpowiedzi WebAuthn w JSON (ten sam z przeglądarki i z natywnej wtyczki).
 * Tylko granice rozmiaru i typy: treść sprawdza `@simplewebauthn/server`.
 */

const MAX_FIELD_LENGTH = 16 * 1024;
const base64url = z.string().min(1).max(MAX_FIELD_LENGTH).regex(/^[A-Za-z0-9_-]+$/);
const credentialId = z.string().min(1).max(1024).regex(/^[A-Za-z0-9_-]+$/);
const attachment = z.enum(['platform', 'cross-platform']).optional();
const extensions = z.record(z.string(), z.unknown()).default({});

const authenticationResponse = z.object({
  id: credentialId,
  rawId: credentialId,
  type: z.literal('public-key'),
  response: z.object({
    clientDataJSON: base64url,
    authenticatorData: base64url,
    signature: base64url,
    // Część wtyczek natywnych przysyła null zamiast pominąć pole.
    userHandle: z.string().max(1024).regex(/^[A-Za-z0-9_-]*$/).nullish().transform((value) => value || undefined),
  }),
  clientExtensionResults: extensions,
  authenticatorAttachment: attachment,
});

const registrationResponse = z.object({
  id: credentialId,
  rawId: credentialId,
  type: z.literal('public-key'),
  response: z.object({
    clientDataJSON: base64url,
    attestationObject: base64url,
    authenticatorData: base64url.optional(),
    transports: z.array(z.string().max(32)).max(16).optional(),
    publicKeyAlgorithm: z.number().int().optional(),
    publicKey: base64url.optional(),
  }),
  clientExtensionResults: extensions,
  authenticatorAttachment: attachment,
});

export const loginVerifyBody = z.object({
  response: authenticationResponse,
  redirectTo: z.string().max(2048).optional(),
});

export const registerVerifyBody = z.object({
  response: registrationResponse,
  /** Nazwa z aplikacji natywnej; przeglądarka jej nie podaje (`deviceLabelFromUserAgent`). */
  deviceLabel: z.string().max(512).optional(),
});

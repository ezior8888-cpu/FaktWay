import { createHmac, hkdfSync } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createPasskeySessionMarker,
  passkeySessionCookieOptions,
  PASSKEY_SESSION_COOKIE,
  PASSKEY_SESSION_MAX_AGE_SECONDS,
  verifyPasskeySessionMarker,
} from '@/lib/auth/passkey/session-marker';

/**
 * Znacznik „ta sesja zaczęła się od asercji z weryfikacją użytkownika”.
 * Od niego zależy, czy konto z TOTP wejdzie do panelu bez kodu, więc każda
 * podmiana (podpis, sesja, konto, czas) musi go unieważnić.
 */

const SERVICE_ROLE = 'fixture-service-role-key-do-testow';
const subject = { sub: 'user-a', sessionId: 'session-a' };
const NOW = Date.UTC(2026, 10, 2, 12, 0, 0);

function flipLastCharacter(marker: string): string {
  const last = marker.at(-1)!;
  return marker.slice(0, -1) + (last === 'A' ? 'B' : 'A');
}

beforeEach(() => {
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', SERVICE_ROLE);
});
afterEach(() => vi.unstubAllEnvs());

describe('znacznik sesji passkey', () => {
  it('przyjmuje znacznik tej sesji i tego konta', async () => {
    const marker = await createPasskeySessionMarker(subject, () => NOW);
    await expect(verifyPasskeySessionMarker(marker, subject, () => NOW)).resolves.toBe(true);
  });

  it('jest ważny 30 dni i ani sekundy dłużej', async () => {
    expect(PASSKEY_SESSION_MAX_AGE_SECONDS).toBe(30 * 24 * 60 * 60);
    const marker = await createPasskeySessionMarker(subject, () => NOW);
    const justBefore = NOW + PASSKEY_SESSION_MAX_AGE_SECONDS * 1000 - 1000;
    const atExpiry = NOW + PASSKEY_SESSION_MAX_AGE_SECONDS * 1000;
    await expect(verifyPasskeySessionMarker(marker, subject, () => justBefore)).resolves.toBe(true);
    await expect(verifyPasskeySessionMarker(marker, subject, () => atExpiry)).resolves.toBe(false);
  });

  it('odrzuca sfałszowany podpis', async () => {
    const marker = await createPasskeySessionMarker(subject, () => NOW);
    await expect(verifyPasskeySessionMarker(flipLastCharacter(marker), subject, () => NOW)).resolves.toBe(false);
  });

  it('odrzuca znacznik innej sesji tego samego konta', async () => {
    const marker = await createPasskeySessionMarker(subject, () => NOW);
    await expect(verifyPasskeySessionMarker(marker, { ...subject, sessionId: 'session-b' }, () => NOW)).resolves.toBe(false);
  });

  it('odrzuca znacznik innego konta z tym samym identyfikatorem sesji', async () => {
    const marker = await createPasskeySessionMarker(subject, () => NOW);
    await expect(verifyPasskeySessionMarker(marker, { ...subject, sub: 'user-b' }, () => NOW)).resolves.toBe(false);
  });

  it('odrzuca przedłużenie: podmieniony czas ważności psuje podpis', async () => {
    const marker = await createPasskeySessionMarker(subject, () => NOW);
    const [version, expiry, mac] = marker.split('.');
    const extended = [version, String(Number(expiry) + 365 * 24 * 60 * 60), mac].join('.');
    await expect(verifyPasskeySessionMarker(extended, subject, () => NOW)).resolves.toBe(false);
  });

  it('odrzuca znacznik podpisany innym kluczem (po rotacji klucza serwisowego)', async () => {
    const marker = await createPasskeySessionMarker(subject, () => NOW);
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'inny-klucz-po-rotacji');
    await expect(verifyPasskeySessionMarker(marker, subject, () => NOW)).resolves.toBe(false);
  });

  it.each([
    [undefined], [null], [''], ['v1'], ['v1.abc.def'], ['v2.9999999999.AAAA'],
    ['v1.9999999999.' + 'A'.repeat(43) + '.dodatek'], ['x'.repeat(5000)],
  ])('odrzuca śmieci bez rzucania wyjątku: %j', async (value) => {
    await expect(verifyPasskeySessionMarker(value, subject, () => NOW)).resolves.toBe(false);
  });

  it('odrzuca brak identyfikatora sesji albo konta (token bez session_id)', async () => {
    const marker = await createPasskeySessionMarker(subject, () => NOW);
    await expect(verifyPasskeySessionMarker(marker, { ...subject, sessionId: '' }, () => NOW)).resolves.toBe(false);
    await expect(verifyPasskeySessionMarker(marker, { ...subject, sub: '' }, () => NOW)).resolves.toBe(false);
  });

  it('bez klucza serwisowego nie przepuszcza i nie wystawia', async () => {
    const marker = await createPasskeySessionMarker(subject, () => NOW);
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '');
    await expect(verifyPasskeySessionMarker(marker, subject, () => NOW)).resolves.toBe(false);
    await expect(createPasskeySessionMarker(subject, () => NOW)).rejects.toThrow();
  });

  it('klucz to HKDF z osobnym info, a podpis to HMAC po sub, sesji i czasie', async () => {
    // Niezależne wyliczenie: zmiana info albo układu danych unieważniłaby znaczniki
    // na produkcji, więc ma być świadoma.
    const marker = await createPasskeySessionMarker(subject, () => NOW);
    const [version, expiry, mac] = marker.split('.');
    const key = Buffer.from(hkdfSync('sha256', SERVICE_ROLE, Buffer.alloc(0), 'faktway/passkey-session-marker/v1', 32));
    const expected = createHmac('sha256', key).update(['v1', subject.sub, subject.sessionId, expiry].join('\n')).digest('base64url');
    expect(version).toBe('v1');
    expect(mac).toBe(expected);
    expect(Number(expiry)).toBe(Math.floor(NOW / 1000) + PASSKEY_SESSION_MAX_AGE_SECONDS);
  });
});

describe('ciasteczko znacznika', () => {
  it('ma stałą nazwę, jest httpOnly i SameSite=Lax na 30 dni', () => {
    expect(PASSKEY_SESSION_COOKIE).toBe('ksef.passkey_session');
    expect(passkeySessionCookieOptions()).toMatchObject({
      httpOnly: true, sameSite: 'lax', path: '/', maxAge: PASSKEY_SESSION_MAX_AGE_SECONDS,
    });
  });

  it('na produkcji jest Secure', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(passkeySessionCookieOptions().secure).toBe(true);
  });
});

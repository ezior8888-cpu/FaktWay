import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ unsubscribe: vi.fn() }));
vi.mock('@/lib/email/preferences', () => ({ unsubscribe: mocks.unsubscribe }));

import { POST } from '@/app/api/email/unsubscribe/route';
import { createUnsubscribeToken, verifyUnsubscribeToken } from '@/lib/email/unsubscribe-token';

/**
 * Rotacja `EMAIL_UNSUBSCRIBE_SECRET` (docs/runbooks/rotacja-kluczy.md, krok 2).
 * Token wypisu żyje 90 dni. Bez drugiego sekretu zmiana unieważniała każdy
 * link z tego okresu, a One-Click z Gmaila dostawał cicho `200 skipped`:
 * skrzynka pokazywała „wypisano”, a maile wychodziły dalej. Na czas rotacji
 * stary sekret leży w `EMAIL_UNSUBSCRIBE_SECRET_PREVIOUS`: podpis zawsze
 * bieżącym, weryfikacja bieżącym albo poprzednim.
 */

const userId = '11111111-1111-4111-8111-111111111111';
const stary = randomBytes(32).toString('hex');
const nowy = randomBytes(32).toString('hex');

function oneClick(token: string) {
  const url = new URL('https://example.test/api/email/unsubscribe');
  url.searchParams.set('t', token);
  return POST(new Request(url, { method: 'POST', body: 'List-Unsubscribe=One-Click' }));
}

/** Token wystawiony przed rotacją, czyli podpisany starym sekretem. */
function tokenSprzedRotacji() {
  vi.stubEnv('EMAIL_UNSUBSCRIBE_SECRET', stary);
  const token = createUnsubscribeToken(userId, 'marketing');
  vi.stubEnv('EMAIL_UNSUBSCRIBE_SECRET', nowy);
  return token;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.unsubscribe.mockResolvedValue(undefined);
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('wypis w trakcie rotacji sekretu', () => {
  it('link sprzed rotacji działa, gdy stary sekret jest w _PREVIOUS (One-Click zapisuje wypis)', async () => {
    const token = tokenSprzedRotacji();
    vi.stubEnv('EMAIL_UNSUBSCRIBE_SECRET_PREVIOUS', stary);

    expect(verifyUnsubscribeToken(token)).toEqual({ valid: true, userId, category: 'marketing' });
    await oneClick(token);
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(1);
    expect(mocks.unsubscribe.mock.calls[0]?.[0]).toMatchObject({ userId, category: 'marketing' });
  });

  it('bez _PREVIOUS link sprzed rotacji jest nieważny (zachowanie jak przed zmianą)', async () => {
    const token = tokenSprzedRotacji();

    expect(verifyUnsubscribeToken(token)).toEqual({ valid: false, reason: 'invalid_signature' });
    await oneClick(token);
    expect(mocks.unsubscribe).not.toHaveBeenCalled();
  });

  it('_PREVIOUS z innym sekretem niczego nie przepuszcza', () => {
    const token = tokenSprzedRotacji();
    vi.stubEnv('EMAIL_UNSUBSCRIBE_SECRET_PREVIOUS', randomBytes(32).toString('hex'));

    expect(verifyUnsubscribeToken(token)).toEqual({ valid: false, reason: 'invalid_signature' });
  });

  it('nowe linki są podpisane bieżącym sekretem: działają po usunięciu _PREVIOUS', () => {
    vi.stubEnv('EMAIL_UNSUBSCRIBE_SECRET', nowy);
    vi.stubEnv('EMAIL_UNSUBSCRIBE_SECRET_PREVIOUS', stary);
    const token = createUnsubscribeToken(userId, 'product_updates');

    vi.stubEnv('EMAIL_UNSUBSCRIBE_SECRET_PREVIOUS', '');
    expect(verifyUnsubscribeToken(token)).toEqual({ valid: true, userId, category: 'product_updates' });
  });

  it('za krótki _PREVIOUS jest pomijany, a nie traktowany jako klucz', () => {
    vi.stubEnv('EMAIL_UNSUBSCRIBE_SECRET', nowy);
    vi.stubEnv('EMAIL_UNSUBSCRIBE_SECRET_PREVIOUS', 'krotki');
    const token = createUnsubscribeToken(userId, 'marketing');

    expect(verifyUnsubscribeToken(token)).toEqual({ valid: true, userId, category: 'marketing' });
  });

  it('wygasły token ze starym sekretem zostaje wygasły', () => {
    vi.stubEnv('EMAIL_UNSUBSCRIBE_SECRET', stary);
    const token = createUnsubscribeToken(userId, 'marketing', -1);
    vi.stubEnv('EMAIL_UNSUBSCRIBE_SECRET', nowy);
    vi.stubEnv('EMAIL_UNSUBSCRIBE_SECRET_PREVIOUS', stary);

    expect(verifyUnsubscribeToken(token)).toEqual({ valid: false, reason: 'expired' });
  });
});

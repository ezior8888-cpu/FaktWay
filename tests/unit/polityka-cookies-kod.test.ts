import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

import { renderPlainText } from '@/lib/legal/doc-model';
import { POLITYKA_COOKIES } from '@/lib/legal/documents';

/**
 * Polityka cookies ↔ kod, w kierunku „kod → polityka”. Strażnik w
 * legal-dokumenty sprawdza, że klucze wymienione w polityce istnieją w kodzie;
 * ten sprawdza odwrotnie: każde miejsce, które zapisuje coś w przeglądarce
 * (cookie, localStorage, sessionStorage), ma swój wiersz w polityce.
 *
 * Skąd: plan Finora dodał menu boczne shadcn, które zapisuje cookie
 * `sidebar_state` na 7 dni — polityka (art. 399 PKE: informacja o każdym
 * zapisie w urządzeniu użytkownika) go nie wymieniała (przegląd 22.10.2026).
 *
 * Nowe miejsce zapisu = czerwony test: dopisz wiersz do
 * lib/legal/documents/polityka-cookies.ts i plik do mapy niżej.
 */

const ROOT = join(__dirname, '..', '..');
const SCANNED = ['app', 'components', 'lib', 'hooks'];
const WRITES = /document\.cookie\s*=|(?:localStorage|sessionStorage)\.setItem\(|cookieStore\.set\(|cookies\(\)\.set\(|\.cookies\.set\(/;

/** Plik zapisujący w przeglądarce → fragment wiersza polityki, który go opisuje. */
const KNOWN: Record<string, string> = {
  'components/ui/sidebar.tsx': 'sidebar_state',
  'components/dashboard/theme-toggle.tsx': 'motyw jasny lub ciemny',
  'hooks/use-install-prompt.ts': 'install-prompt-dismissed-at',
  'app/(dashboard)/_components/ksef-health-banner-client.tsx': 'klucze zamkniętych komunikatów',
  'lib/analytics/consent.ts': 'decyzji w sprawie analityki',
  // Pierwszy dotyk (FAKTWAY-1-0, pkt 7): tylko po zgodzie, 90 dni.
  'lib/analytics/attribution.ts': 'skąd do nas trafiłeś',
  // To samo ciasteczko: po rejestracji serwer zostawia w nim sam znacznik bez danych.
  'lib/analytics/funnel.ts': 'sam znacznik',
  'components/auth/passkey-enroll-offer.tsx': 'faktway.passkey_offer_dismissed',
  'components/auth/passkey-enroll-offer-gate.tsx': 'ksef.passkey_offer',
  'app/actions/organizations.ts': 'w której firmie (Organizacji) pracujesz',
  'lib/supabase/middleware.ts': 'utrzymanie zalogowanej sesji',
  'lib/supabase/server.ts': 'utrzymanie zalogowanej sesji',
  // Te same cookies sesji Supabase; trasa działa tylko przy LOAD_TEST_MODE
  // poza produkcją (isBypassAllowedEnv, fail-closed).
  'app/api/dev/load-test-session/route.ts': 'utrzymanie zalogowanej sesji',
};

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : walk(path);
    return /\.(tsx?|jsx?)$/.test(name) ? [path] : [];
  });
}

function filesWritingBrowserStorage(): string[] {
  return SCANNED.flatMap((dir) => walk(join(ROOT, dir)))
    .filter((file) => WRITES.test(readFileSync(file, 'utf8')))
    .map((file) => relative(ROOT, file).replaceAll('\\', '/'))
    .sort();
}

describe('polityka cookies wymienia każdy zapis w przeglądarce', () => {
  const policy = renderPlainText(POLITYKA_COOKIES, 'https://faktway.example').replace(/\s+/g, ' ');

  it('skaner widzi znane miejsca zapisu (inaczej test nic nie sprawdza)', () => {
    const found = filesWritingBrowserStorage();
    expect(found).toContain('components/ui/sidebar.tsx');
    expect(found).toContain('lib/analytics/consent.ts');
  });

  it('każdy plik zapisujący w przeglądarce jest przypisany do wiersza polityki', () => {
    const unknown = filesWritingBrowserStorage().filter((f) => !(f in KNOWN));
    expect(unknown).toEqual([]);
  });

  it.each(Object.entries(KNOWN))('%s: polityka opisuje zapis („%s”)', (_file, fragment) => {
    expect(policy).toContain(fragment);
  });
});

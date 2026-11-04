import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { siteUrl, SUPPORT_EMAIL } from '@/lib/site';
import { isPublicPath } from '@/lib/supabase/middleware';

/**
 * Krok 10 planu automatyzacji (MAN-18, MAN-19). W kodzie było siedem adresów
 * kontaktowych, w tym cztery w domenie `ksef-saas.pl`, której już nikt nie
 * ma zarejestrowanej — zgłoszenia, żądania RODO i prośby o zwrot mogły trafić
 * do obcej osoby. Sitemap i robots.txt wskazywały tę domenę wyszukiwarkom.
 */

const ROOT = join(__dirname, '..', '..');
const SCANNED = ['app', 'components', 'lib', 'content'];
const EXTENSIONS = /\.(tsx?|mdx?)$/;
// Adresy @faktway.pl dozwolone poza jedną skrzynką: nadawcy maili z konwencji
// w lib/email/send.ts (odpowiedzi idą na SUPPORT_EMAIL przez Reply-To) —
// te same co RESEND_FROM_* na produkcji.
const ALLOWED_FAKTWAY = new Set([SUPPORT_EMAIL, 'powiadomienia@faktway.pl', 'kontakt@faktway.pl']);
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : walk(path);
    return EXTENSIONS.test(name) ? [path] : [];
  });
}

function scan(pattern: RegExp): string[] {
  const hits: string[] = [];
  for (const dir of SCANNED) {
    for (const file of walk(join(ROOT, dir))) {
      const rel = relative(ROOT, file).replaceAll('\\', '/');
      if (rel === 'lib/site.ts') continue;
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        for (const m of line.matchAll(pattern)) hits.push(`${rel}:${i + 1} ${m[0]}`);
      });
    }
  }
  return hits;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('jeden adres kontaktowy', () => {
  it('żadnych odwołań do niezarejestrowanej domeny ksef-saas.pl', () => {
    expect(scan(/ksef-saas\.pl/g)).toEqual([]);
  });

  it('adresy @faktway.pl tylko z listy (jedna skrzynka + nadawca no-reply)', () => {
    const others = scan(/[a-z0-9._-]+@(?:[a-z0-9-]+\.)*faktway\.pl/gi)
      .filter((hit) => !ALLOWED_FAKTWAY.has(hit.split(' ').at(-1) ?? ''));
    expect(others).toEqual([]);
  });

  // Zmiana marki 10.2026: ostatnie adresy w dawnej domenie (lustro tekstów RAISE
  // z 00148) przepisała migracja 00151. Skrzynka w dawnej domenie dalej odbiera
  // pocztę (ops/poczta/worker.mjs) — dla starych maili, nie dla nowych tekstów.
  it('żadnych adresów @faktflow.pl (zmiana marki)', () => {
    expect(scan(/[a-z0-9._-]+@(?:[a-z0-9-]+\.)*faktflow\.pl/gi)).toEqual([]);
  });

  it('adres strony z NEXT_PUBLIC_APP_URL, bez końcowego ukośnika; domyślnie faktway.pl', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://faktway.pl/');
    expect(siteUrl()).toBe('https://faktway.pl');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '');
    expect(siteUrl()).toBe('https://faktway.pl');
    expect(SUPPORT_EMAIL).toBe('pomoc@faktway.pl');
  });
});

describe('ścieżki dla wyszukiwarek i podglądów linków są publiczne', () => {
  it.each(['/robots.txt', '/sitemap.xml', '/opengraph-image'])('%s bez logowania', (path) => {
    expect(isPublicPath(path)).toBe(true);
  });

  it.each(['/robots.txt/x', '/sitemap.xml.bak', '/dashboard', '/settings/billing'])('%s nadal chronione', (path) => {
    expect(isPublicPath(path)).toBe(false);
  });
});

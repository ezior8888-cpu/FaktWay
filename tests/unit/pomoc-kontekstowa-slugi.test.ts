import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { getContextualArticleSlugs } from '@/lib/support/contextual-help';

// „Slugi muszą się zgadzać z plikami `content/help/*.mdx`” (komentarz
// w lib/support/contextual-help.ts) — dotąd nikt tego nie sprawdzał.
// 19.10.2026: trasa `/przeplywy` linkowała `pierwsze-kroki-w-faktflow`,
// artykuł sprzed zmiany marki (dziś `pierwsze-kroki-w-faktway`).

const ROOT = join(__dirname, '..', '..');
const SOURCE = readFileSync(join(ROOT, 'lib/support/contextual-help.ts'), 'utf8');
const PREFIXES = [...SOURCE.matchAll(/prefix:\s*'([^']+)'/g)].map((m) => m[1]);

describe('pomoc kontekstowa: artykuły istnieją', () => {
  it('lista tras odczytana z pliku', () => {
    expect(PREFIXES.length).toBeGreaterThan(10);
  });

  it.each(PREFIXES)('%s — każdy artykuł jest w content/help', (prefix) => {
    const slugs = getContextualArticleSlugs(prefix);
    expect(slugs.length).toBeGreaterThan(0);
    const missing = slugs.filter((slug) => !existsSync(join(ROOT, 'content/help', `${slug}.mdx`)));
    expect(missing).toEqual([]);
  });
});

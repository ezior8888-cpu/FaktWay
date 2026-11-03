import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import matter from 'gray-matter';
import { describe, expect, it } from 'vitest';

import { getAllHelpArticles, HELP_CATEGORIES } from '@/lib/help/articles';

/**
 * Sześć artykułów o agencie (krok 36). FaktWay 1.0: FLO znika z obietnic,
 * więc leżą poza `content/help` (kod FLO zostaje w repozytorium, tak samo
 * jego teksty) i nie ma ich w `/pomoc` ani w bazie wiedzy czatu.
 */

const DIR = join(process.cwd(), 'content/flo/pomoc');
const files = readdirSync(DIR).filter((f) => f.endsWith('.mdx'));

describe('baza wiedzy o agencie poza pomocą publiczną', () => {
  it('sześć artykułów leży w content/flo/pomoc', () => {
    expect(files.map((f) => f.replace(/\.mdx$/, '')).sort()).toEqual([
      'flo-cisza',
      'flo-cofanie',
      'flo-czym-jest',
      'flo-dlaczego-pyta',
      'flo-dlaczego-to-widze',
      'flo-wyciszanie',
    ]);
  });

  it('każdy ma streszczenie i treść, gdyby wróciły do panelu', () => {
    for (const file of files) {
      const { data, content } = matter(readFileSync(join(DIR, file), 'utf8'));
      expect(String(data.summary).length).toBeGreaterThan(30);
      expect(content.length).toBeGreaterThan(400);
    }
  });

  it('pomoc publiczna ich nie wczytuje', () => {
    expect(HELP_CATEGORIES.some((c) => (c.id as string) === 'flo')).toBe(false);
    expect(getAllHelpArticles().filter((a) => a.slug.startsWith('flo-'))).toEqual([]);
  });
});

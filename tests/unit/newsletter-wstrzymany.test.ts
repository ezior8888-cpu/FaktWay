import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Zapis na newsletter jest NIEPODPIĘTY (przegląd prawny 22.10.2026).
 *
 * `BlogNewsletterForm` i `subscribeNewsletterAction` istnieją, ale żaden ekran
 * ich nie używa — i tak ma zostać, dopóki nie ma prawdziwego newslettera:
 *  - potwierdzenia zapisu (double opt-in) — bez niego każdy może zapisać
 *    cudzy adres, a wysyłka do niego narusza art. 398 Prawa komunikacji
 *    elektronicznej (informacja handlowa tylko za uprzednią zgodą);
 *  - zapisu wersji brzmienia zgody i daty (art. 7 ust. 1 RODO — wykazanie
 *    zgody); dziś tabela ma tylko e-mail i datę;
 *  - linku wypisu w każdej wiadomości — klauzula formularza go obiecuje,
 *    a wysyłki i wypisu nie ma.
 *
 * Podpięcie formularza = czerwony test. Zbuduj powyższe, potem zmień test.
 */

const ROOT = join(__dirname, '..', '..');
const SCANNED = ['app', 'components', 'lib', 'content', 'hooks'];
const OWN_FILES = new Set(['components/marketing/blog-newsletter-form.tsx', 'app/actions/newsletter.ts']);
const USES = /BlogNewsletterForm|subscribeNewsletterAction|blog-newsletter-form|actions\/newsletter/;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : walk(path);
    return /\.(tsx?|jsx?|mdx?)$/.test(name) ? [path] : [];
  });
}

function filesUsingNewsletter(): string[] {
  return SCANNED.flatMap((dir) => walk(join(ROOT, dir)))
    .filter((file) => USES.test(readFileSync(file, 'utf8')))
    .map((file) => relative(ROOT, file).replaceAll('\\', '/'))
    .sort();
}

describe('newsletter niepodpięty do czasu double opt-in, wypisu i zapisu zgody', () => {
  it('skaner widzi znany import (formularz → akcja), inaczej test nic nie sprawdza', () => {
    expect(filesUsingNewsletter()).toContain('components/marketing/blog-newsletter-form.tsx');
  });

  it('formularz i akcja zapisu nie są używane poza własnymi plikami', () => {
    expect(filesUsingNewsletter().filter((f) => !OWN_FILES.has(f))).toEqual([]);
  });
});

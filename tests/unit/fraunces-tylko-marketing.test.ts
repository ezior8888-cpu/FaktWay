import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Fraunces (klasy `.font-editorial`, `.editorial-section-num`) rysują tylko
 * strony marketingowe. Do 24.10.2026 font był zadeklarowany w root layoucie,
 * a `next/font` preładowuje fonty z layoutu na każdej trasie pod nim — panel
 * pobierał na każdej stronie ~220 KB Fraunces, których nie używał.
 *
 * Teraz zmienną `--font-fraunces` ustawia tylko `app/(marketing)/layout.tsx`.
 * Klasa użyta poza tą grupą nie dostanie fontu (spadnie na Georgię), więc
 * test pilnuje obu stron: root layout bez Fraunces, klasy tylko w marketingu.
 */

const ROOT = join(__dirname, '..', '..');
const SCANNED = ['app', 'components', 'lib', 'content'];
const EXTENSIONS = /\.(tsx?|mdx?)$/;
const FRAUNCES_CLASSES = /\b(font-editorial|editorial-section-num)\b/;
const MARKETING_GROUP = 'app/(marketing)/';

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...files(full));
    else if (EXTENSIONS.test(name)) out.push(full);
  }
  return out;
}

const SOURCES = SCANNED.flatMap((d) => files(join(ROOT, d))).map((f) => ({
  path: relative(ROOT, f),
  text: readFileSync(f, 'utf8'),
}));

describe('Fraunces tylko na stronach marketingowych', () => {
  it('root layout nie deklaruje Fraunces (inaczej panel pobiera go na każdej stronie)', () => {
    const rootLayout = readFileSync(join(ROOT, 'app/layout.tsx'), 'utf8');
    expect(rootLayout).not.toMatch(/import\s*{[^}]*\bFraunces\b[^}]*}\s*from\s*'next\/font\/google'/);
    expect(rootLayout).not.toContain('fraunces.variable');
  });

  it('layout marketingu ustawia zmienną --font-fraunces', () => {
    const layout = readFileSync(join(ROOT, MARKETING_GROUP, 'layout.tsx'), 'utf8');
    expect(layout).toContain('fraunces.variable');
  });

  it('klasy Fraunces są tylko w plikach rysowanych pod layoutem marketingu', () => {
    const users = SOURCES.filter((s) => FRAUNCES_CLASSES.test(s.text)).map((s) => s.path);
    // skaner widzi znane użycie (inaczej „0 trafień” nic nie znaczy)
    expect(users.some((p) => p.startsWith(MARKETING_GROUP))).toBe(true);

    const outside: string[] = [];
    for (const user of users.filter((p) => !p.startsWith(MARKETING_GROUP))) {
      // komponent spoza grupy wolno importować tylko ze stron marketingu
      const specifier = `@/${user.replace(/\.tsx?$/, '')}'`;
      const importers = SOURCES.filter((s) => s.text.includes(specifier)).map((s) => s.path);
      outside.push(...importers.filter((p) => !p.startsWith(MARKETING_GROUP)).map((p) => `${p} → ${user}`));
      if (!user.startsWith('components/')) outside.push(user);
    }
    expect(outside).toEqual([]);
  });
});

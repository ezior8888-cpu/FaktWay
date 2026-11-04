import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * 23.10.2026: Bartosz kazał zdjąć zielony znak marki (`faktflow-mark.png`,
 * zielony kwadrat z kartką) ze wszystkich ekranów. Od 25.10.2026 jest nowe
 * logo (`components/brand/faktway-logo.tsx`, test `logo-faktway`). Strażnik
 * pilnuje, żeby stary znak nie wrócił przy kolejnej zmianie wyglądu.
 */

const ROOT = process.cwd();
const OLD_MARK = 'faktflow-mark';

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : walk(path);
    return /\.(tsx?|css)$/.test(name) ? [path] : [];
  });
}

describe('stary zielony znak marki', () => {
  it('pliku znaku nie ma w public/', () => {
    expect(existsSync(join(ROOT, 'public/brand/faktflow-mark.png'))).toBe(false);
  });

  it('żaden ekran go nie wczytuje', () => {
    const users = ['app', 'components']
      .flatMap((dir) => walk(join(ROOT, dir)))
      .filter((file) => readFileSync(file, 'utf8').includes(OLD_MARK))
      .map((file) => file.slice(ROOT.length + 1));
    expect(users).toEqual([]);
  });
});

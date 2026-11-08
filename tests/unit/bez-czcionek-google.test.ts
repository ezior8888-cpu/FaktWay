import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildContentSecurityPolicy } from '@/lib/security/csp';

/**
 * Do 15.10.2026 każda strona ładowała ikony Material Symbols z
 * fonts.googleapis.com / fonts.gstatic.com. Przeglądarka odwiedzającego
 * wysyłała wtedy do Google adres IP — bez zgody i bez podstawy prawnej
 * (LG München I, 20.01.2022, 3 O 17493/20; po wyroku fala masowych wezwań
 * do zapłaty). `next/font/google` jest w porządku: pobiera czcionki przy
 * BUDOWANIU i serwuje je z naszej domeny. Ten test pilnuje adresów, które
 * trafiłyby do przeglądarki.
 */

const GOOGLE_FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];
// `styles/` zniknął 23.10.2026 razem z arkuszem szablonu Zova; zostaje na
// liście, gdyby wrócił, a nieistniejące katalogi są pomijane.
const SCANNED_DIRS = ['app', 'components', 'lib', 'styles', 'hooks', 'content'].filter((d) => existsSync(d));
const EXTENSIONS = /\.(tsx?|css|mdx?|html)$/;

/** Wiersze z adresem serwera czcionek Google (pomija komentarze `//` i `*`). */
function googleFontReferences(source: string): string[] {
  return source
    .split(/\r?\n/)
    .filter((line) => GOOGLE_FONT_HOSTS.some((h) => line.includes(h)))
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));
}

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...files(full));
    else if (EXTENSIONS.test(name)) out.push(full);
  }
  return out;
}

describe('bez czcionek z serwerów Google w przeglądarce', () => {
  it('skaner widzi znany przypadek (inaczej „0 trafień” nic nie znaczy)', () => {
    const known = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined" />';
    expect(googleFontReferences(known)).toHaveLength(1);
    expect(googleFontReferences('// fonts.gstatic.com w komentarzu')).toHaveLength(0);
  });

  it('żaden plik serwisu nie odwołuje się do fonts.googleapis.com ani fonts.gstatic.com', () => {
    const hits = SCANNED_DIRS.flatMap((d) => files(d)).flatMap((f) =>
      googleFontReferences(readFileSync(f, 'utf8')).map((line) => `${f}: ${line.trim()}`),
    );
    expect(hits).toEqual([]);
  });

  it('CSP nie dopuszcza serwerów czcionek Google', () => {
    const csp = buildContentSecurityPolicy({ production: true });
    for (const host of GOOGLE_FONT_HOSTS) expect(csp).not.toContain(host);
  });

  it('ikony Material Symbols są z pakietu w naszym buildzie', () => {
    expect(readFileSync('app/layout.tsx', 'utf8')).toContain("import 'material-symbols/outlined.css'");
  });
});

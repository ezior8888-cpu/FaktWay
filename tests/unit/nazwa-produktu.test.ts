import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Plan Finora, D8: produkt nazywa się FaktWay (zmiana nazwy 17.10.2026,
 * wcześniej FaktFlow, a jeszcze wcześniej robocze „KSeF SaaS”). Interfejs,
 * maile, PDF, pomoc i strony publiczne piszą tylko „FaktWay”. Stare nazwy
 * zostały w dokumentacji i historii repozytorium, więc łatwo je wpisać
 * z pamięci — ten test to łapie.
 *
 * `KSeF SaaS v1.0` zostaje: to `<SystemInfo>` każdego pliku FA(3) z naszych
 * generatorów, po którym `lib/ksef/duplicate-verdict.ts` rozpoznaje własne
 * faktury w KSeF. Zmiana tej wartości to osobna decyzja.
 *
 * Bez zmian zostają (inna wielkość liter, test ich nie widzi): domeny
 * `faktflow.pl`, adresy e-mail, zmienne `FAKTFLOW_*`, adresy stron pomocy
 * i identyfikatory techniczne (`faktflow-original`, `FaktflowMark`).
 */

const ROOT = join(__dirname, '..', '..');
const SCANNED = ['app', 'components', 'lib', 'content', 'hooks', 'types', 'public', 'e2e'];
const EXTENSIONS = /\.(tsx?|mjs|js|mdx?|json|webmanifest|css|txt)$/;

// D4: pliki FLO zmienia ich właściciel (Masło, tor silnika) — nie ten test.
const OWNED_ELSEWHERE = [
  'components/flo/',
  'app/(dashboard)/flo/',
  'app/(dashboard)/settings/flo/',
  'content/flo/',
  'lib/flo/',
  'e2e/tests/flo-',
];

// Teksty, które baza ma u siebie i porównuje albo zwraca dosłownie.
// Zmieniają się razem z migracją, która przepisze te funkcje bazy:
// Fakturę za abonament przyjmuje w obu nazwach migracja 00152
// (`lib/billing/self-invoice.ts` pisze FaktWay), a lustro odmów decyzji
// o duplikacie (`DUPLICATE_DECISION_SQL_TEXTS`) przepisała na FaktWay 00151.
// Zostaje wzorzec przyszłego `<SystemInfo>` (D-A4-1b-3-SYS): funkcja bazy
// z 00156 (powód `faktflow-original`) dopasowuje go dosłownie (`~ '^FaktFlow [0-9]'`),
// a lustro w TS (`FAKTFLOW_SYSTEM_INFO_NEXT`) musi być identyczne. To nie tekst
// dla klienta; zmienia się razem z migracją i decyzją o nowym SystemInfo generatora.
const DB_BOUND = new Map<string, string[]>([
  ['lib/ksef/duplicate-decision.ts', ['FAKTFLOW_SYSTEM_INFO_NEXT = /^FaktFlow [0-9]/']],
]);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : walk(path);
    return EXTENSIONS.test(name) ? [path] : [];
  });
}

// „KSeF SaaS” bez wersji po spacji; `KSeF SaaS v1.0` (SystemInfo) przepuszcza.
// `Fakt<span …>Flow` — nazwa rozbita na znaczniki (dwukolorowy znak marki);
// tak przetrwała zmianę nazwy w E0, bo w tekście pliku nie ma „FaktFlow”.
const OLD_NAMES = /FaktFlow|Fakt(?:<[^>]*>)+Flow|KSeF SaaS(?! v\d)/;

function oldNameHits(): string[] {
  const hits: string[] = [];
  for (const dir of SCANNED) {
    for (const file of walk(join(ROOT, dir))) {
      const rel = relative(ROOT, file).replaceAll('\\', '/');
      if (OWNED_ELSEWHERE.some((prefix) => rel.startsWith(prefix))) continue;
      const allowed = DB_BOUND.get(rel) ?? [];
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (!OLD_NAMES.test(line)) return;
        if (allowed.some((text) => line.includes(text))) return;
        hits.push(`${rel}:${i + 1}`);
      });
    }
  }
  return hits;
}

describe('nazwa produktu: FaktWay (plan Finora, D8)', () => {
  it('aplikacja nie pisze starych nazw (FaktFlow, KSeF SaaS)', () => {
    expect(oldNameHits()).toEqual([]);
  });

  it('wyjątki z bazy nadal są w kodzie (inaczej usuń je z listy)', () => {
    for (const [file, texts] of DB_BOUND) {
      const source = readFileSync(join(ROOT, file), 'utf8');
      for (const text of texts) expect(source).toContain(text);
    }
  });
});

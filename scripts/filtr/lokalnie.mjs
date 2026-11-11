#!/usr/bin/env node
// `pnpm filtr:lokalnie` (żelazny filtr F3, plan B5.3): to, co filtr sprawdzi
// w CI, uruchomione lokalnie przed PR.
//   1. klasyfikacja zmiany względem bazy (domyślnie origin/main) mapą ryzyka:
//      plik z sygnałem poza mapą to błąd;
//   2. testy filtra (vitest.filtr.config.ts, jeden wątek): mapa, straż, a od
//      kolejnych kroków rejestr, niezmienniki, wyrocznia, przykłady, XSD;
//   3. dla zmiany R1 i R2 przypomnienie o karcie i liście kontrolnej.
// Użycie: pnpm filtr:lokalnie [baza]

import { spawnSync } from 'node:child_process';

import { KATALOG_REPO } from './mapa.mjs';

const baza = process.argv[2] ?? 'origin/main';
const krok = (opis, polecenie, argumenty) => {
  console.log(`\n[FILTR] ${opis}`);
  return spawnSync(polecenie, argumenty, { cwd: KATALOG_REPO, stdio: 'inherit' }).status ?? 1;
};

const mapa = spawnSync('node', ['scripts/filtr/mapa.mjs', '--diff', baza, '--json'], { cwd: KATALOG_REPO, encoding: 'utf8' });
let poziom = 'R1';
if (mapa.stdout) {
  try {
    poziom = JSON.parse(mapa.stdout).poziom;
  } catch {
    // zostaje R1: nie wiemy, więc zakładamy najgorsze
  }
}
let kod = krok(`Klasyfikacja zmiany względem ${baza}`, 'node', ['scripts/filtr/mapa.mjs', '--diff', baza]);
kod = krok('Testy filtra (vitest.filtr.config.ts)', 'pnpm', ['exec', 'vitest', 'run', '--config', 'vitest.filtr.config.ts']) || kod;
if (poziom === 'R1' || poziom === 'R2') {
  console.log(
    `\n[FILTR] Zmiana ${poziom}: przed PR wypełnij kartę zmiany prawnej (szablon PR), ` +
      'a drugi czytelnik przechodzi listę docs/filtr/LISTA-KONTROLNA.md. Etykiety zgoda:* nadaje tylko Bartosz.',
  );
}
console.log(kod === 0 ? '\n[FILTR] Lokalnie zielono.' : '\n[FILTR] Lokalnie czerwono: popraw przed pushem.');
process.exitCode = kod;

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
const krok = (opis, polecenie, argumenty, { powloka = false } = {}) => {
  console.log(`\n[FILTR] ${opis}`);
  const opcje = { cwd: KATALOG_REPO, stdio: 'inherit' };
  // Przez powłokę jednym napisem: tablica argumentów z `shell: true` daje ostrzeżenie DEP0190.
  const wynik = powloka
    ? spawnSync([polecenie, ...argumenty].join(' '), { ...opcje, shell: true })
    : spawnSync(polecenie, argumenty, opcje);
  if (wynik.error) console.error(`[FILTR] Nie udało się uruchomić ${polecenie}: ${wynik.error.message}`);
  return wynik.status ?? 1;
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
// Na Windows pnpm to skrypt pnpm.cmd: spawn bez powłoki go nie znajduje (ENOENT),
// a pliku .cmd bez powłoki Node nie uruchamia (EINVAL, CVE-2024-27980). Argumenty
// są stałe, bez spacji i znaków powłoki, więc sklejenie ich w jeden napis jest bezpieczne.
const testy = ['exec', 'vitest', 'run', '--config', 'vitest.filtr.config.ts'];
kod = krok('Testy filtra (vitest.filtr.config.ts)', 'pnpm', testy, { powloka: process.platform === 'win32' }) || kod;
if (poziom === 'R1' || poziom === 'R2') {
  console.log(
    `\n[FILTR] Zmiana ${poziom}: przed PR wypełnij kartę zmiany prawnej (szablon PR), ` +
      'a drugi czytelnik przechodzi listę docs/filtr/LISTA-KONTROLNA.md. Etykiety zgoda:* nadaje tylko Bartosz.',
  );
}
console.log(kod === 0 ? '\n[FILTR] Lokalnie zielono.' : '\n[FILTR] Lokalnie czerwono: popraw przed pushem.');
process.exitCode = kod;

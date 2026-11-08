#!/usr/bin/env node
// Skrypt `prepare` (żelazny filtr F3, plan B5.3 pkt 2): przy każdym
// `pnpm install` ustawia `core.hooksPath .githooks`, więc hook przed pushem
// z krokiem filtra działa na każdym komputerze (Bartosz, Igor, pozostali).
// Nigdy nie kończy się błędem: w CI, poza repozytorium git (obraz Docker,
// etap `deps` bez katalogu .git) i bez katalogu .githooks nic nie robi.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * @param {{ katalog?: string, srodowisko?: Record<string, string | undefined>, git?: typeof execFileSync }} [opcje]
 * @returns {string}
 */
export function wlaczHooki({ katalog = process.cwd(), srodowisko = process.env, git = execFileSync } = {}) {
  if (srodowisko.CI) return 'pominięte: CI';
  const opcje = { cwd: katalog, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] };
  let gora;
  try {
    gora = git('git', ['rev-parse', '--show-toplevel'], opcje).trim();
  } catch {
    return 'pominięte: poza repozytorium git';
  }
  if (!existsSync(join(gora, '.githooks', 'pre-push'))) return 'pominięte: brak .githooks/pre-push';
  let obecna = '';
  try {
    obecna = git('git', ['config', '--get', 'core.hooksPath'], opcje).trim();
  } catch {
    obecna = '';
  }
  // Worktree dzieli konfigurację z głównym katalogiem, więc bywa tam ścieżka
  // bezwzględna do .githooks głównego katalogu: to też działający hook.
  if (obecna === '.githooks' || obecna.endsWith('/.githooks')) return 'bez zmian: hook już włączony';
  if (obecna) return `uwaga: core.hooksPath = ${obecna}, hook filtra nie działa (ustaw .githooks)`;
  git('git', ['config', 'core.hooksPath', '.githooks'], opcje);
  return 'włączony: core.hooksPath = .githooks';
}

/** Wywołanie z `prepare` i z wiersza poleceń: wypisuje tylko zmianę albo ostrzeżenie, nigdy nie rzuca. */
export function uruchom() {
  try {
    const wynik = wlaczHooki();
    if (!wynik.startsWith('pominięte') && !wynik.startsWith('bez zmian')) console.log(`[hooki] ${wynik}`);
    return wynik;
  } catch {
    return 'pominięte: błąd';
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) uruchom();

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { wlaczHooki } from '@/scripts/dev/wlacz-hooki.mjs';
import { KATALOG_REPO, przygotujMape } from '@/scripts/filtr/mapa.mjs';
import { poEdycji } from '@/scripts/filtr/po-edycji.mjs';
import { ocenPolecenie } from '@/scripts/filtr/polecenia.mjs';

// Git przekazuje hookowi przed pushem GIT_DIR prawdziwego repo, a ten plik
// uruchamia gita (także przez `wlaczHooki`) w repozytoriach tymczasowych. Bez
// tych zmiennych `git init` i `git config` nie trafią do prawdziwego repo
// (11.11.2026 przez GIT_DIR: core.bare=true; `tests/unit/testy-git-izolacja.test.ts`).
for (const klucz of Object.keys(process.env)) if (klucz.startsWith('GIT_')) delete process.env[klucz];

/**
 * Warstwy lokalne żelaznego filtra (F3, plan B5.2 i B5.3): hook przed
 * poleceniem, hook po edycji, `prepare` z włączeniem hooka przed pushem
 * i konfiguracja w .claude/settings.json.
 */

describe('hook przed poleceniem', () => {
  it.each([
    ['git push --no-verify origin x', 'push-bez-hooka'],
    ['git push -u origin claude/x --no-verify', 'push-bez-hooka'],
    ['SKIP_PREPUSH=1 git push', 'push-bez-hooka'],
    ['cd a && SKIP_PREPUSH=1 git push origin b', 'push-bez-hooka'],
    ['git config core.hooksPath /dev/null', 'hooks-path'],
    ['git config --unset core.hooksPath', 'hooks-path'],
    ['git -c core.hooksPath=/dev/null push', 'hooks-path'],
    ['gh pr edit 488 --add-label zgoda:zmiana-filtra', 'etykieta-zgody'],
    ['gh pr edit 488 --remove-label "zgoda:wiedza-prawna"', 'etykieta-zgody'],
    ['gh label create zgoda:nowa', 'etykieta-zgody'],
    ['gh api repos/o/r/issues/1/labels -f "labels[]=zgoda:wyjatek-filtra"', 'etykieta-zgody'],
    ['gh api -X PUT repos/o/r/rulesets/1 --input r.json', 'reguly-repozytorium'],
    ['gh api --method DELETE repos/o/r/branches/main/protection', 'reguly-repozytorium'],
    ['gh api repos/o/r/rulesets -f name=x', 'reguly-repozytorium'],
    ['gh pr merge 488 --merge --admin', 'scalenie-admin'],
  ])('blokuje: %s', (polecenie, regula) => {
    expect(ocenPolecenie(polecenie)).toMatchObject({ zablokuj: true, regula });
  });

  it.each([
    'git push -u origin claude/filtr-f3-lokalnie',
    'git push -n origin x',
    'git config --get core.hooksPath',
    'git config core.hooksPath .githooks',
    'gh pr view 488 --json labels',
    'grep -rn "zgoda:" docs/',
    'gh api repos/o/r/rulesets',
    'gh api repos/o/r/branches/main/protection',
    'gh pr merge 488 --merge',
    'pnpm filtr:lokalnie',
    '',
  ])('przepuszcza: %s', (polecenie) => {
    expect(ocenPolecenie(polecenie).zablokuj).toBe(false);
  });

  it('skrypt hooka: kod 2 i powód dla zakazanego, 0 dla zwykłego polecenia', () => {
    const uruchom = (polecenie: string) =>
      spawnSync('bash', [join(KATALOG_REPO, 'scripts/filtr/przed-poleceniem.sh')], {
        input: JSON.stringify({ tool_input: { command: polecenie } }),
        encoding: 'utf8',
        env: { ...process.env, CLAUDE_PROJECT_DIR: KATALOG_REPO },
      });
    const zakazane = uruchom('git push --no-verify');
    expect(zakazane.status).toBe(2);
    expect(zakazane.stderr).toMatch(/\[FILTR\] Polecenie zablokowane \(push-bez-hooka\)/);
    expect(uruchom('git status').status).toBe(0);
  });
});

describe('hook po edycji', () => {
  const katalog = mkdtempSync(join(tmpdir(), 'filtr-po-edycji-'));
  const znaczniki = mkdtempSync(join(tmpdir(), 'filtr-znaczniki-'));
  afterEach(() => rmSync(znaczniki, { recursive: true, force: true }));
  const mapa = przygotujMape({
    wersja: 1,
    kod: { katalogi: ['lib/'], rozszerzenia: ['.ts'] },
    obszary: [
      { id: 'silniki', poziom: 'R1', opis: 'Silniki obliczeń podatków.', sciezki: ['lib/podatki/**'] },
      { id: 'pomocnicze', poziom: 'R3', opis: 'Daty i formatowanie.', sciezki: ['lib/format/**'] },
    ],
    wylaczenia: [],
    sygnaly: { tresc: [{ id: 'vat', wzorzec: '(?<![A-Za-z])VAT' }], nazwy: [] },
  });
  const zapisz = (plik: string, tresc: string) => {
    execFileSync('mkdir', ['-p', join(katalog, plik, '..')]);
    writeFileSync(join(katalog, plik), tresc);
    return join(katalog, plik);
  };
  const pliki = ['lib/podatki/zus.ts', 'lib/format/data.ts', 'lib/nowe/stawki.ts', 'lib/inne/x.ts'];

  it('plik R1: kontekst z obszarem i dowodami, raz na sesję', () => {
    const sciezka = zapisz('lib/podatki/zus.ts', 'export const a = 1;');
    const pierwszy = poEdycji({ sciezka, katalog, mapa, sesja: 's1', katalogZnacznikow: znaczniki, pliki });
    expect(pierwszy.kod).toBe(0);
    const kontekst = JSON.parse(pierwszy.stdout ?? '{}').hookSpecificOutput;
    expect(kontekst.hookEventName).toBe('PostToolUse');
    expect(kontekst.additionalContext).toMatch(/\[FILTR R1 silniki\] lib\/podatki\/zus\.ts/);
    expect(kontekst.additionalContext).toMatch(/Etykiet zgoda:\* nie nadawaj/);
    expect(poEdycji({ sciezka, katalog, mapa, sesja: 's1', katalogZnacznikow: znaczniki, pliki })).toEqual({ kod: 0 });
    expect(poEdycji({ sciezka, katalog, mapa, sesja: 's2', katalogZnacznikow: znaczniki, pliki }).stdout).toBeDefined();
  });

  it('plik z sygnałem poza mapą: kod 2 z poleceniem', () => {
    const sciezka = zapisz('lib/nowe/stawki.ts', 'export const VAT = 23;');
    const wynik = poEdycji({ sciezka, katalog, mapa, katalogZnacznikow: znaczniki, pliki });
    expect(wynik.kod).toBe(2);
    expect(wynik.stderr).toMatch(/poza mapą ryzyka \(sygnały: vat\)/);
  });

  it('R3, plik bez sygnału i plik spoza repozytorium: cisza', () => {
    expect(poEdycji({ sciezka: zapisz('lib/format/data.ts', 'VAT'), katalog, mapa, katalogZnacznikow: znaczniki, pliki })).toEqual({ kod: 0 });
    expect(poEdycji({ sciezka: zapisz('lib/inne/x.ts', 'export {}'), katalog, mapa, katalogZnacznikow: znaczniki, pliki })).toEqual({ kod: 0 });
    expect(poEdycji({ sciezka: '/etc/hosts', katalog, mapa, katalogZnacznikow: znaczniki, pliki })).toEqual({ kod: 0 });
    expect(poEdycji({ sciezka: '', katalog, mapa })).toEqual({ kod: 0 });
  });
});

describe('prepare: włączenie hooka przed pushem', () => {
  it('poza repozytorium git (etap deps obrazu Docker) nic nie robi i nie rzuca', () => {
    const katalog = mkdtempSync(join(tmpdir(), 'filtr-bez-gita-'));
    expect(wlaczHooki({ katalog, srodowisko: {} })).toBe('pominięte: poza repozytorium git');
  });

  it('w CI nic nie robi', () => {
    expect(wlaczHooki({ katalog: KATALOG_REPO, srodowisko: { CI: 'true' } })).toBe('pominięte: CI');
  });

  it('w świeżym klonie ustawia core.hooksPath, a drugi raz nic nie zmienia', () => {
    const katalog = mkdtempSync(join(tmpdir(), 'filtr-klon-'));
    execFileSync('git', ['init', '-q'], { cwd: katalog });
    execFileSync('mkdir', ['-p', join(katalog, '.githooks')]);
    writeFileSync(join(katalog, '.githooks', 'pre-push'), '#!/bin/sh\n');
    expect(wlaczHooki({ katalog, srodowisko: {} })).toBe('włączony: core.hooksPath = .githooks');
    expect(execFileSync('git', ['config', '--get', 'core.hooksPath'], { cwd: katalog, encoding: 'utf8' }).trim()).toBe('.githooks');
    expect(wlaczHooki({ katalog, srodowisko: {} })).toBe('bez zmian: hook już włączony');
    execFileSync('git', ['config', 'core.hooksPath', '/dev/null'], { cwd: katalog });
    expect(wlaczHooki({ katalog, srodowisko: {} })).toMatch(/^uwaga: core.hooksPath = \/dev\/null/);
  });

  it('skrypt prepare w package.json nie wymaga plików spoza package.json', () => {
    const pakiet = JSON.parse(readFileSync(join(KATALOG_REPO, 'package.json'), 'utf8'));
    expect(pakiet.scripts.prepare).toMatch(/existsSync\(f\)/);
    const katalog = mkdtempSync(join(tmpdir(), 'filtr-deps-'));
    writeFileSync(join(katalog, 'package.json'), '{}');
    const kod = pakiet.scripts.prepare.replace(/^node -e "/, '').replace(/"$/, '');
    expect(spawnSync('node', ['-e', kod], { cwd: katalog }).status).toBe(0);
  });
});

describe('konfiguracja Claude Code w repozytorium', () => {
  const ustawienia = JSON.parse(readFileSync(join(KATALOG_REPO, '.claude/settings.json'), 'utf8'));

  it('hooki filtra są wpięte', () => {
    const po = ustawienia.hooks.PostToolUse.find((h: { matcher: string }) => h.matcher === 'Edit|Write|MultiEdit');
    expect(po.hooks.map((h: { command: string }) => h.command).join('\n')).toMatch(/scripts\/filtr\/po-edycji\.sh/);
    const przed = ustawienia.hooks.PreToolUse.find((h: { matcher: string }) => h.matcher === 'Bash');
    expect(przed.hooks[0].command).toMatch(/scripts\/filtr\/przed-poleceniem\.sh/);
  });

  it('zakazy w permissions.deny', () => {
    expect(ustawienia.permissions.deny).toEqual(
      expect.arrayContaining(['Bash(git push --no-verify:*)', 'Bash(SKIP_PREPUSH=1 git push:*)', 'Bash(gh pr merge --admin:*)']),
    );
  });

  it('skill /filtr i lista kontrolna istnieją', () => {
    expect(readFileSync(join(KATALOG_REPO, '.claude/skills/filtr/SKILL.md'), 'utf8')).toMatch(/^---\nname: filtr\n/);
    const lista = readFileSync(join(KATALOG_REPO, 'docs/filtr/LISTA-KONTROLNA.md'), 'utf8');
    expect(lista.match(/^\d+\. /gm)).toHaveLength(21);
  });
});

describe('hook po edycji: reguły statyczne (F7)', () => {
  it('nowe naruszenie w pliku R1 kończy się kodem 2 z nazwą reguły; plik bez naruszeń przechodzi', async () => {
    const { poEdycji: hook } = await import('@/scripts/filtr/po-edycji.mjs');
    const katalog = mkdtempSync(join(tmpdir(), 'filtr-reguly-'));
    execFileSync('mkdir', ['-p', join(katalog, 'lib/ksiegowosc')]);
    writeFileSync(join(katalog, 'lib/ksiegowosc/nowy.ts'), 'export const a = Math.round(kwota * 100);');
    const mapa = przygotujMape({
      wersja: 1,
      kod: { katalogi: ['lib/'], rozszerzenia: ['.ts'] },
      obszary: [{ id: 'silniki', poziom: 'R1', opis: 'Silniki obliczeń podatków.', sciezki: ['lib/ksiegowosc/**'] }],
      wylaczenia: [],
      sygnaly: { tresc: [], nazwy: [] },
    });
    const zly = hook({ sciezka: join(katalog, 'lib/ksiegowosc/nowy.ts'), katalog, mapa, katalogZnacznikow: null, pliki: ['lib/ksiegowosc/nowy.ts'] });
    expect(zly.kod).toBe(2);
    expect(zly.stderr).toMatch(/reguła kwoty-bez-float/);
    writeFileSync(join(katalog, 'lib/ksiegowosc/nowy.ts'), 'export const a = procentGr(kwota, 2300);');
    expect(hook({ sciezka: join(katalog, 'lib/ksiegowosc/nowy.ts'), katalog, mapa, katalogZnacznikow: null, pliki: ['lib/ksiegowosc/nowy.ts'] }).kod).toBe(0);
  });
});

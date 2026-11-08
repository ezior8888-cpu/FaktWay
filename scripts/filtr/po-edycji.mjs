#!/usr/bin/env node
// Hook PostToolUse (Edit, Write, MultiEdit) żelaznego filtra, krok F3 (plan B5.2).
//
// Klasyfikuje zmieniony plik mapą ryzyka:
// - plik z sygnałem poza mapą: kod 2 i polecenie dopisania do mapy (sesja
//   poprawia od razu);
// - plik R1 albo R2: raz na sesję i plik dokłada kontekst (additionalContext)
//   z obszarem, poziomem i wymaganymi dowodami;
// - reszta: cisza.
// Reguły statyczne (F7) i reguły z rejestru (F4) dochodzą w swoich krokach.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { KATALOG_REPO, importyPliku, klasyfikujPlik, plikiRepozytorium, poziomZeSciezki, wczytajMape } from './mapa.mjs';

const DOWODY = {
  R1: 'czerwony test przed zmianą (niezmiennik albo przykład urzędowy, nie tylko punkt), reguła z rejestru przepisów, karta zmiany prawnej w opisie PR, `pnpm filtr:lokalnie`, drugi czytelnik z listą kontrolną docs/filtr/LISTA-KONTROLNA.md',
  R2: 'karta zmiany prawnej w opisie PR (treści D8: bez porad podatkowych), `pnpm filtr:lokalnie`, drugi czytelnik z listą kontrolną docs/filtr/LISTA-KONTROLNA.md',
};

/**
 * @param {{ sciezka: string, katalog?: string, mapa?: object, sesja?: string, katalogZnacznikow?: string, pliki?: string[] }} dane
 * @returns {{ kod: number, stdout?: string, stderr?: string }}
 */
export function poEdycji({ sciezka, katalog = KATALOG_REPO, mapa = wczytajMape(), sesja = '', katalogZnacznikow, pliki }) {
  if (!sciezka) return { kod: 0 };
  const pelna = resolve(katalog, sciezka);
  const plik = relative(katalog, pelna).split('\\').join('/');
  if (plik.startsWith('..') || !existsSync(pelna)) return { kod: 0 };
  const tresc = readFileSync(pelna, 'utf8');
  const zbior = new Set(pliki ?? plikiRepozytorium(katalog));
  const importyR1 = importyPliku(plik, tresc, (p) => zbior.has(p)).filter((cel) => poziomZeSciezki(mapa, cel) === 'R1');
  const wynik = klasyfikujPlik(mapa, plik, { tresc, importyR1 });
  if (wynik.status === 'niesklasyfikowany') {
    return {
      kod: 2,
      stderr:
        `[FILTR] ${plik} jest poza mapą ryzyka (sygnały: ${wynik.sygnaly.slice(0, 5).join(', ')}). ` +
        'Dopisz go do obszaru w filtr/mapa-ryzyka.json (wolno bez zgody) albo do „wylaczenia” z powodem ' +
        '(osłabienie: zgoda:zmiana-filtra od Bartosza). Sprawdzenie: pnpm filtr:mapa ' + plik,
    };
  }
  if (wynik.poziom !== 'R1' && wynik.poziom !== 'R2') return { kod: 0 };
  if (katalogZnacznikow !== null) {
    // Znaczniki „już powiedziane w tej sesji” w ignorowanym katalogu repozytorium
    // (.tmp/), nie we wspólnym katalogu tymczasowym systemu. Zapis z flagą „wx”
    // tworzy plik atomowo: gdy już jest, kontekst był w tej sesji.
    const katalogSesji = join(katalogZnacznikow ?? join(katalog, '.tmp', 'filtr-sesje'), sesja.replace(/[^A-Za-z0-9_-]/g, '') || 'bez-sesji');
    const znacznik = join(katalogSesji, createHash('sha256').update(plik).digest('hex').slice(0, 16));
    mkdirSync(katalogSesji, { recursive: true });
    try {
      writeFileSync(znacznik, plik, { flag: 'wx' });
    } catch (blad) {
      if (blad && typeof blad === 'object' && 'code' in blad && blad.code === 'EEXIST') return { kod: 0 };
      throw blad;
    }
  }
  const kontekst =
    `[FILTR ${wynik.poziom} ${wynik.obszary.join(', ')}] ${plik} jest w obszarze ryzyka prawnego ` +
    `(${wynik.poziom === 'R1' ? 'krytyczny: kwota podatku, termin albo dokument dla urzędu' : 'może wprowadzić klienta w błąd'}). ` +
    `Przed PR: ${DOWODY[wynik.poziom]}. Etykiet zgoda:* nie nadawaj. Skill /filtr ma całą procedurę.`;
  return { kod: 0, stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: kontekst } }) };
}

function glowna() {
  let wejscie;
  try {
    wejscie = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return 0;
  }
  const katalog = process.env.CLAUDE_PROJECT_DIR || KATALOG_REPO;
  let wynik;
  try {
    wynik = poEdycji({ sciezka: wejscie?.tool_input?.file_path, katalog, sesja: wejscie?.session_id ?? '' });
  } catch (blad) {
    // Hook nie może blokować pracy z powodu własnego błędu; CI i tak sprawdza mapę.
    process.stderr.write(`[FILTR] hook po edycji: ${blad instanceof Error ? blad.message : 'błąd'}\n`);
    return 0;
  }
  if (wynik.stdout) process.stdout.write(`${wynik.stdout}\n`);
  if (wynik.stderr) process.stderr.write(`${wynik.stderr}\n`);
  return wynik.kod;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = glowna();

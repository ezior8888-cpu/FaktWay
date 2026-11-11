#!/usr/bin/env node
// Hook PreToolUse (Bash) żelaznego filtra, krok F3 (plan B5.2).
//
// Odmawia poleceń, które omijają filtr albo dają zgodę za Bartosza:
// pominięcie hooka przed pushem, zmiana core.hooksPath, nadanie albo zdjęcie
// etykiety zgoda:*, zmiana reguł repozytorium przez API, scalenie z --admin.
// To warstwa ostrzegawcza (settings.local.json może ją wyłączyć): te same
// wymogi i tak sprawdza „Filtr: straż” w CI.
//
// Wejście: JSON hooka Claude Code na stdin (`tool_input.command`).
// Wyjście: kod 2 i powód na stderr = polecenie zablokowane; 0 = dozwolone.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const ZMIANA_API = /(?:-X\s*|--method[\s=]+)(?:POST|PUT|PATCH|DELETE)\b|\s-[fF]\s|--(?:raw-)?field\b|--input\b/;

export const REGULY = [
  {
    id: 'push-bez-hooka',
    test: (p) => /\bgit\b[^;&|]*\bpush\b[^;&|]*--no-verify\b/.test(p) || /\bSKIP_PREPUSH=1\b/.test(p),
    powod: 'pominięcie hooka przed pushem (--no-verify, SKIP_PREPUSH=1) omija filtr; napraw przyczynę czerwieni albo zapytaj Bartosza',
  },
  {
    id: 'hooks-path',
    test: (p) =>
      /\bgit\s+-c\s+core\.hooksPath=/i.test(p) ||
      (/\bgit\s+config\b[^;&|]*\bcore\.hooksPath\b/i.test(p) &&
        !/--get\b/.test(p) &&
        !/\bcore\.hooksPath\s+\.githooks\b/i.test(p)),
    powod: 'zmiana core.hooksPath wyłącza hook przed pushem z filtrem; jedyna dozwolona wartość to .githooks',
  },
  {
    id: 'etykieta-zgody',
    test: (p) => /zgoda:/.test(p) && /--add-label|--remove-label|\bgh\s+label\b|\/labels\b|labels\[\]/.test(p),
    powod: 'etykiety zgoda:* nadaje i zdejmuje tylko Bartosz (filtr/zgody.json); poproś o nią w raporcie',
  },
  {
    id: 'reguly-repozytorium',
    test: (p) => /\bgh\s+api\b/.test(p) && /rulesets|\/protection\b/.test(p) && ZMIANA_API.test(p),
    powod: 'reguły repozytorium (rulesets, ochrona gałęzi) zmienia tylko Bartosz w ustawieniach GitHuba',
  },
  {
    id: 'scalenie-admin',
    test: (p) => /\bgh\s+pr\s+merge\b[^;&|]*--admin\b/.test(p),
    powod: 'scalenie z --admin omija wymagane kontrole, w tym „Filtr: straż”',
  },
];

/** @returns {{ zablokuj: boolean, regula?: string, powod?: string }} */
export function ocenPolecenie(polecenie) {
  if (typeof polecenie !== 'string' || polecenie.trim() === '') return { zablokuj: false };
  const regula = REGULY.find((r) => r.test(polecenie));
  return regula ? { zablokuj: true, regula: regula.id, powod: regula.powod } : { zablokuj: false };
}

function glowna() {
  let wejscie;
  try {
    wejscie = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return 0;
  }
  const wynik = ocenPolecenie(wejscie?.tool_input?.command);
  if (!wynik.zablokuj) return 0;
  process.stderr.write(`[FILTR] Polecenie zablokowane (${wynik.regula}): ${wynik.powod}. Plan: docs/koordynacja/PLAN-ZELAZNY-FILTR.md, B5.2.\n`);
  return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = glowna();

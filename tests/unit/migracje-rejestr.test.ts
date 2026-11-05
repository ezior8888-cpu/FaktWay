import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Strażnik migracji (plan usprawnień 2.6). Zasady z
 * docs/runbooks/wgrywanie-migracji.md sprawdza automat zamiast reguły
 * w prompcie:
 *
 * - nazwa `NNNNN_nazwa.sql`, numery unikalne;
 * - każda migracja od 00083 ma wiersz w rejestrze
 *   (docs/koordynacja/CLAUDE-DO-CODEXA.md, „Rejestr numerów migracji”);
 * - „następny wolny” jest większy od każdego użytego numeru (poza 00200);
 * - nowe migracje (od 00164) mówią w nagłówku, czy wgrać je przed, czy PO
 *   wdrożeniu, a `DROP TABLE`/`DROP COLUMN`/`TRUNCATE`/`DELETE FROM` poza
 *   ciałami funkcji opisują w linii `-- DROP/DML: …` (zgoda Bartosza).
 */

const ROOT = process.cwd();
const DIR = join(ROOT, 'supabase/migrations');
const REGISTRY = join(ROOT, 'docs/koordynacja/CLAUDE-DO-CODEXA.md');
/** Od tego numeru zaczyna się rejestr (wcześniejsze sprzed rejestru). */
const REGISTRY_FROM = 83;
/** Numer spoza kolejności z audytu bloku 1. */
const OUT_OF_ORDER = new Set([200]);
/** Pierwszy numer objęty zasadami nagłówka (starsze bywały bez niego). */
const HEADER_RULES_FROM = 164;

interface Migration {
  file: string;
  number: number;
  sql: string;
}

function parseRegistry(text: string): { covered: Set<number>; nextFree: number | null } {
  const start = text.indexOf('## Rejestr numerów migracji');
  if (start < 0) throw new Error('Brak sekcji „Rejestr numerów migracji” w CLAUDE-DO-CODEXA.md');
  const rest = text.slice(start);
  const end = rest.search(/\n---\n|\n## (?!Rejestr)/);
  const section = end > 0 ? rest.slice(0, end) : rest;
  const covered = new Set<number>();
  let nextFree: number | null = null;
  for (const line of section.split('\n')) {
    const cell = /^\|\s*\**(\d{5})(?:\s*[–-]\s*(\d{5}))?\**\s*\|/.exec(line);
    if (!cell) continue;
    const from = Number(cell[1]);
    const to = cell[2] ? Number(cell[2]) : from;
    if (/następny wolny/.test(line)) {
      nextFree = from;
      continue;
    }
    for (let n = from; n <= to; n += 1) covered.add(n);
  }
  return { covered, nextFree };
}

/** Komentarze nagłówka (`--` na początku linii). */
const headerOf = (sql: string) => sql.split('\n').filter((line) => line.trimStart().startsWith('--')).join('\n');
/** Kod wykonywany przy wgraniu: bez komentarzy i bez ciał funkcji `$…$`. */
const outsideBodies = (sql: string) => sql.replace(/--[^\n]*/g, '').replace(/\$(\w*)\$[\s\S]*?\$\1\$/g, '');

export function migrationProblems(files: string[], read: (file: string) => string, registryText: string): string[] {
  const problems: string[] = [];
  const migrations: Migration[] = [];
  for (const file of files) {
    const m = /^(\d{5})_[a-z0-9_]+\.sql$/.exec(file);
    if (!m) {
      problems.push(`${file}: nazwa poza wzorcem NNNNN_nazwa.sql (małe litery, cyfry, _)`);
      continue;
    }
    migrations.push({ file, number: Number(m[1]), sql: read(file) });
  }

  const byNumber = new Map<number, string[]>();
  for (const { number, file } of migrations) byNumber.set(number, [...(byNumber.get(number) ?? []), file]);
  for (const [number, names] of byNumber) {
    if (names.length > 1) problems.push(`numer ${String(number).padStart(5, '0')} użyty ${names.length} razy: ${names.join(', ')}; weź „następny wolny” z rejestru`);
  }

  const { covered, nextFree } = parseRegistry(registryText);
  for (const { number, file } of migrations) {
    if (number >= REGISTRY_FROM && !covered.has(number)) {
      problems.push(`${file}: brak wiersza w rejestrze (docs/koordynacja/CLAUDE-DO-CODEXA.md); dopisz go w tym samym PR`);
    }
  }

  const inOrder = migrations.map((m) => m.number).filter((n) => !OUT_OF_ORDER.has(n));
  const max = Math.max(...inOrder);
  if (nextFree === null) {
    problems.push('rejestr nie ma wiersza „następny wolny”');
  } else if (nextFree <= max) {
    problems.push(`„następny wolny” to ${String(nextFree).padStart(5, '0')}, a użyty jest już ${String(max).padStart(5, '0')}; przesuń go w rejestrze na ${String(max + 1).padStart(5, '0')}`);
  } else if (byNumber.has(nextFree)) {
    problems.push(`„następny wolny” ${String(nextFree).padStart(5, '0')} jest zajęty`);
  }

  for (const { number, file, sql } of migrations) {
    if (number < HEADER_RULES_FROM || OUT_OF_ORDER.has(number)) continue;
    const header = headerOf(sql);
    if (!/(przed|po)\s+wdro[żz]eni|bez\s+wdro[żz]enia/i.test(header)) {
      problems.push(`${file}: nagłówek nie mówi, czy wgrać PRZED, czy PO wdrożeniu`);
    }
    if (/\b(DROP\s+(TABLE|COLUMN)|TRUNCATE|DELETE\s+FROM)\b/i.test(outsideBodies(sql)) && !/^\s*--\s*DROP\/DML:\s*\S/im.test(sql)) {
      problems.push(`${file}: DROP TABLE/DROP COLUMN/TRUNCATE/DELETE FROM przy wgraniu wymaga linii „-- DROP/DML: co i dlaczego” i zgody Bartosza`);
    }
  }
  return problems;
}

describe('strażnik migracji: rejestr i nagłówki', () => {
  it('migracje w repo spełniają zasady rejestru', () => {
    const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
    expect(migrationProblems(files, (f) => readFileSync(join(DIR, f), 'utf8'), readFileSync(REGISTRY, 'utf8'))).toEqual([]);
  });

  const registry = (rows: string) => `## Rejestr numerów migracji\n\n| Numer | Kto | Plik | Stan |\n|---|---|---|---|\n${rows}\n\n---\n`;
  const good = '-- PRZED wdrożeniem (addytywna)\nCREATE TABLE public.x (id int);\n';
  const check = (files: Record<string, string>, rows: string) =>
    migrationProblems(Object.keys(files), (f) => files[f]!, registry(rows));

  it('przechodzi poprawna nowa migracja', () => {
    expect(check({ '00164_x.sql': good }, '| 00164 | Claude | `x` | PR |\n| **00165** | — | następny wolny | — |')).toEqual([]);
  });

  it.each([
    ['dwa pliki z tym samym numerem', { '00164_a.sql': good, '00164_b.sql': good }, '| 00164 | C | `a` | PR |\n| **00165** | — | następny wolny | — |', /użyty 2 razy/],
    ['brak wiersza w rejestrze', { '00164_x.sql': good }, '| **00165** | — | następny wolny | — |', /brak wiersza w rejestrze/],
    ['„następny wolny” nieprzesunięty', { '00164_x.sql': good }, '| 00164 | C | `x` | PR |\n| **00164** | — | następny wolny | — |', /przesuń go w rejestrze na 00165/],
    ['zła nazwa pliku', { '00164-X.sql': good }, '| **00165** | — | następny wolny | — |', /poza wzorcem/],
    ['nagłówek bez „przed/PO wdrożeniu”', { '00164_x.sql': '-- nowa tabela\nCREATE TABLE x (id int);\n' }, '| 00164 | C | `x` | PR |\n| **00165** | — | następny wolny | — |', /PRZED, czy PO/],
    ['DELETE FROM przy wgraniu bez opisu', { '00164_x.sql': `${good}DELETE FROM public.x;\n` }, '| 00164 | C | `x` | PR |\n| **00165** | — | następny wolny | — |', /DROP\/DML/],
  ])('wyłapuje: %s', (_name, files, rows, expected) => {
    expect(check(files, rows).join('\n')).toMatch(expected);
  });

  it('DELETE w ciele funkcji i DROP z opisem przechodzą', () => {
    const body = `${good}CREATE FUNCTION f() RETURNS void LANGUAGE sql AS $$ DELETE FROM public.x $$;\n`;
    const described = `-- PO wdrożeniu\n-- DROP/DML: stara kolumna, kod jej nie czyta od #400; zgoda Bartosza 05.11\nALTER TABLE x DROP COLUMN y;\n`;
    expect(check({ '00164_x.sql': body, '00165_y.sql': described }, '| 00164–00165 | C | `x`, `y` | PR |\n| **00166** | — | następny wolny | — |')).toEqual([]);
  });
});

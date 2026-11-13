/**
 * Kontrast palety aplikacji na telefon (mobile/src/wyglad/paleta.ts), plan
 * aplikacji D15 i docs/mobile/ZASADY-DESIGNU.md, sekcja 4: każda para tekstu
 * i tła, której używają komponenty, ma co najmniej 4.5:1 (WCAG AA) w obu
 * trybach; duży tytuł na gradiencie co najmniej 3:1 (duży tekst).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import type { Kolory, TonKategorii } from '../../mobile/src/wyglad/paleta';

/**
 * Paleta leży w aplikacji (`mobile/`, własny workspace). Zwykły import kazałby
 * Vitestowi strony wczytać `mobile/tsconfig.json` z `expo/tsconfig.base`, którego
 * w CI strony nie ma (paczki aplikacji się tam nie instalują). Plik jest czystymi
 * danymi bez importów, więc test go transpiluje i uruchamia w osobnym kontekście.
 */
function wczytajPalete() {
  const zrodlo = readFileSync(join(__dirname, '../../mobile/src/wyglad/paleta.ts'), 'utf8');
  const js = ts.transpileModule(zrodlo, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const modul: { exports: Record<string, unknown> } = { exports: {} };
  runInNewContext(js, { module: modul, exports: modul.exports });
  return modul.exports as {
    JASNE: Kolory;
    CIEMNE: Kolory;
    KATEGORIE_JASNE: Record<Exclude<TonKategorii, 'szary'>, { tekst: string; tlo: string }>;
    KATEGORIE_CIEMNE: Record<Exclude<TonKategorii, 'szary'>, { tekst: string; tlo: string }>;
    TON_KATEGORII: Record<string, string>;
  };
}

const { CIEMNE, JASNE, KATEGORIE_CIEMNE, KATEGORIE_JASNE, TON_KATEGORII } = wczytajPalete();

function kanal(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminancja(hex: string): number {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => kanal(parseInt(h.slice(i, i + 2), 16)));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function kontrast(a: string, b: string): number {
  const [jasniejszy, ciemniejszy] = [luminancja(a), luminancja(b)].sort((x, y) => y - x);
  return (jasniejszy! + 0.05) / (ciemniejszy! + 0.05);
}

const PARY_TEKSTU: [keyof Kolory, keyof Kolory][] = [
  ['etykieta', 'tloGrupowane'],
  ['etykieta', 'tloKomorki'],
  ['etykietaDrugorzedna', 'tloGrupowane'],
  ['etykietaDrugorzedna', 'tloKomorki'],
  ['akcent', 'tloKomorki'],
  ['naAkcencie', 'akcentWypelnienie'],
  ['akcentNaTle', 'akcentTlo'],
  ['sukces', 'sukcesTlo'],
  ['ostrzezenie', 'ostrzezenieTlo'],
  ['blad', 'bladTlo'],
  ['info', 'infoTlo'],
  ['fiolet', 'fioletTlo'],
  ['etykietaDrugorzedna', 'neutralneTlo'],
];

describe.each([
  ['jasny', JASNE, KATEGORIE_JASNE],
  ['ciemny', CIEMNE, KATEGORIE_CIEMNE],
] as const)('paleta telefonu, motyw %s', (_, k, kategorie) => {
  it.each(PARY_TEKSTU)('%s na %s ma co najmniej 4.5:1', (tekst, tlo) => {
    expect(kontrast(k[tekst], k[tlo])).toBeGreaterThanOrEqual(4.5);
  });

  it.each(Object.keys(kategorie) as Exclude<TonKategorii, 'szary'>[])('plakietka kategorii %s ma co najmniej 4.5:1', (ton) => {
    expect(kontrast(kategorie[ton].tekst, kategorie[ton].tlo)).toBeGreaterThanOrEqual(4.5);
  });

  it('biały duży tytuł na gradiencie ma co najmniej 3:1', () => {
    expect(kontrast('#FFFFFF', k.gradientGora)).toBeGreaterThanOrEqual(3);
    expect(kontrast('#FFFFFF', k.gradientSrodek)).toBeGreaterThanOrEqual(3);
  });
});

describe('tony kategorii kosztów', () => {
  it('każda kategoria z ZASADY-DESIGNU.md ma swój ton', () => {
    expect(TON_KATEGORII).toEqual({
      Telekomunikacja: 'turkus',
      Energia: 'turkus',
      Czynsz: 'fiolet',
      'Usługi obce': 'fiolet',
      'Materiały biurowe': 'bursztyn',
      Paliwo: 'pomarancz',
      'Podróże służbowe': 'pomarancz',
      Reprezentacja: 'roz',
      Marketing: 'roz',
      Oprogramowanie: 'blekit',
    });
  });
});

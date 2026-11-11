import { describe, expect, it } from 'vitest';

import { przygotujMape } from '@/scripts/filtr/mapa.mjs';
import { REGULY, bezKomentarzy, bezNapisow, naruszeniaPliku, opisWzrostow, policz, porownajZZapadka, wczytajZapadke, wyjatki } from '@/scripts/filtr/reguly.mjs';

/**
 * Reguły statyczne z zapadką (żelazny filtr F7, plan B4.8). Czerwony test
 * pełnego przebiegu znaczy: nowe naruszenie w kodzie (popraw albo
 * `// filtr-wyjatek: <reguła> <powód>` ze zgodą) albo mniej naruszeń niż
 * w zapadce (`node scripts/filtr/reguly.mjs --zapisz`).
 */

describe('reguły statyczne: całe repozytorium wobec zapadki', () => {
  it('bez nowych naruszeń i zapadka aktualna', () => {
    const { wzrosty, spadki } = porownajZZapadka(policz(), wczytajZapadke());
    expect(opisWzrostow(wzrosty), 'nowe naruszenia').toBe('');
    expect(spadki, 'mniej naruszeń niż w zapadce: node scripts/filtr/reguly.mjs --zapisz').toEqual([]);
  });
});

const mapa = przygotujMape({
  wersja: 1,
  kod: { katalogi: ['lib/', 'app/', 'tests/'], rozszerzenia: ['.ts', '.tsx'] },
  obszary: [
    { id: 'silniki', poziom: 'R1', opis: 'Silniki obliczeń podatków.', sciezki: ['lib/ksiegowosc/**'] },
    { id: 'pomocnicze', poziom: 'R3', opis: 'Daty i formatowanie.', sciezki: ['lib/format/**'] },
    { id: 'tresci', poziom: 'R2', opis: 'Treści o podatkach.', sciezki: ['content/**', 'lib/teksty/**'] },
  ],
  wylaczenia: [],
  sygnaly: { tresc: [], nazwy: [] },
});
const kontekst = { otwarteFz: new Set(['FZ-001']) };
const reguly = (plik: string, tresc: string) => naruszeniaPliku(plik, tresc, { mapa, kontekst }).map((n: { regula: string }) => n.regula);

describe('każda reguła łapie zły przykład i przepuszcza dobry', () => {
  it.each([
    ['kwoty-bez-float', 'lib/ksiegowosc/x.ts', 'const zl = Math.round(kwota * 100) / 100;', 'const gr = procentGr(kwota, 2300);'],
    ['kwoty-bez-float', 'lib/ksiegowosc/x.ts', 'return kwota.toFixed(2);', 'return formatujGrosze(kwota);'],
    ['liczby-z-rejestru', 'lib/ksiegowosc/x.ts', 'const vat = netto * 0.23;', 'const vat = procent(netto, stawka);'],
    ['liczby-z-rejestru', 'lib/ksiegowosc/x.ts', 'if (przychod > 240_000) {}', 'if (przychod > limitZwolnienia) {}'],
    ['data-warszawa', 'lib/format/x.ts', 'const dzis = new Date().toISOString().slice(0, 10);', 'const dzis = todayInWarsaw();'],
    ['data-warszawa', 'lib/ksiegowosc/x.ts', 'const m = data.getMonth();', 'const m = data.getUTCMonth();'],
    ['bez-trybu-testowego', 'lib/ksiegowosc/x.ts', "if (process.env.NODE_ENV === 'test') return 0;", 'if (brak) return null;'],
    ['bez-porad', 'lib/teksty/x.ts', "const t = 'Zapłać ryczałt do 20.';", "const t = 'Termin ryczałtu to 20.';"],
    ['wyrocznia-osobno', 'tests/filtr/wyrocznia/zus.ts', "import { skladkiSpoleczne } from '@/lib/ksiegowosc/zus';", "import { BigIntGrosze } from './grosze';"],
    ['testy-bez-pomijania', 'tests/filtr/x.test.ts', "it.skip('a', () => {});", "it('a', () => {});"],
    ['testy-bez-pomijania', 'tests/filtr/x.test.ts', "it.fails('bez numeru znaleziska', () => {});", "it.fails('FZ-001: znane', () => {});"],
  ])('%s', (regula, plik, zly, dobry) => {
    expect(reguly(plik, zly)).toContain(regula);
    expect(reguly(plik, dobry)).not.toContain(regula);
  });

  it('wszystkie reguły z planu mają przykład', () => {
    expect(REGULY.map((r: { id: string }) => r.id).sort()).toEqual(
      ['bez-porad', 'bez-trybu-testowego', 'data-warszawa', 'kwoty-bez-float', 'liczby-z-rejestru', 'testy-bez-pomijania', 'wyrocznia-osobno'].sort(),
    );
  });

  it('reguła nie dotyczy pliku spoza zakresu', () => {
    expect(reguly('lib/inne/x.ts', 'Math.round(a); 0.23')).toEqual([]);
  });
});

describe('komentarze i wyjątki', () => {
  it('komentarz nie jest kodem, napis zostaje', () => {
    expect(bezKomentarzy("a(); // Math.round(x)\n/* 0.23 */ b('http://x');")).toBe(`a(); ${' '.repeat(16)}\n${' '.repeat(11)}b('http://x');`);
    expect(bezNapisow("f('Math.round(1)'); g(`a\nb`);")).toBe(`f('${' '.repeat(13)}'); g(\`${' '}\n${' '}\`);`);
    expect(reguly('lib/ksiegowosc/x.ts', '// Math.round(kwota)\nconst a = 1;')).toEqual([]);
  });

  it('filtr-wyjatek zwalnia tę i następną linię tylko z podanej reguły', () => {
    const tresc = "// filtr-wyjatek: kwoty-bez-float kurs z API ma 4 miejsca\nconst k = Math.round(x);\nconst v = y * 0.23;";
    expect(wyjatki(tresc).get(2)).toEqual(new Set(['kwoty-bez-float']));
    expect(reguly('lib/ksiegowosc/x.ts', tresc)).toEqual(['liczby-z-rejestru']);
  });
});

describe('zapadka', () => {
  it('wzrost to błąd, spadek to sygnał do odświeżenia', () => {
    const zapadka = { wersja: 1, reguly: { 'kwoty-bez-float': { 'lib/a.ts': 2 } } };
    expect(porownajZZapadka({ 'kwoty-bez-float': { 'lib/a.ts': 3 } }, zapadka).wzrosty).toEqual([{ regula: 'kwoty-bez-float', plik: 'lib/a.ts', n: 3, limit: 2 }]);
    expect(porownajZZapadka({ 'kwoty-bez-float': { 'lib/a.ts': 1 } }, zapadka).spadki).toHaveLength(1);
    expect(porownajZZapadka({ 'kwoty-bez-float': { 'lib/b.ts': 1 } }, zapadka).wzrosty).toEqual([{ regula: 'kwoty-bez-float', plik: 'lib/b.ts', n: 1, limit: 0 }]);
    expect(porownajZZapadka({ 'kwoty-bez-float': { 'lib/b.ts': 1 } }, zapadka, { tylkoPliki: ['lib/a.ts'] }).wzrosty).toEqual([]);
  });
});

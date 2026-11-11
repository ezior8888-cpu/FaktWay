import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PARAMETRY, wszystkieLiczby } from '@/lib/ksiegowosc/parametry';
import { KATALOG_REPO, wczytajMape } from '@/scripts/filtr/mapa.mjs';
import { PLIK_PYTAN, bledyRejestru, eksportyWartosci, pytaniaMarkdown, rozwin, wczytajRejestr } from '@/scripts/filtr/rejestr.mjs';

/**
 * Rejestr przepisów (żelazny filtr F4, plan B4.1): każda reguła wskazuje
 * przepis, kod i testy, które istnieją; każdy eksport silników księgowości
 * należy do reguły albo do listy pomocniczych; każdy parametr roku jest użyty
 * przez regułę. Czerwony test: popraw rejestr albo kod (zmiana rejestru
 * wymaga zgoda:wiedza-prawna).
 */

const rejestr = wczytajRejestr();
const mapa = wczytajMape();
const kluczeParametrow = [...new Set(Object.values(PARAMETRY).flatMap((p) => wszystkieLiczby(p).map((w) => `${w.sekcja}.${w.klucz}`)))];

describe('rejestr przepisów: spójność z repozytorium', () => {
  it('kod, testy, obszary, parametry i eksporty silników się zgadzają', () => {
    const bledy = bledyRejestru({ rejestr, mapa, kluczeParametrow });
    expect(bledy, `Błędy rejestru:\n${bledy.join('\n')}`).toEqual([]);
  });

  it('każdy obszar R1 modułu księgowości ma co najmniej jedną regułę', () => {
    const zReguly = new Set(rejestr.przepisy.flatMap((p: { obszary: string[] }) => p.obszary));
    const r1 = mapa.obszary.filter((o: { id: string; poziom: string }) => o.poziom === 'R1' && o.id.startsWith('ksiegowosc.'));
    expect(r1.map((o: { id: string }) => o.id).filter((id: string) => !zReguly.has(id))).toEqual([]);
  });

  it.todo('każdy obszar R1 spoza księgowości ma regułę (krok F10: faktury, KSeF, JPK, waluty, odsetki, retencja)');

  it('pierwsze wypełnienie obejmuje sekcje 4, 5 i 13 planu księgowości', () => {
    const zrodla = rejestr.przepisy.map((p: { zrodlo_planu: string }) => p.zrodlo_planu).join('\n');
    for (const sekcja of ['§4', '§5', '§13']) expect(zrodla).toContain(sekcja);
    expect(rejestr.przepisy.length).toBeGreaterThanOrEqual(60);
  });

  it('lista pytań do księgowej i prawnika jest aktualna', () => {
    expect(readFileSync(join(KATALOG_REPO, PLIK_PYTAN), 'utf8'), 'node scripts/filtr/rejestr.mjs --pytania').toBe(pytaniaMarkdown(rejestr));
  });

  it('nic nie jest podpisane: kwoty modułu czekają na księgową i prawnika (D7)', () => {
    expect(rejestr.przepisy.filter((p: { sprawdzil: { ksiegowa: unknown } }) => p.sprawdzil.ksiegowa !== null)).toEqual([]);
  });
});

describe('rejestr przepisów: kontrola łapie błędy', () => {
  const regula = (zmiana: Record<string, unknown> = {}) => ({
    id: 'RP-TEST-01',
    regula: 'Reguła testowa z wystarczająco długą treścią.',
    podstawa: [{ akt: 'Ordynacja podatkowa', przepis: 'art. 63 § 1' }],
    obowiazuje: { od: '2026-01-01', do: null },
    obszary: ['ksiegowosc.silniki'],
    kod: ['lib/ksiegowosc/ryczalt.ts#doPelnychZlotych'],
    testy: ['tests/unit/ksiegowosc-silniki.test.ts > podstawa i ryczałt w pełnych złotych'],
    parametry: [],
    niezmienniki: [],
    pewnosc: 'wysoka',
    wzorzec: null,
    interpretacja: null,
    do_rozstrzygniecia: null,
    sprawdzil: { ksiegowa: null, prawnik: null },
    odczyt: '2026-11-09',
    zrodlo_planu: '§4',
    stan: 'dziala',
    uwagi: null,
    _plik: 'filtr/przepisy/test.json',
    ...zmiana,
  });
  const bledy = (przepisy: object[], pomocnicze: object[] = []) =>
    bledyRejestru({ rejestr: { pliki: [], przepisy, pomocnicze }, mapa }).filter((b: string) => !b.startsWith('eksport '));

  it.each([
    ['brak pliku kodu', { kod: ['lib/nie-ma.ts#x'] }, /brak pliku/],
    ['symbol nie jest eksportem', { kod: ['lib/ksiegowosc/ryczalt.ts#nieMaTakiego'] }, /symbol nie jest wyeksportowany/],
    ['brak testu o tej nazwie', { testy: ['tests/unit/ksiegowosc-silniki.test.ts > nie ma takiego testu'] }, /nie ma testu z/],
    ['obszar spoza mapy', { obszary: ['ksiegowosc.nieznany'] }, /nie ma na mapie ryzyka/],
    ['działająca bez testu', { testy: [] }, /wymaga kodu i co najmniej jednego testu/],
    ['średnia pewność bez pytania', { pewnosc: 'srednia' }, /wymaga pytania/],
    ['zły identyfikator', { id: 'X-1' }, /RP-/],
    ['bez podstawy', { podstawa: [] }, /podstawa musi wskazać akt i przepis/],
    ['nieznane pole', { dodatkowe: 1 }, /nieznane pole dodatkowe/],
  ])('%s', (_opis, zmiana, blad) => {
    expect(bledy([regula(zmiana)]).join('\n')).toMatch(blad);
  });

  it('powtórzone id', () => {
    expect(bledy([regula(), regula()]).join('\n')).toMatch(/powtórzone id/);
  });

  it('poza v1 bez kodu jest dozwolone', () => {
    expect(bledy([regula({ stan: 'poza-v1', kod: [], testy: [] })])).toEqual([]);
  });

  it('nieaktualny wpis pomocniczy', () => {
    expect(bledy([regula()], [{ symbol: 'lib/ksiegowosc/ryczalt.ts#juzNieMa', powod: 'stary wpis' }]).join('\n')).toMatch(/nie ma takiego eksportu/);
  });

  it('nowy eksport silnika bez reguły jest zgłaszany', () => {
    const wszystkie = bledyRejestru({ rejestr: { pliki: [], przepisy: [regula()], pomocnicze: [] }, mapa });
    expect(wszystkie.some((b: string) => /eksport lib\/ksiegowosc\/zus\.ts#skladkiSpoleczne nie należy do żadnej reguły/.test(b))).toBe(true);
  });

  it('parametr bez reguły i reguła z nieznanym parametrem', () => {
    const wynik = bledyRejestru({ rejestr: { pliki: [], przepisy: [regula({ parametry: ['zus.nieMa'] })], pomocnicze: [] }, mapa, kluczeParametrow: ['zus.stopaEmerytalna'] });
    expect(wynik.join('\n')).toMatch(/parametru zus\.nieMa nie ma/);
    expect(wynik.join('\n')).toMatch(/parametr zus\.stopaEmerytalna nie jest użyty/);
  });

  it('eksporty wartości i rozwinięcie ścieżek', () => {
    expect(eksportyWartosci('export function a() {}\nexport const B = 1;\nexport type C = 1;\nexport async function d() {}\nconst e = 1;')).toEqual(['a', 'B', 'd']);
    expect(rozwin('lib/{a,b}/{c,d}.ts')).toEqual(['lib/a/c.ts', 'lib/a/d.ts', 'lib/b/c.ts', 'lib/b/d.ts']);
  });
});

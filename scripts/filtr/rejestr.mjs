#!/usr/bin/env node
// Rejestr przepisów żelaznego filtra (krok F4; plan docs/koordynacja/PLAN-ZELAZNY-FILTR.md, B4.1).
//
// Każda reguła wskazuje przepis, kod (`plik#symbol`) i testy (`plik > fragment
// nazwy`). Ten moduł sprawdza spójność rejestru z repozytorium i z mapą ryzyka
// oraz tworzy listę pytań do księgowej i prawnika (docs/filtr/PYTANIA-Z-REJESTRU.md).
//
// Użycie:
//   node scripts/filtr/rejestr.mjs --sprawdz     błędy rejestru (kod 1, gdy są)
//   node scripts/filtr/rejestr.mjs --pytania     zapisuje docs/filtr/PYTANIA-Z-REJESTRU.md

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { KATALOG_REPO, wczytajMape } from './mapa.mjs';

export const KATALOG_REJESTRU = 'filtr/przepisy';
export const PLIK_PYTAN = 'docs/filtr/PYTANIA-Z-REJESTRU.md';
const POMIJANE = new Set(['schemat.json', 'pomocnicze.json']);
const PEWNOSC = { wysoka: 'wysoka', srednia: 'średnia', niska: 'niska' };

/** Pliki silników księgowości: każdy eksport wartości musi należeć do reguły albo do listy pomocniczych. */
export const PLIKI_SILNIKOW = [
  'lib/ksiegowosc/{ryczalt,zus,zdrowotna,pit,vat,kalendarz,mikrorachunek,ewidencja,ewidencja-dane,kpir,kpir-dane,ten-miesiac,ten-miesiac-dane,vat-dane,jpk-ewp,jpk-ewp-walidator,jpk-pkpir,odlozyc,profil,przypomnienia,powiadomienia,wylacznik,odeslanie,wpisy-reczne,spis-z-natury,zaplata-reczna,miesiac-strony}.ts',
  'lib/ksiegowosc/parametry/{index,liczba,terminy,zrodla,2026,2027}.ts',
];

export function wczytajRejestr(katalog = KATALOG_REPO) {
  const pelny = join(katalog, KATALOG_REJESTRU);
  if (!existsSync(pelny)) return { pliki: [], przepisy: [], pomocnicze: [] };
  const pliki = readdirSync(pelny).filter((p) => p.endsWith('.json') && !POMIJANE.has(p)).sort();
  const przepisy = pliki.flatMap((plik) =>
    JSON.parse(readFileSync(join(pelny, plik), 'utf8')).przepisy.map((przepis) => ({ ...przepis, _plik: `${KATALOG_REJESTRU}/${plik}` })),
  );
  const sciezkaPomocniczych = join(pelny, 'pomocnicze.json');
  const pomocnicze = existsSync(sciezkaPomocniczych) ? JSON.parse(readFileSync(sciezkaPomocniczych, 'utf8')).symbole : [];
  return { pliki, przepisy, pomocnicze };
}

const ZNACZNIK_EKSPORTU = (symbol) =>
  new RegExp(`export\\s+(?:async\\s+)?(?:function\\*?|const|let|class|type|interface|enum)\\s+${symbol}\\b|export\\s*\\{[^}]*\\b${symbol}\\b[^}]*\\}`);

/** Eksporty wartości (function, const, let, class) z treści pliku TS. */
export function eksportyWartosci(tresc) {
  return [...tresc.matchAll(/^export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z0-9_]+)/gm)].map((d) => d[1]);
}

/** Rozwinięcie `{a,b}` w ścieżkach plików silników. */
export function rozwin(wzorzec) {
  const dopasowanie = /\{([^}]+)\}/.exec(wzorzec);
  if (!dopasowanie) return [wzorzec];
  return dopasowanie[1].split(',').flatMap((czesc) => rozwin(wzorzec.replace(dopasowanie[0], czesc)));
}

const WYMAGANE = ['id', 'regula', 'podstawa', 'obowiazuje', 'obszary', 'kod', 'testy', 'parametry', 'niezmienniki', 'pewnosc', 'wzorzec', 'interpretacja', 'do_rozstrzygniecia', 'sprawdzil', 'odczyt', 'zrodlo_planu', 'stan', 'uwagi'];

/**
 * Błędy spójności rejestru. Pusta lista to rejestr zgodny z repozytorium.
 * @param {{ katalog?: string, rejestr?: ReturnType<typeof wczytajRejestr>, mapa?: object, kluczeParametrow?: string[] }} [opcje]
 */
export function bledyRejestru({ katalog = KATALOG_REPO, rejestr = wczytajRejestr(katalog), mapa = wczytajMape(), kluczeParametrow } = {}) {
  const bledy = [];
  const ids = new Set();
  const czytaj = (plik) => (existsSync(join(katalog, plik)) ? readFileSync(join(katalog, plik), 'utf8') : null);
  const obszaryMapy = new Set(mapa.obszary.map((o) => o.id));
  const przypisane = new Set();
  const uzyteParametry = new Set();
  for (const przepis of rejestr.przepisy) {
    const gdzie = `${przepis._plik} ${przepis.id ?? '(bez id)'}`;
    for (const pole of WYMAGANE) if (!(pole in przepis)) bledy.push(`${gdzie}: brak pola ${pole}`);
    for (const pole of Object.keys(przepis)) if (!WYMAGANE.includes(pole) && pole !== '_plik') bledy.push(`${gdzie}: nieznane pole ${pole}`);
    if (!/^RP-[A-Z0-9]+(?:-[A-Z0-9]+)*$/.test(przepis.id ?? '')) bledy.push(`${gdzie}: id musi mieć postać RP-…`);
    if (ids.has(przepis.id)) bledy.push(`${gdzie}: powtórzone id`);
    ids.add(przepis.id);
    if (!['wysoka', 'srednia', 'niska'].includes(przepis.pewnosc)) bledy.push(`${gdzie}: pewność musi być wysoka, srednia albo niska`);
    if (!['dziala', 'poza-v1', 'obserwacja'].includes(przepis.stan)) bledy.push(`${gdzie}: nieznany stan ${przepis.stan}`);
    if (!Array.isArray(przepis.podstawa) || przepis.podstawa.length === 0 || przepis.podstawa.some((p) => !p.akt || !p.przepis)) {
      bledy.push(`${gdzie}: podstawa musi wskazać akt i przepis`);
    }
    for (const obszar of przepis.obszary ?? []) if (!obszaryMapy.has(obszar)) bledy.push(`${gdzie}: obszaru ${obszar} nie ma na mapie ryzyka`);
    if (przepis.stan === 'dziala' && ((przepis.kod ?? []).length === 0 || (przepis.testy ?? []).length === 0)) {
      bledy.push(`${gdzie}: reguła działająca wymaga kodu i co najmniej jednego testu`);
    }
    if (['srednia', 'niska'].includes(przepis.pewnosc) && !przepis.do_rozstrzygniecia) {
      bledy.push(`${gdzie}: pewność ${przepis.pewnosc} wymaga pytania do księgowej albo prawnika (do_rozstrzygniecia)`);
    }
    if (przepis.wzorzec && ![1, 2, 3, 4, 5, 6].includes(przepis.wzorzec.poziom)) bledy.push(`${gdzie}: poziom wzorca 1-6 (B4.0)`);
    for (const odwolanie of przepis.kod ?? []) {
      const [plik, symbol] = odwolanie.split('#');
      const tresc = czytaj(plik);
      if (tresc === null) bledy.push(`${gdzie}: kod ${odwolanie}: brak pliku`);
      else if (!ZNACZNIK_EKSPORTU(symbol).test(tresc)) bledy.push(`${gdzie}: kod ${odwolanie}: symbol nie jest wyeksportowany`);
      przypisane.add(odwolanie);
    }
    for (const odwolanie of przepis.testy ?? []) {
      const [plik, ...reszta] = odwolanie.split(' > ');
      const fragment = reszta.join(' > ');
      const tresc = czytaj(plik);
      if (tresc === null) bledy.push(`${gdzie}: test ${plik}: brak pliku`);
      else if (fragment && !tresc.includes(fragment)) bledy.push(`${gdzie}: test ${plik}: nie ma testu z „${fragment}”`);
    }
    for (const klucz of przepis.parametry ?? []) {
      uzyteParametry.add(klucz);
      if (kluczeParametrow && !kluczeParametrow.includes(klucz)) bledy.push(`${gdzie}: parametru ${klucz} nie ma w lib/ksiegowosc/parametry`);
    }
  }
  if (kluczeParametrow) {
    for (const klucz of kluczeParametrow) if (!uzyteParametry.has(klucz)) bledy.push(`parametr ${klucz} nie jest użyty przez żadną regułę rejestru`);
  }
  const pomocnicze = new Set();
  for (const { symbol, powod } of rejestr.pomocnicze) {
    pomocnicze.add(symbol);
    if (!powod || powod.length < 5) bledy.push(`pomocnicze ${symbol}: brak powodu`);
    const [plik, nazwa] = symbol.split('#');
    const tresc = czytaj(plik);
    if (tresc === null || !ZNACZNIK_EKSPORTU(nazwa).test(tresc)) bledy.push(`pomocnicze ${symbol}: nie ma takiego eksportu (usuń wpis)`);
  }
  for (const wzorzec of PLIKI_SILNIKOW) {
    for (const plik of rozwin(wzorzec)) {
      const tresc = czytaj(plik);
      if (tresc === null) {
        bledy.push(`plik silnika ${plik} nie istnieje (popraw PLIKI_SILNIKOW)`);
        continue;
      }
      for (const symbol of eksportyWartosci(tresc)) {
        const odwolanie = `${plik}#${symbol}`;
        if (!przypisane.has(odwolanie) && !pomocnicze.has(odwolanie)) {
          bledy.push(`eksport ${odwolanie} nie należy do żadnej reguły ani do filtr/przepisy/pomocnicze.json`);
        }
      }
    }
  }
  return bledy;
}

/** Lista pytań do księgowej i prawnika z pól do_rozstrzygniecia (bramy B2 i B4). */
export function pytaniaMarkdown(rejestr = wczytajRejestr()) {
  const linie = [
    '# Pytania z rejestru przepisów',
    '',
    '> Plik generowany: `node scripts/filtr/rejestr.mjs --pytania`. Nie edytuj ręcznie; test',
    '> `tests/filtr/rejestr.test.ts` pilnuje, żeby był aktualny. Źródło: pola',
    '> `do_rozstrzygniecia` w `filtr/przepisy/*.json` (plan żelaznego filtra, B4.1 pkt 4).',
    '> Materiał dla księgowej i prawnika przed bramą B2 i B4 planu księgowości.',
    '>',
    '> Numery artykułów w regułach spisała sesja agenta z planu księgowości i źródeł urzędowych;',
    '> prawnik sprawdza każdy przed podpisem (`sprawdzil.prawnik`), także w regułach bez pytania.',
    '',
  ];
  for (const kto of ['księgowa', 'prawnik']) {
    const lista = rejestr.przepisy.filter((p) => p.do_rozstrzygniecia?.kto === kto);
    linie.push(`## ${kto === 'księgowa' ? 'Dla księgowej' : 'Dla prawnika'} (${lista.length})`, '');
    if (lista.length === 0) linie.push('Brak pytań.', '');
    for (const p of lista) {
      const przypadki = p.do_rozstrzygniecia.przypadki.length > 0 ? ` Przypadki: ${p.do_rozstrzygniecia.przypadki.join(', ')}.` : '';
      const podstawa = p.podstawa.map((x) => `${x.przepis} (${x.akt})`).join('; ');
      linie.push(`- **${p.id}** (pewność ${PEWNOSC[p.pewnosc] ?? p.pewnosc}): ${p.do_rozstrzygniecia.pytanie}${przypadki}`);
      linie.push(`  - Reguła: ${p.regula}`);
      linie.push(`  - Podstawa: ${podstawa}.`);
      if (p.interpretacja) linie.push(`  - Jak liczy program: ${p.interpretacja}`);
    }
    linie.push('');
  }
  return `${linie.join('\n').trimEnd()}\n`;
}

function glowna(argumenty) {
  if (argumenty.includes('--pytania')) {
    writeFileSync(join(KATALOG_REPO, PLIK_PYTAN), pytaniaMarkdown());
    console.log(`Zapisano ${PLIK_PYTAN}.`);
    return 0;
  }
  if (argumenty.includes('--sprawdz')) {
    const bledy = bledyRejestru();
    for (const blad of bledy) console.log(`- ${blad}`);
    console.log(bledy.length === 0 ? '[FILTR] Rejestr przepisów spójny.' : `[FILTR] Rejestr: ${bledy.length} błędów.`);
    return bledy.length === 0 ? 0 : 1;
  }
  console.error('Użycie: node scripts/filtr/rejestr.mjs --sprawdz | --pytania');
  return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = glowna(process.argv.slice(2));

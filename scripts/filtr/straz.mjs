#!/usr/bin/env node
// „Filtr: straż” (żelazny filtr, krok F2; plan docs/koordynacja/PLAN-ZELAZNY-FILTR.md, B5.4 i B5.6).
//
// Ocenia PR kodem i mapą z `main`. Z PR czyta przez API tylko DANE: listę
// plików z fragmentami zmian, mapę ryzyka i rejestr przepisów (JSON), opis,
// etykiety i ich autorów. Kodu z PR nie pobiera i nie uruchamia, więc PR nie
// osłabi kontroli, która go ocenia (ten sam wzór co agent-guard.yml).
//
// Wymogi:
//   1. każdy zmieniony plik kodu ma poziom z mapy (wyższy z mapy `main` i z PR);
//   2. plik z sygnałem poza mapą zatrzymuje PR;
//   3. zmiany chronione wymagają etykiety: maszyneria filtra i osłabienie mapy
//      (zgoda:zmiana-filtra), wiedza prawna (zgoda:wiedza-prawna i źródło
//      w karcie), wyjątek (zgoda:wyjatek-filtra i powód w karcie);
//   4. etykieta liczy się tylko od osoby z filtr/zgody.json (z `main`) i tylko
//      nadana po ostatnim pushu; każdy push zdejmuje etykiety zgody;
//   5. PR R1 i R2 ma wypełnioną kartę zmiany prawnej; R1 wskazuje przepisy
//      z rejestru i pliki testów, a zmiana kodu R1 ma nowy albo zmieniony test.
//
// Użycie:
//   node scripts/filtr/straz.mjs --github            w workflow (zdarzenie z GITHUB_EVENT_PATH)
//   node scripts/filtr/straz.mjs --pr <N> [--tylko-raport]
//                                                    lokalnie przez API (token z GH_TOKEN albo `gh auth token`)
// Kod wyjścia: 0 dobrze (albo --tylko-raport), 1 PR nie spełnia wymogów, 2 błąd.

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  KATALOG_REPO,
  SCIEZKA_MAPY,
  czyPlikKodu,
  importyPliku,
  klasyfikujPlik,
  pasujeDoWzorca,
  plikiRepozytorium,
  porownajMapy,
  poziomZeSciezki,
  przygotujMape,
  silaPoziomu,
  wyzszyPoziom,
} from './mapa.mjs';

export const ZGODA_FILTRA = 'zgoda:zmiana-filtra';
export const ZGODA_WIEDZY = 'zgoda:wiedza-prawna';
export const ZGODA_WYJATKU = 'zgoda:wyjatek-filtra';
export const ETYKIETY_ZGODY = [ZGODA_FILTRA, ZGODA_WIEDZY, ZGODA_WYJATKU];
export const SCIEZKA_ZGOD = 'filtr/zgody.json';
export const SCIEZKA_ZAPADKI = 'filtr/zapadka.json';

/** Maszyneria filtra: zmiana wymaga zgoda:zmiana-filtra (plan B5.4, tabela zmian chronionych). */
export const MASZYNERIA = [
  '.github/workflows/**',
  '.github/pull_request_template.md',
  '.github/CODEOWNERS',
  'scripts/filtr/**',
  'scripts/ci/**',
  'eslint/filtr/**',
  'eslint.config.mjs',
  'vitest.filtr.config.ts',
  '.githooks/**',
  '.claude/**',
  SCIEZKA_ZGOD,
];

/** Wiedza prawna: zmiana wymaga zgoda:wiedza-prawna i pola „Źródło zmiany” w karcie. */
export const WIEDZA = [
  'filtr/przepisy/**',
  'lib/ksiegowosc/parametry/**',
  'tests/fixtures/ksiegowosc/zlote/**',
  'tests/filtr/zlote-tymczasowe/**',
  'tests/filtr/zlote-pliki/**',
  'tests/filtr/przyklady-urzedowe/**',
  'tests/filtr/wyrocznia/**',
  'lib/**/schemas/**',
];

/** Testy filtra: dopisywanie wolne, usunięta albo zmieniona linia wymaga zgody. */
export const TESTY_FILTRA = 'tests/filtr/**';

// Test to plik `*.test.*` (w tests/ albo obok kodu, np. lib/xml/); fixture to nie test.
const TEST = /\.test\.(?:tsx|ts|mjs|js)$/;

export const POLA_KARTY = [
  { id: 'poziom', szablon: 'Poziom i obszary z mapy', etykieta: 'Poziom i obszary z mapy', klucz: /^poziom/i },
  { id: 'rodzaj', szablon: 'Rodzaj', etykieta: 'Rodzaj', klucz: /^rodzaj/i },
  { id: 'przepisy', szablon: 'Przepisy z rejestru (id) albo nowy przepis ze źródłem', etykieta: 'Przepisy z rejestru (id) albo nowy przepis ze źródłem', klucz: /^przepisy/i },
  { id: 'zrodlo', szablon: 'Źródło zmiany wiedzy (Dz.U., ISAP, MF, ZUS, podpis księgowej) albo n/d', etykieta: 'Źródło zmiany wiedzy', klucz: /^(?:ź|z)ródło/i },
  { id: 'dla-klienta', szablon: 'Co zmienia się dla klienta (kwoty, terminy, pliki, teksty, nic)', etykieta: 'Co zmienia się dla klienta', klucz: /^co zmienia/i },
  { id: 'zaokraglenia', szablon: 'Zaokrąglenia i kwoty ujemne', etykieta: 'Zaokrąglenia i kwoty ujemne', klucz: /^zaokr/i },
  { id: 'czas', szablon: 'Granice czasu (miesiąc, rok, rok składkowy, strefa)', etykieta: 'Granice czasu', klucz: /^granice/i },
  { id: 'waluty', szablon: 'Waluty, korekty, zaliczki', etykieta: 'Waluty, korekty, zaliczki', klucz: /^waluty/i },
  { id: 'brak-danych', szablon: 'Brak danych: komunikat dla klienta i ścieżka operatora', etykieta: 'Brak danych: komunikat dla klienta i ścieżka operatora', klucz: /^brak danych/i },
  { id: 'tresci', szablon: 'Treści (D8) i dane osobowe', etykieta: 'Treści (D8) i dane osobowe', klucz: /^tre(?:ś|s)ci/i },
  { id: 'dowody', szablon: 'Dowody: test czerwony przed zmianą, niezmienniki, wyrocznia, przykłady, XSD', etykieta: 'Dowody', klucz: /^dowody/i },
  { id: 'drugi-czytelnik', szablon: 'Drugi czytelnik z listą kontrolną (kto, wynik, odpowiedzi na uwagi)', etykieta: 'Drugi czytelnik z listą kontrolną', klucz: /^drugi czytelnik/i },
  { id: 'wyjatki', szablon: 'Wyjątki od filtra (etykieta, powód) albo brak', etykieta: 'Wyjątki od filtra', klucz: /^wyj(?:ą|a)tki/i },
];

export const RODZAJE = ['naprawa', 'nowa funkcja', 'refaktor bez zmiany zachowania', 'tylko testy', 'tylko wiedza'];

const NAGLOWEK_KARTY = /^##\s+Karta zmiany prawnej\b.*$/im;
const PUSTE = /^(?:n\/?d|brak|nie dotyczy|-|)$/i;

// ---------------------------------------------------------------------------
// Karta zmiany prawnej

/**
 * Opis bez komentarzy HTML (podpowiedzi z szablonu PR). Bez wyrażenia
 * regularnego: niezamknięty `<!--` ucina resztę, więc nic nie zostaje
 * w połowie komentarza.
 */
export function bezKomentarzyHtml(tekst) {
  let wynik = '';
  let pozycja = 0;
  while (pozycja < tekst.length) {
    const start = tekst.indexOf('<!--', pozycja);
    if (start === -1) {
      wynik += tekst.slice(pozycja);
      break;
    }
    wynik += tekst.slice(pozycja, start);
    const koniec = tekst.indexOf('-->', start + 4);
    if (koniec === -1) break;
    pozycja = koniec + 3;
  }
  return wynik;
}

/** Pola karty z opisu PR. `null`, gdy w opisie nie ma sekcji karty. */
export function czytajKarte(opis) {
  if (!opis) return null;
  const bezKomentarzy = bezKomentarzyHtml(opis);
  const poczatek = bezKomentarzy.search(NAGLOWEK_KARTY);
  if (poczatek === -1) return null;
  const reszta = bezKomentarzy.slice(poczatek).split('\n').slice(1);
  const koniec = reszta.findIndex((linia) => /^#{1,2}\s/.test(linia));
  const linie = koniec === -1 ? reszta : reszta.slice(0, koniec);
  const pola = {};
  let biezace = null;
  for (const linia of linie) {
    // Najpierw pełna etykieta z szablonu (bywa w niej dwukropek), potem krótka.
    const punkt = /^\s*[-*]\s*(.*)$/.exec(linia);
    const zSzablonu = punkt && POLA_KARTY.find((p) => punkt[1].startsWith(`${p.szablon}:`));
    if (zSzablonu) {
      biezace = zSzablonu.id;
      pola[biezace] = punkt[1].slice(zSzablonu.szablon.length + 1).trim();
      continue;
    }
    const pole = /^\s*[-*]\s*([^:]{2,80}):\s*(.*)$/.exec(linia);
    const definicja = pole && POLA_KARTY.find((p) => p.klucz.test(pole[1].trim()));
    if (definicja) {
      biezace = definicja.id;
      pola[biezace] = pole[2].trim();
      continue;
    }
    if (biezace && linia.trim() !== '') pola[biezace] = `${pola[biezace]} ${linia.trim()}`.trim();
  }
  return pola;
}

export function polePuste(wartosc) {
  return wartosc === undefined || PUSTE.test(wartosc.replace(/[.*_`]/g, '').trim());
}

/** Ścieżki plików testów wymienione w polu (w `…` albo gołe). */
export function plikiTestowWPolu(wartosc) {
  if (!wartosc) return [];
  const sciezki = wartosc.match(/[A-Za-z0-9_.()[\]/-]+\.test\.(?:tsx|ts|mjs|js)(?![A-Za-z])|tests\/[A-Za-z0-9_.()[\]/-]+\.(?:tsx|ts|mjs|json|js|xml)(?![A-Za-z])/g) ?? [];
  return [...new Set(sciezki)];
}

// ---------------------------------------------------------------------------
// Etykiety

/**
 * Etykieta zgody jest ważna, gdy jest na PR, ostatnio nadała ją osoba z listy
 * zgód i stało się to po ostatnim pushu.
 * @param {string} nazwa
 * @param {{ obecne: string[], zdarzenia: {event: string, label?: {name: string}, actor?: {login: string}, created_at?: string}[], osoby: string[], ostatniPush?: string }} kontekst
 */
export function etykietaWazna(nazwa, { obecne, zdarzenia, osoby, ostatniPush }) {
  if (!obecne.includes(nazwa)) return { wazna: false, powod: 'brak etykiety' };
  let ostatnie = null;
  for (const zdarzenie of zdarzenia ?? []) {
    if (zdarzenie.event === 'labeled' && zdarzenie.label?.name === nazwa) ostatnie = zdarzenie;
  }
  if (!ostatnie) return { wazna: false, powod: 'nie wiadomo, kto nadał etykietę' };
  const kto = ostatnie.actor?.login?.toLowerCase() ?? '';
  if (!osoby.map((o) => o.toLowerCase()).includes(kto)) {
    return { wazna: false, powod: `etykietę nadał ${kto || 'nieznany'}, a zgody daje tylko ${osoby.join(', ')}` };
  }
  if (ostatniPush && ostatnie.created_at && Date.parse(ostatnie.created_at) < Date.parse(ostatniPush)) {
    return { wazna: false, powod: 'etykieta sprzed ostatniego pushu' };
  }
  return { wazna: true, kto };
}

// ---------------------------------------------------------------------------
// Fragmenty zmian

/** Dodane i usunięte linie z pola `patch` API GitHub (same hunki, bez nagłówków pliku). */
export function liniePatcha(patch) {
  const dodane = [];
  const usuniete = [];
  for (const linia of (patch ?? '').split('\n')) {
    if (linia.startsWith('@@')) continue;
    if (linia.startsWith('+')) dodane.push(linia.slice(1));
    else if (linia.startsWith('-')) usuniete.push(linia.slice(1));
  }
  return { dodane, usuniete };
}

/** Wzrost zapadki: którakolwiek liczba w JSON (np. dopuszczalne naruszenia) urosła albo pojawiła się nowa. */
export function wzrostZapadki(stara, nowa, sciezka = '') {
  const wzrosty = [];
  if (typeof nowa === 'number') {
    if (typeof stara !== 'number' || nowa > stara) wzrosty.push(`${sciezka || 'wartość'}: ${stara ?? 'brak'} → ${nowa}`);
    return wzrosty;
  }
  if (nowa && typeof nowa === 'object') {
    for (const [klucz, wartosc] of Object.entries(nowa)) {
      wzrosty.push(...wzrostZapadki(stara && typeof stara === 'object' ? stara[klucz] : undefined, wartosc, sciezka ? `${sciezka}.${klucz}` : klucz));
    }
  }
  return wzrosty;
}

/** Identyfikatory przepisów (`RP-…`) z dowolnej budowy plików rejestru. */
export function idPrzepisow(json, zbior = new Set()) {
  if (Array.isArray(json)) for (const element of json) idPrzepisow(element, zbior);
  else if (json && typeof json === 'object') {
    if (typeof json.id === 'string' && /^RP-[A-Z0-9-]+$/.test(json.id)) zbior.add(json.id);
    for (const wartosc of Object.values(json)) idPrzepisow(wartosc, zbior);
  }
  return zbior;
}

const pasuje = (wzorce, plik) => wzorce.some((wzorzec) => pasujeDoWzorca(wzorzec, plik));

// ---------------------------------------------------------------------------
// Ocena PR

/**
 * @param {{
 *   pliki: { plik: string, status: string, poprzedni?: string, patch?: string, tresc?: string }[],
 *   mapaMain: object | null, mapaPR: object | null,
 *   zapadkaMain?: object | null, zapadkaPR?: object | null,
 *   opis: string, etykiety: string[], zdarzenia: object[], osoby: string[], ostatniPush?: string,
 *   plikiRepo: string[], przepisy: Set<string>,
 * }} dane
 */
export function ocenPR(dane) {
  const bledy = [];
  const uwagi = [];
  const wymaganeZgody = new Map();
  const wymagaj = (etykieta, powod) => {
    if (!wymaganeZgody.has(etykieta)) wymaganeZgody.set(etykieta, []);
    wymaganeZgody.get(etykieta).push(powod);
  };

  const surowaMain = dane.mapaMain ?? dane.mapaPR;
  if (!surowaMain) {
    return {
      poziom: 'R1',
      wiersze: [],
      bledy: [{ wymog: 'brak mapy ryzyka', pliki: [SCIEZKA_MAPY], coZrobic: 'Mapa musi być na main albo w PR.', wyjatek: 'brak' }],
      uwagi,
      wymaganeZgody: [],
      ok: false,
    };
  }
  if (!dane.mapaMain) uwagi.push('Na main nie ma jeszcze mapy ryzyka: ocena mapą z PR.');
  const mapaMain = przygotujMape(surowaMain);
  let mapaPR = mapaMain;
  let mapaPRPoprawna = false;
  if (dane.mapaPR && dane.mapaPR !== surowaMain) {
    try {
      mapaPR = przygotujMape(dane.mapaPR);
      mapaPRPoprawna = true;
    } catch (blad) {
      bledy.push({
        wymog: 'mapa ryzyka w PR jest niepoprawna',
        pliki: [SCIEZKA_MAPY],
        coZrobic: blad instanceof Error ? blad.message : 'Popraw budowę pliku.',
        wyjatek: 'brak',
      });
    }
  }

  const zmienione = dane.pliki.filter((p) => p.status !== 'removed');
  const istniejace = new Set([...dane.plikiRepo, ...zmienione.map((p) => p.plik)]);
  const istnieje = (plik) => istniejace.has(plik);

  // 1-2. Klasyfikacja.
  const wiersze = [];
  for (const p of dane.pliki) {
    const { dodane } = liniePatcha(p.patch);
    const tresc = p.tresc ?? dodane.join('\n');
    const importyR1 = importyPliku(p.plik, tresc, istnieje).filter((cel) => poziomZeSciezki(mapaPR, cel) === 'R1');
    const wPR = klasyfikujPlik(mapaPR, p.plik, { tresc, importyR1 });
    const wMain = klasyfikujPlik(mapaMain, p.plik, { tresc, importyR1 });
    // Mapa z main liczy się, gdy plik jest w jej obszarze; brak oceny z main
    // („niesklasyfikowany”) nie podnosi poziomu pliku, który PR dopisał do mapy.
    const poziom = wMain.status === 'obszar' ? wyzszyPoziom(wMain.poziom, wPR.poziom) : wPR.poziom;
    wiersze.push({ ...wPR, poziom, status: wPR.status, obszary: [...new Set([...wPR.obszary, ...wMain.obszary])], zmiana: p.status });
    if (p.poprzedni) {
      const stary = klasyfikujPlik(mapaMain, p.poprzedni, {});
      if (silaPoziomu(stary.poziom) > silaPoziomu(poziom)) {
        wiersze.push({ ...stary, zmiana: 'przeniesiony' });
      }
    }
  }
  const niesklasyfikowane = wiersze.filter((w) => w.status === 'niesklasyfikowany');
  if (niesklasyfikowane.length > 0) {
    bledy.push({
      wymog: 'pliki z sygnałem poza mapą ryzyka',
      pliki: niesklasyfikowane.map((w) => `${w.plik} (sygnały: ${w.sygnaly.slice(0, 4).join(', ')})`),
      coZrobic:
        'Dopisz każdy plik do obszaru w filtr/mapa-ryzyka.json (wolno bez zgody) albo do „wylaczenia” z powodem (osłabienie mapy, zgoda:zmiana-filtra).',
      wyjatek: 'brak: plik musi trafić na mapę',
    });
  }
  const poziom = wiersze.map((w) => w.poziom).reduce(wyzszyPoziom, 'R0');

  // 3. Zmiany chronione.
  const maszyneria = dane.pliki.filter((p) => pasuje(MASZYNERIA, p.plik) || (p.poprzedni && pasuje(MASZYNERIA, p.poprzedni)));
  if (maszyneria.length > 0) wymagaj(ZGODA_FILTRA, `maszyneria filtra: ${maszyneria.map((p) => p.plik).join(', ')}`);
  if (mapaPRPoprawna && dane.mapaMain) {
    for (const oslabienie of porownajMapy(dane.mapaMain, dane.mapaPR, [...istniejace])) {
      wymagaj(ZGODA_FILTRA, `osłabienie mapy: ${oslabienie}`);
    }
  }
  if (dane.zapadkaPR) {
    for (const wzrost of wzrostZapadki(dane.zapadkaMain ?? {}, dane.zapadkaPR)) wymagaj(ZGODA_FILTRA, `wzrost zapadki: ${wzrost}`);
  }
  for (const p of dane.pliki) {
    if (!pasujeDoWzorca(TESTY_FILTRA, p.plik) && !(p.poprzedni && pasujeDoWzorca(TESTY_FILTRA, p.poprzedni))) continue;
    const { usuniete } = liniePatcha(p.patch);
    if (p.status === 'removed' || p.status === 'renamed' || usuniete.length > 0) {
      wymagaj(ZGODA_FILTRA, `zmieniony albo usunięty test filtra: ${p.plik}`);
    }
  }
  const wiedza = dane.pliki.filter((p) => pasuje(WIEDZA, p.plik) || (p.poprzedni && pasuje(WIEDZA, p.poprzedni)));
  if (wiedza.length > 0) wymagaj(ZGODA_WIEDZY, `wiedza prawna: ${wiedza.map((p) => p.plik).join(', ')}`);
  const zWyjatkiem = dane.pliki.filter((p) => liniePatcha(p.patch).dodane.some((linia) => /filtr-wyjatek/.test(linia)));
  if (zWyjatkiem.length > 0) wymagaj(ZGODA_WYJATKU, `nowy komentarz filtr-wyjatek: ${zWyjatkiem.map((p) => p.plik).join(', ')}`);

  // 5. Karta zmiany i testy przy kodzie R1.
  const karta = czytajKarte(dane.opis);
  const testy = zmienione.filter((p) => TEST.test(p.plik));
  const kodR1 = wiersze.filter(
    (w) => w.poziom === 'R1' && w.zmiana !== 'przeniesiony' && !TEST.test(w.plik) && czyPlikKodu(mapaPR, w.plik) && w.zmiana !== 'removed',
  );
  const rodzaj = (karta?.rodzaj ?? '').toLowerCase();
  if (kodR1.length > 0 && testy.length === 0) {
    if (rodzaj.includes('refaktor')) {
      uwagi.push('Refaktor bez nowych testów: dowody w karcie muszą wskazać istniejące testy, złote pliki i wyrocznia bez zmian.');
    } else {
      wymagaj(ZGODA_WYJATKU, `kod R1 bez nowego albo zmienionego testu: ${kodR1.map((w) => w.plik).join(', ')}`);
    }
  }
  if (silaPoziomu(poziom) >= silaPoziomu('R2')) {
    if (!karta) {
      bledy.push({
        wymog: `PR ${poziom} bez karty zmiany prawnej`,
        pliki: wiersze.filter((w) => silaPoziomu(w.poziom) >= silaPoziomu('R2')).map((w) => w.plik).slice(0, 10),
        coZrobic: 'Dodaj do opisu PR sekcję „## Karta zmiany prawnej (filtr)” z szablonu (.github/pull_request_template.md) i wypełnij każde pole.',
        wyjatek: 'brak',
      });
    } else {
      bledy.push(...bledyKarty(karta, { poziom, wiersze, dane, istnieje, wymaganeZgody }));
    }
  }

  // 4. Ważność etykiet.
  const kontekst = { obecne: dane.etykiety, zdarzenia: dane.zdarzenia, osoby: dane.osoby, ostatniPush: dane.ostatniPush };
  for (const [etykieta, powody] of wymaganeZgody) {
    const wynik = etykietaWazna(etykieta, kontekst);
    if (!wynik.wazna) {
      bledy.push({
        wymog: `potrzebna etykieta ${etykieta} (${wynik.powod})`,
        pliki: powody,
        coZrobic:
          etykieta === ZGODA_WIEDZY
            ? 'Wpisz źródło w karcie (pole „Źródło zmiany”) i poproś Bartosza o etykietę po ostatnim pushu.'
            : etykieta === ZGODA_WYJATKU
              ? 'Dodaj test w tests/ albo uzasadnij wyjątek w karcie (pole „Wyjątki od filtra”) i poproś Bartosza o etykietę.'
              : 'Poproś Bartosza o etykietę po ostatnim pushu; agenci etykiet zgody nie nadają.',
        wyjatek: `etykietę nadaje tylko ${dane.osoby.join(', ')} (filtr/zgody.json na main)`,
      });
    }
  }

  return {
    poziom,
    wiersze,
    bledy,
    uwagi,
    wymaganeZgody: [...wymaganeZgody.entries()].map(([etykieta, powody]) => ({ etykieta, powody })),
    ok: bledy.length === 0,
  };
}

function bledyKarty(karta, { poziom, wiersze, dane, istnieje, wymaganeZgody }) {
  const bledy = [];
  const blad = (wymog, coZrobic) => bledy.push({ wymog, pliki: [], coZrobic, wyjatek: 'brak' });
  const brakujace = POLA_KARTY.filter((p) => karta[p.id] === undefined || karta[p.id].trim() === '');
  if (brakujace.length > 0) {
    blad(
      `karta zmiany: puste pola ${brakujace.map((p) => `„${p.etykieta}”`).join(', ')}`,
      'Wypełnij każde pole karty; gdy pole nie dotyczy zmiany, wpisz „n/d”.',
    );
  }
  // Najwyższy poziom wymieniony w karcie („R3 i R1” to R1).
  const deklarowany = (karta.poziom?.match(/R[0-3]/g) ?? []).reduce((a, b) => (a ? wyzszyPoziom(a, b) : b), undefined);
  if (!deklarowany || silaPoziomu(deklarowany) < silaPoziomu(poziom)) {
    blad(
      `karta zmiany: poziom w karcie (${deklarowany ?? 'brak'}) niższy niż z mapy (${poziom})`,
      `Wpisz w polu „Poziom i obszary z mapy” ${poziom} i obszary: ${[...new Set(wiersze.flatMap((w) => w.obszary))].slice(0, 8).join(', ')}.`,
    );
  }
  if (karta.rodzaj !== undefined && RODZAJE.filter((r) => karta.rodzaj.toLowerCase().includes(r)).length > 1) {
    blad('karta zmiany: kilka rodzajów naraz (zostawiony szablon?)', `Zostaw jeden rodzaj: ${RODZAJE.join(', ')}.`);
  } else if (karta.rodzaj !== undefined && !RODZAJE.some((r) => karta.rodzaj.toLowerCase().includes(r))) {
    blad('karta zmiany: nieznany rodzaj', `Wpisz jeden z rodzajów: ${RODZAJE.join(', ')}.`);
  }
  if (polePuste(karta['drugi-czytelnik'] ?? '')) {
    blad('karta zmiany: brak drugiego czytelnika', 'Uruchom /code-review z listą kontrolną (docs/filtr/LISTA-KONTROLNA.md) i wpisz wynik.');
  }
  if (wymaganeZgody.has(ZGODA_WIEDZY) && polePuste(karta.zrodlo ?? '')) {
    blad('karta zmiany: zmiana wiedzy bez źródła', 'Wpisz źródło (Dz.U. z pozycją, ISAP, MF, ZUS albo podpis księgowej) w polu „Źródło zmiany wiedzy”.');
  }
  if (wymaganeZgody.has(ZGODA_WYJATKU) && polePuste(karta.wyjatki ?? '')) {
    blad('karta zmiany: wyjątek bez uzasadnienia', 'Opisz w polu „Wyjątki od filtra”, dlaczego zmiana nie ma testu albo ma komentarz filtr-wyjatek.');
  }
  if (poziom === 'R1') {
    if (polePuste(karta.przepisy ?? '')) {
      blad('karta zmiany: R1 bez przepisów', 'Wskaż id reguł z rejestru (RP-…) albo nowy przepis ze źródłem.');
    } else if (dane.przepisy.size > 0) {
      const podane = karta.przepisy.match(/RP-[A-Z0-9-]+/g) ?? [];
      const nieznane = podane.filter((id) => !dane.przepisy.has(id));
      if (podane.length === 0 && !/nowy przepis/i.test(karta.przepisy)) {
        blad('karta zmiany: R1 bez id reguły z rejestru', 'Wskaż id reguł (RP-…) z filtr/przepisy/ albo napisz „nowy przepis:” ze źródłem.');
      }
      if (nieznane.length > 0) {
        blad(`karta zmiany: nieznane id w rejestrze: ${nieznane.join(', ')}`, 'Popraw id albo dodaj regułę do rejestru w tym PR (zgoda:wiedza-prawna).');
      }
    }
    const testy = plikiTestowWPolu(karta.dowody);
    const istniejaceTesty = testy.filter((t) => istnieje(t));
    if (istniejaceTesty.length === 0) {
      blad(
        testy.length === 0 ? 'karta zmiany: R1 bez plików testów w dowodach' : `karta zmiany: dowody wskazują nieistniejące pliki: ${testy.join(', ')}`,
        'Wpisz w polu „Dowody” ścieżki testów (np. `tests/unit/…test.ts`), które są w PR albo w repozytorium.',
      );
    }
  }
  return bledy;
}

// ---------------------------------------------------------------------------
// Raport

const ETYKIETA_POZIOMU = { R1: 'R1 krytyczny', R2: 'R2 wprowadza w błąd', R3: 'R3 pomocniczy', R0: 'R0 bez ryzyka prawnego' };

export function raport(wynik) {
  const linie = [`## Filtr: straż (poziom PR: ${ETYKIETA_POZIOMU[wynik.poziom]})`, ''];
  if (wynik.ok) linie.push('Wymogi filtra spełnione.', '');
  else {
    linie.push(`**PR nie spełnia wymogów filtra (${wynik.bledy.length}).**`, '');
    for (const blad of wynik.bledy) {
      linie.push(`- [FILTR ${wynik.poziom}] ${blad.wymog}`);
      for (const plik of blad.pliki.slice(0, 15)) linie.push(`  - ${plik}`);
      linie.push(`  - Co zrobić: ${blad.coZrobic}`, `  - Wyjątek: ${blad.wyjatek}`);
    }
    linie.push('');
  }
  for (const uwaga of wynik.uwagi) linie.push(`> ${uwaga}`);
  const istotne = wynik.wiersze.filter((w) => w.poziom !== 'R0' || w.status === 'niesklasyfikowany');
  if (istotne.length > 0) {
    linie.push('', '| Plik | Obszar | Poziom |', '|---|---|---|');
    for (const w of istotne.slice(0, 200)) {
      linie.push(`| \`${w.plik}\` | ${w.status === 'niesklasyfikowany' ? 'poza mapą' : w.obszary.join(', ')} | ${w.poziom} |`);
    }
    if (istotne.length > 200) linie.push(`| … | ${istotne.length - 200} plików więcej | |`);
  }
  linie.push('', 'Plan: docs/koordynacja/PLAN-ZELAZNY-FILTR.md, B5.4 i B6.');
  return linie.join('\n');
}

// ---------------------------------------------------------------------------
// GitHub API (tylko dane z PR, bez kodu)

async function gh(sciezka, { metoda = 'GET', token, brak404 = false, surowo = false } = {}) {
  const odpowiedz = await fetch(`https://api.github.com${sciezka}`, {
    method: metoda,
    headers: {
      Accept: surowo ? 'application/vnd.github.raw' : 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (brak404 && odpowiedz.status === 404) return null;
  if (!odpowiedz.ok) throw new Error(`GitHub API ${metoda} ${sciezka.split('?')[0]}: HTTP ${odpowiedz.status}`);
  if (odpowiedz.status === 204) return null;
  return surowo ? odpowiedz.text() : odpowiedz.json();
}

async function wszystkieStrony(sciezka, token) {
  const wynik = [];
  for (let strona = 1; strona <= 30; strona++) {
    const separator = sciezka.includes('?') ? '&' : '?';
    const paczka = await gh(`${sciezka}${separator}per_page=100&page=${strona}`, { token });
    wynik.push(...paczka);
    if (paczka.length < 100) break;
  }
  return wynik;
}

async function plikZPR(baza, sciezka, sha, token) {
  return gh(`${baza}/contents/${sciezka.split('/').map(encodeURIComponent).join('/')}?ref=${sha}`, { token, brak404: true, surowo: true });
}

function zDysku(sciezka) {
  const pelna = join(KATALOG_REPO, sciezka);
  return existsSync(pelna) ? JSON.parse(readFileSync(pelna, 'utf8')) : null;
}

function przepisyZDysku() {
  const katalog = join(KATALOG_REPO, 'filtr/przepisy');
  const zbior = new Set();
  if (!existsSync(katalog)) return zbior;
  for (const plik of readdirSync(katalog).filter((p) => p.endsWith('.json'))) {
    idPrzepisow(JSON.parse(readFileSync(join(katalog, plik), 'utf8')), zbior);
  }
  return zbior;
}

/** Zbiera dane PR przez API. Kod z PR nie jest pobierany: tylko JSON mapy, rejestru i zapadki. */
export async function zbierzDane({ repo, numer, token }) {
  const baza = `/repos/${repo}`;
  const pr = await gh(`${baza}/pulls/${numer}`, { token });
  const [plikiApi, zdarzenia, commity] = await Promise.all([
    wszystkieStrony(`${baza}/pulls/${numer}/files`, token),
    wszystkieStrony(`${baza}/issues/${numer}/events`, token),
    wszystkieStrony(`${baza}/pulls/${numer}/commits`, token),
  ]);
  const sha = pr.head.sha;
  const mapaMain = zDysku(SCIEZKA_MAPY);
  const mapa = mapaMain ? przygotujMape(mapaMain) : null;
  const pliki = [];
  for (const p of plikiApi) {
    const wpis = { plik: p.filename, status: p.status, poprzedni: p.previous_filename, patch: p.patch };
    // Brak fragmentu (duży plik): treść z PR tylko dla pliku kodu spoza mapy,
    // żeby szukać sygnałów (dane, nie wykonanie).
    if (!p.patch && p.status !== 'removed' && (!mapa || czyPlikKodu(mapa, p.filename))) {
      wpis.tresc = (await plikZPR(baza, p.filename, sha, token)) ?? '';
    }
    pliki.push(wpis);
  }
  const zmienioneSciezki = new Set(plikiApi.map((p) => p.filename));
  const json = async (sciezka) => {
    if (!zmienioneSciezki.has(sciezka)) return null;
    const tekst = await plikZPR(baza, sciezka, sha, token);
    if (tekst === null) return null;
    try {
      return JSON.parse(tekst);
    } catch {
      return { blad: `niepoprawny JSON w ${sciezka}` };
    }
  };
  const przepisy = przepisyZDysku();
  for (const sciezka of zmienioneSciezki) {
    if (pasujeDoWzorca('filtr/przepisy/*.json', sciezka)) idPrzepisow(await json(sciezka), przepisy);
  }
  const zgody = zDysku(SCIEZKA_ZGOD) ?? { osoby: [] };
  const ostatni = commity.at(-1);
  return {
    pr,
    dane: {
      pliki,
      mapaMain,
      mapaPR: (await json(SCIEZKA_MAPY)) ?? mapaMain,
      zapadkaMain: zDysku(SCIEZKA_ZAPADKI),
      zapadkaPR: await json(SCIEZKA_ZAPADKI),
      opis: pr.body ?? '',
      etykiety: (pr.labels ?? []).map((l) => l.name),
      zdarzenia,
      osoby: zgody.osoby ?? [],
      ostatniPush: ostatni?.commit?.committer?.date,
      plikiRepo: plikiRepozytorium(),
      przepisy,
    },
  };
}

function token() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
}

async function glowna(argumenty) {
  const tylkoRaport = argumenty.includes('--tylko-raport');
  let repo;
  let numer;
  let zdarzenie = null;
  if (argumenty.includes('--github')) {
    zdarzenie = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    repo = process.env.GITHUB_REPOSITORY;
    numer = zdarzenie.pull_request?.number;
  } else if (argumenty.includes('--pr')) {
    numer = Number(argumenty[argumenty.indexOf('--pr') + 1]);
    repo = process.env.GITHUB_REPOSITORY ?? 'ezior8888-cpu/FaktWay';
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '') || !Number.isInteger(numer) || numer <= 0) {
    console.error('Użycie: node scripts/filtr/straz.mjs --github | --pr <N> [--tylko-raport]');
    return 2;
  }
  const klucz = token();
  // Nowy push zdejmuje etykiety zgody: zgoda dotyczy tego, co Bartosz widział.
  if (zdarzenie?.action === 'synchronize' && !tylkoRaport) {
    for (const etykieta of (zdarzenie.pull_request.labels ?? []).map((l) => l.name).filter((n) => ETYKIETY_ZGODY.includes(n))) {
      await gh(`/repos/${repo}/issues/${numer}/labels/${encodeURIComponent(etykieta)}`, { metoda: 'DELETE', token: klucz, brak404: true });
      console.log(`Nowy push: zdjęto etykietę ${etykieta}; zgoda potrzebna ponownie.`);
    }
  }
  const { dane } = await zbierzDane({ repo, numer, token: klucz });
  if (zdarzenie?.action === 'synchronize') dane.etykiety = dane.etykiety.filter((n) => !ETYKIETY_ZGODY.includes(n));
  const wynik = ocenPR(dane);
  const tekst = raport(wynik);
  console.log(tekst);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${tekst}\n`);
  return wynik.ok || tylkoRaport ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  glowna(process.argv.slice(2))
    .then((kod) => {
      process.exitCode = kod;
    })
    .catch((blad) => {
      console.error(`Filtr: straż: ${blad instanceof Error ? blad.message : 'nieznany błąd'}`);
      process.exitCode = 2;
    });
}

#!/usr/bin/env node
// Klasyfikator mapy ryzyka prawnego (żelazny filtr, krok F1).
//
// Mapa `filtr/mapa-ryzyka.json` przypisuje każdemu plikowi kodu poziom:
//   R1 krytyczny: zły wynik zmienia kwotę podatku albo składki, termin,
//      dokument dla urzędu albo kontrahenta (faktura, JPK, KSeF) albo
//      przechowywanie danych;
//   R2 wprowadza w błąd: nie jest dokumentem, ale może skłonić klienta do
//      złej decyzji o pieniądzach;
//   R3 pomocniczy: kod, z którego korzystają R1 i R2;
//   R0 bez ryzyka prawnego.
// Zasady (plan `docs/koordynacja/PLAN-ZELAZNY-FILTR.md`, B2 i B3):
//   1. plik w ścieżce obszaru dziedziczy jego poziom; kilka obszarów daje
//      najwyższy poziom;
//   2. plik kodu spoza obszarów i spoza wyłączeń, w którym jest sygnał
//      (słowo, wzorzec, nazwa pliku, import pliku R1), jest
//      „niesklasyfikowany” i zatrzymuje zmianę, dopóki nie trafi na mapę;
//   3. mapa z PR nie może osłabić mapy z `main` bez zgody (porownajMapy).
// Ten sam kod działa w teście pełnego skanu, w hookach Claude, w pre-push
// i w CI, dlatego nie ma zależności spoza Node.
//
// Użycie:
//   node scripts/filtr/mapa.mjs --skan [--json]
//       pełny skan repozytorium (pliki z `git ls-files`)
//   node scripts/filtr/mapa.mjs --diff [baza] [--json]
//       zmiana względem bazy (domyślnie origin/main), sygnały z dodanych linii
//   node scripts/filtr/mapa.mjs --diff-z-pliku <plik.diff|-> [--json]
//       zmiana z gotowego diffu (np. `gh pr diff N`)
//   node scripts/filtr/mapa.mjs [--json] <plik>...
//       podane pliki, sygnały z całej treści
// Kod wyjścia: 0 dobrze, 1 pliki niesklasyfikowane albo błędy mapy, 2 złe użycie.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const KATALOG_REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SCIEZKA_MAPY = 'filtr/mapa-ryzyka.json';

/** Poziomy od najsłabszego do najmocniejszego. */
export const POZIOMY = ['R0', 'R3', 'R2', 'R1'];

export function silaPoziomu(poziom) {
  const sila = POZIOMY.indexOf(poziom);
  if (sila === -1) throw new Error(`Nieznany poziom ryzyka: ${poziom}`);
  return sila;
}

export function wyzszyPoziom(a, b) {
  return silaPoziomu(a) >= silaPoziomu(b) ? a : b;
}

// ---------------------------------------------------------------------------
// Wzorce ścieżek
//
// Obsługiwane: `**` (dowolna liczba katalogów), `*` (dowolne znaki bez `/`),
// `?` (jeden znak bez `/`), `{a,b}` (alternatywa, może zawierać wzorce).
// Nawiasy okrągłe i kwadratowe są dosłowne, bo Next.js używa ich w nazwach
// katalogów (`app/(dashboard)/invoices/[id]/`).

const pamiecWzorcow = new Map();

function zamykajacyNawias(wzorzec, start) {
  let glebokosc = 0;
  for (let i = start; i < wzorzec.length; i++) {
    if (wzorzec[i] === '{') glebokosc++;
    if (wzorzec[i] === '}') {
      glebokosc--;
      if (glebokosc === 0) return i;
    }
  }
  throw new Error(`Niezamknięty nawias „{” we wzorcu: ${wzorzec}`);
}

function podzielAlternatywy(tekst) {
  const czesci = [];
  let glebokosc = 0;
  let poczatek = 0;
  for (let i = 0; i < tekst.length; i++) {
    if (tekst[i] === '{') glebokosc++;
    if (tekst[i] === '}') glebokosc--;
    if (tekst[i] === ',' && glebokosc === 0) {
      czesci.push(tekst.slice(poczatek, i));
      poczatek = i + 1;
    }
  }
  czesci.push(tekst.slice(poczatek));
  return czesci;
}

function zrodloWzorca(wzorzec) {
  let wynik = '';
  for (let i = 0; i < wzorzec.length; i++) {
    const znak = wzorzec[i];
    if (znak === '*') {
      if (wzorzec[i + 1] === '*') {
        if (wzorzec[i + 2] === '/') {
          wynik += '(?:[^/]+/)*';
          i += 2;
        } else {
          wynik += '.*';
          i += 1;
        }
        continue;
      }
      wynik += '[^/]*';
      continue;
    }
    if (znak === '?') {
      wynik += '[^/]';
      continue;
    }
    if (znak === '{') {
      const koniec = zamykajacyNawias(wzorzec, i);
      const alternatywy = podzielAlternatywy(wzorzec.slice(i + 1, koniec)).map(zrodloWzorca);
      wynik += `(?:${alternatywy.join('|')})`;
      i = koniec;
      continue;
    }
    wynik += znak.replace(/[\\^$.+?()[\]{}|]/g, '\\$&');
  }
  return wynik;
}

export function wzorzecNaRegex(wzorzec) {
  let regex = pamiecWzorcow.get(wzorzec);
  if (!regex) {
    regex = new RegExp(`^${zrodloWzorca(wzorzec)}$`);
    pamiecWzorcow.set(wzorzec, regex);
  }
  return regex;
}

export function pasujeDoWzorca(wzorzec, plik) {
  return wzorzecNaRegex(wzorzec).test(plik);
}

// ---------------------------------------------------------------------------
// Mapa

export function wczytajMape(sciezka = join(KATALOG_REPO, SCIEZKA_MAPY)) {
  return przygotujMape(JSON.parse(readFileSync(sciezka, 'utf8')));
}

/**
 * Sprawdza budowę mapy i kompiluje sygnały. Rzuca błąd z listą problemów,
 * bo zła mapa nie może po cichu przepuszczać plików.
 */
export function przygotujMape(surowa) {
  const bledy = bledyMapy(surowa);
  if (bledy.length > 0) {
    throw new Error(`Mapa ryzyka jest niepoprawna:\n- ${bledy.join('\n- ')}`);
  }
  const sygnaly = surowa.sygnaly;
  return {
    ...surowa,
    _tresc: sygnaly.tresc.map((s) => ({ id: s.id, regex: new RegExp(s.wzorzec, s.flagi ?? '') })),
    _nazwy: sygnaly.nazwy.map((s) => ({ id: s.id, regex: new RegExp(s.wzorzec) })),
  };
}

export function bledyMapy(mapa) {
  const bledy = [];
  if (!mapa || typeof mapa !== 'object') return ['mapa nie jest obiektem JSON'];
  if (mapa.wersja !== 1) bledy.push('pole „wersja” musi mieć wartość 1');
  const kod = mapa.kod;
  if (!kod || !Array.isArray(kod.katalogi) || kod.katalogi.length === 0) {
    bledy.push('brak listy „kod.katalogi”');
  }
  if (!kod || !Array.isArray(kod.rozszerzenia) || kod.rozszerzenia.length === 0) {
    bledy.push('brak listy „kod.rozszerzenia”');
  }
  if (!Array.isArray(mapa.obszary) || mapa.obszary.length === 0) {
    bledy.push('brak listy „obszary”');
    return bledy;
  }
  const idObszarow = new Set();
  for (const [i, obszar] of mapa.obszary.entries()) {
    const gdzie = `obszary[${i}]${obszar?.id ? ` (${obszar.id})` : ''}`;
    if (!obszar.id || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(obszar.id)) {
      bledy.push(`${gdzie}: id musi być z małych liter, cyfr, kropek i łączników`);
    }
    if (idObszarow.has(obszar.id)) bledy.push(`${gdzie}: powtórzone id`);
    idObszarow.add(obszar.id);
    if (!POZIOMY.includes(obszar.poziom)) bledy.push(`${gdzie}: poziom musi być jednym z ${POZIOMY.join(', ')}`);
    if (obszar.poziom === 'R0') {
      bledy.push(`${gdzie}: obszar nie może mieć poziomu R0; pliki bez ryzyka z sygnałem idą do „wylaczenia” z powodem`);
    }
    if (typeof obszar.opis !== 'string' || obszar.opis.trim().length < 10) {
      bledy.push(`${gdzie}: brak opisu (co tu się liczy i dlaczego ten poziom)`);
    }
    if (!Array.isArray(obszar.sciezki) || obszar.sciezki.length === 0) {
      bledy.push(`${gdzie}: brak ścieżek`);
    } else {
      for (const wzorzec of obszar.sciezki) bledy.push(...bledyWzorca(wzorzec, gdzie));
    }
  }
  if (!Array.isArray(mapa.wylaczenia)) {
    bledy.push('brak listy „wylaczenia” (może być pusta)');
  } else {
    for (const [i, wylaczenie] of mapa.wylaczenia.entries()) {
      const gdzie = `wylaczenia[${i}]`;
      if (!Array.isArray(wylaczenie.sciezki) || wylaczenie.sciezki.length === 0) {
        bledy.push(`${gdzie}: brak ścieżek`);
      } else {
        for (const wzorzec of wylaczenie.sciezki) bledy.push(...bledyWzorca(wzorzec, gdzie));
      }
      if (typeof wylaczenie.powod !== 'string' || wylaczenie.powod.trim().length < 15) {
        bledy.push(`${gdzie}: wyłączenie wymaga powodu (co najmniej jedno zdanie)`);
      }
    }
  }
  const sygnaly = mapa.sygnaly;
  if (!sygnaly || !Array.isArray(sygnaly.tresc) || !Array.isArray(sygnaly.nazwy)) {
    bledy.push('brak list „sygnaly.tresc” i „sygnaly.nazwy”');
    return bledy;
  }
  for (const lista of ['tresc', 'nazwy']) {
    const idSygnalow = new Set();
    for (const [i, sygnal] of sygnaly[lista].entries()) {
      const gdzie = `sygnaly.${lista}[${i}]${sygnal?.id ? ` (${sygnal.id})` : ''}`;
      if (!sygnal.id) bledy.push(`${gdzie}: brak id`);
      if (idSygnalow.has(sygnal.id)) bledy.push(`${gdzie}: powtórzone id`);
      idSygnalow.add(sygnal.id);
      if (lista === 'nazwy' && sygnal.flagi) bledy.push(`${gdzie}: nazwy są już małymi literami, flagi zbędne`);
      try {
        new RegExp(sygnal.wzorzec, sygnal.flagi ?? '');
      } catch (blad) {
        bledy.push(`${gdzie}: zły wzorzec (${blad.message})`);
      }
    }
  }
  return bledy;
}

function bledyWzorca(wzorzec, gdzie) {
  if (typeof wzorzec !== 'string' || wzorzec.length === 0) return [`${gdzie}: pusty wzorzec ścieżki`];
  if (wzorzec.startsWith('/') || wzorzec.startsWith('./')) {
    return [`${gdzie}: wzorzec „${wzorzec}” musi być względny wobec katalogu repozytorium, bez „/” i „./”`];
  }
  try {
    wzorzecNaRegex(wzorzec);
  } catch (blad) {
    return [`${gdzie}: ${blad.message}`];
  }
  return [];
}

export function czyPlikKodu(mapa, plik) {
  const wKatalogu = mapa.kod.katalogi.some((katalog) =>
    katalog.endsWith('/') ? plik.startsWith(katalog) : plik === katalog,
  );
  if (!wKatalogu) return false;
  if (mapa.kod.pomijane?.some((wzorzec) => pasujeDoWzorca(wzorzec, plik))) return false;
  return mapa.kod.rozszerzenia.some((rozszerzenie) => plik.endsWith(rozszerzenie));
}

export function obszaryPliku(mapa, plik) {
  return mapa.obszary.filter((obszar) => obszar.sciezki.some((wzorzec) => pasujeDoWzorca(wzorzec, plik)));
}

export function wylaczeniePliku(mapa, plik) {
  return mapa.wylaczenia.find((wylaczenie) => wylaczenie.sciezki.some((wzorzec) => pasujeDoWzorca(wzorzec, plik)));
}

// ---------------------------------------------------------------------------
// Sygnały

/** Nazwa pliku w postaci „słowo-słowo-…”: `invoiceVatSummary.ts` → `invoice-vat-summary-ts`. */
export function znormalizowanaNazwa(plik) {
  return basename(plik)
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9ąćęłńóśźż]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function sygnalyNazwy(mapa, plik) {
  const nazwa = znormalizowanaNazwa(plik);
  return mapa._nazwy.filter((s) => s.regex.test(nazwa)).map((s) => `nazwa:${s.id}`);
}

export function sygnalyTresci(mapa, tekst) {
  if (!tekst) return [];
  return mapa._tresc.filter((s) => s.regex.test(tekst)).map((s) => s.id);
}

const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)['"](@\/[^'"]+|\.{1,2}\/[^'"]+)['"]/g;
const ROZSZERZENIA_IMPORTU = ['', '.ts', '.tsx', '.mjs', '.js', '/index.ts', '/index.tsx', '/index.js'];

/** Ścieżki repozytorium, które plik importuje (alias `@/` i ścieżki względne). */
export function importyPliku(plik, tekst, istnieje) {
  const wynik = new Set();
  if (!tekst) return [];
  for (const dopasowanie of tekst.matchAll(IMPORT)) {
    const cel = dopasowanie[1];
    const baza = cel.startsWith('@/') ? cel.slice(2) : posix.normalize(posix.join(posix.dirname(plik), cel));
    for (const rozszerzenie of ROZSZERZENIA_IMPORTU) {
      const kandydat = `${baza}${rozszerzenie}`;
      if (istnieje(kandydat)) {
        wynik.add(kandydat);
        break;
      }
    }
  }
  return [...wynik];
}

// ---------------------------------------------------------------------------
// Klasyfikacja

/**
 * @param {object} mapa przygotowana mapa
 * @param {string} plik ścieżka względna wobec repozytorium
 * @param {{ tresc?: string, importyR1?: string[] }} dane
 *   `tresc`: tekst, w którym szukamy sygnałów (cały plik albo dodane linie),
 *   `importyR1`: importowane pliki z poziomem R1 (sygnał „import-r1”)
 */
export function klasyfikujPlik(mapa, plik, dane = {}) {
  const obszary = obszaryPliku(mapa, plik);
  if (obszary.length > 0) {
    const poziom = obszary.map((o) => o.poziom).reduce(wyzszyPoziom);
    return { plik, status: 'obszar', poziom, obszary: obszary.map((o) => o.id), sygnaly: [] };
  }
  if (!czyPlikKodu(mapa, plik)) {
    return { plik, status: 'poza-kodem', poziom: 'R0', obszary: [], sygnaly: [] };
  }
  const wylaczenie = wylaczeniePliku(mapa, plik);
  if (wylaczenie) {
    return { plik, status: 'wylaczony', poziom: 'R0', obszary: [], sygnaly: [], powod: wylaczenie.powod };
  }
  const sygnaly = [
    ...sygnalyNazwy(mapa, plik),
    ...sygnalyTresci(mapa, dane.tresc),
    ...(dane.importyR1 ?? []).map((cel) => `import-r1:${cel}`),
  ];
  if (sygnaly.length > 0) {
    return { plik, status: 'niesklasyfikowany', poziom: 'R1', obszary: [], sygnaly };
  }
  return { plik, status: 'bez-sygnalu', poziom: 'R0', obszary: [], sygnaly: [] };
}

/** Poziom pliku tylko ze ścieżki (bez treści): do importów i porównań map. */
export function poziomZeSciezki(mapa, plik) {
  const obszary = obszaryPliku(mapa, plik);
  return obszary.length > 0 ? obszary.map((o) => o.poziom).reduce(wyzszyPoziom) : 'R0';
}

/**
 * Klasyfikuje zbiór plików. Niesklasyfikowany plik liczy się jak R1:
 * dopóki nie trafi na mapę, filtr zakłada najgorsze.
 * @param {object} mapa
 * @param {{ plik: string, tresc?: string, importyR1?: string[] }[]} pliki
 */
export function klasyfikujZmiane(mapa, pliki) {
  const wyniki = pliki.map(({ plik, ...dane }) => klasyfikujPlik(mapa, plik, dane));
  const poziom = wyniki.map((w) => w.poziom).reduce(wyzszyPoziom, 'R0');
  return {
    poziom,
    pliki: wyniki,
    niesklasyfikowane: wyniki.filter((w) => w.status === 'niesklasyfikowany'),
  };
}

// ---------------------------------------------------------------------------
// Pełny skan repozytorium

export function plikiRepozytorium(katalog = KATALOG_REPO) {
  return execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: katalog, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0')
    .filter(Boolean)
    .filter((plik) => existsSync(join(katalog, plik)));
}

/**
 * Pełny skan: każdy plik kodu ma poziom, żaden plik z sygnałem nie jest
 * poza mapą, żaden wzorzec mapy nie jest martwy.
 */
export function skanujRepozytorium(mapa, { katalog = KATALOG_REPO, pliki = plikiRepozytorium(katalog) } = {}) {
  const zbior = new Set(pliki);
  const istnieje = (p) => zbior.has(p);
  const tresci = new Map();
  const czytaj = (p) => {
    if (!tresci.has(p)) tresci.set(p, readFileSync(join(katalog, p), 'utf8'));
    return tresci.get(p);
  };
  const wyniki = [];
  for (const plik of pliki) {
    if (!czyPlikKodu(mapa, plik) && obszaryPliku(mapa, plik).length === 0) continue;
    const tresc = czyPlikKodu(mapa, plik) ? czytaj(plik) : undefined;
    const importyR1 = tresc
      ? importyPliku(plik, tresc, istnieje).filter((cel) => poziomZeSciezki(mapa, cel) === 'R1')
      : [];
    wyniki.push(klasyfikujPlik(mapa, plik, { tresc, importyR1 }));
  }
  return {
    wyniki,
    niesklasyfikowane: wyniki.filter((w) => w.status === 'niesklasyfikowany'),
    martweWzorce: martweWzorce(mapa, pliki),
    liczby: policzPoziomy(wyniki),
  };
}

export function martweWzorce(mapa, pliki) {
  const martwe = [];
  const sprawdz = (wzorzec, gdzie) => {
    if (!pliki.some((plik) => pasujeDoWzorca(wzorzec, plik))) martwe.push({ wzorzec, gdzie });
  };
  for (const obszar of mapa.obszary) for (const wzorzec of obszar.sciezki) sprawdz(wzorzec, obszar.id);
  for (const [i, wylaczenie] of mapa.wylaczenia.entries()) {
    for (const wzorzec of wylaczenie.sciezki) sprawdz(wzorzec, `wylaczenia[${i}]`);
  }
  return martwe;
}

function policzPoziomy(wyniki) {
  const liczby = { R1: 0, R2: 0, R3: 0, R0: 0, niesklasyfikowane: 0, wylaczone: 0 };
  for (const wynik of wyniki) {
    if (wynik.status === 'niesklasyfikowany') liczby.niesklasyfikowane++;
    else liczby[wynik.poziom]++;
    if (wynik.status === 'wylaczony') liczby.wylaczone++;
  }
  return liczby;
}

// ---------------------------------------------------------------------------
// Osłabienie mapy (używa straż w CI, krok F2)

/**
 * Zmiany mapy, które osłabiają filtr i wymagają zgody `zgoda:zmiana-filtra`:
 * usunięty obszar, niższy poziom, usunięta ścieżka, nowe albo szersze
 * wyłączenie, mniej sygnałów, mniej katalogów kodu. Do tego konkretne pliki,
 * których poziom spadł (porównanie na liście plików repozytorium).
 */
export function porownajMapy(stara, nowa, pliki = []) {
  const oslabienia = [];
  const noweObszary = new Map(nowa.obszary.map((o) => [o.id, o]));
  for (const obszar of stara.obszary) {
    const nowy = noweObszary.get(obszar.id);
    if (!nowy) {
      oslabienia.push(`usunięty obszar ${obszar.id} (${obszar.poziom})`);
      continue;
    }
    if (silaPoziomu(nowy.poziom) < silaPoziomu(obszar.poziom)) {
      oslabienia.push(`obszar ${obszar.id}: poziom ${obszar.poziom} → ${nowy.poziom}`);
    }
    for (const wzorzec of obszar.sciezki) {
      if (!nowy.sciezki.includes(wzorzec)) oslabienia.push(`obszar ${obszar.id}: usunięta ścieżka ${wzorzec}`);
    }
  }
  const stareWylaczenia = new Set(stara.wylaczenia.flatMap((w) => w.sciezki));
  for (const wylaczenie of nowa.wylaczenia) {
    for (const wzorzec of wylaczenie.sciezki) {
      if (!stareWylaczenia.has(wzorzec)) oslabienia.push(`nowe wyłączenie ${wzorzec}`);
    }
  }
  const brakujace = (lista, nowaLista, opis) => {
    const nowe = new Set(nowaLista.map((s) => `${s.id}\u0000${s.wzorzec}\u0000${s.flagi ?? ''}`));
    for (const s of lista) {
      if (!nowe.has(`${s.id}\u0000${s.wzorzec}\u0000${s.flagi ?? ''}`)) oslabienia.push(`${opis}: usunięty albo zmieniony ${s.id}`);
    }
  };
  brakujace(stara.sygnaly.tresc, nowa.sygnaly.tresc, 'sygnał treści');
  brakujace(stara.sygnaly.nazwy, nowa.sygnaly.nazwy, 'sygnał nazwy');
  for (const katalog of stara.kod.katalogi) {
    if (!nowa.kod.katalogi.includes(katalog)) oslabienia.push(`usunięty katalog kodu ${katalog}`);
  }
  for (const rozszerzenie of stara.kod.rozszerzenia) {
    if (!nowa.kod.rozszerzenia.includes(rozszerzenie)) oslabienia.push(`usunięte rozszerzenie kodu ${rozszerzenie}`);
  }
  for (const wzorzec of nowa.kod.pomijane ?? []) {
    if (!(stara.kod.pomijane ?? []).includes(wzorzec)) oslabienia.push(`nowy pomijany wzorzec kodu ${wzorzec}`);
  }
  const staraGotowa = stara._tresc ? stara : przygotujMape(stara);
  const nowaGotowa = nowa._tresc ? nowa : przygotujMape(nowa);
  for (const plik of pliki) {
    const przed = poziomZeSciezki(staraGotowa, plik);
    const po = poziomZeSciezki(nowaGotowa, plik);
    if (silaPoziomu(po) < silaPoziomu(przed)) oslabienia.push(`plik ${plik}: poziom ${przed} → ${po}`);
  }
  return oslabienia;
}

// ---------------------------------------------------------------------------
// Diff

/**
 * Z diffu w formacie unified (git diff, gh pr diff) wyciąga zmienione pliki
 * i ich dodane linie. Usunięty plik ma pustą listę linii, ale jest na liście
 * (usunięcie pliku R1 to zmiana R1). Zmiana nazwy daje obie ścieżki.
 */
export function plikiZDiffu(diff) {
  const pliki = new Map();
  let biezacy = null;
  const dodaj = (sciezka) => {
    if (!sciezka || sciezka === '/dev/null') return null;
    if (!pliki.has(sciezka)) pliki.set(sciezka, []);
    return sciezka;
  };
  for (const linia of diff.split('\n')) {
    if (linia.startsWith('diff --git ')) {
      biezacy = null;
      const dopasowanie = /^diff --git a\/(.+?) b\/(.+)$/.exec(linia);
      if (dopasowanie) {
        dodaj(dopasowanie[1]);
        biezacy = dodaj(dopasowanie[2]);
      }
      continue;
    }
    if (linia.startsWith('--- ')) continue;
    if (linia.startsWith('+++ ')) {
      const cel = linia.slice(4).replace(/^b\//, '');
      if (cel !== '/dev/null') biezacy = dodaj(cel);
      continue;
    }
    if (linia.startsWith('rename from ')) dodaj(linia.slice('rename from '.length));
    if (linia.startsWith('rename to ')) biezacy = dodaj(linia.slice('rename to '.length));
    if (biezacy && linia.startsWith('+')) pliki.get(biezacy).push(linia.slice(1));
  }
  return [...pliki.entries()].map(([plik, linie]) => ({ plik, tresc: linie.join('\n') }));
}

/** Importy R1 w dodanych liniach: zmiana zaczyna korzystać z kodu R1. */
function zImportamiR1(mapa, pliki, istnieje) {
  return pliki.map(({ plik, tresc }) => ({
    plik,
    tresc,
    importyR1: importyPliku(plik, tresc, istnieje).filter((cel) => poziomZeSciezki(mapa, cel) === 'R1'),
  }));
}

// ---------------------------------------------------------------------------
// Wyjście

const OPIS_POZIOMU = {
  R1: 'R1 krytyczny',
  R2: 'R2 wprowadza w błąd',
  R3: 'R3 pomocniczy',
  R0: 'R0 bez ryzyka prawnego',
};

export const CO_ZROBIC_NIESKLASYFIKOWANY =
  'Dopisz plik do obszaru w filtr/mapa-ryzyka.json (wolno bez zgody) albo do „wylaczenia” z powodem ' +
  '(osłabienie mapy: wymaga etykiety zgoda:zmiana-filtra od Bartosza). Poziomy i obszary: ' +
  'docs/koordynacja/PLAN-ZELAZNY-FILTR.md, B2 i B3.';

export function opisZmiany(wynik) {
  const linie = [`[FILTR] Poziom zmiany: ${OPIS_POZIOMU[wynik.poziom]}`];
  const istotne = wynik.pliki.filter((p) => p.status !== 'poza-kodem' || p.poziom !== 'R0');
  for (const p of istotne) {
    if (p.status === 'niesklasyfikowany') {
      linie.push(`  ??  ${p.plik}  niesklasyfikowany, sygnały: ${p.sygnaly.slice(0, 6).join(', ')}`);
    } else if (p.status === 'obszar') {
      linie.push(`  ${p.poziom}  ${p.plik}  (${p.obszary.join(', ')})`);
    } else if (p.status === 'wylaczony') {
      linie.push(`  R0  ${p.plik}  wyłączony: ${p.powod}`);
    } else {
      linie.push(`  R0  ${p.plik}`);
    }
  }
  if (wynik.niesklasyfikowane.length > 0) linie.push('', `Co zrobić: ${CO_ZROBIC_NIESKLASYFIKOWANY}`);
  return linie.join('\n');
}

export function opisSkanu(skan) {
  const { liczby } = skan;
  const linie = [
    `[FILTR] Pełny skan: R1 ${liczby.R1}, R2 ${liczby.R2}, R3 ${liczby.R3}, R0 ${liczby.R0} ` +
      `(w tym wyłączone ${liczby.wylaczone}), niesklasyfikowane ${liczby.niesklasyfikowane}`,
  ];
  for (const p of skan.niesklasyfikowane) {
    linie.push(`  ??  ${p.plik}  sygnały: ${p.sygnaly.slice(0, 6).join(', ')}`);
  }
  for (const m of skan.martweWzorce) {
    linie.push(`  martwy wzorzec ${m.wzorzec} (${m.gdzie}): żaden plik do niego nie pasuje; popraw albo usuń wpis`);
  }
  if (skan.niesklasyfikowane.length > 0) linie.push('', `Co zrobić: ${CO_ZROBIC_NIESKLASYFIKOWANY}`);
  return linie.join('\n');
}

// ---------------------------------------------------------------------------
// CLI

function glowna(argumenty) {
  const json = argumenty.includes('--json');
  const reszta = argumenty.filter((a) => a !== '--json');
  const mapa = wczytajMape();
  const wypisz = (obiekt, tekst) => console.log(json ? JSON.stringify(obiekt, null, 2) : tekst);

  if (reszta[0] === '--skan') {
    const skan = skanujRepozytorium(mapa);
    wypisz({ liczby: skan.liczby, niesklasyfikowane: skan.niesklasyfikowane, martweWzorce: skan.martweWzorce }, opisSkanu(skan));
    return skan.niesklasyfikowane.length === 0 && skan.martweWzorce.length === 0 ? 0 : 1;
  }

  let pliki;
  if (reszta[0] === '--diff' || reszta[0] === '--diff-z-pliku') {
    let diff;
    if (reszta[0] === '--diff') {
      const baza = reszta[1] ?? 'origin/main';
      diff = execFileSync('git', ['diff', '--no-color', '-M', '-U0', `${baza}...HEAD`], {
        cwd: KATALOG_REPO,
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
      });
    } else {
      if (!reszta[1]) {
        console.error('Użycie: node scripts/filtr/mapa.mjs --diff-z-pliku <plik.diff|->');
        return 2;
      }
      diff = readFileSync(reszta[1] === '-' ? 0 : reszta[1], 'utf8');
    }
    const zbior = new Set(plikiRepozytorium());
    pliki = zImportamiR1(mapa, plikiZDiffu(diff), (p) => zbior.has(p));
  } else if (reszta.length > 0 && !reszta[0].startsWith('--')) {
    const zbior = new Set(plikiRepozytorium());
    pliki = zImportamiR1(
      mapa,
      reszta.map((plik) => {
        const sciezka = join(KATALOG_REPO, plik);
        return { plik, tresc: existsSync(sciezka) ? readFileSync(sciezka, 'utf8') : '' };
      }),
      (p) => zbior.has(p),
    );
  } else {
    console.error(
      'Użycie: node scripts/filtr/mapa.mjs --skan | --diff [baza] | --diff-z-pliku <plik|-> | <plik>... [--json]',
    );
    return 2;
  }
  const wynik = klasyfikujZmiane(mapa, pliki);
  wypisz(wynik, opisZmiany(wynik));
  return wynik.niesklasyfikowane.length === 0 ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = glowna(process.argv.slice(2));
}

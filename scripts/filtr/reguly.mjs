#!/usr/bin/env node
// Reguły statyczne żelaznego filtra z zapadką (krok F7; plan
// docs/koordynacja/PLAN-ZELAZNY-FILTR.md, B4.8).
//
// Każda reguła ma zakres (poziom albo obszary z mapy ryzyka, albo wzorce
// ścieżek) i wzorzec w kodzie bez komentarzy. Naruszenia w kodzie sprzed
// filtra są spisane w `filtr/zapadka.json` według reguły i pliku; liczba
// może tylko maleć. Nowe naruszenie czerwieni test `tests/filtr/reguly.test.ts`
// i hook po edycji. Wzrost liczby w zapadce to zmiana filtra (zgoda Bartosza).
// Pojedynczy wyjątek: komentarz `// filtr-wyjatek: <reguła> <powód>` w linii
// naruszenia albo linię wyżej, i etykieta zgoda:wyjatek-filtra w PR.
//
// Użycie:
//   node scripts/filtr/reguly.mjs --sprawdz [plik...]   naruszenia ponad zapadkę (kod 1)
//   node scripts/filtr/reguly.mjs --zapisz               zapadka = stan dziś (tylko gdy nic nie rośnie)

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { KATALOG_REPO, obszaryPliku, pasujeDoWzorca, plikiRepozytorium, wczytajMape } from './mapa.mjs';

export const SCIEZKA_ZAPADKI = 'filtr/zapadka.json';
const KOD = /\.(?:ts|tsx|mjs|js)$/;
const TEST = /\.test\.(?:ts|tsx|mjs|js)$/;

/**
 * Reguły. `zakres(plik, obszary, poziom)` mówi, czy reguła dotyczy pliku;
 * `wzorzec` szuka w kodzie bez komentarzy (`tresc: 'kod'`) albo w całym
 * pliku (`tresc: 'calosc'`, np. dla testów).
 */
export const REGULY = [
  {
    id: 'kwoty-bez-float',
    opis: 'Math.round, toFixed i parseFloat na kwotach w kodzie R1: kwoty to grosze w liczbach całkowitych, a zaokrąglenia idą przez funkcje z rejestru (RP-ZAOKR-*).',
    zakres: ({ poziom, plik }) => poziom === 'R1' && !TEST.test(plik) && !plik.startsWith('supabase/'),
    wzorzec: /Math\.round\(|\.toFixed\(|parseFloat\(/g,
    tresc: 'bez-napisow',
  },
  {
    id: 'liczby-z-rejestru',
    opis: 'Literały równe liczbom prawnym (stawki, progi, limity, kwoty ZUS) poza lib/ksiegowosc/parametry: liczby tylko z parametrów z podpisem (RP-PARAM-01).',
    zakres: ({ plik }) =>
      !TEST.test(plik) &&
      ['lib/ksiegowosc/**', 'lib/dashboard/**', 'lib/flo/functions/**', 'components/przeplywy/**', 'lib/invoices/vat-exemption.ts'].some((w) => pasujeDoWzorca(w, plik)) &&
      !pasujeDoWzorca('lib/ksiegowosc/parametry/**', plik),
    wzorzec: /(?<![\w.])(?:0\.23|1\.23|0\.19|0\.12|0\.32|0\.09|0\.049|0\.085|0\.055|120_?000|240_?000|14_?100|10_?800|4_?806|4_?950|1926\.76|456\.18|19\.52)(?![\w.])/g,
    tresc: 'kod',
  },
  {
    id: 'data-warszawa',
    opis: 'Dzień z toISOString().slice(0, 10) albo lokalnego getMonth/getDate/getFullYear w kodzie R1 i R3: dzień i miesiąc w strefie Europe/Warsaw (lib/format/warsaw-date.ts, RP-MIES-01).',
    zakres: ({ poziom, plik }) => (poziom === 'R1' || poziom === 'R3') && !TEST.test(plik) && !plik.startsWith('supabase/') && !plik.startsWith('scripts/'),
    wzorzec: /toISOString\(\)\.slice\(0,\s?10\)|\.get(?:Month|Date|FullYear|Day)\(\)/g,
    tresc: 'bez-napisow',
  },
  {
    id: 'bez-trybu-testowego',
    opis: 'Gałęzie zależne od testów (process.env.VITEST, NODE_ENV === "test") w kodzie R1: kod liczy tak samo w testach i u klienta.',
    zakres: ({ poziom, plik }) => poziom === 'R1' && !TEST.test(plik),
    wzorzec: /process\.env\.VITEST|NODE_ENV\s*[!=]==?\s*['"]test['"]|['"]test['"]\s*[!=]==?\s*process\.env\.NODE_ENV/g,
    tresc: 'kod',
  },
  {
    id: 'bez-porad',
    opis: 'Tryb rozkazujący i porady w tekstach o podatkach (D8, RP-D8-01): tekst mówi, ile wychodzi z danych i jaki jest termin, nie co klient ma zrobić.',
    zakres: ({ obszary, plik }) =>
      !TEST.test(plik) && obszary.some((o) => ['ksiegowosc.ekrany', 'ksiegowosc.przypomnienia', 'ksiegowosc.odlozyc', 'szacunki', 'tresci'].includes(o)),
    wzorzec: /\b(?:[Zz]apłać|[Zz]alecamy|[Rr]adzimy|[Pp]owinieneś|[Pp]owinnaś|[Oo]płaca się|[Zz]aoszczędzisz|[Oo]szczędź|[Nn]ajlepsza forma|[Ww]ybierz (?:ryczałt|skalę|liniowy|formę))/g,
    tresc: 'kod',
  },
  {
    id: 'wyrocznia-osobno',
    opis: 'Wyrocznia (tests/filtr/wyrocznia/) jest niezależna: kod aplikacji jej nie importuje, a ona nie importuje aplikacji (czysty pokój, B4.4).',
    zakres: () => true,
    wzorzec: null,
    sprawdz: (plik, tresc) => {
      const wynik = [];
      const importy = /(?:from\s*|import\s*\(\s*)['"]([^'"]+)['"]/g;
      for (const d of tresc.matchAll(importy)) {
        const cel = d[1];
        const wWyroczni = plik.startsWith('tests/filtr/wyrocznia/');
        if (!wWyroczni && /tests\/filtr\/wyrocznia\//.test(cel) && !plik.startsWith('tests/')) wynik.push(d.index);
        if (wWyroczni && (/^@\/(?:lib|app|components)\//.test(cel) || /(?:\.\.\/)+(?:lib|app|components)\//.test(cel))) wynik.push(d.index);
      }
      return wynik;
    },
    tresc: 'kod',
  },
  {
    id: 'testy-bez-pomijania',
    opis: '.skip, .only, .todo i vi.mock modułów R1 w testach filtra; .fails tylko z numerem otwartego FZ z docs/filtr/USTALENIA.md.',
    zakres: ({ plik }) => plik.startsWith('tests/filtr/') && TEST.test(plik),
    wzorzec: null,
    sprawdz: (_plik, tresc, kontekst) => {
      // Wywołania szukamy w kodzie bez napisów (przykład w napisie to nie wywołanie),
      // a nazwę testu przy `.fails` czytamy z oryginału w tym samym miejscu.
      const kod = bezNapisow(tresc);
      const wynik = [];
      for (const d of kod.matchAll(/\b(?:it|test|describe)\.(?:skip|only|todo)\(/g)) wynik.push(d.index);
      for (const d of kod.matchAll(/\bvi\.mock\(\s*['"]/g)) {
        if (/^\s*['"]@\/lib\//.test(tresc.slice(d.index + 'vi.mock('.length))) wynik.push(d.index);
      }
      for (const d of kod.matchAll(/\b(?:it|test)\.fails\(/g)) {
        const nazwa = /^\s*(['"`])([^'"`]*)\1/.exec(tresc.slice(d.index + d[0].length))?.[2] ?? '';
        const fz = /FZ-\d{3}/.exec(nazwa)?.[0];
        if (!fz || !kontekst.otwarteFz.has(fz)) wynik.push(d.index);
      }
      return wynik;
    },
    tresc: 'kod',
  },
];

/**
 * Kod bez komentarzy, z zachowaną liczbą znaków i nowych linii (pozycje
 * naruszeń zgadzają się z plikiem). Napisy zostają, bo teksty dla klienta
 * żyją w literałach.
 */
export function bezKomentarzy(tekst) {
  let wynik = '';
  let i = 0;
  let napis = null;
  while (i < tekst.length) {
    const znak = tekst[i];
    const nastepny = tekst[i + 1];
    if (napis) {
      wynik += znak;
      if (znak === '\\') {
        wynik += nastepny ?? '';
        i += 2;
        continue;
      }
      if (znak === napis) napis = null;
      i++;
      continue;
    }
    if (znak === '"' || znak === "'" || znak === '`') {
      napis = znak;
      wynik += znak;
      i++;
      continue;
    }
    if (znak === '/' && nastepny === '/') {
      while (i < tekst.length && tekst[i] !== '\n') {
        wynik += ' ';
        i++;
      }
      continue;
    }
    if (znak === '/' && nastepny === '*') {
      while (i < tekst.length && !(tekst[i] === '*' && tekst[i + 1] === '/')) {
        wynik += tekst[i] === '\n' ? '\n' : ' ';
        i++;
      }
      wynik += '  ';
      i += 2;
      continue;
    }
    wynik += znak;
    i++;
  }
  return wynik;
}

/** Kod z treścią napisów zamienioną na spacje (te same pozycje): wzorce kodu nie łapią przykładów w napisach. */
export function bezNapisow(kod) {
  let wynik = '';
  let napis = null;
  for (let i = 0; i < kod.length; i++) {
    const znak = kod[i];
    if (napis) {
      if (znak === '\\') {
        wynik += '  ';
        i++;
        continue;
      }
      if (znak === napis) {
        napis = null;
        wynik += znak;
        continue;
      }
      wynik += znak === '\n' ? '\n' : ' ';
      continue;
    }
    if (znak === '"' || znak === "'" || znak === '`') napis = znak;
    wynik += znak;
  }
  return wynik;
}

function liniaPozycji(tekst, pozycja) {
  let linia = 1;
  for (let i = 0; i < pozycja && i < tekst.length; i++) if (tekst[i] === '\n') linia++;
  return linia;
}

/** Linie objęte wyjątkiem `// filtr-wyjatek: <reguła> <powód>` (ta i następna). */
export function wyjatki(tekst) {
  const mapa = new Map();
  tekst.split('\n').forEach((linia, i) => {
    const d = /filtr-wyjatek:\s*([a-z-]+)\s+\S/.exec(linia);
    if (!d) return;
    for (const numer of [i + 1, i + 2]) {
      if (!mapa.has(numer)) mapa.set(numer, new Set());
      mapa.get(numer).add(d[1]);
    }
  });
  return mapa;
}

export function otwarteFz(katalog = KATALOG_REPO) {
  const sciezka = join(katalog, 'docs/filtr/USTALENIA.md');
  const zbior = new Set();
  if (!existsSync(sciezka)) return zbior;
  for (const linia of readFileSync(sciezka, 'utf8').split('\n')) {
    const d = /^\|\s*(FZ-\d{3})\s*\|.*\|\s*otwarte\s*\|\s*$/.exec(linia);
    if (d) zbior.add(d[1]);
  }
  return zbior;
}

/** Naruszenia w jednym pliku: [{ regula, linia }]. */
export function naruszeniaPliku(plik, tresc, { mapa, kontekst }) {
  const obszary = obszaryPliku(mapa, plik).map((o) => o.id);
  const poziom = obszaryPliku(mapa, plik).map((o) => o.poziom).sort((a, b) => ['R0', 'R3', 'R2', 'R1'].indexOf(b) - ['R0', 'R3', 'R2', 'R1'].indexOf(a))[0] ?? 'R0';
  const kod = bezKomentarzy(tresc);
  const kodBezNapisow = bezNapisow(kod);
  const zwolnione = wyjatki(tresc);
  const wynik = [];
  for (const regula of REGULY) {
    if (!regula.zakres({ plik, obszary, poziom })) continue;
    const zrodlo = regula.tresc === 'bez-napisow' ? kodBezNapisow : kod;
    const pozycje = regula.sprawdz ? regula.sprawdz(plik, kod, kontekst) : [...zrodlo.matchAll(regula.wzorzec)].map((d) => d.index);
    for (const pozycja of pozycje) {
      const linia = liniaPozycji(kod, pozycja);
      if (zwolnione.get(linia)?.has(regula.id)) continue;
      wynik.push({ regula: regula.id, linia });
    }
  }
  return wynik;
}

/** Liczby naruszeń { regula: { plik: n } } w podanych plikach (domyślnie całe repozytorium). */
export function policz({ katalog = KATALOG_REPO, mapa = wczytajMape(), pliki = plikiRepozytorium(katalog) } = {}) {
  const kontekst = { otwarteFz: otwarteFz(katalog) };
  const liczby = {};
  for (const plik of pliki) {
    if (!KOD.test(plik) || plik.startsWith('scripts/filtr/') || plik.startsWith('node_modules/')) continue;
    const sciezka = join(katalog, plik);
    if (!existsSync(sciezka)) continue;
    for (const { regula } of naruszeniaPliku(plik, readFileSync(sciezka, 'utf8'), { mapa, kontekst })) {
      liczby[regula] ??= {};
      liczby[regula][plik] = (liczby[regula][plik] ?? 0) + 1;
    }
  }
  return liczby;
}

export function wczytajZapadke(katalog = KATALOG_REPO) {
  const sciezka = join(katalog, SCIEZKA_ZAPADKI);
  return existsSync(sciezka) ? JSON.parse(readFileSync(sciezka, 'utf8')) : { wersja: 1, reguly: {} };
}

/** Porównanie z zapadką: wzrosty (błąd: nowe naruszenie) i spadki (do zapisania w zapadce). */
export function porownajZZapadka(liczby, zapadka, { tylkoPliki } = {}) {
  const wzrosty = [];
  const spadki = [];
  const reguly = new Set([...Object.keys(liczby), ...Object.keys(zapadka.reguly ?? {})]);
  for (const regula of reguly) {
    const teraz = liczby[regula] ?? {};
    const dozwolone = zapadka.reguly?.[regula] ?? {};
    for (const plik of new Set([...Object.keys(teraz), ...Object.keys(dozwolone)])) {
      if (tylkoPliki && !tylkoPliki.includes(plik)) continue;
      const n = teraz[plik] ?? 0;
      const limit = dozwolone[plik] ?? 0;
      if (n > limit) wzrosty.push({ regula, plik, n, limit });
      if (n < limit) spadki.push({ regula, plik, n, limit });
    }
  }
  return { wzrosty, spadki };
}

export function opisWzrostow(wzrosty) {
  return wzrosty
    .map(({ regula, plik, n, limit }) => {
      const r = REGULY.find((x) => x.id === regula);
      return `[FILTR] ${plik}: reguła ${regula}, ${n} naruszeń przy dozwolonych ${limit}. ${r?.opis ?? ''} Wyjątek: komentarz „// filtr-wyjatek: ${regula} <powód>” i zgoda:wyjatek-filtra.`;
    })
    .join('\n');
}

function glowna(argumenty) {
  const zapadka = wczytajZapadke();
  if (argumenty[0] === '--zapisz') {
    const liczby = policz();
    const { wzrosty } = porownajZZapadka(liczby, zapadka);
    if (wzrosty.length > 0 && Object.keys(zapadka.reguly ?? {}).length > 0) {
      console.error(`${opisWzrostow(wzrosty)}\nZapadka może tylko maleć: popraw kod albo dodaj wyjątek.`);
      return 1;
    }
    const posortowane = Object.fromEntries(
      Object.keys(liczby).sort().map((r) => [r, Object.fromEntries(Object.entries(liczby[r]).sort(([a], [b]) => a.localeCompare(b)))]),
    );
    writeFileSync(
      join(KATALOG_REPO, SCIEZKA_ZAPADKI),
      `${JSON.stringify({ wersja: 1, opis: 'Naruszenia reguł statycznych filtra w kodzie sprzed filtra (B4.8). Liczba może tylko maleć; wzrost wymaga zgoda:zmiana-filtra. Odświeżenie po poprawkach: node scripts/filtr/reguly.mjs --zapisz.', reguly: posortowane }, null, 2)}\n`,
    );
    console.log(`Zapisano ${SCIEZKA_ZAPADKI}.`);
    return 0;
  }
  if (argumenty[0] === '--sprawdz') {
    const pliki = argumenty.slice(1);
    const liczby = policz(pliki.length > 0 ? { pliki } : {});
    const { wzrosty, spadki } = porownajZZapadka(liczby, zapadka, pliki.length > 0 ? { tylkoPliki: pliki } : {});
    if (wzrosty.length > 0) console.log(opisWzrostow(wzrosty));
    if (spadki.length > 0) console.log(`[FILTR] Mniej naruszeń niż w zapadce w ${spadki.length} miejscach: node scripts/filtr/reguly.mjs --zapisz`);
    if (wzrosty.length === 0) console.log('[FILTR] Reguły statyczne: bez nowych naruszeń.');
    return wzrosty.length === 0 ? 0 : 1;
  }
  console.error('Użycie: node scripts/filtr/reguly.mjs --sprawdz [plik...] | --zapisz');
  return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = glowna(process.argv.slice(2));

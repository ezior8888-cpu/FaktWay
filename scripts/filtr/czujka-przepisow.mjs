#!/usr/bin/env node
// Czujka przepisów żelaznego filtra (krok F15; plan docs/koordynacja/PLAN-ZELAZNY-FILTR.md, B9).
//
// Codziennie (workflow filtr-czujka.yml):
//   1. ELI API Sejmu (`/eli/changes/acts?since=…`): akty, które zmieniają
//      akt obserwowany, są wydane na jego podstawie, same się zmieniły
//      (np. nowy tekst jednolity) albo mają w tytule słowo z listy;
//   2. kalendarz ogłoszeń: termin w oknie (domyślnie 14 dni przed i 30 po);
//   3. wydania repozytoriów MF na GitHubie (dokumentacja KSeF).
// Każde trafienie to issue z etykietą `filtr` (bez powtórek: tytuł zaczyna
// się od klucza trafienia). Bez GITHUB_TOKEN tylko wypisuje.
//
// Użycie: node scripts/filtr/czujka-przepisow.mjs [--od RRRR-MM-DD] [--dzis RRRR-MM-DD] [--bez-issue]

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { KATALOG_REPO } from './mapa.mjs';

export const API_ELI = 'https://api.sejm.gov.pl/eli';
export const KONFIGURACJA = 'filtr/czujka-przepisow.json';
const DOBA = 86_400_000;

export function wczytajKonfiguracje(katalog = KATALOG_REPO) {
  return JSON.parse(readFileSync(join(katalog, KONFIGURACJA), 'utf8'));
}

/**
 * Trafienie dla jednego aktu z ELI API albo null.
 * @returns {{ klucz: string, eli: string, tytul: string, powody: string[], obszary: string[] } | null}
 */
export function ocenAkt(akt, konfiguracja, od = '0000-01-01') {
  // Tylko akty ogłoszone od `od`: kanał zmian ELI podaje też stare akty, którym
  // dopisano odwołanie, a zmianę aktu obserwowanego widać i tak po nowym akcie
  // zmieniającym albo po obwieszczeniu tekstu jednolitego.
  const ogloszony = akt.announcementDate ?? akt.promulgation ?? '';
  if (ogloszony < od) return null;
  const obserwowane = new Map(konfiguracja.obserwowane.map((o) => [o.eli, o]));
  const powody = [];
  const obszary = new Set();
  const dodaj = (powod, eli) => {
    powody.push(powod);
    for (const o of obserwowane.get(eli)?.obszary ?? []) obszary.add(o);
  };
  for (const [rodzaj, lista] of Object.entries(akt.references ?? {})) {
    for (const odwolanie of lista ?? []) {
      const eli = odwolanie.id ?? odwolanie.act?.ELI;
      if (!obserwowane.has(eli) || eli === akt.ELI) continue;
      const podstawa = /Podstawa prawna/i.test(rodzaj);
      if (podstawa && obserwowane.get(eli).podstawa_prawna === false) continue;
      if (/zmienion|uchylon|Tekst jednolity/i.test(rodzaj) || podstawa) dodaj(`${rodzaj}: ${obserwowane.get(eli).nazwa}`, eli);
    }
  }
  const slowa = konfiguracja.slowa_w_tytule.map((s) => new RegExp(s, 'i'));
  const slowo = slowa.find((r) => r.test(akt.title ?? ''));
  if (slowo) powody.push(`tytuł pasuje do „${slowo.source}”`);
  if (powody.length === 0) return null;
  return { klucz: akt.ELI, eli: akt.ELI, tytul: akt.title, powody: [...new Set(powody)], obszary: [...obszary], wchodzi: akt.entryIntoForce ?? null, ogloszono: akt.announcementDate ?? null };
}

/** Terminy kalendarza w oknie wokół dnia `dzis` (RRRR-MM-DD). */
export function terminyKalendarza(konfiguracja, dzis) {
  const { przed, po } = konfiguracja.okno_kalendarza_dni;
  const teraz = Date.parse(`${dzis}T00:00:00Z`);
  const rok = Number(dzis.slice(0, 4));
  const wynik = [];
  for (const wpis of konfiguracja.kalendarz) {
    for (const r of [rok - 1, rok, rok + 1]) {
      const termin = Date.parse(`${r}-${wpis.kiedy}T00:00:00Z`);
      const dni = Math.round((termin - teraz) / DOBA);
      if (dni <= przed && dni >= -po) {
        wynik.push({ klucz: `kalendarz ${wpis.id} ${r}`, termin: `${r}-${wpis.kiedy}`, dni, ...wpis });
      }
    }
  }
  return wynik;
}

export function trescIssue(trafienie) {
  if (trafienie.termin) {
    return {
      tytul: `[czujka] ${trafienie.klucz}: ${trafienie.co}`.slice(0, 250),
      tresc: [
        `Termin ogłoszenia: ${trafienie.termin} (${trafienie.dni >= 0 ? `za ${trafienie.dni} dni` : `${-trafienie.dni} dni temu`}).`,
        '',
        `Co: ${trafienie.co}.`,
        trafienie.parametry.length > 0 ? `Parametry do uzupełnienia w lib/ksiegowosc/parametry: ${trafienie.parametry.map((p) => `\`${p}\``).join(', ')}.` : '',
        '',
        'Co zrobić: gdy ogłoszenie jest, sesja uzupełnia parametry ze źródłem (PR z zgoda:wiedza-prawna), a księgowa potwierdza sekcję (sprawdzila). Do tego czasu moduł pokazuje brak (D7). Plan filtra F15.',
      ].filter((l) => l !== null).join('\n'),
    };
  }
  if (trafienie.repo) {
    return {
      tytul: `[czujka] ${trafienie.klucz}: nowe wydanie ${trafienie.nazwa}`.slice(0, 250),
      tresc: `Nowe wydanie: ${trafienie.wydanie} (${trafienie.url}). Co zrobić: przeczytać zmiany pod kątem FA(3), KSeF i wysyłki; czujka schematu FA(3) i KSeF TEST pokażą skutki. Plan filtra F15.`,
    };
  }
  return {
    tytul: `[czujka] ${trafienie.klucz}: ${trafienie.tytul}`.slice(0, 250),
    tresc: [
      `Akt: ${trafienie.tytul}`,
      `ELI: ${trafienie.eli} (https://isap.sejm.gov.pl/isap.nsf/DocDetails.xsp?id=W${trafienie.eli.replace(/^(DU|MP)\/(\d{4})\/(\d+)$/, (_, p, r, n) => `${p === 'DU' ? 'DU' : 'MP'}${r}${String(n).padStart(7, '0')}`)})`,
      trafienie.ogloszono ? `Ogłoszono: ${trafienie.ogloszono}.` : '',
      trafienie.wchodzi ? `Wchodzi w życie: ${trafienie.wchodzi}.` : '',
      '',
      `Dlaczego czujka: ${trafienie.powody.join('; ')}.`,
      trafienie.obszary.length > 0 ? `Obszary mapy ryzyka: ${trafienie.obszary.join(', ')}.` : '',
      '',
      'Co zrobić: przeczytać zmianę pod kątem reguł z filtr/przepisy (filtr: pole obowiazuje, treść reguły, parametry). Każda zmiana reguły to PR z zgoda:wiedza-prawna i źródłem. Decyzję o sesji podejmuje Bartosz. Plan filtra F15.',
    ].filter((l) => l !== '').join('\n'),
  };
}

async function pobierz(url, opcje = {}) {
  const odpowiedz = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'faktway-filtr-czujka', ...(opcje.naglowki ?? {}) }, method: opcje.metoda ?? 'GET', body: opcje.cialo });
  if (!odpowiedz.ok) throw new Error(`${opcje.metoda ?? 'GET'} ${url.split('?')[0]}: HTTP ${odpowiedz.status}`);
  return odpowiedz.status === 204 ? null : odpowiedz.json();
}

/** Wszystkie akty zmienione od dnia `od` (stronami). */
export async function aktyOd(od, pobieranie = pobierz) {
  const akty = [];
  for (let offset = 0; offset < 5_000; offset += 500) {
    const strona = await pobieranie(`${API_ELI}/changes/acts?since=${od}T00:00:00&limit=500&offset=${offset}`);
    akty.push(...(strona.items ?? []));
    if ((strona.items ?? []).length < 500) break;
  }
  return akty;
}

async function glowna(argumenty) {
  const arg = (nazwa) => (argumenty.includes(nazwa) ? argumenty[argumenty.indexOf(nazwa) + 1] : undefined);
  const dzis = arg('--dzis') ?? new Date().toISOString().slice(0, 10);
  const od = arg('--od') ?? new Date(Date.parse(`${dzis}T00:00:00Z`) - 3 * DOBA).toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dzis) || !/^\d{4}-\d{2}-\d{2}$/.test(od)) {
    console.error('Daty w postaci RRRR-MM-DD.');
    return 2;
  }
  const konfiguracja = wczytajKonfiguracje();
  const trafienia = [];
  for (const akt of await aktyOd(od)) {
    const t = ocenAkt(akt, konfiguracja, od);
    if (t) trafienia.push(t);
  }
  trafienia.push(...terminyKalendarza(konfiguracja, dzis));
  for (const { repo, nazwa, ostatnie_znane: znane } of konfiguracja.repozytoria) {
    try {
      const wydania = await pobierz(`https://api.github.com/repos/${repo}/releases?per_page=1`);
      const ostatnie = wydania?.[0];
      if (ostatnie && ostatnie.tag_name !== znane) trafienia.push({ klucz: `${repo} ${ostatnie.tag_name}`, repo, nazwa, wydanie: ostatnie.tag_name, url: ostatnie.html_url });
    } catch (blad) {
      console.log(`Wydania ${repo}: ${blad instanceof Error ? blad.message : 'błąd'}`);
    }
  }
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  let istniejace = [];
  if (token && repo && !argumenty.includes('--bez-issue')) {
    const naglowki = { Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' };
    for (let strona = 1; strona <= 10; strona++) {
      const paczka = await pobierz(`https://api.github.com/repos/${repo}/issues?labels=filtr&state=all&per_page=100&page=${strona}`, { naglowki });
      istniejace.push(...paczka.map((i) => i.title));
      if (paczka.length < 100) break;
    }
    for (const t of trafienia) {
      const { tytul, tresc } = trescIssue(t);
      if (istniejace.some((i) => i.startsWith(`[czujka] ${t.klucz}:`))) {
        console.log(`już jest: ${tytul}`);
        continue;
      }
      await pobierz(`https://api.github.com/repos/${repo}/issues`, {
        metoda: 'POST',
        naglowki: { ...naglowki, 'Content-Type': 'application/json' },
        cialo: JSON.stringify({ title: tytul, body: tresc, labels: ['filtr'] }),
      });
      console.log(`issue: ${tytul}`);
    }
  } else {
    for (const t of trafienia) console.log(`- ${trescIssue(t).tytul}`);
  }
  console.log(`[FILTR] Czujka przepisów: ${trafienia.length} trafień od ${od} (dziś ${dzis}).`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  glowna(process.argv.slice(2))
    .then((kod) => {
      process.exitCode = kod;
    })
    .catch((blad) => {
      console.error(`Czujka przepisów: ${blad instanceof Error ? blad.message : 'błąd'}`);
      process.exitCode = 2;
    });
}

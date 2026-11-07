#!/usr/bin/env node
// Plan usprawnień 3.4: czujka zmian schematu FA(3) w MF (workflow
// `.github/workflows/czujka-schematu-fa3.yml`, raz w tygodniu).
//
//   node scripts/ci/czujka-schematu-fa3.mjs            # sprawdza i zgłasza issue
//   CZUJKA_BEZ_ISSUE=1 node scripts/ci/czujka-schematu-fa3.mjs   # tylko raport
//
// Dwa źródła MF:
// 1. crd.gov.pl: te same adresy co przestrzenie nazw w `lib/xml/schemas/fa3/`.
//    Porównanie po skrócie SHA-256 treści po normalizacji (końce linii,
//    `schemaLocation` z pełnym adresem MF → sama nazwa pliku, jak w repo).
//    Łapie poprawki MF wprowadzone w miejscu.
// 2. Repo dokumentacji KSeF MF na GitHubie (`CIRFMF/ksef-docs`, katalog
//    `faktury/schemy/FA`): nowa wersja schematu dostaje nowy plik i nowy adres
//    w crd.gov.pl, więc punkt 1 by jej nie zobaczył. Tu liczy się lista plików
//    i skróty blobów gita (format plików różni się od crd.gov.pl).
//
// Różnica = issue z etykietą `czujka-fa3` (jedno na wersję MF, deduplikacja po
// odcisku zmian). Źródło niedostępne = ostrzeżenie w logu, bez issue i bez
// czerwieni: czujka jest fail-open, aplikacja waliduje dalej lokalnym XSD.
// Czerwień (kod 1) tylko wtedy, gdy różnica jest, a issue nie udało się założyć.
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const CRD_FA3 = 'https://crd.gov.pl/wzor/2025/06/25/13775/';
const CRD_ETD = 'https://crd.gov.pl/xml/schematy/dziedzinowe/mf/2022/01/05/eD/DefinicjeTypy/';

/** Plik MF → kopie w `lib/xml/schemas/fa3/` (walidator używa `schemat-local.xsd`). */
export const PLIKI_CRD = [
  { url: `${CRD_FA3}schemat.xsd`, repo: ['schemat.xsd', 'schemat-local.xsd'] },
  { url: `${CRD_ETD}StrukturyDanych_v10-0E.xsd`, repo: ['StrukturyDanych_v10-0E.xsd'] },
  { url: `${CRD_ETD}ElementarneTypyDanych_v10-0E.xsd`, repo: ['ElementarneTypyDanych_v10-0E.xsd'] },
  { url: `${CRD_ETD}KodyKrajow_v10-0E.xsd`, repo: ['KodyKrajow_v10-0E.xsd'] },
];

export const DOCS_REPO = 'CIRFMF/ksef-docs';
export const DOCS_KATALOGI = ['faktury/schemy/FA', 'faktury/schemy/FA/bazowe'];
/** Pliki w `ksef-docs` na 07.11.2026 → skrót bloba gita. Po aktualizacji schematu w repo dopisz nowe. */
export const ZNANE_W_DOCS = {
  'faktury/schemy/FA/schemat_FA(2)_v1-0E.xsd': '0df84399b1bf01a52ddf8ccf5770fbf916a2c301',
  'faktury/schemy/FA/schemat_FA(3)_v1-0E.xsd': 'f55341fca047617271fc939ca44e5f6bd30ea344',
  'faktury/schemy/FA/bazowe/ElementarneTypyDanych_v10-0E.xsd': 'c259ac2db65566021536a05a1d36784171b1bd3e',
  'faktury/schemy/FA/bazowe/KodyKrajow_v10-0E.xsd': 'ad60b2571b94d5a417510ffccde92b99c859d227',
  'faktury/schemy/FA/bazowe/StrukturyDanych_v10-0E.xsd': '6325080bb713e463dbf8d50bf1b2832cd4527686',
};
/** FA(2) obowiązywała do 31.01.2026; jej zmiany w `ksef-docs` nas nie dotyczą. */
const POMIJANE_W_DOCS = /\/schemat_FA\(2\)_/;
/** Plik z `ksef-docs`, którego nazwy porównujemy z repo, gdy się zmieni albo pojawi nowy. */
const odpowiednikWRepo = (sciezka) => {
  const nazwa = sciezka.split('/').pop();
  const wersja = /^schemat_FA\((\d+)\)/i.exec(nazwa);
  if (wersja) return Number(wersja[1]) >= 3 ? 'schemat.xsd' : null;
  return PLIKI_CRD.some((p) => p.repo.includes(nazwa)) ? nazwa : null;
};

export const ETYKIETA = 'czujka-fa3';
const ZNACZNIK = 'faktway-czujka-fa3';
const RUNBOOK = 'docs/runbooks/fa3-ksef.md';
const LIMIT_NAZW = 40;

export const normalizuj = (tekst) =>
  tekst
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/schemaLocation="[^"]*\/([^"/]+\.xsd)"/g, 'schemaLocation="$1"')
    .trimEnd();

export const sha256 = (tekst) => createHash('sha256').update(tekst).digest('hex');

/** Nazwy z XSD: elementy, typy i wartości wyliczeń (np. kody krajów). */
export function nazwy(xsd) {
  const zbierz = (re) => new Set([...xsd.matchAll(re)].map((m) => m[1]));
  return {
    elementy: zbierz(/<(?:\w+:)?element\b[^>]*?\bname="([^"]+)"/g),
    typy: zbierz(/<(?:\w+:)?(?:complexType|simpleType)\b[^>]*?\bname="([^"]+)"/g),
    wartosci: zbierz(/<(?:\w+:)?enumeration\b[^>]*?\bvalue="([^"]*)"/g),
  };
}

/** @typedef {{ dodane: string[], usuniete: string[] }} Roznica */
/** @typedef {{ elementy: Roznica, typy: Roznica, wartosci: Roznica }} RoznicaNazw */
/**
 * @typedef {{ zrodlo: string, plik: string, rodzaj: 'zmieniony'|'nowy'|'usuniety', skrot: string, url: string,
 *   porownanieZ?: string, roznica?: RoznicaNazw }} Zmiana
 */

/** @returns {RoznicaNazw} */
export function roznicaNazw(stary, nowy) {
  const a = nazwy(stary);
  const b = nazwy(nowy);
  /** @param {Set<string>} x @param {Set<string>} y */
  const r = (x, y) => ({ dodane: [...y].filter((n) => !x.has(n)).sort(), usuniete: [...x].filter((n) => !y.has(n)).sort() });
  return { elementy: r(a.elementy, b.elementy), typy: r(a.typy, b.typy), wartosci: r(a.wartosci, b.wartosci) };
}

async function pobierz(fetchImpl, url, naglowki = {}) {
  let ostatni = '';
  for (let proba = 1; proba <= 2; proba++) {
    try {
      const res = await fetchImpl(url, {
        headers: { 'User-Agent': 'faktway-czujka-fa3', ...naglowki },
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) return { ok: true, tekst: await res.text() };
      ostatni = `HTTP ${res.status}`;
      if (res.status < 500 && res.status !== 429) break;
    } catch (e) {
      ostatni = e instanceof Error ? e.name : 'błąd';
    }
  }
  return { ok: false, powod: ostatni };
}

/**
 * @param {{ fetchImpl?: typeof fetch, katalogRepo: string, token?: string }} opcje
 * @returns {Promise<{ zmiany: Zmiana[], niedostepne: string[] }>}
 */
export async function sprawdz({ fetchImpl = fetch, katalogRepo, token }) {
  /** @type {Zmiana[]} */
  const zmiany = [];
  const niedostepne = [];
  const repoPlik = (nazwa) => readFileSync(join(katalogRepo, nazwa), 'utf8');

  const pobrane = await Promise.all(PLIKI_CRD.map((p) => pobierz(fetchImpl, p.url)));
  for (const [i, { url, repo }] of PLIKI_CRD.entries()) {
    const r = pobrane[i];
    if (!r.ok) {
      niedostepne.push(`${url} (${r.powod})`);
      continue;
    }
    const mf = normalizuj(r.tekst);
    const skrot = sha256(mf);
    for (const nazwa of repo) {
      const lokalny = normalizuj(repoPlik(nazwa));
      if (sha256(lokalny) === skrot) continue;
      zmiany.push({ zrodlo: 'crd.gov.pl', plik: nazwa, rodzaj: 'zmieniony', skrot, url, porownanieZ: nazwa, roznica: roznicaNazw(lokalny, mf) });
    }
  }

  const api = { Accept: 'application/vnd.github+json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  const widziane = new Set();
  const sprawdzoneKatalogi = new Set();
  for (const katalog of DOCS_KATALOGI) {
    const url = `https://api.github.com/repos/${DOCS_REPO}/contents/${katalog}`;
    const r = await pobierz(fetchImpl, url, api);
    let lista;
    try {
      lista = r.ok ? JSON.parse(r.tekst) : null;
    } catch {
      lista = null;
    }
    if (!Array.isArray(lista)) {
      niedostepne.push(`${DOCS_REPO}/${katalog} (${r.ok ? 'nieczytelna lista' : r.powod})`);
      continue;
    }
    sprawdzoneKatalogi.add(katalog);
    for (const wpis of lista) {
      if (wpis?.type !== 'file' || typeof wpis.path !== 'string' || !/\.xsd$/i.test(wpis.path)) continue;
      if (POMIJANE_W_DOCS.test(wpis.path)) continue;
      widziane.add(wpis.path);
      const znany = ZNANE_W_DOCS[wpis.path];
      if (znany === wpis.sha) continue;
      /** @type {Zmiana} */
      const zmiana = {
        zrodlo: DOCS_REPO,
        plik: wpis.path,
        rodzaj: znany ? 'zmieniony' : 'nowy',
        skrot: String(wpis.sha),
        url: `https://github.com/${DOCS_REPO}/blob/main/${wpis.path}`,
      };
      const odpowiednik = odpowiednikWRepo(wpis.path);
      if (odpowiednik && typeof wpis.download_url === 'string' && wpis.download_url.startsWith('https://raw.githubusercontent.com/')) {
        const plik = await pobierz(fetchImpl, wpis.download_url);
        if (plik.ok) {
          zmiana.porownanieZ = odpowiednik;
          zmiana.roznica = roznicaNazw(repoPlik(odpowiednik), plik.tekst);
        }
      }
      zmiany.push(zmiana);
    }
  }
  for (const sciezka of Object.keys(ZNANE_W_DOCS)) {
    if (POMIJANE_W_DOCS.test(sciezka)) continue;
    const katalog = sciezka.slice(0, sciezka.lastIndexOf('/'));
    if (sprawdzoneKatalogi.has(katalog) && !widziane.has(sciezka)) {
      zmiany.push({ zrodlo: DOCS_REPO, plik: sciezka, rodzaj: 'usuniety', skrot: '-', url: `https://github.com/${DOCS_REPO}/tree/main/${katalog}` });
    }
  }
  return { zmiany, niedostepne };
}

/** Odcisk zestawu zmian: ta sama wersja MF = ten sam odcisk = to samo issue. */
export const odcisk = (/** @type {Zmiana[]} */ zmiany) =>
  sha256(
    zmiany
      .map((z) => `${z.zrodlo}|${z.plik}|${z.rodzaj}|${z.skrot}`)
      .sort()
      .join('\n'),
  ).slice(0, 16);

// Treść z MF trafia do issue, które może przeczytać agent kodu: tylko nazwy
// w bezpiecznym kształcie, reszta pominięta.
const bezpieczna = (n) => (/^[\p{L}\p{N}_.\- ]{1,80}$/u.test(n) ? `\`${n}\`` : null);
function lista(nazwy) {
  const ok = nazwy.map(bezpieczna).filter(Boolean);
  const pominiete = nazwy.length - ok.length;
  const widoczne = ok.length ? ok.slice(0, LIMIT_NAZW).join(', ') : '(brak do pokazania)';
  const reszta = ok.length > LIMIT_NAZW ? ` i ${ok.length - LIMIT_NAZW} więcej` : '';
  const uwaga = pominiete ? ` (${pominiete} o nietypowym kształcie pominięte)` : '';
  return `${widoczne}${reszta}${uwaga}`;
}

const ETYKIETY_NAZW = { elementy: 'Elementy', typy: 'Typy', wartosci: 'Wartości wyliczeń' };

/** @param {{ zmiany: Zmiana[], niedostepne: string[], fp: string, repo: string, runUrl: string }} p */
export function trescIssue({ zmiany, niedostepne, fp, repo, runUrl }) {
  // Ścieżka i adres z listy `ksef-docs` też są danymi z zewnątrz.
  const sciezka = (t) => (/^[\p{L}\p{N}_.()\-/ ]{1,200}$/u.test(t) ? `\`${t}\`` : '(nazwa pominięta)');
  const adres = (u) => (/^https:\/\/[\w.\-/()%]+$/.test(u) ? `[źródło](${u})` : '');
  const wiersze = zmiany.map(
    (z) => `| ${sciezka(z.plik)} | ${z.zrodlo} | ${z.rodzaj} | \`${z.skrot.slice(0, 16).replace(/[^0-9a-f-]/gi, '')}\` | ${adres(z.url)} |`,
  );
  const roznice = zmiany
    .filter((z) => z.roznica)
    .map((z) => {
      const linie = [];
      for (const [k, { dodane, usuniete }] of Object.entries(z.roznica)) {
        if (dodane.length) linie.push(`- ${ETYKIETY_NAZW[k]} dodane (${dodane.length}): ${lista(dodane)}`);
        if (usuniete.length) linie.push(`- ${ETYKIETY_NAZW[k]} usunięte (${usuniete.length}): ${lista(usuniete)}`);
      }
      if (!linie.length) linie.push('- Nazwy bez zmian: różnica w ograniczeniach, typach pól albo adnotacjach.');
      return `#### ${sciezka(z.plik)} (${z.zrodlo}) względem \`lib/xml/schemas/fa3/${z.porownanieZ}\`\n${linie.join('\n')}`;
    });
  const tekst = [
    `<!-- ${ZNACZNIK} fp=${fp} -->`,
    'Cotygodniowa czujka (`.github/workflows/czujka-schematu-fa3.yml`) widzi schemat FA(3) w MF inny niż w `lib/xml/schemas/fa3/`.',
    '',
    '| Plik | Źródło | Zmiana | Skrót | |',
    '|---|---|---|---|---|',
    ...wiersze,
    '',
    '### Nazwy w XSD',
    roznice.length ? roznice.join('\n\n') : 'Brak pliku do porównania nazw (plik bez odpowiednika w repo albo nie dał się pobrać).',
    '',
    '### Co zrobić',
    `Runbook: [${RUNBOOK}](https://github.com/${repo}/blob/main/${RUNBOOK}), sekcja „Czujka zmian schematu MF”.`,
    'Zamknięcie issue bez zmiany repo wycisza tę wersję MF; kolejna zmiana MF założy nowe issue.',
    niedostepne.length ? `\nW tym przebiegu niedostępne (pominięte): ${niedostepne.length}.` : '',
    runUrl ? `\nPrzebieg: ${runUrl}` : '',
  ];
  return tekst.join('\n').trimEnd() + '\n';
}

async function gh(fetchImpl, token, metoda, sciezka, cialo) {
  const res = await fetchImpl(`https://api.github.com${sciezka}`, {
    method: metoda,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'faktway-czujka-fa3',
      ...(cialo ? { 'Content-Type': 'application/json' } : {}),
    },
    body: cialo ? JSON.stringify(cialo) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  return { status: res.status, dane: res.status === 204 ? null : await res.json().catch(() => null) };
}

/**
 * Zakłada albo aktualizuje issue. To samo `fp` (otwarte albo zamknięte) = nic.
 * Inne `fp` przy otwartym issue czujki = nowa treść i komentarz.
 * @param {{ fetchImpl?: typeof fetch, token: string, repo: string, zmiany: Zmiana[], niedostepne?: string[], runUrl?: string }} p
 * @returns {Promise<{ akcja: 'jest'|'zaktualizowane'|'zalozone', numer: number }>}
 */
export async function zglos({ fetchImpl = fetch, token, repo, zmiany, niedostepne = [], runUrl = '' }) {
  const fp = odcisk(zmiany);
  const etykieta = await gh(fetchImpl, token, 'POST', `/repos/${repo}/labels`, {
    name: ETYKIETA,
    color: 'fbca04',
    description: 'Schemat FA(3) w MF różni się od repo (czujka)',
  });
  if (etykieta.status !== 201 && etykieta.status !== 422) throw new Error(`etykieta: HTTP ${etykieta.status}`);

  const istniejace = await gh(fetchImpl, token, 'GET', `/repos/${repo}/issues?labels=${ETYKIETA}&state=all&per_page=100`);
  if (istniejace.status !== 200 || !Array.isArray(istniejace.dane)) throw new Error(`lista issue: HTTP ${istniejace.status}`);
  const issues = istniejace.dane.filter((i) => !i.pull_request && typeof i.body === 'string' && i.body.includes(`<!-- ${ZNACZNIK} `));

  const tytul = `Czujka FA(3): schemat MF inny niż w repo (${fp.slice(0, 8)})`;
  const body = trescIssue({ zmiany, niedostepne, fp, repo, runUrl });

  const ten = issues.find((i) => i.body.includes(`fp=${fp} -->`));
  if (ten) return { akcja: 'jest', numer: ten.number };

  const otwarte = issues.find((i) => i.state === 'open');
  // Część źródeł niedostępna: odcisk jest niepełny, więc otwartego issue nie
  // nadpisujemy (inaczej każda przerwa MF dawałaby fałszywe „zmienił ponownie”).
  if (otwarte && niedostepne.length) return { akcja: 'jest', numer: otwarte.number };
  if (otwarte) {
    const p = await gh(fetchImpl, token, 'PATCH', `/repos/${repo}/issues/${otwarte.number}`, { title: tytul, body });
    if (p.status !== 200) throw new Error(`aktualizacja issue: HTTP ${p.status}`);
    const k = await gh(fetchImpl, token, 'POST', `/repos/${repo}/issues/${otwarte.number}/comments`, {
      body: `MF zmienił schemat ponownie (odcisk \`${fp}\`), treść issue zaktualizowana.${runUrl ? ` Przebieg: ${runUrl}` : ''}`,
    });
    if (k.status !== 201) throw new Error(`komentarz: HTTP ${k.status}`);
    return { akcja: 'zaktualizowane', numer: otwarte.number };
  }

  const c = await gh(fetchImpl, token, 'POST', `/repos/${repo}/issues`, { title: tytul, body, labels: [ETYKIETA] });
  if (c.status !== 201) throw new Error(`nowe issue: HTTP ${c.status}`);
  return { akcja: 'zalozone', numer: c.dane?.number };
}

async function main() {
  const env = process.env;
  const katalogRepo = resolve(env.CZUJKA_KATALOG_REPO ?? 'lib/xml/schemas/fa3');
  const repo = env.GITHUB_REPOSITORY ?? 'ezior8888-cpu/FaktWay';
  const runUrl = env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL ?? 'https://github.com'}/${repo}/actions/runs/${env.GITHUB_RUN_ID}` : '';
  const podsumowanie = (t) => env.GITHUB_STEP_SUMMARY && appendFileSync(env.GITHUB_STEP_SUMMARY, `${t}\n`);

  const { zmiany, niedostepne } = await sprawdz({ katalogRepo, token: env.GITHUB_TOKEN });
  for (const n of niedostepne) console.log(`::warning title=Czujka FA(3)::Źródło MF niedostępne, pominięte: ${n}`);

  if (!zmiany.length) {
    const t = niedostepne.length ? `Bez różnic w dostępnych źródłach (${niedostepne.length} niedostępne).` : 'Schemat FA(3) w MF zgodny z repo.';
    console.log(t);
    podsumowanie(t);
    return 0;
  }
  const fp = odcisk(zmiany);
  console.log(`Różnica względem MF (odcisk ${fp}):`);
  for (const z of zmiany) console.log(`  ${z.rodzaj.padEnd(9)} ${z.zrodlo}  ${z.plik}`);
  podsumowanie(trescIssue({ zmiany, niedostepne, fp, repo, runUrl }));

  if (env.CZUJKA_BEZ_ISSUE === '1') return 0;
  if (!env.GITHUB_TOKEN) {
    console.error('Brak GITHUB_TOKEN: nie mogę założyć issue (lokalnie użyj CZUJKA_BEZ_ISSUE=1).');
    return 1;
  }
  try {
    const { akcja, numer } = await zglos({ token: env.GITHUB_TOKEN, repo, zmiany, niedostepne, runUrl });
    console.log(`Issue #${numer}: ${akcja}.`);
    return 0;
  } catch (e) {
    console.error(`::error title=Czujka FA(3)::Nie udało się zgłosić issue: ${e instanceof Error ? e.message : 'błąd'}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main();
}

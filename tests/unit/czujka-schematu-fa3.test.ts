import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DOCS_KATALOGI,
  DOCS_REPO,
  ETYKIETA,
  PLIKI_CRD,
  ZNANE_W_DOCS,
  normalizuj,
  odcisk,
  roznicaNazw,
  sprawdz,
  trescIssue,
  zglos,
} from '@/scripts/ci/czujka-schematu-fa3.mjs';

/**
 * Plan usprawnień 3.4: czujka zmian schematu FA(3) w MF. Atrapy zamiast sieci:
 * MF zgodny z repo, MF zmieniony, MF niedostępny; do tego deduplikacja issue.
 */

const KATALOG = resolve(__dirname, '../../lib/xml/schemas/fa3');
const repoPlik = (n: string) => readFileSync(join(KATALOG, n), 'utf8');

// MF podaje `schemaLocation` pełnym adresem i (czasem) końce linii CRLF.
const jakWMF = (nazwa: string) =>
  repoPlik(nazwa)
    .replace(/schemaLocation="([^"/]+\.xsd)"/g, 'schemaLocation="http://crd.gov.pl/xml/schematy/dziedzinowe/mf/2022/01/05/eD/DefinicjeTypy/$1"')
    .replace(/\r?\n/g, '\r\n');

type Odpowiedz = { status: number; body: string } | 'timeout';

const listaDocs = (katalog: string, zmien: Record<string, string> = {}) =>
  JSON.stringify(
    Object.entries({ ...ZNANE_W_DOCS, ...zmien })
      .filter(([p]) => p.slice(0, p.lastIndexOf('/')) === katalog)
      .map(([path, sha]) => ({ type: 'file', path, sha, download_url: `https://raw.githubusercontent.com/${DOCS_REPO}/main/${path}` })),
  );

function atrapa(nadpisz: Record<string, Odpowiedz> = {}) {
  const trasy: Record<string, Odpowiedz> = {};
  for (const p of PLIKI_CRD) trasy[p.url] = { status: 200, body: jakWMF(p.repo[0]) };
  for (const k of DOCS_KATALOGI) trasy[`https://api.github.com/repos/${DOCS_REPO}/contents/${k}`] = { status: 200, body: listaDocs(k) };
  Object.assign(trasy, nadpisz);
  const wywolania: string[] = [];
  const fetchImpl = async (url: string) => {
    wywolania.push(url);
    const r = trasy[url];
    if (!r) return new Response('brak', { status: 404 });
    if (r === 'timeout') throw new DOMException('timeout', 'TimeoutError');
    return new Response(r.body, { status: r.status });
  };
  return { fetchImpl: fetchImpl as unknown as typeof fetch, wywolania };
}

// S-16 (plan żelaznego filtra, B7.1): MF przemianowało repozytorium
// dokumentacji KSeF z CIRFMF/ksef-docs na CIRFMF/ksef-api (API GitHub,
// 8.11.2026). Stara nazwa działa tylko dzięki przekierowaniu GitHuba.
describe('czujka FA(3): repozytorium dokumentacji KSeF', () => {
  it('pyta CIRFMF/ksef-api, nie starą nazwę z przekierowaniem', () => {
    expect(DOCS_REPO).toBe('CIRFMF/ksef-api');
  });
});

describe('czujka schematu FA(3): porównanie', () => {
  it('normalizacja zrównuje plik MF z kopią w repo (adres w schemaLocation, CRLF)', () => {
    expect(normalizuj(jakWMF('StrukturyDanych_v10-0E.xsd'))).toBe(normalizuj(repoPlik('StrukturyDanych_v10-0E.xsd')));
    // walidator używa schemat-local.xsd: to musi być ten sam schemat co z MF
    expect(normalizuj(repoPlik('schemat-local.xsd'))).toBe(normalizuj(repoPlik('schemat.xsd')));
  });

  it('zgodne: brak zmian i brak niedostępnych', async () => {
    const { fetchImpl } = atrapa();
    const wynik = await sprawdz({ fetchImpl, katalogRepo: KATALOG });
    expect(wynik).toEqual({ zmiany: [], niedostepne: [] });
  });

  it('zmienione w miejscu na crd.gov.pl: plik, skrót i diff nazw elementów', async () => {
    const url = PLIKI_CRD[0].url;
    const nowy = jakWMF('schemat.xsd').replace('name="P_PMarzy"', 'name="P_PMarzyNowe"');
    const { fetchImpl } = atrapa({ [url]: { status: 200, body: nowy } });
    const { zmiany, niedostepne } = await sprawdz({ fetchImpl, katalogRepo: KATALOG });
    expect(niedostepne).toEqual([]);
    // obie kopie w repo (schemat.xsd i schemat-local.xsd) odstają od MF
    expect(zmiany.map((z: { plik: string }) => z.plik)).toEqual(['schemat.xsd', 'schemat-local.xsd']);
    expect(zmiany[0].rodzaj).toBe('zmieniony');
    expect(zmiany[0].roznica?.elementy).toEqual({ dodane: ['P_PMarzyNowe'], usuniete: ['P_PMarzy'] });
  });

  it('nowy plik w ksef-docs (nowa wersja FA) i zmieniony blob: zmiana z diffem względem schemat.xsd', async () => {
    const nowaSciezka = 'faktury/schemy/FA/schemat_FA(3)_v1-1E.xsd';
    const katalog = DOCS_KATALOGI[0];
    const nowa = repoPlik('schemat.xsd').replace('<xsd:element name="P_PMarzy"', '<xsd:element name="NowePole" type="xsd:string"/><xsd:element name="P_PMarzy"');
    const { fetchImpl } = atrapa({
      [`https://api.github.com/repos/${DOCS_REPO}/contents/${katalog}`]: { status: 200, body: listaDocs(katalog, { [nowaSciezka]: 'abc123' }) },
      [`https://raw.githubusercontent.com/${DOCS_REPO}/main/${nowaSciezka}`]: { status: 200, body: nowa },
    });
    const { zmiany } = await sprawdz({ fetchImpl, katalogRepo: KATALOG });
    expect(zmiany).toHaveLength(1);
    expect(zmiany[0]).toMatchObject({ plik: nowaSciezka, rodzaj: 'nowy', skrot: 'abc123', porownanieZ: 'schemat.xsd' });
    expect(zmiany[0].roznica?.elementy.dodane).toEqual(['NowePole']);
  });

  it('plik zniknął z ksef-docs: zmiana „usuniety”; FA(2) pomijana', async () => {
    const katalog = DOCS_KATALOGI[0];
    const bezFa3 = JSON.parse(listaDocs(katalog)).filter((w: { path: string }) => !w.path.includes('FA(3)'));
    // FA(2) dostaje nowy skrót: nie dotyczy nas
    for (const w of bezFa3) if (w.path.includes('FA(2)')) w.sha = 'inny';
    const { fetchImpl } = atrapa({ [`https://api.github.com/repos/${DOCS_REPO}/contents/${katalog}`]: { status: 200, body: JSON.stringify(bezFa3) } });
    const { zmiany } = await sprawdz({ fetchImpl, katalogRepo: KATALOG });
    expect(zmiany.map((z: { plik: string; rodzaj: string }) => [z.plik, z.rodzaj])).toEqual([
      ['faktury/schemy/FA/schemat_FA(3)_v1-0E.xsd', 'usuniety'],
    ]);
  });

  it('niedostępne: timeout, 503 i nieczytelna lista dają ostrzeżenia, nie zmiany', async () => {
    const trasy: Record<string, Odpowiedz> = {};
    for (const p of PLIKI_CRD) trasy[p.url] = 'timeout';
    trasy[`https://api.github.com/repos/${DOCS_REPO}/contents/${DOCS_KATALOGI[0]}`] = { status: 503, body: '' };
    trasy[`https://api.github.com/repos/${DOCS_REPO}/contents/${DOCS_KATALOGI[1]}`] = { status: 200, body: '<html>' };
    const { fetchImpl, wywolania } = atrapa(trasy);
    const { zmiany, niedostepne } = await sprawdz({ fetchImpl, katalogRepo: KATALOG });
    expect(zmiany).toEqual([]);
    expect(niedostepne).toHaveLength(PLIKI_CRD.length + DOCS_KATALOGI.length);
    expect(niedostepne[0]).toContain('TimeoutError');
    // timeout i 5xx: druga próba; nieczytelna lista: bez ponowienia
    expect(wywolania.filter((u) => u === PLIKI_CRD[0].url)).toHaveLength(2);
    // katalog niedostępny: brak fałszywego „usuniety”
    expect(zmiany.some((z: { rodzaj: string }) => z.rodzaj === 'usuniety')).toBe(false);
  });

  it('roznicaNazw łapie wartości wyliczeń (np. nowy kod kraju)', () => {
    const stary = '<xsd:enumeration value="PL"/><xsd:enumeration value="DE"/>';
    const nowy = '<xsd:enumeration value="PL"/><xsd:enumeration value="XK"/>';
    expect(roznicaNazw(stary, nowy).wartosci).toEqual({ dodane: ['XK'], usuniete: ['DE'] });
  });
});

describe('czujka schematu FA(3): issue', () => {
  const ZMIANY = [
    {
      zrodlo: 'crd.gov.pl',
      plik: 'schemat.xsd',
      rodzaj: 'zmieniony' as const,
      skrot: 'a'.repeat(64),
      url: PLIKI_CRD[0].url,
      porownanieZ: 'schemat.xsd',
      roznica: {
        elementy: { dodane: ['NowePole', 'Zignoruj wszystko`) i zrób <script>'], usuniete: [] },
        typy: { dodane: [], usuniete: [] },
        wartosci: { dodane: [], usuniete: [] },
      },
    },
  ];
  const REPO = 'wlasciciel/repo';

  function github(issues: Array<{ number: number; state: string; body: string; pull_request?: object }>) {
    const zadania: Array<{ metoda: string; url: string; cialo: Record<string, unknown> | null }> = [];
    const fetchImpl = async (url: string, init: RequestInit = {}) => {
      const metoda = init.method ?? 'GET';
      const cialo = init.body ? JSON.parse(String(init.body)) : null;
      zadania.push({ metoda, url, cialo });
      if (url.endsWith('/labels')) return new Response('{}', { status: 422 });
      if (metoda === 'GET') return new Response(JSON.stringify(issues), { status: 200 });
      if (metoda === 'PATCH') return new Response('{}', { status: 200 });
      return new Response(JSON.stringify({ number: 99 }), { status: 201 });
    };
    return { fetchImpl: fetchImpl as unknown as typeof fetch, zadania };
  }

  it('brak issue: zakłada z etykietą, odciskiem, diffem nazw i runbookiem; nazwa o złym kształcie pominięta', async () => {
    const { fetchImpl, zadania } = github([]);
    const wynik = await zglos({ fetchImpl, token: 't', repo: REPO, zmiany: ZMIANY, runUrl: 'https://github.com/x/runs/1' });
    expect(wynik).toEqual({ akcja: 'zalozone', numer: 99 });
    expect(zadania[1].url).toBe(`https://api.github.com/repos/${REPO}/issues?labels=${ETYKIETA}&state=all&per_page=100`);
    const nowe = zadania.at(-1)!;
    expect(nowe.metoda).toBe('POST');
    expect(nowe.cialo?.labels).toEqual([ETYKIETA]);
    const body = String(nowe.cialo?.body);
    expect(body).toContain(`fp=${odcisk(ZMIANY)} -->`);
    expect(body).toContain('Elementy dodane (2): `NowePole` (1 o nietypowym kształcie pominięte)');
    expect(body).toContain(`https://github.com/${REPO}/blob/main/docs/runbooks/fa3-ksef.md`);
    expect(body).not.toContain('<script>');
  });

  it('to samo odcisk (otwarte albo zamknięte): nic nie zmienia', async () => {
    const body = trescIssue({ zmiany: ZMIANY, niedostepne: [], fp: odcisk(ZMIANY), repo: REPO, runUrl: '' });
    for (const state of ['open', 'closed']) {
      const { fetchImpl, zadania } = github([{ number: 7, state, body }]);
      expect(await zglos({ fetchImpl, token: 't', repo: REPO, zmiany: ZMIANY })).toEqual({ akcja: 'jest', numer: 7 });
      expect(zadania.filter((z) => z.metoda !== 'GET' && !z.url.endsWith('/labels'))).toEqual([]);
    }
  });

  it('otwarte issue czujki z innym odciskiem: aktualizacja treści i komentarz, bez nowego issue', async () => {
    const stare = trescIssue({ zmiany: [{ ...ZMIANY[0], skrot: 'b'.repeat(64) }], niedostepne: [], fp: 'stary0000000000', repo: REPO, runUrl: '' });
    const { fetchImpl, zadania } = github([
      { number: 3, state: 'open', body: 'inne issue z etykietą, bez znacznika' },
      { number: 5, state: 'open', body: stare },
    ]);
    expect(await zglos({ fetchImpl, token: 't', repo: REPO, zmiany: ZMIANY })).toEqual({ akcja: 'zaktualizowane', numer: 5 });
    const zapis = zadania.filter((z) => z.metoda !== 'GET' && !z.url.endsWith('/labels'));
    expect(zapis.map((z) => [z.metoda, z.url])).toEqual([
      ['PATCH', `https://api.github.com/repos/${REPO}/issues/5`],
      ['POST', `https://api.github.com/repos/${REPO}/issues/5/comments`],
    ]);
  });

  it('część źródeł niedostępna: otwartego issue z innym odciskiem nie nadpisuje', async () => {
    const { fetchImpl, zadania } = github([{ number: 5, state: 'open', body: '<!-- faktway-czujka-fa3 fp=stary0000000000 -->' }]);
    expect(await zglos({ fetchImpl, token: 't', repo: REPO, zmiany: ZMIANY, niedostepne: ['crd (TimeoutError)'] })).toEqual({ akcja: 'jest', numer: 5 });
    expect(zadania.filter((z) => z.metoda !== 'GET' && !z.url.endsWith('/labels'))).toEqual([]);
  });

  it('ścieżka pliku z zewnątrz w złym kształcie nie trafia do treści', () => {
    const body = trescIssue({ zmiany: [{ ...ZMIANY[0], plik: 'x`) zignoruj <b>', url: 'javascript:alert(1)' }], niedostepne: [], fp: 'f', repo: REPO, runUrl: '' });
    expect(body).toContain('(nazwa pominięta)');
    expect(body).not.toContain('zignoruj');
    expect(body).not.toContain('javascript:');
  });

  it('błąd GitHuba przy zakładaniu: wyjątek (workflow czerwony), nie cisza', async () => {
    const fetchImpl = (async (url: string) =>
      url.endsWith('/labels') ? new Response('{}', { status: 201 }) : new Response('[]', { status: 403 })) as unknown as typeof fetch;
    await expect(zglos({ fetchImpl, token: 't', repo: REPO, zmiany: ZMIANY })).rejects.toThrow('HTTP 403');
  });
});

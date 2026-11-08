import { describe, expect, it } from 'vitest';

import {
  ZGODA_FILTRA,
  ZGODA_WIEDZY,
  ZGODA_WYJATKU,
  czytajKarte,
  etykietaWazna,
  idPrzepisow,
  liniePatcha,
  ocenPR,
  plikiTestowWPolu,
  raport,
  wzrostZapadki,
} from '@/scripts/filtr/straz.mjs';

/**
 * „Filtr: straż” (żelazny filtr F2, plan B5.4): logika oceny PR na danych,
 * bez GitHuba. Workflow podaje te same dane z API.
 */

type Zdarzenie = { event: string; label?: { name: string }; actor?: { login: string }; created_at?: string };
type Plik = { plik: string; status: string; poprzedni?: string; patch?: string; tresc?: string };

function mapa() {
  return {
    wersja: 1,
    kod: { katalogi: ['lib/', 'app/', 'components/', 'scripts/'], rozszerzenia: ['.ts', '.tsx', '.mjs'], pomijane: ['**/*.test.ts'] },
    obszary: [
      { id: 'silniki', poziom: 'R1', opis: 'Silniki obliczeń podatków.', sciezki: ['lib/podatki/**'] },
      { id: 'parametry', poziom: 'R1', opis: 'Parametry roku.', sciezki: ['lib/ksiegowosc/parametry/**'] },
      { id: 'szacunki', poziom: 'R2', opis: 'Szacunki na pulpicie.', sciezki: ['lib/pulpit/**'] },
      { id: 'ekrany', poziom: 'R3', opis: 'Ekrany i komponenty.', sciezki: ['components/**/*.tsx'] },
    ],
    wylaczenia: [{ sciezki: ['scripts/filtr/**'], powod: 'Maszyneria filtra chroniona przez straż.' }],
    sygnaly: {
      tresc: [{ id: 'vat', wzorzec: '(?<![A-Za-z])(?:VAT|[Vv]at)|(?<=[a-z])Vat' }],
      nazwy: [{ id: 'podatki', wzorzec: '(?:^|-)(?:vat|tax)' }],
    },
  };
}

const BARTOSZ = 'ezior8888-cpu';
const PUSH = '2026-11-08T20:00:00Z';
const PO_PUSHU = '2026-11-08T21:00:00Z';
const PRZED_PUSHEM = '2026-11-08T19:00:00Z';

const KARTA_R1 = `## Karta zmiany prawnej (filtr)

- Poziom i obszary z mapy: R1, silniki
- Rodzaj: naprawa
- Przepisy z rejestru (id) albo nowy przepis ze źródłem: RP-ZAOKR-01
- Źródło zmiany wiedzy (Dz.U., ISAP, MF, ZUS, podpis księgowej) albo n/d: n/d
- Co zmienia się dla klienta (kwoty, terminy, pliki, teksty, nic): kwota ryczałtu przy groszach
- Zaokrąglenia i kwoty ujemne: art. 63 § 1 OP, sprawdzone dla ujemnych
- Granice czasu (miesiąc, rok, rok składkowy, strefa): n/d
- Waluty, korekty, zaliczki: n/d
- Brak danych: komunikat dla klienta i ścieżka operatora: bez zmian
- Treści (D8) i dane osobowe: n/d
- Dowody: test czerwony przed zmianą, niezmienniki, wyrocznia, przykłady, XSD: \`tests/unit/ryczalt.test.ts\` czerwony przed
- Drugi czytelnik z listą kontrolną (kto, wynik, odpowiedzi na uwagi): /code-review, 2 uwagi poprawione
- Wyjątki od filtra (etykieta, powód) albo brak: brak

## Migracje

Brak.`;

const patch = (...dodane: string[]) => `@@ -1,1 +1,${dodane.length} @@\n${dodane.map((l) => `+${l}`).join('\n')}`;
const zmianaR1: Plik = { plik: 'lib/podatki/ryczalt.ts', status: 'modified', patch: patch('const x = 1;') };
const testR1: Plik = { plik: 'tests/unit/ryczalt.test.ts', status: 'modified', patch: patch('it("x", () => {});') };

function dane(nadpisz: Partial<Parameters<typeof ocenPR>[0]> = {}) {
  const m = mapa();
  return {
    pliki: [] as Plik[],
    mapaMain: m,
    mapaPR: m,
    zapadkaMain: null,
    zapadkaPR: null,
    opis: '',
    etykiety: [] as string[],
    zdarzenia: [] as Zdarzenie[],
    osoby: [BARTOSZ],
    ostatniPush: PUSH,
    plikiRepo: ['lib/podatki/ryczalt.ts', 'tests/unit/ryczalt.test.ts', 'lib/pulpit/a.ts'],
    przepisy: new Set<string>(),
    ...nadpisz,
  };
}

const zgoda = (nazwa: string, kto = BARTOSZ, kiedy = PO_PUSHU) => ({
  event: 'labeled',
  label: { name: nazwa },
  actor: { login: kto },
  created_at: kiedy,
});

const wymogi = (wynik: ReturnType<typeof ocenPR>) => wynik.bledy.map((b) => b.wymog).join('\n');

describe('poziom PR i klasyfikacja', () => {
  it('PR z samą dokumentacją: R0, bez wymogów', () => {
    const wynik = ocenPR(dane({ pliki: [{ plik: 'docs/notatka.md', status: 'added', patch: patch('VAT') }] }));
    expect(wynik).toMatchObject({ poziom: 'R0', ok: true });
  });

  it('PR R3 (ekran) nie wymaga karty', () => {
    const wynik = ocenPR(dane({ pliki: [{ plik: 'components/x/karta.tsx', status: 'modified', patch: patch('<div/>') }] }));
    expect(wynik).toMatchObject({ poziom: 'R3', ok: true });
  });

  it('plik z sygnałem poza mapą zatrzymuje PR', () => {
    const wynik = ocenPR(dane({ pliki: [{ plik: 'lib/nowe/stawki.ts', status: 'added', patch: patch('const stawkaVat = 23;') }] }));
    expect(wynik.ok).toBe(false);
    expect(wymogi(wynik)).toMatch(/pliki z sygnałem poza mapą ryzyka/);
    expect(wynik.poziom).toBe('R1');
  });

  it('PR, który dopisuje nowy plik do mapy, jest oceniany poziomem z mapy PR', () => {
    const mapaPR = mapa();
    mapaPR.obszary[2].sciezki.push('lib/nowe/**');
    const wynik = ocenPR(
      dane({
        mapaPR,
        opis: KARTA_R1.replace('R1, silniki', 'R2, szacunki'),
        pliki: [{ plik: 'lib/nowe/stawki.ts', status: 'added', patch: patch('const stawkaVat = 23;') }],
      }),
    );
    expect(wynik.poziom).toBe('R2');
    expect(wymogi(wynik)).not.toMatch(/poza mapą/);
  });

  it('mapa z PR nie obniży poziomu: liczy się wyższy, a osłabienie wymaga zgody', () => {
    const mapaPR = mapa();
    mapaPR.obszary[0].poziom = 'R3';
    const wynik = ocenPR(dane({ mapaPR, pliki: [zmianaR1, testR1], opis: KARTA_R1 }));
    expect(wynik.poziom).toBe('R1');
    expect(wynik.wymaganeZgody.map((z) => z.etykieta)).toContain(ZGODA_FILTRA);
    expect(wymogi(wynik)).toMatch(/potrzebna etykieta zgoda:zmiana-filtra/);
  });

  it('niepoprawna mapa w PR to błąd z treścią problemu', () => {
    const mapaPR = { ...mapa(), obszary: [{ id: 'x', poziom: 'R9', opis: 'zły poziom tutaj', sciezki: ['lib/**'] }] };
    const wynik = ocenPR(dane({ mapaPR, pliki: [{ plik: 'docs/a.md', status: 'modified', patch: patch('a') }] }));
    expect(wymogi(wynik)).toMatch(/mapa ryzyka w PR jest niepoprawna/);
  });

  it('bez mapy na main i w PR straż nie przepuszcza', () => {
    const wynik = ocenPR(dane({ mapaMain: null, mapaPR: null }));
    expect(wynik).toMatchObject({ ok: false, poziom: 'R1' });
  });

  it('przeniesienie pliku R1 poza obszar: wiersz ze starą ścieżką trzyma R1', () => {
    const wynik = ocenPR(
      dane({ pliki: [{ plik: 'docs/ryczalt.md', status: 'renamed', poprzedni: 'lib/podatki/ryczalt.ts', patch: '' }], opis: KARTA_R1 }),
    );
    expect(wynik.poziom).toBe('R1');
    expect(wynik.wiersze.some((w) => w.plik === 'lib/podatki/ryczalt.ts' && w.zmiana === 'przeniesiony')).toBe(true);
  });
});

describe('karta zmiany prawnej', () => {
  it('PR R1 bez karty jest czerwony', () => {
    const wynik = ocenPR(dane({ pliki: [zmianaR1, testR1] }));
    expect(wymogi(wynik)).toMatch(/PR R1 bez karty zmiany prawnej/);
  });

  it('PR R1 z pełną kartą i testem przechodzi', () => {
    expect(ocenPR(dane({ pliki: [zmianaR1, testR1], opis: KARTA_R1 })).ok).toBe(true);
  });

  it('PR R2 wymaga karty, ale nie przepisów z rejestru', () => {
    const r2: Plik = { plik: 'lib/pulpit/a.ts', status: 'modified', patch: patch('x') };
    expect(wymogi(ocenPR(dane({ pliki: [r2] })))).toMatch(/PR R2 bez karty/);
    const karta = KARTA_R1.replace('R1, silniki', 'R2, szacunki').replace('RP-ZAOKR-01', 'n/d');
    expect(ocenPR(dane({ pliki: [r2], opis: karta })).ok).toBe(true);
  });

  it('puste pole karty jest wymienione z nazwy', () => {
    const wynik = ocenPR(dane({ pliki: [zmianaR1, testR1], opis: KARTA_R1.replace('kwota ryczałtu przy groszach', '') }));
    expect(wymogi(wynik)).toMatch(/puste pola „Co zmienia się dla klienta”/);
  });

  it('poziom w karcie niższy niż z mapy', () => {
    const wynik = ocenPR(dane({ pliki: [zmianaR1, testR1], opis: KARTA_R1.replace('R1, silniki', 'R3') }));
    expect(wymogi(wynik)).toMatch(/poziom w karcie \(R3\) niższy niż z mapy \(R1\)/);
  });

  it('zostawiony szablon rodzaju i nieznany rodzaj', () => {
    const szablon = KARTA_R1.replace('Rodzaj: naprawa', 'Rodzaj: naprawa / nowa funkcja / refaktor bez zmiany zachowania / tylko testy / tylko wiedza');
    expect(wymogi(ocenPR(dane({ pliki: [zmianaR1, testR1], opis: szablon })))).toMatch(/kilka rodzajów naraz/);
    const nieznany = KARTA_R1.replace('Rodzaj: naprawa', 'Rodzaj: porządki');
    expect(wymogi(ocenPR(dane({ pliki: [zmianaR1, testR1], opis: nieznany })))).toMatch(/nieznany rodzaj/);
  });

  it('brak drugiego czytelnika', () => {
    const karta = KARTA_R1.replace('/code-review, 2 uwagi poprawione', 'n/d');
    expect(wymogi(ocenPR(dane({ pliki: [zmianaR1, testR1], opis: karta })))).toMatch(/brak drugiego czytelnika/);
  });

  it('R1 bez przepisów', () => {
    const karta = KARTA_R1.replace('RP-ZAOKR-01', 'n/d');
    expect(wymogi(ocenPR(dane({ pliki: [zmianaR1, testR1], opis: karta })))).toMatch(/R1 bez przepisów/);
  });

  it('gdy rejestr istnieje, id z karty musi w nim być', () => {
    const przepisy = new Set(['RP-PIT-01']);
    expect(wymogi(ocenPR(dane({ pliki: [zmianaR1, testR1], opis: KARTA_R1, przepisy })))).toMatch(/nieznane id w rejestrze: RP-ZAOKR-01/);
    expect(ocenPR(dane({ pliki: [zmianaR1, testR1], opis: KARTA_R1, przepisy: new Set(['RP-ZAOKR-01']) })).ok).toBe(true);
  });

  it('dowody muszą wskazać istniejący plik testu', () => {
    const karta = KARTA_R1.replace('`tests/unit/ryczalt.test.ts`', '`tests/unit/nie-ma.test.ts`');
    expect(wymogi(ocenPR(dane({ pliki: [zmianaR1, testR1], opis: karta })))).toMatch(/dowody wskazują nieistniejące pliki/);
    const bez = KARTA_R1.replace('`tests/unit/ryczalt.test.ts` czerwony przed', 'sprawdzone ręcznie');
    expect(wymogi(ocenPR(dane({ pliki: [zmianaR1, testR1], opis: bez })))).toMatch(/R1 bez plików testów w dowodach/);
  });
});

describe('test przy kodzie R1', () => {
  it('kod R1 bez testu wymaga zgoda:wyjatek-filtra', () => {
    const wynik = ocenPR(dane({ pliki: [zmianaR1], opis: KARTA_R1 }));
    expect(wynik.wymaganeZgody.map((z) => z.etykieta)).toEqual([ZGODA_WYJATKU]);
    expect(wymogi(wynik)).toMatch(/zgoda:wyjatek-filtra/);
  });

  it('z etykietą Bartosza i powodem w karcie wyjątek przechodzi', () => {
    const karta = KARTA_R1.replace('albo brak: brak', 'albo brak: zgoda:wyjatek-filtra, sama zmiana komentarza');
    const wynik = ocenPR(dane({ pliki: [zmianaR1], opis: karta, etykiety: [ZGODA_WYJATKU], zdarzenia: [zgoda(ZGODA_WYJATKU)] }));
    expect(wynik.ok).toBe(true);
  });

  it('wyjątek bez powodu w karcie nie przechodzi', () => {
    const wynik = ocenPR(dane({ pliki: [zmianaR1], opis: KARTA_R1, etykiety: [ZGODA_WYJATKU], zdarzenia: [zgoda(ZGODA_WYJATKU)] }));
    expect(wymogi(wynik)).toMatch(/wyjątek bez uzasadnienia/);
  });

  it('refaktor bez zmiany zachowania nie wymaga nowego testu, ale zostawia uwagę', () => {
    const karta = KARTA_R1.replace('Rodzaj: naprawa', 'Rodzaj: refaktor bez zmiany zachowania');
    const wynik = ocenPR(dane({ pliki: [zmianaR1], opis: karta }));
    expect(wynik.ok).toBe(true);
    expect(wynik.uwagi.join('\n')).toMatch(/Refaktor bez nowych testów/);
  });

  it('nowy komentarz filtr-wyjatek wymaga zgody', () => {
    const plik: Plik = { plik: 'lib/podatki/ryczalt.ts', status: 'modified', patch: patch('// filtr-wyjatek: zaokrąglenie z bazy') };
    const wynik = ocenPR(dane({ pliki: [plik, testR1], opis: KARTA_R1 }));
    expect(wynik.wymaganeZgody.map((z) => z.etykieta)).toContain(ZGODA_WYJATKU);
  });
});

describe('zmiany chronione', () => {
  it('maszyneria filtra wymaga zgoda:zmiana-filtra', () => {
    for (const plik of ['.github/workflows/ci.yml', 'scripts/filtr/mapa.mjs', '.githooks/pre-push', '.claude/settings.json', 'filtr/zgody.json']) {
      const wynik = ocenPR(dane({ pliki: [{ plik, status: 'modified', patch: patch('x') }] }));
      expect(wynik.wymaganeZgody.map((z) => z.etykieta), plik).toEqual([ZGODA_FILTRA]);
    }
  });

  it('przeniesienie pliku maszynerii poza jej katalog też wymaga zgody', () => {
    const wynik = ocenPR(dane({ pliki: [{ plik: 'docs/stary-straz.mjs', status: 'renamed', poprzedni: 'scripts/filtr/straz.mjs' }] }));
    expect(wynik.wymaganeZgody.map((z) => z.etykieta)).toContain(ZGODA_FILTRA);
  });

  it('wiedza prawna wymaga zgoda:wiedza-prawna i źródła w karcie', () => {
    const plik: Plik = { plik: 'lib/ksiegowosc/parametry/2027.ts', status: 'added', patch: patch('export const x = 1;') };
    const bezZrodla = ocenPR(dane({ pliki: [plik, testR1], opis: KARTA_R1, etykiety: [ZGODA_WIEDZY], zdarzenia: [zgoda(ZGODA_WIEDZY)] }));
    expect(wymogi(bezZrodla)).toMatch(/zmiana wiedzy bez źródła/);
    const karta = KARTA_R1.replace('albo n/d: n/d', 'albo n/d: Dz.U. 2026 poz. 1213');
    const zeZrodlem = ocenPR(dane({ pliki: [plik, testR1], opis: karta, etykiety: [ZGODA_WIEDZY], zdarzenia: [zgoda(ZGODA_WIEDZY)] }));
    expect(zeZrodlem.ok).toBe(true);
  });

  it('dopisanie testu filtra jest wolne, zmiana albo usunięcie linii wymaga zgody', () => {
    const nowy: Plik = { plik: 'tests/filtr/nowy.test.ts', status: 'added', patch: patch('it("a", () => {});') };
    expect(ocenPR(dane({ pliki: [nowy] })).wymaganeZgody).toEqual([]);
    const zmieniony: Plik = { plik: 'tests/filtr/mapa.test.ts', status: 'modified', patch: '@@ -1 +1 @@\n-expect(a).toBe(1);\n+expect(a).toBe(2);' };
    expect(ocenPR(dane({ pliki: [zmieniony] })).wymaganeZgody.map((z) => z.etykieta)).toEqual([ZGODA_FILTRA]);
    const usuniety: Plik = { plik: 'tests/filtr/mapa.test.ts', status: 'removed', patch: '' };
    expect(ocenPR(dane({ pliki: [usuniety] })).wymaganeZgody.map((z) => z.etykieta)).toEqual([ZGODA_FILTRA]);
  });

  it('wzrost zapadki wymaga zgody, spadek nie', () => {
    const wzrost = ocenPR(dane({ zapadkaMain: { naruszenia: { 'roundToCents': 5 } }, zapadkaPR: { naruszenia: { 'roundToCents': 6 } } }));
    expect(wzrost.wymaganeZgody.map((z) => z.etykieta)).toEqual([ZGODA_FILTRA]);
    const spadek = ocenPR(dane({ zapadkaMain: { naruszenia: { 'roundToCents': 5 } }, zapadkaPR: { naruszenia: { 'roundToCents': 4 } } }));
    expect(spadek.wymaganeZgody).toEqual([]);
  });
});

describe('etykiety zgody', () => {
  const kontekst = (zdarzenia: Zdarzenie[], obecne = [ZGODA_FILTRA]) => ({ obecne, zdarzenia, osoby: [BARTOSZ], ostatniPush: PUSH });

  it('ważna: Bartosz, po ostatnim pushu', () => {
    expect(etykietaWazna(ZGODA_FILTRA, kontekst([zgoda(ZGODA_FILTRA)]))).toMatchObject({ wazna: true, kto: BARTOSZ });
  });

  it('nieważna: inna osoba (także agent na koncie z dostępem)', () => {
    expect(etykietaWazna(ZGODA_FILTRA, kontekst([zgoda(ZGODA_FILTRA, 'masloigor')]))).toMatchObject({ wazna: false });
  });

  it('nieważna: nadana przed ostatnim pushem', () => {
    expect(etykietaWazna(ZGODA_FILTRA, kontekst([zgoda(ZGODA_FILTRA, BARTOSZ, PRZED_PUSHEM)]))).toMatchObject({
      wazna: false,
      powod: 'etykieta sprzed ostatniego pushu',
    });
  });

  it('nieważna: brak etykiety albo brak zdarzenia nadania', () => {
    expect(etykietaWazna(ZGODA_FILTRA, kontekst([], []))).toMatchObject({ wazna: false, powod: 'brak etykiety' });
    expect(etykietaWazna(ZGODA_FILTRA, kontekst([]))).toMatchObject({ wazna: false });
  });

  it('liczy się ostatnie nadanie: najpierw ktoś inny, potem Bartosz', () => {
    expect(etykietaWazna(ZGODA_FILTRA, kontekst([zgoda(ZGODA_FILTRA, 'ktos'), zgoda(ZGODA_FILTRA)]))).toMatchObject({ wazna: true });
    expect(etykietaWazna(ZGODA_FILTRA, kontekst([zgoda(ZGODA_FILTRA), zgoda(ZGODA_FILTRA, 'ktos')]))).toMatchObject({ wazna: false });
  });

  it('zmiana maszynerii z ważną etykietą przechodzi', () => {
    const wynik = ocenPR(
      dane({ pliki: [{ plik: 'scripts/filtr/mapa.mjs', status: 'modified', patch: patch('x') }], etykiety: [ZGODA_FILTRA], zdarzenia: [zgoda(ZGODA_FILTRA)] }),
    );
    expect(wynik.ok).toBe(true);
  });
});

describe('części pomocnicze', () => {
  it('karta: etykieta z dwukropkiem, linie kontynuacji, komentarze HTML', () => {
    const karta = czytajKarte(
      `## Karta zmiany prawnej (filtr)\n<!-- - Rodzaj: naprawa -->\n- Brak danych: komunikat dla klienta i ścieżka operatora: komunikat A\n  i runbook B\n- Rodzaj: nowa funkcja\n## Dalej`,
    );
    expect(karta).toEqual({ 'brak-danych': 'komunikat A i runbook B', rodzaj: 'nowa funkcja' });
    expect(czytajKarte('## Zmiana\n- Rodzaj: naprawa')).toBeNull();
    expect(czytajKarte('')).toBeNull();
  });

  it('linie patcha, pliki testów w polu, id przepisów, wzrost zapadki', () => {
    expect(liniePatcha('@@ -1,2 +1,2 @@\n-stara\n+nowa\n bez zmian')).toEqual({ dodane: ['nowa'], usuniete: ['stara'] });
    expect(plikiTestowWPolu('`tests/unit/a.test.ts` i lib/xml/b.test.ts, oraz tests/fixtures/x.json')).toEqual([
      'tests/unit/a.test.ts',
      'lib/xml/b.test.ts',
      'tests/fixtures/x.json',
    ]);
    expect([...idPrzepisow({ przepisy: [{ id: 'RP-A-1', podrzedne: [{ id: 'RP-B-2' }] }, { id: 'zle' }] })]).toEqual(['RP-A-1', 'RP-B-2']);
    expect(wzrostZapadki({ a: 1 }, { a: 1, b: 0 })).toEqual(['b: brak → 0']);
  });

  it('raport podaje wymóg, co zrobić, kto daje wyjątek i tabelę plików', () => {
    const wynik = ocenPR(dane({ pliki: [zmianaR1] }));
    const tekst = raport(wynik);
    expect(tekst).toMatch(/\[FILTR R1\] PR R1 bez karty zmiany prawnej/);
    expect(tekst).toMatch(/Co zrobić:/);
    expect(tekst).toMatch(/Wyjątek:/);
    expect(tekst).toMatch(/\| `lib\/podatki\/ryczalt\.ts` \| silniki \| R1 \|/);
  });
});

describe('poprawki po przeglądzie (drugi czytelnik F2)', () => {
  it('fixture w tests/ nie jest testem dla kodu R1', () => {
    const fixture: Plik = { plik: 'tests/fixtures/ryczalt.json', status: 'modified', patch: patch('{}') };
    expect(ocenPR(dane({ pliki: [zmianaR1, fixture], opis: KARTA_R1 })).wymaganeZgody.map((z) => z.etykieta)).toEqual([ZGODA_WYJATKU]);
  });

  it('karta z kilkoma poziomami bierze najwyższy', () => {
    expect(ocenPR(dane({ pliki: [zmianaR1, testR1], opis: KARTA_R1.replace('R1, silniki', 'R3 i R1, silniki') })).ok).toBe(true);
  });
});

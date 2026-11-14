import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { Ewidencja, WierszEwidencji } from '@/lib/ksiegowosc/ewidencja';
import type { Kpir } from '@/lib/ksiegowosc/kpir';
import { brakujace, parametryRoku } from '@/lib/ksiegowosc/parametry';
import type { NazwaSekcji, ParametryRoku } from '@/lib/ksiegowosc/parametry/typy';
import { ETAPY_ZUS, type WersjaProfilu } from '@/lib/ksiegowosc/profil';
import { tenMiesiac, type RodzajRozliczenia, type TenMiesiac, type WejscieMiesiaca } from '@/lib/ksiegowosc/ten-miesiac';

import { profil, stawkaRyczaltu } from '../generatory/ksiegowosc';
import { opcje } from '../generatory/ustawienia';

/**
 * NZ-TRESC-04 (żelazny filtr F10, część 7c; plan B4.2; plan księgowości JDG,
 * sekcja 8): każdy brak ma komunikat z nazwą braku i tym, co z nim będzie,
 * bez trybu rozkazującego (D8).
 *
 * Gdzie klient widzi braki silnika „Ten miesiąc” (`tenMiesiac`) i co jest obok:
 * - brak pozycji (`ok: false` przy rozliczeniu): na stronie „Ten miesiąc”
 *   i w telefonie sam pod nazwą rozliczenia, bez innego tekstu. Komunikat
 *   mówi więc sam, czego brakuje (w pierwszym zdaniu, nie w dopisku, gdzie
 *   co zmienić) i co z kwotą tej pozycji będzie;
 * - brak całego miesiąca: lista pod tytułem „Kwot za {miesiąc} nie liczymy”,
 *   więc komunikat mówi, czego brakuje;
 * - braki parametrów (`brakujace`, D7): komunikat przy kwocie, której nie ma.
 *
 * Tryb rozkazujący sprawdzamy listą roboczą z NZ-TRESC-01 (do zatwierdzenia
 * przez prawnika) i listą form rozkazujących z tekstów ekranów; inne formy
 * test przepuści. Przegląd deterministyczny dociera do każdej ścieżki braku
 * silnika: każda liczba parametrów osobno nieogłoszona, każdy etap ZUS z datą
 * przed, w trakcie i po miesiącu albo bez daty, ustawienia od dnia w trakcie
 * miesiąca i ich zmiana, ewidencja i KPiR z brakami, ze stawką spoza
 * parametrów i bez odczytu, brak roku parametrów. Losowe przypadki są
 * dodatkiem. Braki VAT, KPiR roku poprzedniego i dokumentów ewidencji
 * powstają w warstwie danych (`*-dane.ts`) i mają osobny test.
 */

const ZAKAZANE = /(?<![\p{L}])(?:zapłać\p{L}*|musisz|musicie|powinieneś|powinnaś|powinniście|należy|zalecamy|radzimy|wybierz\p{L}*|opłaca się|lepiej|najkorzystniej\p{L}*|oszczędzisz|zaoszczędzisz)(?![\p{L}])/iu;
const ROZKAZUJACE = /(?<![\p{L}])(?:uzupełnij|sprawdź|dodaj|wpisz|zmień|kliknij|przejdź|otwórz|zostaw|wyłącz|włącz|przygotuj|napisz|zapisz|skontaktuj|pamiętaj|ustaw|podaj|złóż|prześlij|wyślij|popraw|zaznacz)(?![\p{L}])/iu;
const DLUGIE_MYSLNIKI = /[—–]/;
/** Nazwa braku w pierwszym zdaniu: czego brakuje albo co się nie zgadza. */
const NAZWA = /parametr|stawk|ustawie|etap|dat[aęy]|ewidencj|KPiR|kwot[ay]|limit|prog|próg|deklaracj|nadwyżk/iu;
/** Co z kwotą będzie: nie liczymy jej albo rozlicza ją kto inny. */
const SKUTEK = /nie liczy|nie pokazujemy|nie ustalimy|rozlicza księgowa|u księgowej/iu;
/** Skutek dotyczy tej pozycji (albo kwoty ogólnie), nie innej. */
const OBIEKT: Readonly<Record<RodzajRozliczenia, RegExp>> = {
  ryczalt: /ryczałt|kwot|nic(?![\p{L}])/iu,
  pit: /zaliczk|kwot|nic(?![\p{L}])/iu,
  zus_spoleczne: /składek|kwot|nic(?![\p{L}])|miesiąc rozlicza księgowa/iu,
  zdrowotna: /zdrowotn|kwot|nic(?![\p{L}])/iu,
  vat: /VAT|kwot|nic(?![\p{L}])/iu,
};

/** Pierwsze zdanie: do kropki przed wielką literą albo cudzysłowem (daty „1.03.2026” zostają w środku). */
const pierwszeZdanie = (tekst: string) => tekst.split(/\.\s+(?=[\p{Lu}„])/u)[0];

function bledyKomunikatu(tekst: string, rodzaj: RodzajRozliczenia | null): string[] {
  const bledy: string[] = [];
  const slowo = ZAKAZANE.exec(tekst) ?? ROZKAZUJACE.exec(tekst);
  if (slowo) bledy.push(`słowo „${slowo[0]}”`);
  if (DLUGIE_MYSLNIKI.test(tekst)) bledy.push('długi myślnik');
  if (!NAZWA.test(pierwszeZdanie(tekst))) bledy.push('bez nazwy braku w pierwszym zdaniu');
  if (rodzaj && !SKUTEK.test(tekst)) bledy.push('bez tego, co z kwotą będzie');
  if (rodzaj && SKUTEK.test(tekst) && !OBIEKT[rodzaj].test(tekst)) bledy.push(`skutek nie o pozycji ${rodzaj}`);
  return bledy.map((b) => `${b}: ${tekst}`);
}

/** Braki z wyniku silnika: pozycje mówią skutek same, braki miesiąca mają go w tytule. */
function bledyWyniku(w: TenMiesiac): string[] {
  if (!w.ok) return w.braki.flatMap((b) => bledyKomunikatu(b, null));
  return w.wynik.pozycje.flatMap((p) => (p.ok ? [] : bledyKomunikatu(p.brak, p.rodzaj)));
}

const DZIEN_MS = 86_400_000;
const dzienMiedzy = (od: string, doDnia: string) =>
  fc.integer({ min: Date.parse(`${od}T00:00:00Z`) / DZIEN_MS, max: Date.parse(`${doDnia}T00:00:00Z`) / DZIEN_MS }).map((d) => new Date(d * DZIEN_MS).toISOString().slice(0, 10));
const ostatniDzien = (rok: number, nr: number) => new Date(Date.UTC(rok, nr, 0)).toISOString().slice(0, 10);
const mm = (nr: number) => String(nr).padStart(2, '0');

// Wszystkie liczby parametrów jako „sekcja.klucz”, żeby je osobno „nie ogłaszać”.
const BAZA = parametryRoku(2026)!;
const SEKCJE = Object.keys(BAZA).filter((k) => k !== 'rok') as NazwaSekcji[];
const KLUCZE = SEKCJE.flatMap((s) => Object.keys((BAZA[s] as { liczby: Record<string, unknown> }).liczby).map((k) => `${s}.${k}`));

function parametryZ(nieogloszone: readonly string[], bezRoku: readonly number[]): (rok: number) => ParametryRoku | null {
  return (rok) => {
    if (bezRoku.includes(rok)) return null;
    const p = parametryRoku(rok);
    if (!p) return null;
    const kopia = structuredClone(p) as unknown as Record<string, { liczby: Record<string, { wartosc: number | null }> }>;
    for (const sk of nieogloszone) {
      const [s, k] = sk.split('.');
      const liczba = kopia[s]?.liczby[k];
      if (liczba) liczba.wartosc = null;
    }
    return kopia as unknown as ParametryRoku;
  };
}

function wiersz(dzien: string, kwotaGr: number, stawkaPb: number, i: number): WierszEwidencji {
  return {
    lp: i + 1,
    dataWpisu: dzien,
    dataPrzychodu: dzien,
    dowod: `D/${i}`,
    numerKsef: null,
    krajKontrahenta: null,
    idKontrahenta: null,
    kwotaGr,
    stawkaPb,
    uwagi: null,
    zrodlo: { typ: 'wpis', id: `w-${i}` },
  };
}

const brakDokumentu = (rok: number, nr: number) => ({ dzien: `${rok}-${mm(nr)}-15`, dokument: 'FV/1', komunikat: 'Faktura FV/1 bez stawki.' });
const kpirRoku = (rok: number, braki: readonly number[]): Kpir => ({ rok, wiersze: [], braki: braki.map((m) => brakDokumentu(rok, m)), pominiete: [] });

type DaneEwidencji = 'pelne' | 'z brakiem' | 'stawka spoza' | 'bez odczytu';
type DaneKpir = 'pelne' | 'z brakiem' | 'poprzedni z brakiem' | 'bez poprzedniego' | 'bez odczytu';

interface Przypadek {
  miesiac: string;
  wersje: WersjaProfilu[];
  nieogloszone?: readonly string[];
  bezRoku?: readonly number[];
  ewidencja?: DaneEwidencji;
  kpir?: DaneKpir;
}

function wejscie(p: Przypadek): WejscieMiesiaca {
  const rok = Number(p.miesiac.slice(0, 4));
  const nr = Number(p.miesiac.slice(5, 7));
  const e = p.ewidencja ?? 'pelne';
  const wiersze = Array.from({ length: nr }, (_, i) => wiersz(`${rok}-${mm(i + 1)}-10`, 1_000_000, 1200, i));
  if (e === 'stawka spoza') wiersze.push(wiersz(`${rok}-01-12`, 50_000, 999, nr));
  const ewidencja: Ewidencja = { rok, wiersze, braki: e === 'z brakiem' ? [brakDokumentu(rok, nr)] : [], pominiete: [], ryczaltWRoku: true };
  const k = p.kpir ?? 'pelne';
  const kpir = {
    rok: kpirRoku(rok, k === 'z brakiem' ? [nr] : []),
    poprzedni: k === 'bez poprzedniego' ? null : kpirRoku(rok - 1, k === 'poprzedni z brakiem' ? [12] : []),
  };
  return {
    miesiac: p.miesiac,
    wersje: p.wersje,
    platnosci: [],
    parametry: parametryZ(p.nieogloszone ?? [], p.bezRoku ?? []),
    ...(e === 'bez odczytu' ? {} : { ewidencja }),
    ...(k === 'bez odczytu' ? {} : { kpir }),
  };
}

const MIESIACE = ['2026-01', '2026-05', '2027-01', '2027-05'];
const FORMY = ['ryczalt', 'skala', 'liniowy'] as const;
const EWIDENCJA: readonly DaneEwidencji[] = ['pelne', 'z brakiem', 'stawka spoza', 'bez odczytu'];
const KPIR: readonly DaneKpir[] = ['pelne', 'z brakiem', 'poprzedni z brakiem', 'bez poprzedniego', 'bez odczytu'];

/** Wszystkie przypadki przeglądu deterministycznego. */
function* przeglad(): Generator<Przypadek> {
  for (const miesiac of MIESIACE) {
    const rok = Number(miesiac.slice(0, 4));
    const nr = Number(miesiac.slice(5, 7));
    const pierwszy = `${miesiac}-01`;
    const srodek = `${miesiac}-15`;
    const po = `${rok}-${mm(nr + 1)}-02`;
    for (const forma of FORMY) {
      // A: każda liczba parametrów osobno nieogłoszona, przy każdym etapie ZUS (etap trwa od stycznia).
      for (const zusEtap of ETAPY_ZUS) {
        const wersje = [profil({ forma, zusEtap, zusOd: zusEtap === 'pelny' ? null : `${rok}-01-01`, validFrom: '2025-01-01' })];
        for (const klucz of [null, ...KLUCZE]) yield { miesiac, wersje, nieogloszone: klucz ? [klucz] : [] };
        // B: data etapu bez daty, dawno, od początku, w trakcie i po miesiącu.
        for (const zusOd of [null, '2020-01-01', pierwszy, srodek, po]) yield { miesiac, wersje: [profil({ forma, zusEtap, zusOd, validFrom: '2025-01-01' })] };
      }
      // C: ustawienia od dnia w trakcie miesiąca, zmiana składek w trakcie miesiąca, brak ustawień.
      const zwykle = profil({ forma, validFrom: '2025-01-01' });
      yield { miesiac, wersje: [profil({ forma, validFrom: srodek })] };
      yield { miesiac, wersje: [zwykle, profil({ ...zwykle, id: 'p2', validFrom: srodek, chorobowe: !zwykle.chorobowe })] };
      yield { miesiac, wersje: [profil({ forma, validFrom: po })] };
      // D: ewidencja i KPiR.
      for (const ewidencja of EWIDENCJA) for (const kpir of KPIR) yield { miesiac, wersje: [zwykle], ewidencja, kpir };
      // E: brak roku parametrów (i roku składkowego zdrowotnej w styczniu).
      for (const bezRoku of [[rok], [rok - 1]]) yield { miesiac, wersje: [zwykle], bezRoku };
    }
  }
}

describe('NZ-TRESC-04: braki z nazwą braku i tym, co z nim będzie, bez trybu rozkazującego', () => {
  it('sprawdzenie działa na przykładach (żeby test nie był pusty)', () => {
    expect(bledyKomunikatu('Brak części parametrów ZUS, więc składek za maj 2026 nie liczymy.', 'zus_spoleczne')).toEqual([]);
    expect(bledyKomunikatu('Etap „Ulga na start” potrzebuje daty początku. Etap ZUS i jego datę zmienia się w ustawieniach.', 'zus_spoleczne')).not.toEqual([]);
    expect(bledyKomunikatu('Brak części parametrów ZUS, więc ryczałtu nie liczymy.', 'zus_spoleczne')).not.toEqual([]);
    expect(bledyKomunikatu('Tak wyszło. Ustawienia są w zakładce „Ustawienia podatkowe”.', null)).not.toEqual([]);
    expect(bledyKomunikatu('Uzupełnij stawki na 2028 r., więc tej kwoty nie liczymy.', 'ryczalt')).not.toEqual([]);
    expect(bledyKomunikatu('Stawki ryczałtu nie ma w parametrach — więc ryczałtu nie liczymy.', 'ryczalt')).not.toEqual([]);
    expect(pierwszeZdanie('Etap „Ulga na start” trwał do 30.06.2026, a rozliczany miesiąc to lipiec 2026. Etap ZUS i jego datę…')).toBe(
      'Etap „Ulga na start” trwał do 30.06.2026, a rozliczany miesiąc to lipiec 2026',
    );
  });

  it('przegląd silnika „Ten miesiąc”: każda ścieżka braku pozycji i miesiąca', () => {
    const bledy = new Set<string>();
    const zBrakiem = new Set<string>();
    let przypadki = 0;
    for (const p of przeglad()) {
      przypadki++;
      const w = tenMiesiac(wejscie(p));
      if (!w.ok) zBrakiem.add('miesiąc');
      else for (const poz of w.wynik.pozycje) if (!poz.ok) zBrakiem.add(poz.rodzaj);
      for (const b of bledyWyniku(w)) bledy.add(`${p.miesiac}: ${b}`);
    }
    expect([...bledy]).toEqual([]);
    // Przegląd dociera do braku każdej pozycji (bez VAT, który przychodzi z warstwy danych) i braku miesiąca.
    expect([...zBrakiem].sort()).toEqual(['miesiąc', 'pit', 'ryczalt', 'zdrowotna', 'zus_spoleczne']);
    expect(przypadki).toBeGreaterThan(2_000);
  });

  it('losowe ustawienia, parametry, ewidencja i KPiR', () => {
    const okres = fc.record({
      rok: fc.oneof({ weight: 9, arbitrary: fc.constantFrom(2026, 2027) }, { weight: 1, arbitrary: fc.constant(2028) }),
      nr: fc.oneof(fc.constant(1), fc.integer({ min: 1, max: 12 })),
    });
    const scenariusz = okres.chain(({ rok, nr }) => {
      const od = `${rok}-${mm(nr)}-01`;
      const koniec = ostatniDzien(rok, nr);
      return fc.record({
        miesiac: fc.constant(`${rok}-${mm(nr)}`),
        forma: fc.constantFrom(...FORMY),
        zusEtap: fc.constantFrom(...ETAPY_ZUS),
        zusOd: fc.oneof(fc.constant(null), dzienMiedzy('2024-01-01', '2029-12-31'), dzienMiedzy(od, koniec)),
        chorobowe: fc.boolean(),
        validFrom: fc.oneof(fc.constant('2025-01-01'), dzienMiedzy(od, koniec), dzienMiedzy(koniec, `${rok + 1}-12-31`)),
        zmiana: fc.option(fc.record({ dzien: dzienMiedzy(od, koniec), zusEtap: fc.constantFrom(...ETAPY_ZUS) })),
        nieogloszone: fc.uniqueArray(fc.constantFrom(...KLUCZE), { maxLength: 3 }),
        ewidencja: fc.constantFrom(...EWIDENCJA),
        kpir: fc.constantFrom(...KPIR),
        stawka: stawkaRyczaltu,
      });
    });
    fc.assert(
      fc.property(scenariusz, (s) => {
        const glowna = profil({ forma: s.forma, zusEtap: s.zusEtap, zusOd: s.zusOd, chorobowe: s.chorobowe, validFrom: s.validFrom, stawkaDomyslna: s.stawka });
        const wersje = s.zmiana ? [glowna, profil({ ...glowna, id: 'p2', validFrom: s.zmiana.dzien, zusEtap: s.zmiana.zusEtap })] : [glowna];
        expect(bledyWyniku(tenMiesiac(wejscie({ miesiac: s.miesiac, wersje, nieogloszone: s.nieogloszone, ewidencja: s.ewidencja, kpir: s.kpir })))).toEqual([]);
      }),
      opcje(),
    );
  });

  it('braki parametrów (D7): każdy rok 2025-2030 i każda sekcja', () => {
    const bledy: string[] = [];
    for (let rok = 2025; rok <= 2030; rok++) {
      for (const b of brakujace(rok, SEKCJE)) bledy.push(...bledyKomunikatu(b.komunikat, 'ryczalt').filter((x) => !x.startsWith('skutek nie o pozycji')));
    }
    expect(bledy).toEqual([]);
  });
});

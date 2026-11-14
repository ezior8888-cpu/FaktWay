import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { Ewidencja, WierszEwidencji } from '@/lib/ksiegowosc/ewidencja';
import type { Kpir } from '@/lib/ksiegowosc/kpir';
import { brakujace, parametryRoku } from '@/lib/ksiegowosc/parametry';
import type { NazwaSekcji, ParametryRoku } from '@/lib/ksiegowosc/parametry/typy';
import { ETAPY_ZUS, type WersjaProfilu } from '@/lib/ksiegowosc/profil';
import { tenMiesiac, type TenMiesiac } from '@/lib/ksiegowosc/ten-miesiac';

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
 *   musi więc sam powiedzieć, czego brakuje i co z kwotą będzie;
 * - brak całego miesiąca: lista pod tytułem „Kwot za {miesiąc} nie liczymy”,
 *   więc komunikat musi powiedzieć, czego brakuje;
 * - braki parametrów (`brakujace`, D7): komunikat przy kwocie, której nie ma.
 *
 * Losujemy ustawienia (forma, etap ZUS z datą przed, w trakcie i po
 * miesiącu, zmiana w trakcie miesiąca), parametry z nieogłoszonymi liczbami
 * albo bez roku, ewidencję i KPiR z brakami, stawką spoza parametrów albo
 * bez odczytu. Braki VAT, KPiR roku poprzedniego i dokumentów ewidencji
 * powstają w warstwie danych (`*-dane.ts`) i mają osobny test.
 */

// Lista robocza z NZ-TRESC-01 (pytanie 1 do prawnika), jak w teście tekstów przypomnień.
const ZAKAZANE = /(?<![\p{L}])(?:zapłać\p{L}*|musisz|musicie|powinieneś|powinnaś|powinniście|należy|zalecamy|radzimy|wybierz\p{L}*|opłaca się|lepiej|najkorzystniej\p{L}*|oszczędzisz|zaoszczędzisz)(?![\p{L}])/iu;
const DLUGIE_MYSLNIKI = /[—–]/;
/** Nazwa braku: czego brakuje albo co się nie zgadza (dane, ustawienia, parametry, księgi). */
const NAZWA = /parametr|stawk|ustawie|etap|dat[aęy]|ewidencj|KPiR|kwot[ay]|limit|prog|próg|deklaracj|nadwyżk/iu;
/** Co z kwotą będzie: nie liczymy jej albo rozlicza ją kto inny. */
const SKUTEK = /nie liczymy|nie liczy|nie pokazujemy|nie ustalimy|rozlicza księgowa|u księgowej/iu;

function bledyKomunikatu(tekst: string, { skutek }: { skutek: boolean }): string[] {
  const bledy: string[] = [];
  const slowo = ZAKAZANE.exec(tekst);
  if (slowo) bledy.push(`słowo „${slowo[0]}”`);
  if (DLUGIE_MYSLNIKI.test(tekst)) bledy.push('długi myślnik');
  if (!NAZWA.test(tekst)) bledy.push('bez nazwy braku');
  if (skutek && !SKUTEK.test(tekst)) bledy.push('bez tego, co z kwotą będzie');
  return bledy.map((b) => `${b}: ${tekst}`);
}

/** Braki z wyniku silnika: pozycje mówią skutek same, braki miesiąca mają go w tytule. */
function bledyWyniku(w: TenMiesiac): string[] {
  if (!w.ok) return w.braki.flatMap((b) => bledyKomunikatu(b, { skutek: false }));
  return w.wynik.pozycje.flatMap((p) => (p.ok ? [] : bledyKomunikatu(p.brak, { skutek: true })));
}

const DZIEN_MS = 86_400_000;
const dzienMiedzy = (od: string, doDnia: string) =>
  fc.integer({ min: Date.parse(`${od}T00:00:00Z`) / DZIEN_MS, max: Date.parse(`${doDnia}T00:00:00Z`) / DZIEN_MS }).map((d) => new Date(d * DZIEN_MS).toISOString().slice(0, 10));

const ostatniDzien = (rok: number, nr: number) => new Date(Date.UTC(rok, nr, 0)).toISOString().slice(0, 10);
const mm = (nr: number) => String(nr).padStart(2, '0');

// Wszystkie liczby parametrów jako „sekcja.klucz”, żeby losować nieogłoszone.
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

const scenariusz = fc
  .record({
    rok: fc.constantFrom(2026, 2027, 2028),
    nr: fc.oneof(fc.constant(1), fc.integer({ min: 1, max: 12 })),
  })
  .chain(({ rok, nr }) => {
    const od = `${rok}-${mm(nr)}-01`;
    const koniec = ostatniDzien(rok, nr);
    return fc.record({
      rok: fc.constant(rok),
      nr: fc.constant(nr),
      forma: fc.constantFrom('ryczalt' as const, 'skala' as const, 'liniowy' as const),
      zusEtap: fc.constantFrom(...ETAPY_ZUS),
      zusOd: fc.oneof(fc.constant(null), dzienMiedzy('2024-01-01', '2029-12-31'), dzienMiedzy(od, koniec)),
      chorobowe: fc.boolean(),
      // Od początku roku, od dnia w trakcie miesiąca albo dopiero po nim (brak ustawień).
      validFrom: fc.oneof(fc.constant('2025-01-01'), dzienMiedzy(od, koniec), dzienMiedzy(koniec, `${rok + 1}-12-31`)),
      zmiana: fc.option(fc.record({ dzien: dzienMiedzy(od, koniec), zusEtap: fc.constantFrom(...ETAPY_ZUS), chorobowe: fc.boolean() })),
      nieogloszone: fc.uniqueArray(fc.constantFrom(...KLUCZE), { maxLength: 3 }),
      bezRoku: fc.uniqueArray(fc.constantFrom(rok - 1, rok), { maxLength: 1 }),
      wiersze: fc.array(
        fc.record({ m: fc.integer({ min: 1, max: nr }), gr: fc.integer({ min: -500_000, max: 5_000_000 }), pb: fc.oneof(stawkaRyczaltu, fc.constant(999)) }),
        { maxLength: 6 },
      ),
      brakiEwidencji: fc.uniqueArray(fc.integer({ min: 1, max: nr }), { maxLength: 2 }),
      odczytEwidencji: fc.boolean(),
      brakiKpir: fc.uniqueArray(fc.integer({ min: 1, max: nr }), { maxLength: 2 }),
      kpirPoprzedni: fc.constantFrom('jest' as const, 'brak' as const, 'z brakiem' as const),
      odczytKpir: fc.boolean(),
    });
  });

describe('NZ-TRESC-04: braki z nazwą braku i tym, co z nim będzie, bez trybu rozkazującego', () => {
  it('sprawdzenie działa na przykładach (żeby test nie był pusty)', () => {
    expect(bledyKomunikatu('Brak parametrów ZUS, więc składek nie liczymy.', { skutek: true })).toEqual([]);
    expect(bledyKomunikatu('Etap „ulga na start” potrzebuje daty początku. Datę zmienia się w ustawieniach.', { skutek: true })).not.toEqual([]);
    expect(bledyKomunikatu('Brak miesiąca do policzenia.', { skutek: false })).not.toEqual([]);
    expect(bledyKomunikatu('Uzupełnij stawki, bo lepiej mieć ryczałt.', { skutek: false })).not.toEqual([]);
    expect(bledyKomunikatu('Stawki ryczałtu nie ma w parametrach — więc ryczałtu nie liczymy.', { skutek: true })).not.toEqual([]);
  });

  it('silnik „Ten miesiąc”: losowe ustawienia, parametry, ewidencja i KPiR', () => {
    fc.assert(
      fc.property(scenariusz, (s) => {
        const miesiac = `${s.rok}-${mm(s.nr)}`;
        const glowna: WersjaProfilu = profil({ forma: s.forma, zusEtap: s.zusEtap, zusOd: s.zusOd, chorobowe: s.chorobowe, validFrom: s.validFrom });
        const wersje = s.zmiana ? [glowna, profil({ ...glowna, id: 'p2', validFrom: s.zmiana.dzien, zusEtap: s.zmiana.zusEtap, chorobowe: s.zmiana.chorobowe })] : [glowna];
        const ewidencja: Ewidencja = {
          rok: s.rok,
          wiersze: s.wiersze.map((w, i) => wiersz(`${s.rok}-${mm(w.m)}-10`, w.gr, w.pb, i)),
          braki: s.brakiEwidencji.map((m) => brakDokumentu(s.rok, m)),
          pominiete: [],
          ryczaltWRoku: true,
        };
        const kpirRoku = (rok: number, braki: number[]): Kpir => ({ rok, wiersze: [], braki: braki.map((m) => brakDokumentu(rok, m)), pominiete: [] });
        const kpir = {
          rok: kpirRoku(s.rok, s.brakiKpir),
          poprzedni: s.kpirPoprzedni === 'brak' ? null : kpirRoku(s.rok - 1, s.kpirPoprzedni === 'z brakiem' ? [12] : []),
        };
        const wynik = tenMiesiac({
          miesiac,
          wersje,
          platnosci: [],
          parametry: parametryZ(s.nieogloszone, s.bezRoku),
          ...(s.odczytEwidencji ? { ewidencja } : {}),
          ...(s.odczytKpir ? { kpir } : {}),
        });
        expect(bledyWyniku(wynik)).toEqual([]);
      }),
      opcje(),
    );
  });

  it('braki parametrów (D7): każdy rok 2025-2030 i każda sekcja', () => {
    const bledy: string[] = [];
    for (let rok = 2025; rok <= 2030; rok++) {
      for (const b of brakujace(rok, SEKCJE)) bledy.push(...bledyKomunikatu(b.komunikat, { skutek: true }));
    }
    expect(bledy).toEqual([]);
  });
});

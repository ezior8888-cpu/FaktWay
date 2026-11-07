/**
 * „Ten miesiąc” przy ryczałcie (plan księgowości JDG, K4; sekcje 4, 7 i 8):
 * składki społeczne, składka zdrowotna i ryczałt za miesiąc, z terminami.
 * Funkcja czysta: dane czyta `ten-miesiac-dane.ts`, a tam `brakujace()`
 * sprawdza, czy księgowa potwierdziła parametry (D7).
 *
 * - Ryczałt miesiąca zależy od wcześniejszych miesięcy roku (przeniesienie
 *   odliczeń), więc liczy się od stycznia.
 * - Od przychodu odlicza się składki ZAPŁACONE w miesiącu, czyli oznaczone
 *   w rozliczeniach przyciskiem „Zapłacone” z datą. Przy kolejnej wersji
 *   rozliczenia liczy się tylko dopłata (przyrost między zapłaconymi wersjami).
 * - Próg zdrowotnej: przychód od początku roku pomniejszony o zapłacone
 *   składki społeczne bez FP (sekcja 5, pewność średnia).
 * - Skala i liniowy: K7.
 */

import { sumyOkresu, wierszeOkresu, type Ewidencja } from '@/lib/ksiegowosc/ewidencja';
import { terminDla, type Termin } from '@/lib/ksiegowosc/kalendarz';
import { rokSkladkowyZdrowotnej, type ParametryRoku } from '@/lib/ksiegowosc/parametry';
import { wersjaNa, type WersjaProfilu } from '@/lib/ksiegowosc/profil';
import { ryczaltMiesiaca, type RyczaltMiesiaca } from '@/lib/ksiegowosc/ryczalt';
import { zdrowotnaRyczaltu, type ZdrowotnaRyczaltu } from '@/lib/ksiegowosc/zdrowotna';
import { granice, skladkiSpoleczne, type SkladkiSpoleczne } from '@/lib/ksiegowosc/zus';

export const RODZAJE_ROZLICZEN = ['ryczalt', 'zus_spoleczne', 'zdrowotna'] as const;
export type RodzajRozliczenia = (typeof RODZAJE_ROZLICZEN)[number];

export const NAZWY_ROZLICZEN: Readonly<Record<RodzajRozliczenia, string>> = {
  ryczalt: 'Ryczałt od przychodów ewidencjonowanych',
  zus_spoleczne: 'Składki społeczne',
  zdrowotna: 'Składka zdrowotna',
};

/** Zapłacona wersja rozliczenia (status `zaplacone`). */
export interface Platnosc {
  /** RRRR-MM: miesiąc, którego rozliczenie dotyczy. */
  miesiac: string;
  rodzaj: RodzajRozliczenia;
  wersja: number;
  kwotaGr: number;
  /** Przy składkach społecznych: część bez FP, którą odlicza się od przychodu. */
  spoleczneBezFpGr: number;
  /** RRRR-MM-DD */
  zaplaconeO: string;
}

export interface PozycjaDoZaplaty {
  rodzaj: RodzajRozliczenia;
  kwotaGr: number;
  termin: Termin | null;
  /** Wejścia do migawki i skrótu (D6): przy innych wejściach powstaje nowa wersja. */
  wejscia: Record<string, unknown>;
  /** Część bez FP (składki społeczne), do odliczeń w kolejnych miesiącach. */
  spoleczneBezFpGr?: number;
}

export interface WynikMiesiaca {
  miesiac: string;
  przychodGr: number;
  skladki: SkladkiSpoleczne;
  zdrowotna: ZdrowotnaRyczaltu;
  ryczalt: RyczaltMiesiaca;
  pozycje: PozycjaDoZaplaty[];
}

export type TenMiesiac = { ok: true; wynik: WynikMiesiaca } | { ok: false; braki: string[] };

export interface WejscieMiesiaca {
  /** RRRR-MM */
  miesiac: string;
  /** Ewidencja roku miesiąca (K3). */
  ewidencja: Ewidencja;
  wersje: readonly WersjaProfilu[];
  /** Zapłacone wersje rozliczeń, także za grudzień roku poprzedniego zapłacony w styczniu. */
  platnosci: readonly Platnosc[];
  parametry: (rok: number) => ParametryRoku | null;
}

const PROFIL = 'Ustawienia są w Księgowości, w zakładce „Ustawienia podatkowe”.';

/**
 * Dopłaty: przy kolejnej zapłaconej wersji tego samego rozliczenia liczy się
 * tylko przyrost (kwota tej wersji minus ostatnio zapłacona), w miesiącu
 * zapłaty. Ujemny przyrost (nadpłata) to zero.
 */
export function przyrostyZaplat(platnosci: readonly Platnosc[]) {
  const grupy = new Map<string, Platnosc[]>();
  for (const p of platnosci) {
    const klucz = `${p.miesiac}|${p.rodzaj}`;
    grupy.set(klucz, [...(grupy.get(klucz) ?? []), p]);
  }
  const wynik: { rodzaj: RodzajRozliczenia; miesiacZaplaty: string; kwotaGr: number; spoleczneBezFpGr: number }[] = [];
  for (const lista of grupy.values()) {
    let kwota = 0;
    let bezFp = 0;
    for (const p of [...lista].sort((a, b) => a.wersja - b.wersja)) {
      wynik.push({
        rodzaj: p.rodzaj,
        miesiacZaplaty: p.zaplaconeO.slice(0, 7),
        kwotaGr: Math.max(0, p.kwotaGr - kwota),
        spoleczneBezFpGr: Math.max(0, p.spoleczneBezFpGr - bezFp),
      });
      kwota = Math.max(kwota, p.kwotaGr);
      bezFp = Math.max(bezFp, p.spoleczneBezFpGr);
    }
  }
  return wynik;
}

const miesiacNr = (rok: number, m: number) => `${rok}-${String(m).padStart(2, '0')}`;

export function tenMiesiac(w: WejscieMiesiaca): TenMiesiac {
  const rok = Number(w.miesiac.slice(0, 4));
  const nr = Number(w.miesiac.slice(5, 7));
  const { od, do: koniec } = granice(w.miesiac);
  const braki: string[] = [];

  const wersja = wersjaNa(w.wersje, od);
  if (!wersja) return { ok: false, braki: [`Na ${w.miesiac} nie ma ustawień podatkowych, więc nic nie liczymy. ${PROFIL}`] };
  if (wersja.forma !== 'ryczalt') {
    return { ok: false, braki: ['Rozliczenie skali podatkowej i podatku liniowego dojdzie w kolejnej wersji modułu.'] };
  }
  const zmianaWTrakcie = w.wersje.find(
    (v) =>
      v.validFrom > od &&
      v.validFrom <= koniec &&
      (v.zusEtap !== wersja.zusEtap || v.zusOd !== wersja.zusOd || v.chorobowe !== wersja.chorobowe),
  );
  if (zmianaWTrakcie) {
    braki.push(`Ustawienia składek ZUS zmieniają się w trakcie miesiąca (${zmianaWTrakcie.validFrom}); taki miesiąc rozlicza księgowa. ${PROFIL}`);
  }

  const brakiEwidencji = w.ewidencja.braki.filter((b) => b.dzien.slice(0, 7) <= w.miesiac);
  if (brakiEwidencji.length > 0) {
    const miesiace = [...new Set(brakiEwidencji.map((b) => b.dzien.slice(0, 7)))].join(', ');
    braki.push(`Ewidencja przychodów ma braki w miesiącach: ${miesiace}. Dopóki są, ryczałtu i progu zdrowotnej nie liczymy; lista jest w zakładce „Ewidencja”.`);
  }

  const p = w.parametry(rok);
  const rokSkladkowy = rokSkladkowyZdrowotnej(w.miesiac);
  const zdrowotnaRoku = w.parametry(rokSkladkowy);
  if (!p) braki.push(`Brak parametrów na ${rok} r., więc nic nie liczymy.`);
  if (!zdrowotnaRoku) {
    braki.push(
      `Brak parametrów składki zdrowotnej na rok składkowy od lutego ${rokSkladkowy} r. do stycznia ${rokSkladkowy + 1} r., więc nic nie liczymy.`,
    );
  }
  if (braki.length > 0 || !p || !zdrowotnaRoku) return { ok: false, braki };

  const zus = skladkiSpoleczne(w.miesiac, wersja, p.zus.liczby);
  if (!zus.ok) return { ok: false, braki: [zus.brak] };

  // Ryczałt od stycznia: przeniesienie odliczeń zależy od wcześniejszych miesięcy.
  const przyrosty = przyrostyZaplat(w.platnosci);
  const zaplaconeW = (miesiac: string, rodzaj: RodzajRozliczenia, pole: 'kwotaGr' | 'spoleczneBezFpGr') =>
    przyrosty.filter((z) => z.rodzaj === rodzaj && z.miesiacZaplaty === miesiac).reduce((s, z) => s + z[pole], 0);
  let nadwyzka = 0;
  let ryczalt: RyczaltMiesiaca | null = null;
  const lancuch: Record<string, unknown>[] = [];
  for (let m = 1; m <= nr; m++) {
    const miesiac = miesiacNr(rok, m);
    const g = granice(miesiac);
    const przychody = sumyOkresu(wierszeOkresu(w.ewidencja, g.od, g.do)).stawki;
    const wejscie = {
      przychodWgStawekGr: przychody,
      spoleczneZaplaconeGr: zaplaconeW(miesiac, 'zus_spoleczne', 'spoleczneBezFpGr'),
      zdrowotnaZaplaconaGr: zaplaconeW(miesiac, 'zdrowotna', 'kwotaGr'),
      nadwyzkaZPoprzednichGr: nadwyzka,
    };
    const r = ryczaltMiesiaca(wejscie, p.ryczalt.liczby);
    if (!r.ok) return { ok: false, braki: [`${miesiac}: ${r.brak}`] };
    nadwyzka = r.ryczalt.odliczenia.nadwyzkaNaKolejneGr;
    ryczalt = r.ryczalt;
    lancuch.push({
      miesiac,
      przychod: Object.fromEntries(przychody),
      spoleczne: wejscie.spoleczneZaplaconeGr,
      zdrowotna: wejscie.zdrowotnaZaplaconaGr,
    });
  }
  if (!ryczalt) return { ok: false, braki: ['Brak miesiąca do policzenia.'] };

  const przychodNarastajacoGr = w.ewidencja.wiersze
    .filter((x) => x.dataPrzychodu >= `${rok}-01-01` && x.dataPrzychodu <= koniec)
    .reduce((s, x) => s + x.kwotaGr, 0);
  const spoleczneNarastajacoGr = przyrosty
    .filter((z) => z.rodzaj === 'zus_spoleczne' && z.miesiacZaplaty >= `${rok}-01` && z.miesiacZaplaty <= w.miesiac)
    .reduce((s, z) => s + z.spoleczneBezFpGr, 0);
  const zdrowotna = zdrowotnaRyczaltu(przychodNarastajacoGr - spoleczneNarastajacoGr, zdrowotnaRoku.zdrowotna.liczby);
  if (!zdrowotna.ok) return { ok: false, braki: [zdrowotna.brak] };

  const przychodGr = [...ryczalt.przychodWgStawekGr.values()].reduce((a, b) => a + b, 0);
  const termin = (rodzaj: 'ryczalt' | 'zus') => terminDla({ rodzaj, rok, miesiac: nr });

  return {
    ok: true,
    wynik: {
      miesiac: w.miesiac,
      przychodGr,
      skladki: zus.skladki,
      zdrowotna: zdrowotna.zdrowotna,
      ryczalt,
      pozycje: [
        {
          rodzaj: 'ryczalt',
          kwotaGr: ryczalt.ryczaltGr,
          termin: termin('ryczalt'),
          wejscia: { lancuch, profil: { id: wersja.id, stawkaDomyslna: wersja.stawkaDomyslna, najem: wersja.najem } },
        },
        {
          rodzaj: 'zus_spoleczne',
          kwotaGr: zus.skladki.razemGr + zus.skladki.funduszPracyGr,
          spoleczneBezFpGr: zus.skladki.razemGr,
          termin: termin('zus'),
          wejscia: { etap: wersja.zusEtap, od: wersja.zusOd, chorobowe: wersja.chorobowe, skladki: zus.skladki },
        },
        {
          rodzaj: 'zdrowotna',
          kwotaGr: zdrowotna.zdrowotna.skladkaGr,
          termin: termin('zus'),
          wejscia: { przychodNarastajacoGr, spoleczneNarastajacoGr, prog: zdrowotna.zdrowotna.prog },
        },
      ],
    },
  };
}

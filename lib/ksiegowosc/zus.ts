/**
 * Składki społeczne JDG za miesiąc (plan księgowości JDG, K4; sekcja 5).
 * Funkcja czysta: parametry podaje wołający (`parametryRoku(rok).zus`), więc
 * testy i złote przypadki liczą na sprawdzonej kopii, a produkcja dopiero po
 * `brakujace()` (D7).
 *
 * Etapy z profilu (K2):
 * - ulga na start: 6 miesięcy od daty z profilu bez składek społecznych;
 * - preferencyjne: podstawa 30 % płacy minimalnej przez 24 miesiące, bez FP;
 * - pełne: podstawa 60 % prognozowanego przeciętnego wynagrodzenia, z FP;
 * - etat obok: zbieg tytułów, bez składek społecznych.
 *
 * Każda składka jest zaokrąglona do grosza (sekcja 4, pkt 6). Miesiąc, w którym
 * etap zaczyna się albo kończy w trakcie, ZUS liczy od podstawy proporcjonalnej
 * do dni; tego jeszcze nie liczymy, więc to brak z wyjściem, a nie zgadywanie.
 */

import { monthLabel, monthRange } from '@/lib/expenses/month';
import { formatIsoDatePl } from '@/lib/format/iso-date';
import type { KluczZus, Liczba } from '@/lib/ksiegowosc/parametry';
import { NAZWY_ETAPOW_ZUS, type WersjaProfilu } from '@/lib/ksiegowosc/profil';

export interface SkladkiSpoleczne {
  podstawaGr: number;
  emerytalnaGr: number;
  rentoweGr: number;
  chorobowaGr: number;
  wypadkowaGr: number;
  /** Emerytalna, rentowe, chorobowa i wypadkowa: tylko te odlicza się od przychodu. */
  razemGr: number;
  /** Fundusz Pracy i Fundusz Solidarnościowy: w tym samym przelewie, ale bez odliczenia. */
  funduszPracyGr: number;
}

export type WynikZus = { ok: true; skladki: SkladkiSpoleczne } | { ok: false; brak: string };

export type LiczbyZus = { readonly [P in KluczZus]: Liczba };

const ZERO: SkladkiSpoleczne = {
  podstawaGr: 0,
  emerytalnaGr: 0,
  rentoweGr: 0,
  chorobowaGr: 0,
  wypadkowaGr: 0,
  razemGr: 0,
  funduszPracyGr: 0,
};

const USTAWIENIA = 'Etap ZUS i jego datę zmienia się w Księgowości, w zakładce „Ustawienia podatkowe”.';
export const PROPORCJA =
  'ZUS liczy wtedy składki od podstawy proporcjonalnej do dni, a tego program jeszcze nie liczy. ' +
  'Kwota za ten miesiąc jest w PUE ZUS albo u księgowej.';

/** Grosze × punkty bazowe, zaokrąglone do grosza (połówka w górę). */
export function procentGr(gr: number, pb: number): number {
  return Math.floor((gr * pb + 5_000) / 10_000);
}

/** Ten sam dzień `n` miesięcy później (koniec miesiąca, gdy dnia brak), RRRR-MM-DD. */
export function dodajMiesiace(dzien: string, n: number): string {
  const [r, m, d] = dzien.split('-').map(Number);
  const ostatni = new Date(Date.UTC(r, m - 1 + n + 1, 0)).getUTCDate();
  return new Date(Date.UTC(r, m - 1 + n, Math.min(d, ostatni))).toISOString().slice(0, 10);
}

function wartosc(liczby: LiczbyZus, klucz: KluczZus): number | null {
  return liczby[klucz]?.wartosc ?? null;
}

/**
 * Okres etapu [od, do) wobec miesiąca: cały w środku, poza nim albo na
 * granicy (miesiąc niepełny).
 */
function wobecMiesiaca(miesiac: string, od: string, doWylacznie: string | null): 'w' | 'przed' | 'po' | 'czesc' {
  const { from: pierwszy, to: ostatni } = monthRange(miesiac);
  if (ostatni < od) return 'przed';
  if (doWylacznie !== null && pierwszy >= doWylacznie) return 'po';
  const caly = pierwszy >= od && (doWylacznie === null || ostatni < doWylacznie);
  return caly ? 'w' : 'czesc';
}

export function skladkiSpoleczne(miesiac: string, wersja: WersjaProfilu, liczby: LiczbyZus): WynikZus {
  const etap = NAZWY_ETAPOW_ZUS[wersja.zusEtap];
  const nazwaMiesiaca = monthLabel(miesiac);

  if (wersja.zusEtap === 'etat_obok') return { ok: true, skladki: ZERO };

  const miesiecy =
    wersja.zusEtap === 'ulga_na_start'
      ? wartosc(liczby, 'ulgaNaStartMiesiecy')
      : wersja.zusEtap === 'preferencyjny'
        ? wartosc(liczby, 'preferencyjnyMiesiecy')
        : null;
  if (wersja.zusEtap !== 'pelny' && miesiecy === null) {
    return { ok: false, brak: `Brak długości etapu „${etap}” w parametrach, więc składek za ${nazwaMiesiaca} nie liczymy.` };
  }

  if (wersja.zusOd !== null) {
    const koniec = miesiecy === null ? null : dodajMiesiace(wersja.zusOd, miesiecy);
    const polozenie = wobecMiesiaca(miesiac, wersja.zusOd, koniec);
    if (polozenie === 'przed') {
      return {
        ok: false,
        brak: `Etap „${etap}” zaczyna się ${formatIsoDatePl(wersja.zusOd)}, a rozliczany miesiąc to ${nazwaMiesiaca}, więc składek za ten miesiąc nie liczymy. ${USTAWIENIA}`,
      };
    }
    if (polozenie === 'po') {
      const ostatniDzien = new Date(Date.parse(`${koniec}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
      return {
        ok: false,
        brak: `Etap „${etap}” trwał do ${formatIsoDatePl(ostatniDzien)}, a rozliczany miesiąc to ${nazwaMiesiaca}, więc składek za ten miesiąc nie liczymy. ${USTAWIENIA}`,
      };
    }
    // Ulga zaczęta w trakcie miesiąca to wciąż zero: przed startem nie było
    // działalności. Brakiem jest miesiąc, w którym etap się kończy (miesza się z kolejnym).
    const { from: pierwszy, to: ostatni } = monthRange(miesiac);
    const startUlgi = wersja.zusEtap === 'ulga_na_start' && pierwszy < wersja.zusOd && (koniec === null || ostatni < koniec);
    if (polozenie === 'czesc' && !startUlgi) {
      return { ok: false, brak: `Etap „${etap}” zaczyna się albo kończy w trakcie miesiąca (${nazwaMiesiaca}). ${PROPORCJA}` };
    }
  } else if (wersja.zusEtap !== 'pelny') {
    return { ok: false, brak: `Etap „${etap}” potrzebuje daty początku, więc składek za ${nazwaMiesiaca} nie liczymy. ${USTAWIENIA}` };
  }

  if (wersja.zusEtap === 'ulga_na_start') return { ok: true, skladki: ZERO };

  const kwotaBazowa =
    wersja.zusEtap === 'preferencyjny' ? wartosc(liczby, 'placaMinimalna') : wartosc(liczby, 'prognozowanePrzecietneWynagrodzenie');
  const procentPodstawy =
    wersja.zusEtap === 'preferencyjny' ? wartosc(liczby, 'podstawaPreferencyjnaProc') : wartosc(liczby, 'podstawaPelnaProc');
  const kwiecienLubPozniej = Number(miesiac.slice(5, 7)) >= 4;
  const stopy = {
    emerytalna: wartosc(liczby, 'stopaEmerytalna'),
    rentowa: wartosc(liczby, 'stopaRentowa'),
    chorobowa: wartosc(liczby, 'stopaChorobowa'),
    wypadkowa: wartosc(liczby, kwiecienLubPozniej ? 'stopaWypadkowaOdKwietnia' : 'stopaWypadkowaDoMarca'),
    fp: wartosc(liczby, 'stopaFunduszPracy'),
  };
  if (kwotaBazowa === null || procentPodstawy === null || Object.values(stopy).some((s) => s === null)) {
    return { ok: false, brak: `Brak części parametrów ZUS, więc składek za ${nazwaMiesiaca} nie liczymy.` };
  }

  const podstawaGr = procentGr(kwotaBazowa, procentPodstawy);
  const emerytalnaGr = procentGr(podstawaGr, stopy.emerytalna as number);
  const rentoweGr = procentGr(podstawaGr, stopy.rentowa as number);
  const chorobowaGr = wersja.chorobowe ? procentGr(podstawaGr, stopy.chorobowa as number) : 0;
  const wypadkowaGr = procentGr(podstawaGr, stopy.wypadkowa as number);
  // FP płaci się od podstawy co najmniej równej płacy minimalnej: przy pełnych tak, przy preferencyjnych nie.
  const funduszPracyGr = wersja.zusEtap === 'pelny' ? procentGr(podstawaGr, stopy.fp as number) : 0;

  return {
    ok: true,
    skladki: {
      podstawaGr,
      emerytalnaGr,
      rentoweGr,
      chorobowaGr,
      wypadkowaGr,
      razemGr: emerytalnaGr + rentoweGr + chorobowaGr + wypadkowaGr,
      funduszPracyGr,
    },
  };
}

/**
 * Zaliczki na PIT przy skali i podatku liniowym (plan księgowości JDG, K7;
 * sekcje 4, 5 i 7). Funkcja czysta: miesiące roku z KPiR i zapłatami podaje
 * wołający, parametry roku też.
 *
 * Metoda narastająca od 1 stycznia:
 * - dochód = przychód − koszty z KPiR;
 * - od dochodu odlicza się składki społeczne bez FP ZAPŁACONE w roku (nie są
 *   kosztem), a przy liniowym także zapłaconą składkę zdrowotną do limitu
 *   rocznego (art. 30c); odliczenie nie robi z dochodu straty;
 * - podstawa w pełnych złotych (art. 63 Ordynacji: od 50 gr w górę);
 * - skala: 12 % do progu minus kwota zmniejszająca, ponad progiem kwota
 *   z progu i 32 % nadwyżki; liniowy: 19 %;
 * - zaliczka = podatek narastająco minus zaliczki za wcześniejsze miesiące,
 *   w pełnych złotych, nie mniej niż zero (nadpłaty nie zwraca się w trakcie roku).
 *
 * Sposób zaokrąglania podatku narastająco (do grosza, a do złotych dopiero
 * zaliczka) ma pewność średnią: księgowa potwierdza go w G8-G11.
 */

import type { Liczba } from '@/lib/ksiegowosc/parametry';

export type FormaPit = 'skala' | 'liniowy';

export interface MiesiacPit {
  /** RRRR-MM */
  miesiac: string;
  przychodGr: number;
  kosztyGr: number;
  /** Składki społeczne bez FP zapłacone w tym miesiącu. */
  spoleczneZaplaconeGr: number;
  /** Składka zdrowotna zapłacona w tym miesiącu (odlicza tylko liniowy). */
  zdrowotnaZaplaconaGr: number;
}

export interface ZaliczkaMiesiaca {
  miesiac: string;
  przychodNarastajacoGr: number;
  kosztyNarastajacoGr: number;
  /** Może być ujemny (strata). */
  dochodNarastajacoGr: number;
  spoleczneNarastajacoGr: number;
  /** Tylko liniowy; przy skali zero. */
  zdrowotnaNarastajacoGr: number;
  /** Pełne złote w groszach. */
  podstawaNarastajacoGr: number;
  podatekNarastajacoGr: number;
  /** Pełne złote w groszach. */
  zaliczkaGr: number;
}

export type LiczbySkali = { readonly [P in 'stawkaDoProgu' | 'stawkaPonadProg' | 'prog' | 'kwotaZmniejszajaca']: Liczba };
export type LiczbyLiniowego = { readonly [P in 'stawka' | 'limitOdliczeniaZdrowotnej']: Liczba };

export type WynikZaliczek = { ok: true; miesiace: ZaliczkaMiesiaca[] } | { ok: false; brak: string };

/** Grosze do pełnych złotych (art. 63 § 1 Ordynacji podatkowej): od 50 gr w górę. */
export function doZlotych(gr: number): number {
  const znak = gr < 0 ? -1 : 1;
  return znak * Math.floor((Math.abs(gr) + 50) / 100) * 100;
}

/** Iloczyn kwoty w groszach i stawki w punktach bazowych, do grosza (połówka od zera). */
export function procent(gr: number, pb: number): number {
  const znak = gr < 0 ? -1 : 1;
  return znak * Math.floor((Math.abs(gr) * pb + 5_000) / 10_000);
}

function podatekSkali(podstawaGr: number, l: { stawkaDoProgu: number; stawkaPonadProg: number; prog: number; kwotaZmniejszajaca: number }): number {
  if (podstawaGr <= l.prog) return Math.max(0, procent(podstawaGr, l.stawkaDoProgu) - l.kwotaZmniejszajaca);
  return procent(l.prog, l.stawkaDoProgu) - l.kwotaZmniejszajaca + procent(podstawaGr - l.prog, l.stawkaPonadProg);
}

/**
 * Zaliczki za kolejne miesiące roku. `miesiace` to styczeń i dalej, bez
 * przerw, do miesiąca liczonego włącznie.
 */
export function zaliczkiPit(
  forma: FormaPit,
  miesiace: readonly MiesiacPit[],
  liczby: { skala: LiczbySkali; liniowy: LiczbyLiniowego },
): WynikZaliczek {
  const rok = miesiace[0]?.miesiac.slice(0, 4) ?? '';
  let parametry: { stawkaDoProgu: number; stawkaPonadProg: number; prog: number; kwotaZmniejszajaca: number } | null = null;
  let liniowy: { stawka: number; limit: number } | null = null;
  if (forma === 'skala') {
    const { stawkaDoProgu, stawkaPonadProg, prog, kwotaZmniejszajaca } = liczby.skala;
    if (stawkaDoProgu.wartosc === null || stawkaPonadProg.wartosc === null || prog.wartosc === null || kwotaZmniejszajaca.wartosc === null) {
      return { ok: false, brak: `Stawki i progi skali podatkowej na ${rok} r. nie są jeszcze ogłoszone, więc zaliczki nie liczymy.` };
    }
    parametry = { stawkaDoProgu: stawkaDoProgu.wartosc, stawkaPonadProg: stawkaPonadProg.wartosc, prog: prog.wartosc, kwotaZmniejszajaca: kwotaZmniejszajaca.wartosc };
  } else {
    const { stawka, limitOdliczeniaZdrowotnej } = liczby.liniowy;
    if (stawka.wartosc === null || limitOdliczeniaZdrowotnej.wartosc === null) {
      return {
        ok: false,
        brak: `Stawka podatku liniowego albo limit odliczenia składki zdrowotnej na ${rok} r. nie są jeszcze ogłoszone (limit MF ogłasza w grudniu), więc zaliczki nie liczymy.`,
      };
    }
    liniowy = { stawka: stawka.wartosc, limit: limitOdliczeniaZdrowotnej.wartosc };
  }

  const wynik: ZaliczkaMiesiaca[] = [];
  let przychod = 0;
  let koszty = 0;
  let spoleczneZaplacone = 0;
  let zdrowotnaZaplacona = 0;
  let zaliczkiWczesniej = 0;
  for (const m of miesiace) {
    przychod += m.przychodGr;
    koszty += m.kosztyGr;
    spoleczneZaplacone += m.spoleczneZaplaconeGr;
    zdrowotnaZaplacona += m.zdrowotnaZaplaconaGr;
    const dochod = przychod - koszty;
    const spoleczne = Math.min(spoleczneZaplacone, Math.max(0, dochod));
    const zdrowotna = liniowy ? Math.min(zdrowotnaZaplacona, liniowy.limit, Math.max(0, dochod - spoleczne)) : 0;
    const podstawa = doZlotych(Math.max(0, dochod - spoleczne - zdrowotna));
    const podatek = parametry ? podatekSkali(podstawa, parametry) : procent(podstawa, (liniowy as { stawka: number }).stawka);
    const zaliczka = Math.max(0, doZlotych(podatek - zaliczkiWczesniej));
    zaliczkiWczesniej += zaliczka;
    wynik.push({
      miesiac: m.miesiac,
      przychodNarastajacoGr: przychod,
      kosztyNarastajacoGr: koszty,
      dochodNarastajacoGr: dochod,
      spoleczneNarastajacoGr: spoleczne,
      zdrowotnaNarastajacoGr: zdrowotna,
      podstawaNarastajacoGr: podstawa,
      podatekNarastajacoGr: podatek,
      zaliczkaGr: zaliczka,
    });
  }
  return { ok: true, miesiace: wynik };
}

/**
 * Ryczałt od przychodów ewidencjonowanych za miesiąc (plan księgowości JDG,
 * K4; sekcje 4 i 5). Funkcja czysta: przychód według stawek daje ewidencja
 * (K3, już z progiem najmu), zapłacone składki rozliczenia z „Zapłacone”,
 * parametry wołający (`parametryRoku(rok).ryczalt`).
 *
 * - Od przychodu odlicza się składki społeczne zapłacone w miesiącu (bez FP)
 *   i 50 % zapłaconej składki zdrowotnej; czego nie da się odliczyć,
 *   przechodzi na kolejne miesiące roku.
 * - Korekta większa niż przychód ze stawką w miesiącu zmniejsza przychód tej
 *   stawki w kolejnych miesiącach roku (art. 14 ust. 1m i 1n ustawy o PIT przez
 *   art. 6 ust. 1a ustawy o ryczałcie; sekcja 5, pewność średnia).
 * - Przy kilku stawkach odliczenia dzielą się proporcjonalnie do przychodu
 *   z każdej stawki (dla zdrowotnej tak mówi podatki.gov.pl; dla społecznych
 *   to podział neutralny, bez wybierania za klienta, D8; księgowa potwierdza
 *   w złotym przypadku G4). Część stawki jest dokładna, bez zaokrąglania do
 *   groszy: podział co do grosza (z resztami po groszu) przestawiał grosze
 *   między stawkami przy każdej zmianie przychodu, a zaokrąglenie podstawy
 *   robiło z tego 1 zł mniej ryczałtu przy większym przychodzie (FZ-007,
 *   NZ-RYCZ-02).
 * - Podstawy i ryczałt w pełnych złotych (art. 63 Ordynacji podatkowej).
 */

import { etykietaStawki } from '@/lib/ksiegowosc/ewidencja';
import type { KluczRyczaltu, Liczba } from '@/lib/ksiegowosc/parametry';
import { procentGr } from '@/lib/ksiegowosc/zus';

export type LiczbyRyczaltu = { readonly [P in KluczRyczaltu]: Liczba };

/** Stawka z ewidencji (pb) → klucz w parametrach roku. */
export const KLUCZE_STAWEK: Readonly<Record<number, KluczRyczaltu>> = {
  1700: 'stawka17',
  1500: 'stawka15',
  1400: 'stawka14',
  1250: 'stawkaPonadProg8_5',
  1200: 'stawka12',
  1000: 'stawka10',
  850: 'stawka8_5',
  550: 'stawka5_5',
  300: 'stawka3',
};

export interface WejscieRyczaltu {
  /** Przychód miesiąca według stawki (pb → grosze), z ewidencji. */
  przychodWgStawekGr: ReadonlyMap<number, number>;
  /** Składki społeczne bez FP zapłacone w tym miesiącu. */
  spoleczneZaplaconeGr: number;
  /** Składka zdrowotna zapłacona w tym miesiącu. */
  zdrowotnaZaplaconaGr: number;
  /** Odliczenia, których nie dało się wykorzystać we wcześniejszych miesiącach roku. */
  nadwyzkaZPoprzednichGr: number;
  /** Ujemny przychód według stawki z wcześniejszych miesięcy roku (korekty większe niż przychód). */
  ujemneZPoprzednichGr?: ReadonlyMap<number, number>;
}

export interface OdliczeniaRyczaltu {
  spoleczneZaplaconeGr: number;
  zdrowotna50ProcGr: number;
  nadwyzkaZPoprzednichGr: number;
  odliczonoGr: number;
  nadwyzkaNaKolejneGr: number;
}

export interface RyczaltMiesiaca {
  odliczenia: OdliczeniaRyczaltu;
  /** Przychód ze stawką po zmniejszeniu o korekty z wcześniejszych miesięcy, tylko dodatni. */
  przychodWgStawekGr: Map<number, number>;
  /** Przychód ze stawką po odliczeniach, w pełnych złotych (w groszach). */
  podstawaWgStawekGr: Map<number, number>;
  /** Ryczałt do zapłaty za miesiąc, w pełnych złotych (w groszach). */
  ryczaltGr: number;
  /** Ujemny przychód według stawki, który przechodzi na kolejne miesiące. */
  ujemneNaKolejneGr: Map<number, number>;
}

export type WynikRyczaltu = { ok: true; ryczalt: RyczaltMiesiaca } | { ok: false; brak: string };

/** Grosze do pełnych złotych, połówka w górę (kwoty nieujemne). */
export function doPelnychZlotych(gr: number): number {
  return Math.floor((gr + 50) / 100) * 100;
}

export function ryczaltMiesiaca(w: WejscieRyczaltu, liczby: LiczbyRyczaltu): WynikRyczaltu {
  const odliczenieZdrowotnej = liczby.odliczenieZdrowotnej?.wartosc ?? null;
  if (odliczenieZdrowotnej === null) {
    return { ok: false, brak: 'Brak w parametrach części składki zdrowotnej, którą odlicza się od przychodu.' };
  }

  const lacznie = new Map<number, number>();
  for (const zrodlo of [w.przychodWgStawekGr, w.ujemneZPoprzednichGr ?? new Map<number, number>()]) {
    for (const [pb, gr] of zrodlo) lacznie.set(pb, (lacznie.get(pb) ?? 0) + gr);
  }
  const przychody = new Map<number, number>();
  const ujemneNaKolejneGr = new Map<number, number>();
  for (const [pb, gr] of [...lacznie].sort((a, b) => b[0] - a[0])) {
    if (gr === 0) continue;
    const klucz = KLUCZE_STAWEK[pb];
    if (!klucz || liczby[klucz]?.wartosc !== pb) {
      return { ok: false, brak: `Stawki ${etykietaStawki(pb)} nie ma w parametrach ryczałtu na ten rok.` };
    }
    if (gr < 0) ujemneNaKolejneGr.set(pb, gr);
    else przychody.set(pb, gr);
  }

  const zdrowotna50ProcGr = procentGr(w.zdrowotnaZaplaconaGr, odliczenieZdrowotnej);
  const dostepne = w.nadwyzkaZPoprzednichGr + w.spoleczneZaplaconeGr + zdrowotna50ProcGr;
  const przychodGr = [...przychody.values()].reduce((a, b) => a + b, 0);
  const odliczonoGr = Math.min(dostepne, przychodGr);

  // Podstawa stawki: jej przychód minus dokładna część odliczeń, czyli
  // gr · (przychód − odliczono) / przychód, do pełnych złotych. Rośnie z każdym
  // przychodem i maleje z odliczeniami, więc więcej przychodu nigdy nie daje
  // mniej ryczałtu (NZ-RYCZ-02), a więcej składek nigdy więcej ryczałtu (NZ-RYCZ-03).
  // Ułamek grosza obcinamy przed `doPelnychZlotych`: granica 50 gr leży na całym
  // groszu, więc wynik jest ten sam co zaokrąglenie dokładnej kwoty.
  const przychodRazem = BigInt(przychodGr);
  const poOdliczeniu = przychodRazem - BigInt(odliczonoGr);
  const podstawaWgStawekGr = new Map<number, number>();
  let podatekRazem = 0;
  for (const [pb, gr] of przychody) {
    const podstawa = doPelnychZlotych(Number((BigInt(gr) * poOdliczeniu) / przychodRazem));
    podstawaWgStawekGr.set(pb, podstawa);
    podatekRazem += podstawa * pb;
  }

  return {
    ok: true,
    ryczalt: {
      odliczenia: {
        spoleczneZaplaconeGr: w.spoleczneZaplaconeGr,
        zdrowotna50ProcGr,
        nadwyzkaZPoprzednichGr: w.nadwyzkaZPoprzednichGr,
        odliczonoGr,
        nadwyzkaNaKolejneGr: dostepne - odliczonoGr,
      },
      przychodWgStawekGr: przychody,
      podstawaWgStawekGr,
      // Σ podstawa × pb to grosze × 10 000; do pełnych złotych z połówką w górę.
      ryczaltGr: Math.floor((podatekRazem + 500_000) / 1_000_000) * 100,
      ujemneNaKolejneGr,
    },
  };
}

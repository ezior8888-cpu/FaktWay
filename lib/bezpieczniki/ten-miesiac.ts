/**
 * Strażnik „Ten miesiąc” (żelazny filtr F13, plan B4.10; D-F7: w module
 * księgowości blokada od razu). Ostatnia kontrola spójności pozycji tuż
 * przed pokazaniem, zatwierdzeniem i przypomnieniem: `czytajTenMiesiac`
 * sprawdza nim wynik silnika po bramce D7, więc strona, zatwierdzenie,
 * crony i „Odłóż na podatek” dostają już sprawdzone pozycje. Zła kwota nie
 * dochodzi do klienta nawet przy błędzie w silniku.
 *
 * Funkcja czysta: zwraca pozycje po kontroli i alarmy, a wysyła je wołający
 * (`alarm.ts`). Pozycja, która nie przejdzie kontroli, staje się brakiem
 * z komunikatem `BRAK_PO_KONTROLI` (przy złym terminie także bez terminu);
 * pozostałe zostają tymi samymi obiektami.
 *
 * Niezmienniki:
 * - FILTR-RT-TM-01: kwota to bezpieczna liczba całkowita groszy, nie mniej niż zero.
 * - FILTR-RT-TM-02: ryczałt, zaliczka PIT i VAT są w pełnych złotych
 *   (art. 63 § 1 Ordynacji podatkowej; RP-ZAOKR-01, RP-ZAOKR-03). Zaokrąglają
 *   je silniki: ryczałt `ryczaltMiesiaca` (`ryczalt.ts`), zaliczkę `doZlotych`
 *   (`pit.ts`), VAT to P_51 z pól deklaracji po `wholeZloty`, razy 100
 *   (`vat.ts`). Składki społeczne i zdrowotna są w groszach (RP-ZAOKR-02),
 *   więc ich ten niezmiennik nie dotyczy.
 * - FILTR-RT-TM-03: kwota pozycji równa jej źródłu w wyniku silnika (pary
 *   z `ten-miesiac.ts`): ryczałt `ryczalt.ryczaltGr`, zaliczka
 *   `pit.zaliczkaGr`, składki społeczne `skladki.razemGr +
 *   skladki.funduszPracyGr` (a ich część bez FP `skladki.razemGr`),
 *   zdrowotna `zdrowotna.skladkaGr` przy ryczałcie i
 *   `zdrowotnaOdDochodu.skladkaGr` przy skali i liniowym, VAT
 *   `vat.wynik.doZaplatyGr`. Pozycja z kwotą bez źródła też jest błędem.
 * - FILTR-RT-TM-04: termin (gdy jest) przypada w dzień roboczy
 *   (`czyDzienRoboczy`, RP-TERM-02), także przy pozycji bez kwoty, bo
 *   strona pokazuje termin i przy braku.
 */

import type { AlarmFiltra } from '@/lib/bezpieczniki/alarm';
import { czyDzienRoboczy } from '@/lib/ksiegowosc/kalendarz';
import type { PozycjaMiesiaca, RodzajRozliczenia, WynikMiesiaca } from '@/lib/ksiegowosc/ten-miesiac';

export const KODY_TEN_MIESIACA = {
  kwota: 'FILTR-RT-TM-01',
  pelneZlote: 'FILTR-RT-TM-02',
  zrodlo: 'FILTR-RT-TM-03',
  termin: 'FILTR-RT-TM-04',
} as const;

export type KodTenMiesiaca = (typeof KODY_TEN_MIESIACA)[keyof typeof KODY_TEN_MIESIACA];

/** Dla klienta, zamiast kwoty, która nie przeszła kontroli. */
export const BRAK_PO_KONTROLI = 'Tej kwoty nie pokazujemy, bo kontrola spójności wykryła błąd po naszej stronie. Zgłosiliśmy go.';

/** Rodzaje, które silniki zaokrąglają do pełnych złotych (TM-02). */
export const W_PELNYCH_ZLOTYCH: readonly RodzajRozliczenia[] = ['ryczalt', 'pit', 'vat'];

export interface AlarmTenMiesiaca extends AlarmFiltra {
  kod: KodTenMiesiaca;
  rodzaj: RodzajRozliczenia;
}

export interface KontrolaTenMiesiaca {
  /** Pozycje po kontroli, w tej samej kolejności co w wyniku. */
  pozycje: PozycjaMiesiaca[];
  alarmy: AlarmTenMiesiaca[];
}

type Naruszenie = [KodTenMiesiaca, string];

export function sprawdzTenMiesiac(wynik: WynikMiesiaca): KontrolaTenMiesiaca {
  const alarmy: AlarmTenMiesiaca[] = [];
  const pozycje = wynik.pozycje.map((poz): PozycjaMiesiaca => {
    const bledy = naruszenia(wynik, poz);
    if (bledy.length === 0) return poz;
    for (const [kod, opis] of bledy) alarmy.push({ kod, rodzaj: poz.rodzaj, miesiac: wynik.miesiac, opis });
    const zlyTermin = bledy.some(([kod]) => kod === KODY_TEN_MIESIACA.termin);
    return { ok: false, rodzaj: poz.rodzaj, termin: zlyTermin ? null : poz.termin, brak: BRAK_PO_KONTROLI };
  });
  return { pozycje, alarmy };
}

function naruszenia(w: WynikMiesiaca, poz: PozycjaMiesiaca): Naruszenie[] {
  const bledy: Naruszenie[] = [];
  if (poz.ok) {
    if (!Number.isSafeInteger(poz.kwotaGr) || poz.kwotaGr < 0) {
      bledy.push([KODY_TEN_MIESIACA.kwota, 'kwota nie jest całkowitą liczbą groszy od zera w górę']);
    }
    if (W_PELNYCH_ZLOTYCH.includes(poz.rodzaj) && poz.kwotaGr % 100 !== 0) {
      bledy.push([KODY_TEN_MIESIACA.pelneZlote, 'kwota nie jest w pełnych złotych (art. 63 § 1 Ordynacji podatkowej)']);
    }
    const zrodlo = zrodloKwoty(w, poz.rodzaj);
    if (!zrodlo) bledy.push([KODY_TEN_MIESIACA.zrodlo, 'pozycja ma kwotę, a wynik silnika nie ma jej źródła']);
    else if (poz.kwotaGr !== zrodlo.kwotaGr) bledy.push([KODY_TEN_MIESIACA.zrodlo, 'kwota pozycji różni się od wyniku silnika']);
    else if (zrodlo.bezFpGr !== undefined && poz.spoleczneBezFpGr !== zrodlo.bezFpGr) {
      bledy.push([KODY_TEN_MIESIACA.zrodlo, 'część składek bez Funduszu Pracy różni się od wyniku silnika']);
    }
  }
  if (poz.termin && !wDzienRoboczy(poz.termin.faktyczny)) {
    bledy.push([KODY_TEN_MIESIACA.termin, 'termin nie przypada w dzień roboczy']);
  }
  return bledy;
}

/** Źródło kwoty pozycji w wyniku silnika (TM-03); null, gdy wynik go nie ma. */
function zrodloKwoty(w: WynikMiesiaca, rodzaj: RodzajRozliczenia): { kwotaGr: number; bezFpGr?: number } | null {
  switch (rodzaj) {
    case 'ryczalt':
      return w.ryczalt ? { kwotaGr: w.ryczalt.ryczaltGr } : null;
    case 'pit':
      return w.pit ? { kwotaGr: w.pit.zaliczkaGr } : null;
    case 'zus_spoleczne':
      return w.skladki ? { kwotaGr: w.skladki.razemGr + w.skladki.funduszPracyGr, bezFpGr: w.skladki.razemGr } : null;
    case 'zdrowotna': {
      // Silnik wybiera źródło według formy: ryczałt w `tenMiesiac`, skala i liniowy w `miesiacKpir`.
      const z = w.profil.forma === 'ryczalt' ? w.zdrowotna : w.zdrowotnaOdDochodu;
      return z ? { kwotaGr: z.skladkaGr } : null;
    }
    case 'vat':
      return w.vat?.wynik ? { kwotaGr: w.vat.wynik.doZaplatyGr } : null;
  }
}

const DZIEN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Dzień RRRR-MM-DD (północ UTC, jak w kalendarzu) jest roboczy; zła data to nie dzień roboczy. Też dla strażnika przypomnień. */
export function wDzienRoboczy(dzien: unknown): boolean {
  const czesci = typeof dzien === 'string' ? DZIEN.exec(dzien) : null;
  if (!czesci) return false;
  const [rok, miesiac, dzienMiesiaca] = [Number(czesci[1]), Number(czesci[2]), Number(czesci[3])];
  const data = new Date(Date.UTC(rok, miesiac - 1, dzienMiesiaca));
  if (data.getUTCFullYear() !== rok || data.getUTCMonth() !== miesiac - 1 || data.getUTCDate() !== dzienMiesiaca) return false;
  return czyDzienRoboczy(data);
}

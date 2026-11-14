/**
 * Strażnik przypomnień o terminach (żelazny filtr F13 część 5, plan B4.10;
 * D-F7: w module księgowości blokada od razu). `cron.ksiegowosc-terminy`
 * sprawdza nim przypomnienie tuż przed wysyłką pusha, maila i wpisu
 * w dzwonku. Pozycje szkicu przeszły już strażnika „Ten miesiąc”
 * (`czytajTenMiesiac`), ale kwota z zatwierdzonej wersji i termin z kalendarza
 * przypomnienia idą inną drogą.
 *
 * Funkcja czysta: zwraca pozycje po kontroli, decyzję o wysyłce i alarmy,
 * a alarmy wysyła wołający (`alarm.ts`).
 * - FILTR-RT-PRZ-01: kwota pozycji to bezpieczna liczba całkowita groszy, nie
 *   mniej niż zero, a ryczałt, zaliczka PIT i VAT są w pełnych złotych
 *   (art. 63 § 1 Ordynacji podatkowej, jak FILTR-RT-TM-01 i TM-02). Pozycja
 *   z taką kwotą zostaje w przypomnieniu bez kwoty, tak jak przy braku
 *   podpisu księgowej (D7): klient dostaje termin, a zła kwota do niego nie
 *   dochodzi.
 * - FILTR-RT-PRZ-02: termin przypomnienia przypada w dzień roboczy
 *   (`wDzienRoboczy` strażnika „Ten miesiąc”, RP-TERM-02, jak FILTR-RT-TM-04). Inaczej przypomnienie
 *   nie wychodzi, bo podałoby zły termin; „Ten miesiąc” pokazuje termin
 *   po swojej kontroli.
 */

import type { AlarmFiltra } from '@/lib/bezpieczniki/alarm';
import { W_PELNYCH_ZLOTYCH, wDzienRoboczy } from '@/lib/bezpieczniki/ten-miesiac';
import type { PozycjaPrzypomnienia } from '@/lib/ksiegowosc/przypomnienia';

export const KODY_PRZYPOMNIEN = {
  kwota: 'FILTR-RT-PRZ-01',
  termin: 'FILTR-RT-PRZ-02',
} as const;

export type KodPrzypomnienia = (typeof KODY_PRZYPOMNIEN)[keyof typeof KODY_PRZYPOMNIEN];

export interface AlarmPrzypomnienia extends AlarmFiltra {
  kod: KodPrzypomnienia;
}

export interface KontrolaPrzypomnienia {
  /** Pozycje do treści; zła kwota zamieniona na brak kwoty (`null`). */
  pozycje: PozycjaPrzypomnienia[];
  /** `false`: przypomnienie nie wychodzi (zły termin). */
  wyslac: boolean;
  alarmy: AlarmPrzypomnienia[];
}

/** `miesiac` to okres rozliczenia (RRRR-MM), `termin` faktyczny dzień terminu (RRRR-MM-DD). */
export function sprawdzPrzypomnienie(w: { miesiac: string; termin: string; pozycje: readonly PozycjaPrzypomnienia[] }): KontrolaPrzypomnienia {
  const alarmy: AlarmPrzypomnienia[] = [];
  const pozycje = w.pozycje.map((p) => {
    if (p.kwotaGr === null) return p;
    const calkowita = Number.isSafeInteger(p.kwotaGr) && p.kwotaGr >= 0;
    const wZlotych = !W_PELNYCH_ZLOTYCH.includes(p.rodzaj) || p.kwotaGr % 100 === 0;
    if (calkowita && wZlotych) return p;
    alarmy.push({
      kod: KODY_PRZYPOMNIEN.kwota,
      rodzaj: p.rodzaj,
      miesiac: w.miesiac,
      opis: calkowita ? 'kwota w przypomnieniu nie jest w pełnych złotych' : 'kwota w przypomnieniu nie jest całkowitą liczbą groszy od zera w górę',
    });
    return { ...p, kwotaGr: null };
  });
  const dzienRoboczy = wDzienRoboczy(w.termin);
  if (!dzienRoboczy) {
    alarmy.push({ kod: KODY_PRZYPOMNIEN.termin, rodzaj: 'termin', miesiac: w.miesiac, opis: 'termin przypomnienia nie przypada w dzień roboczy albo nie jest datą' });
  }
  return { pozycje, wyslac: dzienRoboczy, alarmy };
}

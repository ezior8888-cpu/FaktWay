import { ODCZYT_K1 } from './zrodla';
import type { Jednostka, Liczba, Pewnosc } from './typy';

/** Wpis liczby w pliku roku. Data odczytu domyślnie z kroku K1. */
export function liczba(
  wartosc: number | null,
  jednostka: Jednostka,
  zrodlo: string,
  pewnosc: Pewnosc,
  dodatkowo: { odczyt?: string; uwagi?: string } = {},
): Liczba {
  return {
    wartosc,
    jednostka,
    zrodlo,
    odczyt: dodatkowo.odczyt ?? ODCZYT_K1,
    pewnosc,
    ...(dodatkowo.uwagi ? { uwagi: dodatkowo.uwagi } : {}),
  };
}

/** Liczba jeszcze nieogłoszona: bez wartości, z powodem i datą, kiedy się pojawi. */
export function nieznana(jednostka: Jednostka, uwagi: string): Liczba {
  return { wartosc: null, jednostka, zrodlo: '', odczyt: ODCZYT_K1, pewnosc: 'niska', uwagi };
}

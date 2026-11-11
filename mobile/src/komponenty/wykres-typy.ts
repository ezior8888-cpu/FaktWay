import type { Kolory } from '@/wyglad/kolory';

export type PunktWykresu = {
  /** Podpis osi X, np. „lis”, albo nazwa wycinka pierścienia. */
  x: string;
  /** Wartość w złotych (nie w groszach): wykres pokazuje skalę, nie dokładne kwoty. */
  y: number;
  /** Kolor słupka albo wycinka; domyślnie odcienie niebieskiego marki (`wykres1` do `wykres5`). */
  kolor?: keyof Kolory;
  /** Tekst dymka i czytnika ekranu, np. „34 560,00 zł”. */
  opis?: string;
};

/** Seria słupków składanych (jak „Finanse” na stronie: koszty, zysk, VAT w jednym słupku). */
export type SeriaWykresu = { nazwa: string; kolor: keyof Kolory; wartosci: number[] };

export type WykresProps = {
  punkty: PunktWykresu[];
  rodzaj?: 'slupki' | 'linia' | 'pole' | 'kolo';
  /** Słupki składane z serii; `punkty` dają wtedy podpisy osi X i dymki. */
  stos?: SeriaWykresu[];
  wysokosc?: number;
  etykieta?: string;
};

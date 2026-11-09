import type { Kolory } from '@/wyglad/kolory';

export type PunktWykresu = {
  /** Podpis osi X, np. „lis”. */
  x: string;
  /** Wartość w złotych (nie w groszach): wykres pokazuje skalę, nie dokładne kwoty. */
  y: number;
  kolor?: keyof Kolory;
  /** Tekst dla czytnika ekranu, np. „34 560 zł”. */
  opis?: string;
};

export type WykresProps = {
  punkty: PunktWykresu[];
  rodzaj?: 'slupki' | 'linia' | 'pole' | 'kolo';
  wysokosc?: number;
  etykieta?: string;
};

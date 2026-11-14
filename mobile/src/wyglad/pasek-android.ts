/**
 * Górny pasek na Androidzie (etap M12, ZASADY-DESIGNU.md, sekcja 10): pasek
 * Material z tytułem po lewej i strzałką wstecz, ten sam wygląd treści co na
 * iOS. Czyste funkcje bez React Native (czyta je test
 * `tests/unit/mobile-android.test.ts`): na iOS każda zwraca to, co ekrany
 * miały przed M12, więc iPhone wygląda tak samo.
 *
 * Dlaczego osobno dla Androida:
 * - pasek Androida jest nieprzezroczysty i nie ma dużego tytułu, więc na
 *   ekranach z gradientem (D15) pasek ma kolor góry gradientu, biały tytuł i
 *   białe ikony, a gradient w treści zaczyna się od tego samego koloru;
 * - styl paska stanu: gdy jeden ekran (Pulpit) go ustawi, Android stosuje
 *   domyślny jasny styl na każdym innym ekranie, więc każdy ekran go podaje;
 * - menu w pasku rysuje Compose (`@expo/ui`): bez własnych kolorów dostaje
 *   tło paska i napisy w kolorze akcentu. Białe menu wymaga też koloru okręgu
 *   za ikoną (`buttonContainerColor`), inaczej za ikoną jest biały kwadrat.
 */
import type { Kolory } from './paleta';

type Platforma = string;

/** Kolory menu i przycisków ikon w `Stack.Toolbar` (Android). */
export type KoloryNarzedzi = { tintColor?: string; backgroundColor?: string; buttonContainerColor?: string };

/** Opcje dokładane do każdego stosu: styl paska stanu według motywu. */
export function opcjeStosuAndroid(platforma: Platforma, ciemny: boolean): { statusBarStyle?: 'light' | 'dark' } {
  if (platforma !== 'android') return {};
  return { statusBarStyle: ciemny ? 'light' : 'dark' };
}

/**
 * Ekran z gradientem pod nagłówkiem (lista zakładki albo szczegół): pasek w
 * kolorze `gradientGora`, biały tytuł, strzałka i jasny pasek stanu.
 */
export function opcjeGradientuAndroid(platforma: Platforma, k: Kolory, czcionkaTytulu: string) {
  if (platforma !== 'android') return {};
  return {
    headerStyle: { backgroundColor: k.gradientGora },
    headerTintColor: k.naGradiencie,
    headerTitleStyle: { fontFamily: czcionkaTytulu, color: k.naGradiencie },
    statusBarStyle: 'light' as const,
  };
}

/**
 * Ikony w pasku i menu Compose. iOS: ikona w kolorze tekstu, jak przed M12,
 * bez zmian w `Stack.Toolbar`. Android: na niebieskim pasku ikona biała na
 * okręgu 20% bieli (ZASADY-DESIGNU.md, sekcja 2), menu na białej karcie z
 * ciemnym tekstem.
 */
export function koloryPaska(platforma: Platforma, k: Kolory, naGradiencie: boolean): { ikona: string; ikonaAktywna: string; narzedzia: KoloryNarzedzi } {
  if (platforma !== 'android') return { ikona: k.etykieta, ikonaAktywna: k.akcent, narzedzia: {} };
  return {
    ikona: naGradiencie ? k.naGradiencie : k.etykieta,
    // Na niebieskim pasku niebieska ikona zniknęłaby: aktywny filtr zostaje biały, liczbę filtrów pokazuje treść.
    ikonaAktywna: naGradiencie ? k.naGradiencie : k.akcent,
    narzedzia: { tintColor: k.etykieta, backgroundColor: k.tloKomorki, buttonContainerColor: naGradiencie ? k.naGradiencieTlo : 'transparent' },
  };
}

/** Wyszukiwarka w pasku (lupa, wpisany tekst, podpowiedź) na niebieskim pasku Androida. */
export function opcjeWyszukiwarkiAndroid(platforma: Platforma, k: Kolory) {
  if (platforma !== 'android') return {};
  return { headerIconColor: k.naGradiencie, textColor: k.naGradiencie, hintTextColor: k.naGradiencieDrugorzedny, tintColor: k.naGradiencie };
}

/** Punkt gradientu: odległość od górnej krawędzi treści (pt) i kolor. */
export type StopGradientu = { y: number; kolor: keyof Kolory };

/**
 * Gradient w treści pod nieprzezroczystym paskiem Androida: od koloru paska
 * (bez szwu) do tła pod pierwszą kartą. Do połowy gradientu (niżej tekst bez
 * karty nie schodzi, ZASADY-DESIGNU.md, sekcja 4) biały tekst ma tu co
 * najmniej taki kontrast jak na iOS, a w ciemnym motywie co najmniej 7:1
 * (sprawdza `tests/unit/mobile-android.test.ts`).
 */
export function stopyPodPaskiemAndroid(nad: number, podTrescia: number): StopGradientu[] {
  return [
    { y: -nad, kolor: 'gradientGora' },
    { y: 0, kolor: 'gradientGora' },
    { y: podTrescia * 0.15, kolor: 'gradientSrodek' },
    { y: podTrescia * 0.35, kolor: 'gradientDol' },
    { y: podTrescia, kolor: 'tloGrupowane' },
  ];
}

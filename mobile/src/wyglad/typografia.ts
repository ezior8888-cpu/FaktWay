/**
 * Typografia FaktWay (plan aplikacji, D12): Outfit na interfejs, IBM Plex
 * Mono na liczby, numery faktur, NIP-y i daty, jak w wersji na komputer
 * (`app/layout.tsx` strony, plan Finora D2). Czcionki są wbudowane w aplikację
 * (`app.json`, plugin `expo-font`), więc działają od pierwszej klatki, także
 * w paskach nawigacji i zakładek.
 *
 * Wagę wybiera się plikiem czcionki, nie `fontWeight`: przy własnej czcionce
 * `fontWeight` na Androidzie wraca do czcionki systemowej. `dynamicTypeRamp`
 * mówi iOS, jak styl rośnie przy większym tekście z ustawień.
 */
import type { TextProps, TextStyle } from 'react-native';

export type Waga = 'regular' | 'medium' | 'semibold' | 'bold';

/** Nazwy PostScript wbudowanych plików (`assets/fonts/`). */
const OUTFIT: Record<Waga, string> = {
  regular: 'Outfit-Regular',
  medium: 'Outfit-Medium',
  semibold: 'Outfit-SemiBold',
  bold: 'Outfit-Bold',
};

/** IBM Plex Mono nie ma w aplikacji pliku Bold: pogrubione liczby są SemiBold. */
const PLEX_MONO: Record<Waga, string> = {
  regular: 'IBMPlexMono-Regular',
  medium: 'IBMPlexMono-Medium',
  semibold: 'IBMPlexMono-SemiBold',
  bold: 'IBMPlexMono-SemiBold',
};

export function czcionka(waga: Waga = 'regular', cyfry = false): string {
  return (cyfry ? PLEX_MONO : OUTFIT)[waga];
}

export type StylTekstu =
  | 'largeTitle'
  | 'title1'
  | 'title2'
  | 'title3'
  | 'headline'
  | 'body'
  | 'callout'
  | 'subheadline'
  | 'footnote'
  | 'caption1'
  | 'caption2';

type Definicja = { fontSize: number; lineHeight: number; letterSpacing: number; waga: Waga };

/**
 * Skala tekstu. Rozmiary nieco mniejsze niż systemowe iOS: Outfit ma szersze
 * litery niż SF Pro, a strona jest zwarta (skala SM). Rozmiarów spoza tej
 * skali nie wpisujemy w komponentach.
 */
export const SKALA: Record<StylTekstu, Definicja> = {
  largeTitle: { fontSize: 30, lineHeight: 36, letterSpacing: -0.4, waga: 'semibold' },
  title1: { fontSize: 26, lineHeight: 32, letterSpacing: -0.3, waga: 'semibold' },
  title2: { fontSize: 21, lineHeight: 26, letterSpacing: -0.2, waga: 'semibold' },
  title3: { fontSize: 18, lineHeight: 23, letterSpacing: -0.1, waga: 'semibold' },
  headline: { fontSize: 16, lineHeight: 21, letterSpacing: 0, waga: 'semibold' },
  body: { fontSize: 16, lineHeight: 22, letterSpacing: 0, waga: 'regular' },
  callout: { fontSize: 15, lineHeight: 20, letterSpacing: 0, waga: 'regular' },
  subheadline: { fontSize: 14, lineHeight: 19, letterSpacing: 0, waga: 'regular' },
  footnote: { fontSize: 13, lineHeight: 18, letterSpacing: 0, waga: 'regular' },
  caption1: { fontSize: 12, lineHeight: 16, letterSpacing: 0.1, waga: 'regular' },
  caption2: { fontSize: 11, lineHeight: 14, letterSpacing: 0.2, waga: 'medium' },
};

/** Gotowy styl tekstu (czcionka, rozmiar, interlinia) dla pól i miejsc bez komponentu `Tekst`. */
export function stylTekstu(styl: StylTekstu, opcje: { waga?: Waga; cyfry?: boolean } = {}): TextStyle {
  const d = SKALA[styl];
  // Plex Mono jest szeroki: liczby trochę ciaśniej, żeby kwoty mieściły się w kolumnach.
  const ciasniej = opcje.cyfry ? Math.min(0, -0.02 * d.fontSize) : 0;
  return {
    fontFamily: czcionka(opcje.waga ?? d.waga, opcje.cyfry),
    fontSize: d.fontSize,
    lineHeight: d.lineHeight,
    letterSpacing: d.letterSpacing + ciasniej,
  };
}

/** Nazwa rampy Dynamic Type dla stylu (React Native: prop `dynamicTypeRamp`). */
export const RAMPA: Record<StylTekstu, NonNullable<TextProps['dynamicTypeRamp']>> = {
  largeTitle: 'largeTitle',
  title1: 'title1',
  title2: 'title2',
  title3: 'title3',
  headline: 'headline',
  body: 'body',
  callout: 'callout',
  subheadline: 'subheadline',
  footnote: 'footnote',
  caption1: 'caption1',
  caption2: 'caption2',
};

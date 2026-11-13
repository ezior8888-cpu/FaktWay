/**
 * Typografia FaktWay: Outfit na wszystko, także na liczby (plan aplikacji,
 * D15, „wszystko jak Copilot”; wcześniej liczby w IBM Plex Mono, D12).
 * Liczby, kwoty, numery, NIP-y i daty mają cyfry tabelaryczne
 * (`fontVariant: ['tabular-nums']`, funkcja `tnum` w plikach Outfit), więc
 * kolumny kwot się nie rozjeżdżają. Czcionka jest wbudowana w aplikację
 * (`app.json`, plugin `expo-font`), więc działa od pierwszej klatki, także w
 * paskach nawigacji i zakładek.
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

export function czcionka(waga: Waga = 'regular'): string {
  return OUTFIT[waga];
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
  return {
    fontFamily: czcionka(opcje.waga ?? d.waga),
    fontSize: d.fontSize,
    lineHeight: d.lineHeight,
    letterSpacing: d.letterSpacing,
    ...(opcje.cyfry ? { fontVariant: ['tabular-nums'] as TextStyle['fontVariant'] } : null),
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

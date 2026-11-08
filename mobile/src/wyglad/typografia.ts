/**
 * Systemowe style tekstu iOS (rozmiar i interlinia przy domyślnym rozmiarze
 * tekstu). `dynamicTypeRamp` mówi iOS, jak dany styl rośnie przy większym
 * tekście z ustawień, więc Dynamic Type działa jak w aplikacjach Apple
 * (docs/mobile/ZASADY-DESIGNU.md, sekcja 3). Rozmiarów spoza tej skali nie
 * wpisujemy w komponentach.
 */
import type { TextStyle } from 'react-native';

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

type Definicja = Pick<TextStyle, 'fontSize' | 'lineHeight' | 'fontWeight' | 'letterSpacing'>;

export const STYLE_TEKSTU: Record<StylTekstu, Definicja> = {
  largeTitle: { fontSize: 34, lineHeight: 41, fontWeight: '700', letterSpacing: 0.4 },
  title1: { fontSize: 28, lineHeight: 34, fontWeight: '700', letterSpacing: 0.38 },
  title2: { fontSize: 22, lineHeight: 28, fontWeight: '700', letterSpacing: -0.26 },
  title3: { fontSize: 20, lineHeight: 25, fontWeight: '600', letterSpacing: -0.45 },
  headline: { fontSize: 17, lineHeight: 22, fontWeight: '600', letterSpacing: -0.43 },
  body: { fontSize: 17, lineHeight: 22, fontWeight: '400', letterSpacing: -0.43 },
  callout: { fontSize: 16, lineHeight: 21, fontWeight: '400', letterSpacing: -0.31 },
  subheadline: { fontSize: 15, lineHeight: 20, fontWeight: '400', letterSpacing: -0.23 },
  footnote: { fontSize: 13, lineHeight: 18, fontWeight: '400', letterSpacing: -0.08 },
  caption1: { fontSize: 12, lineHeight: 16, fontWeight: '400', letterSpacing: 0 },
  caption2: { fontSize: 11, lineHeight: 13, fontWeight: '400', letterSpacing: 0.06 },
};

/** Nazwa rampy Dynamic Type dla stylu (React Native: prop `dynamicTypeRamp`). */
export const RAMPA: Record<StylTekstu, NonNullable<import('react-native').TextProps['dynamicTypeRamp']>> = {
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

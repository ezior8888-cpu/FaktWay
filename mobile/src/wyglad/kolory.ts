/**
 * Kolory aplikacji: tylko semantyczne kolory systemu i jeden akcent marki
 * (docs/mobile/ZASADY-DESIGNU.md, sekcja 4).
 *
 * Na iOS to kolory UIKit (`Color.ios.*`), które same przełączają się między
 * trybem jasnym i ciemnym. Na Androidzie to kolory Material 3 (`dynamic`),
 * a akcent zależy od trybu, więc całość jest hookiem.
 */
import { Color } from 'expo-router';
import { DynamicColorIOS, Platform, useColorScheme, type ColorValue } from 'react-native';

/** Niebieski FaktWay: `--primary` z app/globals.css (jasny i ciemny motyw strony). */
export const AKCENT_JASNY = '#2463EF';
export const AKCENT_CIEMNY = '#61A4F7';

export type Kolory = {
  etykieta: ColorValue;
  etykietaDrugorzedna: ColorValue;
  etykietaTrzeciorzedna: ColorValue;
  tlo: ColorValue;
  tloGrupowane: ColorValue;
  tloKomorki: ColorValue;
  wypelnienie: ColorValue;
  separator: ColorValue;
  akcent: ColorValue;
  sukces: ColorValue;
  ostrzezenie: ColorValue;
  blad: ColorValue;
};

const IOS: Kolory = {
  etykieta: Color.ios.label,
  etykietaDrugorzedna: Color.ios.secondaryLabel,
  etykietaTrzeciorzedna: Color.ios.tertiaryLabel,
  tlo: Color.ios.systemBackground,
  tloGrupowane: Color.ios.systemGroupedBackground,
  tloKomorki: Color.ios.secondarySystemGroupedBackground,
  wypelnienie: Color.ios.tertiarySystemFill,
  separator: Color.ios.separator,
  akcent: Platform.OS === 'ios' ? DynamicColorIOS({ light: AKCENT_JASNY, dark: AKCENT_CIEMNY }) : AKCENT_JASNY,
  sukces: Color.ios.systemGreen,
  ostrzezenie: Color.ios.systemOrange,
  blad: Color.ios.systemRed,
};

function koloryAndroid(ciemny: boolean): Kolory {
  const d = Color.android.dynamic;
  return {
    etykieta: d.onSurface,
    etykietaDrugorzedna: d.onSurfaceVariant,
    etykietaTrzeciorzedna: d.outline,
    tlo: d.surface,
    tloGrupowane: d.surfaceContainerLow,
    tloKomorki: d.surfaceContainer,
    wypelnienie: d.surfaceContainerHighest,
    separator: d.outlineVariant,
    akcent: ciemny ? AKCENT_CIEMNY : AKCENT_JASNY,
    sukces: ciemny ? '#4ADE80' : '#15803D',
    ostrzezenie: ciemny ? '#FBBF24' : '#B45309',
    blad: d.error,
  };
}

export function useKolory(): Kolory {
  const schemat = useColorScheme();
  if (Platform.OS === 'ios') return IOS;
  return koloryAndroid(schemat === 'dark');
}

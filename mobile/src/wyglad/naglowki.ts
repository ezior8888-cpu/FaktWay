/**
 * Wspólne opcje stosu ekranów: tytuły w Outfit, płaski pasek nad tłem ekranu
 * (jak nagłówek strony, bez cienia), wstecz w kolorze marki.
 * Zachowanie zostaje systemowe: duży tytuł zwija się przy przewijaniu,
 * przejścia i gest wstecz robi system (płynność, plan aplikacji D12).
 */
import type { NativeStackNavigationOptions } from 'expo-router';

import { useKolory } from '@/wyglad/kolory';
import { czcionka } from '@/wyglad/typografia';

export function useOpcjeStosu(): NativeStackNavigationOptions {
  const kolory = useKolory();
  return {
    headerTintColor: kolory.akcent,
    headerTitleStyle: { fontFamily: czcionka('semibold'), color: kolory.etykieta },
    headerLargeTitleStyle: { fontFamily: czcionka('semibold'), color: kolory.etykieta },
    headerBackTitleStyle: { fontFamily: czcionka('regular') },
    // Bez `headerStyle`/`headerLargeStyle` z kolorem tła: na iOS 27 chowają duży
    // tytuł (sprawdzone w symulatorze). Pasek jest przezroczysty nad tłem ekranu.
    headerShadowVisible: false,
    headerLargeTitleShadowVisible: false,
    contentStyle: { backgroundColor: kolory.tloGrupowane },
  };
}

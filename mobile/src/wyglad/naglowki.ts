/**
 * Wspólne opcje stosu ekranów: tytuły w Outfit, płaski pasek nad tłem ekranu
 * (jak nagłówek strony, bez cienia), wstecz w kolorze marki.
 * Zachowanie zostaje systemowe: duży tytuł zwija się przy przewijaniu,
 * przejścia i gest wstecz robi system (płynność, plan aplikacji D12).
 */
import type { NativeStackNavigationOptions } from 'expo-router';
import { useState } from 'react';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';

import { useKolory } from '@/wyglad/kolory';
import { GRADIENT } from '@/wyglad/odstepy';
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

/**
 * Ekran zakładki z gradientem pod nagłówkiem (D15): duży tytuł biały na
 * niebieskim. Po przewinięciu system zwija go do małego tytułu w zwykłym
 * kolorze na zwykłym pasku (sprawdzone w symulatorze, iOS 27). Treść ekranu
 * dostaje gradient przez `EkranListy gradient`.
 */
export function useOpcjeGradientu(): NativeStackNavigationOptions {
  const kolory = useKolory();
  return { headerLargeTitle: true, headerLargeTitleStyle: { fontFamily: czcionka('semibold'), color: kolory.naGradiencie } };
}

/**
 * Szczegół z gradientem i małym tytułem w pasku (numer faktury): tytuł biały,
 * dopóki pod paskiem leży niebieski gradient, a po przewinięciu zwykły, bo
 * pasek robi się jasny. Ciemny tytuł na niebieskim miał kontrast około 2:1
 * (sprawdzone w symulatorze). Przekaż `onScroll` i `scrollEventThrottle` do
 * `EkranListy`, a `tytul` do opcji ekranu.
 */
export function useTytulNaGradiencie() {
  const kolory = useKolory();
  const [naGradiencie, setNaGradiencie] = useState(true);
  return {
    tytul: { fontFamily: czcionka('semibold'), color: naGradiencie ? kolory.naGradiencie : kolory.etykieta },
    scrollEventThrottle: 16,
    onScroll: (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      // W spoczynku przesunięcie jest ujemne (treść pod paskiem); gradient znika spod paska koło zera.
      const teraz = e.nativeEvent.contentOffset.y < -GRADIENT.nadTrescia * 0.3;
      if (teraz !== naGradiencie) setNaGradiencie(teraz);
    },
  };
}

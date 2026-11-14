/**
 * Wspólne opcje stosu ekranów: tytuły w Outfit, płaski pasek nad tłem ekranu
 * (jak nagłówek strony, bez cienia), wstecz w kolorze marki.
 * Zachowanie zostaje systemowe: duży tytuł zwija się przy przewijaniu,
 * przejścia i gest wstecz robi system (płynność, plan aplikacji D12).
 */
import type { NativeStackNavigationOptions } from 'expo-router';
import { useState } from 'react';
import { Platform, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';

import { useCiemny, useKolory } from '@/wyglad/kolory';
import { GRADIENT } from '@/wyglad/odstepy';
import { koloryPaska, opcjeGradientuAndroid, opcjeStosuAndroid, opcjeWyszukiwarkiAndroid } from '@/wyglad/pasek-android';
import { czcionka } from '@/wyglad/typografia';

export function useOpcjeStosu(): NativeStackNavigationOptions {
  const kolory = useKolory();
  const ciemny = useCiemny();
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
    // Android (M12): styl paska stanu na każdym ekranie, bo po Pulpicie zostałby jasny na jasnym pasku.
    ...opcjeStosuAndroid(Platform.OS, ciemny),
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
  return {
    headerLargeTitle: true,
    headerLargeTitleStyle: { fontFamily: czcionka('semibold'), color: kolory.naGradiencie },
    // Android nie ma dużego tytułu: pasek w kolorze góry gradientu z białym tytułem (`pasek-android.ts`).
    ...opcjeGradientuAndroid(Platform.OS, kolory, czcionka('semibold')),
  };
}

/**
 * Szczegół z gradientem (faktura, wydatek, kontrahent): na iOS nic (pasek
 * przezroczysty nad gradientem, tytuł z `useTytulNaGradiencie`), na Androidzie
 * pasek w kolorze góry gradientu jak na liście zakładki.
 */
export function useOpcjeSzczegoluNaGradiencie(): NativeStackNavigationOptions {
  const kolory = useKolory();
  return opcjeGradientuAndroid(Platform.OS, kolory, czcionka('semibold'));
}

/**
 * Kolory ikon w pasku: `ikona` do `tintColor` przycisku i menu,
 * `narzedzia` do `Stack.Toolbar` (na iOS pusty obiekt). `naGradiencie`: ekran
 * z gradientem, na Androidzie niebieski pasek.
 */
export function useKoloryPaska(naGradiencie: boolean) {
  const kolory = useKolory();
  return koloryPaska(Platform.OS, kolory, naGradiencie);
}

/** Wyszukiwarka w pasku ekranu z gradientem: na Androidzie białe ikony i tekst na niebieskim pasku. */
export function useOpcjeWyszukiwarki() {
  const kolory = useKolory();
  return opcjeWyszukiwarkiAndroid(Platform.OS, kolory);
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
  // Android: pasek zawsze w kolorze gradientu (`useOpcjeSzczegoluNaGradiencie`), więc tytuł zawsze biały.
  // Przesunięcie treści startuje tam od zera, a próg niżej zakłada ujemne (treść pod paskiem iOS).
  if (Platform.OS === 'android') {
    return { tytul: { fontFamily: czcionka('semibold'), color: kolory.naGradiencie }, scrollEventThrottle: undefined, onScroll: undefined };
  }
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

/**
 * Grupy w menu filtrów (`Stack.Toolbar.Menu inline`): na iOS sekcje z tytułem
 * w jednym menu, jak przed M12. Menu Compose na Androidzie rysuje grupę w
 * linii bez tytułu, więc trzy pozycje „Wszystkie” stałyby obok siebie; tam
 * każda grupa to podmenu z tytułem („Status KSeF ›”).
 */
export const GRUPY_MENU_W_LINII = Platform.OS !== 'android';

import { DarkTheme, DefaultTheme, Slot, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import { LogBox, StyleSheet, useColorScheme, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { Blokada, Zaslona } from '@/komponenty/blokada';
import { PasekCofnij } from '@/komponenty/pasek-cofnij';
import { StanFaktur } from '@/stan/faktury';
import { Sesja, useSesja } from '@/stan/sesja';
import { paleta } from '@/wyglad/kolory';

// Znane ostrzeżenie React Native w wersji deweloperskiej przy przejściach ekranów
// (wartości `Animated` bez nasłuchu); nie dotyczy naszego kodu i zasłaniało dół ekranu.
LogBox.ignoreLogs(['Sending `onAnimatedValueUpdate` with no listeners registered']);

// Ekran startowy z logo (WZORCE-MOBBIN.md 7, ekran 1) zostaje, dopóki sesja nie wczyta się z pęku kluczy.
void SplashScreen.preventAutoHideAsync();

/**
 * Korzeń aplikacji: motyw nawigacji w kolorach marki (tło pod paskiem nie
 * mruga), stan danych, sesja. Bez sesji widać tylko logowanie, po
 * zalogowaniu tylko zakładki (etap M5): pilnują tego przekierowania w
 * `(zakladki)/_layout.tsx` i `logowanie/_layout.tsx`. Korzeń to `Slot`, nie
 * stos: stos nad zakładkami przejmował styl paska stanu (ciemny napis na
 * gradiencie Pulpitu, sprawdzone w symulatorze). Nad wszystkim leżą blokada
 * Face ID i zasłona w przełączniku aplikacji.
 */
export default function UkladGlowny() {
  const ciemny = useColorScheme() === 'dark';
  const k = paleta(ciemny);
  const baza = ciemny ? DarkTheme : DefaultTheme;
  const motyw = {
    ...baza,
    colors: { ...baza.colors, primary: k.akcent, background: k.tloGrupowane, card: k.tloGrupowane, text: k.etykieta, border: k.obwodka },
  };
  return (
    <GestureHandlerRootView style={styles.ekran}>
      <ThemeProvider value={motyw}>
        <StanFaktur>
          <Sesja>
            <Nawigacja />
          </Sesja>
        </StanFaktur>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}

function Nawigacja() {
  const { stan } = useSesja();
  const zalogowany = stan === 'aktywna';
  const wczytana = stan !== 'wczytywanie';
  useEffect(() => {
    if (wczytana) void SplashScreen.hideAsync();
  }, [wczytana]);
  // Bez nawigacji do końca wczytywania: inaczej przekierowanie mignęłoby ekranem logowania.
  if (!wczytana) return null;
  return (
    <View style={styles.ekran}>
      <Slot />
      {zalogowany ? <PasekCofnij /> : null}
      <Zaslona />
      <Blokada />
    </View>
  );
}

const styles = StyleSheet.create({
  ekran: { flex: 1 },
});

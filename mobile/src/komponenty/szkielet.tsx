/**
 * Szkielet ładowania w kształcie treści (ZASADY-DESIGNU.md, sekcja 5;
 * WZORCE-MOBBIN.md 8.1, wzór Mercury): tytuł, wyszukiwarka i pigułki stoją od
 * razu, szare kształty tylko w miejscu wierszy i kwoty. Słabe pulsowanie,
 * wyłączone przy „Ogranicz ruch”. Czytnik ekranu słyszy „Wczytujemy…”.
 */
import { useEffect } from 'react';
import { StyleSheet, View, type DimensionValue } from 'react-native';
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';

import { Karta } from '@/komponenty/karta';
import { useKolory } from '@/wyglad/kolory';
import { MARGINES, ODSTEP } from '@/wyglad/odstepy';

function usePuls() {
  const bezRuchu = useReducedMotion();
  const przezroczystosc = useSharedValue(1);
  useEffect(() => {
    if (bezRuchu) return;
    przezroczystosc.set(withRepeat(withTiming(0.55, { duration: 900 }), -1, true));
  }, [bezRuchu, przezroczystosc]);
  return useAnimatedStyle(() => ({ opacity: przezroczystosc.get() }));
}

function Kreska({ szerokosc, wysokosc = 12 }: { szerokosc: DimensionValue; wysokosc?: number }) {
  const kolory = useKolory();
  return <View style={{ width: szerokosc, height: wysokosc, borderRadius: wysokosc / 2, backgroundColor: kolory.neutralneTlo }} />;
}

/** Karta z wierszami jak `WierszFaktury`: kółko, dwie linie, kwota. */
export function SzkieletListy({ wiersze = 5, etykieta = 'Wczytujemy faktury' }: { wiersze?: number; etykieta?: string }) {
  const kolory = useKolory();
  const puls = usePuls();
  return (
    // Pulsują tylko szare kształty; karta zostaje nieprzezroczysta (na gradiencie inaczej prześwituje).
    <View style={styles.odstep} accessible accessibilityRole="progressbar" accessibilityLabel={`${etykieta}…`}>
      <Animated.View style={[styles.naglowek, puls]}>
        <Kreska szerokosc={120} />
      </Animated.View>
      <Karta>
        <Animated.View style={puls}>
          {Array.from({ length: wiersze }, (_, i) => (
            <View key={i} style={styles.wiersz}>
              <View style={[styles.kolo, { backgroundColor: kolory.neutralneTlo }]} />
              <View style={styles.linie}>
                <Kreska szerokosc={i % 2 === 0 ? '70%' : '55%'} wysokosc={14} />
                <Kreska szerokosc="40%" />
              </View>
              <Kreska szerokosc={72} wysokosc={14} />
            </View>
          ))}
        </Animated.View>
      </Karta>
    </View>
  );
}

/** Karta z dużą kwotą („Do zapłaty od klientów”) w czasie pierwszego wczytywania. */
export function SzkieletKwoty() {
  const puls = usePuls();
  return (
    <View style={styles.karta} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
      <Karta>
        <Animated.View style={[styles.trescKwoty, puls]}>
          <Kreska szerokosc={150} />
          <Kreska szerokosc={190} wysokosc={30} />
          <Kreska szerokosc="100%" wysokosc={8} />
        </Animated.View>
      </Karta>
    </View>
  );
}

const styles = StyleSheet.create({
  odstep: { marginTop: ODSTEP.l },
  naglowek: { paddingHorizontal: MARGINES + ODSTEP.xxs, paddingBottom: ODSTEP.s },
  wiersz: { flexDirection: 'row', alignItems: 'center', gap: ODSTEP.s, paddingHorizontal: MARGINES, minHeight: 66 },
  kolo: { width: 40, height: 40, borderRadius: 20 },
  linie: { flex: 1, gap: ODSTEP.xs },
  karta: { marginTop: ODSTEP.s },
  trescKwoty: { padding: MARGINES, gap: ODSTEP.s },
});

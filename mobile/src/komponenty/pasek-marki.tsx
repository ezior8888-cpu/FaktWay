/**
 * Górny pasek Pulpitu: logo FaktWay po lewej i okrągły awatar firmy po
 * prawej, jak nagłówek menu bocznego strony (`app-sidebar.tsx`: logo u góry)
 * i awatar użytkownika. Stoi nad przewijaną treścią, pod paskiem stanu, na
 * niebieskim gradiencie (plan aplikacji, D15): logo w wersji białej, awatar
 * biały na 20% bieli. Gradient przechodzi płynnie w ten pod treścią
 * (`EkranListy gradient="pod-paskiem"`), a przewijana treść chowa się pod
 * paskiem.
 */
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

import { LogoFaktWay } from '@/komponenty/logo';
import { Tekst } from '@/komponenty/tekst';
import { useKolory } from '@/wyglad/kolory';
import { CEL_DOTYKU, MARGINES, ODSTEP } from '@/wyglad/odstepy';

type Props = { inicjaly: string; etykietaAwatara: string; onAwatar: () => void };

export function PasekMarki({ inicjaly, etykietaAwatara, onAwatar }: Props) {
  const kolory = useKolory();
  const { top } = useSafeAreaInsets();
  // Wymiary mierzone wprost: SVG z rozmiarem w procentach źle się przeliczał po zmianie motywu (sprawdzone w symulatorze).
  const [rozmiar, setRozmiar] = useState({ w: 0, h: 0 });
  return (
    <View style={[styles.pasek, { paddingTop: top + ODSTEP.xs, backgroundColor: kolory.gradientSrodek }]} onLayout={(e) => setRozmiar({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}>
      <View style={StyleSheet.absoluteFill} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <Svg width={rozmiar.w} height={rozmiar.h}>
          <Defs>
            <LinearGradient id="gradient-paska" x1="0" y1="0" x2="0" y2="1">
              <Stop offset={0} stopColor={kolory.gradientGora} />
              <Stop offset={1} stopColor={kolory.gradientSrodek} />
            </LinearGradient>
          </Defs>
          <Rect x={0} y={0} width={rozmiar.w} height={rozmiar.h} fill="url(#gradient-paska)" />
        </Svg>
      </View>
      <LogoFaktWay wysokosc={24} biale />
      <Pressable
        onPress={onAwatar}
        accessibilityRole="button"
        accessibilityLabel={etykietaAwatara}
        hitSlop={ODSTEP.xs}
        android_ripple={{ color: kolory.falaNaAkcencie, borderless: true, radius: AWATAR / 2 + ODSTEP.xxs }}
        style={styles.dotyk}>
        <View style={[styles.awatar, { backgroundColor: kolory.naGradiencieTlo }]}>
          {/* Kółko ma stałą średnicę: inicjały rosną z dużym tekstem tylko trochę, pełną nazwę czyta etykieta. */}
          <Tekst styl="footnote" waga="semibold" kolor="naGradiencie" maxFontSizeMultiplier={1.3}>
            {inicjaly}
          </Tekst>
        </View>
      </Pressable>
    </View>
  );
}

const AWATAR = 36;

const styles = StyleSheet.create({
  pasek: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: MARGINES + ODSTEP.xxs,
    paddingBottom: ODSTEP.xs,
  },
  dotyk: { minWidth: CEL_DOTYKU, minHeight: CEL_DOTYKU, alignItems: 'flex-end', justifyContent: 'center' },
  awatar: { width: AWATAR, height: AWATAR, borderRadius: AWATAR / 2, alignItems: 'center', justifyContent: 'center' },
});

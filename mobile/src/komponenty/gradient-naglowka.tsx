/**
 * Miękki gradient pod nagłówkiem ekranu, jak w Copilocie (plan aplikacji,
 * D15; docs/mobile/ZASADY-DESIGNU.md, sekcja 4). Leży w przewijanej treści,
 * więc odjeżdża razem z nią; nad górną krawędzią treści (pod paskiem
 * nawigacji i przy pociągnięciu w dół) jest pełnym niebieskim. Znika w tle pod
 * pierwszą kartą ekranu (`GRADIENT.podTrescia`). Rysowany w SVG, bez nowej
 * paczki natywnej.
 */
import { StyleSheet, View } from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

import { useKolory } from '@/wyglad/kolory';
import { GRADIENT } from '@/wyglad/odstepy';
import { stopyPodPaskiemAndroid } from '@/wyglad/pasek-android';

/** Zapas nad treścią: pasek stanu, pasek nawigacji, duży tytuł i pociągnięcie w dół. */
const NAD = 900;

type Props = {
  /**
   * Pulpit: nad treścią stoi pasek marki z własnym gradientem (`PasekMarki`),
   * więc ten zaczyna się od koloru, na którym tamten się kończy.
   */
  podPaskiem?: boolean;
  /**
   * Gdzie w treści zaczyna się pierwsza karta, gdy nad nią stoi własny
   * nagłówek ekranu zamiast paska nawigacji (ekrany logowania).
   */
  odsuniecie?: number;
  /**
   * Android (M12): nad treścią stoi nieprzezroczysty pasek w kolorze
   * `gradientGora` (`useOpcjeGradientu`), więc gradient zaczyna się od niego.
   */
  podPaskiemAndroid?: boolean;
};

export function GradientNaglowka({ podPaskiem, odsuniecie = 0, podPaskiemAndroid }: Props) {
  const kolory = useKolory();
  const wysokosc = NAD + GRADIENT.podTrescia;
  const offset = (y: number) => Math.min(1, Math.max(0, (NAD + y) / wysokosc));
  // Punkty liczone od górnej krawędzi treści (y = 0); ujemne leżą pod paskiem nawigacji.
  const stopy = podPaskiemAndroid
    ? stopyPodPaskiemAndroid(NAD, GRADIENT.podTrescia).map((s) => ({ y: s.y, kolor: kolory[s.kolor] }))
    : podPaskiem
    ? [
        { y: -NAD, kolor: kolory.gradientSrodek },
        { y: 0, kolor: kolory.gradientSrodek },
        { y: GRADIENT.podTrescia * 0.35, kolor: kolory.gradientDol },
        { y: GRADIENT.podTrescia, kolor: kolory.tloGrupowane },
      ]
    : [
        { y: -NAD, kolor: kolory.gradientGora },
        { y: -GRADIENT.nadTrescia, kolor: kolory.gradientGora },
        { y: -GRADIENT.nadTrescia * 0.4, kolor: kolory.gradientSrodek },
        { y: GRADIENT.podTrescia * 0.35, kolor: kolory.gradientDol },
        { y: GRADIENT.podTrescia, kolor: kolory.tloGrupowane },
      ];
  return (
    <View
      pointerEvents="none"
      style={[styles.warstwa, { top: odsuniecie - NAD, height: wysokosc }]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants">
      <Svg width="100%" height="100%">
        <Defs>
          <LinearGradient id="gradient-naglowka" x1="0" y1="0" x2="0" y2="1">
            {stopy.map((s) => (
              <Stop key={s.y} offset={offset(s.y)} stopColor={s.kolor} />
            ))}
          </LinearGradient>
        </Defs>
        <Rect x={0} y={0} width="100%" height="100%" fill="url(#gradient-naglowka)" />
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  warstwa: { position: 'absolute', left: 0, right: 0 },
});

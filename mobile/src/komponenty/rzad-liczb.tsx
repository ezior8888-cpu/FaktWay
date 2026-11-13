/**
 * Rząd dwóch albo trzech liczb pod sobą z podpisami, rozdzielonych cienką
 * linią: zamiast osobnych kafli (plan aplikacji, D14; wzór Copilota). Przy
 * dużym tekście liczby stają jedna pod drugą.
 */
import { Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';

import { Tekst } from '@/komponenty/tekst';
import { useKolory, type Kolory } from '@/wyglad/kolory';
import { ODSTEP, SKALA_PIONOWA } from '@/wyglad/odstepy';

export type Liczba = { wartosc: string; podpis: string; kolor?: keyof Kolory; onPress?: () => void };

export function RzadLiczb({ liczby }: { liczby: Liczba[] }) {
  const kolory = useKolory();
  const { fontScale } = useWindowDimensions();
  const pionowo = fontScale >= SKALA_PIONOWA;
  return (
    <View style={pionowo ? styles.kolumna : styles.rzad}>
      {liczby.map((l, i) => {
        const tresc = (
          <>
            <Tekst styl="callout" waga="semibold" cyfry kolor={l.kolor ?? 'etykieta'} numberOfLines={pionowo ? 2 : 1} adjustsFontSizeToFit minimumFontScale={0.8}>
              {l.wartosc}
            </Tekst>
            <Tekst styl="caption1" kolor="etykietaDrugorzedna" style={pionowo ? null : styles.srodek} numberOfLines={pionowo ? 3 : 2}>
              {l.podpis}
            </Tekst>
          </>
        );
        const styl = [pionowo ? styles.pozycjaPionowa : styles.pozycja, !pionowo && i > 0 ? [styles.linia, { borderLeftColor: kolory.separator }] : null];
        return l.onPress ? (
          <Pressable key={l.podpis} onPress={l.onPress} accessibilityRole="button" accessibilityLabel={`${l.podpis}: ${l.wartosc}`} style={styl}>
            {tresc}
          </Pressable>
        ) : (
          <View key={l.podpis} accessible accessibilityLabel={`${l.podpis}: ${l.wartosc}`} style={styl}>
            {tresc}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  rzad: { flexDirection: 'row' },
  kolumna: { gap: ODSTEP.s },
  pozycja: { flex: 1, alignItems: 'center', gap: ODSTEP.linia, paddingHorizontal: ODSTEP.xxs },
  pozycjaPionowa: { gap: ODSTEP.linia },
  linia: { borderLeftWidth: StyleSheet.hairlineWidth },
  srodek: { textAlign: 'center' },
});

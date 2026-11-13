/**
 * Rząd akcji pod kwotą na szczególe dokumentu: białe pigułki z ikoną, jak
 * w Revolut Business (plan aplikacji, D14; WZORCE-MOBBIN.md 3.7). Zawija się
 * do kolejnej linii przy dużym tekście. Rzadsze akcje zostają w menu „…”.
 */
import { StyleSheet, View } from 'react-native';

import { Dotyk } from '@/komponenty/dotyk';
import { Ikona, type NazwaIkony } from '@/komponenty/ikona';
import { useStylKarty } from '@/komponenty/karta';
import { Tekst } from '@/komponenty/tekst';
import { useKolory } from '@/wyglad/kolory';
import { CEL_DOTYKU, MARGINES, ODSTEP, PROMIEN_PIGULKI } from '@/wyglad/odstepy';

export type Akcja = { tytul: string; ikona: NazwaIkony; onPress: () => void };

export function RzadAkcji({ akcje }: { akcje: Akcja[] }) {
  const kolory = useKolory();
  const stylKarty = useStylKarty();
  return (
    <View style={styles.rzad}>
      {akcje.map((a) => (
        <Dotyk key={a.tytul} onPress={a.onPress} accessibilityRole="button" accessibilityLabel={a.tytul} style={[styles.pigulka, stylKarty, styles.ksztalt]}>
          <Ikona nazwa={a.ikona} rozmiar={18} kolor={kolory.akcent} />
          <Tekst styl="subheadline" waga="medium" numberOfLines={1}>
            {a.tytul}
          </Tekst>
        </Dotyk>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  rzad: { flexDirection: 'row', flexWrap: 'wrap', gap: ODSTEP.xs, marginHorizontal: MARGINES, marginTop: ODSTEP.m },
  pigulka: { flexDirection: 'row', alignItems: 'center', gap: ODSTEP.xxs + 2, minHeight: CEL_DOTYKU - ODSTEP.xxs, paddingHorizontal: ODSTEP.m - 2 },
  ksztalt: { borderRadius: PROMIEN_PIGULKI },
});

/**
 * Kafle wskaźników po dwa w rzędzie, jak podsumowania w Zdrowiu i Kondycji:
 * podpis, liczba, opcjonalny opis. Bez cieni i ramek; tło komórki listy.
 * Dotknięcie kafla prowadzi do szczegółu (jeśli jest dokąd).
 */
import { SymbolView, type SFSymbol } from 'expo-symbols';
import { Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';

import { Tekst } from '@/komponenty/tekst';
import { useKolory, type Kolory } from '@/wyglad/kolory';
import { MARGINES, ODSTEP, PROMIEN_SEKCJI, SKALA_PIONOWA } from '@/wyglad/odstepy';

export type Kafel = {
  klucz: string;
  podpis: string;
  wartosc: string;
  opis?: string;
  opisKolor?: keyof Kolory;
  ikona?: SFSymbol;
  ikonaKolor?: keyof Kolory;
  onPress?: () => void;
};

export function Kafle({ kafle }: { kafle: Kafel[] }) {
  const kolory = useKolory();
  const { fontScale } = useWindowDimensions();
  // Przy dużym tekście z ustawień jeden kafel w rzędzie, żeby podpisy się nie ucinały.
  const duzyTekst = fontScale >= SKALA_PIONOWA;
  return (
    <View style={styles.siatka}>
      {kafle.map((k) => (
        <Pressable
          key={k.klucz}
          onPress={k.onPress}
          disabled={!k.onPress}
          accessibilityRole={k.onPress ? 'button' : undefined}
          accessibilityLabel={[k.podpis, k.wartosc, k.opis].filter(Boolean).join(', ')}
          style={({ pressed }) => [styles.kafel, duzyTekst && styles.kafelSzeroki, { backgroundColor: pressed ? kolory.wypelnienie : kolory.tloKomorki }]}>
          <View style={styles.gora}>
            {k.ikona ? (
              <SymbolView name={k.ikona} size={17} tintColor={kolory[k.ikonaKolor ?? 'akcent'] as string} style={styles.ikona} />
            ) : null}
            <Tekst styl="subheadline" kolor="etykietaDrugorzedna" numberOfLines={duzyTekst ? 4 : 2} style={styles.podpis}>
              {k.podpis}
            </Tekst>
          </View>
          <Tekst styl="title2" cyfry numberOfLines={1} adjustsFontSizeToFit>
            {k.wartosc}
          </Tekst>
          {k.opis ? (
            <Tekst styl="footnote" kolor={k.opisKolor ?? 'etykietaDrugorzedna'} numberOfLines={duzyTekst ? 4 : 2}>
              {k.opis}
            </Tekst>
          ) : null}
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  siatka: { flexDirection: 'row', flexWrap: 'wrap', gap: ODSTEP.s, marginHorizontal: MARGINES, marginTop: ODSTEP.l },
  kafel: {
    flexBasis: '47%',
    flexGrow: 1,
    padding: ODSTEP.m,
    gap: ODSTEP.xxs,
    borderRadius: PROMIEN_SEKCJI - ODSTEP.xs,
    borderCurve: 'continuous',
  },
  kafelSzeroki: { flexBasis: '100%' },
  gora: { flexDirection: 'row', alignItems: 'center', gap: ODSTEP.xs },
  ikona: { width: 20, height: 20 },
  podpis: { flex: 1 },
});

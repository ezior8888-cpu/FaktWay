/**
 * Główna akcja ekranu w treści (D7: „Nowa faktura” to szeroki bloczek pod
 * sumą). Wykończenie jak w Copilocie (D15): rogi 16 pt, pełne tło w kolorze
 * marki; wariant drugorzędny jest tonalny (jasnoniebieskie tło, niebieski
 * napis), np. cofnięcie akcji albo druga droga. Na telefonie wyższy (cel
 * dotyku) i z animacją wciśnięcia na sprężynie.
 */
import { StyleSheet, View } from 'react-native';

import { Dotyk } from '@/komponenty/dotyk';
import { Ikona, type NazwaIkony } from '@/komponenty/ikona';
import { Tekst } from '@/komponenty/tekst';
import { useKolory } from '@/wyglad/kolory';
import { CEL_DOTYKU, ODSTEP, PROMIEN_PRZYCISKU } from '@/wyglad/odstepy';

export type PrzyciskGlownyProps = {
  tytul: string;
  ikona?: NazwaIkony;
  /** `glowny`: tło marki; `drugorzedny`: tonalny, jasnoniebieskie tło i niebieski napis. */
  wariant?: 'glowny' | 'drugorzedny';
  onPress: () => void;
};

export function PrzyciskGlowny({ tytul, ikona, wariant = 'glowny', onPress }: PrzyciskGlownyProps) {
  const kolory = useKolory();
  const glowny = wariant === 'glowny';
  const kolorTresci = glowny ? kolory.naAkcencie : kolory.akcentNaTle;
  return (
    <Dotyk
      onPress={onPress}
      wibracja={glowny}
      accessibilityRole="button"
      accessibilityLabel={tytul}
      style={[
        styles.przycisk,
        { backgroundColor: glowny ? kolory.akcentWypelnienie : kolory.akcentTlo },
      ]}>
      <View style={styles.tresc}>
        {ikona ? <Ikona nazwa={ikona} rozmiar={18} kolor={kolorTresci} /> : null}
        <Tekst styl="callout" waga="semibold" style={{ color: kolorTresci }} numberOfLines={2}>
          {tytul}
        </Tekst>
      </View>
    </Dotyk>
  );
}

const styles = StyleSheet.create({
  przycisk: {
    minHeight: CEL_DOTYKU + ODSTEP.xxs,
    borderRadius: PROMIEN_PRZYCISKU,
    paddingHorizontal: ODSTEP.m,
    paddingVertical: ODSTEP.s - 2,
    justifyContent: 'center',
  },
  tresc: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: ODSTEP.xs },
});

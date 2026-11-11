/**
 * Główna akcja ekranu w treści (D7: „Nowa faktura” to szeroki bloczek pod
 * sumą). Wygląd przycisku ze strony (`components/ui/button.tsx`): pełne tło
 * w kolorze marki albo obwódka, ostre rogi, średnia waga napisu. Na telefonie
 * wyższy (cel dotyku) i z animacją wciśnięcia na sprężynie.
 */
import { StyleSheet, View } from 'react-native';

import { Dotyk } from '@/komponenty/dotyk';
import { Ikona, type NazwaIkony } from '@/komponenty/ikona';
import { Tekst } from '@/komponenty/tekst';
import { useKolory } from '@/wyglad/kolory';
import { CEL_DOTYKU, OBWODKA, ODSTEP, PROMIEN } from '@/wyglad/odstepy';

export type PrzyciskGlownyProps = {
  tytul: string;
  ikona?: NazwaIkony;
  /** `glowny`: tło marki; `drugorzedny`: obwódka (wariant `outline` strony). */
  wariant?: 'glowny' | 'drugorzedny';
  onPress: () => void;
};

export function PrzyciskGlowny({ tytul, ikona, wariant = 'glowny', onPress }: PrzyciskGlownyProps) {
  const kolory = useKolory();
  const glowny = wariant === 'glowny';
  const kolorTresci = glowny ? kolory.naAkcencie : kolory.etykieta;
  return (
    <Dotyk
      onPress={onPress}
      wibracja={glowny}
      accessibilityRole="button"
      accessibilityLabel={tytul}
      style={[
        styles.przycisk,
        glowny
          ? { backgroundColor: kolory.akcentWypelnienie, borderColor: kolory.akcentWypelnienie }
          : { backgroundColor: kolory.tloKomorki, borderColor: kolory.obwodka },
      ]}>
      <View style={styles.tresc}>
        {ikona ? <Ikona nazwa={ikona} rozmiar={18} kolor={glowny ? kolorTresci : kolory.akcent} /> : null}
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
    borderRadius: PROMIEN,
    borderWidth: OBWODKA,
    paddingHorizontal: ODSTEP.m,
    paddingVertical: ODSTEP.s - 2,
    justifyContent: 'center',
  },
  tresc: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: ODSTEP.xs },
});

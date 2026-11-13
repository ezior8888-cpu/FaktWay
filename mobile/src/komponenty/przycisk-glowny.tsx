/**
 * Główna akcja ekranu w treści (D7: „Nowa faktura” to szeroki bloczek pod
 * sumą). Wykończenie jak w Copilocie (D15): rogi 16 pt, pełne tło w kolorze
 * marki; wariant drugorzędny jest tonalny (jasnoniebieskie tło, niebieski
 * napis), np. cofnięcie akcji albo druga droga. Na telefonie wyższy (cel
 * dotyku) i z animacją wciśnięcia na sprężynie.
 *
 * Od M5 (logowanie): `karta` to biały przycisk z cieniem karty dla drugiej
 * drogi na tle ekranu („Zaloguj przez Google”), `naGradiencie` to biały
 * przycisk na pełnym gradiencie marki (ekran blokady). `trwa` pokazuje
 * kółko ładowania zamiast napisu i blokuje ponowne dotknięcie.
 */
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { Dotyk } from '@/komponenty/dotyk';
import { Ikona, type NazwaIkony } from '@/komponenty/ikona';
import { Tekst } from '@/komponenty/tekst';
import { useCiemny, useKolory, type Kolory } from '@/wyglad/kolory';
import { CEL_DOTYKU, CIEN_KARTY, ODSTEP, PROMIEN_PRZYCISKU } from '@/wyglad/odstepy';

export type PrzyciskGlownyProps = {
  tytul: string;
  ikona?: NazwaIkony;
  /**
   * `glowny`: tło marki; `drugorzedny`: tonalny, jasnoniebieskie tło i niebieski
   * napis; `karta`: biały z cieniem karty; `naGradiencie`: biały na gradiencie.
   */
  wariant?: Wariant;
  /** Trwa akcja (logowanie, wysyłka): kółko zamiast napisu, dotknięcie nic nie robi. */
  trwa?: boolean;
  onPress: () => void;
};

type Wariant = 'glowny' | 'drugorzedny' | 'karta' | 'naGradiencie';

const KOLORY: Record<Wariant, { tlo: keyof Kolory; tresc: keyof Kolory }> = {
  glowny: { tlo: 'akcentWypelnienie', tresc: 'naAkcencie' },
  drugorzedny: { tlo: 'akcentTlo', tresc: 'akcentNaTle' },
  karta: { tlo: 'tloKomorki', tresc: 'etykieta' },
  naGradiencie: { tlo: 'naGradiencie', tresc: 'gradientGora' },
};

export function PrzyciskGlowny({ tytul, ikona, wariant = 'glowny', trwa, onPress }: PrzyciskGlownyProps) {
  const kolory = useKolory();
  const ciemny = useCiemny();
  const kolorTresci = kolory[KOLORY[wariant].tresc];
  return (
    <Dotyk
      onPress={trwa ? undefined : onPress}
      wibracja={wariant === 'glowny' && !trwa}
      accessibilityRole="button"
      accessibilityLabel={tytul}
      accessibilityState={{ busy: Boolean(trwa) }}
      style={[
        styles.przycisk,
        { backgroundColor: kolory[KOLORY[wariant].tlo] },
        wariant === 'karta' && !ciemny ? { boxShadow: CIEN_KARTY } : null,
      ]}>
      <View style={styles.tresc}>
        {trwa ? (
          <ActivityIndicator color={kolorTresci} />
        ) : (
          <>
            {ikona ? <Ikona nazwa={ikona} rozmiar={18} kolor={kolorTresci} /> : null}
            <Tekst styl="callout" waga="semibold" style={[styles.napis, { color: kolorTresci }]} numberOfLines={2}>
              {tytul}
            </Tekst>
          </>
        )}
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
  napis: { textAlign: 'center', flexShrink: 1 },
});

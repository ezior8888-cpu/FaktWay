/**
 * Główna akcja ekranu w treści (Android i pozostałe): wypełniony przycisk
 * Material. Wersja iOS w `przycisk-glowny.ios.tsx`.
 */
import type { SFSymbol } from 'expo-symbols';
import { Pressable, StyleSheet } from 'react-native';

import { Tekst } from '@/komponenty/tekst';
import { useKolory } from '@/wyglad/kolory';
import { CEL_DOTYKU, ODSTEP } from '@/wyglad/odstepy';

export type PrzyciskGlownyProps = {
  tytul: string;
  ikona?: SFSymbol;
  wariant?: 'glowny' | 'drugorzedny';
  onPress: () => void;
};

export function PrzyciskGlowny({ tytul, wariant = 'glowny', onPress }: PrzyciskGlownyProps) {
  const kolory = useKolory();
  const glowny = wariant === 'glowny';
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      android_ripple={{ color: kolory.wypelnienie as string }}
      style={[styles.przycisk, { backgroundColor: glowny ? kolory.akcentWypelnienie : kolory.wypelnienie }]}>
      <Tekst styl="headline" kolor="akcent" style={glowny ? styles.naWypelnieniu : null}>
        {tytul}
      </Tekst>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // Biały napis na wypełnieniu akcentu w obu trybach (jak `akcentWypelnienie`).
  naWypelnieniu: { color: '#FFFFFF' },
  przycisk: {
    minHeight: CEL_DOTYKU + ODSTEP.xxs,
    borderRadius: CEL_DOTYKU,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: ODSTEP.l,
  },
});

/**
 * Pasek „Cofnij” nad paskiem zakładek po zmianie, którą łatwo zrobić przez
 * przypadek (gest „Zapłacona”, menu wiersza): przez 5 sekund mówi, co się
 * stało, i pozwala to odwrócić (ZASADY-DESIGNU.md, sekcja 5; WZORCE-MOBBIN.md
 * 8.5). Czytnik ekranu dostaje ten sam komunikat.
 */
import { useEffect } from 'react';
import { AccessibilityInfo, Pressable, StyleSheet, View } from 'react-native';
import Animated, { FadeInDown, FadeOutDown } from 'react-native-reanimated';

import { Tekst } from '@/komponenty/tekst';
import { useStanFaktur } from '@/stan/faktury';
import { useKolory } from '@/wyglad/kolory';
import { CEL_DOTYKU, MARGINES, ODSTEP, PROMIEN_PRZYCISKU } from '@/wyglad/odstepy';

const CZAS_MS = 5000;
/** Nad pływającym paskiem zakładek iOS 26 (około 64 pt i margines dolny). */
const NAD_ZAKLADKAMI = 100;

export function PasekCofnij() {
  const kolory = useKolory();
  const { cofnij, pokazCofnij } = useStanFaktur();

  useEffect(() => {
    if (!cofnij) return;
    AccessibilityInfo.announceForAccessibility(cofnij.przycisk ? cofnij.tekst : `${cofnij.tekst}. Możesz cofnąć.`);
    const t = setTimeout(() => pokazCofnij(undefined), CZAS_MS);
    return () => clearTimeout(t);
  }, [cofnij, pokazCofnij]);

  if (!cofnij) return null;
  return (
    <Animated.View key={cofnij.id} entering={FadeInDown} exiting={FadeOutDown} style={styles.oslona} pointerEvents="box-none">
      <View style={[styles.pasek, { backgroundColor: kolory.etykieta }]}>
        <Tekst styl="subheadline" style={[styles.tekst, { color: kolory.tloKomorki }]} numberOfLines={2}>
          {cofnij.tekst}
        </Tekst>
        <Pressable
          onPress={() => {
            cofnij.akcja();
            pokazCofnij(undefined);
          }}
          accessibilityRole="button"
          accessibilityLabel={cofnij.przycisk ?? 'Cofnij'}
          hitSlop={ODSTEP.xs}
          android_ripple={{ color: kolory.falaNaAkcencie, borderless: true }}
          style={styles.cofnij}>
          <Tekst styl="subheadline" waga="semibold" style={{ color: kolory.tloKomorki }}>
            {cofnij.przycisk ?? 'Cofnij'}
          </Tekst>
        </Pressable>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  oslona: { position: 'absolute', left: MARGINES, right: MARGINES, bottom: NAD_ZAKLADKAMI },
  pasek: { flexDirection: 'row', alignItems: 'center', gap: ODSTEP.s, borderRadius: PROMIEN_PRZYCISKU, paddingLeft: ODSTEP.m, paddingRight: ODSTEP.xs, minHeight: CEL_DOTYKU + ODSTEP.xxs },
  tekst: { flex: 1 },
  cofnij: { minHeight: CEL_DOTYKU, paddingHorizontal: ODSTEP.s, justifyContent: 'center' },
});

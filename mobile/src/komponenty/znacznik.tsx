/**
 * Plakietka statusu jak na stronie (`components/invoices/status-badge.tsx`):
 * tekst w kolorze roli na jej 10% tle, mocno zaokrąglona (D15). Status niesie
 * napis, nie sam kolor; kręcące się kółko mówi, że coś trwa (np. wysyłka do KSeF).
 */
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { Easing, cancelAnimation, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';

import { Ikona } from '@/komponenty/ikona';
import { Tekst } from '@/komponenty/tekst';
import { kolorTonu, useKolory, type Ton } from '@/wyglad/kolory';
import { ODSTEP, PROMIEN_POLA } from '@/wyglad/odstepy';

type Props = { ton: Ton; children: string; trwa?: boolean };

export function Znacznik({ ton, children, trwa }: Props) {
  const kolory = useKolory();
  const { tekst, tlo } = kolorTonu(kolory, ton);
  return (
    <View style={[styles.znacznik, { backgroundColor: tlo }]}>
      {trwa ? <Krecace kolor={tekst} /> : null}
      <Tekst styl="caption1" waga="medium" style={[styles.napis, { color: tekst }]} numberOfLines={2}>
        {children}
      </Tekst>
    </View>
  );
}

function Krecace({ kolor }: { kolor: string }) {
  const obrot = useSharedValue(0);
  useEffect(() => {
    obrot.set(withRepeat(withTiming(360, { duration: 900, easing: Easing.linear }), -1));
    return () => cancelAnimation(obrot);
  }, [obrot]);
  const styl = useAnimatedStyle(() => ({ transform: [{ rotate: `${obrot.value}deg` }] }));
  return (
    <Animated.View style={styl}>
      <Ikona nazwa="loader4-line" rozmiar={12} kolor={kolor} />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  napis: { flexShrink: 1 },
  znacznik: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: ODSTEP.xxs,
    paddingHorizontal: ODSTEP.xs,
    paddingVertical: ODSTEP.linia,
    // 12 pt: w jednej linii wygląda jak pigułka, zawinięty opis nie robi się owalem.
    borderRadius: PROMIEN_POLA,
  },
});

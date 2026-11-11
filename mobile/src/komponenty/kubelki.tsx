/**
 * Wiek należności jak karta „Należności” pulpitu strony
 * (`components/dashboard/pulpit/receivables-aging-card.tsx`): kolumny
 * z linią między nimi (na stronie przerywaną), w każdej podpis, procent i słupek, który
 * płynnie rośnie od dołu. Kolor mówi o terminie, procent mówi wszystko.
 */
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { Tekst } from '@/komponenty/tekst';
import { useKolory, type Kolory } from '@/wyglad/kolory';
import { MARGINES, ODSTEP, PROMIEN } from '@/wyglad/odstepy';

export type Kubelek = { podpis: string; procent: number; kwota: string; kolor: keyof Kolory };

const WYSOKOSC = 72;

export function Kubelki({ kubelki }: { kubelki: Kubelek[] }) {
  const kolory = useKolory();
  return (
    <View style={styles.rzad} accessible accessibilityLabel={kubelki.map((k) => `${k.podpis}: ${k.procent}%, ${k.kwota}`).join('; ')}>
      {kubelki.map((k, i) => (
        <View key={k.podpis} style={[styles.kolumna, i > 0 ? { borderLeftColor: kolory.separator, borderLeftWidth: 1 } : null]}>
          <Tekst styl="caption1" kolor="etykietaDrugorzedna" numberOfLines={2}>
            {k.podpis}
          </Tekst>
          <Tekst styl="title2" cyfry>
            {`${k.procent}%`}
          </Tekst>
          <View style={styles.miejsceSlupka}>
            <Slupek procent={k.procent} kolor={kolory[k.kolor]} tlo={kolory.neutralneTlo} />
          </View>
          <Tekst styl="caption1" kolor="etykietaDrugorzedna" cyfry numberOfLines={1}>
            {k.kwota}
          </Tekst>
        </View>
      ))}
    </View>
  );
}

function Slupek({ procent, kolor, tlo }: { procent: number; kolor: string; tlo: string }) {
  const wys = useSharedValue(0);
  useEffect(() => {
    // Zero to brak słupka: cienka kreska przy 0% sugerowałaby zaległość, której nie ma.
    wys.set(withTiming(procent > 0 ? Math.max(3, (WYSOKOSC * procent) / 100) : 0, { duration: 650, easing: Easing.out(Easing.cubic) }));
  }, [procent, wys]);
  const styl = useAnimatedStyle(() => ({ height: wys.value }));
  return (
    <View style={[styles.tor, { backgroundColor: tlo }]}>
      <Animated.View style={[styles.slupek, { backgroundColor: kolor }, styl]} />
    </View>
  );
}

const styles = StyleSheet.create({
  rzad: { flexDirection: 'row', paddingHorizontal: MARGINES - ODSTEP.xs, paddingVertical: ODSTEP.s },
  kolumna: { flex: 1, paddingHorizontal: ODSTEP.xs, gap: ODSTEP.xxs },
  miejsceSlupka: { height: WYSOKOSC, justifyContent: 'flex-end', marginVertical: ODSTEP.xxs },
  tor: { height: WYSOKOSC, justifyContent: 'flex-end', borderRadius: PROMIEN, overflow: 'hidden' },
  slupek: { width: '100%', borderRadius: PROMIEN },
});

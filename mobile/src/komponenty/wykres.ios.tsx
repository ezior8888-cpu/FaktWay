/**
 * Wykres na iOS: natywne Swift Charts przez `@expo/ui/swift-ui`.
 * Wersja dla Androida w `wykres.tsx`.
 */
import { Host } from '@expo/ui';
import { Chart } from '@expo/ui/swift-ui';
import { StyleSheet, View } from 'react-native';

import { useKolory } from '@/wyglad/kolory';
import { MARGINES, ODSTEP, PROMIEN_SEKCJI } from '@/wyglad/odstepy';

import type { WykresProps } from './wykres-typy';

export function Wykres({ punkty, rodzaj = 'slupki', wysokosc = 180, etykieta }: WykresProps) {
  const kolory = useKolory();
  return (
    <View
      style={[styles.ramka, { backgroundColor: kolory.tloKomorki }]}
      accessible
      accessibilityLabel={etykieta ?? punkty.map((p) => `${p.x}: ${p.opis ?? p.y}`).join(', ')}>
      <Host style={{ height: wysokosc }}>
        <Chart
          type={rodzaj === 'linia' ? 'line' : rodzaj === 'pole' ? 'area' : rodzaj === 'kolo' ? 'pie' : 'bar'}
          data={punkty.map((p) => ({ x: p.x, y: p.y, color: p.kolor ? kolory[p.kolor] : kolory.akcent }))}
          showGrid
          animate={false}
          barStyle={{ cornerRadius: 6 }}
          pieStyle={{ innerRadius: 0.6, angularInset: 1.5, cornerRadius: 4 }}
          showLegend={rodzaj === 'kolo'}
          lineStyle={{ width: 3, color: kolory.akcent, pointStyle: 'circle', pointSize: 6 }}
          areaStyle={{ color: kolory.akcent }}
        />
      </Host>
    </View>
  );
}

const styles = StyleSheet.create({
  ramka: {
    marginHorizontal: MARGINES,
    padding: ODSTEP.m,
    borderRadius: PROMIEN_SEKCJI,
    borderCurve: 'continuous',
  },
});

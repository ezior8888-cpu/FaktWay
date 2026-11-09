/**
 * Wykres na Androidzie: proste słupki z widoków (Compose Charts dochodzą
 * w etapie Androida, M12). Wersja iOS w `wykres.ios.tsx` (Swift Charts).
 */
import { StyleSheet, View } from 'react-native';

import { Tekst } from '@/komponenty/tekst';
import { useKolory } from '@/wyglad/kolory';
import { MARGINES, ODSTEP, PROMIEN_SEKCJI } from '@/wyglad/odstepy';

import type { WykresProps } from './wykres-typy';

export function Wykres({ punkty, wysokosc = 180, etykieta }: WykresProps) {
  const kolory = useKolory();
  const max = Math.max(1, ...punkty.map((p) => Math.abs(p.y)));
  return (
    <View
      style={[styles.ramka, { backgroundColor: kolory.tloKomorki, height: wysokosc + ODSTEP.xxl * 2 }]}
      accessible
      accessibilityLabel={etykieta ?? punkty.map((p) => `${p.x}: ${p.opis ?? p.y}`).join(', ')}>
      <View style={styles.slupki}>
        {punkty.map((p) => (
          <View key={p.x} style={styles.kolumna}>
            <View
              style={{
                height: (Math.abs(p.y) / max) * wysokosc,
                backgroundColor: p.kolor ? kolory[p.kolor] : kolory.akcent,
                borderRadius: ODSTEP.xxs,
              }}
            />
            <Tekst styl="caption2" kolor="etykietaDrugorzedna" numberOfLines={1}>
              {p.x}
            </Tekst>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  ramka: { marginHorizontal: MARGINES, padding: ODSTEP.m, borderRadius: PROMIEN_SEKCJI },
  slupki: { flex: 1, flexDirection: 'row', alignItems: 'flex-end', gap: ODSTEP.xs },
  kolumna: { flex: 1, alignItems: 'stretch', gap: ODSTEP.xxs },
});

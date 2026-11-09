/**
 * Kalendarz aktywności z 26 tygodni (odpowiednik „Kalendarza sprzedaży”
 * i „Kalendarza wydatków” ze strony): kolumny to tygodnie, wiersze dni od
 * poniedziałku. Natężenie koloru akcentu = liczba dokumentów w dniu.
 */
import { StyleSheet, View } from 'react-native';

import { Tekst } from '@/komponenty/tekst';
import { useKolory } from '@/wyglad/kolory';
import { MARGINES, ODSTEP, PROMIEN_SEKCJI } from '@/wyglad/odstepy';

const DNI = ['P', 'W', 'Ś', 'C', 'P', 'S', 'N'];
const NATEZENIE = [0, 0.25, 0.45, 0.7, 1];

export function Kalendarz({ dni, etykieta }: { dni: number[]; etykieta: string }) {
  const kolory = useKolory();
  const tygodnie = Math.ceil(dni.length / 7);
  return (
    <View style={[styles.ramka, { backgroundColor: kolory.tloKomorki }]} accessible accessibilityLabel={etykieta}>
      <View style={styles.dni}>
        {DNI.map((d, i) => (
          <Tekst key={i} styl="caption2" kolor="etykietaDrugorzedna" style={styles.dzien}>
            {d}
          </Tekst>
        ))}
      </View>
      <View style={styles.siatka}>
        {Array.from({ length: tygodnie }, (_, t) => (
          <View key={t} style={styles.tydzien}>
            {Array.from({ length: 7 }, (_, d) => {
              const poziom = dni[t * 7 + d] ?? 0;
              return (
                <View
                  key={d}
                  style={[
                    styles.kratka,
                    poziom === 0
                      ? { backgroundColor: kolory.wypelnienie }
                      : { backgroundColor: kolory.akcent, opacity: NATEZENIE[poziom] },
                  ]}
                />
              );
            })}
          </View>
        ))}
      </View>
    </View>
  );
}

const KRATKA = 9;

const styles = StyleSheet.create({
  ramka: {
    flexDirection: 'row',
    gap: ODSTEP.xs,
    marginHorizontal: MARGINES,
    padding: ODSTEP.m,
    borderRadius: PROMIEN_SEKCJI,
    borderCurve: 'continuous',
  },
  dni: { justifyContent: 'space-between' },
  dzien: { height: KRATKA, lineHeight: KRATKA },
  siatka: { flex: 1, flexDirection: 'row', justifyContent: 'space-between' },
  tydzien: { gap: ODSTEP.linia },
  kratka: { width: KRATKA, height: KRATKA, borderRadius: ODSTEP.linia },
});

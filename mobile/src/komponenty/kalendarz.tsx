/**
 * Kalendarz aktywności z 26 tygodni (odpowiednik „Kalendarza sprzedaży”
 * i „Kalendarza wydatków” ze strony): kolumny to tygodnie, wiersze dni od
 * poniedziałku. Natężenie niebieskiego marki = liczba dokumentów w dniu.
 */
import { StyleSheet, View } from 'react-native';

import { Tekst } from '@/komponenty/tekst';
import { useKolory } from '@/wyglad/kolory';
import { ODSTEP } from '@/wyglad/odstepy';

const DNI = ['P', 'W', 'Ś', 'C', 'P', 'S', 'N'];
const NATEZENIE = [0, 0.25, 0.45, 0.7, 1];

export function Kalendarz({ dni, etykieta }: { dni: number[]; etykieta: string }) {
  const kolory = useKolory();
  const tygodnie = Math.ceil(dni.length / 7);
  return (
    <View style={styles.ramka} accessible accessibilityLabel={etykieta}>
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
                    poziom === 0 ? { backgroundColor: kolory.neutralneTlo } : { backgroundColor: kolory.wykres2, opacity: NATEZENIE[poziom] },
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
  // Leży w karcie `Sekcja swobodna`, która daje tło i margines.
  ramka: { flexDirection: 'row', gap: ODSTEP.xs },
  dni: { justifyContent: 'space-between' },
  dzien: { height: KRATKA, lineHeight: KRATKA },
  siatka: { flex: 1, flexDirection: 'row', justifyContent: 'space-between' },
  tydzien: { gap: ODSTEP.linia },
  kratka: { width: KRATKA, height: KRATKA, borderRadius: 1 },
});

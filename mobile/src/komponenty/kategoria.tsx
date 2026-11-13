/**
 * Plakietka kategorii kosztu w kolorze tonu (plan aplikacji, D15; ZASADY-
 * DESIGNU.md, sekcja 4): wersaliki na jasnym tle tonu, kształt pigułki.
 * Kolor rozróżnia kategorie na liście i nic nie mówi o podatku; status ma
 * zwykłe litery (`Znacznik`), więc się z nim nie myli.
 */
import { StyleSheet, View } from 'react-native';

import { Tekst } from '@/komponenty/tekst';
import { kolorKategorii, useCiemny, useKolory } from '@/wyglad/kolory';
import { ODSTEP, PROMIEN_PIGULKI } from '@/wyglad/odstepy';

export function Kategoria({ nazwa }: { nazwa: string }) {
  const kolory = useKolory();
  const ciemny = useCiemny();
  const { tekst, tlo } = kolorKategorii(kolory, ciemny, nazwa);
  return (
    <View style={[styles.plakietka, { backgroundColor: tlo }]}>
      <Tekst styl="caption2" waga="semibold" style={[styles.napis, { color: tekst }]} numberOfLines={1}>
        {nazwa}
      </Tekst>
    </View>
  );
}

const styles = StyleSheet.create({
  plakietka: { alignSelf: 'flex-start', borderRadius: PROMIEN_PIGULKI, paddingHorizontal: ODSTEP.xs, paddingVertical: ODSTEP.linia },
  napis: { textTransform: 'uppercase', letterSpacing: 0.4 },
});

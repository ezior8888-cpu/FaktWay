import { StyleSheet, View } from 'react-native';

import { KoloIkony, type NazwaIkony } from '@/komponenty/ikona';
import { Tekst } from '@/komponenty/tekst';
import { ODSTEP } from '@/wyglad/odstepy';

type Props = { ikona: NazwaIkony; tytul: string; opis: string };

/** Pusty ekran: okrągła ikona marki, jedno zdanie, bez ozdobników (ZASADY-DESIGNU.md, sekcja 5). */
export function StanPusty({ ikona, tytul, opis }: Props) {
  return (
    <View style={styles.kontener} accessible accessibilityLabel={`${tytul}. ${opis}`}>
      <View style={styles.ikona}>
        <KoloIkony nazwa={ikona} rozmiar={56} />
      </View>
      <Tekst styl="title3" style={styles.srodek}>
        {tytul}
      </Tekst>
      <Tekst styl="subheadline" kolor="etykietaDrugorzedna" style={styles.srodek}>
        {opis}
      </Tekst>
    </View>
  );
}

const styles = StyleSheet.create({
  kontener: { alignItems: 'center', paddingHorizontal: ODSTEP.xxl, paddingTop: ODSTEP.xxl * 2, gap: ODSTEP.xs },
  ikona: { marginBottom: ODSTEP.xs },
  srodek: { textAlign: 'center' },
});

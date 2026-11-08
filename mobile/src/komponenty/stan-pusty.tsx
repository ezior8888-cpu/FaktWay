import { SymbolView, type SFSymbol } from 'expo-symbols';
import { StyleSheet, View } from 'react-native';

import { Tekst } from '@/komponenty/tekst';
import { useKolory } from '@/wyglad/kolory';
import { ODSTEP } from '@/wyglad/odstepy';

type Props = { ikona: SFSymbol; tytul: string; opis: string };

/** Pusty ekran: ikona, jedno zdanie, bez ozdobników (ZASADY-DESIGNU.md, sekcja 5). */
export function StanPusty({ ikona, tytul, opis }: Props) {
  const kolory = useKolory();
  return (
    <View style={styles.kontener} accessible accessibilityLabel={`${tytul}. ${opis}`}>
      <SymbolView name={ikona} size={44} tintColor={kolory.etykietaTrzeciorzedna as string} style={styles.ikona} />
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
  ikona: { width: 52, height: 52, marginBottom: ODSTEP.xs },
  srodek: { textAlign: 'center' },
});

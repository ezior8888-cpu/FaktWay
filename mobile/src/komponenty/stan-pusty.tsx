import { StyleSheet, View } from 'react-native';

import { KoloIkony, type NazwaIkony } from '@/komponenty/ikona';
import { PrzyciskGlowny } from '@/komponenty/przycisk-glowny';
import { Tekst } from '@/komponenty/tekst';
import { ODSTEP } from '@/wyglad/odstepy';

type Props = {
  ikona: NazwaIkony;
  tytul: string;
  opis: string;
  /** Jedna akcja, która wyprowadza z pustego stanu (np. „Wyczyść filtry”, „Dodaj wydatek”). */
  akcja?: { tytul: string; onPress: () => void };
};

/**
 * Pusty ekran: okrągła ikona marki, jedno zdanie i jedna akcja, bez ozdobników
 * (ZASADY-DESIGNU.md, sekcja 5; WZORCE-MOBBIN.md 8.2). Stoi tuż pod
 * przełącznikiem widoku, nie w połowie ekranu.
 */
export function StanPusty({ ikona, tytul, opis, akcja }: Props) {
  return (
    <View style={styles.kontener}>
      <View accessible accessibilityLabel={`${tytul}. ${opis}`} style={styles.tresc}>
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
      {akcja ? (
        <View style={styles.akcja}>
          <PrzyciskGlowny tytul={akcja.tytul} wariant="drugorzedny" onPress={akcja.onPress} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  kontener: { paddingHorizontal: ODSTEP.xxl, paddingTop: ODSTEP.xxl, gap: ODSTEP.m },
  tresc: { alignItems: 'center', gap: ODSTEP.xs },
  ikona: { marginBottom: ODSTEP.xs },
  srodek: { textAlign: 'center' },
  akcja: { alignSelf: 'stretch' },
});

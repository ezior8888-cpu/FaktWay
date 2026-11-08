import { useLocalSearchParams } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { KOSZTY } from '@/dane-przykladowe';
import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { StanPusty } from '@/komponenty/stan-pusty';
import { Tekst } from '@/komponenty/tekst';
import { dataPelna, kwota } from '@/lib/format';
import { MARGINES, ODSTEP } from '@/wyglad/odstepy';

export default function EkranKosztu() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const k = KOSZTY.find((x) => x.id === id);

  if (!k) {
    return (
      <EkranListy>
        <StanPusty ikona="doc.questionmark" tytul="Nie ma takiego kosztu" opis="Mógł zostać usunięty na komputerze." />
      </EkranListy>
    );
  }

  return (
    <EkranListy>
      <View style={styles.naglowek}>
        <Tekst styl="headline" selectable>
          {k.dostawca}
        </Tekst>
        <Tekst styl="largeTitle" cyfry selectable>
          {kwota(k.brutto)}
        </Tekst>
        <Tekst styl="subheadline" kolor={k.doOpisania ? 'ostrzezenie' : 'etykietaDrugorzedna'}>
          {k.doOpisania ? 'Do opisania' : 'W ewidencji'}
        </Tekst>
      </View>
      <Sekcja naglowek="Szczegóły">
        <Wiersz tytul="Opis" wartosc={k.opis} />
        <Wiersz tytul="Data" wartosc={dataPelna(k.data)} />
        <Wiersz tytul="Źródło" wartosc={k.zrodlo === 'ksef' ? 'KSeF' : 'Zdjęcie paragonu'} />
      </Sekcja>
    </EkranListy>
  );
}

const styles = StyleSheet.create({
  naglowek: { paddingHorizontal: MARGINES + ODSTEP.xxs, paddingTop: ODSTEP.m, gap: ODSTEP.xxs },
});

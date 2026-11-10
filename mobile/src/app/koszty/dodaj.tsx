import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { DZIS, NOWY_WYDATEK, type Koszt } from '@/dane-przykladowe';
import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { Tekst } from '@/komponenty/tekst';
import { useStanFaktur } from '@/stan/faktury';
import { MARGINES, ODSTEP } from '@/wyglad/odstepy';

type Etap = 'wybor' | 'wgrywanie' | 'rozpoznaje';

/** Odczyt przykładowego paragonu (na stronie: OCR, `use-expense-capture.tsx`). */
const ROZPOZNANY: Koszt = {
  id: '',
  dostawca: 'Stacja Paliw Rondo',
  nip: '1234567890',
  opis: 'Paliwo',
  data: DZIS,
  netto: 16_260,
  brutto: 20_000,
  zrodlo: 'zdjecie',
  doOpisania: true,
  kategoria: 'Paliwo',
  kolumna: '13',
  dokument: 'Paragon',
  numer: '0051/2026',
  wKpir: true,
};

/**
 * Arkusz „Dodaj wydatek”: zdjęcie albo plik, potem odczyt danych i ekran
 * akceptacji. Na danych przykładowych odczyt daje zawsze ten sam paragon;
 * aparat i galerię podłącza etap M9.
 */
export default function EkranDodawaniaWydatku() {
  const router = useRouter();
  const { zapiszKoszt } = useStanFaktur();
  const [etap, setEtap] = useState<Etap>('wybor');
  // Arkusz zamknięty w trakcie odczytu: bez zapisu wydatku i bez przejścia w tle.
  const zegary = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => zegary.current.forEach(clearTimeout), []);

  const odczytaj = () => {
    setEtap('wgrywanie');
    zegary.current.push(setTimeout(() => setEtap('rozpoznaje'), 700));
    zegary.current.push(setTimeout(() => {
      const id = zapiszKoszt(ROZPOZNANY);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.replace({ pathname: '/koszty/[id]', params: { id } });
    }, 1900));
  };

  // Pusty formularz; wydatek powstaje dopiero po „Zapisz” (wyjście bez zapisu nie zostawia pustego wiersza).
  const reczny = () => router.replace({ pathname: '/koszty/[id]', params: { id: NOWY_WYDATEK } });

  if (etap !== 'wybor') {
    return (
      <View style={styles.czekanie} accessible accessibilityLiveRegion="polite" accessibilityLabel={etap === 'wgrywanie' ? 'Wgrywanie' : 'Rozpoznaję dane'}>
        <ActivityIndicator />
        <Tekst styl="headline">{etap === 'wgrywanie' ? 'Wgrywanie…' : 'Rozpoznaję…'}</Tekst>
        <Tekst styl="subheadline" kolor="etykietaDrugorzedna">
          Odczytujemy sprzedawcę, datę i kwoty.
        </Tekst>
      </View>
    );
  }

  return (
    <EkranListy>
      <Sekcja stopka="Zdjęcie paragonu albo faktury: dane odczytamy sami. Potem tylko sprawdzasz i zatwierdzasz.">
        <Wiersz tytul="Zrób zdjęcie" ikona="camera-line" strzalka onPress={odczytaj} />
        <Wiersz tytul="Wybierz z galerii" podtytul="Zdjęcie lub PDF z plików" ikona="image-line" strzalka onPress={odczytaj} />
        <Wiersz tytul="Wpisz ręcznie" ikona="edit-box-line" strzalka onPress={reczny} />
      </Sekcja>
    </EkranListy>
  );
}

const styles = StyleSheet.create({
  czekanie: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: ODSTEP.s, paddingHorizontal: MARGINES * 2 },
});

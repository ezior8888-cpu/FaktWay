import { SegmentedControl } from '@expo/ui/community/segmented-control';
import Constants from 'expo-constants';
import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { StyleSheet, Switch, View } from 'react-native';

import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { useStanFaktur, type WariantNowej } from '@/stan/faktury';
import { useKolory } from '@/wyglad/kolory';
import { MARGINES, ODSTEP } from '@/wyglad/odstepy';

const STRONA = 'https://faktway.pl';

const WARIANTY: { klucz: WariantNowej; nazwa: string }[] = [
  { klucz: 'pasek', nazwa: 'Plus u góry' },
  { klucz: 'pod-suma', nazwa: 'Pod sumą' },
  { klucz: 'nad-zakladkami', nazwa: 'Nad zakładkami' },
];

export default function EkranKonta() {
  const kolory = useKolory();
  const { wariantNowej, ustawWariantNowej } = useStanFaktur();
  // Blokadę Face ID podłącza etap M4; do tego czasu przełącznik pamięta tylko wybór.
  const [faceId, setFaceId] = useState(false);

  return (
    <EkranListy>
      <Sekcja naglowek="Firma">
        <Wiersz tytul="Pracownia Przykładowa Jan Kowalski" podtytul="NIP 1234567890" zaznaczalna />
      </Sekcja>

      <Sekcja naglowek="Bezpieczeństwo" stopka="Po włączeniu aplikacja poprosi o Face ID przy każdym otwarciu.">
        <Wiersz
          tytul="Blokada Face ID"
          prawaStrona={
            <Switch
              value={faceId}
              onValueChange={setFaceId}
              trackColor={{ true: kolory.akcent as string }}
              accessibilityLabel="Blokada Face ID"
            />
          }
        />
      </Sekcja>

      <Sekcja
        naglowek="Na komputerze"
        stopka="Ustawienia KSeF, import danych, eksporty i panel księgowej są na faktway.pl.">
        <Wiersz tytul="Otwórz faktway.pl" strzalka onPress={() => void WebBrowser.openBrowserAsync(STRONA)} />
      </Sekcja>

      <Sekcja
        naglowek="Do wyboru: przycisk „Nowa faktura”"
        stopka="Tymczasowe, na czas decyzji. Zmiana działa od razu na zakładce Faktury.">
        <View style={styles.wybor}>
          <SegmentedControl
            values={WARIANTY.map((w) => w.nazwa)}
            selectedIndex={WARIANTY.findIndex((w) => w.klucz === wariantNowej)}
            onChange={(e) => ustawWariantNowej(WARIANTY[e.nativeEvent.selectedSegmentIndex]?.klucz ?? 'pasek')}
            accessibilityLabel="Miejsce przycisku Nowa faktura"
          />
        </View>
      </Sekcja>

      <Sekcja stopka={`FaktWay ${Constants.expoConfig?.version ?? ''}, dane przykładowe`}>
        <Wiersz tytul="Wersja aplikacji" wartosc={Constants.expoConfig?.version ?? ''} />
      </Sekcja>
    </EkranListy>
  );
}

const styles = StyleSheet.create({
  wybor: { padding: MARGINES, paddingVertical: ODSTEP.s },
});

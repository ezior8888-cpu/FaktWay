import Constants from 'expo-constants';
import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { Alert, Switch } from 'react-native';

import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { useKolory } from '@/wyglad/kolory';

const STRONA = 'https://faktway.pl';

export default function EkranKonta() {
  const kolory = useKolory();
  // Etap M4 podłączy blokadę Face ID; tu tylko układ przełącznika.
  const [faceId, setFaceId] = useState(false);

  return (
    <EkranListy>
      <Sekcja naglowek="Firma">
        <Wiersz tytul="Pracownia Przykładowa Jan Kowalski" podtytul="NIP 1234567890" />
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

      <Sekcja stopka={`FaktWay ${Constants.expoConfig?.version ?? ''}, dane przykładowe`}>
        <Wiersz
          tytul="Wyloguj"
          niszczacy
          onPress={() => Alert.alert('Wylogowanie', 'Logowanie pojawi się w etapie M4.')}
        />
      </Sekcja>
    </EkranListy>
  );
}

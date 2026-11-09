import Constants from 'expo-constants';
import * as WebBrowser from 'expo-web-browser';

import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';

const STRONA = 'https://faktway.pl';

export default function EkranKonta() {
  return (
    <EkranListy>
      <Sekcja naglowek="Firma">
        <Wiersz tytul="Pracownia Przykładowa Jan Kowalski" podtytul="NIP 1234567890" zaznaczalna />
      </Sekcja>

      <Sekcja
        naglowek="Na komputerze"
        stopka="Ustawienia KSeF, import danych, eksporty i panel księgowej są na faktway.pl.">
        <Wiersz tytul="Otwórz faktway.pl" strzalka onPress={() => void WebBrowser.openBrowserAsync(STRONA)} />
      </Sekcja>

      <Sekcja stopka={`FaktWay ${Constants.expoConfig?.version ?? ''}, dane przykładowe`}>
        <Wiersz tytul="Wersja aplikacji" wartosc={Constants.expoConfig?.version ?? ''} />
      </Sekcja>
    </EkranListy>
  );
}

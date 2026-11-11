import { useState } from 'react';
import { Alert, Share } from 'react-native';

import { PolePrzelacznik, PoleTekstowe } from '@/komponenty/formularz';
import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { dataPelna } from '@/lib/format';
import { useFlaga } from '@/stan/faktury';

/**
 * Konto i dane (RODO): pobranie danych, usunięcie konta z 14 dniami na
 * rezygnację (wymóg Apple: usuwanie konta w aplikacji), analityka.
 */
export default function EkranKonta() {
  const [haslo, setHaslo] = useState('');
  const [zaplanowane, setZaplanowane] = useFlaga('usuniecie-konta', false);
  const [analityka, setAnalityka] = useFlaga('analityka', true);
  const [blad, setBlad] = useState<string>();

  return (
    <EkranListy keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
      <Sekcja naglowek="Pobierz moje dane" stopka="Plik JSON ze wszystkimi Twoimi danymi.">
        <Wiersz tytul="Pobierz dane (JSON)" ikona="file-download-line" akcja onPress={() => void Share.share({ message: 'Eksport danych konta FaktWay (przykładowy).' })} />
      </Sekcja>

      <Sekcja naglowek="Analityka" stopka="Bez analityki zbieramy tylko dane niezbędne do działania.">
        <PolePrzelacznik etykieta="Analityka użycia" wartosc={analityka} onZmiana={setAnalityka} />
      </Sekcja>

      {zaplanowane ? (
        <Sekcja naglowek="Usunięcie konta zaplanowane" stopka="Do tego dnia możesz się wycofać. Potem usuwanie nie da się cofnąć.">
          <Wiersz tytul="Planowana data usunięcia" wartosc={dataPelna('2026-11-23')} />
          <Wiersz tytul="Anuluj usunięcie konta" akcja onPress={() => setZaplanowane(false)} />
        </Sekcja>
      ) : (
        <Sekcja naglowek="Trwałe usunięcie konta" stopka={blad ?? 'Masz 14 dni na rezygnację. Faktury przechowujemy tyle, ile wymaga prawo podatkowe.'}>
          <PoleTekstowe etykieta="Aktualne hasło" wartosc={haslo} onZmiana={setHaslo} tajne />
          <Wiersz
            tytul="Usuń moje konto"
            niszczacy
            onPress={() => {
              if (!haslo) return setBlad('Wpisz aktualne hasło, żeby potwierdzić.');
              Alert.alert('Usunąć konto?', 'Konto zostanie usunięte za 14 dni. Do tego czasu możesz się wycofać.', [
                { text: 'Wróć', style: 'cancel' },
                {
                  text: 'Potwierdź żądanie',
                  style: 'destructive',
                  onPress: () => {
                    setZaplanowane(true);
                    setHaslo('');
                    setBlad(undefined);
                  },
                },
              ]);
            }}
          />
        </Sekcja>
      )}
    </EkranListy>
  );
}

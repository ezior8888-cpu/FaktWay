import { useState } from 'react';
import { Share } from 'react-native';

import { PoleKodu, PolePrzelacznik, PoleTekstowe } from '@/komponenty/formularz';
import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { potwierdz } from '@/komponenty/potwierdz';
import { dataPelna } from '@/lib/format';
import { useFlaga } from '@/stan/faktury';
import { useSesja } from '@/stan/sesja';

/**
 * Konto i dane (RODO): pobranie danych, usunięcie konta z 14 dniami na
 * rezygnację (wymóg Apple: usuwanie konta w aplikacji), analityka.
 * Usunięcie potwierdza się hasłem; konto z Google hasła w FaktWay nie ma,
 * więc potwierdza je kod z aplikacji TOTP (WZORCE-MOBBIN.md 7, ekran 6),
 * a bez 2FA systemowe Face ID (M5b).
 */
export default function EkranKonta() {
  const { konto, biometria, potwierdzBiometria } = useSesja();
  const google = konto?.metoda === 'google';
  const [dwaEtapy] = useFlaga('2fa', true);
  const [haslo, setHaslo] = useState('');
  const [kod, setKod] = useState('');
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
          {!google ? <PoleTekstowe etykieta="Aktualne hasło" wartosc={haslo} onZmiana={setHaslo} tajne /> : null}
          {google && dwaEtapy ? (
            <PoleKodu etykieta="Kod z aplikacji (TOTP)" wartosc={kod} onZmiana={setKod} opis="Logujesz się przez Google, więc potwierdzasz kodem z aplikacji." />
          ) : null}
          <Wiersz
            tytul="Usuń moje konto"
            niszczacy
            onPress={async () => {
              if (!google && !haslo) return setBlad('Wpisz aktualne hasło, żeby potwierdzić.');
              if (google && dwaEtapy && kod.length !== 6) return setBlad('Wpisz 6-cyfrowy kod z aplikacji TOTP, żeby potwierdzić.');
              // Konto z Google bez 2FA nie ma hasła ani kodu: potwierdza twarz (M5b), bez biometrii zostaje arkusz.
              if (google && !dwaEtapy && biometria && !(await potwierdzBiometria())) return setBlad(`Nie potwierdziliśmy ${biometria.nazwa}. Spróbuj jeszcze raz.`);
              potwierdz({ tytul: 'Usunąć konto?', opis: 'Konto zostanie usunięte za 14 dni. Do tego czasu możesz się wycofać.', potwierdz: 'Potwierdź żądanie', anuluj: 'Wróć' }, () => {
                setZaplanowane(true);
                setHaslo('');
                setKod('');
                setBlad(undefined);
              });
            }}
          />
        </Sekcja>
      )}
    </EkranListy>
  );
}

import Constants from 'expo-constants';
import { useRouter, type Href } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import type { NazwaIkony } from '@/komponenty/ikona';

import { FIRMA, KSEF } from '@/dane-przykladowe/ustawienia';
import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import type { Kolory } from '@/wyglad/kolory';

type Pozycja = { tytul: string; ikona: NazwaIkony; kolor?: keyof Kolory; trasa: Href; podtytul?: string };

const USTAWIENIA: Pozycja[] = [
  { tytul: 'Firma', ikona: 'building2-line', trasa: '/wiecej/ustawienia/firma', podtytul: 'Dane firmy, VAT, metoda kasowa' },
  { tytul: 'Bezpieczeństwo', ikona: 'shield-keyhole-line', trasa: '/wiecej/ustawienia/bezpieczenstwo', podtytul: 'Hasło, 2FA, logowanie biometrią' },
  { tytul: 'Powiadomienia', ikona: 'notification3-line', trasa: '/wiecej/ustawienia/powiadomienia' },
  { tytul: 'KSeF', ikona: 'shield-check-line', kolor: 'sukces', trasa: '/wiecej/ustawienia/ksef', podtytul: KSEF.status },
  { tytul: 'Przypomnienia', ikona: 'mail-unread-line', trasa: '/wiecej/ustawienia/przypomnienia', podtytul: 'Przypomnienia o zapłacie' },
  { tytul: 'Księgowa', ikona: 'user-star-line', trasa: '/wiecej/ustawienia/ksiegowa', podtytul: 'Co-Pilot i udostępnione dostępy' },
  { tytul: 'Zespół', ikona: 'team-line', trasa: '/wiecej/ustawienia/zespol' },
  { tytul: 'Abonament', ikona: 'bank-card-line', trasa: '/wiecej/ustawienia/abonament' },
  { tytul: 'Dziennik zdarzeń', ikona: 'history-line', trasa: '/wiecej/ustawienia/dziennik' },
  { tytul: 'Konto i dane (RODO)', ikona: 'account-circle-line', trasa: '/wiecej/ustawienia/konto' },
];

/**
 * Więcej: wszystko, czego nie ma w czterech pierwszych zakładkach. Odpowiada
 * pozostałym pozycjom menu strony i kartom ustawień (`settings-tabs.ts`).
 */
export default function EkranWiecej() {
  const router = useRouter();
  return (
    <EkranListy gradient>
      <Sekcja>
        <Wiersz tytul={FIRMA.nazwa} podtytul={`NIP ${FIRMA.nip} · ${FIRMA.vat}`} ikona="building2-line" strzalka onPress={() => router.push('/wiecej/ustawienia/firma')} />
      </Sekcja>

      <Sekcja naglowek="Sprzedaż i dane">
        <Wiersz tytul="Kontrahenci" ikona="contacts-book3-line" strzalka onPress={() => router.push('/wiecej/kontrahenci')} />
        <Wiersz tytul="Faktury cykliczne" ikona="repeat-line" strzalka onPress={() => router.navigate({ pathname: '/faktury', params: { widok: 'cykliczne' } })} />
        <Wiersz tytul="Przepływy" ikona="exchange-funds-line" strzalka onPress={() => router.push('/przeplywy')} />
        <Wiersz tytul="Analizy" ikona="bar-chart2-line" strzalka onPress={() => router.push('/analizy')} />
        <Wiersz tytul="Import danych" ikona="download2-line" strzalka onPress={() => router.push('/wiecej/import')} />
      </Sekcja>

      <Sekcja naglowek="Ustawienia">
        {USTAWIENIA.map((p) => (
          <Wiersz key={p.tytul} tytul={p.tytul} podtytul={p.podtytul} ikona={p.ikona} ikonaKolor={p.kolor} strzalka onPress={() => router.push(p.trasa)} />
        ))}
      </Sekcja>

      <Sekcja naglowek="Pomoc">
        <Wiersz tytul="Centrum pomocy" ikona="question-line" strzalka onPress={() => void WebBrowser.openBrowserAsync('https://faktway.pl/pomoc')} />
        <Wiersz tytul="Napisz do nas" ikona="mail-line" strzalka onPress={() => void WebBrowser.openBrowserAsync('https://faktway.pl/kontakt')} />
      </Sekcja>

      <Sekcja stopka={`FaktWay ${Constants.expoConfig?.version ?? ''}, dane przykładowe`}>
        <Wiersz tytul="Wersja aplikacji" wartosc={Constants.expoConfig?.version ?? ''} />
      </Sekcja>
    </EkranListy>
  );
}

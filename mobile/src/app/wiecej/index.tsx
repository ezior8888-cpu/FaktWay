import Constants from 'expo-constants';
import { useRouter, type Href } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import type { SFSymbol } from 'expo-symbols';

import { FIRMA, KSEF } from '@/dane-przykladowe/ustawienia';
import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import type { Kolory } from '@/wyglad/kolory';

type Pozycja = { tytul: string; ikona: SFSymbol; kolor?: keyof Kolory; trasa: Href; podtytul?: string };

const USTAWIENIA: Pozycja[] = [
  { tytul: 'Firma', ikona: 'building.2', trasa: '/wiecej/ustawienia/firma', podtytul: 'Dane firmy, VAT, metoda kasowa' },
  { tytul: 'Bezpieczeństwo', ikona: 'lock.shield', trasa: '/wiecej/ustawienia/bezpieczenstwo', podtytul: 'Hasło, 2FA, logowanie biometrią' },
  { tytul: 'Powiadomienia', ikona: 'bell', trasa: '/wiecej/ustawienia/powiadomienia' },
  { tytul: 'KSeF', ikona: 'checkmark.shield', kolor: 'sukces', trasa: '/wiecej/ustawienia/ksef', podtytul: KSEF.status },
  { tytul: 'Przypomnienia', ikona: 'envelope.badge', trasa: '/wiecej/ustawienia/przypomnienia', podtytul: 'Przypomnienia o zapłacie' },
  { tytul: 'Księgowa', ikona: 'person.text.rectangle', trasa: '/wiecej/ustawienia/ksiegowa', podtytul: 'Co-Pilot i udostępnione dostępy' },
  { tytul: 'Zespół', ikona: 'person.2', trasa: '/wiecej/ustawienia/zespol' },
  { tytul: 'Abonament', ikona: 'creditcard', trasa: '/wiecej/ustawienia/abonament' },
  { tytul: 'Flo', ikona: 'sparkles', trasa: '/wiecej/ustawienia/flo' },
  { tytul: 'Dziennik zdarzeń', ikona: 'clock.arrow.circlepath', trasa: '/wiecej/ustawienia/dziennik' },
  { tytul: 'Konto i dane (RODO)', ikona: 'person.crop.circle', trasa: '/wiecej/ustawienia/konto' },
];

/**
 * Więcej: wszystko, czego nie ma w czterech pierwszych zakładkach. Odpowiada
 * pozostałym pozycjom menu strony i kartom ustawień (`settings-tabs.ts`).
 */
export default function EkranWiecej() {
  const router = useRouter();
  return (
    <EkranListy>
      <Sekcja>
        <Wiersz tytul={FIRMA.nazwa} podtytul={`NIP ${FIRMA.nip} · ${FIRMA.vat}`} ikona="building.2.crop.circle" strzalka onPress={() => router.push('/wiecej/ustawienia/firma')} />
      </Sekcja>

      <Sekcja naglowek="Sprzedaż i dane">
        <Wiersz tytul="Kontrahenci" ikona="person.crop.rectangle.stack" strzalka onPress={() => router.push('/wiecej/kontrahenci')} />
        <Wiersz tytul="Faktury cykliczne" ikona="arrow.triangle.2.circlepath" strzalka onPress={() => router.navigate({ pathname: '/faktury', params: { widok: 'cykliczne' } })} />
        <Wiersz tytul="Przepływy" ikona="arrow.left.arrow.right" strzalka onPress={() => router.push('/przeplywy')} />
        <Wiersz tytul="Analizy" ikona="chart.bar" strzalka onPress={() => router.push('/analizy')} />
        <Wiersz tytul="Import danych" ikona="square.and.arrow.down" strzalka onPress={() => router.push('/wiecej/import')} />
        <Wiersz tytul="Flo" podtytul="Asystent: propozycje do zatwierdzenia" ikona="sparkles" strzalka onPress={() => router.push('/wiecej/flo')} />
      </Sekcja>

      <Sekcja naglowek="Ustawienia">
        {USTAWIENIA.map((p) => (
          <Wiersz key={p.tytul} tytul={p.tytul} podtytul={p.podtytul} ikona={p.ikona} ikonaKolor={p.kolor} strzalka onPress={() => router.push(p.trasa)} />
        ))}
      </Sekcja>

      <Sekcja naglowek="Pomoc">
        <Wiersz tytul="Centrum pomocy" ikona="questionmark.circle" strzalka onPress={() => void WebBrowser.openBrowserAsync('https://faktway.pl/pomoc')} />
        <Wiersz tytul="Napisz do nas" ikona="envelope" strzalka onPress={() => void WebBrowser.openBrowserAsync('https://faktway.pl/kontakt')} />
      </Sekcja>

      <Sekcja stopka={`FaktWay ${Constants.expoConfig?.version ?? ''}, dane przykładowe`}>
        <Wiersz tytul="Wersja aplikacji" wartosc={Constants.expoConfig?.version ?? ''} />
      </Sekcja>
    </EkranListy>
  );
}

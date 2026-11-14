import Constants from 'expo-constants';
import { Stack, useRouter, type Href } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { CZLONKOWIE, FIRMA, KSEF } from '@/dane-przykladowe/ustawienia';
import { Karta } from '@/komponenty/karta';
import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { otworzStrone } from '@/komponenty/na-stronie';
import { StanPusty } from '@/komponenty/stan-pusty';
import { Tekst } from '@/komponenty/tekst';
import { potwierdz } from '@/komponenty/potwierdz';
import { Znacznik } from '@/komponenty/znacznik';
import { useKontoFirmy } from '@/stan/dane';
import { useFlaga, useStanFaktur } from '@/stan/faktury';
import { useSesja } from '@/stan/sesja';
import { useUstawienia } from '@/stan/ustawienia';
import type { Kolory } from '@/wyglad/kolory';
import { MARGINES, ODSTEP } from '@/wyglad/odstepy';

/**
 * `strona`: na prawdziwym koncie karta bez API telefonu (M10b) otwiera tę
 * stronę panelu zamiast ekranu z danymi przykładowymi. `role`: kto widzi
 * pozycję na prawdziwym koncie, jak zakładki strony (`settings-tabs.ts`).
 */
type Pozycja = { tytul: string; trasa: Href; podtytul?: string; stan?: string; stanKolor?: keyof Kolory; slowa?: string; strona?: string; role?: string[] };

const WLASCICIEL_ADMIN = ['owner', 'admin'];

/** Rola w firmie jak na stronie (zespół w ustawieniach). */
const NAZWA_ROLI: Record<string, string> = { owner: 'Właściciel', admin: 'Administrator', member: 'Członek zespołu', accountant: 'Księgowa' };
type Grupa = { naglowek: string; pozycje: Pozycja[] };

/**
 * Więcej: wszystko, czego nie ma w czterech pierwszych zakładkach. Odpowiada
 * pozostałym pozycjom menu strony i kartom ustawień (`settings-tabs.ts`).
 * Układ jak Google Account i Deel (WZORCE-MOBBIN.md 6.1): karta konta na
 * górze, małe grupy ze stanem po prawej, wyszukiwarka po słowach kluczowych.
 * „Wyloguj się” na końcu, z potwierdzeniem w arkuszu akcji (etap M5).
 */
export default function EkranWiecej() {
  const router = useRouter();
  const [szukaj, setSzukaj] = useState('');
  const [dwaEtapyPrzyklad] = useFlaga('2fa', true);
  const { wyloguj, biometria, blokada, konto: kontoSesji } = useSesja();
  const kontoFirmy = useKontoFirmy();
  const { dane } = useStanFaktur();
  // Prawdziwe konto (M7): firma i rola z `GET /konto`; od M9 też wydatki; reszta kart na danych przykładowych do M10.
  const zBazy = dane.zrodlo === 'baza';
  const przyklad = CZLONKOWIE.find((c) => c.ty);
  const konto = zBazy ? (kontoSesji ? { imie: kontoSesji.imie, email: kontoSesji.email } : undefined) : przyklad;
  const firma = kontoFirmy?.firma;
  // 2FA na prawdziwym koncie z serwera (`dwaEtapy.wlaczone`); `undefined`, dopóki `GET /konto` nie odpowie.
  const dwaEtapy = zBazy ? kontoFirmy?.konto?.dwaEtapy.wlaczone : dwaEtapyPrzyklad;
  const ileFirm = kontoFirmy?.konto?.firmy.length ?? 0;
  // Stan KSeF na prawdziwym koncie z serwera (`GET /ustawienia`); `undefined`, dopóki nie odpowie.
  const ustawienia = useUstawienia();
  const stanKsef = zBazy ? ustawienia?.dane?.ksef.stan : KSEF.status.startsWith('Skonfigurowano') ? 'polaczono' : 'brak';
  const ksefPolaczony = stanKsef === 'polaczono';
  const ksefStan = stanKsef === undefined ? undefined : ksefPolaczony ? 'Połączony' : stanKsef === 'do_potwierdzenia' ? 'Do potwierdzenia' : 'Niepołączony';

  const grupy: Grupa[] = [
    {
      naglowek: 'Sprzedaż i dane',
      pozycje: [
        { tytul: 'Kontrahenci', trasa: '/wiecej/kontrahenci', slowa: 'klienci nabywcy dostawcy nip' },
        { tytul: 'Faktury cykliczne', trasa: { pathname: '/faktury', params: { widok: 'cykliczne' } }, slowa: 'abonament co miesiąc' },
        { tytul: 'Przepływy', trasa: '/przeplywy', slowa: 'wpływy wydatki pieniądze' },
        { tytul: 'Analizy', trasa: '/analizy', slowa: 'sprzedaż koszty wykresy' },
        { tytul: 'Import danych', trasa: '/wiecej/import', slowa: 'csv excel przeniesienie' },
      ],
    },
    {
      naglowek: 'Firma i KSeF',
      pozycje: [
        { tytul: 'Firma', trasa: '/wiecej/ustawienia/firma', podtytul: 'Dane firmy, VAT, metoda kasowa', slowa: 'nip adres rachunek bank metoda kasowa zwolnienie' },
        { tytul: 'KSeF', trasa: '/wiecej/ustawienia/ksef', stan: ksefStan, stanKolor: ksefPolaczony ? 'sukces' : 'ostrzezenie', slowa: 'certyfikat token uprawnienia' },
        { tytul: 'Księgowa', trasa: '/wiecej/ustawienia/ksiegowa', podtytul: 'Co-Pilot i udostępnione dostępy', slowa: 'biuro rachunkowe dostęp', strona: '/settings/accountant' },
      ],
    },
    {
      naglowek: 'Powiadomienia i przypomnienia',
      pozycje: [
        { tytul: 'Powiadomienia', trasa: '/wiecej/ustawienia/powiadomienia', slowa: 'push e-mail', strona: '/settings/notifications' },
        { tytul: 'Przypomnienia o zapłacie', trasa: '/wiecej/ustawienia/przypomnienia', slowa: 'windykacja po terminie', role: ['owner'] },
      ],
    },
    {
      naglowek: 'Zespół i abonament',
      pozycje: [
        { tytul: 'Zespół', trasa: '/wiecej/ustawienia/zespol', stan: zBazy ? undefined : `${CZLONKOWIE.length} osoby`, slowa: 'użytkownicy zaproszenia role', strona: '/settings/team', role: WLASCICIEL_ADMIN },
        { tytul: 'Abonament', trasa: '/wiecej/ustawienia/abonament', stan: zBazy ? undefined : 'Plan miesięczny', slowa: 'subskrypcja płatność faktura', strona: '/settings/billing', role: WLASCICIEL_ADMIN },
      ],
    },
    {
      naglowek: 'Bezpieczeństwo i dane',
      pozycje: [
        {
          tytul: 'Bezpieczeństwo',
          trasa: '/wiecej/ustawienia/bezpieczenstwo',
          podtytul: biometria ? `Blokada ${biometria.nazwa}: ${blokada ? 'włączona' : 'wyłączona'}` : undefined,
          stan: dwaEtapy === undefined ? undefined : dwaEtapy ? '2FA włączone' : '2FA wyłączone',
          stanKolor: dwaEtapy ? 'sukces' : 'ostrzezenie',
          slowa: 'hasło 2fa face id biometria klucz blokada wyloguj',
        },
        { tytul: 'Dziennik zdarzeń', trasa: '/wiecej/ustawienia/dziennik', slowa: 'logi historia audyt', strona: '/settings/audit' },
        { tytul: 'Konto i dane (RODO)', trasa: '/wiecej/ustawienia/konto', slowa: 'usuń konto eksport danych rodo' },
      ],
    },
  ];

  // Na prawdziwym koncie pozycje według roli, jak zakładki strony; strona i tak pilnuje roli sama.
  const widoczne: Grupa[] = zBazy
    ? grupy.map((g) => ({ ...g, pozycje: g.pozycje.filter((p) => !p.role || (firma ? p.role.includes(firma.rola) : false)) })).filter((g) => g.pozycje.length > 0)
    : grupy;

  const fraza = szukaj.trim().toLocaleLowerCase('pl');
  const wyniki = fraza
    ? widoczne.flatMap((g) => g.pozycje).filter((p) => `${p.tytul} ${p.podtytul ?? ''} ${p.slowa ?? ''}`.toLocaleLowerCase('pl').includes(fraza))
    : [];

  const wiersz = (p: Pozycja) => (
    <Wiersz
      key={p.tytul}
      tytul={p.tytul}
      podtytul={p.podtytul}
      wartosc={zBazy && p.strona ? 'faktway.pl' : p.stan}
      wartoscKolor={zBazy && p.strona ? 'etykietaDrugorzedna' : (p.stanKolor ?? 'etykietaDrugorzedna')}
      strzalka
      onPress={() => (zBazy && p.strona ? otworzStrone(p.strona) : router.push(p.trasa))}
    />
  );

  return (
    <>
      <Stack.SearchBar placeholder="Szukaj ustawień, np. 2FA" onChangeText={(e) => setSzukaj(e.nativeEvent.text)} />
      <EkranListy gradient={!fraza} keyboardShouldPersistTaps="handled">
        {fraza ? (
          wyniki.length > 0 ? (
            <Sekcja naglowek="Wyniki">{wyniki.map(wiersz)}</Sekcja>
          ) : (
            <StanPusty ikona="search-line" tytul="Nic nie znaleźliśmy" opis={`Brak ustawień pasujących do „${szukaj.trim()}”.`} />
          )
        ) : (
          <>
            {zBazy ? (
              <Karta style={styles.konto}>
                <Pressable
                  onPress={ileFirm > 1 ? () => router.push('/wiecej/firmy') : undefined}
                  disabled={ileFirm <= 1}
                  accessibilityRole={ileFirm > 1 ? 'button' : undefined}
                  accessibilityLabel={`${firma?.nazwa ?? 'Bez firmy'}${firma?.nip ? `, NIP ${firma.nip}` : ''}, ${konto?.email ?? ''}.${ileFirm > 1 ? ' Zmień firmę.' : ''}`}
                  style={styles.trescKonta}>
                  <Tekst styl="headline">{firma?.nazwa ?? (kontoFirmy?.konto ? 'Konto bez firmy' : 'Wczytujemy firmę…')}</Tekst>
                  {firma ? (
                    <Tekst styl="footnote" kolor="etykietaDrugorzedna" cyfry>
                      {[firma.nip ? `NIP ${firma.nip}` : undefined, NAZWA_ROLI[firma.rola] ?? firma.rola].filter(Boolean).join(' · ')}
                    </Tekst>
                  ) : kontoFirmy?.konto ? (
                    <Tekst styl="footnote" kolor="etykietaDrugorzedna">
                      Załóż firmę albo przyjmij zaproszenie na faktway.pl.
                    </Tekst>
                  ) : null}
                  {konto ? (
                    <Tekst styl="footnote" kolor="etykietaDrugorzedna">
                      {konto.imie ? `${konto.imie}, ${konto.email}` : konto.email}
                    </Tekst>
                  ) : null}
                  {ileFirm > 1 ? (
                    <Tekst styl="footnote" kolor="akcent" waga="medium" style={styles.zmienFirme}>
                      {`Zmień firmę (${ileFirm})`}
                    </Tekst>
                  ) : null}
                </Pressable>
              </Karta>
            ) : (
              <Karta style={styles.konto}>
                <Pressable
                  onPress={() => router.push('/wiecej/ustawienia/firma')}
                  accessibilityRole="button"
                  accessibilityLabel={`${FIRMA.nazwa}, NIP ${FIRMA.nip}, ${konto?.email ?? ''}. Dane firmy.`}
                  style={styles.trescKonta}>
                  <Tekst styl="headline">{FIRMA.nazwa}</Tekst>
                  <Tekst styl="footnote" kolor="etykietaDrugorzedna" cyfry>
                    {`NIP ${FIRMA.nip} · ${FIRMA.vat}`}
                  </Tekst>
                  {konto ? (
                    <Tekst styl="footnote" kolor="etykietaDrugorzedna">
                      {`${konto.imie}, ${konto.email}`}
                    </Tekst>
                  ) : null}
                  <View style={styles.plakietki}>
                    <Znacznik ton={ksefPolaczony ? 'sukces' : 'ostrzezenie'}>{ksefPolaczony ? 'KSeF połączony' : 'KSeF niepołączony'}</Znacznik>
                    <Znacznik ton="marka">Plan miesięczny</Znacznik>
                  </View>
                </Pressable>
              </Karta>
            )}

            {widoczne.map((g) => (
              <Sekcja key={g.naglowek} naglowek={g.naglowek}>
                {g.pozycje.map(wiersz)}
              </Sekcja>
            ))}

            <Sekcja naglowek="Pomoc">
              <Wiersz tytul="Centrum pomocy" strzalka onPress={() => void WebBrowser.openBrowserAsync('https://faktway.pl/pomoc')} />
              <Wiersz tytul="Napisz do nas" strzalka onPress={() => void WebBrowser.openBrowserAsync('https://faktway.pl/kontakt')} />
            </Sekcja>

            <Sekcja>
              <Wiersz
                tytul="Wyloguj się"
                niszczacy
                onPress={() =>
                  potwierdz({ tytul: 'Wylogować się?', opis: 'Następnym razem zalogujesz się e-mailem i hasłem albo przez Google.', potwierdz: 'Wyloguj się' }, wyloguj)
                }
              />
            </Sekcja>

            <Sekcja
              stopka={
                zBazy
                  ? `FaktWay ${Constants.expoConfig?.version ?? ''}. Z Twojego konta: firma, faktury i należności, skrzynka KSeF, wydatki, księgowość i ustawienia. Kontrahenci, przepływy, analizy i import danych pokazują jeszcze dane przykładowe. Karty z dopiskiem faktway.pl otwierają stronę.`
                  : `FaktWay ${Constants.expoConfig?.version ?? ''}, dane przykładowe`
              }
            />
          </>
        )}
      </EkranListy>
    </>
  );
}

const styles = StyleSheet.create({
  konto: { marginTop: ODSTEP.s },
  trescKonta: { padding: MARGINES, gap: ODSTEP.linia },
  plakietki: { flexDirection: 'row', flexWrap: 'wrap', gap: ODSTEP.xs, marginTop: ODSTEP.xs },
  zmienFirme: { marginTop: ODSTEP.xs },
});

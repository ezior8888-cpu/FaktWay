import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { PolePrzelacznik, PoleTekstowe, PoleWyboru } from '@/komponenty/formularz';
import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { MA_ADRES_STRONY, otworzStrone } from '@/komponenty/na-stronie';
import { PrzyciskGlowny } from '@/komponenty/przycisk-glowny';
import { StanPusty } from '@/komponenty/stan-pusty';
import { SzkieletListy } from '@/komponenty/szkielet';
import { useUstawienia, type StanUstawien } from '@/stan/ustawienia';
import { useStanFaktur } from '@/stan/faktury';
import { MARGINES, ODSTEP } from '@/wyglad/odstepy';

const ETAPY = [
  { klucz: '1', nazwa: 'Etap 1: Uprzejme przypomnienie', dni: '3' },
  { klucz: '2', nazwa: 'Etap 2: Stanowcze przypomnienie', dni: '7' },
  { klucz: '3', nazwa: 'Etap 3: Przedsądowe wezwanie', dni: '14' },
];

const GODZINY = Array.from({ length: 13 }, (_, i) => String(i + 6));

export default function EkranPrzypomnienOZaplacie() {
  const ustawienia = useUstawienia();
  if (ustawienia) return <EkranPrzypomnienZBazy ustawienia={ustawienia} />;
  return <EkranUstawienPrzypomnien />;
}

const tak = (w: boolean) => (w ? 'Tak' : 'Nie');

/**
 * Przypomnienia na prawdziwym koncie (M10b): ustawienia z `GET /ustawienia`
 * do odczytu, tylko dla właściciela (jak zakładka strony). Zmiany na
 * faktway.pl (decyzja M10b: formularz strony ma granice i podgląd treści).
 * Same przypomnienia (podgląd, zgoda, wstrzymanie) idą z telefonu od M10a.
 */
function EkranPrzypomnienZBazy({ ustawienia }: { ustawienia: StanUstawien }) {
  const { dane } = ustawienia;
  if (!dane) {
    return (
      <EkranListy>
        {ustawienia.stan === 'blad' ? (
          <StanPusty ikona="error-warning-line" tytul="Nie udało się wczytać przypomnień" opis={ustawienia.blad ?? 'Spróbuj ponownie za chwilę.'} akcja={{ tytul: 'Spróbuj ponownie', onPress: () => void ustawienia.odswiez() }} />
        ) : (
          <SzkieletListy wiersze={4} etykieta="Wczytujemy przypomnienia" />
        )}
      </EkranListy>
    );
  }
  const p = dane.przypomnienia;
  if (!p) {
    return (
      <EkranListy>
        <StanPusty ikona="shield-keyhole-line" tytul="Przypomnienia ustawia właściciel firmy" opis="Etapy, godzinę wysyłki i nadawcę ustawia właściciel firmy na faktway.pl." />
      </EkranListy>
    );
  }
  const zmien = MA_ADRES_STRONY ? <Wiersz tytul="Zmień na faktway.pl" ikona="global-line" akcja onPress={() => otworzStrone('/settings/reminders', () => void ustawienia.odswiez())} /> : null;
  if (!p.zapisane) {
    return (
      <EkranListy onOdswiez={ustawienia.odswiez}>
        <Sekcja
          naglowek="Przypomnienia o zapłacie"
          stopka="Firma nie zapisała jeszcze ustawień, więc FaktWay nie przygotowuje przypomnień. Ustawisz je na faktway.pl; każde przypomnienie i tak czeka na Twoje zatwierdzenie.">
          <Wiersz tytul="Nie ustawione" ikona="error-warning-line" ikonaKolor="ostrzezenie" />
          {zmien}
        </Sekcja>
      </EkranListy>
    );
  }
  return (
    <EkranListy onOdswiez={ustawienia.odswiez}>
      <Sekcja naglowek="Przypomnienia o zapłacie" stopka="Przypomnienia przygotowujemy do Twojego zatwierdzenia. Nic nie wychodzi samo.">
        <Wiersz tytul={p.wlaczone ? 'Włączone' : 'Wyłączone'} ikona={p.wlaczone ? 'checkbox-circle-fill' : 'close-line'} ikonaKolor={p.wlaczone ? 'sukces' : 'etykietaDrugorzedna'} />
      </Sekcja>

      {p.wlaczone ? (
        <>
          <Sekcja naglowek="Etapy przypomnień">
            {p.etapy.map((e) => (
              <Wiersz
                key={e.etap}
                tytul={ETAPY[e.etap - 1]?.nazwa ?? `Etap ${e.etap}`}
                wartosc={e.wlaczony ? `${e.dniPoTerminie} ${e.dniPoTerminie === 1 ? 'dzień' : 'dni'} po terminie` : 'Wyłączony'}
              />
            ))}
          </Sekcja>

          <Sekcja naglowek="Inteligentne reguły">
            <Wiersz tytul="Pauza po odpowiedzi klienta" wartosc={tak(p.wstrzymajPoOdpowiedzi)} />
            <Wiersz tytul="Pauza po częściowej płatności" wartosc={tak(p.wstrzymajPoCzesciowej)} />
            <Wiersz tytul="Wysyłaj tylko w dni robocze" wartosc={tak(p.tylkoDniRobocze)} />
            <Wiersz tytul="Godzina wysyłki" wartosc={`${p.godzina}:00`} />
            <Wiersz tytul="Maks. przypomnień na fakturę" wartosc={String(p.najwiecej)} />
          </Sekcja>

          <Sekcja naglowek="Dane nadawcy">
            <Wiersz tytul="Nadawca" podtytul={p.nadawca ?? 'Nazwa firmy'} />
            <Wiersz tytul="Odpowiedzi na adres" podtytul={p.odpowiedzNa ?? 'Nie podano'} />
          </Sekcja>
        </>
      ) : null}

      <Sekcja stopka="Etapy, reguły i nadawcę zmienisz na faktway.pl.">{zmien}</Sekcja>
    </EkranListy>
  );
}

/** Przypomnienia o zapłacie: odpowiednik `reminder-settings-form.tsx` (etapy, reguły, nadawca). */
function EkranUstawienPrzypomnien() {
  const { flagi, ustawFlage } = useStanFaktur();
  const wl = (k: string, d: boolean) => flagi[`przyp-${k}`] ?? d;
  const glowny = wl('wlaczone', true);
  const [dni, setDni] = useState<Record<string, string>>(Object.fromEntries(ETAPY.map((e) => [e.klucz, e.dni])));
  const [godzina, setGodzina] = useState('9');
  const [maks, setMaks] = useState('3');
  const [nadawca, setNadawca] = useState('Jan Kowalski');
  const [replyTo, setReplyTo] = useState('jan@przyklad.pl');
  const [zapisano, setZapisano] = useState(false);

  return (
    <EkranListy keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
      <Sekcja stopka="Przypomnienia przygotowujemy do Twojego zatwierdzenia. Nic nie wychodzi samo.">
        <PolePrzelacznik etykieta="Przypomnienia o zapłacie" wartosc={glowny} onZmiana={(v) => ustawFlage('przyp-wlaczone', v)} />
      </Sekcja>

      {glowny ? (
        <>
          <Sekcja naglowek="Etapy przypomnień">
            {ETAPY.map((e) => (
              <View key={e.klucz}>
                <PolePrzelacznik etykieta={e.nazwa} wartosc={wl(`etap-${e.klucz}`, true)} onZmiana={(v) => ustawFlage(`przyp-etap-${e.klucz}`, v)} />
                {wl(`etap-${e.klucz}`, true) ? (
                  <PoleTekstowe etykieta="Dni po terminie" wartosc={dni[e.klucz] ?? ''} onZmiana={(t) => setDni((d) => ({ ...d, [e.klucz]: t }))} klawiatura="number-pad" />
                ) : null}
              </View>
            ))}
          </Sekcja>

          <Sekcja naglowek="Inteligentne reguły">
            <PolePrzelacznik etykieta="Pauza po odpowiedzi klienta" wartosc={wl('pauza-odp', true)} onZmiana={(v) => ustawFlage('przyp-pauza-odp', v)} />
            <PolePrzelacznik etykieta="Pauza po częściowej płatności" wartosc={wl('pauza-czesc', true)} onZmiana={(v) => ustawFlage('przyp-pauza-czesc', v)} />
            <PolePrzelacznik etykieta="Wysyłaj tylko w dni robocze" wartosc={wl('robocze', true)} onZmiana={(v) => ustawFlage('przyp-robocze', v)} />
            <PoleWyboru etykieta="Godzina wysyłki" wartosc={godzina} opcje={GODZINY.map((g) => ({ wartosc: g, etykieta: `${g}:00` }))} onZmiana={setGodzina} />
            <PoleTekstowe etykieta="Maks. przypomnień na fakturę" wartosc={maks} onZmiana={setMaks} klawiatura="number-pad" />
          </Sekcja>

          <Sekcja naglowek="Dane nadawcy">
            <PoleTekstowe etykieta="Nadawca" wartosc={nadawca} onZmiana={setNadawca} />
            <PoleTekstowe etykieta="Odpowiedzi na adres" wartosc={replyTo} onZmiana={setReplyTo} klawiatura="email-address" />
          </Sekcja>
        </>
      ) : null}

      <View style={styles.akcja}>
        <PrzyciskGlowny
          tytul={zapisano ? 'Zapisano' : 'Zapisz ustawienia'}
          ikona="check-line"
          onPress={() => {
            setZapisano(true);
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          }}
        />
      </View>
    </EkranListy>
  );
}

const styles = StyleSheet.create({
  akcja: { marginHorizontal: MARGINES, marginTop: ODSTEP.xl },
});

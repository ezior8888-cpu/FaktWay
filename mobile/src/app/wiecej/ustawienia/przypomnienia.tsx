import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { PolePrzelacznik, PoleTekstowe, PoleWyboru } from '@/komponenty/formularz';
import { EkranListy, Sekcja } from '@/komponenty/lista';
import { PrzyciskGlowny } from '@/komponenty/przycisk-glowny';
import { useStanFaktur } from '@/stan/faktury';
import { MARGINES, ODSTEP } from '@/wyglad/odstepy';

const ETAPY = [
  { klucz: '1', nazwa: 'Etap 1: Uprzejme przypomnienie', dni: '3' },
  { klucz: '2', nazwa: 'Etap 2: Stanowcze przypomnienie', dni: '7' },
  { klucz: '3', nazwa: 'Etap 3: Przedsądowe wezwanie', dni: '14' },
];

const GODZINY = Array.from({ length: 13 }, (_, i) => String(i + 6));

/** Przypomnienia o zapłacie: odpowiednik `reminder-settings-form.tsx` (etapy, reguły, nadawca). */
export default function EkranUstawienPrzypomnien() {
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

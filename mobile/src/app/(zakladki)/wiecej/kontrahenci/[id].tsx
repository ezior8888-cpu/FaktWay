import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { DZIS } from '@/dane-przykladowe';
import { KONTRAHENCI } from '@/dane-przykladowe/kontrahenci';
import { PolePrzelacznik, PoleTekstowe } from '@/komponenty/formularz';
import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { NaglowekKwoty } from '@/komponenty/naglowek';
import { PrzyciskGlowny } from '@/komponenty/przycisk-glowny';
import { StanPusty } from '@/komponenty/stan-pusty';
import { WierszFaktury } from '@/komponenty/wiersz-faktury';
import { potwierdz } from '@/komponenty/potwierdz';
import { kwota } from '@/lib/format';
import { doZaplaty, statusFaktury } from '@/lib/status-faktury';
import { useFlaga, useStanFaktur } from '@/stan/faktury';
import { MARGINES, ODSTEP } from '@/wyglad/odstepy';

/** Karta kontrahenta: dane, należności, faktury, przypomnienia, edycja i usunięcie. */
export default function EkranKontrahenta() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { faktury, ustawFlage } = useStanFaktur();
  const k = KONTRAHENCI.find((x) => x.id === id);
  const [ulica, miasto] = k?.adres.split(', ') ?? [];
  const [nazwa, setNazwa] = useState(k?.nazwa ?? '');
  const [adres1, setAdres1] = useState(ulica ?? '');
  const [adres2, setAdres2] = useState(miasto ?? '');
  const [email, setEmail] = useState(k?.email ?? '');
  const [edycja, setEdycja] = useState(false);
  const [przypomnienia, setPrzypomnienia] = useFlaga(`przypomnienia-kontrahent-${id}`, k?.przypomnienia ?? true);

  if (!k) return <StanPusty ikona="user-search-line" tytul="Nie ma takiego kontrahenta" opis="Mógł zostać usunięty na komputerze." />;
  const jego = faktury.filter((f) => f.kontrahent === k.nazwa);
  const otwarte = jego.filter(doZaplaty);
  const zalegle = otwarte.filter((f) => statusFaktury(f, DZIS).zalegla);

  return (
    <>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button onPress={() => setEdycja(!edycja)}>{edycja ? 'Gotowe' : 'Edytuj'}</Stack.Toolbar.Button>
      </Stack.Toolbar>
      <EkranListy gradient keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
        <NaglowekKwoty
          podpis={nazwa}
          podpisWyrozniony
          wartosc={kwota(otwarte.reduce((s, f) => s + f.brutto, 0))}
          status={zalegle.length > 0 ? `W tym po terminie ${kwota(zalegle.reduce((s, f) => s + f.brutto, 0))}` : 'Należności, nic po terminie'}
          statusKolor={zalegle.length > 0 ? 'ostrzezenie' : 'etykietaDrugorzedna'}
        />
        <View style={styles.akcja}>
          <PrzyciskGlowny tytul="Wystaw fakturę" ikona="add-line" onPress={() => router.push({ pathname: '/faktury/nowa/[rodzaj]', params: { rodzaj: 'vat', wzor: jego[0]?.id ?? '', wprost: '1' } })} />
        </View>

        <Sekcja naglowek="Dane" stopka={edycja ? 'NIP nie da się zmienić: to identyfikator kontrahenta.' : undefined}>
          {edycja ? (
            <>
              <PoleTekstowe etykieta="Nazwa" wartosc={nazwa} onZmiana={setNazwa} />
              <PoleTekstowe etykieta="Ulica i numer" wartosc={adres1} onZmiana={setAdres1} />
              <PoleTekstowe etykieta="Kod i miejscowość" wartosc={adres2} onZmiana={setAdres2} />
              <PoleTekstowe etykieta="E-mail do faktur" wartosc={email} onZmiana={setEmail} klawiatura="email-address" />
              <Wiersz
                tytul="Zapisz"
                akcja
                onPress={() => {
                  setEdycja(false);
                  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                }}
              />
            </>
          ) : (
            <>
              <Wiersz tytul="NIP" wartosc={k.nip} zaznaczalna />
              <Wiersz tytul="Status VAT" wartosc="Czynny VAT" wartoscKolor="sukces" />
              <Wiersz tytul="Adres" podtytul={`${adres1}\n${adres2}`} zaznaczalna />
              {email ? <Wiersz tytul="E-mail do faktur" podtytul={email} zaznaczalna /> : null}
              {k.telefon ? <Wiersz tytul="Telefon" podtytul={k.telefon} zaznaczalna /> : null}
              <Wiersz tytul="Termin płatności" wartosc={`${k.terminDni} dni`} />
            </>
          )}
        </Sekcja>

        <Sekcja naglowek="Przypomnienia" stopka="Przypomnienia o zapłacie dla faktur tego kontrahenta.">
          <PolePrzelacznik etykieta="Przypominaj o zapłacie" wartosc={przypomnienia} onZmiana={setPrzypomnienia} />
        </Sekcja>

        {jego.length > 0 ? (
          <Sekcja naglowek="Faktury">
            {jego.map((f) => (
              <WierszFaktury key={f.id} faktura={f} />
            ))}
          </Sekcja>
        ) : null}

        <Sekcja stopka="Wystawione faktury się nie zmienią.">
          <Wiersz
            tytul="Usuń kontrahenta"
            niszczacy
            onPress={() =>
              potwierdz({ tytul: `Usunąć kontrahenta ${k.nazwa}?`, opis: 'Wystawione faktury się nie zmienią.', potwierdz: 'Usuń kontrahenta' }, () => {
                ustawFlage(`kontrahent-usuniety-${k.id}`, true);
                router.back();
              })
            }
          />
        </Sekcja>
      </EkranListy>
    </>
  );
}

const styles = StyleSheet.create({
  akcja: { marginHorizontal: MARGINES, marginTop: ODSTEP.l },
});

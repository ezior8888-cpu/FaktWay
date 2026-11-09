import { Stack, useRouter } from 'expo-router';
import { useState } from 'react';
import { Share, StyleSheet, View } from 'react-native';

import { PolePrzelacznik } from '@/komponenty/formularz';
import { Sekcja } from '@/komponenty/lista';
import { PrzyciskGlowny } from '@/komponenty/przycisk-glowny';
import { Tekst } from '@/komponenty/tekst';
import { useKolory } from '@/wyglad/kolory';
import { MARGINES, ODSTEP } from '@/wyglad/odstepy';

const SLAJDY = [
  { podpis: 'Sprzedaż w 2026 roku', wartosc: '371 tys. zł', opis: 'O 2% więcej niż rok temu.' },
  { podpis: 'Wystawione faktury', wartosc: '138', opis: 'Średnio prawie 3 tygodniowo.' },
  { podpis: 'Twój najlepszy miesiąc', wartosc: 'Październik', opis: '40 tys. zł wpływów.' },
  { podpis: 'Twój największy klient', wartosc: 'Kowalczyk Studio', opis: '28% sprzedaży w roku.', nazwa: true },
  { podpis: 'Najszybciej płaci', wartosc: 'Biuro Rachunkowe Sowa', opis: 'Średnio 3 dni przed terminem.', nazwa: true },
  { podpis: 'Tyle faktur poszło do KSeF bez poprawki', wartosc: '97%', opis: 'Tylko 4 wymagały ponownej wysyłki.' },
  { podpis: 'Twój najmocniejszy kwartał', wartosc: 'III kwartał', opis: 'Wrzesień ciągnął w górę.' },
];

/** „Twój rok w liczbach”: odpowiednik `flo/wrapped` (slajdy, zapis bez nazw klientów). */
export default function EkranTwojegoRoku() {
  const router = useRouter();
  const kolory = useKolory();
  const [i, setI] = useState(0);
  const [nazwy, setNazwy] = useState(false);
  const [kwoty, setKwoty] = useState(true);
  const s = SLAJDY[i] ?? SLAJDY[0]!;
  const ostatni = i === SLAJDY.length - 1;
  const wartosc = s.nazwa && !nazwy ? 'Twój klient' : !kwoty && /zł/.test(s.wartosc) ? 'ukryte' : s.wartosc;

  return (
    <>
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button onPress={() => router.back()}>Zamknij</Stack.Toolbar.Button>
      </Stack.Toolbar>
      <View style={[styles.ekran, { backgroundColor: kolory.tloGrupowane }]}>
        <View style={styles.slajd} accessible accessibilityLabel={`${s.podpis}: ${wartosc}. ${s.opis}`}>
          <Tekst styl="subheadline" kolor="etykietaDrugorzedna">
            {i + 1} z {SLAJDY.length}
          </Tekst>
          <Tekst styl="title3" style={styles.srodek}>
            {s.podpis}
          </Tekst>
          <Tekst styl="largeTitle" kolor="akcent" style={styles.srodek} adjustsFontSizeToFit numberOfLines={2}>
            {wartosc}
          </Tekst>
          <Tekst styl="body" kolor="etykietaDrugorzedna" style={styles.srodek}>
            {s.opis}
          </Tekst>
        </View>

        {ostatni ? (
          <Sekcja naglowek="Zanim to zapiszesz">
            <PolePrzelacznik etykieta="Pokaż prawdziwe nazwy kontrahentów" wartosc={nazwy} onZmiana={setNazwy} />
            <PolePrzelacznik etykieta="Pokaż kwoty" wartosc={kwoty} onZmiana={setKwoty} />
          </Sekcja>
        ) : null}

        <View style={styles.przyciski}>
          <PrzyciskGlowny
            tytul={ostatni ? 'Udostępnij podsumowanie' : 'Dalej'}
            ikona={ostatni ? 'square.and.arrow.up' : 'chevron.right'}
            onPress={() => {
              if (!ostatni) return setI(i + 1);
              void Share.share({
                message: SLAJDY.map((x) => `${x.podpis}: ${x.nazwa && !nazwy ? 'Twój klient' : !kwoty && /zł/.test(x.wartosc) ? 'ukryte' : x.wartosc}`).join('\n'),
              });
            }}
          />
          {i > 0 ? <PrzyciskGlowny tytul="Wstecz" wariant="drugorzedny" onPress={() => setI(i - 1)} /> : null}
        </View>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  ekran: { flex: 1, paddingBottom: ODSTEP.xxl },
  slajd: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: MARGINES * 2, gap: ODSTEP.s },
  srodek: { textAlign: 'center' },
  przyciski: { marginHorizontal: MARGINES, gap: ODSTEP.s, marginTop: ODSTEP.l },
});

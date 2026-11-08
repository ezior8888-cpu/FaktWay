import * as Haptics from 'expo-haptics';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Share, StyleSheet, View } from 'react-native';

import { DZIS, znajdzFakture } from '@/dane-przykladowe';
import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { StanPusty } from '@/komponenty/stan-pusty';
import { Tekst } from '@/komponenty/tekst';
import { dataPelna, kwota } from '@/lib/format';
import { doZaplaty, statusFaktury } from '@/lib/status-faktury';
import { MARGINES, ODSTEP } from '@/wyglad/odstepy';

export default function EkranFaktury() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const zrodlo = znajdzFakture(id);
  // Etap M2: zmiana tylko w pamięci ekranu; zapis przez API dochodzi w M9.
  const [zaplacona, setZaplacona] = useState(zrodlo?.zaplacona ?? false);

  if (!zrodlo) {
    return (
      <EkranListy>
        <StanPusty ikona="doc.questionmark" tytul="Nie ma takiej faktury" opis="Mogła zostać usunięta na komputerze." />
      </EkranListy>
    );
  }
  const f = { ...zrodlo, zaplacona };
  const status = statusFaktury(f, DZIS);

  const udostepnij = () => {
    void Share.share({ message: `Faktura ${f.numer} dla ${f.kontrahent}, ${kwota(f.brutto)}.` });
  };

  const przelaczZaplate = () => {
    setZaplacona((z) => !z);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  return (
    <>
      <Stack.Screen options={{ title: f.numer }} />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button icon="square.and.arrow.up" accessibilityLabel="Udostępnij" onPress={udostepnij} />
      </Stack.Toolbar>

      <EkranListy>
        <View style={styles.naglowek} accessible accessibilityLabel={`${f.kontrahent}, ${kwota(f.brutto)}, ${status.tekst}`}>
          <Tekst styl="subheadline" kolor="etykietaDrugorzedna">
            {f.kontrahent}
          </Tekst>
          <Tekst styl="largeTitle" cyfry>
            {kwota(f.brutto)}
          </Tekst>
          <Tekst styl="subheadline" kolor={status.kolor}>
            {status.tekst}
          </Tekst>
        </View>

        {doZaplaty(f) || f.zaplacona ? (
          <Sekcja>
            <Wiersz
              tytul={f.zaplacona ? 'Cofnij oznaczenie zapłaty' : 'Oznacz jako zapłaconą'}
              akcja
              onPress={przelaczZaplate}
            />
          </Sekcja>
        ) : null}

        <Sekcja naglowek="Szczegóły">
          <Wiersz tytul="Numer" wartosc={f.numer} />
          <Wiersz tytul="Wystawiona" wartosc={dataPelna(f.dataWystawienia)} />
          <Wiersz tytul="Termin płatności" wartosc={dataPelna(f.terminPlatnosci)} />
          <Wiersz tytul="NIP nabywcy" wartosc={f.nipKontrahenta} />
        </Sekcja>

        <Sekcja naglowek="Pozycje" stopka={`Netto ${kwota(f.netto)}, VAT ${kwota(f.brutto - f.netto)}`}>
          {f.pozycje.map((p, i) => (
            <Wiersz
              key={i}
              tytul={p.nazwa}
              podtytul={`${p.ilosc} ${p.jednostka} × ${kwota(p.cenaNetto)} netto, VAT ${p.stawkaVat}%`}
              wartosc={kwota(Math.round(p.ilosc * p.cenaNetto * (1 + p.stawkaVat / 100)))}
            />
          ))}
        </Sekcja>

        <Sekcja
          naglowek="KSeF"
          stopka={
            f.statusKsef === 'odrzucona'
              ? 'KSeF odrzucił fakturę. Popraw ją na faktway.pl i wyślij ponownie.'
              : undefined
          }>
          <Wiersz
            tytul="Status"
            wartosc={
              f.statusKsef === 'przyjeta'
                ? 'Przyjęta'
                : f.statusKsef === 'wysylanie'
                  ? 'Wysyłanie'
                  : f.statusKsef === 'odrzucona'
                    ? 'Odrzucona'
                    : 'Szkic'
            }
          />
          {f.numerKsef ? <Wiersz tytul="Numer KSeF" podtytul={f.numerKsef} /> : null}
        </Sekcja>
      </EkranListy>
    </>
  );
}

const styles = StyleSheet.create({
  naglowek: { paddingHorizontal: MARGINES + ODSTEP.xxs, paddingTop: ODSTEP.m, gap: ODSTEP.xxs },
});

import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';

import { KATEGORIE_KOSZTOW, NAZWA_KOLUMNY, NAZWA_ZRODLA, NOWY_WYDATEK, PUSTY_WYDATEK, type KolumnaKpir } from '@/dane-przykladowe';
import { PoleDaty, PolePrzelacznik, PoleTekstowe, PoleWyboru } from '@/komponenty/formularz';
import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { NaglowekKwoty } from '@/komponenty/naglowek';
import { PrzyciskGlowny } from '@/komponenty/przycisk-glowny';
import { StanPusty } from '@/komponenty/stan-pusty';
import { doPola, groszeZPola as grosze, kwota } from '@/lib/format';
import { useStanFaktur } from '@/stan/faktury';
import { MARGINES, ODSTEP } from '@/wyglad/odstepy';

/**
 * Opis i akceptacja wydatku: odpowiednik `expenses/[id]` (auto-kategoryzacja,
 * sprzedawca, dokument, kwoty, kolumna KPiR, kategoria, notatki).
 */
export default function EkranWydatku() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { koszty, zapiszKoszt, usunKoszt } = useStanFaktur();
  const k = id === NOWY_WYDATEK ? PUSTY_WYDATEK : koszty.find((x) => x.id === id);
  const [dostawca, setDostawca] = useState(k?.dostawca ?? '');
  const [nip, setNip] = useState(k?.nip ?? '');
  const [numer, setNumer] = useState(k?.numer ?? '');
  const [data, setData] = useState(k?.data ?? '2026-11-09');
  const [netto, setNetto] = useState(k && k.netto ? doPola(k.netto) : '');
  const [brutto, setBrutto] = useState(k && k.brutto ? doPola(k.brutto) : '');
  const [kolumna, setKolumna] = useState<KolumnaKpir>(k?.kolumna ?? '13');
  const [kategoria, setKategoria] = useState(k?.kategoria ?? 'Pozostałe wydatki');
  const [wKpir, setWKpir] = useState(k?.wKpir ?? true);
  const [notatki, setNotatki] = useState(k?.opis ?? '');
  const [blad, setBlad] = useState<string>();

  if (!k) return <StanPusty ikona="file-unknow-line" tytul="Nie ma takiego wydatku" opis="Mógł zostać usunięty na komputerze." />;
  const zKsef = k.zrodlo === 'ksef';
  const vat = (grosze(brutto) || 0) - (grosze(netto) || 0);

  const zapisz = () => {
    if (!dostawca.trim()) return setBlad('Wpisz nazwę sprzedawcy.');
    if (!(grosze(brutto) > 0)) return setBlad('Wpisz kwotę brutto.');
    zapiszKoszt({
      ...k,
      dostawca: dostawca.trim(),
      nip: nip.trim() || undefined,
      numer: numer.trim(),
      data,
      netto: grosze(netto) || 0,
      brutto: grosze(brutto),
      kolumna,
      kategoria,
      wKpir,
      opis: notatki.trim() || k.opis,
      doOpisania: false,
    });
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    router.back();
  };

  const nowy = !k.id;
  const przycisk = nowy ? 'Dodaj wydatek' : !wKpir ? 'Zapisz poza KPiR' : k.doOpisania ? 'Zaakceptuj' : 'Zapisz zmiany';

  return (
    <>
      <Stack.Screen options={{ title: nowy ? 'Nowy wydatek' : k.doOpisania ? 'Zaakceptuj wydatek' : 'Edytuj wydatek' }} />
      <EkranListy keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
        <NaglowekKwoty
          podpis={k.dostawca || 'Nowy wydatek'}
          podpisWyrozniony
          wartosc={kwota(k.brutto)}
          status={nowy ? 'Wpisz dane z dokumentu' : k.doOpisania ? 'Sprawdź dane rozpoznane automatycznie i zatwierdź' : 'Opisany'}
          statusKolor={nowy ? 'etykietaDrugorzedna' : k.doOpisania ? 'ostrzezenie' : 'sukces'}
        />

        {k.zrodlo !== 'reczny' ? (
          <Sekcja stopka="Kategorię i kolumnę dobraliśmy z dostawcy i treści dokumentu. Zmień, jeśli się nie zgadza.">
            <Wiersz tytul={`Wykryto: ${k.kategoria} · Kol. ${k.kolumna}`} ikona="price-tag3-line" ikonaKolor="akcent" />
          </Sekcja>
        ) : null}

        <Sekcja naglowek="Szczegóły">
          <Wiersz tytul="Źródło" wartosc={NAZWA_ZRODLA[k.zrodlo]} />
          <Wiersz tytul="Dokument" wartosc={k.dokument} />
          {k.numerKsef ? <Wiersz tytul="Numer KSeF" podtytul={k.numerKsef} zaznaczalna /> : null}
        </Sekcja>

        <Sekcja naglowek="Sprzedawca">
          <PoleTekstowe etykieta="Nazwa" wartosc={dostawca} onZmiana={setDostawca} podpowiedz="Nazwa sprzedawcy" />
          <PoleTekstowe etykieta="NIP" wartosc={nip} onZmiana={setNip} podpowiedz="opcjonalnie" klawiatura="number-pad" />
        </Sekcja>

        <Sekcja naglowek="Dokument">
          <PoleTekstowe etykieta="Numer" wartosc={numer} onZmiana={setNumer} podpowiedz="Numer dokumentu" />
          <PoleDaty etykieta="Data wystawienia" wartosc={data} onZmiana={setData} />
        </Sekcja>

        <Sekcja naglowek="Kwoty" stopka={blad}>
          <PoleTekstowe etykieta="Netto" wartosc={netto} onZmiana={setNetto} podpowiedz="zł" klawiatura="decimal-pad" />
          <Wiersz tytul="VAT" wartosc={kwota(vat)} />
          <PoleTekstowe etykieta="Brutto" wartosc={brutto} onZmiana={setBrutto} podpowiedz="zł" klawiatura="decimal-pad" />
        </Sekcja>

        <Sekcja naglowek="Kategoryzacja KPiR" stopka="Wyłącz, jeśli ten wydatek nie jest kosztem firmowym.">
          <PoleWyboru
            etykieta="Kolumna KPiR"
            wartosc={kolumna}
            opcje={(Object.keys(NAZWA_KOLUMNY) as KolumnaKpir[]).map((c) => ({ wartosc: c, etykieta: NAZWA_KOLUMNY[c] }))}
            onZmiana={setKolumna}
          />
          <PoleWyboru etykieta="Kategoria" wartosc={kategoria} opcje={KATEGORIE_KOSZTOW.map((x) => ({ wartosc: x, etykieta: x }))} onZmiana={setKategoria} />
          <PolePrzelacznik etykieta="Uwzględnij w KPiR" wartosc={wKpir} onZmiana={setWKpir} />
        </Sekcja>

        <Sekcja naglowek="Notatki">
          <PoleTekstowe etykieta="Notatki" wartosc={notatki} onZmiana={setNotatki} podpowiedz="np. Zakup na potrzeby projektu X" wielowierszowe />
        </Sekcja>

        <View style={styles.przyciski}>
          <PrzyciskGlowny tytul={przycisk} ikona="check-line" onPress={zapisz} />
        </View>

        {zKsef ? (
          <Sekcja stopka="Wydatków z KSeF nie usuwa się: przychodzą z urzędowego systemu." />
        ) : !k.id ? null : (
          <Sekcja>
            <Wiersz
              tytul="Usuń wydatek"
              niszczacy
              onPress={() =>
                Alert.alert('Usunąć ten wydatek?', 'Zniknie z listy i z KPiR.', [
                  { text: 'Anuluj', style: 'cancel' },
                  {
                    text: 'Usuń wydatek',
                    style: 'destructive',
                    onPress: () => {
                      usunKoszt(k.id);
                      router.back();
                    },
                  },
                ])
              }
            />
          </Sekcja>
        )}
      </EkranListy>
    </>
  );
}

const styles = StyleSheet.create({
  przyciski: { marginHorizontal: MARGINES, marginTop: ODSTEP.xl },
});

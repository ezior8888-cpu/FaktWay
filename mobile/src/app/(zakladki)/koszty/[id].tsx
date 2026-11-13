import { Image } from 'expo-image';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  KATEGORIE_KOSZTOW,
  KOLUMNY_KOSZTU,
  NAZWA_KOLUMNY,
  NAZWA_ZRODLA,
  NOWY_WYDATEK,
  PUSTY_WYDATEK,
  type KolumnaKpir,
  type Koszt,
} from '@/dane-przykladowe';
import { PoleDaty, PolePrzelacznik, PoleTekstowe, PoleWyboru } from '@/komponenty/formularz';
import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { NaglowekKwoty } from '@/komponenty/naglowek';
import { wydatekNaStronie } from '@/komponenty/na-stronie';
import { potwierdz } from '@/komponenty/potwierdz';
import { PrzyciskGlowny } from '@/komponenty/przycisk-glowny';
import { StanPusty } from '@/komponenty/stan-pusty';
import { SzkieletListy } from '@/komponenty/szkielet';
import { Tekst } from '@/komponenty/tekst';
import { doPola, groszeZPola as grosze, kwota } from '@/lib/format';
import { czekaNaZlote, sprawdzFormularz, vatKosztu, type BladFormularza, type FormularzWydatku } from '@/lib/wydatek/zatwierdzenie';
import { useStanFaktur } from '@/stan/faktury';
import { useKolory } from '@/wyglad/kolory';
import { useTytulNaGradiencie } from '@/wyglad/naglowki';
import { MARGINES, ODSTEP, PROMIEN_KARTY } from '@/wyglad/odstepy';

/**
 * Opis i akceptacja wydatku, także sprawdzenie odczytu zdjęcia (M9):
 * odpowiednik `expenses/[id]` strony (kategoria wykryta automatycznie,
 * sprzedawca, dokument, kwoty netto, VAT i brutto, kolumna KPiR, kategoria,
 * KPiR tak albo nie, notatki). Po skanie nad polami stoi zdjęcie, żeby
 * porównać odczyt z dokumentem. Na prawdziwym koncie zapis przez
 * `POST /wydatki/{id}/zatwierdzenie` (te same zasady co na stronie);
 * wydatek z KSeF, wpis ręczny i usunięcie na faktway.pl.
 */
export default function EkranWydatku() {
  const { id, zdjecie } = useLocalSearchParams<{ id: string; zdjecie?: string }>();
  const { koszty, dane } = useStanFaktur();
  const k = id === NOWY_WYDATEK ? PUSTY_WYDATEK : koszty.find((x) => x.id === id);
  if (!k) {
    // Wydatek z odczytu może dojść z bazy chwilę po wejściu: szkielet zamiast pustego formularza.
    if (dane.zrodlo === 'baza' && dane.stan === 'ladowanie') {
      return (
        <EkranListy>
          <SzkieletListy wiersze={4} etykieta="Wczytujemy wydatek" />
        </EkranListy>
      );
    }
    return <StanPusty ikona="file-unknow-line" tytul="Nie ma takiego wydatku" opis="Mógł zostać usunięty na komputerze. Odśwież listę wydatków." />;
  }
  // Klucz: pola formularza biorą wartości z wydatku przy pierwszym rysowaniu tego wydatku.
  return <FormularzKosztu key={k.id || NOWY_WYDATEK} k={k} zdjecie={zdjecie} />;
}

function FormularzKosztu({ k, zdjecie }: { k: Koszt; zdjecie?: string }) {
  const router = useRouter();
  const kolory = useKolory();
  const { zapiszKoszt, usunKoszt, zatwierdzKoszt, dane } = useStanFaktur();
  const naKoncie = dane.zrodlo === 'baza';
  const { tytul, onScroll, scrollEventThrottle } = useTytulNaGradiencie();
  const [dostawca, setDostawca] = useState(k.dostawca);
  const [nip, setNip] = useState(k.nip ?? '');
  const [numer, setNumer] = useState(k.numer);
  const [data, setData] = useState(k.data);
  const [netto, setNetto] = useState(k.netto ? doPola(k.netto) : '');
  const [vat, setVat] = useState(k.brutto ? doPola(vatKosztu(k)) : '');
  const [brutto, setBrutto] = useState(k.brutto ? doPola(k.brutto) : '');
  const [kolumna, setKolumna] = useState<KolumnaKpir>(k.kolumna);
  const [kategoria, setKategoria] = useState(k.kategoria);
  const [wKpir, setWKpir] = useState(k.wKpir);
  const [notatki, setNotatki] = useState(k.opis);
  const [zlote, setZlote] = useState(false);
  const [blad, setBlad] = useState<BladFormularza | { pole?: undefined; komunikat: string }>();
  const [trwa, setTrwa] = useState(false);

  const zKsef = k.zrodlo === 'ksef';
  const nowy = !k.id;
  const waluta = czekaNaZlote(k);
  // Kwoty w walucie dokumentu, dopóki klient nie potwierdzi, że wpisał złote.
  const jednostka = waluta && !zlote ? waluta : 'zł';
  const opisNaStronie = naKoncie && zKsef;

  const formularz = (): FormularzWydatku => ({
    dostawca,
    nip,
    numer,
    data,
    netto: grosze(netto),
    vat: grosze(vat || '0'),
    brutto: grosze(brutto),
    kolumna,
    kategoria,
    wKpir,
    notatki,
    zlotePotwierdzone: zlote,
  });

  const zapisz = async () => {
    if (opisNaStronie) return wydatekNaStronie(k.id);
    const f = formularz();
    const problem = sprawdzFormularz(f);
    if (problem) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      return setBlad(problem);
    }
    setBlad(undefined);
    if (nowy) {
      // Dane przykładowe: wpis ręczny w pamięci (na koncie odsyła na stronę `zapiszKoszt`).
      zapiszKoszt({ ...k, dostawca: f.dostawca.trim(), nip: f.nip.trim() || undefined, numer: f.numer.trim(), data, netto: f.netto, vat: f.vat, brutto: f.brutto, kolumna, kategoria, wKpir, opis: f.notatki.trim(), doOpisania: false });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      return router.back();
    }
    setTrwa(true);
    const w = await zatwierdzKoszt(k, f);
    setTrwa(false);
    if (!w.ok) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      return setBlad({ komunikat: w.komunikat });
    }
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    if (w.uwaga) {
      return potwierdz({ tytul: 'Wydatek zapisany poza KPiR', opis: w.uwaga, potwierdz: 'Wróć do wydatków', anuluj: 'Zostań', zwykly: true }, () => router.back());
    }
    router.back();
  };

  const przycisk = opisNaStronie ? 'Opisz na faktway.pl' : nowy ? 'Dodaj wydatek' : !wKpir ? 'Zapisz poza KPiR' : k.doOpisania ? 'Zatwierdź wydatek' : 'Zapisz zmiany';
  const opcjeKolumn = (KOLUMNY_KOSZTU.includes(k.kolumna) ? KOLUMNY_KOSZTU : [...KOLUMNY_KOSZTU, k.kolumna]).map((c) => ({ wartosc: c, etykieta: NAZWA_KOLUMNY[c] }));
  const kategorie: string[] = (KATEGORIE_KOSZTOW as readonly string[]).includes(k.kategoria) ? [...KATEGORIE_KOSZTOW] : [...KATEGORIE_KOSZTOW, k.kategoria];
  const bladPola = (pole: BladFormularza['pole']) => (blad?.pole === pole ? blad.komunikat : undefined);

  return (
    <>
      <Stack.Screen options={{ title: nowy ? 'Nowy wydatek' : k.doOpisania ? 'Sprawdź odczyt' : 'Edytuj wydatek', headerTitleStyle: tytul }} />
      <EkranListy gradient onScroll={onScroll} scrollEventThrottle={scrollEventThrottle} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
        <NaglowekKwoty
          podpis={k.dostawca || 'Nowy wydatek'}
          podpisWyrozniony
          wartosc={kwota(k.brutto, k.walutaKwot ?? 'PLN')}
          status={nowy ? 'Wpisz dane z dokumentu' : k.doOpisania ? 'Porównaj odczyt z dokumentem i zatwierdź' : 'Opisany'}
          statusKolor={nowy ? 'etykietaDrugorzedna' : k.doOpisania ? 'ostrzezenie' : 'sukces'}
        />

        {zdjecie ? (
          <Sekcja naglowek="Dokument" stopka="Zdjęcie z tego telefonu. Oryginał trafił do archiwum dokumentów firmy.">
            <Image
              source={{ uri: zdjecie }}
              contentFit="contain"
              style={[styles.zdjecie, { backgroundColor: kolory.wypelnienie }]}
              accessibilityLabel="Zdjęcie dokumentu, z którego odczytaliśmy dane"
            />
          </Sekcja>
        ) : null}

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
          <PoleTekstowe etykieta="Nazwa" wartosc={dostawca} onZmiana={setDostawca} podpowiedz="Nazwa sprzedawcy" blad={bladPola('dostawca')} />
          <PoleTekstowe etykieta="NIP" wartosc={nip} onZmiana={setNip} podpowiedz="opcjonalnie" klawiatura="number-pad" cyfry />
        </Sekcja>

        <Sekcja naglowek="Dokument">
          <PoleTekstowe etykieta="Numer" wartosc={numer} onZmiana={setNumer} podpowiedz="Numer dokumentu" cyfry />
          <PoleDaty etykieta="Data wystawienia" wartosc={data} onZmiana={setData} />
        </Sekcja>

        <Sekcja
          naglowek="Kwoty"
          stopka={waluta ? `Dokument jest w ${waluta}, a kursu NBP nie było. Wpisz kwoty w złotych i zaznacz to niżej, inaczej wydatek zostanie poza KPiR.` : undefined}>
          <PoleTekstowe etykieta="Netto" wartosc={netto} onZmiana={setNetto} podpowiedz={jednostka} klawiatura="decimal-pad" blad={bladPola('netto')} />
          <PoleTekstowe etykieta="VAT" wartosc={vat} onZmiana={setVat} podpowiedz={jednostka} klawiatura="decimal-pad" blad={bladPola('vat')} />
          <PoleTekstowe etykieta="Brutto" wartosc={brutto} onZmiana={setBrutto} podpowiedz={jednostka} klawiatura="decimal-pad" blad={bladPola('brutto')} />
          {waluta ? <PolePrzelacznik etykieta="Kwoty są w złotych" opis={`Przeliczone z ${waluta} na złote`} wartosc={zlote} onZmiana={setZlote} /> : null}
        </Sekcja>

        <Sekcja naglowek="Kategoryzacja KPiR" stopka="Wyłącz, jeśli ten wydatek nie jest kosztem firmowym.">
          <PoleWyboru etykieta="Kolumna KPiR" wartosc={kolumna} opcje={opcjeKolumn} onZmiana={setKolumna} />
          <PoleWyboru etykieta="Kategoria" wartosc={kategoria} opcje={kategorie.map((x) => ({ wartosc: x, etykieta: x }))} onZmiana={setKategoria} />
          <PolePrzelacznik etykieta="Uwzględnij w KPiR" wartosc={wKpir} onZmiana={setWKpir} />
        </Sekcja>

        <Sekcja naglowek="Notatki">
          <PoleTekstowe etykieta="Notatki" wartosc={notatki} onZmiana={setNotatki} podpowiedz="np. Zakup na potrzeby projektu X" wielowierszowe />
        </Sekcja>

        <View style={styles.przyciski}>
          {blad && !blad.pole ? (
            <Tekst styl="footnote" kolor="blad" accessibilityLiveRegion="polite">
              {blad.komunikat}
            </Tekst>
          ) : null}
          <PrzyciskGlowny tytul={przycisk} ikona={opisNaStronie ? 'global-line' : 'check-line'} trwa={trwa} onPress={() => void zapisz()} />
        </View>

        {zKsef ? (
          <Sekcja stopka={naKoncie ? 'Wydatek z KSeF opiszesz na faktway.pl: tam porównasz go z fakturą z KSeF. Nie usuwa się go, bo przychodzi z urzędowego systemu.' : 'Wydatków z KSeF nie usuwa się: przychodzą z urzędowego systemu.'} />
        ) : !k.id ? null : (
          <Sekcja>
            <Wiersz
              tytul="Usuń wydatek"
              niszczacy
              onPress={() =>
                naKoncie
                  ? usunKoszt(k.id)
                  : potwierdz({ tytul: 'Usunąć ten wydatek?', opis: 'Zniknie z listy i z KPiR.', potwierdz: 'Usuń wydatek' }, () => {
                      usunKoszt(k.id);
                      router.back();
                    })
              }
            />
          </Sekcja>
        )}
      </EkranListy>
    </>
  );
}

const styles = StyleSheet.create({
  przyciski: { marginHorizontal: MARGINES, marginTop: ODSTEP.xl, gap: ODSTEP.s },
  zdjecie: { height: 260, borderRadius: PROMIEN_KARTY - 6, margin: ODSTEP.s },
});

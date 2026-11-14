import { Image } from 'expo-image';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { NOWY_WYDATEK } from '@/dane-przykladowe';
import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { wydatekNaStronie } from '@/komponenty/na-stronie';
import { potwierdz } from '@/komponenty/potwierdz';
import { PrzyciskGlowny } from '@/komponenty/przycisk-glowny';
import { StanPusty } from '@/komponenty/stan-pusty';
import { Tekst } from '@/komponenty/tekst';
import { kluczZapisu } from '@/lib/faktura/wystawienie';
import { skanerDostepny, skanujDokument } from '@/lib/skaner';
import { czekajNaOdczyt } from '@/lib/wydatek/zatwierdzenie';
import { useKontoFirmy } from '@/stan/dane';
import { useStanFaktur, type PlikDokumentu } from '@/stan/faktury';
import { MARGINES, ODSTEP, PROMIEN_KARTY } from '@/wyglad/odstepy';
import { useKolory } from '@/wyglad/kolory';

type Etap =
  | { rodzaj: 'wybor' }
  | { rodzaj: 'wgrywanie' }
  | { rodzaj: 'rozpoznaje' }
  /** `ponow`: to samo zdjęcie jeszcze raz (ten sam klucz, bez drugiego kosztu); inaczej nowe zdjęcie. */
  | { rodzaj: 'blad'; tytul: string; opis: string; ponow: boolean };

/** Zdjęcie z galerii: JPG (iOS zamienia HEIC), kompresja jak zmniejszanie zdjęć na stronie. */
const OPCJE_GALERII: ImagePicker.ImagePickerOptions = {
  mediaTypes: ['images'],
  quality: 0.7,
  preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
};

/**
 * Arkusz „Dodaj wydatek” (etap M9; na stronie przycisk „Dodaj wydatek”,
 * `components/expenses/use-expense-capture.tsx`): systemowy skaner dokumentów
 * albo zdjęcie z galerii, wgranie z kluczem na zdjęcie, czekanie na odczyt
 * i przejście do sprawdzenia odczytu (`koszty/[id]`).
 *
 * Ponowienie po zerwanym połączeniu wysyła to samo zdjęcie z tym samym
 * kluczem: serwer oddaje ten sam odczyt, bez drugiego kosztu. Gdy stan
 * odczytu jest nieznany (sieć), pytamy dalej i nie proponujemy zdjęcia
 * drugi raz (na stronie E16).
 */
export default function EkranDodawaniaWydatku() {
  const router = useRouter();
  const kolory = useKolory();
  const { wgrajDokument, stanOdczytu, odswiezWydatki, dane } = useStanFaktur();
  const naKoncie = dane.zrodlo === 'baza';
  // Firma arkusza: zapamiętana przy otwarciu (albo gdy konto dojdzie), wgranie i odczyt idą do niej.
  const firmaTeraz = useKontoFirmy()?.firma?.id ?? null;
  const [firmaArkusza, setFirmaArkusza] = useState(firmaTeraz);
  if (!firmaArkusza && firmaTeraz) setFirmaArkusza(firmaTeraz);
  const [etap, setEtap] = useState<Etap>({ rodzaj: 'wybor' });
  const [podglad, setPodglad] = useState<string>();
  const plik = useRef<PlikDokumentu | null>(null);
  const klucz = useRef('');
  // Arkusz zamknięty w trakcie: bez dalszych pytań, bez przejścia i bez wibracji.
  const zamkniety = useRef(false);
  useEffect(() => {
    zamkniety.current = false;
    return () => {
      zamkniety.current = true;
    };
  }, []);

  const blad = (tytul: string, opis: string, ponow: boolean) => {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    setEtap({ rodzaj: 'blad', tytul, opis, ponow });
  };

  const wyslij = async () => {
    const p = plik.current;
    if (!p) return;
    setEtap({ rodzaj: 'wgrywanie' });
    const w = await wgrajDokument(p, klucz.current, firmaArkusza);
    if (zamkniety.current) return;
    if (!w.ok) {
      return blad(w.ponow ? 'Nie udało się wysłać zdjęcia' : 'FaktWay nie przyjął tego pliku', w.komunikat, w.ponow);
    }
    setEtap({ rodzaj: 'rozpoznaje' });
    const koniec = await czekajNaOdczyt(() => stanOdczytu(w.odczytId, firmaArkusza), { przerwano: () => zamkniety.current });
    if (zamkniety.current || koniec.wynik === 'przerwano') return;
    switch (koniec.wynik) {
      case 'gotowy':
        await odswiezWydatki();
        if (zamkniety.current) return;
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        router.replace({ pathname: '/koszty/[id]', params: { id: koniec.wydatekId, ...(p.typ.startsWith('image/') && p.uri ? { zdjecie: p.uri } : {}) } });
        return;
      case 'nieudany':
        return blad('Nie udało się odczytać dokumentu', `${koniec.komunikat} Zrób zdjęcie jeszcze raz, przy dobrym świetle, z całym dokumentem w kadrze.`, false);
      case 'brak':
        return blad('Nie ma tego odczytu', 'Sprawdź listę wydatków. Jeśli wydatku nie ma, zrób zdjęcie jeszcze raz.', false);
      case 'czas':
        // Odczyt może się jeszcze udać: drugie zdjęcie dałoby drugi koszt.
        void odswiezWydatki();
        return blad('Odczyt trwa dłużej niż zwykle', 'Wydatek pojawi się na liście, gdy skończymy. Nie wysyłaj tego zdjęcia drugi raz.', false);
      case 'sesja':
        return blad('Zaloguj się ponownie', 'Sesja wygasła w trakcie odczytu. Po zalogowaniu wydatek będzie na liście.', false);
    }
  };

  const wybierz = (p: PlikDokumentu) => {
    plik.current = p;
    // Jeden klucz na zdjęcie: „Spróbuj ponownie” wysyła je z tym samym kluczem.
    klucz.current = kluczZapisu();
    setPodglad(p.typ.startsWith('image/') && p.uri ? p.uri : undefined);
    void wyslij();
  };

  const skanuj = async () => {
    if (!skanerDostepny()) {
      // Dane przykładowe w symulatorze: odczyt przykładowego paragonu bez aparatu.
      if (!naKoncie) return wybierz({ uri: '', nazwa: 'przyklad.jpg', typ: 'image/jpeg' });
      return potwierdz(
        { tytul: 'Skaner działa na iPhonie z aparatem', opis: 'Na tym urządzeniu wybierz zdjęcie dokumentu z galerii.', potwierdz: 'Wybierz z galerii', zwykly: true },
        () => void zGalerii(),
      );
    }
    try {
      const skan = await skanujDokument();
      if (!skan || zamkniety.current) return;
      wybierz({ uri: skan.uri, nazwa: skan.typ === 'application/pdf' ? 'skan.pdf' : 'skan.jpg', typ: skan.typ });
    } catch (e) {
      blad('Skaner się zatrzymał', e instanceof Error ? e.message : 'Spróbuj jeszcze raz albo wybierz zdjęcie z galerii.', false);
    }
  };

  const zGalerii = async () => {
    const wynik = await ImagePicker.launchImageLibraryAsync(OPCJE_GALERII).catch(() => null);
    if (zamkniety.current) return;
    if (!wynik) return blad('Nie można otworzyć galerii', 'Spróbuj jeszcze raz albo zeskanuj dokument.', false);
    const zdjecie = wynik.canceled ? undefined : wynik.assets[0];
    if (!zdjecie) return;
    wybierz({ uri: zdjecie.uri, nazwa: zdjecie.fileName ?? 'zdjecie.jpg', typ: zdjecie.mimeType ?? 'image/jpeg' });
  };

  // Pusty formularz; wydatek powstaje dopiero po „Zapisz” (wyjście bez zapisu nie zostawia pustego wiersza).
  const reczny = () => (naKoncie ? wydatekNaStronie() : router.replace({ pathname: '/koszty/[id]', params: { id: NOWY_WYDATEK } }));

  if (etap.rodzaj === 'blad') {
    return (
      <EkranListy>
        <StanPusty ikona="error-warning-line" tytul={etap.tytul} opis={etap.opis} />
        <View style={styles.przyciski}>
          {etap.ponow ? (
            <PrzyciskGlowny tytul="Spróbuj ponownie" ikona="refresh-line" onPress={() => void wyslij()} />
          ) : (
            <PrzyciskGlowny tytul="Zrób zdjęcie jeszcze raz" ikona="camera-line" onPress={() => setEtap({ rodzaj: 'wybor' })} />
          )}
          <PrzyciskGlowny tytul="Wróć do wydatków" wariant="drugorzedny" onPress={() => router.back()} />
        </View>
      </EkranListy>
    );
  }

  if (etap.rodzaj !== 'wybor') {
    const wgrywa = etap.rodzaj === 'wgrywanie';
    return (
      <View style={styles.czekanie} accessible accessibilityLiveRegion="polite" accessibilityLabel={wgrywa ? 'Wysyłamy zdjęcie' : 'Odczytujemy dokument'}>
        {podglad ? (
          <Image source={{ uri: podglad }} contentFit="contain" style={[styles.podglad, { backgroundColor: kolory.wypelnienie }]} accessibilityIgnoresInvertColors />
        ) : null}
        <ActivityIndicator />
        <Tekst styl="headline">{wgrywa ? 'Wysyłamy zdjęcie…' : 'Odczytujemy dokument…'}</Tekst>
        <Tekst styl="subheadline" kolor="etykietaDrugorzedna" style={styles.srodek}>
          {wgrywa ? 'Zdjęcie trafia do archiwum dokumentów firmy.' : 'Sprzedawca, data i kwoty. Zwykle kilkanaście sekund.'}
        </Tekst>
      </View>
    );
  }

  return (
    <EkranListy>
      <Sekcja stopka="Paragon albo faktura: dane odczytamy sami. Potem sprawdzasz odczyt i zatwierdzasz wydatek.">
        <Wiersz tytul="Skanuj dokument" podtytul="Aparat sam wykryje krawędzie kartki" ikona="camera-line" strzalka onPress={() => void skanuj()} />
        <Wiersz tytul="Wybierz z galerii" podtytul="Zdjęcie paragonu albo faktury" ikona="image-line" strzalka onPress={() => void zGalerii()} />
        <Wiersz tytul="Wpisz ręcznie" ikona="edit-box-line" strzalka onPress={reczny} />
      </Sekcja>
    </EkranListy>
  );
}

const styles = StyleSheet.create({
  czekanie: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: ODSTEP.s, paddingHorizontal: MARGINES * 2 },
  podglad: { width: 160, height: 200, borderRadius: PROMIEN_KARTY, marginBottom: ODSTEP.m },
  srodek: { textAlign: 'center' },
  przyciski: { marginHorizontal: MARGINES, marginTop: ODSTEP.l, gap: ODSTEP.s },
});

import * as Haptics from 'expo-haptics';
import { Stack, useLocalSearchParams, usePreventRemove, useRouter } from 'expo-router';
import { useState } from 'react';
import { ActionSheetIOS, Alert, Platform, StyleSheet, View } from 'react-native';

import {
  bruttoPozycji,
  DZIS,
  nettoPozycji,
  SPRZEDAWCA,
  vatPozycji,
  type Faktura,
  type MetodaPlatnosci,
  type Pozycja,
  type RodzajFaktury,
} from '@/dane-przykladowe';
import { KONTRAHENCI, type Kontrahent } from '@/dane-przykladowe/kontrahenci';
import { PoleDaty, PolePrzelacznik, PoleTekstowe, PoleWyboru } from '@/komponenty/formularz';
import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { PrzyciskGlowny } from '@/komponenty/przycisk-glowny';
import { Tekst } from '@/komponenty/tekst';
import { dataKrotka, dniMiedzy, doPola, groszeZPola as grosze, kwota } from '@/lib/format';
import { useStanFaktur } from '@/stan/faktury';
import { MARGINES, ODSTEP } from '@/wyglad/odstepy';

const TYTUL: Record<RodzajFaktury, string> = {
  vat: 'Nowa faktura',
  zaliczkowa: 'Faktura zaliczkowa',
  rozliczajaca: 'Faktura rozliczająca',
  korygujaca: 'Faktura korygująca',
};

const PREFIKS: Record<RodzajFaktury, string> = { vat: 'FV', zaliczkowa: 'FZ', rozliczajaca: 'FR', korygujaca: 'KOR' };

const STAWKI_ZWYKLE = [
  { wartosc: '23', etykieta: '23%' },
  { wartosc: '8', etykieta: '8%' },
  { wartosc: '5', etykieta: '5%' },
  { wartosc: '0', etykieta: '0%' },
  { wartosc: 'zw', etykieta: 'zw (zwolniona)' },
  { wartosc: 'oo', etykieta: 'oo (odwrotne obciążenie)' },
  { wartosc: 'np', etykieta: 'np (nie podlega)' },
];
const STAWKI_ZALICZKI = STAWKI_ZWYKLE.slice(0, 4);
const STAWKI_ROZLICZENIA = STAWKI_ZWYKLE.filter((s) => s.wartosc !== 'zw');

type PozycjaFormularza = { nazwa: string; ilosc: string; jednostka: string; cena: string; stawka: string };

function liczba(tekst: string): number {
  return Number(tekst.replace(',', '.'));
}

function stawkaProcent(s: string): number {
  return /^\d+$/.test(s) ? Number(s) : 0;
}

function doPozycji(p: PozycjaFormularza): Pozycja {
  return { nazwa: p.nazwa.trim(), ilosc: liczba(p.ilosc) || 0, jednostka: p.jednostka || 'szt', cenaNetto: grosze(p.cena) || 0, stawkaVat: stawkaProcent(p.stawka) };
}

/** Pozycja zapisanej faktury z powrotem w polach formularza (wzór, korekta, edycja). */
function zPozycji(p: Pozycja): PozycjaFormularza {
  return { nazwa: p.nazwa, ilosc: String(p.ilosc), jednostka: p.jednostka, cena: doPola(p.cenaNetto), stawka: String(p.stawkaVat) };
}

/** Termin z zapisanej faktury na najbliższą opcję wyboru (7, 14, 30 dni). */
function najblizszyTermin(dni: number): string {
  return [7, 14, 30].reduce((a, b) => (Math.abs(b - dni) < Math.abs(a - dni) ? b : a)).toString();
}

function dodajDni(iso: string, dni: number): string {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + dni);
  return d.toISOString().slice(0, 10);
}

const PUSTA: PozycjaFormularza = { nazwa: '', ilosc: '1', jednostka: 'szt', cena: '', stawka: '23' };

/**
 * Formularz faktury: zwykła, zaliczkowa, rozliczająca, korygująca. Odpowiednik
 * `components/invoices/invoice-form.tsx`, `advance-form.tsx`, `final-form.tsx`
 * i `correction-form.tsx` (pola i różnice jak na stronie).
 */
export default function EkranFormularzaFaktury() {
  const router = useRouter();
  const { rodzaj: rodzajParam, wzor, z, edytuj, wprost } = useLocalSearchParams<{ rodzaj: string; wzor?: string; z?: string; edytuj?: string; wprost?: string }>();
  const rodzaj: RodzajFaktury = (['vat', 'zaliczkowa', 'rozliczajaca', 'korygujaca'] as const).find((r) => r === rodzajParam) ?? 'vat';
  const { faktury, dodajFakture, zastapFakture } = useStanFaktur();
  // Edycja szkicu albo odrzuconej faktury: te same pola, zapis w miejscu starej.
  const edytowana = faktury.find((f) => f.id === edytuj && (f.statusKsef === 'robocza' || f.statusKsef === 'odrzucona'));
  const wzorFaktury = edytowana ?? faktury.find((f) => f.id === wzor);

  const startowy = KONTRAHENCI.find((k) => k.nazwa === (wzorFaktury?.kontrahent ?? faktury.find((f) => f.id === z)?.kontrahent));
  const [ulicaStart, miastoStart] = startowy?.adres.split(', ') ?? [];
  const [numer, setNumer] = useState(edytowana?.numer ?? `${PREFIKS[rodzaj]}/11/2026/${faktury.filter((f) => f.rodzaj === rodzaj).length + 1}`);
  const [dataWyst, setDataWyst] = useState(edytowana?.dataWystawienia ?? DZIS);
  const [dataSprz, setDataSprz] = useState(edytowana?.dataWystawienia ?? DZIS);
  const [termin, setTermin] = useState(
    edytowana ? najblizszyTermin(dniMiedzy(edytowana.dataWystawienia, edytowana.terminPlatnosci)) : String(startowy?.terminDni ?? 14),
  );
  const [rodzajNabywcy, setRodzajNabywcy] = useState<'firma' | 'osoba' | 'ue'>('firma');
  const [nip, setNip] = useState(edytowana?.nipKontrahenta ?? startowy?.nip ?? '');
  const [nazwa, setNazwa] = useState(edytowana?.kontrahent ?? startowy?.nazwa ?? '');
  const [adres1, setAdres1] = useState(ulicaStart ?? '');
  const [adres2, setAdres2] = useState(miastoStart ?? '');
  const [email, setEmail] = useState(startowy?.email ?? '');
  const [metoda, setMetoda] = useState<MetodaPlatnosci>(edytowana?.metodaPlatnosci ?? 'Przelew');
  const [rachunek, setRachunek] = useState(edytowana?.rachunek ?? SPRZEDAWCA.rachunek);
  const [mpp, setMpp] = useState(edytowana?.mpp ?? false);
  const [pozycje, setPozycje] = useState<PozycjaFormularza[]>(
    wzorFaktury ? wzorFaktury.pozycje.map(zPozycji) : [PUSTA],
  );
  const [uwagi, setUwagi] = useState(edytowana?.uwagi ?? '');
  const [bledy, setBledy] = useState<Record<string, string>>({});
  // Zaliczka.
  const [wartoscUmowy, setWartoscUmowy] = useState('');
  const [kwotaZaliczki, setKwotaZaliczki] = useState(edytowana?.rodzaj === 'zaliczkowa' ? doPola(edytowana.brutto) : '');
  const [stawkaZaliczki, setStawkaZaliczki] = useState('23');
  const [realizacja, setRealizacja] = useState(dodajDni(DZIS, 30));
  const [opisZaliczki, setOpisZaliczki] = useState(edytowana?.rodzaj === 'zaliczkowa' ? (edytowana.pozycje[0]?.nazwa ?? '') : '');
  // Rozliczenie zaliczek.
  const zaliczki = faktury.filter((f) => f.rodzaj === 'zaliczkowa' && f.statusKsef === 'przyjeta');
  const [wybraneZaliczki, setWybraneZaliczki] = useState<Record<string, boolean>>({});
  // Korekta.
  const [zrodloId, setZrodloId] = useState<string | undefined>(z);
  const [typKorekty, setTypKorekty] = useState<'kwotowa' | 'dane' | 'anulowanie'>('kwotowa');
  const [typKsef, setTypKsef] = useState('2');
  const [przyczyna, setPrzyczyna] = useState('');
  const zrodlo = faktury.find((f) => f.id === zrodloId);

  // Zamknięcie ze zmianami pyta „Odrzucić zmiany?” (ZASADY-DESIGNU.md, sekcja 6), także gestem w dół.
  const migawka = JSON.stringify([numer, dataWyst, dataSprz, termin, rodzajNabywcy, nip, nazwa, adres1, adres2, email, metoda, rachunek, mpp, pozycje, uwagi,
    wartoscUmowy, kwotaZaliczki, stawkaZaliczki, realizacja, opisZaliczki, wybraneZaliczki, zrodloId, typKorekty, typKsef, przyczyna]);
  const [migawkaStartowa] = useState(migawka);
  const [bezPytania, setBezPytania] = useState(false);
  const wylaczOchrone = usePreventRemove(!bezPytania && migawka !== migawkaStartowa, ({ repeat }) => {
    const odrzuc = () => {
      setBezPytania(true);
      repeat();
    };
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { title: 'Odrzucić zmiany w fakturze?', options: ['Odrzuć zmiany', 'Wróć do faktury'], destructiveButtonIndex: 0, cancelButtonIndex: 1 },
        (i) => {
          if (i === 0) odrzuc();
        },
      );
    } else {
      Alert.alert('Odrzucić zmiany w fakturze?', undefined, [
        { text: 'Wróć do faktury', style: 'cancel' },
        { text: 'Odrzuć zmiany', style: 'destructive', onPress: odrzuc },
      ]);
    }
  });

  const wypelnijZ = (nazwaK: string) => {
    const k: Kontrahent | undefined = KONTRAHENCI.find((x) => x.nazwa === nazwaK);
    if (!k) {
      // „Nowy nabywca”: czyste pola zamiast danych poprzednio wybranej firmy.
      setNip('');
      setNazwa('');
      setAdres1('');
      setAdres2('');
      setEmail('');
      return;
    }
    setNip(k.nip);
    setNazwa(k.nazwa);
    const [ulica, miasto] = k.adres.split(', ');
    setAdres1(ulica ?? '');
    setAdres2(miasto ?? '');
    setEmail(k.email ?? '');
    setTermin(String(k.terminDni));
  };

  const pozycjeGotowe = pozycje.map(doPozycji);
  const sumaNetto = pozycjeGotowe.reduce((s, p) => s + nettoPozycji(p), 0);
  const sumaVat = pozycjeGotowe.reduce((s, p) => s + vatPozycji(p), 0);
  const zaliczkaBrutto = grosze(kwotaZaliczki) || 0;
  const zaliczkaNetto = Math.round(zaliczkaBrutto / (1 + stawkaProcent(stawkaZaliczki) / 100));
  const wybrane = zaliczki.filter((f) => wybraneZaliczki[f.id]);
  const sumaWybranychZaliczek = wybrane.reduce((s, f) => s + f.brutto, 0);
  // Korekta pokazuje i zapisuje różnicę „jest” minus „było”, nie nową sumę.
  const zmianaKorekty = typKorekty === 'anulowanie' ? -(zrodlo?.brutto ?? 0) : sumaNetto + sumaVat - (zrodlo?.brutto ?? 0);

  const ustawPozycje = (i: number, zmiana: Partial<PozycjaFormularza>) =>
    setPozycje((lista) => lista.map((p, j) => (j === i ? { ...p, ...zmiana } : p)));

  const sprawdz = (): boolean => {
    const b: Record<string, string> = {};
    if (!numer.trim()) b.numer = 'Wpisz numer faktury.';
    if (rodzaj !== 'korygujaca' || zrodlo) {
      if (!nazwa.trim()) b.nazwa = 'Wpisz nazwę nabywcy.';
      if (!adres1.trim() || !adres2.trim()) b.adres = 'Wpisz oba wiersze adresu.';
      if ((rodzajNabywcy === 'firma' || rodzaj !== 'vat') && !/^\d{10}$/.test(nip.replace(/\D/g, ''))) b.nip = 'NIP ma 10 cyfr.';
    }
    if (rodzaj === 'korygujaca' && !zrodlo) b.zrodlo = 'Wybierz fakturę, którą korygujesz.';
    if (rodzaj === 'korygujaca' && !przyczyna.trim()) b.przyczyna = 'Podaj przyczynę korekty (obowiązkowe).';
    if (rodzaj === 'zaliczkowa' && !(zaliczkaBrutto > 0)) b.zaliczka = 'Wpisz kwotę zaliczki brutto.';
    if (rodzaj === 'rozliczajaca' && wybrane.length === 0)
      b.zaliczki = zaliczki.length === 0 ? 'Najpierw wystaw fakturę zaliczkową.' : 'Zaznacz zaliczki, które rozliczasz.';
    if ((rodzaj === 'vat' || rodzaj === 'rozliczajaca' || (rodzaj === 'korygujaca' && typKorekty !== 'anulowanie')) && pozycje.some((p) => !p.nazwa.trim()))
      b.pozycje = 'Każda pozycja potrzebuje nazwy.';
    if (mpp && !rachunek.trim()) b.rachunek = 'MPP wymaga numeru rachunku.';
    setBledy(b);
    const ok = Object.keys(b).length === 0;
    if (!ok) void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    return ok;
  };

  const zapisz = (wyslij: boolean) => {
    if (!sprawdz()) return;
    const pozycjeFaktury: Pozycja[] =
      rodzaj === 'zaliczkowa'
        ? [{ nazwa: opisZaliczki.trim() || 'Zaliczka', ilosc: 1, jednostka: 'usł.', cenaNetto: zaliczkaNetto, stawkaVat: stawkaProcent(stawkaZaliczki) }]
        : rodzaj === 'korygujaca' && typKorekty === 'anulowanie'
          ? (zrodlo?.pozycje ?? []).map((p) => ({ ...p, cenaNetto: -p.cenaNetto }))
          : pozycjeGotowe;
    let netto = pozycjeFaktury.reduce((s, p) => s + nettoPozycji(p), 0);
    let brutto = pozycjeFaktury.reduce((s, p) => s + bruttoPozycji(p), 0);
    if (rodzaj === 'rozliczajaca') {
      // Do zapłaty zostaje tylko to, czego nie pokryły zaliczki.
      netto -= wybrane.reduce((s, f) => s + f.netto, 0);
      brutto -= sumaWybranychZaliczek;
    }
    if (rodzaj === 'korygujaca' && typKorekty !== 'anulowanie' && zrodlo) {
      netto -= zrodlo.netto;
      brutto -= zrodlo.brutto;
    }
    const nowa: Faktura = {
      id: '',
      numer: numer.trim(),
      kontrahent: nazwa.trim(),
      nipKontrahenta: nip.replace(/\D/g, '') || '1234567890',
      dataWystawienia: dataWyst,
      terminPlatnosci: dodajDni(dataWyst, Number(termin)),
      netto,
      brutto,
      statusKsef: 'robocza',
      zaplacona: false,
      pozycje: pozycjeFaktury,
      rodzaj,
      metodaPlatnosci: metoda,
      rachunek: metoda === 'Przelew' ? rachunek : undefined,
      mpp,
      uwagi: [rodzaj === 'korygujaca' ? `Przyczyna korekty: ${przyczyna.trim()}` : '', uwagi.trim()].filter(Boolean).join('\n') || undefined,
    };
    setBezPytania(true);
    wylaczOchrone();
    if (edytowana) zastapFakture(edytowana.id, nowa, wyslij);
    else dodajFakture(nowa, wyslij);
    router.dismissTo('/faktury');
  };

  const przyciskWyslij =
    rodzaj === 'zaliczkowa' ? 'Wystaw i wyślij zaliczkę do KSeF' : rodzaj === 'korygujaca' ? 'Wystaw korektę i wyślij do KSeF' : 'Wystaw i wyślij do KSeF';
  const stawki = rodzaj === 'rozliczajaca' ? STAWKI_ROZLICZENIA : STAWKI_ZWYKLE;

  return (
    <>
      <Stack.Screen options={{ title: edytowana ? (edytowana.statusKsef === 'odrzucona' ? 'Popraw fakturę' : 'Edytuj szkic') : TYTUL[rodzaj] }} />
      {wprost ? (
        // Otwarty ze szczegółu albo karty kontrahenta: pod spodem nie ma wyboru rodzaju, więc „Anuluj” zamyka arkusz.
        <Stack.Toolbar placement="left">
          <Stack.Toolbar.Button onPress={() => router.back()}>Anuluj</Stack.Toolbar.Button>
        </Stack.Toolbar>
      ) : null}
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button onPress={() => zapisz(false)}>Szkic</Stack.Toolbar.Button>
      </Stack.Toolbar>

      <EkranListy keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
        {rodzaj === 'korygujaca' ? (
          <Sekcja naglowek="Faktura pierwotna" stopka={bledy.zrodlo ?? 'Korygować można fakturę przyjętą w KSeF.'}>
            {zrodlo ? (
              <>
                <Wiersz tytul={zrodlo.numer} podtytul={`${zrodlo.kontrahent} · ${dataKrotka(zrodlo.dataWystawienia)}`} wartosc={kwota(zrodlo.brutto)} />
                <Wiersz tytul="Wybierz inną fakturę" akcja onPress={() => setZrodloId(undefined)} />
              </>
            ) : (
              faktury
                .filter((f) => f.statusKsef === 'przyjeta' && f.rodzaj !== 'korygujaca')
                .slice(0, 8)
                .map((f) => (
                  <Wiersz
                    key={f.id}
                    tytul={f.numer}
                    podtytul={`${f.kontrahent} · ${dataKrotka(f.dataWystawienia)}`}
                    wartosc={kwota(f.brutto)}
                    wartoscPodpis="Wybierz"
                    wartoscPodpisKolor="akcent"
                    onPress={() => {
                      setZrodloId(f.id);
                      wypelnijZ(f.kontrahent);
                      // „Jest” startuje jako kopia „było”: zmienia się tylko to, co trzeba.
                      setPozycje(f.pozycje.map(zPozycji));
                    }}
                  />
                ))
            )}
          </Sekcja>
        ) : null}


        <Sekcja
          naglowek={rodzaj === 'korygujaca' ? 'Dane korekty' : 'Numer i daty'}
          stopka={rodzaj === 'korygujaca' ? 'Typ KSeF mówi, od kiedy korekta działa. Najczęściej: 2, od daty korekty.' : undefined}>
          <PoleTekstowe etykieta={rodzaj === 'korygujaca' ? 'Numer korekty' : 'Numer faktury'} wartosc={numer} onZmiana={setNumer} blad={bledy.numer} cyfry />
          <PoleDaty etykieta={rodzaj === 'korygujaca' ? 'Data korekty' : 'Data wystawienia'} wartosc={dataWyst} onZmiana={setDataWyst} />
          {rodzaj === 'vat' ? <PoleDaty etykieta="Data sprzedaży" wartosc={dataSprz} onZmiana={setDataSprz} /> : null}
          <PoleWyboru
            etykieta="Termin płatności"
            wartosc={termin}
            opcje={[
              { wartosc: '7', etykieta: '7 dni' },
              { wartosc: '14', etykieta: '14 dni' },
              { wartosc: '30', etykieta: '30 dni' },
            ]}
            onZmiana={setTermin}
          />
          {rodzaj === 'korygujaca' ? (
            <>
              <PoleWyboru
                etykieta="Typ korekty"
                wartosc={typKorekty}
                opcje={[
                  { wartosc: 'kwotowa', etykieta: 'Kwotowa (zwrot, rabat)' },
                  { wartosc: 'dane', etykieta: 'Danych (było, jest)' },
                  { wartosc: 'anulowanie', etykieta: 'Anulowanie faktury' },
                ]}
                onZmiana={setTypKorekty}
              />
              <PoleWyboru
                etykieta="Typ KSeF"
                wartosc={typKsef}
                opcje={[
                  { wartosc: '1', etykieta: '1: data faktury' },
                  { wartosc: '2', etykieta: '2: data korekty' },
                  { wartosc: '3', etykieta: '3: inna data' },
                ]}
                onZmiana={setTypKsef}
              />
              <PoleTekstowe etykieta="Przyczyna korekty" wartosc={przyczyna} onZmiana={setPrzyczyna} podpowiedz="np. rabat za opóźnienie" blad={bledy.przyczyna} wielowierszowe />
            </>
          ) : null}
        </Sekcja>

        {rodzaj !== 'korygujaca' ? (
          <Sekcja naglowek={rodzaj === 'vat' ? 'Nabywca' : 'Nabywca (B2B)'} stopka="Dane firmy z Polski uzupełnimy z GUS po wpisaniu NIP.">
            <PoleWyboru
              etykieta="Kontrahent"
              wartosc={KONTRAHENCI.some((k) => k.nazwa === nazwa) ? nazwa : ''}
              opcje={[{ wartosc: '', etykieta: 'Nowy nabywca' }, ...KONTRAHENCI.map((k) => ({ wartosc: k.nazwa, etykieta: k.nazwa }))]}
              onZmiana={wypelnijZ}
            />
            {rodzaj === 'vat' ? (
              <PoleWyboru
                etykieta="Rodzaj nabywcy"
                wartosc={rodzajNabywcy}
                opcje={[
                  { wartosc: 'firma', etykieta: 'Firma z Polski (NIP)' },
                  { wartosc: 'osoba', etykieta: 'Osoba prywatna' },
                  { wartosc: 'ue', etykieta: 'Firma z UE (VAT-UE)' },
                ]}
                onZmiana={setRodzajNabywcy}
              />
            ) : null}
            {rodzajNabywcy !== 'osoba' || rodzaj !== 'vat' ? (
              <PoleTekstowe
                etykieta={rodzajNabywcy === 'ue' && rodzaj === 'vat' ? 'Numer VAT-UE' : 'NIP nabywcy'}
                wartosc={nip}
                onZmiana={setNip}
                podpowiedz={rodzajNabywcy === 'ue' && rodzaj === 'vat' ? 'DE123456789' : '10 cyfr'}
                klawiatura={rodzajNabywcy === 'ue' && rodzaj === 'vat' ? 'default' : 'number-pad'}
                blad={bledy.nip}
              />
            ) : null}
            {/^\d{10}$/.test(nip.replace(/\D/g, '')) && !nazwa ? (
              <Wiersz tytul="Uzupełnij danymi z GUS" ikona="bank-line" akcja onPress={() => wypelnijZ(KONTRAHENCI[0]?.nazwa ?? '')} />
            ) : null}
            <PoleTekstowe etykieta="Nazwa" wartosc={nazwa} onZmiana={setNazwa} podpowiedz="Nazwa firmy" blad={bledy.nazwa} />
            <PoleTekstowe etykieta="Adres" wartosc={adres1} onZmiana={setAdres1} podpowiedz="Ulica i numer" />
            <PoleTekstowe etykieta="Miejscowość" wartosc={adres2} onZmiana={setAdres2} podpowiedz="00-001 Warszawa" blad={bledy.adres} />
            <PoleTekstowe etykieta="E-mail" wartosc={email} onZmiana={setEmail} podpowiedz="opcjonalnie" klawiatura="email-address" />
          </Sekcja>
        ) : null}

        <Sekcja naglowek="Płatność" stopka={mpp ? 'Przy MPP nabywca płaci VAT na rachunek VAT.' : 'MPP obowiązuje m.in. dla faktur firmowych powyżej 15 000 zł brutto z załącznika 15.'}>
          <PoleWyboru
            etykieta="Metoda płatności"
            wartosc={metoda}
            opcje={(['Przelew', 'Gotówka', 'Karta', 'Kompensata', 'Inna'] as const)
              .filter((m) => m !== 'Kompensata' || rodzaj === 'zaliczkowa' || rodzaj === 'rozliczajaca')
              .map((m) => ({ wartosc: m, etykieta: m }))}
            onZmiana={setMetoda}
          />
          {metoda === 'Przelew' ? <PoleTekstowe etykieta="Rachunek" wartosc={rachunek} onZmiana={setRachunek} klawiatura="number-pad" blad={bledy.rachunek} /> : null}
          <PolePrzelacznik etykieta="Podzielona płatność (MPP)" wartosc={mpp} onZmiana={setMpp} />
        </Sekcja>

        {rodzaj === 'zaliczkowa' ? (
          <Sekcja naglowek="Zaliczka" stopka={bledy.zaliczka}>
            <PoleTekstowe etykieta="Wartość umowy (brutto)" wartosc={wartoscUmowy} onZmiana={setWartoscUmowy} podpowiedz="zł" klawiatura="decimal-pad" />
            <PoleTekstowe etykieta="Kwota zaliczki (brutto)" wartosc={kwotaZaliczki} onZmiana={setKwotaZaliczki} podpowiedz="zł" klawiatura="decimal-pad" />
            <PoleWyboru etykieta="Stawka VAT zaliczki" wartosc={stawkaZaliczki} opcje={STAWKI_ZALICZKI} onZmiana={setStawkaZaliczki} />
            <PoleDaty etykieta="Planowana realizacja" wartosc={realizacja} onZmiana={setRealizacja} najwczesniej={dataWyst} />
            <PoleTekstowe etykieta="Opis" wartosc={opisZaliczki} onZmiana={setOpisZaliczki} podpowiedz="Za co jest zaliczka" wielowierszowe />
          </Sekcja>
        ) : null}

        {rodzaj === 'rozliczajaca' ? (
          <Sekcja naglowek="Faktury zaliczkowe do rozliczenia" stopka={bledy.zaliczki}>
            {zaliczki.length === 0
              ? [<Wiersz key="brak" tytul="Brak zaliczek do wyboru" podtytul="Najpierw wystaw fakturę zaliczkową." />]
              : zaliczki.map((f) => (
                  <PolePrzelacznik
                    key={f.id}
                    etykieta={f.numer}
                    opis={`${f.kontrahent} · ${kwota(f.brutto)}`}
                    wartosc={Boolean(wybraneZaliczki[f.id])}
                    onZmiana={(v) => setWybraneZaliczki((w) => ({ ...w, [f.id]: v }))}
                  />
                ))}
          </Sekcja>
        ) : null}

        {rodzaj === 'korygujaca' && zrodlo ? (
          <Sekcja naglowek="Było" stopka="Pozycje z faktury pierwotnej.">
            {zrodlo.pozycje.map((p, i) => (
              <Wiersz key={i} tytul={p.nazwa} podtytul={`${p.ilosc} ${p.jednostka} × ${kwota(p.cenaNetto)} netto, VAT ${p.stawkaVat}%`} wartosc={kwota(bruttoPozycji(p))} />
            ))}
          </Sekcja>
        ) : null}

        {rodzaj === 'zaliczkowa' || (rodzaj === 'korygujaca' && (!zrodlo || typKorekty === 'anulowanie')) ? null : (
          <>
            {pozycje.map((p, i) => (
              <Sekcja key={i} naglowek={rodzaj === 'korygujaca' ? `Jest: pozycja ${i + 1}` : `Pozycja ${i + 1}`} stopka={i === pozycje.length - 1 ? bledy.pozycje : undefined}>
                <PoleTekstowe etykieta="Nazwa" wartosc={p.nazwa} onZmiana={(t) => ustawPozycje(i, { nazwa: t })} podpowiedz="np. Projekt graficzny" />
                <PoleTekstowe etykieta="Ilość" wartosc={p.ilosc} onZmiana={(t) => ustawPozycje(i, { ilosc: t })} klawiatura="decimal-pad" />
                <PoleTekstowe etykieta="Jednostka" wartosc={p.jednostka} onZmiana={(t) => ustawPozycje(i, { jednostka: t })} />
                <PoleTekstowe etykieta="Cena netto" wartosc={p.cena} onZmiana={(t) => ustawPozycje(i, { cena: t })} podpowiedz="zł" klawiatura={rodzaj === 'korygujaca' ? 'numbers-and-punctuation' : 'decimal-pad'} />
                <PoleWyboru etykieta="VAT" wartosc={p.stawka} opcje={stawki} onZmiana={(v) => ustawPozycje(i, { stawka: v })} />
                <Wiersz tytul="Brutto" wartosc={kwota(bruttoPozycji(doPozycji(p)))} />
                {pozycje.length > 1 ? <Wiersz tytul="Usuń pozycję" niszczacy onPress={() => setPozycje((l) => l.filter((_, j) => j !== i))} /> : null}
              </Sekcja>
            ))}
            <Sekcja>
              <Wiersz tytul="Dodaj pozycję" ikona="add-circle-fill" akcja onPress={() => setPozycje((l) => [...l, PUSTA])} />
            </Sekcja>
          </>
        )}

        <Sekcja naglowek="Podsumowanie">
          {rodzaj === 'zaliczkowa' ? (
            <>
              <Wiersz tytul="Zaliczka netto" wartosc={kwota(zaliczkaNetto)} />
              <Wiersz tytul={`VAT ${stawkaZaliczki}%`} wartosc={kwota(zaliczkaBrutto - zaliczkaNetto)} />
              <Wiersz tytul="Do zapłaty" wartosc={kwota(zaliczkaBrutto)} wartoscKolor="etykieta" />
            </>
          ) : rodzaj === 'rozliczajaca' ? (
            <>
              <Wiersz tytul="Razem brutto pozycji" wartosc={kwota(sumaNetto + sumaVat)} />
              <Wiersz tytul="Suma wybranych zaliczek" wartosc={kwota(sumaWybranychZaliczek)} />
              <Wiersz tytul="Do zapłaty po odliczeniu zaliczek" wartosc={kwota(sumaNetto + sumaVat - sumaWybranychZaliczek)} wartoscKolor="etykieta" />
            </>
          ) : rodzaj === 'korygujaca' ? (
            <Wiersz tytul="Zmiana brutto" wartosc={kwota(zmianaKorekty)} wartoscKolor="etykieta" />
          ) : (
            <>
              <Wiersz tytul="Razem netto" wartosc={kwota(sumaNetto)} />
              <Wiersz tytul="VAT" wartosc={kwota(sumaVat)} />
              <Wiersz tytul="Razem brutto" wartosc={kwota(sumaNetto + sumaVat)} wartoscKolor="etykieta" />
            </>
          )}
        </Sekcja>

        <Sekcja naglowek="Uwagi">
          <PoleTekstowe etykieta="Uwagi" wartosc={uwagi} onZmiana={setUwagi} podpowiedz="Widoczne na fakturze (do 3500 znaków)" wielowierszowe />
        </Sekcja>

        <View style={styles.przyciski}>
          {Object.keys(bledy).length > 0 ? (
            // Błędy stoją pod polami wyżej; tu ich lista, żeby nie trzeba było ich szukać.
            <View style={styles.bledy} accessibilityLiveRegion="polite">
              <Tekst styl="subheadline" kolor="blad" pogrubiony>
                Do poprawy wyżej:
              </Tekst>
              {Object.values(bledy).map((b) => (
                <Tekst key={b} styl="subheadline" kolor="blad">
                  {b}
                </Tekst>
              ))}
            </View>
          ) : null}
          <PrzyciskGlowny tytul={przyciskWyslij} ikona="send-plane-line" onPress={() => zapisz(true)} />
          <PrzyciskGlowny tytul="Zapisz szkic" wariant="drugorzedny" onPress={() => zapisz(false)} />
        </View>
      </EkranListy>
    </>
  );
}

const styles = StyleSheet.create({
  przyciski: { marginHorizontal: MARGINES, marginTop: ODSTEP.xl, gap: ODSTEP.s },
  bledy: { gap: ODSTEP.linia, paddingHorizontal: ODSTEP.xxs, paddingBottom: ODSTEP.xxs },
});

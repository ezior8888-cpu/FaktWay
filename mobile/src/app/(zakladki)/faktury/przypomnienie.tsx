import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { DZIS } from '@/dane-przykladowe';
import { KONTRAHENCI } from '@/dane-przykladowe/kontrahenci';
import { PolePrzelacznik, PoleTekstowe } from '@/komponenty/formularz';
import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { NaglowekKwoty } from '@/komponenty/naglowek';
import { PrzyciskGlowny } from '@/komponenty/przycisk-glowny';
import { StanPusty } from '@/komponenty/stan-pusty';
import { SzkieletKwoty, SzkieletListy } from '@/komponenty/szkielet';
import { Tekst } from '@/komponenty/tekst';
import type { PodgladPrzypomnieniaOdpowiedz, WstrzymanieOdpowiedz, ZatwierdzeniePrzypomnieniaOdpowiedz } from '@/lib/api/kontrakt';
import { dzienWarszawa, grosze } from '@/lib/dane/mapowanie';
import { dataPelna, dniMiedzy, kwota } from '@/lib/format';
import { udostepnijPdf } from '@/lib/pdf-faktury';
import { dni } from '@/lib/status-faktury';
import { useKontoFirmy, type KontoFirmy } from '@/stan/dane';
import { useFlaga, useStanFaktur } from '@/stan/faktury';
import { powodBezPodgladu } from '@/lib/naleznosci';
import { podpisPrzypomnien, useNaleznosci } from '@/stan/naleznosci';
import { MARGINES, ODSTEP } from '@/wyglad/odstepy';

export default function EkranPrzypomnienia() {
  const konto = useKontoFirmy();
  if (konto) return <EkranPrzypomnieniaZBazy konto={konto} />;
  return <EkranPrzypomnieniaPrzyklad />;
}

/**
 * Przypomnienie o zapłacie na prawdziwym koncie (M10a), jak okno
 * „Przygotuj przypomnienie” na stronie: podgląd z serwera (nic nie wychodzi),
 * treść do poprawienia, załącznik do obejrzenia, zgoda i „Zatwierdź i zleć
 * wysyłkę” (właściciel albo administrator). Do tego wstrzymanie przypomnień
 * i „Zapłacone”. Zmiana adresu albo odmowa serwera wymaga nowego podglądu.
 */
function EkranPrzypomnieniaZBazy({ konto }: { konto: KontoFirmy }) {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const naleznosci = useNaleznosci();
  const { faktury, przelaczZaplate } = useStanFaktur();
  const n = naleznosci?.dane?.faktury.find((x) => x.id === id);
  const f = faktury.find((x) => x.id === id);
  const [email, setEmail] = useState<string>();
  const [podglad, setPodglad] = useState<PodgladPrzypomnieniaOdpowiedz>();
  const [tresc, setTresc] = useState('');
  const [zgoda, setZgoda] = useState(false);
  const [wygaslo, setWygaslo] = useState(false);
  const [trwa, setTrwa] = useState<'podglad' | 'zgoda' | 'wstrzymanie'>();
  const [blad, setBlad] = useState<string>();
  const [zlecone, setZlecone] = useState(false);
  // Firma, w której otwarto ekran: każdy zapis idzie do niej albo nie idzie wcale (zmiana firmy w Więcej).
  const [firmaEkranu] = useState(konto.firma?.id ?? null);
  // Drugie dotknięcie w tej samej klatce (zanim `trwa` się narysuje) nie wysyła drugiego żądania.
  const wToku = useRef(false);

  // Podgląd wygasa (30 minut, jak na stronie): po terminie zgoda jest nieważna.
  useEffect(() => {
    if (!podglad) return;
    const zostalo = Date.parse(podglad.wazneDo) - Date.now();
    const zegar = setTimeout(() => setWygaslo(true), Number.isFinite(zostalo) ? Math.max(0, zostalo) : 0);
    return () => clearTimeout(zegar);
  }, [podglad]);

  const zamknij = (
    <Stack.Toolbar placement="left">
      <Stack.Toolbar.Button onPress={() => router.back()}>Zamknij</Stack.Toolbar.Button>
    </Stack.Toolbar>
  );

  if (!n) {
    const laduje = !naleznosci || naleznosci.stan === 'ladowanie';
    return (
      <>
        {zamknij}
        <EkranListy>
          {laduje ? (
            <>
              <SzkieletKwoty />
              <SzkieletListy wiersze={3} etykieta="Wczytujemy przypomnienie" />
            </>
          ) : (
            <StanPusty
              ikona="checkbox-circle-line"
              tytul="Tej faktury nie ma na liście po terminie"
              opis={naleznosci?.blad ?? 'Mogła zostać zapłacona, skorygowana albo nie jest jeszcze po terminie.'}
              akcja={{ tytul: 'Odśwież', onPress: () => void naleznosci?.odswiez() }}
            />
          )}
        </EkranListy>
      </>
    );
  }

  const adres = email ?? n.email ?? '';
  const odp = naleznosci?.dane;
  const mozeZatwierdzac = odp?.mozeZatwierdzac ?? false;
  const bezPodgladu = powodBezPodgladu(n);
  const podpis = podpisPrzypomnien(n);

  const nowyAdres = (tekst: string) => {
    setEmail(tekst);
    setPodglad(undefined);
    setZgoda(false);
    setBlad(undefined);
  };

  const przygotuj = async () => {
    if (wToku.current) return;
    wToku.current = true;
    setTrwa('podglad');
    setBlad(undefined);
    setPodglad(undefined);
    setZgoda(false);
    setWygaslo(false);
    const wpisany = adres.trim();
    const w = await konto.zapytaj<PodgladPrzypomnieniaOdpowiedz>(`faktury/${n.id}/przypomnienie`, {
      metoda: 'POST',
      cialo: wpisany && wpisany !== n.email ? { email: wpisany } : {},
      firmaEkranu,
    });
    wToku.current = false;
    setTrwa(undefined);
    if (!w.ok) {
      setBlad(w.blad.komunikat);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      return;
    }
    setPodglad(w.dane);
    setTresc(w.dane.tresc);
    setEmail(w.dane.do);
  };

  const zatwierdz = async () => {
    if (wToku.current || !podglad) return;
    if (wygaslo || Date.parse(podglad.wazneDo) <= Date.now()) return setWygaslo(true);
    if (!zgoda) return setBlad('Zaznacz, że sprawdzasz odbiorcę, temat, treść i załączniki.');
    if (!tresc.trim()) return setBlad('Treść wiadomości nie może być pusta.');
    wToku.current = true;
    setTrwa('zgoda');
    setBlad(undefined);
    const w = await konto.zapytaj<ZatwierdzeniePrzypomnieniaOdpowiedz>(`przypomnienia/${podglad.propozycja}/zatwierdz`, {
      metoda: 'POST',
      cialo: { wersja: podglad.wersja, tresc },
      firmaEkranu,
    });
    wToku.current = false;
    setTrwa(undefined);
    if (!w.ok) {
      // Jak na stronie: odrzucona albo zmieniona operacja wymaga nowego, obejrzanego podglądu.
      setBlad(w.blad.komunikat);
      setPodglad(undefined);
      setZgoda(false);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      return;
    }
    setZlecone(true);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    void naleznosci?.odswiez();
  };

  const wstrzymaj = async (wstrzymane: boolean) => {
    if (wToku.current) return;
    wToku.current = true;
    setTrwa('wstrzymanie');
    setBlad(undefined);
    naleznosci?.zmien(n.id, { wstrzymane });
    const w = await konto.zapytaj<WstrzymanieOdpowiedz>(`faktury/${n.id}/wstrzymanie`, { metoda: 'POST', cialo: { wstrzymane }, firmaEkranu });
    wToku.current = false;
    setTrwa(undefined);
    if (!w.ok) {
      naleznosci?.zmien(n.id, { wstrzymane: !wstrzymane });
      setBlad(w.blad.komunikat);
      return;
    }
    if (wstrzymane) setPodglad(undefined);
    void naleznosci?.odswiez();
  };

  const zaplacona = f?.zaplacona ?? false;

  return (
    <>
      {zamknij}
      <EkranListy keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
        <NaglowekKwoty
          podpis={`${n.kontrahent} · ${n.numer}`}
          wartosc={kwota(grosze(n.doZaplaty))}
          status={`${dni(n.dniPoTerminie)} po terminie`}
          statusKolor={n.dniPoTerminie > 7 ? 'blad' : 'ostrzezenie'}
        />
        {f && odp?.mozeOznaczac ? (
          <View style={styles.akcja}>
            <PrzyciskGlowny
              tytul={zaplacona ? 'Cofnij zapłatę' : 'Zapłacone'}
              ikona={zaplacona ? 'arrow-go-back-line' : 'check-line'}
              wariant={zaplacona ? 'drugorzedny' : 'glowny'}
              onPress={() => przelaczZaplate(f)}
            />
          </View>
        ) : null}

        <Sekcja
          naglowek="Przypomnienia"
          stopka={n.ostatnie && n.ostatnie !== 'nieznany' ? `Ostatnio: ${dataPelna(dzienWarszawa(new Date(n.ostatnie.kiedy)))}, etap ${n.ostatnie.etap}.` : undefined}>
          <Wiersz tytul="Status" wartosc={podpis.tekst} />
          <Wiersz tytul="Wysłane" wartosc={String(n.wyslane)} />
          <PolePrzelacznik etykieta="Wstrzymaj przypomnienia" wartosc={n.wstrzymane} onZmiana={(v) => void wstrzymaj(v)} />
        </Sekcja>

        {zaplacona ? null : zlecone ? (
          <Sekcja naglowek="Przypomnienie zlecone" stopka="Wyślemy je w najbliższym oknie wysyłki z ustawień przypomnień.">
            <Wiersz tytul={`Do: ${adres}`} ikona="checkbox-circle-fill" ikonaKolor="sukces" />
          </Sekcja>
        ) : bezPodgladu ? (
          <Sekcja naglowek="Przygotuj przypomnienie" stopka={blad}>
            <Wiersz tytul={bezPodgladu} podtytul={n.wstrzymane ? 'Wznów przypomnienia, żeby przygotować wiadomość.' : 'Status wysyłki sprawdzisz na faktway.pl.'} />
          </Sekcja>
        ) : (
          <>
            <Sekcja
              naglowek="Przygotuj przypomnienie"
              stopka={podglad ? undefined : (blad ?? 'Puste pole użyje adresu z faktury. Najpierw zobaczysz podgląd; nic nie wyjdzie bez Twojej zgody.')}>
              <PoleTekstowe etykieta="Adres e-mail odbiorcy" wartosc={adres} onZmiana={nowyAdres} podpowiedz="adres z faktury" klawiatura="email-address" />
            </Sekcja>
            {podglad ? null : (
              <View style={styles.akcja}>
                <PrzyciskGlowny tytul="Przygotuj podgląd" ikona="eye-line" wariant="drugorzedny" trwa={trwa === 'podglad'} onPress={() => void przygotuj()} />
              </View>
            )}
            {podglad ? (
              <>
                <Sekcja naglowek="Podgląd">
                  <Wiersz tytul="Od" podtytul={podglad.od} />
                  <Wiersz tytul="Do" podtytul={podglad.do} />
                  {podglad.odpowiedzNa ? <Wiersz tytul="Odpowiedź na" podtytul={podglad.odpowiedzNa} /> : null}
                  <Wiersz tytul="Temat" podtytul={podglad.temat} />
                  <PoleTekstowe
                    etykieta="Treść wiadomości"
                    wartosc={tresc}
                    onZmiana={(t) => {
                      setTresc(t);
                      setZgoda(false);
                    }}
                    wielowierszowe
                  />
                  {podglad.zalacznik ? (
                    <Wiersz
                      tytul="Załącznik PDF"
                      podtytul={podglad.zalacznik.nazwa}
                      strzalka
                      onPress={() => void udostepnijPdf(podglad.zalacznik!.nazwa, podglad.zalacznik!.pdfBase64).catch(() => setBlad('Nie udało się otworzyć załącznika. Spróbuj ponownie.'))}
                    />
                  ) : (
                    <Wiersz tytul="Bez załączników" />
                  )}
                </Sekcja>
                <Sekcja
                  naglowek="Zgoda"
                  stopka={
                    wygaslo
                      ? 'Podgląd wygasł. Przygotuj go ponownie i sprawdź aktualne dane.'
                      : (blad ?? (mozeZatwierdzac ? 'Przed zatwierdzeniem sprawdź aktualne saldo faktury: wpłata mogła już wpłynąć.' : 'Wysyłkę zatwierdza właściciel albo administrator firmy.'))
                  }>
                  <PolePrzelacznik etykieta="Sprawdziłem odbiorcę, temat, treść i załączniki. Zatwierdzam tę wiadomość do wysyłki." wartosc={zgoda} onZmiana={setZgoda} />
                </Sekcja>
                <View style={styles.akcja}>
                  {wygaslo ? (
                    <PrzyciskGlowny tytul="Przygotuj nowy podgląd" ikona="refresh-line" wariant="drugorzedny" trwa={trwa === 'podglad'} onPress={() => void przygotuj()} />
                  ) : mozeZatwierdzac ? (
                    <PrzyciskGlowny tytul="Zatwierdź i zleć wysyłkę" ikona="send-plane-line" trwa={trwa === 'zgoda'} onPress={() => void zatwierdz()} />
                  ) : null}
                </View>
              </>
            ) : null}
          </>
        )}
        {trwa === 'wstrzymanie' ? (
          <Tekst styl="footnote" kolor="etykietaDrugorzedna" style={styles.nota}>
            Zapisujemy zmianę…
          </Tekst>
        ) : null}
      </EkranListy>
    </>
  );
}

/**
 * Przypomnienie o zapłacie (strona „Po terminie”): podgląd wiadomości,
 * zgoda i zlecenie wysyłki; wstrzymanie przypomnień; oznaczenie zapłaty.
 * Nic nie wychodzi samo, jak na stronie.
 */
function EkranPrzypomnieniaPrzyklad() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { faktury, przelaczZaplate } = useStanFaktur();
  const f = faktury.find((x) => x.id === id);
  const k = KONTRAHENCI.find((x) => x.nazwa === f?.kontrahent);
  const [wstrzymane, setWstrzymane] = useFlaga(`przypomnienia-wstrzymane-${id}`, false);
  const [email, setEmail] = useState(k?.email ?? '');
  const [tresc, setTresc] = useState(
    f ? `Dzień dobry,\n\nprzypominamy o płatności za fakturę ${f.numer} na kwotę ${kwota(f.brutto)}, z terminem ${dataPelna(f.terminPlatnosci)}. Jeśli przelew już wyszedł, prosimy zignorować tę wiadomość.\n\nPozdrawiamy` : '',
  );
  const [pdf, setPdf] = useState(true);
  const [zgoda, setZgoda] = useState(false);
  const [zlecone, setZlecone] = useState(false);
  const [blad, setBlad] = useState<string>();

  if (!f) return <StanPusty ikona="file-unknow-line" tytul="Nie ma takiej faktury" opis="Mogła zostać zapłacona albo usunięta." />;
  const poTerminie = dniMiedzy(f.terminPlatnosci, DZIS);

  const zlec = () => {
    if (!/^\S+@\S+\.\S+$/.test(email)) return setBlad('Wpisz poprawny adres e-mail odbiorcy.');
    if (!zgoda) return setBlad('Zaznacz zgodę na wysyłkę.');
    setBlad(undefined);
    setZlecone(true);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  return (
    <>
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button onPress={() => router.back()}>Zamknij</Stack.Toolbar.Button>
      </Stack.Toolbar>
      <EkranListy keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
        <NaglowekKwoty
          podpis={`${f.kontrahent} · ${f.numer}`}
          wartosc={kwota(f.brutto)}
          status={poTerminie > 0 ? `${dni(poTerminie)} po terminie` : 'W terminie'}
          statusKolor={poTerminie > 7 ? 'blad' : 'ostrzezenie'}
        />
        <View style={styles.akcja}>
          <PrzyciskGlowny
            tytul={f.zaplacona ? 'Cofnij zapłatę' : 'Zapłacone'}
            ikona="check-line"
            wariant={f.zaplacona ? 'drugorzedny' : 'glowny'}
            onPress={() => przelaczZaplate(f)}
          />
        </View>

        <Sekcja naglowek="Przypomnienia" stopka={f.przypomnienie?.data ? `Ostatnio: ${dataPelna(f.przypomnienie.data)}, etap ${f.przypomnienie.etap}.` : undefined}>
          <Wiersz tytul="Status" wartosc={wstrzymane ? 'Wstrzymane' : f.przypomnienie?.status ?? 'Bez przypomnień'} />
          <Wiersz tytul="Wysłane" wartosc={`${f.przypomnienie?.wyslane ?? 0} z 3`} />
          <PolePrzelacznik etykieta="Wstrzymaj przypomnienia" wartosc={wstrzymane} onZmiana={setWstrzymane} />
        </Sekcja>

        {wstrzymane || f.zaplacona ? null : zlecone ? (
          <Sekcja naglowek="Przypomnienie zlecone" stopka="Wyślemy je w najbliższym oknie wysyłki z ustawień przypomnień.">
            <Wiersz tytul={`Do: ${email}`} ikona="checkbox-circle-fill" ikonaKolor="sukces" />
          </Sekcja>
        ) : (
          <>
            <Sekcja naglowek="Przygotuj przypomnienie" stopka={blad}>
              <PoleTekstowe etykieta="Do" wartosc={email} onZmiana={setEmail} podpowiedz="adres e-mail" klawiatura="email-address" />
              <Wiersz tytul="Temat" podtytul={`Przypomnienie o płatności: ${f.numer}`} />
              <PoleTekstowe etykieta="Treść wiadomości" wartosc={tresc} onZmiana={setTresc} wielowierszowe />
              <PolePrzelacznik etykieta="Załącznik PDF" wartosc={pdf} onZmiana={setPdf} />
              <PolePrzelacznik etykieta="Zgadzam się na wysyłkę tej wiadomości" wartosc={zgoda} onZmiana={setZgoda} />
            </Sekcja>
            <View style={styles.akcja}>
              <PrzyciskGlowny tytul="Zatwierdź i zleć wysyłkę" ikona="send-plane-line" onPress={zlec} />
            </View>
          </>
        )}
      </EkranListy>
    </>
  );
}

const styles = StyleSheet.create({
  akcja: { marginHorizontal: MARGINES, marginTop: ODSTEP.l },
  nota: { marginHorizontal: MARGINES, marginTop: ODSTEP.s },
});

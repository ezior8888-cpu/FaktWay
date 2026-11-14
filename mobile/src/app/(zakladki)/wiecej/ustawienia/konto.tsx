import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { Share, StyleSheet, View } from 'react-native';
import * as Haptics from 'expo-haptics';

import { PoleKodu, PolePrzelacznik, PoleTekstowe } from '@/komponenty/formularz';
import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { otworzStrone } from '@/komponenty/na-stronie';
import { potwierdz } from '@/komponenty/potwierdz';
import { PrzyciskGlowny } from '@/komponenty/przycisk-glowny';
import { SzkieletListy } from '@/komponenty/szkielet';
import { StanPusty } from '@/komponenty/stan-pusty';
import type { AnulowanieUsunieciaOdpowiedz, UsuniecieKontaOdpowiedz, UsuniecieZaplanowaneOdpowiedz } from '@/lib/api/kontrakt';
import { dzienWarszawa } from '@/lib/dane/mapowanie';
import { dataPelna } from '@/lib/format';
import { useKontoFirmy, type KontoFirmy } from '@/stan/dane';
import { useFlaga } from '@/stan/faktury';
import { useSesja } from '@/stan/sesja';
import { MARGINES, ODSTEP } from '@/wyglad/odstepy';

export default function EkranKontaIDanych() {
  const konto = useKontoFirmy();
  if (konto) return <EkranKontaZBazy konto={konto} />;
  return <EkranKonta />;
}

/**
 * Konto i dane na prawdziwym koncie (M10b): usunięcie konta z 14 dniami na
 * rezygnację (wymóg Apple) przez `POST /api/mobile/v1/konto/usuniecie`, ta sama
 * ścieżka RODO co na stronie (mail z linkiem anulowania, audyt). Sposób
 * potwierdzenia mówi serwer: hasło albo świeże logowanie przez Google; kod 2FA
 * sprawdza bramka (sesja po kodzie). Pobranie danych i analityka na faktway.pl.
 */
function EkranKontaZBazy({ konto }: { konto: KontoFirmy }) {
  const { zalogujGoogle, biometria, potwierdzBiometria } = useSesja();
  const [stan, setStan] = useState<UsuniecieKontaOdpowiedz>();
  const [bladOdczytu, setBladOdczytu] = useState<string>();
  const [haslo, setHaslo] = useState('');
  const [blad, setBlad] = useState<string>();
  const [trwa, setTrwa] = useState(false);
  const wToku = useRef(false);

  const zapytaj = konto.zapytaj;
  const wczytajTeraz = useEffectEvent(() => zapytaj<UsuniecieKontaOdpowiedz>('konto/usuniecie', { bezFirmy: true }));
  const [odswiezenie, setOdswiezenie] = useState(0);
  useEffect(() => {
    let biezace = true;
    void wczytajTeraz().then((w) => {
      if (!biezace) return;
      if (w.ok) {
        setStan(w.dane);
        setBladOdczytu(undefined);
      } else setBladOdczytu(w.blad.komunikat);
    });
    return () => {
      biezace = false;
    };
  }, [odswiezenie]);

  // Świeże logowanie wygasa: po terminie stan od nowa (przycisk ponownego logowania wraca).
  const swiezeDo = stan?.swiezeDo ?? null;
  useEffect(() => {
    if (!swiezeDo) return;
    const zegar = setTimeout(() => setOdswiezenie((n) => n + 1), Math.max(0, Date.parse(swiezeDo) - Date.now()) + 1000);
    return () => clearTimeout(zegar);
  }, [swiezeDo]);

  if (!stan) {
    return (
      <EkranListy>
        {bladOdczytu ? (
          <StanPusty ikona="error-warning-line" tytul="Nie udało się wczytać stanu konta" opis={bladOdczytu} akcja={{ tytul: 'Spróbuj ponownie', onPress: () => setOdswiezenie((n) => n + 1) }} />
        ) : (
          <SzkieletListy wiersze={3} etykieta="Wczytujemy konto" />
        )}
      </EkranListy>
    );
  }

  const zHaslem = stan.potwierdzenie === 'haslo';
  const swiezeTeraz = !zHaslem && stan.swiezeDo !== null;

  /** Wysłanie z potwierdzeniem; `reauth_required` odświeża stan (przycisk ponownego logowania). */
  const wyslij = async (sciezka: 'konto/usuniecie' | 'konto/usuniecie/anuluj') => {
    if (wToku.current) return;
    if (zHaslem && !haslo) return setBlad('Wpisz aktualne hasło, żeby potwierdzić.');
    wToku.current = true;
    setTrwa(true);
    setBlad(undefined);
    const w = await zapytaj<UsuniecieZaplanowaneOdpowiedz | AnulowanieUsunieciaOdpowiedz>(sciezka, { metoda: 'POST', cialo: zHaslem ? { haslo } : {}, bezFirmy: true });
    wToku.current = false;
    setTrwa(false);
    if (!w.ok) {
      setBlad(w.blad.komunikat);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      if (w.blad.kod === 'reauth_required') setOdswiezenie((n) => n + 1);
      return;
    }
    setHaslo('');
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setOdswiezenie((n) => n + 1);
  };

  const usun = async () => {
    if (zHaslem && !haslo) return setBlad('Wpisz aktualne hasło, żeby potwierdzić.');
    // Konto bez hasła: twarz potwierdza, że telefon trzyma właściciel (jak w M5b); świeże logowanie sprawdza serwer.
    if (!zHaslem && biometria && !(await potwierdzBiometria())) return setBlad(`Nie potwierdziliśmy ${biometria.nazwa}. Spróbuj jeszcze raz.`);
    potwierdz(
      { tytul: 'Usunąć konto?', opis: 'Konto zostanie usunięte za 14 dni. Do tego czasu możesz się wycofać tutaj albo linkiem z maila.', potwierdz: 'Potwierdź żądanie', anuluj: 'Wróć' },
      () => void wyslij('konto/usuniecie'),
    );
  };

  const zalogujPonownie = async () => {
    setBlad(undefined);
    const w = await zalogujGoogle();
    // Konto z 2FA po logowaniu wraca przez ekran kodu; potem ten ekran pokaże świeże logowanie.
    if (!w.ok) return setBlad(w.blad === 'anulowane' ? undefined : 'Nie udało się zalogować przez Google. Spróbuj ponownie.');
    setOdswiezenie((n) => n + 1);
  };

  const potwierdzenie = zHaslem ? (
    <PoleTekstowe etykieta="Aktualne hasło" wartosc={haslo} onZmiana={setHaslo} tajne autouzupelnianie="haslo" />
  ) : swiezeTeraz ? (
    <Wiersz tytul="Logowanie przez Google potwierdzone" podtytul={`Potwierdź do ${new Date(stan.swiezeDo!).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })}.`} ikona="checkbox-circle-fill" ikonaKolor="sukces" />
  ) : (
    <Wiersz tytul="Zaloguj się ponownie przez Google" podtytul="Ze względów bezpieczeństwa potwierdzasz usunięcie świeżym logowaniem." akcja onPress={() => void zalogujPonownie()} />
  );

  return (
    <EkranListy keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
      <Sekcja naglowek="Pobierz moje dane i analityka" stopka="Plik z Twoimi danymi i zgodę na analitykę ustawisz na faktway.pl.">
        <Wiersz tytul="Otwórz Konto na faktway.pl" strzalka onPress={() => otworzStrone('/settings/account')} />
      </Sekcja>

      {stan.zaplanowane ? (
        <>
          <Sekcja naglowek="Usunięcie konta zaplanowane" stopka={blad ?? 'Do tego dnia możesz się wycofać. Potem usunięcia nie da się cofnąć.'}>
            <Wiersz tytul="Planowana data usunięcia" wartosc={dataPelna(dzienWarszawa(stan.zaplanowane))} />
            {potwierdzenie}
          </Sekcja>
          <View style={styles.akcja}>
            <PrzyciskGlowny tytul="Anuluj usunięcie konta" ikona="arrow-go-back-line" wariant="drugorzedny" trwa={trwa} onPress={() => void wyslij('konto/usuniecie/anuluj')} />
          </View>
        </>
      ) : (
        <Sekcja naglowek="Trwałe usunięcie konta" stopka={blad ?? 'Masz 14 dni na rezygnację. Faktury przechowujemy tyle, ile wymaga prawo podatkowe.'}>
          {potwierdzenie}
          {zHaslem || swiezeTeraz ? <Wiersz tytul={trwa ? 'Wysyłamy żądanie…' : 'Usuń moje konto'} niszczacy onPress={trwa ? undefined : () => void usun()} /> : null}
        </Sekcja>
      )}
    </EkranListy>
  );
}

/**
 * Konto i dane (RODO): pobranie danych, usunięcie konta z 14 dniami na
 * rezygnację (wymóg Apple: usuwanie konta w aplikacji), analityka.
 * Usunięcie potwierdza się hasłem; konto z Google hasła w FaktWay nie ma,
 * więc potwierdza je kod z aplikacji TOTP (WZORCE-MOBBIN.md 7, ekran 6),
 * a bez 2FA systemowe Face ID (M5b).
 */
function EkranKonta() {
  const { konto, biometria, potwierdzBiometria } = useSesja();
  const google = konto?.metoda === 'google';
  const [dwaEtapy] = useFlaga('2fa', true);
  const [haslo, setHaslo] = useState('');
  const [kod, setKod] = useState('');
  const [zaplanowane, setZaplanowane] = useFlaga('usuniecie-konta', false);
  const [analityka, setAnalityka] = useFlaga('analityka', true);
  const [blad, setBlad] = useState<string>();

  return (
    <EkranListy keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
      <Sekcja naglowek="Pobierz moje dane" stopka="Plik JSON ze wszystkimi Twoimi danymi.">
        <Wiersz tytul="Pobierz dane (JSON)" ikona="file-download-line" akcja onPress={() => void Share.share({ message: 'Eksport danych konta FaktWay (przykładowy).' })} />
      </Sekcja>

      <Sekcja naglowek="Analityka" stopka="Bez analityki zbieramy tylko dane niezbędne do działania.">
        <PolePrzelacznik etykieta="Analityka użycia" wartosc={analityka} onZmiana={setAnalityka} />
      </Sekcja>

      {zaplanowane ? (
        <Sekcja naglowek="Usunięcie konta zaplanowane" stopka="Do tego dnia możesz się wycofać. Potem usuwanie nie da się cofnąć.">
          <Wiersz tytul="Planowana data usunięcia" wartosc={dataPelna('2026-11-23')} />
          <Wiersz tytul="Anuluj usunięcie konta" akcja onPress={() => setZaplanowane(false)} />
        </Sekcja>
      ) : (
        <Sekcja naglowek="Trwałe usunięcie konta" stopka={blad ?? 'Masz 14 dni na rezygnację. Faktury przechowujemy tyle, ile wymaga prawo podatkowe.'}>
          {!google ? <PoleTekstowe etykieta="Aktualne hasło" wartosc={haslo} onZmiana={setHaslo} tajne /> : null}
          {google && dwaEtapy ? (
            <PoleKodu etykieta="Kod z aplikacji (TOTP)" wartosc={kod} onZmiana={setKod} opis="Logujesz się przez Google, więc potwierdzasz kodem z aplikacji." />
          ) : null}
          <Wiersz
            tytul="Usuń moje konto"
            niszczacy
            onPress={async () => {
              if (!google && !haslo) return setBlad('Wpisz aktualne hasło, żeby potwierdzić.');
              if (google && dwaEtapy && kod.length !== 6) return setBlad('Wpisz 6-cyfrowy kod z aplikacji TOTP, żeby potwierdzić.');
              // Konto z Google bez 2FA nie ma hasła ani kodu: potwierdza twarz (M5b), bez biometrii zostaje arkusz.
              if (google && !dwaEtapy && biometria && !(await potwierdzBiometria())) return setBlad(`Nie potwierdziliśmy ${biometria.nazwa}. Spróbuj jeszcze raz.`);
              potwierdz({ tytul: 'Usunąć konto?', opis: 'Konto zostanie usunięte za 14 dni. Do tego czasu możesz się wycofać.', potwierdz: 'Potwierdź żądanie', anuluj: 'Wróć' }, () => {
                setZaplanowane(true);
                setHaslo('');
                setKod('');
                setBlad(undefined);
              });
            }}
          />
        </Sekcja>
      )}
    </EkranListy>
  );
}

const styles = StyleSheet.create({
  akcja: { marginHorizontal: MARGINES, marginTop: ODSTEP.l },
});

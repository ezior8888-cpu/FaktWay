import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { KSEF } from '@/dane-przykladowe/ustawienia';
import { PoleTekstowe } from '@/komponenty/formularz';
import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { MA_ADRES_STRONY, otworzStrone } from '@/komponenty/na-stronie';
import { NaglowekKwoty } from '@/komponenty/naglowek';
import { PrzyciskGlowny } from '@/komponenty/przycisk-glowny';
import { StanPusty } from '@/komponenty/stan-pusty';
import { SzkieletListy } from '@/komponenty/szkielet';
import { Tekst } from '@/komponenty/tekst';
import { dataPelna } from '@/lib/format';
import { useKontoFirmy } from '@/stan/dane';
import { NAZWA_STANU_KSEF, useUstawienia, type StanUstawien } from '@/stan/ustawienia';
import { useKolory } from '@/wyglad/kolory';
import { MARGINES, ODSTEP } from '@/wyglad/odstepy';

const KROKI = ['Sprawdzenie warunków', 'Pobierz certyfikat z KSeF', 'Wgraj pliki', 'Sprawdzamy w KSeF', 'Połączono'];

export default function EkranKsefIPolaczenia() {
  const ustawienia = useUstawienia();
  if (ustawienia) return <EkranKsefZBazy ustawienia={ustawienia} />;
  return <EkranKsef />;
}

/**
 * KSeF na prawdziwym koncie (M10b): stan połączenia jak plakietka strony
 * (liczy serwer: „połączono” tylko z dowodem w środowisku aplikacji). Pliki
 * certyfikatu (.crt, .key i hasło) wgrywa się na faktway.pl (decyzja M10b:
 * kreator strony sprawdza 2FA, rolę i pliki w KSeF; wgrywanie plików z telefonu poza M10).
 */
function EkranKsefZBazy({ ustawienia }: { ustawienia: StanUstawien }) {
  const rola = useKontoFirmy()?.firma?.rola;
  const { dane } = ustawienia;
  if (!dane) {
    return (
      <EkranListy>
        {ustawienia.stan === 'blad' ? (
          <StanPusty ikona="error-warning-line" tytul="Nie udało się wczytać połączenia z KSeF" opis={ustawienia.blad ?? 'Spróbuj ponownie za chwilę.'} akcja={{ tytul: 'Spróbuj ponownie', onPress: () => void ustawienia.odswiez() }} />
        ) : (
          <SzkieletListy wiersze={3} etykieta="Wczytujemy połączenie z KSeF" />
        )}
      </EkranListy>
    );
  }
  const { ksef, firma } = dane;
  const polaczono = ksef.stan === 'polaczono';
  const opis = polaczono
    ? ksef.certyfikatDo
      ? `Certyfikat ważny do ${dataPelna(ksef.certyfikatDo)}`
      : 'Certyfikat wgrany'
    : ksef.stan === 'do_potwierdzenia'
      ? 'Certyfikat wgrany, ale trzeba go potwierdzić ponownie'
      : 'Podłącz KSeF, aby móc wysyłać faktury';
  const wlasciciel = rola === 'owner';
  const akcja = polaczono ? 'Odnów certyfikat na faktway.pl' : ksef.stan === 'do_potwierdzenia' ? 'Wgraj certyfikat ponownie na faktway.pl' : 'Podłącz KSeF na faktway.pl';
  return (
    <EkranListy onOdswiez={ustawienia.odswiez}>
      <NaglowekKwoty podpis="Połączenie z KSeF" wartosc={NAZWA_STANU_KSEF[ksef.stan]} styl="title1" status={opis} statusKolor={polaczono ? 'sukces' : 'ostrzezenie'} />
      <Sekcja naglowek="Połączenie">
        <Wiersz tytul="NIP" wartosc={firma.nip || 'Brak'} />
        {polaczono && ksef.certyfikatDo ? <Wiersz tytul="Certyfikat ważny do" wartosc={dataPelna(ksef.certyfikatDo)} /> : null}
      </Sekcja>
      <Sekcja
        stopka={
          wlasciciel
            ? 'Pliki certyfikatu (.crt i .key) i hasło do klucza wgrasz na faktway.pl. Do tego potrzebna jest weryfikacja dwuetapowa.'
            : 'Certyfikat KSeF podłącza właściciel firmy na faktway.pl.'
        }>
        {wlasciciel && MA_ADRES_STRONY ? <Wiersz tytul={akcja} ikona="global-line" akcja onPress={() => otworzStrone('/settings/ksef')} /> : null}
      </Sekcja>
      {polaczono && MA_ADRES_STRONY ? (
        <Sekcja naglowek="Historia faktur z KSeF" stopka="Po podłączeniu FaktWay sam pobiera historię faktur z KSeF.">
          <Wiersz tytul="Zobacz postęp pobierania" ikona="global-line" akcja onPress={() => otworzStrone('/import-danych')} />
        </Sekcja>
      ) : null}
    </EkranListy>
  );
}

/**
 * KSeF: status połączenia i kreator podłączenia certyfikatu (5 kroków, jak
 * na stronie): warunki, instrukcja Aplikacji Podatnika, pliki .crt i .key,
 * sprawdzenie w KSeF, połączono.
 */
function EkranKsef() {
  const router = useRouter();
  const kolory = useKolory();
  const [krok, setKrok] = useState<number | null>(null);
  const [crt, setCrt] = useState(false);
  const [key, setKey] = useState(false);
  const [haslo, setHaslo] = useState('');

  const sprawdz = () => {
    setKrok(3);
    setTimeout(() => {
      setKrok(4);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }, 1800);
  };

  if (krok === null) {
    return (
      <EkranListy>
        <NaglowekKwoty podpis="Połączenie z KSeF" wartosc={KSEF.status} styl="title1" status={`Certyfikat ważny do ${dataPelna(KSEF.certyfikatDo)}`} statusKolor="sukces" />
        <Sekcja naglowek="Połączenie">
          <Wiersz tytul="NIP" wartosc={KSEF.nip} />
          <Wiersz tytul="Certyfikat ważny do" wartosc={dataPelna(KSEF.certyfikatDo)} />
          <Wiersz tytul="Odnów certyfikat" ikona="refresh-line" akcja onPress={() => setKrok(0)} />
        </Sekcja>
        <Sekcja naglowek="Historia faktur z KSeF">
          <Wiersz tytul="Zobacz postęp pobierania" strzalka onPress={() => router.push('/wiecej/import')} />
        </Sekcja>
        <Sekcja naglowek="Logowanie przez Google">
          <Wiersz tytul="Konto Google" wartosc={KSEF.google ? 'Połączone' : 'Niepołączone'} />
        </Sekcja>
      </EkranListy>
    );
  }

  return (
    <EkranListy>
      <View style={styles.naglowek}>
        <Tekst styl="subheadline" kolor="etykietaDrugorzedna">
          Krok {krok + 1} z {KROKI.length}
        </Tekst>
        <Tekst styl="title2">{KROKI[krok]}</Tekst>
        <View style={styles.pasek} accessibilityElementsHidden>
          {KROKI.map((_, i) => (
            <View key={i} style={[styles.odcinek, { backgroundColor: i <= krok ? kolory.akcent : kolory.wypelnienie }]} />
          ))}
        </View>
      </View>

      {krok === 0 ? (
        <>
          <Sekcja naglowek="Warunki">
            <Wiersz tytul="NIP firmy" ikona="checkbox-circle-fill" ikonaKolor="sukces" />
            <Wiersz tytul="Właściciel firmy" ikona="checkbox-circle-fill" ikonaKolor="sukces" />
            <Wiersz tytul="Logowanie dwuetapowe" ikona="checkbox-circle-fill" ikonaKolor="sukces" />
          </Sekcja>
          <View style={styles.akcja}>
            <PrzyciskGlowny tytul="Dalej" onPress={() => setKrok(1)} />
          </View>
        </>
      ) : null}

      {krok === 1 ? (
        <>
          <Sekcja naglowek="W Aplikacji Podatnika KSeF" stopka="Certyfikat może pobrać właściciel firmy albo osoba z uprawnieniem do zarządzania certyfikatami.">
            <Wiersz tytul="1. Zaloguj się do Aplikacji Podatnika" />
            <Wiersz tytul="2. Otwórz Certyfikaty" />
            <Wiersz tytul="3. Ustaw hasło do klucza" />
            <Wiersz tytul="4. „Generuj” zapisze plik .key" />
            <Wiersz tytul="5. Wybierz „Uwierzytelnienie w systemie KSeF”" />
            <Wiersz tytul="6. Pobierz plik .crt" />
            <Wiersz tytul="Otwórz Aplikację Podatnika" ikona="global-line" akcja onPress={() => void WebBrowser.openBrowserAsync('https://ksef.podatki.gov.pl')} />
          </Sekcja>
          <View style={styles.akcja}>
            <PrzyciskGlowny tytul="Mam oba pliki i hasło, dalej" onPress={() => setKrok(2)} />
          </View>
        </>
      ) : null}

      {krok === 2 ? (
        <>
          <Sekcja naglowek="Pliki" stopka="Pliki zostają zaszyfrowane na serwerze FaktWay w Unii Europejskiej.">
            <Wiersz tytul="Certyfikat (.crt)" wartoscPodpis={crt ? 'Wybrano' : 'Wybierz plik'} wartoscPodpisKolor={crt ? 'sukces' : 'akcent'} onPress={() => setCrt(true)} />
            <Wiersz tytul="Klucz prywatny (.key)" wartoscPodpis={key ? 'Wybrano' : 'Wybierz plik'} wartoscPodpisKolor={key ? 'sukces' : 'akcent'} onPress={() => setKey(true)} />
            {key ? <PoleTekstowe etykieta="Hasło do klucza" wartosc={haslo} onZmiana={setHaslo} tajne /> : null}
          </Sekcja>
          <View style={styles.akcja}>
            <PrzyciskGlowny tytul="Sprawdź w KSeF" onPress={() => (crt && key ? sprawdz() : undefined)} />
            <PrzyciskGlowny tytul="Wstecz do instrukcji" wariant="drugorzedny" onPress={() => setKrok(1)} />
          </View>
        </>
      ) : null}

      {krok === 3 ? (
        <View style={styles.czekanie}>
          <ActivityIndicator />
          <Tekst styl="headline">Sprawdzamy certyfikat w KSeF</Tekst>
        </View>
      ) : null}

      {krok === 4 ? (
        <>
          <Sekcja naglowek="Połączono z KSeF">
            <Wiersz tytul={`NIP ${KSEF.nip}`} ikona="verified-badge-fill" ikonaKolor="sukces" />
            <Wiersz tytul="Certyfikat ważny do" wartosc={dataPelna('2028-11-09')} />
          </Sekcja>
          <View style={styles.akcja}>
            <PrzyciskGlowny tytul="Wystaw pierwszą fakturę" ikona="add-line" onPress={() => router.push('/faktury/nowa')} />
            <PrzyciskGlowny tytul="Gotowe" wariant="drugorzedny" onPress={() => setKrok(null)} />
          </View>
        </>
      ) : null}
    </EkranListy>
  );
}

const styles = StyleSheet.create({
  naglowek: { paddingHorizontal: MARGINES + ODSTEP.xxs, paddingTop: ODSTEP.xs, gap: ODSTEP.xxs },
  pasek: { flexDirection: 'row', gap: ODSTEP.xxs },
  odcinek: { flex: 1, height: ODSTEP.xxs, borderRadius: ODSTEP.linia },
  akcja: { marginHorizontal: MARGINES, marginTop: ODSTEP.xl, gap: ODSTEP.s },
  czekanie: { alignItems: 'center', gap: ODSTEP.s, paddingTop: ODSTEP.xxl * 2 },
});

import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { KSEF } from '@/dane-przykladowe/ustawienia';
import { PoleTekstowe } from '@/komponenty/formularz';
import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { NaglowekKwoty } from '@/komponenty/naglowek';
import { PrzyciskGlowny } from '@/komponenty/przycisk-glowny';
import { Tekst } from '@/komponenty/tekst';
import { dataPelna } from '@/lib/format';
import { useKolory } from '@/wyglad/kolory';
import { MARGINES, ODSTEP } from '@/wyglad/odstepy';

const KROKI = ['Sprawdzenie warunków', 'Pobierz certyfikat z KSeF', 'Wgraj pliki', 'Sprawdzamy w KSeF', 'Połączono'];

/**
 * KSeF: status połączenia i kreator podłączenia certyfikatu (5 kroków, jak
 * na stronie): warunki, instrukcja Aplikacji Podatnika, pliki .crt i .key,
 * sprawdzenie w KSeF, połączono.
 */
export default function EkranKsef() {
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
          <Wiersz tytul="Odnów certyfikat" ikona="arrow.clockwise" akcja onPress={() => setKrok(0)} />
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
            <Wiersz tytul="NIP firmy" ikona="checkmark.circle.fill" ikonaKolor="sukces" />
            <Wiersz tytul="Właściciel firmy" ikona="checkmark.circle.fill" ikonaKolor="sukces" />
            <Wiersz tytul="Logowanie dwuetapowe" ikona="checkmark.circle.fill" ikonaKolor="sukces" />
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
            <Wiersz tytul="Otwórz Aplikację Podatnika" ikona="safari" akcja onPress={() => void WebBrowser.openBrowserAsync('https://ksef.podatki.gov.pl')} />
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
            <Wiersz tytul={`NIP ${KSEF.nip}`} ikona="checkmark.seal.fill" ikonaKolor="sukces" />
            <Wiersz tytul="Certyfikat ważny do" wartosc={dataPelna('2028-11-09')} />
          </Sekcja>
          <View style={styles.akcja}>
            <PrzyciskGlowny tytul="Wystaw pierwszą fakturę" ikona="plus" onPress={() => router.push('/faktury/nowa')} />
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

import * as Haptics from 'expo-haptics';
import { useNavigation, useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { Pressable, StyleSheet, View, type TextInputInstance } from 'react-native';

import { EkranLogowania } from '@/komponenty/ekran-logowania';
import { PoleTekstowe } from '@/komponenty/formularz';
import { Karta } from '@/komponenty/karta';
import { PrzyciskGlowny } from '@/komponenty/przycisk-glowny';
import { Tekst } from '@/komponenty/tekst';
import { APPLE_WLACZONE, BLEDY_LOGOWANIA, useSesja, type Wynik } from '@/stan/sesja';
import { useKolory } from '@/wyglad/kolory';
import { CEL_DOTYKU, MARGINES, ODSTEP, PROMIEN_POLA } from '@/wyglad/odstepy';

/**
 * Logowanie (WZORCE-MOBBIN.md 7, ekran 2; wzór Mercury): klient ma konto ze
 * strony, więc aplikacja zaczyna od logowania, bez ekranu powitalnego.
 * E-mail i hasło z podpowiedziami pęku kluczy, „Nie pamiętasz hasła?” na
 * stronie w przeglądarce w aplikacji, Google jako druga droga. Teksty błędów
 * jak na stronie (`app/(auth)/login/page.tsx`).
 */
export default function EkranLogowaniaHaslem() {
  const router = useRouter();
  const kolory = useKolory();
  const navigation = useNavigation();
  const { stan, zaloguj, zalogujGoogle, anulujKod, zapamietanyEmail } = useSesja();
  const [email, setEmail] = useState(zapamietanyEmail);
  const [haslo, setHaslo] = useState('');
  const [blad, setBlad] = useState<string>();
  const [trwa, setTrwa] = useState<'haslo' | 'google'>();
  const pole = useRef<TextInputInstance>(null);

  // Powrót tu z ekranu kodu (gest albo „wstecz”) kończy krok 2FA: hasło wpisuje się od nowa.
  const poPowrocie = useEffectEvent(() => {
    if (stan === 'kod') anulujKod();
  });
  useEffect(() => navigation.addListener('focus', () => poPowrocie()), [navigation]);

  const dalej = (w: Wynik) => {
    if (!w.ok) {
      // Zamknięte okno Google to nie błąd: bez komunikatu i wibracji.
      if (w.blad === 'anulowane') return;
      setBlad(BLEDY_LOGOWANIA[w.blad]);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      return;
    }
    setBlad(undefined);
    setHaslo('');
    if (w.dalej === 'kod') router.push('/logowanie/kod');
    else if (w.dalej === 'propozycja') router.replace('/logowanie/face-id');
    // `gotowe`: zakładki pokazują się same (trasy chronione w `app/_layout.tsx`).
  };

  const zalogujHaslem = async (wpisane = haslo) => {
    if (trwa) return;
    setTrwa('haslo');
    const w = await zaloguj(email, wpisane);
    setTrwa(undefined);
    dalej(w);
  };

  const zalogujPrzezGoogle = async () => {
    if (trwa) return;
    setTrwa('google');
    const w = await zalogujGoogle();
    setTrwa(undefined);
    dalej(w);
  };

  return (
    <EkranLogowania
      logo
      tytul="Zaloguj się"
      opis="Wystawiaj faktury i odbieraj koszty z KSeF."
      stopka={
        <Pressable
          onPress={() => void WebBrowser.openBrowserAsync('https://faktway.pl/register')}
          accessibilityRole="link"
          accessibilityLabel="Nie masz konta? Załóż je na faktway.pl"
          style={styles.link}>
          <Tekst styl="footnote" kolor="etykietaDrugorzedna" style={styles.wysrodkowany}>
            {'Nie masz konta? '}
            <Tekst styl="footnote" waga="semibold" kolor="akcent">
              Załóż je na faktway.pl
            </Tekst>
          </Tekst>
        </Pressable>
      }>
      <Karta wnetrze={styles.karta}>
        <PoleTekstowe
          etykieta="E-mail"
          wartosc={email}
          onZmiana={(t) => {
            setEmail(t);
            setBlad(undefined);
          }}
          klawiatura="email-address"
          autouzupelnianie="login"
          podpowiedz="ty@firma.pl"
          klawiszZatwierdz="next"
          onZatwierdz={() => pole.current?.focus()}
        />
        <PoleTekstowe
          etykieta="Hasło"
          wartosc={haslo}
          onZmiana={(t) => {
            setHaslo(t);
            setBlad(undefined);
          }}
          tajne
          klawiszZatwierdz="go"
          onZatwierdz={(t) => void zalogujHaslem(t)}
          poleRef={pole}
        />
        <Pressable
          onPress={() => void WebBrowser.openBrowserAsync('https://faktway.pl/forgot-password')}
          accessibilityRole="link"
          hitSlop={ODSTEP.xs}
          style={styles.zapomniane}>
          <Tekst styl="subheadline" waga="medium" kolor="akcent">
            Nie pamiętasz hasła?
          </Tekst>
        </Pressable>
      </Karta>

      {blad ? (
        <View style={[styles.blad, { backgroundColor: kolory.bladTlo }]} accessibilityLiveRegion="polite" accessibilityRole="alert">
          <Tekst styl="subheadline" kolor="blad">
            {blad}
          </Tekst>
        </View>
      ) : null}

      <View style={styles.przyciski}>
        <PrzyciskGlowny tytul="Zaloguj się" trwa={trwa === 'haslo'} onPress={() => void zalogujHaslem()} />
        <View style={styles.albo} accessible={false} importantForAccessibility="no-hide-descendants">
          <View style={[styles.kreska, { backgroundColor: kolory.obwodka }]} />
          <Tekst styl="footnote" kolor="etykietaDrugorzedna">
            albo
          </Tekst>
          <View style={[styles.kreska, { backgroundColor: kolory.obwodka }]} />
        </View>
        {/* Wytyczna App Store 4.8: Apple nie mniej widoczny niż Google, więc wyżej. Włączamy w M11. */}
        {APPLE_WLACZONE ? <PrzyciskGlowny tytul="Zaloguj przez Apple" wariant="karta" onPress={() => undefined} /> : null}
        <PrzyciskGlowny tytul="Zaloguj przez Google" ikona="google-fill" wariant="karta" trwa={trwa === 'google'} onPress={() => void zalogujPrzezGoogle()} />
      </View>
    </EkranLogowania>
  );
}

const styles = StyleSheet.create({
  karta: { paddingVertical: ODSTEP.xs },
  zapomniane: { minHeight: CEL_DOTYKU, justifyContent: 'center', paddingHorizontal: MARGINES },
  blad: { marginHorizontal: MARGINES, borderRadius: PROMIEN_POLA, padding: ODSTEP.s },
  przyciski: { paddingHorizontal: MARGINES, gap: ODSTEP.s },
  albo: { flexDirection: 'row', alignItems: 'center', gap: ODSTEP.s },
  kreska: { flex: 1, height: StyleSheet.hairlineWidth },
  link: { minHeight: CEL_DOTYKU, justifyContent: 'center' },
  wysrodkowany: { textAlign: 'center' },
});

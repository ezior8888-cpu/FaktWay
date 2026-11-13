import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { EkranLogowania } from '@/komponenty/ekran-logowania';
import { PoleKodu } from '@/komponenty/formularz';
import { Karta } from '@/komponenty/karta';
import { PrzyciskGlowny } from '@/komponenty/przycisk-glowny';
import { Tekst } from '@/komponenty/tekst';
import { BLEDY_LOGOWANIA, useSesja, type Wynik } from '@/stan/sesja';
import { CEL_DOTYKU, MARGINES, ODSTEP } from '@/wyglad/odstepy';

/**
 * Kod z aplikacji TOTP (WZORCE-MOBBIN.md 7, ekran 3; wzory Kraken i Family):
 * jedno pole z dużymi cyframi, wysyłka sama po szóstej cyfrze, teksty błędów
 * jak na stronie (`app/(auth)/login/two-factor/page.tsx`). Autouzupełnianie
 * kodów iOS (Hasła) wpisuje kod jednym dotknięciem nad klawiaturą.
 */
export default function EkranKodu() {
  const router = useRouter();
  const { potwierdzKod } = useSesja();
  const [kod, setKod] = useState('');
  const [blad, setBlad] = useState<string>();
  const [trwa, setTrwa] = useState(false);

  const wyslij = async (wartosc: string) => {
    if (trwa) return;
    setTrwa(true);
    const w: Wynik = await potwierdzKod(wartosc);
    setTrwa(false);
    if (!w.ok) {
      setBlad(BLEDY_LOGOWANIA[w.blad]);
      setKod('');
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      return;
    }
    if (w.dalej === 'propozycja') router.replace('/logowanie/face-id');
  };

  return (
    <EkranLogowania
      zPaskiem
      tytul="Weryfikacja dwuetapowa"
      opis="Kod z aplikacji uwierzytelniającej potwierdza, że to Ty."
      stopka={
        <Pressable
          onPress={() => void WebBrowser.openBrowserAsync('https://faktway.pl/kontakt')}
          accessibilityRole="link"
          style={styles.link}>
          <Tekst styl="footnote" kolor="etykietaDrugorzedna" style={styles.wysrodkowany}>
            {'Nie masz dostępu do aplikacji? '}
            <Tekst styl="footnote" waga="semibold" kolor="akcent">
              Napisz do pomocy
            </Tekst>
          </Tekst>
        </Pressable>
      }>
      <Karta wnetrze={styles.karta}>
        <PoleKodu
          etykieta="Kod z aplikacji"
          wartosc={kod}
          onZmiana={(t) => {
            setKod(t);
            setBlad(undefined);
            if (t.length === 6) void wyslij(t);
          }}
          opis="Wpisz 6 cyfr. Nowy kod pojawia się w aplikacji co 30 sekund."
          blad={blad}
          autoFocus
          onWklej={(t) => {
            const cyfry = t.replace(/\D/g, '').slice(0, 6);
            if (cyfry.length !== 6) return setBlad('W schowku nie ma 6-cyfrowego kodu.');
            setKod(cyfry);
            setBlad(undefined);
            void wyslij(cyfry);
          }}
        />
      </Karta>
      <View style={styles.przyciski}>
        <PrzyciskGlowny tytul="Zweryfikuj" trwa={trwa} onPress={() => void wyslij(kod)} />
      </View>
    </EkranLogowania>
  );
}

const styles = StyleSheet.create({
  karta: { paddingVertical: ODSTEP.xs },
  przyciski: { paddingHorizontal: MARGINES },
  link: { minHeight: CEL_DOTYKU, justifyContent: 'center' },
  wysrodkowany: { textAlign: 'center' },
});

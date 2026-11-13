/**
 * Ekran blokady i zasłona w przełączniku aplikacji (WZORCE-MOBBIN.md 7,
 * ekran 5; wzór Revolut Business, odblokowanie). Obie warstwy leżą nad całą
 * aplikacją, także nad otwartym arkuszem (`FullWindowOverlay` na iOS), więc
 * kwot nie widać ani po powrocie z tła, ani na miniaturze w przełączniku.
 *
 * Blokada: logo, powitanie, nazwa firmy (księgowe mają kilka firm); pytanie
 * systemu o Face ID pojawia się samo, a po anulowaniu zostają „Odblokuj” i
 * „Zaloguj się na inne konto”. Bez własnego PIN-u: zapasem jest kod telefonu.
 */
import { useEffect, useEffectEvent, useState, type ReactNode } from 'react';
import { AppState, Platform, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { FullWindowOverlay } from 'react-native-screens';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

import { LogoFaktWay } from '@/komponenty/logo';
import { PrzyciskGlowny } from '@/komponenty/przycisk-glowny';
import { Tekst } from '@/komponenty/tekst';
import { useNazwaFirmy } from '@/stan/dane';
import { imieDoPowitania, useSesja } from '@/stan/sesja';
import { useKolory } from '@/wyglad/kolory';
import { CEL_DOTYKU, MARGINES, ODSTEP } from '@/wyglad/odstepy';

/** Warstwa nad całą aplikacją; poza iOS zwykły widok na wierzchu korzenia. */
function NadWszystkim({ children }: { children: ReactNode }) {
  if (Platform.OS === 'ios') return <FullWindowOverlay unstable_accessibilityContainerViewIsModal>{children}</FullWindowOverlay>;
  return <View style={StyleSheet.absoluteFill}>{children}</View>;
}

/** Pełny gradient marki (od góry `gradientGora` do `gradientSrodek`), na którym biały tekst trzyma kontrast. */
function TloMarki({ children }: { children: ReactNode }) {
  const kolory = useKolory();
  const { width, height } = useWindowDimensions();
  return (
    <View style={{ width, height, backgroundColor: kolory.gradientSrodek }}>
      <Svg width={width} height={height} style={StyleSheet.absoluteFill} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <Defs>
          <LinearGradient id="tlo-marki" x1="0" y1="0" x2="0" y2="1">
            <Stop offset={0} stopColor={kolory.gradientGora} />
            <Stop offset={1} stopColor={kolory.gradientSrodek} />
          </LinearGradient>
        </Defs>
        <Rect x={0} y={0} width={width} height={height} fill="url(#tlo-marki)" />
      </Svg>
      {children}
    </View>
  );
}

function powitanie(teraz = new Date()): string {
  const g = teraz.getHours();
  return g >= 5 && g < 18 ? 'Dzień dobry' : 'Dobry wieczór';
}

export function Blokada() {
  const kolory = useKolory();
  const { top, bottom } = useSafeAreaInsets();
  const { zablokowana, konto, biometria, odblokuj, wyloguj } = useSesja();
  // Z `GET /konto` (albo z poprzedniego otwarcia); na danych przykładowych firma z konta przykładowego.
  const firma = useNazwaFirmy();

  // Pytanie systemu pojawia się samo, raz przy każdym pokazaniu blokady (M5b: Face ID).
  const zapytajSystem = useEffectEvent(() => void odblokuj({ sama: true }));
  useEffect(() => {
    if (zablokowana) zapytajSystem();
  }, [zablokowana]);

  if (!zablokowana) return null;
  const imie = imieDoPowitania(konto);
  const tekstPowitania = imie ? `${powitanie()}, ${imie}` : powitanie();
  // Inicjały z imienia i nazwiska, bez nich pierwsza litera e-maila.
  const inicjaly = ((konto?.imie || konto?.email) ?? '')
    .split(' ')
    .map((c) => c[0] ?? '')
    .join('')
    .slice(0, 2)
    .toLocaleUpperCase('pl');
  return (
    <NadWszystkim>
      <TloMarki>
        {/* Przewijana tylko wtedy, gdy duży tekst nie mieści się na małym telefonie. */}
        <ScrollView contentContainerStyle={[styles.blokada, { paddingTop: top + ODSTEP.l, paddingBottom: bottom + ODSTEP.l }]} alwaysBounceVertical={false}>
          <View style={styles.logo}>
            <LogoFaktWay wysokosc={26} biale />
          </View>
          <View style={styles.srodek} accessible accessibilityLabel={`${tekstPowitania}. ${firma}. Aplikacja zablokowana.`}>
            <View style={[styles.awatar, { backgroundColor: kolory.naGradiencieTlo }]}>
              <Tekst styl="title2" kolor="naGradiencie" maxFontSizeMultiplier={1.3}>
                {inicjaly}
              </Tekst>
            </View>
            <Tekst styl="title2" kolor="naGradiencie" style={styles.wysrodkowany}>
              {tekstPowitania}
            </Tekst>
            {firma ? (
              <Tekst styl="subheadline" kolor="naGradiencie" style={styles.wysrodkowany}>
                {firma}
              </Tekst>
            ) : null}
          </View>
          <View style={styles.akcje}>
            <PrzyciskGlowny
              tytul={biometria ? `Odblokuj przez ${biometria.nazwa}` : 'Odblokuj'}
              wariant="naGradiencie"
              onPress={() => void odblokuj()}
            />
            <Pressable onPress={wyloguj} accessibilityRole="button" style={styles.tekstowy}>
              <Tekst styl="callout" waga="medium" kolor="naGradiencie" style={styles.wysrodkowany}>
                Zaloguj się na inne konto
              </Tekst>
            </Pressable>
          </View>
        </ScrollView>
      </TloMarki>
    </NadWszystkim>
  );
}

/**
 * Zasłona, gdy aplikacja nie jest na wierzchu (przełącznik aplikacji, centrum
 * powiadomień): system robi wtedy miniaturę ekranu, a na niej nie może być kwot.
 */
export function Zaslona() {
  const { stan, zablokowana, pytanieSystemu } = useSesja();
  // Tylko jawne „tło” i „nieaktywna”: stan 'unknown' przy starcie nie może zasłonić aplikacji na stałe.
  const [wTle, setWTle] = useState(AppState.currentState === 'background' || AppState.currentState === 'inactive');
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => setWTle(s === 'background' || s === 'inactive'));
    return () => sub.remove();
  }, []);
  if (!wTle || zablokowana || pytanieSystemu || stan !== 'aktywna') return null;
  return (
    <NadWszystkim>
      <TloMarki>
        <View style={styles.zaslona} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <LogoFaktWay wysokosc={32} biale />
        </View>
      </TloMarki>
    </NadWszystkim>
  );
}

const AWATAR = 72;

const styles = StyleSheet.create({
  blokada: { flexGrow: 1, paddingHorizontal: MARGINES },
  logo: { alignItems: 'center' },
  srodek: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: ODSTEP.xs },
  awatar: { width: AWATAR, height: AWATAR, borderRadius: AWATAR / 2, alignItems: 'center', justifyContent: 'center', marginBottom: ODSTEP.xs },
  wysrodkowany: { textAlign: 'center' },
  akcje: { gap: ODSTEP.xs },
  tekstowy: { minHeight: CEL_DOTYKU, alignItems: 'center', justifyContent: 'center' },
  zaslona: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});

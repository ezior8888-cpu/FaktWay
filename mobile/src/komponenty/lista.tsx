/**
 * Lista w stylu systemowym: sekcje „inset grouped” z nagłówkiem i stopką,
 * wiersze z podświetleniem przy dotyku (docs/mobile/ZASADY-DESIGNU.md, sekcja 5).
 */
import { SymbolView, type SFSymbol } from 'expo-symbols';
import { Children, Fragment, isValidElement, type ReactNode } from 'react';
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
  type ScrollViewProps,
} from 'react-native';

import { Tekst } from '@/komponenty/tekst';
import { useKolory, type Kolory } from '@/wyglad/kolory';
import { CEL_DOTYKU, MARGINES, ODSTEP, PROMIEN_SEKCJI, SKALA_PIONOWA } from '@/wyglad/odstepy';

/**
 * Przewijany ekran z tłem listy grupowanej. `contentInsetAdjustmentBehavior`
 * pozwala dużemu tytułowi zwijać się przy przewijaniu (Expo Router, Stack).
 */
export function EkranListy({ children, ...reszta }: ScrollViewProps & { children: ReactNode }) {
  const kolory = useKolory();
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      style={{ backgroundColor: kolory.tloGrupowane }}
      contentContainerStyle={styles.tresc}
      {...reszta}>
      {children}
    </ScrollView>
  );
}

type SekcjaProps = {
  naglowek?: string;
  stopka?: string;
  /** Treść bez karty listy (wykres, kafle, kalendarz): sama rysuje swoje tło i marginesy. */
  swobodna?: boolean;
  children?: ReactNode;
};

export function Sekcja({ naglowek, stopka, swobodna, children }: SekcjaProps) {
  const kolory = useKolory();
  const wiersze = Children.toArray(children).filter(isValidElement);
  return (
    <View style={styles.sekcja}>
      {naglowek ? (
        <Tekst styl="headline" style={styles.naglowek} accessibilityRole="header">
          {naglowek}
        </Tekst>
      ) : null}
      {swobodna ? (
        children
      ) : wiersze.length > 0 ? (
        <View style={[styles.karta, { backgroundColor: kolory.tloKomorki }]}>
          {wiersze.map((w, i) => (
            <Fragment key={w.key ?? i}>
              {i > 0 ? <View style={[styles.separator, { backgroundColor: kolory.separator }]} /> : null}
              {w}
            </Fragment>
          ))}
        </View>
      ) : null}
      {stopka ? (
        <Tekst styl="footnote" kolor="etykietaDrugorzedna" style={styles.stopka}>
          {stopka}
        </Tekst>
      ) : null}
    </View>
  );
}

type WierszProps = {
  tytul: string;
  podtytul?: string;
  wartosc?: string;
  /** Druga linia po prawej, pod wartością (np. status). */
  wartoscPodpis?: string;
  wartoscPodpisKolor?: keyof Kolory;
  /** Kolor wartości (domyślnie drugorzędny, jak w systemowych listach). */
  wartoscKolor?: keyof Kolory;
  /** Dane do skopiowania (NIP, numer KSeF): tekst da się zaznaczyć. */
  zaznaczalna?: boolean;
  ikona?: SFSymbol;
  ikonaKolor?: keyof Kolory;
  /** Strzałka w prawo: wiersz prowadzi do kolejnego ekranu ustawień. */
  strzalka?: boolean;
  /** Znacznik wyboru po prawej, jak w systemowej liście jednokrotnego wyboru. */
  zaznaczony?: boolean;
  /** Akcja niszcząca (np. „Wyloguj”): czerwony tekst, bez wartości. */
  niszczacy?: boolean;
  /** Tekst akcji w kolorze akcentu (np. „Oznacz jako zapłaconą”). */
  akcja?: boolean;
  onPress?: () => void;
  prawaStrona?: ReactNode;
  etykietaDostepnosci?: string;
};

export function Wiersz({
  tytul,
  podtytul,
  wartosc,
  wartoscPodpis,
  wartoscPodpisKolor = 'etykietaDrugorzedna',
  wartoscKolor,
  zaznaczalna,
  ikona,
  ikonaKolor = 'akcent',
  strzalka,
  zaznaczony,
  niszczacy,
  akcja,
  onPress,
  prawaStrona,
  etykietaDostepnosci,
}: WierszProps) {
  const kolory = useKolory();
  const { fontScale } = useWindowDimensions();
  // Przy dużym tekście z ustawień wartość schodzi pod tytuł, żeby nic się nie ucinało.
  const duzyTekst = fontScale >= SKALA_PIONOWA;
  const pionowo = duzyTekst && Boolean(wartosc || wartoscPodpis);
  const tresc = (
    <>
      {ikona ? (
        <SymbolView name={ikona} size={22} tintColor={kolory[ikonaKolor] as string} style={styles.ikona} />
      ) : null}
      <View style={styles.lewa}>
        <Tekst
          styl="body"
          kolor={niszczacy ? 'blad' : akcja ? 'akcent' : 'etykieta'}
          numberOfLines={duzyTekst ? 5 : 2}>
          {tytul}
        </Tekst>
        {podtytul ? (
          <Tekst
            styl="subheadline"
            kolor="etykietaDrugorzedna"
            numberOfLines={pionowo ? 6 : 4}
            selectable={zaznaczalna}>
            {podtytul}
          </Tekst>
        ) : null}
      </View>
      {wartosc || wartoscPodpis ? (
        <View style={pionowo ? styles.prawaPionowa : styles.prawa}>
          {wartosc ? (
            <Tekst
              styl="body"
              kolor={wartoscKolor ?? (podtytul ? 'etykieta' : 'etykietaDrugorzedna')}
              cyfry
              selectable={zaznaczalna}
              numberOfLines={pionowo ? 2 : 1}>
              {wartosc}
            </Tekst>
          ) : null}
          {wartoscPodpis ? (
            <Tekst styl="subheadline" kolor={wartoscPodpisKolor} numberOfLines={1}>
              {wartoscPodpis}
            </Tekst>
          ) : null}
        </View>
      ) : null}
      {prawaStrona}
      {zaznaczony ? (
        <SymbolView name="checkmark" size={17} weight="semibold" tintColor={kolory.akcent as string} style={styles.znacznik} />
      ) : null}
      {strzalka ? (
        <SymbolView
          name="chevron.right"
          size={14}
          weight="semibold"
          tintColor={kolory.etykietaTrzeciorzedna as string}
          style={styles.strzalka}
        />
      ) : null}
    </>
  );

  if (!onPress) {
    return (
      <View
        style={[styles.wiersz, pionowo ? styles.wierszPionowy : null]}
        accessible={!zaznaczalna}
        accessibilityLabel={etykietaDostepnosci}>
        {tresc}
      </View>
    );
  }
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={etykietaDostepnosci}
      accessibilityState={zaznaczony === undefined ? undefined : { selected: zaznaczony }}
      android_ripple={{ color: kolory.wypelnienie as string }}
      style={({ pressed }) => [
        styles.wiersz,
        pionowo ? styles.wierszPionowy : null,
        pressed && Platform.OS === 'ios' ? { backgroundColor: kolory.wypelnienie } : null,
      ]}>
      {tresc}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  tresc: { paddingBottom: ODSTEP.xxl },
  sekcja: { marginTop: ODSTEP.xl },
  naglowek: { marginBottom: ODSTEP.xs, marginLeft: MARGINES + ODSTEP.xxs, marginRight: MARGINES },
  stopka: { marginTop: ODSTEP.xs, marginHorizontal: MARGINES * 2 },
  karta: { marginHorizontal: MARGINES, borderRadius: PROMIEN_SEKCJI, borderCurve: 'continuous', overflow: 'hidden' },
  // Jak w listach iOS 26 i nowszych: separator wcięty z obu stron (porównanie z Ustawieniami, M3).
  separator: { height: StyleSheet.hairlineWidth, marginHorizontal: MARGINES },
  wiersz: {
    // 52 pt jak jednoliniowy wiersz w Ustawieniach iOS 27.
    minHeight: CEL_DOTYKU + ODSTEP.xs,
    paddingHorizontal: MARGINES,
    paddingVertical: ODSTEP.s,
    flexDirection: 'row',
    alignItems: 'center',
    gap: ODSTEP.s,
  },
  ikona: { width: 28, height: 28 },
  lewa: { flex: 1, gap: ODSTEP.linia },
  prawa: { alignItems: 'flex-end', gap: ODSTEP.linia, maxWidth: '50%' },
  prawaPionowa: { alignItems: 'flex-start', gap: ODSTEP.linia },
  wierszPionowy: { flexDirection: 'column', alignItems: 'stretch', gap: ODSTEP.xxs },
  strzalka: { width: 10, height: 14 },
  znacznik: { width: 20, height: 20 },
});

/**
 * Lista w stylu systemowym: sekcje „inset grouped” z nagłówkiem i stopką,
 * wiersze z podświetleniem przy dotyku (docs/mobile/ZASADY-DESIGNU.md, sekcja 5).
 */
import { SymbolView, type SFSymbol } from 'expo-symbols';
import { Children, Fragment, isValidElement, type ReactNode } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, View, type ScrollViewProps } from 'react-native';

import { Tekst } from '@/komponenty/tekst';
import { useKolory, type Kolory } from '@/wyglad/kolory';
import { CEL_DOTYKU, MARGINES, ODSTEP, PROMIEN_SEKCJI } from '@/wyglad/odstepy';

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

type SekcjaProps = { naglowek?: string; stopka?: string; children: ReactNode };

export function Sekcja({ naglowek, stopka, children }: SekcjaProps) {
  const kolory = useKolory();
  const wiersze = Children.toArray(children).filter(isValidElement);
  return (
    <View style={styles.sekcja}>
      {naglowek ? (
        <Tekst styl="headline" style={styles.naglowek} accessibilityRole="header">
          {naglowek}
        </Tekst>
      ) : null}
      <View style={[styles.karta, { backgroundColor: kolory.tloKomorki }]}>
        {wiersze.map((w, i) => (
          <Fragment key={w.key ?? i}>
            {i > 0 ? <View style={[styles.separator, { backgroundColor: kolory.separator }]} /> : null}
            {w}
          </Fragment>
        ))}
      </View>
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
  ikona?: SFSymbol;
  ikonaKolor?: keyof Kolory;
  /** Strzałka w prawo: wiersz prowadzi do kolejnego ekranu ustawień. */
  strzalka?: boolean;
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
  ikona,
  ikonaKolor = 'akcent',
  strzalka,
  niszczacy,
  akcja,
  onPress,
  prawaStrona,
  etykietaDostepnosci,
}: WierszProps) {
  const kolory = useKolory();
  const tresc = (
    <>
      {ikona ? (
        <SymbolView name={ikona} size={22} tintColor={kolory[ikonaKolor] as string} style={styles.ikona} />
      ) : null}
      <View style={styles.lewa}>
        <Tekst
          styl="body"
          kolor={niszczacy ? 'blad' : akcja ? 'akcent' : 'etykieta'}
          numberOfLines={2}>
          {tytul}
        </Tekst>
        {podtytul ? (
          <Tekst styl="subheadline" kolor="etykietaDrugorzedna" numberOfLines={2}>
            {podtytul}
          </Tekst>
        ) : null}
      </View>
      {wartosc || wartoscPodpis ? (
        <View style={styles.prawa}>
          {wartosc ? (
            <Tekst styl="body" kolor={podtytul ? 'etykieta' : 'etykietaDrugorzedna'} cyfry numberOfLines={1}>
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
      <View style={styles.wiersz} accessible accessibilityLabel={etykietaDostepnosci}>
        {tresc}
      </View>
    );
  }
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={etykietaDostepnosci}
      android_ripple={{ color: kolory.wypelnienie as string }}
      style={({ pressed }) => [
        styles.wiersz,
        pressed && Platform.OS === 'ios' ? { backgroundColor: kolory.wypelnienie } : null,
      ]}>
      {tresc}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  tresc: { paddingBottom: ODSTEP.xxl },
  sekcja: { marginTop: ODSTEP.xl, marginHorizontal: MARGINES },
  naglowek: { marginBottom: ODSTEP.xs, marginLeft: ODSTEP.xxs },
  stopka: { marginTop: ODSTEP.xs, marginHorizontal: MARGINES },
  karta: { borderRadius: PROMIEN_SEKCJI, borderCurve: 'continuous', overflow: 'hidden' },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: MARGINES },
  wiersz: {
    minHeight: CEL_DOTYKU + ODSTEP.s,
    paddingHorizontal: MARGINES,
    paddingVertical: ODSTEP.s,
    flexDirection: 'row',
    alignItems: 'center',
    gap: ODSTEP.s,
  },
  ikona: { width: 28, height: 28 },
  lewa: { flex: 1, gap: ODSTEP.linia },
  prawa: { alignItems: 'flex-end', gap: ODSTEP.linia, maxWidth: '50%' },
  strzalka: { width: 10, height: 14 },
});

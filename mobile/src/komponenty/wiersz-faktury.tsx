/**
 * Wiersz faktury na liście: dotknięcie otwiera szczegół, przytrzymanie daje
 * podgląd i menu (Link.Preview, Link.Menu), przesunięcie w lewo oznacza zapłatę
 * (docs/mobile/ZASADY-DESIGNU.md, sekcja 5). Każda akcja z gestu jest też
 * na ekranie szczegółu.
 */
import * as Haptics from 'expo-haptics';
import { Link } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useRef, useState } from 'react';
import { Pressable, Share, StyleSheet, useWindowDimensions, View, type ColorValue } from 'react-native';
import ReanimatedSwipeable, { type SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable';
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';

import { DZIS, type Faktura } from '@/dane-przykladowe';
import { Tekst } from '@/komponenty/tekst';
import { dataKrotka, kwota } from '@/lib/format';
import { doZaplaty, statusFaktury } from '@/lib/status-faktury';
import { useStanFaktur } from '@/stan/faktury';
import { useKolory } from '@/wyglad/kolory';
import { CEL_DOTYKU, MARGINES, ODSTEP, SKALA_PIONOWA } from '@/wyglad/odstepy';

const SZEROKOSC_AKCJI = 96;
/** Biały na kolorowym tle akcji przesunięcia, jak w akcjach systemowych iOS (wyjątek od kolorów semantycznych). */
const NA_AKCJI = '#FFFFFF';

export function WierszFaktury({ faktura: f }: { faktura: Faktura }) {
  const kolory = useKolory();
  const { ustawZaplate } = useStanFaktur();
  const { fontScale } = useWindowDimensions();
  const swipe = useRef<SwipeableMethods>(null);
  // Link z `asChild` spłaszcza style (Slot), więc styl zależny od wciśnięcia liczymy ze stanu.
  const [wcisniety, setWcisniety] = useState(false);
  const status = statusFaktury(f, DZIS);
  const pionowo = fontScale >= SKALA_PIONOWA;
  const mozeZaplacic = doZaplaty(f) || f.zaplacona;

  const przelaczZaplate = () => {
    ustawZaplate(f.id, !f.zaplacona);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  const udostepnij = () => {
    void Share.share({ message: `Faktura ${f.numer} dla ${f.kontrahent}, ${kwota(f.brutto)}.` });
  };

  const akcja = (postep: SharedValue<number>) => (
    <AkcjaPrzesuniecia
      postep={postep}
      zaplacona={f.zaplacona}
      tlo={f.zaplacona ? kolory.etykietaDrugorzedna : kolory.sukces}
    />
  );

  const tresc = (
    <Link href={{ pathname: '/faktura/[id]', params: { id: f.id } }} asChild>
      <Link.Trigger>
        <Pressable
          accessibilityLabel={`${f.kontrahent}, ${kwota(f.brutto)}, ${status.tekst}`}
          accessibilityHint="Otwiera fakturę"
          onPressIn={() => setWcisniety(true)}
          onPressOut={() => setWcisniety(false)}
          style={StyleSheet.flatten([
            styles.wiersz,
            pionowo ? styles.wierszPionowy : null,
            { backgroundColor: wcisniety ? kolory.wypelnienie : kolory.tloKomorki },
          ])}>
          <View style={styles.lewa}>
            <Tekst styl="body" numberOfLines={pionowo ? 3 : 1}>
              {f.kontrahent}
            </Tekst>
            <Tekst styl="subheadline" kolor="etykietaDrugorzedna" numberOfLines={pionowo ? 2 : 1}>
              {f.numer} · {dataKrotka(f.dataWystawienia)}
            </Tekst>
          </View>
          <View style={pionowo ? styles.prawaPionowa : styles.prawa}>
            <Tekst styl="body" cyfry numberOfLines={1}>
              {kwota(f.brutto)}
            </Tekst>
            <Tekst styl="subheadline" kolor={status.kolor} numberOfLines={pionowo ? 2 : 1}>
              {status.tekst}
            </Tekst>
          </View>
        </Pressable>
      </Link.Trigger>
      <Link.Preview />
      <Link.Menu>
        {mozeZaplacic ? (
          <Link.MenuAction
            title={f.zaplacona ? 'Cofnij oznaczenie zapłaty' : 'Oznacz jako zapłaconą'}
            icon={f.zaplacona ? 'arrow.uturn.backward' : 'checkmark.circle'}
            onPress={przelaczZaplate}
          />
        ) : null}
        <Link.MenuAction title="Udostępnij" icon="square.and.arrow.up" onPress={udostepnij} />
      </Link.Menu>
    </Link>
  );

  if (!mozeZaplacic) return tresc;

  return (
    <ReanimatedSwipeable
      ref={swipe}
      friction={2}
      rightThreshold={SZEROKOSC_AKCJI / 2}
      overshootRight={false}
      renderRightActions={akcja}
      onSwipeableWillOpen={() => void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)}
      onSwipeableOpen={() => {
        przelaczZaplate();
        swipe.current?.close();
      }}>
      {tresc}
    </ReanimatedSwipeable>
  );
}

/**
 * Akcja pod wierszem. Widoczna tylko w trakcie przesuwania: przy przytrzymaniu
 * system unosi wiersz do podglądu i bez tego spod spodu wyglądałaby akcja.
 */
type AkcjaProps = { postep: SharedValue<number>; zaplacona: boolean; tlo: ColorValue };

function AkcjaPrzesuniecia({ postep, zaplacona, tlo }: AkcjaProps) {
  const widocznosc = useAnimatedStyle(() => ({ opacity: postep.value > 0.01 ? 1 : 0 }));
  return (
    <Animated.View style={[styles.akcja, { backgroundColor: tlo }, widocznosc]}>
      <SymbolView
        name={zaplacona ? 'arrow.uturn.backward' : 'checkmark'}
        size={20}
        weight="semibold"
        tintColor={NA_AKCJI}
        style={styles.ikonaAkcji}
      />
      <Tekst styl="footnote" pogrubiony style={styles.tekstAkcji} numberOfLines={1}>
        {zaplacona ? 'Cofnij' : 'Zapłacona'}
      </Tekst>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wiersz: {
    minHeight: CEL_DOTYKU + ODSTEP.xs,
    paddingHorizontal: MARGINES,
    paddingVertical: ODSTEP.s,
    flexDirection: 'row',
    alignItems: 'center',
    gap: ODSTEP.s,
  },
  wierszPionowy: { flexDirection: 'column', alignItems: 'stretch', gap: ODSTEP.xxs },
  lewa: { flex: 1, gap: ODSTEP.linia },
  prawa: { alignItems: 'flex-end', gap: ODSTEP.linia },
  prawaPionowa: { alignItems: 'flex-start', gap: ODSTEP.linia },
  akcja: { width: SZEROKOSC_AKCJI, alignItems: 'center', justifyContent: 'center', gap: ODSTEP.xxs },
  ikonaAkcji: { width: 24, height: 24 },
  tekstAkcji: { color: NA_AKCJI },
});

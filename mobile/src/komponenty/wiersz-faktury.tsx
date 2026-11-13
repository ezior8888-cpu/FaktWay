/**
 * Wiersz faktury na liście: dotknięcie otwiera szczegół, przytrzymanie daje
 * podgląd i menu (Link.Preview, Link.Menu), przesunięcie w lewo oznacza zapłatę
 * (docs/mobile/ZASADY-DESIGNU.md, sekcja 5). Każda akcja z gestu jest też
 * na ekranie szczegółu.
 */
import { Link } from 'expo-router';
import { useRef, useState } from 'react';
import { Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import ReanimatedSwipeable, { type SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable';
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';

import type { Faktura } from '@/dane-przykladowe';
import { Ikona } from '@/komponenty/ikona';
import { Tekst } from '@/komponenty/tekst';
import { Znacznik } from '@/komponenty/znacznik';
import { dataKrotka, kwota } from '@/lib/format';
import { doZaplaty, statusFaktury } from '@/lib/status-faktury';
import { udostepnijFakture, useStanFaktur } from '@/stan/faktury';
import { useKolory } from '@/wyglad/kolory';
import { CEL_DOTYKU, MARGINES, ODSTEP, SKALA_PIONOWA } from '@/wyglad/odstepy';

const SZEROKOSC_AKCJI = 96;
/** Biały na kolorowym tle akcji przesunięcia, jak w akcjach systemowych iOS (wyjątek od kolorów semantycznych). */
const NA_AKCJI = '#FFFFFF';
/** Tła akcji przesunięcia stałe w obu trybach: jasna zieleń trybu ciemnego nie niesie białego napisu. */
const TLO_ZAPLACONA = '#15803D';
const TLO_COFNIJ = '#6C727E';

export function WierszFaktury({ faktura: f }: { faktura: Faktura }) {
  const kolory = useKolory();
  const { przelaczZaplate, dzis } = useStanFaktur();
  const { fontScale } = useWindowDimensions();
  const swipe = useRef<SwipeableMethods>(null);
  // Link z `asChild` spłaszcza style (Slot), więc styl zależny od wciśnięcia liczymy ze stanu.
  const [wcisniety, setWcisniety] = useState(false);
  const status = statusFaktury(f, dzis);
  const pionowo = fontScale >= SKALA_PIONOWA;
  const mozeZaplacic = doZaplaty(f) || f.zaplacona;
  // Faktura w terminie: termin w podpisie, bez plakietki (wzór Revolut Business, D14); plakietka tylko przy wyjątkach.
  const zwykla = status.ton === 'neutralny' && f.statusKsef !== 'robocza';

  const akcja = (postep: SharedValue<number>) => (
    <AkcjaPrzesuniecia
      postep={postep}
      zaplacona={f.zaplacona}
      tlo={f.zaplacona ? TLO_COFNIJ : TLO_ZAPLACONA}
    />
  );

  const tresc = (
    <Link href={{ pathname: '/faktury/[id]', params: { id: f.id } }} asChild>
      <Link.Trigger>
        <Pressable
          accessibilityLabel={`${f.kontrahent}, ${kwota(f.brutto, f.waluta)}, ${status.tekst}`}
          accessibilityHint="Otwiera fakturę"
          onPressIn={() => setWcisniety(true)}
          onPressOut={() => setWcisniety(false)}
          style={StyleSheet.flatten([
            styles.wiersz,
            pionowo ? styles.wierszPionowy : null,
            { backgroundColor: wcisniety ? kolory.wypelnienie : kolory.tloKomorki },
          ])}>
          <View style={styles.lewa}>
            <Tekst styl="body" waga="medium" numberOfLines={pionowo ? 3 : 1}>
              {f.kontrahent}
            </Tekst>
            <Tekst styl="footnote" kolor="etykietaDrugorzedna" cyfry numberOfLines={pionowo ? 2 : 1}>
              {f.numer} · {zwykla ? `termin ${dataKrotka(f.terminPlatnosci)}` : dataKrotka(f.dataWystawienia)}
            </Tekst>
          </View>
          <View style={pionowo ? styles.prawaPionowa : styles.prawa}>
            <Tekst styl="callout" cyfry waga="medium" numberOfLines={1}>
              {kwota(f.brutto, f.waluta)}
            </Tekst>
            {zwykla ? null : (
              <Znacznik ton={status.ton} trwa={status.trwa}>
                {status.tekst}
              </Znacznik>
            )}
          </View>
        </Pressable>
      </Link.Trigger>
      <Link.Preview />
      <Link.Menu>
        {mozeZaplacic ? (
          <Link.MenuAction
            title={f.zaplacona ? 'Cofnij oznaczenie zapłaty' : 'Oznacz jako zapłaconą'}
            icon={f.zaplacona ? 'arrow.uturn.backward' : 'checkmark.circle'}
            onPress={() => przelaczZaplate(f)}
          />
        ) : null}
        <Link.MenuAction title="Udostępnij" icon="square.and.arrow.up" onPress={() => udostepnijFakture(f)} />
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
      onSwipeableOpen={() => {
        przelaczZaplate(f);
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
type AkcjaProps = { postep: SharedValue<number>; zaplacona: boolean; tlo: string };

function AkcjaPrzesuniecia({ postep, zaplacona, tlo }: AkcjaProps) {
  const widocznosc = useAnimatedStyle(() => ({ opacity: postep.value > 0.01 ? 1 : 0 }));
  return (
    <Animated.View style={[styles.akcja, { backgroundColor: tlo }, widocznosc]}>
      <Ikona nazwa={zaplacona ? 'arrow-go-back-line' : 'check-line'} rozmiar={22} kolor={NA_AKCJI} />
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
  prawa: { alignItems: 'flex-end', gap: ODSTEP.xxs },
  prawaPionowa: { alignItems: 'flex-start', gap: ODSTEP.xxs },
  akcja: { width: SZEROKOSC_AKCJI, alignItems: 'center', justifyContent: 'center', gap: ODSTEP.xxs },
  tekstAkcji: { color: NA_AKCJI },
});

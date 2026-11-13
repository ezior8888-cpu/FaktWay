/**
 * Szkielet ekranów logowania (WZORCE-MOBBIN.md 7, wzór Mercury; wykończenie
 * D15): u góry na gradiencie białe logo, tytuł i jedno zdanie, niżej karty
 * na tle ekranu. Bez paska nawigacji, więc nagłówek stoi w treści, a gradient
 * zaczyna się pod nim (`GradientNaglowka odsuniecie`). Klawiatura nie zasłania
 * pól (`automaticallyAdjustKeyboardInsets`).
 */
import { useState, type ReactNode } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { GradientNaglowka } from '@/komponenty/gradient-naglowka';
import { LogoFaktWay } from '@/komponenty/logo';
import { Tekst } from '@/komponenty/tekst';
import { useKolory } from '@/wyglad/kolory';
import { GRADIENT, MARGINES, ODSTEP } from '@/wyglad/odstepy';

/**
 * Gradient zaczyna jaśnieć dopiero pod górną krawędzią karty: biały opis pod
 * tytułem stoi wtedy na kolorach `gradientGora` i `gradientSrodek` (kontrast
 * 4.5:1, test `mobile-kontrast`), a nie na jaśniejszym przejściu w tło.
 */
const ZAPAS_GRADIENTU = GRADIENT.nadTrescia * 0.4;

/** Wysokość systemowego paska nawigacji iOS, gdy ekran ma nad treścią przezroczysty pasek z „wstecz”. */
const PASEK_NAWIGACJI = 44;

type Props = {
  tytul: string;
  opis?: string;
  /** Logo nad tytułem (pierwszy ekran logowania). */
  logo?: boolean;
  /** Nad treścią stoi przezroczysty pasek z przyciskiem „wstecz” (ekran kodu). */
  zPaskiem?: boolean;
  children: ReactNode;
  /** Na dole ekranu, pod kartami (np. „Nie masz konta?”). */
  stopka?: ReactNode;
};

export function EkranLogowania({ tytul, opis, logo, zPaskiem, children, stopka }: Props) {
  const kolory = useKolory();
  const { top, bottom } = useSafeAreaInsets();
  // Pierwsza karta zaczyna się pod nagłówkiem, którego wysokość zależy od rozmiaru tekstu.
  const [wysokoscNaglowka, setWysokoscNaglowka] = useState(220);
  return (
    <ScrollView
      style={{ backgroundColor: kolory.tloGrupowane }}
      contentContainerStyle={[styles.tresc, { paddingBottom: bottom + ODSTEP.xl }]}
      contentInsetAdjustmentBehavior="never"
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      automaticallyAdjustKeyboardInsets>
      <GradientNaglowka odsuniecie={wysokoscNaglowka + ZAPAS_GRADIENTU} />
      <View
        onLayout={(e) => setWysokoscNaglowka(e.nativeEvent.layout.height)}
        style={[styles.naglowek, { paddingTop: top + (zPaskiem ? PASEK_NAWIGACJI + ODSTEP.xs : ODSTEP.xl) }]}>
        {logo ? (
          <View style={styles.logo}>
            <LogoFaktWay wysokosc={28} biale />
          </View>
        ) : null}
        <Tekst styl="largeTitle" kolor="naGradiencie" accessibilityRole="header">
          {tytul}
        </Tekst>
        {opis ? (
          <Tekst styl="subheadline" kolor="naGradiencie">
            {opis}
          </Tekst>
        ) : null}
      </View>
      <View style={styles.karty}>{children}</View>
      {stopka ? <View style={styles.stopka}>{stopka}</View> : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  tresc: { flexGrow: 1 },
  naglowek: { paddingHorizontal: MARGINES + ODSTEP.xxs, paddingBottom: ODSTEP.xl, gap: ODSTEP.xs },
  logo: { marginBottom: ODSTEP.xl },
  karty: { gap: ODSTEP.m },
  stopka: { flex: 1, justifyContent: 'flex-end', paddingTop: ODSTEP.xl, paddingHorizontal: MARGINES },
});

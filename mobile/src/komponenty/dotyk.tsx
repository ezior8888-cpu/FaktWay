/**
 * Dotyk z animacją wciśnięcia: element lekko się zmniejsza na sprężynie
 * i wraca po puszczeniu (wątek interfejsu, Reanimated), opcjonalnie z lekką
 * wibracją. Dla przycisków i kafli; wiersze list podświetlają tło.
 *
 * Android (M12, ZASADY-DESIGNU.md, sekcja 10): zamiast zmniejszenia fala
 * Material (`android_ripple`), przycięta do zaokrąglenia (`DotykFala`).
 */
import * as Haptics from 'expo-haptics';
import { Platform, Pressable, StyleSheet, View, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';

import { useKolory } from '@/wyglad/kolory';

const AnimowanyPressable = Animated.createAnimatedComponent(Pressable);
const SPREZYNA = { damping: 18, stiffness: 320, mass: 0.6 };

type Props = Omit<PressableProps, 'style'> & {
  style?: StyleProp<ViewStyle>;
  /** Skala przy wciśnięciu (domyślnie 0,97). Na Androidzie bez skali, jest fala. */
  skala?: number;
  /** Lekka wibracja przy dotknięciu. */
  wibracja?: boolean;
  /** Kolor fali na Androidzie (domyślnie `fala` z palety; na przycisku w kolorze marki `falaNaAkcencie`). */
  fala?: string;
};

export function Dotyk({ style, skala = 0.97, wibracja, fala, onPressIn, onPressOut, onPress, ...reszta }: Props) {
  const s = useSharedValue(1);
  const animacja = useAnimatedStyle(() => ({ transform: [{ scale: s.value }] }));
  const dotkniecie: PressableProps['onPress'] = (e) => {
    if (wibracja) void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onPress?.(e);
  };
  if (Platform.OS === 'android') {
    return <DotykFala {...reszta} style={style} fala={fala} onPressIn={onPressIn} onPressOut={onPressOut} onPress={dotkniecie} />;
  }
  return (
    <AnimowanyPressable
      {...reszta}
      onPressIn={(e) => {
        s.set(withSpring(skala, SPREZYNA));
        onPressIn?.(e);
      }}
      onPressOut={(e) => {
        s.set(withSpring(1, SPREZYNA));
        onPressOut?.(e);
      }}
      onPress={dotkniecie}
      style={[style, animacja]}
    />
  );
}

/**
 * Układ treści idzie do środka (tam jest fala), reszta stylu (tło, rogi, cień,
 * marginesy, wymiary) na zewnątrz.
 */
const STYL_WNETRZA = new Set<string>([
  'padding',
  'paddingHorizontal',
  'paddingVertical',
  'paddingTop',
  'paddingBottom',
  'paddingLeft',
  'paddingRight',
  'paddingStart',
  'paddingEnd',
  'flexDirection',
  'flexWrap',
  'alignItems',
  'alignContent',
  'justifyContent',
  'gap',
  'rowGap',
  'columnGap',
]);

function podzielStyl(style: StyleProp<ViewStyle>): [ViewStyle, ViewStyle] {
  const plaski = (StyleSheet.flatten(style) ?? {}) as Record<string, unknown>;
  const zewnatrz: Record<string, unknown> = {};
  const wnetrze: Record<string, unknown> = {};
  for (const [klucz, wartosc] of Object.entries(plaski)) (STYL_WNETRZA.has(klucz) ? wnetrze : zewnatrz)[klucz] = wartosc;
  return [zewnatrz as ViewStyle, wnetrze as ViewStyle];
}

type PropsFali = Omit<PressableProps, 'style'> & {
  style?: StyleProp<ViewStyle>;
  fala?: string;
  /** Fala nad treścią: gdy treść ma własne nieprzezroczyste tło (pole formularza), fala pod nią byłaby niewidoczna. */
  nadTrescia?: boolean;
};

/**
 * Dotyk z falą Material (Android). React Native rysuje falę w prostokątnej
 * masce (`ReactDrawableHelper.getMask`), więc na zaokrąglonym przycisku
 * wychodziłaby rogami. Przycina ją zewnętrzny widok z rogami przycisku
 * (`overflow: 'hidden'` tnie dzieci, a cień zewnętrznego widoku zostaje).
 */
export function DotykFala({ style, fala, nadTrescia, ...reszta }: PropsFali) {
  const kolory = useKolory();
  const [zewnatrz, wnetrze] = podzielStyl(style);
  return (
    <View style={[zewnatrz, styles.przycinanie]}>
      <Pressable {...reszta} android_ripple={{ color: fala ?? kolory.fala, foreground: nadTrescia }} style={[styles.wypelnienie, wnetrze]} />
    </View>
  );
}

const styles = StyleSheet.create({
  przycinanie: { overflow: 'hidden' },
  wypelnienie: { flexGrow: 1 },
});

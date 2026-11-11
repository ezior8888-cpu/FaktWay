/**
 * Dotyk z animacją wciśnięcia: element lekko się zmniejsza na sprężynie
 * i wraca po puszczeniu (wątek interfejsu, Reanimated), opcjonalnie z lekką
 * wibracją. Dla przycisków i kafli; wiersze list podświetlają tło.
 */
import * as Haptics from 'expo-haptics';
import { Pressable, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';

const AnimowanyPressable = Animated.createAnimatedComponent(Pressable);
const SPREZYNA = { damping: 18, stiffness: 320, mass: 0.6 };

type Props = Omit<PressableProps, 'style'> & {
  style?: StyleProp<ViewStyle>;
  /** Skala przy wciśnięciu (domyślnie 0,97). */
  skala?: number;
  /** Lekka wibracja przy dotknięciu. */
  wibracja?: boolean;
};

export function Dotyk({ style, skala = 0.97, wibracja, onPressIn, onPressOut, onPress, ...reszta }: Props) {
  const s = useSharedValue(1);
  const animacja = useAnimatedStyle(() => ({ transform: [{ scale: s.value }] }));
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
      onPress={(e) => {
        if (wibracja) void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        onPress?.(e);
      }}
      style={[style, animacja]}
    />
  );
}

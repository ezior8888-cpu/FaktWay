/**
 * Karta jak w Copilocie (plan aplikacji, D15; ZASADY-DESIGNU.md, sekcja 5):
 * białe tło, rogi 18 pt, bez obwódki, delikatny cień w jasnym motywie.
 * Cień leży na zewnętrznym widoku, a przycinanie do zaokrąglenia (podświetlony
 * wiersz w rogu karty) na wewnętrznym, bo `overflow: 'hidden'` ucina cień.
 */
import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { useCiemny, useKolory } from '@/wyglad/kolory';
import { CIEN_KARTY, MARGINES, PROMIEN_KARTY } from '@/wyglad/odstepy';

/** Tło, zaokrąglenie i cień karty dla komponentów, które same są przyciskiem (kafel). */
export function useStylKarty(): ViewStyle {
  const kolory = useKolory();
  const ciemny = useCiemny();
  return { backgroundColor: kolory.tloKomorki, borderRadius: PROMIEN_KARTY, boxShadow: ciemny ? undefined : CIEN_KARTY };
}

type Props = { children: ReactNode; style?: StyleProp<ViewStyle>; wnetrze?: StyleProp<ViewStyle> };

export function Karta({ children, style, wnetrze }: Props) {
  const stylKarty = useStylKarty();
  return (
    <View style={[styles.karta, stylKarty, style]}>
      <View style={[styles.wnetrze, wnetrze]}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  karta: { marginHorizontal: MARGINES },
  wnetrze: { borderRadius: PROMIEN_KARTY, overflow: 'hidden' },
});

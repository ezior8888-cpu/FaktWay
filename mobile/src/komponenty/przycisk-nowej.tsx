/**
 * Wariant C decyzji D7: „Nowa faktura” w pasku nad zakładkami
 * (NativeTabs.BottomAccessory), dostępny z każdej zakładki, jak plus na dolnym
 * pasku obecnego PWA.
 */
import { useRouter } from 'expo-router';
import { NativeTabs } from 'expo-router/native-tabs';
import { SymbolView } from 'expo-symbols';
import { Pressable, StyleSheet } from 'react-native';

import { Tekst } from '@/komponenty/tekst';
import { useKolory } from '@/wyglad/kolory';
import { CEL_DOTYKU, MARGINES, ODSTEP } from '@/wyglad/odstepy';

export function PrzyciskNowejNadZakladkami() {
  const router = useRouter();
  const kolory = useKolory();
  const umiejscowienie = NativeTabs.BottomAccessory.usePlacement();
  const kompaktowo = umiejscowienie === 'inline';
  return (
    <Pressable
      onPress={() => router.push('/nowa')}
      accessibilityRole="button"
      accessibilityLabel="Nowa faktura"
      style={({ pressed }) => [styles.przycisk, { opacity: pressed ? 0.6 : 1 }]}>
      <SymbolView name="plus.circle.fill" size={22} tintColor={kolory.akcent as string} style={styles.ikona} />
      {kompaktowo ? null : (
        <Tekst styl="headline" kolor="akcent">
          Nowa faktura
        </Tekst>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  przycisk: {
    minHeight: CEL_DOTYKU,
    paddingHorizontal: MARGINES,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: ODSTEP.xs,
  },
  ikona: { width: 24, height: 24 },
});

/**
 * Górny pasek Pulpitu: logo FaktWay po lewej i okrągły awatar firmy po
 * prawej, jak nagłówek menu bocznego strony (`app-sidebar.tsx`: logo u góry)
 * i awatar użytkownika. Stoi nad przewijaną treścią, pod paskiem stanu.
 */
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { LogoFaktWay } from '@/komponenty/logo';
import { Tekst } from '@/komponenty/tekst';
import { useKolory } from '@/wyglad/kolory';
import { CEL_DOTYKU, MARGINES, ODSTEP } from '@/wyglad/odstepy';

type Props = { inicjaly: string; etykietaAwatara: string; onAwatar: () => void };

export function PasekMarki({ inicjaly, etykietaAwatara, onAwatar }: Props) {
  const kolory = useKolory();
  const { top } = useSafeAreaInsets();
  return (
    <View style={[styles.pasek, { paddingTop: top + ODSTEP.xs, backgroundColor: kolory.tloGrupowane }]}>
      <LogoFaktWay wysokosc={24} />
      <Pressable onPress={onAwatar} accessibilityRole="button" accessibilityLabel={etykietaAwatara} hitSlop={ODSTEP.xs} style={styles.dotyk}>
        <View style={[styles.awatar, { backgroundColor: kolory.akcentTlo }]}>
          <Tekst styl="footnote" waga="semibold" kolor="akcentNaTle">
            {inicjaly}
          </Tekst>
        </View>
      </Pressable>
    </View>
  );
}

const AWATAR = 36;

const styles = StyleSheet.create({
  pasek: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: MARGINES + ODSTEP.xxs,
    paddingBottom: ODSTEP.xs,
  },
  dotyk: { minWidth: CEL_DOTYKU, minHeight: CEL_DOTYKU, alignItems: 'flex-end', justifyContent: 'center' },
  awatar: { width: AWATAR, height: AWATAR, borderRadius: AWATAR / 2, alignItems: 'center', justifyContent: 'center' },
});

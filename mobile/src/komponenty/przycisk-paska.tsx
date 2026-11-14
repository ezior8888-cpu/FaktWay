/**
 * Przycisk z napisem w pasku u góry: Anuluj, Zamknij, Szkic, Zapisz, Wyślij.
 *
 * iOS: systemowy przycisk paska (`Stack.Toolbar.Button`), dokładnie jak przed
 * etapem M12.
 *
 * Android (M12, ZASADY-DESIGNU.md, sekcja 10): `Stack.Toolbar.Button` bez
 * ikony nic tam nie rysuje (expo-router 58, `StackToolbarButton/native.android`),
 * a przycisk po lewej zastępuje strzałkę wstecz. Dlatego zamknięcie to ikona X
 * po lewej, jak w pełnoekranowym formularzu Material, a akcja to napis w
 * kolorze marki po prawej. Oba z falą przy dotknięciu; systemowy przycisk
 * wstecz działa obok nich (`usePreventRemove` w formularzach pyta o zmiany).
 */
import { Stack } from 'expo-router';
import { Platform, Pressable, StyleSheet } from 'react-native';

import { Ikona } from '@/komponenty/ikona';
import { Tekst } from '@/komponenty/tekst';
import { useKolory } from '@/wyglad/kolory';
import { CEL_DOTYKU, ODSTEP } from '@/wyglad/odstepy';

type Props = {
  strona: 'lewa' | 'prawa';
  tytul: string;
  onPress: () => void;
  /** Główna akcja arkusza (na iOS `variant="done"`, pogrubiony napis). */
  glowny?: boolean;
  /** Ekran z gradientem: na Androidzie pasek jest niebieski, więc napis i ikona są białe. */
  naGradiencie?: boolean;
};

/** Cel dotyku na Androidzie: 48 dp (ZASADY-DESIGNU.md, sekcja 3). */
const CEL_ANDROID = CEL_DOTYKU + ODSTEP.xxs;

export function PrzyciskPaska({ strona, tytul, onPress, glowny, naGradiencie }: Props) {
  const kolory = useKolory();
  const placement = strona === 'lewa' ? 'left' : 'right';

  if (Platform.OS !== 'android') {
    return (
      <Stack.Toolbar placement={placement}>
        {glowny ? (
          <Stack.Toolbar.Button variant="done" onPress={onPress}>
            {tytul}
          </Stack.Toolbar.Button>
        ) : (
          <Stack.Toolbar.Button onPress={onPress}>{tytul}</Stack.Toolbar.Button>
        )}
      </Stack.Toolbar>
    );
  }

  const fala = { color: naGradiencie ? kolory.falaNaAkcencie : kolory.fala, borderless: true, radius: CEL_ANDROID / 2 };
  if (strona === 'lewa') {
    return (
      <Stack.Toolbar placement="left" asChild>
        <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={tytul} android_ripple={fala} style={styles.ikona}>
          <Ikona nazwa="close-line" rozmiar={24} kolor={naGradiencie ? kolory.naGradiencie : kolory.etykieta} />
        </Pressable>
      </Stack.Toolbar>
    );
  }
  return (
    <Stack.Toolbar placement="right" asChild>
      <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={tytul} android_ripple={fala} style={styles.napis}>
        <Tekst styl="callout" waga={glowny ? 'semibold' : 'medium'} style={{ color: naGradiencie ? kolory.naGradiencie : kolory.akcent }} numberOfLines={1} maxFontSizeMultiplier={1.4}>
          {tytul}
        </Tekst>
      </Pressable>
    </Stack.Toolbar>
  );
}

const styles = StyleSheet.create({
  ikona: { width: CEL_ANDROID, height: CEL_ANDROID, alignItems: 'center', justifyContent: 'center' },
  napis: { minWidth: CEL_ANDROID, minHeight: CEL_ANDROID, paddingHorizontal: ODSTEP.s, alignItems: 'center', justifyContent: 'center' },
});

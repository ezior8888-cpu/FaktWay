/**
 * Potwierdzenie akcji niszczącej w systemowym arkuszu akcji, nie w oknie na
 * środku ekranu (ZASADY-DESIGNU.md, sekcja 2; WZORCE-MOBBIN.md 8.6). Na
 * Androidzie zostaje systemowe okno z tymi samymi przyciskami. Jedno miejsce
 * zamiast osobnych `Alert.alert` w każdym ekranie.
 */
import { ActionSheetIOS, Alert, Platform } from 'react-native';

type Opcje = {
  tytul: string;
  /** Jedno zdanie: co się stanie po potwierdzeniu. */
  opis?: string;
  /** Napis przycisku potwierdzenia, np. „Usuń wydatek”. */
  potwierdz: string;
  anuluj?: string;
};

export function potwierdz({ tytul, opis, potwierdz: tak, anuluj = 'Anuluj' }: Opcje, onTak: () => void): void {
  if (Platform.OS === 'ios') {
    ActionSheetIOS.showActionSheetWithOptions(
      { title: tytul, message: opis, options: [tak, anuluj], destructiveButtonIndex: 0, cancelButtonIndex: 1 },
      (i) => {
        if (i === 0) onTak();
      },
    );
    return;
  }
  Alert.alert(tytul, opis, [
    { text: anuluj, style: 'cancel' },
    { text: tak, style: 'destructive', onPress: onTak },
  ]);
}

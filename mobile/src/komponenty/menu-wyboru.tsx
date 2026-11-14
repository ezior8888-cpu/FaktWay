/**
 * Lista opcji pola wyboru na Androidzie: menu Material pod polem
 * (`menu-wyboru.android.tsx`, etap M12). Na iOS `PoleWyboru` otwiera arkusz
 * akcji i tego komponentu nie używa; ten plik daje tylko typy i pusty zapas
 * dla innych platform, żeby Compose z `@expo/ui/jetpack-compose` nie trafiał
 * do pakietu iOS.
 */
import type { StyleProp, TextStyle, ViewStyle } from 'react-native';

export type OpcjaMenu<T extends string> = { wartosc: T; etykieta: string };

export type MenuWyboruProps<T extends string> = {
  etykieta: string;
  wartosc: T;
  opcje: OpcjaMenu<T>[];
  onZmiana: (wartosc: T) => void;
  /** Ramka pola jak na stronie (obwódka, rogi, tło), ta sama co na iOS. */
  stylPola: StyleProp<ViewStyle>;
  stylTekstu: StyleProp<TextStyle>;
};

export function MenuWyboru<T extends string>(_props: MenuWyboruProps<T>) {
  return null;
}

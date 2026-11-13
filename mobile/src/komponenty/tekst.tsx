import { Text, type TextProps } from 'react-native';

import { useKolory, type Kolory } from '@/wyglad/kolory';
import { RAMPA, stylTekstu, type StylTekstu, type Waga } from '@/wyglad/typografia';

type Props = TextProps & {
  /** Styl ze skali (`typografia.ts`); domyślnie Body. */
  styl?: StylTekstu;
  /** Kolor semantyczny; domyślnie etykieta główna. */
  kolor?: keyof Kolory;
  /** Liczby, kwoty, numery, NIP-y i daty: cyfry tabelaryczne Outfit (D15), kolumny się nie rozjeżdżają. */
  cyfry?: boolean;
  /** Skrót dla `waga="semibold"` (np. kwota w wierszu). */
  pogrubiony?: boolean;
  /** Waga czcionki; domyślnie waga stylu. */
  waga?: Waga;
};

/**
 * Jedyny komponent tekstu w aplikacji. Pilnuje czcionki FaktWay (Outfit z
 * cyframi tabelarycznymi w liczbach), skali stylów, Dynamic Type i kolorów semantycznych
 * (docs/mobile/ZASADY-DESIGNU.md, sekcja 3).
 */
export function Tekst({ styl = 'body', kolor = 'etykieta', cyfry, pogrubiony, waga, style, ...reszta }: Props) {
  const kolory = useKolory();
  return (
    <Text
      dynamicTypeRamp={RAMPA[styl]}
      style={[stylTekstu(styl, { cyfry, waga: waga ?? (pogrubiony ? 'semibold' : undefined) }), { color: kolory[kolor] }, style]}
      {...reszta}
    />
  );
}

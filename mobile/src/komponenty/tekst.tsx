import { Text, type TextProps } from 'react-native';

import { useKolory, type Kolory } from '@/wyglad/kolory';
import { RAMPA, STYLE_TEKSTU, type StylTekstu } from '@/wyglad/typografia';

type Props = TextProps & {
  /** Systemowy styl tekstu; domyślnie Body. */
  styl?: StylTekstu;
  /** Kolor semantyczny; domyślnie etykieta główna. */
  kolor?: keyof Kolory;
  /** Cyfry o stałej szerokości: kwoty i liczby w kolumnach. */
  cyfry?: boolean;
  /** Pogrubienie wewnątrz stylu (np. kwota w wierszu). */
  pogrubiony?: boolean;
};

/**
 * Jedyny komponent tekstu w aplikacji. Pilnuje skali stylów, Dynamic Type
 * i kolorów semantycznych (docs/mobile/ZASADY-DESIGNU.md, sekcja 3).
 */
export function Tekst({ styl = 'body', kolor = 'etykieta', cyfry, pogrubiony, style, ...reszta }: Props) {
  const kolory = useKolory();
  return (
    <Text
      dynamicTypeRamp={RAMPA[styl]}
      style={[
        STYLE_TEKSTU[styl],
        { color: kolory[kolor] },
        cyfry ? { fontVariant: ['tabular-nums'] } : null,
        pogrubiony ? { fontWeight: '600' } : null,
        style,
      ]}
      {...reszta}
    />
  );
}

/**
 * Ikony przycisków w pasku u góry ekranu (filtr, kalendarz, udostępnij, więcej):
 * te same ikony Remix co na stronie, jako obrazy szablonowe, które system
 * barwi kolorem `tintColor`. Pliki rysuje `scripts/ikony-remix.cjs` z tych
 * samych kształtów co `komponenty/ikony-remix.ts` (22 pt, @2x i @3x).
 * Pozycje menu systemowego zostają z ikonami SF: menu iOS przyjmuje tylko je.
 */
import type { ImageSourcePropType } from 'react-native';

export const IKONY_PASKA: Record<'kalendarz' | 'filtr' | 'udostepnij' | 'wiecej', ImageSourcePropType> = {
  kalendarz: require('../../assets/pasek/kalendarz.png'),
  filtr: require('../../assets/pasek/filtr.png'),
  udostepnij: require('../../assets/pasek/udostepnij.png'),
  wiecej: require('../../assets/pasek/wiecej.png'),
};

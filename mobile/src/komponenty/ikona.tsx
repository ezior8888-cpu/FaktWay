/**
 * Ikony Remix, te same co w wersji na komputer (plan aplikacji, D12).
 * `Ikona` to sam kształt; `KoloIkony` to okrągła ikona na tle 10% koloru,
 * jak `Avatar` z ikoną w kartach pulpitu strony (`statistics-card-03.tsx`).
 */
import { View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { kolorTonu, useKolory, type Ton } from '@/wyglad/kolory';
import { KOLO_IKONY } from '@/wyglad/odstepy';

import { IKONY, type NazwaIkony } from './ikony-remix';

export type { NazwaIkony };

type IkonaProps = { nazwa: NazwaIkony; rozmiar?: number; kolor: string };

export function Ikona({ nazwa, rozmiar = 20, kolor }: IkonaProps) {
  return (
    <Svg width={rozmiar} height={rozmiar} viewBox="0 0 24 24" pointerEvents="none">
      {IKONY[nazwa].map((d) => (
        <Path key={d} d={d} fill={kolor} />
      ))}
    </Svg>
  );
}

type KoloProps = { nazwa: NazwaIkony; ton?: Ton; rozmiar?: number };

/** Okrągła ikona: kolor marki (albo tonu) na jego 10% tle. */
export function KoloIkony({ nazwa, ton = 'marka', rozmiar = KOLO_IKONY }: KoloProps) {
  const kolory = useKolory();
  const { tlo, tekst } = kolorTonu(kolory, ton);
  return (
    <View
      style={{ width: rozmiar, height: rozmiar, borderRadius: rozmiar / 2, backgroundColor: tlo, alignItems: 'center', justifyContent: 'center' }}
      importantForAccessibility="no-hide-descendants">
      {/* Na stronie ikona marki ma kolor `primary`, a tekst plakietki `accent-foreground`. */}
      <Ikona nazwa={nazwa} rozmiar={Math.round(rozmiar * 0.5)} kolor={ton === 'marka' ? kolory.akcent : tekst} />
    </View>
  );
}

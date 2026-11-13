/**
 * Logo FaktWay z tej samej geometrii co strona i zestaw logo
 * (`lib/brand/faktway-logo-paths.ts`, `docs/brand/logo/README.md`).
 * W jasnym motywie niebieski znak i granatowy napis, w ciemnym odchudzona
 * wersja na ciemne tło (jasnoniebieski znak, biały napis); na niebieskim tle
 * (gradient pod nagłówkiem, D15) wersja biała `faktway-logo-biale.svg`. Nie
 * przekolorowujemy wersji podstawowej (README logo, „Wersje”).
 */
import { useColorScheme } from 'react-native';
import Svg, { G, Path } from 'react-native-svg';

const NIEBIESKI = '#2463EF';
const GRANAT = '#0D1936';
const JASNY_NIEBIESKI = '#61A4F7';
const BIALY = '#FFFFFF';

type Props = {
  wysokosc?: number;
  /** Na niebieskim tle: cała biała, odchudzona wersja z zestawu logo. */
  biale?: boolean;
};

/** Logo poziome: znak i napis (pole ochronne zostawia rodzic). */
export function LogoFaktWay({ wysokosc = 22, biale }: Props) {
  const ciemny = useColorScheme() === 'dark';
  if (biale) {
    return (
      <Svg
        width={(wysokosc * SZEROKOSC_BIALE) / WYSOKOSC}
        height={wysokosc}
        viewBox={`0 0 ${SZEROKOSC_BIALE} ${WYSOKOSC}`}
        accessible
        accessibilityRole="image"
        accessibilityLabel="FaktWay">
        <Path d={ZNAK_BIALE} fill={BIALY} />
        <G transform={NAPIS_BIALE_TRANSFORM}>
          <Path d={NAPIS_CIEMNE} fill={BIALY} />
        </G>
      </Svg>
    );
  }
  return (
    <Svg
      width={(wysokosc * SZEROKOSC) / WYSOKOSC}
      height={wysokosc}
      viewBox={`0 0 ${SZEROKOSC} ${WYSOKOSC}`}
      accessible
      accessibilityRole="image"
      accessibilityLabel="FaktWay">
      <Path d={ciemny ? ZNAK_CIEMNE : ZNAK_JASNE} fill={ciemny ? JASNY_NIEBIESKI : NIEBIESKI} />
      <G transform={NAPIS_TRANSFORM}>
        <Path d={ciemny ? NAPIS_CIEMNE : NAPIS_JASNE} fill={ciemny ? BIALY : GRANAT} />
      </G>
    </Svg>
  );
}

// Kopia LOCKUP z lib/brand/faktway-logo-paths.ts (tam plik generowany z
// docs/brand/logo/zrodla/aplikacja.py). Po zmianie logo skopiuj ścieżki ponownie.
const SZEROKOSC = 814;
const WYSOKOSC = 180;
const ZNAK_JASNE = 'M40 80 A80 80 0 0 1 200 80 Z M160 100 A80 80 0 0 1 0 100 Z';
const ZNAK_CIEMNE = 'M40.91 79.09 A79.09 79.09 0 0 1 199.09 79.09 Z M159.09 100.91 A79.09 79.09 0 0 1 0.91 100.91 Z';
const NAPIS_TRANSFORM = 'translate(260 -2.8571) scale(0.7143)';
const NAPIS_JASNE =
  'M0 60 L22 60 L22 200 L0 200 Z M22 60 L80 60 L80 80 L22 80 Z M22 117 L72 117 L72 137 L22 137 Z M82 148 A54 54 0 1 1 190 148 A54 54 0 1 1 82 148 Z M105 148 A31 33 0 1 0 167 148 A31 33 0 1 0 105 148 Z M168 96 L190 96 L190 200 L168 200 Z M205 52 L227 52 L227 200 L205 200 Z M216 147.04 L255.7 96 L282.3 96 L216 181.25 Z M250.82 121.62 L288.66 200 L265.34 200 L235.1 137.34 Z M317 70 L339 70 L339 200 L317 200 Z M299 96 L361 96 L361 116 L299 116 Z M389.68 60 L427.19 200 L405.45 200 L367.94 60 Z M470.06 60 L432.55 200 L410.81 200 L448.32 60 Z M475.42 60 L512.93 200 L491.19 200 L453.68 60 Z M555.81 60 L518.29 200 L496.55 200 L534.07 60 Z M556.94 148 A54 54 0 1 1 664.94 148 A54 54 0 1 1 556.94 148 Z M579.94 148 A31 33 0 1 0 641.94 148 A31 33 0 1 0 579.94 148 Z M642.94 96 L664.94 96 L664.94 200 L642.94 200 Z M692.25 96 L727.59 183.92 L716.28 212.08 L669.62 96 Z M774.25 96 L713.96 246 L691.33 246 L751.62 96 Z';
const NAPIS_CIEMNE =
  'M0 60 L21.4 60 L21.4 200 L0 200 Z M21.4 60 L80 60 L80 79.4 L21.4 79.4 Z M21.4 117 L72 117 L72 136.4 L21.4 136.4 Z M82 148 A54 54 0 1 1 190 148 A54 54 0 1 1 82 148 Z M104.4 148 A31.6 33.6 0 1 0 167.6 148 A31.6 33.6 0 1 0 104.4 148 Z M168.6 96 L190 96 L190 200 L168.6 200 Z M205 52 L226.4 52 L226.4 200 L205 200 Z M215.7 147.09 L256.01 96 L281.99 96 L215.7 180.03 Z M250.22 121.85 L288.35 200 L265.65 200 L234.96 137.11 Z M317 70 L338.4 70 L338.4 200 L317 200 Z M299 96 L360.4 96 L360.4 115.4 L299 115.4 Z M388.77 60 L426.28 200 L405.16 200 L367.65 60 Z M469.15 60 L431.64 200 L410.52 200 L448.03 60 Z M474.51 60 L512.02 200 L490.9 200 L453.39 60 Z M554.9 60 L517.38 200 L496.26 200 L533.78 60 Z M556.34 148 A54 54 0 1 1 664.34 148 A54 54 0 1 1 556.34 148 Z M578.74 148 A31.6 33.6 0 1 0 641.94 148 A31.6 33.6 0 1 0 578.74 148 Z M642.94 96 L664.34 96 L664.34 200 L642.94 200 Z M691.33 96 L726.83 184.33 L715.84 211.67 L669.34 96 Z M773.33 96 L713.04 246 L691.05 246 L751.34 96 Z';

// Wersja biała (`docs/brand/logo/zestaw/svg/faktway-logo-biale.svg`): ten sam
// odchudzony napis co wersja na ciemne tło, inny znak i szerokość 811.
const SZEROKOSC_BIALE = 811;
const ZNAK_BIALE = 'M40 79.09 A79.09 79.09 0 0 1 198.18 79.09 Z M158.18 100.91 A79.09 79.09 0 0 1 0 100.91 Z';
const NAPIS_BIALE_TRANSFORM = 'translate(258.1818 -2.8571) scale(0.7143)';

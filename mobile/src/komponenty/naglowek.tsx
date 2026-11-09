/**
 * Nagłówek ekranu z najważniejszą liczbą (kwota faktury, suma do zapłaty):
 * podpis, duża kwota, linia statusu. Jeden wzór na wszystkich ekranach.
 */
import { StyleSheet, View } from 'react-native';

import { Tekst } from '@/komponenty/tekst';
import type { Kolory } from '@/wyglad/kolory';
import type { StylTekstu } from '@/wyglad/typografia';
import { MARGINES, ODSTEP } from '@/wyglad/odstepy';

type Props = {
  podpis?: string;
  /** Podpis wyróżniony (np. nazwa kontrahenta nad kwotą faktury). */
  podpisWyrozniony?: boolean;
  wartosc: string;
  /** Rozmiar wartości: kwota faktury `largeTitle`, podsumowanie listy `title1`. */
  styl?: Extract<StylTekstu, 'largeTitle' | 'title1'>;
  status?: string;
  statusKolor?: keyof Kolory;
};

export function NaglowekKwoty({ podpis, podpisWyrozniony, wartosc, styl = 'largeTitle', status, statusKolor = 'etykietaDrugorzedna' }: Props) {
  return (
    <View style={styles.naglowek} accessible accessibilityLabel={[podpis, wartosc, status].filter(Boolean).join(', ')}>
      {podpis ? (
        <Tekst styl={podpisWyrozniony ? 'headline' : 'subheadline'} kolor={podpisWyrozniony ? 'etykieta' : 'etykietaDrugorzedna'}>
          {podpis}
        </Tekst>
      ) : null}
      <Tekst styl={styl} cyfry selectable>
        {wartosc}
      </Tekst>
      {status ? (
        <Tekst styl="subheadline" kolor={statusKolor}>
          {status}
        </Tekst>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  naglowek: { paddingHorizontal: MARGINES + ODSTEP.xxs, paddingTop: ODSTEP.xs, gap: ODSTEP.linia },
});

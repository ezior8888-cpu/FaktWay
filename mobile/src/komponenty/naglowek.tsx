/**
 * Nagłówek ekranu z najważniejszą liczbą (kwota faktury, suma do zapłaty):
 * podpis, duża kwota w IBM Plex Mono, status. Status z kolorem oceny
 * (sukces, ostrzeżenie, błąd) jest plakietką, jak na stronie.
 */
import { StyleSheet, View } from 'react-native';

import { Tekst } from '@/komponenty/tekst';
import { Znacznik } from '@/komponenty/znacznik';
import { tonKoloru, type Kolory } from '@/wyglad/kolory';
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

const TONY: (keyof Kolory)[] = ['sukces', 'ostrzezenie', 'blad', 'info'];

export function NaglowekKwoty({ podpis, podpisWyrozniony, wartosc, styl = 'largeTitle', status, statusKolor = 'etykietaDrugorzedna' }: Props) {
  return (
    <View style={styles.naglowek} accessible accessibilityLabel={[podpis, wartosc, status].filter(Boolean).join(', ')}>
      {podpis ? (
        <Tekst styl={podpisWyrozniony ? 'headline' : 'subheadline'} kolor={podpisWyrozniony ? 'etykieta' : 'etykietaDrugorzedna'}>
          {podpis}
        </Tekst>
      ) : null}
      {/* Kwota w IBM Plex Mono; nagłówek słowny (np. „Skonfigurowano połączenie”) w Outfit. */}
      <Tekst styl={styl} cyfry={/\d/.test(wartosc)} selectable>
        {wartosc}
      </Tekst>
      {status ? (
        TONY.includes(statusKolor) ? (
          <View style={styles.status}>
            <Znacznik ton={tonKoloru(statusKolor)}>{status}</Znacznik>
          </View>
        ) : (
          <Tekst styl="subheadline" kolor={statusKolor}>
            {status}
          </Tekst>
        )
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  naglowek: { paddingHorizontal: MARGINES + ODSTEP.xxs, paddingTop: ODSTEP.xs, gap: ODSTEP.xxs },
  status: { paddingTop: ODSTEP.linia },
});

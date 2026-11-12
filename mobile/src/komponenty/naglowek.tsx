/**
 * Nagłówek ekranu z najważniejszą liczbą (kwota faktury, suma do zapłaty) jako
 * pierwsza karta ekranu, która nachodzi na gradient pod nagłówkiem (plan
 * aplikacji, D15; ZASADY-DESIGNU.md, sekcja 4). Podpis, duża kwota z groszami
 * w indeksie górnym, status; status z kolorem oceny (sukces, ostrzeżenie, błąd)
 * jest plakietką, jak na stronie.
 */
import { StyleSheet, View } from 'react-native';

import { Karta } from '@/komponenty/karta';
import { Tekst } from '@/komponenty/tekst';
import { Znacznik } from '@/komponenty/znacznik';
import { tonKoloru, type Kolory } from '@/wyglad/kolory';
import type { StylTekstu } from '@/wyglad/typografia';
import { MARGINES, ODSTEP } from '@/wyglad/odstepy';

type StylKwoty = Extract<StylTekstu, 'largeTitle' | 'title1'>;

type Props = {
  podpis?: string;
  /** Podpis wyróżniony (np. nazwa kontrahenta nad kwotą faktury). */
  podpisWyrozniony?: boolean;
  wartosc: string;
  /** Rozmiar wartości: kwota faktury `largeTitle`, podsumowanie listy `title1`. */
  styl?: StylKwoty;
  status?: string;
  statusKolor?: keyof Kolory;
};

const TONY: (keyof Kolory)[] = ['sukces', 'ostrzezenie', 'blad', 'info'];

export function NaglowekKwoty({ podpis, podpisWyrozniony, wartosc, styl = 'largeTitle', status, statusKolor = 'etykietaDrugorzedna' }: Props) {
  return (
    <Karta style={styles.karta}>
      <View style={styles.tresc} accessible accessibilityLabel={[podpis, wartosc, status].filter(Boolean).join(', ')}>
        {podpis ? (
          <Tekst styl={podpisWyrozniony ? 'headline' : 'subheadline'} kolor={podpisWyrozniony ? 'etykieta' : 'etykietaDrugorzedna'}>
            {podpis}
          </Tekst>
        ) : null}
        <KwotaZGroszami wartosc={wartosc} styl={styl} />
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
    </Karta>
  );
}

/** „23 280,00 zł”: część złotych, grosze, waluta. Inny tekst (np. „Połączone”) zostaje jak jest. */
const KWOTA = /^(.*\d),(\d{2})(\s*zł)$/u;

/** Grosze o połowę mniejsze: styl ze skali o mniej więcej połowie rozmiaru kwoty. */
const STYL_GROSZY: Record<StylKwoty, StylTekstu> = { largeTitle: 'callout', title1: 'footnote' };

/**
 * Duża kwota z groszami w indeksie górnym i bez przecinka: „23 280⁰⁰ zł”
 * (D15, ZASADY-DESIGNU.md, sekcja 3). Czytnik ekranu dostaje pełną kwotę z
 * etykiety nagłówka. W wierszach list i polach grosze zostają po przecinku.
 */
export function KwotaZGroszami({ wartosc, styl }: { wartosc: string; styl: StylKwoty }) {
  const czesci = KWOTA.exec(wartosc);
  if (!czesci) {
    return (
      <Tekst styl={styl} cyfry={/\d/.test(wartosc)} selectable>
        {wartosc}
      </Tekst>
    );
  }
  const [, zlote, grosze, waluta] = czesci;
  return (
    <View style={styles.kwota}>
      <Tekst styl={styl} cyfry>
        {zlote}
      </Tekst>
      <Tekst styl={STYL_GROSZY[styl]} waga="semibold" cyfry style={styles.grosze}>
        {grosze}
      </Tekst>
      <Tekst styl={styl}>{waluta}</Tekst>
    </View>
  );
}

const styles = StyleSheet.create({
  karta: { marginTop: ODSTEP.s },
  tresc: { paddingHorizontal: MARGINES, paddingVertical: ODSTEP.m - 2, gap: ODSTEP.xxs },
  kwota: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start' },
  grosze: { marginTop: ODSTEP.xxs, marginLeft: ODSTEP.linia },
  status: { paddingTop: ODSTEP.linia },
});

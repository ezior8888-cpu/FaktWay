/**
 * Karta wyniku miesiąca na Pulpicie, jak w Copilocie (plan aplikacji, D14;
 * makieta z 12.11.2026): wyśrodkowana duża kwota z groszami w indeksie,
 * wykres narastająco od początku miesiąca z przerywaną linią średniego
 * miesiąca i plakietką różnicy przy końcu linii, a pod spodem rząd trzech
 * liczb. Zastępuje kafle, żeby zadania były widać bez przewijania.
 */
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Circle, Defs, LinearGradient, Line, Path, Stop } from 'react-native-svg';

import { Karta } from '@/komponenty/karta';
import { KwotaZGroszami } from '@/komponenty/naglowek';
import { RzadLiczb, type Liczba } from '@/komponenty/rzad-liczb';
import { Tekst } from '@/komponenty/tekst';
import { Znacznik } from '@/komponenty/znacznik';
import { kwota } from '@/lib/format';
import { useKolory } from '@/wyglad/kolory';
import { MARGINES, ODSTEP } from '@/wyglad/odstepy';

const WYSOKOSC = 88;
const MARGINES_WYKRESU = 6;

type Props = {
  podpis: string;
  /** Wynik od początku miesiąca w groszach. */
  wynik: number;
  /** Zdanie pod kwotą, np. „średnio 16 650,00 zł miesięcznie”. */
  opis: string;
  /** Wynik narastająco na koniec kolejnych dni miesiąca (od 1. do dziś), w groszach. */
  narastajaco: number[];
  dniWMiesiacu: number;
  /** Średni wynik całego miesiąca w groszach: przerywana linia od zera do końca miesiąca. */
  sredniMiesiac: number;
  /** Podpisy osi: pierwszy i ostatni dzień miesiąca. */
  od: string;
  do: string;
  liczby: Liczba[];
};

export function KartaWyniku({ podpis, wynik, opis, narastajaco, dniWMiesiacu, sredniMiesiac, od, do: doDnia, liczby }: Props) {
  const kolory = useKolory();
  const [szerokosc, setSzerokosc] = useState(0);
  const dzis = narastajaco.length;
  const tempoDzis = Math.round((sredniMiesiac * dzis) / dniWMiesiacu);
  const roznica = wynik - tempoDzis;
  const plakietka = `${roznica >= 0 ? '+' : '−'}${kwota(Math.abs(roznica))} wobec średniej`;

  const punkty = [0, ...narastajaco];
  const maks = Math.max(sredniMiesiac, ...punkty, 1) * 1.08;
  const x = (dzien: number) => MARGINES_WYKRESU + (dzien / dniWMiesiacu) * (szerokosc - 2 * MARGINES_WYKRESU);
  const y = (v: number) => WYSOKOSC - MARGINES_WYKRESU - (Math.max(0, v) / maks) * (WYSOKOSC - 2 * MARGINES_WYKRESU);
  const linia = punkty.map((v, d) => `${d === 0 ? 'M' : 'L'}${x(d).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  const pole = `${linia} L${x(dzis).toFixed(1)} ${WYSOKOSC} L${x(0).toFixed(1)} ${WYSOKOSC} Z`;
  const koniecX = x(dzis);
  const koniecY = y(punkty[dzis] ?? 0);
  // Plakietka obok końca linii; za połową szerokości stoi po jego lewej stronie.
  const plakietkaPoLewej = koniecX > szerokosc * 0.55;

  return (
    <Karta style={styles.karta}>
      <View style={styles.tresc}>
        <View style={styles.naglowek} accessible accessibilityLabel={`${podpis}: ${kwota(wynik)}. ${opis}. ${plakietka}.`}>
          <Tekst styl="subheadline" kolor="etykietaDrugorzedna">
            {podpis}
          </Tekst>
          <KwotaZGroszami wartosc={kwota(wynik)} styl="largeTitle" />
          <Tekst styl="subheadline" kolor="etykietaDrugorzedna" style={styles.srodek}>
            {opis}
          </Tekst>
        </View>

        <View style={styles.wykres} onLayout={(e) => setSzerokosc(e.nativeEvent.layout.width)} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          {szerokosc > 0 ? (
            <>
              <Svg width={szerokosc} height={WYSOKOSC}>
                <Defs>
                  <LinearGradient id="pole-wyniku" x1="0" y1="0" x2="0" y2="1">
                    <Stop offset={0} stopColor={kolory.akcent} stopOpacity={0.22} />
                    <Stop offset={1} stopColor={kolory.akcent} stopOpacity={0} />
                  </LinearGradient>
                </Defs>
                <Line x1={x(0)} y1={y(0)} x2={x(dniWMiesiacu)} y2={y(sredniMiesiac)} stroke={kolory.etykietaTrzeciorzedna} strokeWidth={1.5} strokeDasharray="3 5" />
                <Path d={pole} fill="url(#pole-wyniku)" />
                <Path d={linia} stroke={kolory.akcent} strokeWidth={3} fill="none" strokeLinejoin="round" strokeLinecap="round" />
                <Circle cx={koniecX} cy={koniecY} r={5.5} fill={kolory.tloKomorki} stroke={kolory.akcent} strokeWidth={3} />
              </Svg>
              <View
                style={[
                  styles.plakietka,
                  { top: Math.max(0, koniecY - 12) },
                  plakietkaPoLewej ? { right: szerokosc - koniecX + ODSTEP.s } : { left: koniecX + ODSTEP.s },
                ]}>
                <Znacznik ton={roznica >= 0 ? 'sukces' : 'blad'}>{plakietka}</Znacznik>
              </View>
            </>
          ) : null}
        </View>
        <View style={styles.os}>
          <Tekst styl="caption2" kolor="etykietaDrugorzedna">
            {od}
          </Tekst>
          <Tekst styl="caption2" kolor="etykietaDrugorzedna" style={styles.legenda} numberOfLines={1}>
            przerywana: średni miesiąc
          </Tekst>
          <Tekst styl="caption2" kolor="etykietaDrugorzedna">
            {doDnia}
          </Tekst>
        </View>

        <View style={[styles.separator, { backgroundColor: kolory.separator }]} />
        <RzadLiczb liczby={liczby} />
      </View>
    </Karta>
  );
}

const styles = StyleSheet.create({
  karta: { marginTop: ODSTEP.s },
  tresc: { padding: MARGINES, gap: ODSTEP.xs },
  naglowek: { alignItems: 'center', gap: ODSTEP.linia },
  srodek: { textAlign: 'center' },
  wykres: { height: WYSOKOSC, marginTop: ODSTEP.xs },
  plakietka: { position: 'absolute' },
  os: { flexDirection: 'row', justifyContent: 'space-between', gap: ODSTEP.xs },
  legenda: { flexShrink: 1, textAlign: 'center' },
  separator: { height: StyleSheet.hairlineWidth, marginVertical: ODSTEP.xs },
});

/**
 * Historia dokumentu jako oś: kroki od wystawienia do zapłaty, każdy z
 * opisem (WZORCE-MOBBIN.md 3.3; wzór Revolut Business i Remote). Krok
 * zrobiony ma zielony znacznik, trwający kręci się, czekający jest pustym
 * kółkiem, błąd czerwony. Status zawsze ma też słowo, nie tylko kolor.
 */
import { StyleSheet, View } from 'react-native';

import { Ikona } from '@/komponenty/ikona';
import { Tekst } from '@/komponenty/tekst';
import { Znacznik } from '@/komponenty/znacznik';
import { useKolory } from '@/wyglad/kolory';
import { MARGINES, ODSTEP } from '@/wyglad/odstepy';

export type Krok = { tytul: string; opis?: string; stan: 'zrobione' | 'trwa' | 'czeka' | 'blad' };

const ROZMIAR = 22;

export function OsStatusu({ kroki }: { kroki: Krok[] }) {
  const kolory = useKolory();
  return (
    <View style={styles.os}>
      {kroki.map((k, i) => {
        const ostatni = i === kroki.length - 1;
        return (
          <View key={k.tytul} style={styles.krok} accessible accessibilityLabel={`${k.tytul}${k.opis ? `, ${k.opis}` : ''}, ${OPIS_STANU[k.stan]}`}>
            <View style={styles.punkt}>
              {k.stan === 'zrobione' ? (
                <Ikona nazwa="checkbox-circle-fill" rozmiar={ROZMIAR} kolor={kolory.sukces} />
              ) : k.stan === 'blad' ? (
                <Ikona nazwa="alert-fill" rozmiar={ROZMIAR} kolor={kolory.blad} />
              ) : k.stan === 'trwa' ? (
                <Ikona nazwa="loader4-line" rozmiar={ROZMIAR} kolor={kolory.akcent} />
              ) : (
                <View style={[styles.puste, { borderColor: kolory.etykietaTrzeciorzedna }]} />
              )}
              {ostatni ? null : <View style={[styles.linia, { backgroundColor: k.stan === 'zrobione' ? kolory.sukces : kolory.obwodka }]} />}
            </View>
            <View style={[styles.tresc, ostatni ? null : styles.trescOdstep]}>
              <Tekst styl="callout" waga="medium" kolor={k.stan === 'blad' ? 'blad' : 'etykieta'}>
                {k.tytul}
              </Tekst>
              {k.opis ? (
                <Tekst styl="footnote" kolor="etykietaDrugorzedna" selectable>
                  {k.opis}
                </Tekst>
              ) : null}
              {k.stan === 'trwa' ? (
                <View style={styles.trwa}>
                  <Znacznik ton="info" trwa>
                    Trwa
                  </Znacznik>
                </View>
              ) : null}
            </View>
          </View>
        );
      })}
    </View>
  );
}

const OPIS_STANU: Record<Krok['stan'], string> = { zrobione: 'zrobione', trwa: 'trwa', czeka: 'czeka', blad: 'błąd' };

const styles = StyleSheet.create({
  os: { paddingHorizontal: MARGINES, paddingVertical: ODSTEP.m },
  krok: { flexDirection: 'row', gap: ODSTEP.s },
  punkt: { width: ROZMIAR, alignItems: 'center' },
  puste: { width: ROZMIAR - 6, height: ROZMIAR - 6, borderRadius: ROZMIAR, borderWidth: 2, marginTop: 3 },
  linia: { flex: 1, width: 2, marginVertical: ODSTEP.linia, minHeight: ODSTEP.s },
  tresc: { flex: 1, gap: ODSTEP.linia },
  trescOdstep: { paddingBottom: ODSTEP.m },
  trwa: { paddingTop: ODSTEP.xxs },
});

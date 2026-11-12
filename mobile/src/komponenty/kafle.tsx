/**
 * Kafle wskaźników po dwa w rzędzie, jak karty statystyk pulpitu strony
 * (`components/dashboard/finora/statistics-card-03.tsx`): okrągła ikona,
 * zmiana procentowa ze strzałką, liczba, podpis i plakietka na dole.
 * Dotknięcie kafla prowadzi do szczegółu (jeśli jest dokąd).
 */
import { StyleSheet, useWindowDimensions, View } from 'react-native';

import { Dotyk } from '@/komponenty/dotyk';
import { Ikona, KoloIkony, type NazwaIkony } from '@/komponenty/ikona';
import { useStylKarty } from '@/komponenty/karta';
import { Tekst } from '@/komponenty/tekst';
import { Znacznik } from '@/komponenty/znacznik';
import { zmiana as tekstZmiany } from '@/lib/format';
import { tonKoloru, useKolory, type Kolory } from '@/wyglad/kolory';
import { MARGINES, ODSTEP, SKALA_PIONOWA } from '@/wyglad/odstepy';

export type Kafel = {
  klucz: string;
  podpis: string;
  wartosc: string;
  /** Plakietka na dole kafla (np. „Ten miesiąc”, „2 czeka na sprawdzenie”). */
  opis?: string;
  /** Ton plakietki; bez niego plakietka ma kolor marki. */
  opisKolor?: keyof Kolory;
  /** Okrągła ikona: od D15 tylko w kolorze stanu (`ikonaKolor` sukces, ostrzeżenie, błąd), ozdobne nie rysują się. */
  ikona?: NazwaIkony;
  /** Ton okrągłej ikony (np. wpływy zielone, wydatki czerwone). */
  ikonaKolor?: keyof Kolory;
  /** Zmiana wobec poprzedniego okresu w procentach: w prawym górnym rogu ze strzałką. */
  zmiana?: number;
  onPress?: () => void;
};

/** Ikona w kaflu zostaje tylko wtedy, gdy mówi o stanie (D15). */
const TONY_STANU: (keyof Kolory)[] = ['sukces', 'ostrzezenie', 'blad'];

/** Opis dłuższy niż tyle znaków nie mieści się w plakietce połowy ekranu. */
const DLUGOSC_PLAKIETKI = 24;

export function Kafle({ kafle }: { kafle: Kafel[] }) {
  const { fontScale } = useWindowDimensions();
  // Przy dużym tekście z ustawień jeden kafel w rzędzie, żeby podpisy się nie ucinały.
  const duzyTekst = fontScale >= SKALA_PIONOWA;
  return (
    <View style={styles.siatka}>
      {kafle.map((k) => (
        <KafelWidok key={k.klucz} kafel={k} szeroki={duzyTekst} />
      ))}
    </View>
  );
}

function KafelWidok({ kafel: k, szeroki }: { kafel: Kafel; szeroki: boolean }) {
  const kolory = useKolory();
  const stylKarty = useStylKarty();
  const ikona = k.ikonaKolor && TONY_STANU.includes(k.ikonaKolor) ? k.ikona : undefined;
  const zmianaKolor: keyof Kolory = k.zmiana === undefined || k.zmiana === 0 ? 'etykietaDrugorzedna' : k.zmiana > 0 ? 'sukces' : 'blad';
  const etykieta = [k.podpis, k.wartosc, k.zmiana !== undefined ? `${tekstZmiany(k.zmiana)} wobec poprzedniego okresu` : null, k.opis]
    .filter(Boolean)
    .join(', ');
  return (
    <Dotyk
      onPress={k.onPress}
      disabled={!k.onPress}
      skala={0.98}
      accessibilityRole={k.onPress ? 'button' : undefined}
      accessibilityLabel={etykieta}
      style={[styles.kafel, szeroki && styles.kafelSzeroki, stylKarty]}>
      {ikona || k.zmiana !== undefined ? (
        <View style={styles.gora}>
          {ikona && k.ikonaKolor ? <KoloIkony nazwa={ikona} rozmiar={32} ton={tonKoloru(k.ikonaKolor)} /> : <View />}
          {k.zmiana !== undefined ? (
            <View style={styles.zmiana}>
              <Tekst styl="footnote" kolor={zmianaKolor} cyfry waga="medium">
                {tekstZmiany(k.zmiana)}
              </Tekst>
              {k.zmiana !== 0 ? <Ikona nazwa={k.zmiana > 0 ? 'arrow-up-s-line' : 'arrow-down-s-line'} rozmiar={16} kolor={kolory[zmianaKolor]} /> : null}
            </View>
          ) : null}
        </View>
      ) : null}
      <View style={styles.liczby}>
        {/* Liczby i kwoty cyframi tabelarycznymi, nazwy (np. „Biuro”, „Kowalczyk Studio”) zwykłymi. */}
        <Tekst styl="title2" cyfry={/\d/.test(k.wartosc)} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>
          {k.wartosc}
        </Tekst>
        <Tekst styl="footnote" kolor="etykietaDrugorzedna" numberOfLines={szeroki ? 4 : 2}>
          {k.podpis}
        </Tekst>
      </View>
      {k.opis ? (
        // Krótki opis to plakietka (jak na stronie), dłuższe zdanie zostaje zwykłym tekstem, żeby się nie ucinało.
        k.opis.length <= DLUGOSC_PLAKIETKI ? (
          <Znacznik ton={k.opisKolor ? tonKoloru(k.opisKolor) : 'marka'}>{k.opis}</Znacznik>
        ) : (
          <Tekst styl="caption1" kolor={k.opisKolor ?? 'etykietaDrugorzedna'}>
            {k.opis}
          </Tekst>
        )
      ) : null}
    </Dotyk>
  );
}

const styles = StyleSheet.create({
  siatka: { flexDirection: 'row', flexWrap: 'wrap', gap: ODSTEP.s, marginHorizontal: MARGINES, marginTop: ODSTEP.m },
  kafel: {
    flexBasis: '47%',
    flexGrow: 1,
    padding: ODSTEP.m - 2,
    gap: ODSTEP.s,
  },
  kafelSzeroki: { flexBasis: '100%' },
  gora: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  zmiana: { flexDirection: 'row', alignItems: 'center' },
  liczby: { gap: ODSTEP.linia },
});

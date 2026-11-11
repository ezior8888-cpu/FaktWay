/**
 * Karty i wiersze w stylu FaktWay (plan aplikacji, D12): płaska karta z cienką
 * obwódką i nagłówkiem w środku, jak `Card` strony (`components/ui/card.tsx`),
 * wiersze z linią na całą szerokość karty jak w tabelach strony, okrągłe
 * ikony Remix, liczby w IBM Plex Mono, statusy jako plakietki
 * (docs/mobile/ZASADY-DESIGNU.md, sekcja 5).
 */
import { Children, Fragment, isValidElement, type ReactElement, type ReactNode } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, useWindowDimensions, View, type ScrollViewProps } from 'react-native';

import { Ikona, KoloIkony, type NazwaIkony } from '@/komponenty/ikona';
import { Tekst } from '@/komponenty/tekst';
import { Znacznik } from '@/komponenty/znacznik';
import { tonKoloru, useKolory, type Kolory } from '@/wyglad/kolory';
import { CEL_DOTYKU, MARGINES, OBWODKA, ODSTEP, PROMIEN, SKALA_PIONOWA } from '@/wyglad/odstepy';

/**
 * Przewijany ekran na tle pod kartami. `contentInsetAdjustmentBehavior`
 * pozwala dużemu tytułowi zwijać się przy przewijaniu (Expo Router, Stack).
 */
export function EkranListy({ children, ...reszta }: ScrollViewProps & { children: ReactNode }) {
  const kolory = useKolory();
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      style={{ backgroundColor: kolory.tloGrupowane }}
      contentContainerStyle={styles.tresc}
      {...reszta}>
      {children}
    </ScrollView>
  );
}

type SekcjaProps = {
  /** Tytuł karty (w środku karty, jak `CardTitle` strony). */
  naglowek?: string;
  /** Opis pod tytułem (`CardDescription`). */
  opis?: string;
  /** Link po prawej stronie tytułu, np. „Wszystkie”. */
  naglowekAkcja?: { tytul: string; onPress: () => void };
  /** Dopisek na dole karty: wyjaśnienie, źródło liczb, błąd. */
  stopka?: string;
  /** Treść bez wierszy (wykres, kalendarz): w karcie, z marginesem wewnętrznym. */
  swobodna?: boolean;
  /** Treść bez karty (kafle mają własne karty): tytuł nad treścią. */
  bezKarty?: boolean;
  children?: ReactNode;
};

/** Pole formularza (etykieta nad polem) ma własne odstępy; linia dzieli tylko wiersze. */
type ZPolem = { pole?: boolean };

function jestPolem(el: ReactElement): boolean {
  return typeof el.type !== 'string' && (el.type as ZPolem).pole === true;
}

/** Dzieci z rozwiniętymi fragmentami (`<>...</>`), żeby linie szły między wszystkimi wierszami. */
function splaszcz(children: ReactNode): ReactElement[] {
  return Children.toArray(children)
    .filter(isValidElement)
    .flatMap((el) => (el.type === Fragment ? splaszcz((el as ReactElement<{ children?: ReactNode }>).props.children) : [el]));
}

export function Sekcja({ naglowek, opis, naglowekAkcja, stopka, swobodna, bezKarty, children }: SekcjaProps) {
  const kolory = useKolory();
  const elementy = splaszcz(children);
  const naglowekWidok = naglowek ? <NaglowekKarty tytul={naglowek} opis={opis} akcja={naglowekAkcja} /> : null;

  if (bezKarty) {
    return (
      <View style={styles.sekcja}>
        {naglowekWidok}
        {children}
        {stopka ? (
          <Tekst styl="footnote" kolor="etykietaDrugorzedna" style={styles.stopkaBezKarty}>
            {stopka}
          </Tekst>
        ) : null}
      </View>
    );
  }

  // Sam dopisek bez treści i tytułu: zwykły tekst pod poprzednią kartą.
  if (!naglowek && elementy.length === 0 && !swobodna) {
    return stopka ? (
      <Tekst styl="footnote" kolor="etykietaDrugorzedna" style={styles.samaStopka}>
        {stopka}
      </Tekst>
    ) : null;
  }

  const sameWiersze = !swobodna && elementy.length > 0 && !elementy.some(jestPolem);
  return (
    <View style={[styles.sekcja, styles.karta, { backgroundColor: kolory.tloKomorki, borderColor: kolory.obwodka }]}>
      {naglowekWidok}
      {naglowekWidok && sameWiersze ? <Linia kolor={kolory.separator} /> : null}
      {swobodna ? (
        <View style={[styles.swobodna, naglowek ? styles.swobodnaPodNaglowkiem : null]}>{children}</View>
      ) : (
        <View style={elementy.some(jestPolem) ? styles.zPolami : null}>
          {elementy.map((el, i) => {
            const poprzedni = elementy[i - 1];
            const linia = poprzedni !== undefined && !jestPolem(poprzedni) && !jestPolem(el);
            return (
              <Fragment key={el.key ?? i}>
                {linia ? <Linia kolor={kolory.separator} /> : null}
                {el}
              </Fragment>
            );
          })}
        </View>
      )}
      {stopka ? (
        <>
          {sameWiersze ? <Linia kolor={kolory.separator} /> : null}
          <Tekst styl="footnote" kolor="etykietaDrugorzedna" style={styles.stopka}>
            {stopka}
          </Tekst>
        </>
      ) : null}
    </View>
  );
}

function Linia({ kolor }: { kolor: string }) {
  return <View style={[styles.linia, { backgroundColor: kolor }]} />;
}

function NaglowekKarty({ tytul, opis, akcja }: { tytul: string; opis?: string; akcja?: { tytul: string; onPress: () => void } }) {
  const kolory = useKolory();
  return (
    <View style={styles.naglowekKarty}>
      <View style={styles.naglowekWiersz}>
        <Tekst styl="headline" accessibilityRole="header" style={styles.rozciagniety}>
          {tytul}
        </Tekst>
        {akcja ? (
          <Pressable onPress={akcja.onPress} hitSlop={ODSTEP.s} accessibilityRole="button" style={styles.akcjaNaglowka}>
            <Tekst styl="subheadline" kolor="akcent" waga="medium">
              {akcja.tytul}
            </Tekst>
            <Ikona nazwa="arrow-right-s-line" rozmiar={16} kolor={kolory.akcent} />
          </Pressable>
        ) : null}
      </View>
      {opis ? (
        <Tekst styl="footnote" kolor="etykietaDrugorzedna">
          {opis}
        </Tekst>
      ) : null}
    </View>
  );
}

type WierszProps = {
  tytul: string;
  podtytul?: string;
  wartosc?: string;
  /** Druga linia po prawej, pod wartością. Kolor statusu (sukces, ostrzeżenie, błąd) daje plakietkę. */
  wartoscPodpis?: string;
  wartoscPodpisKolor?: keyof Kolory;
  /** Kolor wartości (domyślnie główny przy podtytule, drugorzędny bez niego). */
  wartoscKolor?: keyof Kolory;
  /** Dane do skopiowania (NIP, numer KSeF): tekst da się zaznaczyć. */
  zaznaczalna?: boolean;
  /** Okrągła ikona Remix po lewej. */
  ikona?: NazwaIkony;
  /** Kolor okrągłej ikony (ton): domyślnie marka. */
  ikonaKolor?: keyof Kolory;
  /** Strzałka w prawo: wiersz prowadzi do kolejnego ekranu. */
  strzalka?: boolean;
  /** Znacznik wyboru po prawej (lista jednokrotnego wyboru). */
  zaznaczony?: boolean;
  /** Akcja niszcząca (np. „Usuń”): czerwony tekst, bez wartości. */
  niszczacy?: boolean;
  /** Tekst akcji w kolorze marki (np. „Oznacz jako zapłaconą”). */
  akcja?: boolean;
  onPress?: () => void;
  prawaStrona?: ReactNode;
  etykietaDostepnosci?: string;
};

/** Wartość z cyframi (kwota, data, numer, procent) idzie czcionką liczb, jak na stronie. */
const MA_CYFRY = /\d/;
const TONY_PLAKIETKI: (keyof Kolory)[] = ['sukces', 'ostrzezenie', 'blad', 'info', 'fiolet'];

export function Wiersz({
  tytul,
  podtytul,
  wartosc,
  wartoscPodpis,
  wartoscPodpisKolor = 'etykietaDrugorzedna',
  wartoscKolor,
  zaznaczalna,
  ikona,
  ikonaKolor = 'akcent',
  strzalka,
  zaznaczony,
  niszczacy,
  akcja,
  onPress,
  prawaStrona,
  etykietaDostepnosci,
}: WierszProps) {
  const kolory = useKolory();
  const { fontScale } = useWindowDimensions();
  // Przy dużym tekście z ustawień wartość schodzi pod tytuł, żeby nic się nie ucinało.
  const duzyTekst = fontScale >= SKALA_PIONOWA;
  const pionowo = duzyTekst && Boolean(wartosc || wartoscPodpis);
  const tresc = (
    <>
      {ikona ? <KoloIkony nazwa={ikona} ton={tonKoloru(ikonaKolor)} /> : null}
      <View style={styles.lewa}>
        <Tekst
          styl="body"
          kolor={niszczacy ? 'blad' : akcja ? 'akcent' : 'etykieta'}
          waga={akcja || niszczacy ? 'medium' : undefined}
          numberOfLines={duzyTekst ? 5 : 2}>
          {tytul}
        </Tekst>
        {podtytul ? (
          <Tekst styl="footnote" kolor="etykietaDrugorzedna" numberOfLines={pionowo ? 6 : 4} selectable={zaznaczalna}>
            {podtytul}
          </Tekst>
        ) : null}
      </View>
      {wartosc || wartoscPodpis ? (
        <View style={pionowo ? styles.prawaPionowa : styles.prawa}>
          {wartosc ? (
            <Tekst
              styl="callout"
              kolor={wartoscKolor ?? (podtytul ? 'etykieta' : 'etykietaDrugorzedna')}
              cyfry={MA_CYFRY.test(wartosc)}
              waga={MA_CYFRY.test(wartosc) ? 'medium' : undefined}
              selectable={zaznaczalna}
              numberOfLines={pionowo ? 2 : 1}>
              {wartosc}
            </Tekst>
          ) : null}
          {wartoscPodpis ? (
            TONY_PLAKIETKI.includes(wartoscPodpisKolor) ? (
              <Znacznik ton={tonKoloru(wartoscPodpisKolor)}>{wartoscPodpis}</Znacznik>
            ) : (
              <Tekst
                styl="footnote"
                kolor={wartoscPodpisKolor}
                waga={wartoscPodpisKolor === 'akcent' ? 'medium' : undefined}
                cyfry={MA_CYFRY.test(wartoscPodpis) && wartoscPodpisKolor !== 'akcent'}
                numberOfLines={1}>
                {wartoscPodpis}
              </Tekst>
            )
          ) : null}
        </View>
      ) : null}
      {prawaStrona}
      {zaznaczony ? <Ikona nazwa="check-line" rozmiar={20} kolor={kolory.akcent} /> : null}
      {strzalka ? <Ikona nazwa="arrow-right-s-line" rozmiar={20} kolor={kolory.etykietaTrzeciorzedna} /> : null}
    </>
  );

  if (!onPress) {
    return (
      <View style={[styles.wiersz, pionowo ? styles.wierszPionowy : null]} accessible={!zaznaczalna} accessibilityLabel={etykietaDostepnosci}>
        {tresc}
      </View>
    );
  }
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={etykietaDostepnosci}
      accessibilityState={zaznaczony === undefined ? undefined : { selected: zaznaczony }}
      android_ripple={{ color: kolory.wypelnienie }}
      style={({ pressed }) => [
        styles.wiersz,
        pionowo ? styles.wierszPionowy : null,
        pressed && Platform.OS === 'ios' ? { backgroundColor: kolory.wypelnienie } : null,
      ]}>
      {tresc}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  tresc: { paddingBottom: ODSTEP.xxl },
  sekcja: { marginTop: ODSTEP.m },
  karta: { marginHorizontal: MARGINES, borderRadius: PROMIEN, borderWidth: OBWODKA, overflow: 'hidden' },
  naglowekKarty: { paddingHorizontal: MARGINES, paddingTop: ODSTEP.s + 2, paddingBottom: ODSTEP.s, gap: ODSTEP.linia },
  naglowekWiersz: { flexDirection: 'row', alignItems: 'center', gap: ODSTEP.xs },
  rozciagniety: { flex: 1 },
  akcjaNaglowka: { flexDirection: 'row', alignItems: 'center', gap: ODSTEP.linia, minHeight: CEL_DOTYKU / 2 },
  swobodna: { padding: MARGINES },
  swobodnaPodNaglowkiem: { paddingTop: 0 },
  zPolami: { paddingVertical: ODSTEP.xs },
  linia: { height: StyleSheet.hairlineWidth },
  stopka: { paddingHorizontal: MARGINES, paddingTop: ODSTEP.s - 2, paddingBottom: ODSTEP.s },
  stopkaBezKarty: { marginHorizontal: MARGINES + ODSTEP.xxs, marginTop: ODSTEP.xs },
  samaStopka: { marginHorizontal: MARGINES + ODSTEP.xxs, marginTop: ODSTEP.s },
  wiersz: {
    // 52 pt: wiersz z jedną linią jak w tabelach strony powiększonych do palca.
    minHeight: CEL_DOTYKU + ODSTEP.xs,
    paddingHorizontal: MARGINES,
    paddingVertical: ODSTEP.s,
    flexDirection: 'row',
    alignItems: 'center',
    gap: ODSTEP.s,
  },
  lewa: { flex: 1, gap: ODSTEP.linia },
  prawa: { alignItems: 'flex-end', gap: ODSTEP.xxs, maxWidth: '55%' },
  prawaPionowa: { alignItems: 'flex-start', gap: ODSTEP.xxs },
  wierszPionowy: { flexDirection: 'column', alignItems: 'stretch', gap: ODSTEP.xxs },
});

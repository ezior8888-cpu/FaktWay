/**
 * Karty i wiersze FaktWay z wykończeniem Copilota (plan aplikacji, D15):
 * karta 18 pt bez obwódki z delikatnym cieniem (`karta.tsx`), nagłówek sekcji
 * wersalikami nad kartą (w formularzu z polami w karcie), wiersze bez linii,
 * oddzielone wysokością; linia zostaje tylko w długich tabelach (`linie`).
 * Okrągłe ikony Remix, liczby cyframi tabelarycznymi, statusy jako plakietki
 * (docs/mobile/ZASADY-DESIGNU.md, sekcja 5).
 */
import { Children, Fragment, isValidElement, useState, type ReactElement, type ReactNode } from 'react';
import { Platform, Pressable, RefreshControl, ScrollView, StyleSheet, useWindowDimensions, View, type ScrollViewProps } from 'react-native';

import { GradientNaglowka } from '@/komponenty/gradient-naglowka';
import { Karta } from '@/komponenty/karta';
import { Kategoria } from '@/komponenty/kategoria';
import { Ikona, KoloIkony, type NazwaIkony } from '@/komponenty/ikona';
import { Tekst } from '@/komponenty/tekst';
import { Znacznik } from '@/komponenty/znacznik';
import { tonKoloru, useKolory, type Kolory } from '@/wyglad/kolory';
import { CEL_DOTYKU, MARGINES, ODSTEP, SKALA_PIONOWA } from '@/wyglad/odstepy';

/**
 * Przewijany ekran na tle pod kartami. `contentInsetAdjustmentBehavior`
 * pozwala dużemu tytułowi zwijać się przy przewijaniu (Expo Router, Stack).
 */
/**
 * `gradient`: miękki gradient pod nagłówkiem (D15) na ekranach z dużym tytułem
 * albo dużą kwotą; `'pod-paskiem'` na Pulpicie, gdzie nad treścią stoi pasek
 * marki z własnym gradientem. `onOdswiez`: odświeżanie pociągnięciem w dół
 * (WZORCE-MOBBIN.md 8.3); kręciołek jest biały na gradiencie.
 */
export function EkranListy({
  children,
  gradient,
  onOdswiez,
  ...reszta
}: ScrollViewProps & { children: ReactNode; gradient?: boolean | 'pod-paskiem'; onOdswiez?: () => Promise<void> }) {
  const kolory = useKolory();
  const [odswiezam, setOdswiezam] = useState(false);
  const odswiez = async () => {
    if (!onOdswiez) return;
    setOdswiezam(true);
    try {
      await onOdswiez();
    } finally {
      setOdswiezam(false);
    }
  };
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      style={{ backgroundColor: kolory.tloGrupowane }}
      contentContainerStyle={styles.tresc}
      refreshControl={
        onOdswiez ? <RefreshControl refreshing={odswiezam} onRefresh={() => void odswiez()} tintColor={gradient ? kolory.naGradiencie : kolory.etykietaDrugorzedna} /> : undefined
      }
      {...reszta}>
      {gradient ? <GradientNaglowka podPaskiem={gradient === 'pod-paskiem'} /> : null}
      {children}
    </ScrollView>
  );
}

type SekcjaProps = {
  /** Nagłówek sekcji: wersalikami nad kartą (D15); w karcie z polami formularza w karcie. */
  naglowek?: string;
  /** Opis pod nagłówkiem. */
  opis?: string;
  /** Link po prawej stronie tytułu, np. „Wszystkie”. */
  naglowekAkcja?: { tytul: string; onPress: () => void };
  /** Liczba albo suma po prawej stronie nagłówka (np. suma grupy faktur), gdy nie ma linku. */
  naglowekWartosc?: string;
  /** Dopisek na dole karty: wyjaśnienie, źródło liczb, błąd. */
  stopka?: string;
  /** Treść bez wierszy (wykres, kalendarz): w karcie, z marginesem wewnętrznym. */
  swobodna?: boolean;
  /** Treść bez karty (kafle mają własne karty): tytuł nad treścią. */
  bezKarty?: boolean;
  /** Linia między wierszami: tylko długie tabele (KPiR, ewidencja), reszta oddziela się wysokością. */
  linie?: boolean;
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

export function Sekcja({ naglowek, opis, naglowekAkcja, naglowekWartosc, stopka, swobodna, bezKarty, linie, children }: SekcjaProps) {
  const kolory = useKolory();
  const elementy = splaszcz(children);
  const zPolami = elementy.some(jestPolem);

  if (bezKarty) {
    return (
      <View style={naglowek ? styles.sekcjaZNaglowkiem : styles.sekcja}>
        {naglowek ? <NaglowekSekcji tytul={naglowek} opis={opis} akcja={naglowekAkcja} wartosc={naglowekWartosc} /> : null}
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

  // Nagłówek nad kartą jak w Copilocie; w formularzu („Nabywca”, „Pozycje”) zostaje w karcie.
  const naglowekNad = naglowek && !zPolami;
  return (
    <View style={naglowekNad ? styles.sekcjaZNaglowkiem : styles.sekcja}>
      {naglowekNad ? <NaglowekSekcji tytul={naglowek} opis={opis} akcja={naglowekAkcja} wartosc={naglowekWartosc} /> : null}
      <Karta>
        {naglowek && zPolami ? <NaglowekSekcji tytul={naglowek} opis={opis} akcja={naglowekAkcja} wKarcie /> : null}
        {swobodna ? (
          <View style={styles.swobodna}>{children}</View>
        ) : (
          <View style={zPolami ? styles.zPolami : styles.wiersze}>
            {elementy.map((el, i) => {
              const poprzedni = elementy[i - 1];
              const linia = linie && poprzedni !== undefined && !jestPolem(poprzedni) && !jestPolem(el);
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
          <Tekst styl="footnote" kolor="etykietaDrugorzedna" style={styles.stopka}>
            {stopka}
          </Tekst>
        ) : null}
      </Karta>
    </View>
  );
}

function Linia({ kolor }: { kolor: string }) {
  return <View style={[styles.linia, { backgroundColor: kolor }]} />;
}

type NaglowekSekcjiProps = { tytul: string; opis?: string; akcja?: { tytul: string; onPress: () => void }; wartosc?: string; wKarcie?: boolean };

/** Nagłówek sekcji wersalikami 12 pt (Copilot, D15), link ze strzałką po prawej. */
function NaglowekSekcji({ tytul, opis, akcja, wartosc, wKarcie }: NaglowekSekcjiProps) {
  const kolory = useKolory();
  const { fontScale } = useWindowDimensions();
  // Przy dużym tekście suma albo link schodzi pod tytuł: obok niego tytuł łamałby słowa w środku (M10a).
  const pionowo = fontScale >= SKALA_PIONOWA && Boolean(akcja || wartosc);
  return (
    <View style={wKarcie ? styles.naglowekWKarcie : styles.naglowekNad}>
      <View style={pionowo ? styles.naglowekPionowo : styles.naglowekWiersz}>
        <Tekst styl="caption1" waga="semibold" kolor="etykietaDrugorzedna" accessibilityRole="header" style={[pionowo ? null : styles.rozciagniety, styles.wersaliki]}>
          {tytul}
        </Tekst>
        {akcja ? (
          <Pressable onPress={akcja.onPress} hitSlop={ODSTEP.s} accessibilityRole="button" style={styles.akcjaNaglowka}>
            <Tekst styl="subheadline" kolor="akcent" waga="medium">
              {akcja.tytul}
            </Tekst>
            <Ikona nazwa="arrow-right-s-line" rozmiar={16} kolor={kolory.akcent} />
          </Pressable>
        ) : wartosc ? (
          <Tekst styl="subheadline" kolor="etykietaDrugorzedna" cyfry waga="medium">
            {wartosc}
          </Tekst>
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
  /** Kategoria kosztu jako kolorowa plakietka przed podtytułem (D15). */
  kategoria?: string;
  wartosc?: string;
  /** Druga linia po prawej, pod wartością. Kolor statusu (sukces, ostrzeżenie, błąd) daje plakietkę. */
  wartoscPodpis?: string;
  wartoscPodpisKolor?: keyof Kolory;
  /** Kolor wartości (domyślnie główny przy podtytule, drugorzędny bez niego). */
  wartoscKolor?: keyof Kolory;
  /** Dane do skopiowania (NIP, numer KSeF): tekst da się zaznaczyć. */
  zaznaczalna?: boolean;
  /**
   * Okrągła ikona Remix po lewej. Od D15 rysowana tylko w kolorze stanu
   * (`ikonaKolor` błąd, ostrzeżenie, sukces), bo ozdobne ikony przy każdym
   * wierszu zaśmiecały ekrany (Bartosz, 12.11.2026).
   */
  ikona?: NazwaIkony;
  /** Kolor okrągłej ikony (ton); ikona marki się nie rysuje. */
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

/** Wartość z cyframi (kwota, data, numer, procent) ma cyfry tabelaryczne, kolumny się nie rozjeżdżają. */
const MA_CYFRY = /\d/;
const TONY_PLAKIETKI: (keyof Kolory)[] = ['sukces', 'ostrzezenie', 'blad', 'info', 'fiolet'];
/** Ikona w wierszu zostaje tylko wtedy, gdy mówi o stanie. */
const TONY_STANU: (keyof Kolory)[] = ['sukces', 'ostrzezenie', 'blad'];

export function Wiersz({
  tytul,
  podtytul,
  kategoria,
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
      {ikona && TONY_STANU.includes(ikonaKolor) ? <KoloIkony nazwa={ikona} ton={tonKoloru(ikonaKolor)} /> : null}
      <View style={styles.lewa}>
        <Tekst
          styl="body"
          kolor={niszczacy ? 'blad' : akcja ? 'akcent' : 'etykieta'}
          waga={akcja || niszczacy ? 'medium' : undefined}
          numberOfLines={duzyTekst ? 5 : 2}>
          {tytul}
        </Tekst>
        {kategoria ? (
          <View style={styles.zKategoria}>
            <Kategoria nazwa={kategoria} />
            {podtytul ? (
              <Tekst styl="footnote" kolor="etykietaDrugorzedna" numberOfLines={pionowo ? 6 : 4} selectable={zaznaczalna} style={styles.rozciagniety}>
                {podtytul}
              </Tekst>
            ) : null}
          </View>
        ) : podtytul ? (
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
  sekcjaZNaglowkiem: { marginTop: ODSTEP.xl },
  naglowekNad: { marginHorizontal: MARGINES + ODSTEP.xxs, marginBottom: ODSTEP.xs, gap: ODSTEP.linia },
  naglowekWKarcie: { paddingHorizontal: MARGINES, paddingTop: ODSTEP.s + 2, gap: ODSTEP.linia },
  naglowekWiersz: { flexDirection: 'row', alignItems: 'center', gap: ODSTEP.xs },
  naglowekPionowo: { alignItems: 'flex-start', gap: ODSTEP.xxs },
  rozciagniety: { flex: 1 },
  wersaliki: { textTransform: 'uppercase', letterSpacing: 0.8 },
  akcjaNaglowka: { flexDirection: 'row', alignItems: 'center', gap: ODSTEP.linia, minHeight: CEL_DOTYKU / 2 },
  swobodna: { padding: MARGINES },
  wiersze: { paddingVertical: ODSTEP.xxs },
  zPolami: { paddingVertical: ODSTEP.xs },
  linia: { height: StyleSheet.hairlineWidth, marginLeft: MARGINES },
  stopka: { paddingHorizontal: MARGINES, paddingTop: ODSTEP.xxs, paddingBottom: ODSTEP.s },
  stopkaBezKarty: { marginHorizontal: MARGINES + ODSTEP.xxs, marginTop: ODSTEP.xs },
  samaStopka: { marginHorizontal: MARGINES + ODSTEP.xxs, marginTop: ODSTEP.s },
  wiersz: {
    // 52 pt: wiersz z jedną linią, powiększony do palca; bez linii oddziela go wysokość.
    minHeight: CEL_DOTYKU + ODSTEP.xs,
    paddingHorizontal: MARGINES,
    paddingVertical: ODSTEP.s,
    flexDirection: 'row',
    alignItems: 'center',
    gap: ODSTEP.s,
  },
  lewa: { flex: 1, gap: ODSTEP.linia },
  zKategoria: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: ODSTEP.xs, marginTop: ODSTEP.linia },
  prawa: { alignItems: 'flex-end', gap: ODSTEP.xxs, maxWidth: '55%' },
  prawaPionowa: { alignItems: 'flex-start', gap: ODSTEP.xxs },
  wierszPionowy: { flexDirection: 'column', alignItems: 'stretch', gap: ODSTEP.xxs },
});

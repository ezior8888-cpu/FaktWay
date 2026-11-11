/**
 * Kolory FaktWay: te same, co w wersji na komputer (plan aplikacji, D12).
 * Źródło: `app/globals.css` strony, preset „Modern Minimal” z planu Finora
 * (D2, §10.1), przeliczony z OKLCH na HEX, oraz tony statusów z
 * `components/invoices/status-badge.tsx` (tło = 10% koloru roli).
 *
 * Jasny i ciemny motyw to dwie palety; `useKolory()` wybiera według trybu
 * telefonu. Nazwy są semantyczne: komponent mówi „etykieta drugorzędna”, nie
 * „szary #6C727E” (docs/mobile/ZASADY-DESIGNU.md, sekcja 4).
 */
import { useColorScheme } from 'react-native';

export type Kolory = {
  /** `--foreground`: tekst główny (nie czarny, jak na stronie). */
  etykieta: string;
  /** `--muted-foreground`: podpisy, opisy, osie wykresów. */
  etykietaDrugorzedna: string;
  /** Najsłabszy tekst: podpowiedzi w polach, strzałki wierszy. */
  etykietaTrzeciorzedna: string;
  /** `--background`: tło arkuszy i pól. */
  tlo: string;
  /** Tło ekranu pod kartami (na stronie: tło menu bocznego). */
  tloGrupowane: string;
  /** `--card`: karty. */
  tloKomorki: string;
  /** Wiersz albo kafel wciśnięty palcem. */
  wypelnienie: string;
  /** Linia między wierszami w karcie. */
  separator: string;
  /** `--border`: obwódka kart, pól i przycisków drugorzędnych. */
  obwodka: string;
  /** `--primary` jako tekst: linki, akcje, aktywna zakładka. */
  akcent: string;
  /** `--primary` jako tło przycisku głównego. */
  akcentWypelnienie: string;
  /** `--primary-foreground`: tekst na przycisku głównym (w ciemnym motywie ciemny, jak na stronie). */
  naAkcencie: string;
  /** `bg-primary/10`: tło okrągłych ikon i plakietek w kolorze marki. */
  akcentTlo: string;
  /** `--accent-foreground`: tekst na `akcentTlo`. */
  akcentNaTle: string;
  sukces: string;
  sukcesTlo: string;
  ostrzezenie: string;
  ostrzezenieTlo: string;
  blad: string;
  bladTlo: string;
  info: string;
  infoTlo: string;
  fiolet: string;
  fioletTlo: string;
  /** Tło plakietki neutralnej (szkic, informacja bez oceny). */
  neutralneTlo: string;
  /** `--chart-1` do `--chart-5`: odcienie niebieskiego, od najjaśniejszego. */
  wykres1: string;
  wykres2: string;
  wykres3: string;
  wykres4: string;
  wykres5: string;
};

const JASNE: Kolory = {
  etykieta: '#333333',
  etykietaDrugorzedna: '#6C727E',
  etykietaTrzeciorzedna: '#A3A7AE',
  tlo: '#FFFFFF',
  tloGrupowane: '#F8F8F8',
  tloKomorki: '#FFFFFF',
  wypelnienie: '#F1F3F7',
  separator: '#ECEFF3',
  obwodka: '#E4E8EF',
  akcent: '#2463EF',
  akcentWypelnienie: '#2463EF',
  naAkcencie: '#FFFFFF',
  akcentTlo: '#E9EFFD',
  akcentNaTle: '#1E3A8B',
  sukces: '#15803D',
  sukcesTlo: '#E8F6ED',
  ostrzezenie: '#B45309',
  ostrzezenieTlo: '#FBF1E6',
  blad: '#C90F1A',
  bladTlo: '#FAE7E8',
  info: '#0369A1',
  infoTlo: '#E6F3F9',
  fiolet: '#6D28D9',
  fioletTlo: '#F2EBFD',
  neutralneTlo: '#F1F2F4',
  wykres1: '#3981F6',
  wykres2: '#2463EF',
  wykres3: '#1D4EDA',
  wykres4: '#1D3FAD',
  wykres5: '#1E3A8B',
};

const CIEMNE: Kolory = {
  etykieta: '#E4E4E4',
  etykietaDrugorzedna: '#A4A4A4',
  etykietaTrzeciorzedna: '#6E6E6E',
  tlo: '#161616',
  tloGrupowane: '#161616',
  tloKomorki: '#262626',
  wypelnienie: '#313131',
  separator: '#363636',
  obwodka: '#404040',
  akcent: '#61A4F7',
  akcentWypelnienie: '#61A4F7',
  naAkcencie: '#161616',
  akcentTlo: '#35465A',
  akcentNaTle: '#BDDAFF',
  sukces: '#4ADE80',
  sukcesTlo: '#2A382F',
  ostrzezenie: '#FBBF24',
  ostrzezenieTlo: '#3B3526',
  blad: '#FF9795',
  bladTlo: '#513D3C',
  info: '#38BDF8',
  infoTlo: '#28353B',
  fiolet: '#A78BFA',
  fioletTlo: '#33303B',
  neutralneTlo: '#333333',
  wykres1: '#61A4F7',
  wykres2: '#3981F6',
  wykres3: '#2463EF',
  wykres4: '#1D4EDA',
  wykres5: '#1D3FAD',
};

/** Paleta dla trybu: dla miejsc poza komponentami (np. opcje pasków w `_layout.tsx`). */
export function paleta(ciemny: boolean): Kolory {
  return ciemny ? CIEMNE : JASNE;
}

export function useKolory(): Kolory {
  return paleta(useColorScheme() === 'dark');
}

/** Ton plakietki i okrągłej ikony: kolor tekstu i tło 10% (jak `STATUS_TONE_CLASS` na stronie). */
export type Ton = 'marka' | 'sukces' | 'ostrzezenie' | 'blad' | 'info' | 'fiolet' | 'neutralny';

export function kolorTonu(k: Kolory, ton: Ton): { tekst: string; tlo: string } {
  switch (ton) {
    case 'marka':
      return { tekst: k.akcentNaTle, tlo: k.akcentTlo };
    case 'sukces':
      return { tekst: k.sukces, tlo: k.sukcesTlo };
    case 'ostrzezenie':
      return { tekst: k.ostrzezenie, tlo: k.ostrzezenieTlo };
    case 'blad':
      return { tekst: k.blad, tlo: k.bladTlo };
    case 'info':
      return { tekst: k.info, tlo: k.infoTlo };
    case 'fiolet':
      return { tekst: k.fiolet, tlo: k.fioletTlo };
    default:
      return { tekst: k.etykietaDrugorzedna, tlo: k.neutralneTlo };
  }
}

/** Kolor semantyczny tekstu na ton plakietki (status faktury, opis kafla). */
export function tonKoloru(kolor: keyof Kolory | undefined): Ton {
  switch (kolor) {
    case 'sukces':
      return 'sukces';
    case 'ostrzezenie':
      return 'ostrzezenie';
    case 'blad':
      return 'blad';
    case 'info':
      return 'info';
    case 'fiolet':
      return 'fiolet';
    case 'akcent':
      return 'marka';
    default:
      return 'neutralny';
  }
}

/**
 * Paleta FaktWay na telefon: same wartości, bez React Native, żeby kontrast
 * sprawdzał test strony (`tests/unit/mobile-kontrast.test.ts`). Komponenty
 * biorą kolory przez `useKolory()` z `kolory.ts`.
 *
 * Źródło: `app/globals.css` strony, preset „Modern Minimal” z planu Finora
 * (D2, §10.1), przeliczony z OKLCH na HEX, oraz tony statusów z
 * `components/invoices/status-badge.tsx` (tło = 10% koloru roli). Od
 * 12.11.2026 wykończenie jak w Copilocie (plan aplikacji, D15): chłodnoszare
 * tło pod kartami, gradient pod nagłówkiem, kolorowe kategorie kosztów
 * (docs/mobile/ZASADY-DESIGNU.md, sekcja 4).
 *
 * Nazwy są semantyczne: komponent mówi „etykieta drugorzędna”, nie
 * „szary #646A76”.
 */

export type Kolory = {
  /** `--foreground`: tekst główny (nie czarny, jak na stronie). */
  etykieta: string;
  /**
   * Podpisy, opisy, osie wykresów. W jasnym odrobinę ciemniejszy niż
   * `--muted-foreground` strony, bo na chłodnoszarym tle D15 tamten nie
   * trzyma 4.5:1.
   */
  etykietaDrugorzedna: string;
  /** Najsłabszy tekst: podpowiedzi w polach, strzałki wierszy. */
  etykietaTrzeciorzedna: string;
  /** `--background`: tło arkuszy i pól. */
  tlo: string;
  /** Tło ekranu pod kartami: chłodnoszare jak w Copilocie (D15). */
  tloGrupowane: string;
  /** `--card`: karty. */
  tloKomorki: string;
  /** Wiersz albo kafel wciśnięty palcem. */
  wypelnienie: string;
  /** Linia między wierszami w długich tabelach (KPiR, ewidencja). */
  separator: string;
  /** `--border`: obwódka pól i przełączników. Karty od D15 są bez obwódki. */
  obwodka: string;
  /** `--primary` jako tekst: linki, akcje, aktywna zakładka. */
  akcent: string;
  /** `--primary` jako tło przycisku głównego. */
  akcentWypelnienie: string;
  /** `--primary-foreground`: tekst na przycisku głównym (w ciemnym motywie ciemny, jak na stronie). */
  naAkcencie: string;
  /** `bg-primary/10`: tło okrągłych ikon, plakietek marki i przycisku tonalnego. */
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
  /** Gradient pod nagłówkiem (D15): góra pod paskiem stanu, środek pod dużym tytułem, dół znika w tle. */
  gradientGora: string;
  gradientSrodek: string;
  gradientDol: string;
  /** Tekst i ikony na gradiencie (tytuł, logo, awatar). */
  naGradiencie: string;
  /** Tło awatara i okrągłych przycisków na gradiencie. */
  naGradiencieTlo: string;
  /** Podpowiedź w polu wyszukiwania na niebieskim pasku Androida (M12). */
  naGradiencieDrugorzedny: string;
  /** Fala przy dotknięciu na Androidzie (M12): na kartach, polach i przyciskach jasnych. */
  fala: string;
  /** Fala na przycisku w kolorze marki. */
  falaNaAkcencie: string;
};

export const JASNE: Kolory = {
  etykieta: '#333333',
  etykietaDrugorzedna: '#646A76',
  etykietaTrzeciorzedna: '#A3A7AE',
  tlo: '#FFFFFF',
  tloGrupowane: '#F2F4F7',
  tloKomorki: '#FFFFFF',
  wypelnienie: '#EEF1F6',
  separator: '#ECEFF3',
  obwodka: '#E4E8EF',
  akcent: '#2463EF',
  akcentWypelnienie: '#2463EF',
  naAkcencie: '#FFFFFF',
  akcentTlo: '#E9EFFD',
  akcentNaTle: '#1E3A8B',
  sukces: '#15803D',
  sukcesTlo: '#EAF7EF',
  ostrzezenie: '#B45309',
  ostrzezenieTlo: '#FBF1E6',
  blad: '#C90F1A',
  bladTlo: '#FAE7E8',
  info: '#0369A1',
  infoTlo: '#E6F3F9',
  fiolet: '#6D28D9',
  fioletTlo: '#F2EBFD',
  neutralneTlo: '#ECEEF2',
  wykres1: '#3981F6',
  wykres2: '#2463EF',
  wykres3: '#1D4EDA',
  wykres4: '#1D3FAD',
  wykres5: '#1E3A8B',
  gradientGora: '#1D4EDA',
  gradientSrodek: '#2463EF',
  gradientDol: '#6E99F4',
  naGradiencie: '#FFFFFF',
  naGradiencieTlo: 'rgba(255,255,255,0.2)',
  naGradiencieDrugorzedny: 'rgba(255,255,255,0.72)',
  fala: 'rgba(36,99,239,0.12)',
  falaNaAkcencie: 'rgba(255,255,255,0.24)',
};

export const CIEMNE: Kolory = {
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
  gradientGora: '#1D3FAD',
  gradientSrodek: '#1E3A8B',
  gradientDol: '#1B2A55',
  naGradiencie: '#FFFFFF',
  naGradiencieTlo: 'rgba(255,255,255,0.16)',
  naGradiencieDrugorzedny: 'rgba(255,255,255,0.72)',
  fala: 'rgba(97,164,247,0.16)',
  falaNaAkcencie: 'rgba(0,0,0,0.16)',
};

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

/**
 * Tony kategorii kosztów (D15). Kolor rozróżnia kategorie na liście i nic
 * nie mówi o podatku; kategoria ma wersaliki, status zwykłe litery.
 */
export type TonKategorii = 'turkus' | 'fiolet' | 'bursztyn' | 'pomarancz' | 'roz' | 'blekit' | 'szary';

type ParaKategorii = { tekst: string; tlo: string };

export const KATEGORIE_JASNE: Record<Exclude<TonKategorii, 'szary'>, ParaKategorii> = {
  turkus: { tekst: '#0E6E8C', tlo: '#E3F4F8' },
  fiolet: { tekst: '#6D28D9', tlo: '#F2EBFD' },
  bursztyn: { tekst: '#7A5200', tlo: '#FBF3DB' },
  pomarancz: { tekst: '#B23C0A', tlo: '#FDEDE3' },
  roz: { tekst: '#B0175A', tlo: '#FCE8F1' },
  blekit: { tekst: '#0369A1', tlo: '#E6F3F9' },
};

export const KATEGORIE_CIEMNE: Record<Exclude<TonKategorii, 'szary'>, ParaKategorii> = {
  turkus: { tekst: '#7DD3E8', tlo: '#1E3A42' },
  fiolet: { tekst: '#C4B5FD', tlo: '#33303B' },
  bursztyn: { tekst: '#FCD34D', tlo: '#3B3526' },
  pomarancz: { tekst: '#FDBA8C', tlo: '#40291E' },
  roz: { tekst: '#F9A8D4', tlo: '#3F2632' },
  blekit: { tekst: '#38BDF8', tlo: '#28353B' },
};

/** Kategoria kosztu (`KATEGORIE_KOSZTOW` w danych) na ton; brak na liście = szary. */
export const TON_KATEGORII: Record<string, Exclude<TonKategorii, 'szary'>> = {
  Telekomunikacja: 'turkus',
  Energia: 'turkus',
  Czynsz: 'fiolet',
  'Usługi obce': 'fiolet',
  'Materiały biurowe': 'bursztyn',
  Paliwo: 'pomarancz',
  'Podróże służbowe': 'pomarancz',
  Reprezentacja: 'roz',
  Marketing: 'roz',
  Oprogramowanie: 'blekit',
};

export function kolorKategorii(k: Kolory, ciemny: boolean, kategoria: string): ParaKategorii {
  const ton = TON_KATEGORII[kategoria];
  if (!ton) return { tekst: k.etykietaDrugorzedna, tlo: k.neutralneTlo };
  return (ciemny ? KATEGORIE_CIEMNE : KATEGORIE_JASNE)[ton];
}

/**
 * „Ten miesiąc” przy ryczałcie (plan księgowości JDG, K4; sekcje 4, 7 i 8):
 * składki społeczne, składka zdrowotna i ryczałt za miesiąc, z terminami.
 * Funkcja czysta: dane czyta `ten-miesiac-dane.ts`, a tam `brakujace()`
 * sprawdza, czy księgowa potwierdziła parametry (D7); liczbę bez wartości
 * sprawdza silnik, który jej używa.
 *
 * - Każda pozycja ma własny wynik albo brak: brak jednej (np. składek za
 *   niepełny miesiąc) nie zabiera kwot pozostałych.
 * - Ryczałt miesiąca zależy od wcześniejszych miesięcy roku (przeniesienie
 *   odliczeń i korekt większych niż przychód), więc liczy się od stycznia.
 * - Od przychodu odlicza się składki ZAPŁACONE w miesiącu, czyli oznaczone
 *   w rozliczeniach przyciskiem „Zapłacone” z datą. Przy kolejnej wersji
 *   rozliczenia liczy się tylko dopłata (przyrost między zapłaconymi wersjami).
 * - Próg zdrowotnej: przychód od początku roku pomniejszony o zapłacone
 *   składki społeczne bez FP (sekcja 5, pewność średnia).
 * - Firma, która zaczyna w trakcie miesiąca, liczy się z pierwszej wersji
 *   ustawień z tego miesiąca; składka zdrowotna jest wtedy pełna.
 * - Skala i liniowy (K7): zamiast ryczałtu zaliczka PIT narastająco z KPiR
 *   (`pit.ts`), a składka zdrowotna od dochodu z poprzedniego miesiąca (za
 *   styczeń z grudnia, więc z KPiR roku poprzedniego).
 */

import { monthLabel, monthRange } from '@/lib/expenses/month';
import { formatIsoDatePl } from '@/lib/format/iso-date';
import { brakiOkresu, sumyOkresu, wierszeOkresu, type Ewidencja } from '@/lib/ksiegowosc/ewidencja';
import { brakiKpirOkresu, sumyKpir, wierszeKpirOkresu, type Kpir } from '@/lib/ksiegowosc/kpir';
import { zaliczkiPit, type FormaPit, type MiesiacPit, type ZaliczkaMiesiaca } from '@/lib/ksiegowosc/pit';
import { terminDla, type Termin } from '@/lib/ksiegowosc/kalendarz';
import { rokSkladkowyZdrowotnej, type ParametryRoku } from '@/lib/ksiegowosc/parametry';
import { wersjaNa, type WersjaProfilu } from '@/lib/ksiegowosc/profil';
import { ryczaltMiesiaca, type RyczaltMiesiaca, type WejscieRyczaltu } from '@/lib/ksiegowosc/ryczalt';
import { zdrowotnaOdDochodu, zdrowotnaRyczaltu, type ZdrowotnaOdDochodu, type ZdrowotnaRyczaltu } from '@/lib/ksiegowosc/zdrowotna';
import { PROPORCJA, skladkiSpoleczne, type SkladkiSpoleczne } from '@/lib/ksiegowosc/zus';

export const RODZAJE_ROZLICZEN = ['ryczalt', 'pit', 'zus_spoleczne', 'zdrowotna'] as const;
export type RodzajRozliczenia = (typeof RODZAJE_ROZLICZEN)[number];

export const NAZWY_ROZLICZEN: Readonly<Record<RodzajRozliczenia, string>> = {
  ryczalt: 'Ryczałt od przychodów ewidencjonowanych',
  pit: 'Zaliczka na podatek dochodowy',
  zus_spoleczne: 'Składki społeczne',
  zdrowotna: 'Składka zdrowotna',
};

/** Zapłacona wersja rozliczenia (status `zaplacone`). */
export interface Platnosc {
  /** RRRR-MM: miesiąc, którego rozliczenie dotyczy. */
  miesiac: string;
  rodzaj: RodzajRozliczenia;
  wersja: number;
  kwotaGr: number;
  /** Przy składkach społecznych: część bez FP, którą odlicza się od przychodu. */
  spoleczneBezFpGr: number;
  /** RRRR-MM-DD */
  zaplaconeO: string;
}

export interface PozycjaDoZaplaty {
  rodzaj: RodzajRozliczenia;
  kwotaGr: number;
  termin: Termin | null;
  /**
   * Bezpośrednie wejścia kwoty. Skrót (D6) liczy się z nich i z kwoty, więc
   * zmiana, która kwoty tej pozycji nie dotyka, nie tworzy nowej wersji.
   */
  wejscia: Record<string, unknown>;
  /** Do migawki, poza skrótem: łańcuch od stycznia, przychód narastająco. */
  szczegoly?: Record<string, unknown>;
  /** Część bez FP (składki społeczne), do odliczeń w kolejnych miesiącach. */
  spoleczneBezFpGr?: number;
}

export interface BrakPozycji {
  rodzaj: RodzajRozliczenia;
  termin: Termin | null;
  /** Dla klienta: dlaczego kwoty nie ma i co dalej. */
  brak: string;
}

export type PozycjaMiesiaca = ({ ok: true } & PozycjaDoZaplaty) | ({ ok: false } & BrakPozycji);

export interface WynikMiesiaca {
  miesiac: string;
  /** Wersja ustawień, z której liczy się miesiąc. */
  profil: WersjaProfilu;
  /** Przychód miesiąca z ewidencji; `null`, gdy ewidencja ma w tym miesiącu braki. */
  przychodGr: number | null;
  /** Skala i liniowy: koszty miesiąca z KPiR; przy ryczałcie null. */
  kosztyGr: number | null;
  skladki: SkladkiSpoleczne | null;
  zdrowotna: ZdrowotnaRyczaltu | null;
  /** Skala i liniowy: składka od dochodu z poprzedniego miesiąca. */
  zdrowotnaOdDochodu: ZdrowotnaOdDochodu | null;
  ryczalt: RyczaltMiesiaca | null;
  /** Skala i liniowy: zaliczka narastająco za ten miesiąc. */
  pit: ZaliczkaMiesiaca | null;
  pozycje: PozycjaMiesiaca[];
}

export type TenMiesiac = { ok: true; wynik: WynikMiesiaca } | { ok: false; braki: string[] };

export interface WejscieMiesiaca {
  /** RRRR-MM */
  miesiac: string;
  /** Ewidencja roku miesiąca (K3); potrzebna tylko przy ryczałcie. */
  ewidencja?: Ewidencja;
  /** Skala i liniowy (K7): KPiR roku miesiąca i (dla stycznia) roku poprzedniego. */
  kpir?: { rok: Kpir; poprzedni: Kpir | null };
  wersje: readonly WersjaProfilu[];
  /** Wszystkie zapłacone wersje rozliczeń do tego miesiąca (odliczenia liczą się po dniu zapłaty). */
  platnosci: readonly Platnosc[];
  parametry: (rok: number) => ParametryRoku | null;
}

const PROFIL = 'Ustawienia są w Księgowości, w zakładce „Ustawienia podatkowe”.';

/**
 * Dopłaty: przy kolejnej zapłaconej wersji tego samego rozliczenia liczy się
 * tylko przyrost (kwota tej wersji minus najwyższa wcześniej zapłacona),
 * w miesiącu zapłaty. Ujemny przyrost (nadpłata) to zero.
 */
export function przyrostyZaplat(platnosci: readonly Platnosc[]) {
  const grupy = new Map<string, Platnosc[]>();
  for (const p of platnosci) {
    const klucz = `${p.miesiac}|${p.rodzaj}`;
    grupy.set(klucz, [...(grupy.get(klucz) ?? []), p]);
  }
  const wynik: { rodzaj: RodzajRozliczenia; miesiacZaplaty: string; kwotaGr: number; spoleczneBezFpGr: number }[] = [];
  for (const lista of grupy.values()) {
    let kwota = 0;
    let bezFp = 0;
    for (const p of [...lista].sort((a, b) => a.wersja - b.wersja)) {
      wynik.push({
        rodzaj: p.rodzaj,
        miesiacZaplaty: p.zaplaconeO.slice(0, 7),
        kwotaGr: Math.max(0, p.kwotaGr - kwota),
        spoleczneBezFpGr: Math.max(0, p.spoleczneBezFpGr - bezFp),
      });
      kwota = Math.max(kwota, p.kwotaGr);
      bezFp = Math.max(bezFp, p.spoleczneBezFpGr);
    }
  }
  return wynik;
}

const miesiacNr = (rok: number, m: number) => `${rok}-${String(m).padStart(2, '0')}`;

type Czesciowy<T> = ({ ok: true } & T) | { ok: false; brak: string };

/** Wersja ustawień miesiąca: z pierwszego dnia, a przy starcie w trakcie miesiąca pierwsza z tego miesiąca. */
export function wersjaMiesiaca(wersje: readonly WersjaProfilu[], miesiac: string): WersjaProfilu | null {
  const { from: od, to: koniec } = monthRange(miesiac);
  return (
    wersjaNa(wersje, od) ??
    [...wersje].filter((v) => v.validFrom > od && v.validFrom <= koniec).sort((a, b) => a.validFrom.localeCompare(b.validFrom))[0] ??
    null
  );
}

export function tenMiesiac(w: WejscieMiesiaca): TenMiesiac {
  const rok = Number(w.miesiac.slice(0, 4));
  const nr = Number(w.miesiac.slice(5, 7));
  const { from: od, to: koniec } = monthRange(w.miesiac);

  const wersja = wersjaMiesiaca(w.wersje, w.miesiac);
  if (!wersja) return { ok: false, braki: [`Na ${monthLabel(w.miesiac)} nie ma ustawień podatkowych, więc nic nie liczymy. ${PROFIL}`] };
  const p = w.parametry(rok);
  if (!p) return { ok: false, braki: [`Brak parametrów na ${rok} r., więc nic nie liczymy.`] };

  const przyrosty = przyrostyZaplat(w.platnosci);
  const zaplaconeW = (miesiac: string, rodzaj: RodzajRozliczenia, pole: 'kwotaGr' | 'spoleczneBezFpGr') =>
    przyrosty.filter((z) => z.rodzaj === rodzaj && z.miesiacZaplaty === miesiac).reduce((s, z) => s + z[pole], 0);

  const zus = ((): Czesciowy<{ skladki: SkladkiSpoleczne }> => {
    const odDnia = wersja.validFrom > od ? wersja.validFrom : od;
    const zmiana = w.wersje.find(
      (v) =>
        v.validFrom > odDnia &&
        v.validFrom <= koniec &&
        (v.zusEtap !== wersja.zusEtap || v.zusOd !== wersja.zusOd || v.chorobowe !== wersja.chorobowe),
    );
    if (zmiana) {
      return {
        ok: false,
        brak: `Ustawienia składek ZUS zmieniają się w trakcie miesiąca (od ${formatIsoDatePl(zmiana.validFrom)}); taki miesiąc rozlicza księgowa. ${PROFIL}`,
      };
    }
    // Pełny ZUS nie ma daty początku etapu: start w trakcie miesiąca to podstawa proporcjonalna.
    if (wersja.validFrom > od && wersja.zusEtap === 'pelny') {
      return { ok: false, brak: `Ustawienia podatkowe obowiązują od ${formatIsoDatePl(wersja.validFrom)}, czyli od dnia w trakcie miesiąca. ${PROPORCJA}` };
    }
    return skladkiSpoleczne(w.miesiac, wersja, p.zus.liczby);
  })();
  const termin = (rodzaj: 'ryczalt' | 'zaliczkaPit' | 'zus') => terminDla({ rodzaj, rok, miesiac: nr });
  const pozycjaZus: PozycjaMiesiaca = zus.ok
    ? {
        ok: true,
        rodzaj: 'zus_spoleczne',
        kwotaGr: zus.skladki.razemGr + zus.skladki.funduszPracyGr,
        spoleczneBezFpGr: zus.skladki.razemGr,
        termin: termin('zus'),
        wejscia: { etap: wersja.zusEtap, od: wersja.zusOd, chorobowe: wersja.chorobowe, skladki: zus.skladki },
      }
    : { ok: false, rodzaj: 'zus_spoleczne', termin: termin('zus'), brak: zus.brak };

  if (wersja.forma !== 'ryczalt') {
    return {
      ok: true,
      wynik: miesiacKpir(w, wersja.forma, p, przyrosty, termin, pozycjaZus, zus.ok ? zus.skladki : null, wersja),
    };
  }

  const ewidencja = w.ewidencja;
  if (!ewidencja) return { ok: false, braki: ['Nie udało się odczytać ewidencji przychodów, więc nic nie liczymy.'] };
  const brakiRoku = brakiOkresu(ewidencja, `${rok}-01-01`, koniec);
  const brakEwidencji =
    brakiRoku.length > 0
      ? `Ewidencja przychodów ma braki w miesiącach: ${[...new Set(brakiRoku.map((b) => b.dzien.slice(0, 7)))].map(monthLabel).join(', ')}. ` +
        'Dopóki są, ryczałtu i progu zdrowotnej nie liczymy; lista jest w zakładce „Ewidencja”.'
      : null;

  // Ryczałt od stycznia: przeniesienie odliczeń i korekt zależy od wcześniejszych miesięcy.
  const ryczalt = ((): Czesciowy<{ ryczalt: RyczaltMiesiaca; wejscie: WejscieRyczaltu; lancuch: Record<string, unknown>[] }> => {
    if (brakEwidencji) return { ok: false, brak: brakEwidencji };
    let nadwyzka = 0;
    let ujemne: ReadonlyMap<number, number> = new Map();
    const lancuch: Record<string, unknown>[] = [];
    let ostatni: { ryczalt: RyczaltMiesiaca; wejscie: WejscieRyczaltu } | null = null;
    for (let m = 1; m <= nr; m++) {
      const miesiac = miesiacNr(rok, m);
      const g = monthRange(miesiac);
      const wejscie: WejscieRyczaltu = {
        przychodWgStawekGr: sumyOkresu(wierszeOkresu(ewidencja, g.from, g.to)).stawki,
        ujemneZPoprzednichGr: ujemne,
        spoleczneZaplaconeGr: zaplaconeW(miesiac, 'zus_spoleczne', 'spoleczneBezFpGr'),
        zdrowotnaZaplaconaGr: zaplaconeW(miesiac, 'zdrowotna', 'kwotaGr'),
        nadwyzkaZPoprzednichGr: nadwyzka,
      };
      const r = ryczaltMiesiaca(wejscie, p.ryczalt.liczby);
      if (!r.ok) return { ok: false, brak: m === nr ? r.brak : `${monthLabel(miesiac)}: ${r.brak}` };
      nadwyzka = r.ryczalt.odliczenia.nadwyzkaNaKolejneGr;
      ujemne = r.ryczalt.ujemneNaKolejneGr;
      lancuch.push({
        miesiac,
        przychod: Object.fromEntries(wejscie.przychodWgStawekGr),
        spoleczne: wejscie.spoleczneZaplaconeGr,
        zdrowotna: wejscie.zdrowotnaZaplaconaGr,
      });
      ostatni = { ryczalt: r.ryczalt, wejscie };
    }
    if (!ostatni) return { ok: false, brak: 'Brak miesiąca do policzenia.' };
    return { ok: true, ...ostatni, lancuch };
  })();

  const rokSkladkowy = rokSkladkowyZdrowotnej(w.miesiac);
  const zdrowotna = ((): Czesciowy<{ zdrowotna: ZdrowotnaRyczaltu; przychodNarastajacoGr: number; spoleczneNarastajacoGr: number }> => {
    const zdrowotnaRoku = w.parametry(rokSkladkowy);
    if (!zdrowotnaRoku) {
      return {
        ok: false,
        brak: `Brak parametrów składki zdrowotnej na rok składkowy od lutego ${rokSkladkowy} r. do stycznia ${rokSkladkowy + 1} r., więc tej składki nie liczymy.`,
      };
    }
    if (brakEwidencji) return { ok: false, brak: brakEwidencji };
    const przychodNarastajacoGr = sumyOkresu(wierszeOkresu(ewidencja, `${rok}-01-01`, koniec)).razemGr;
    const spoleczneNarastajacoGr = przyrosty
      .filter((z) => z.rodzaj === 'zus_spoleczne' && z.miesiacZaplaty >= `${rok}-01` && z.miesiacZaplaty <= w.miesiac)
      .reduce((s, z) => s + z.spoleczneBezFpGr, 0);
    const z = zdrowotnaRyczaltu(przychodNarastajacoGr - spoleczneNarastajacoGr, zdrowotnaRoku.zdrowotna.liczby);
    if (!z.ok) return z;
    return { ok: true, zdrowotna: z.zdrowotna, przychodNarastajacoGr, spoleczneNarastajacoGr };
  })();

  const pozycje: PozycjaMiesiaca[] = [
    ryczalt.ok
      ? {
          ok: true,
          rodzaj: 'ryczalt',
          kwotaGr: ryczalt.ryczalt.ryczaltGr,
          termin: termin('ryczalt'),
          wejscia: {
            przychod: Object.fromEntries(ryczalt.wejscie.przychodWgStawekGr),
            ujemneZPoprzednich: Object.fromEntries(ryczalt.wejscie.ujemneZPoprzednichGr ?? []),
            spoleczne: ryczalt.wejscie.spoleczneZaplaconeGr,
            zdrowotna: ryczalt.wejscie.zdrowotnaZaplaconaGr,
            nadwyzkaZPoprzednich: ryczalt.wejscie.nadwyzkaZPoprzednichGr,
          },
          szczegoly: { lancuch: ryczalt.lancuch, profil: { id: wersja.id, stawkaDomyslna: wersja.stawkaDomyslna, najem: wersja.najem } },
        }
      : { ok: false, rodzaj: 'ryczalt', termin: termin('ryczalt'), brak: ryczalt.brak },
    pozycjaZus,
    zdrowotna.ok
      ? {
          ok: true,
          rodzaj: 'zdrowotna',
          kwotaGr: zdrowotna.zdrowotna.skladkaGr,
          termin: termin('zus'),
          wejscia: { prog: zdrowotna.zdrowotna.prog },
          szczegoly: { przychodNarastajacoGr: zdrowotna.przychodNarastajacoGr, spoleczneNarastajacoGr: zdrowotna.spoleczneNarastajacoGr },
        }
      : { ok: false, rodzaj: 'zdrowotna', termin: termin('zus'), brak: zdrowotna.brak },
  ];

  return {
    ok: true,
    wynik: {
      miesiac: w.miesiac,
      profil: wersja,
      przychodGr: brakiOkresu(ewidencja, od, koniec).length === 0 ? sumyOkresu(wierszeOkresu(ewidencja, od, koniec)).razemGr : null,
      kosztyGr: null,
      skladki: zus.ok ? zus.skladki : null,
      zdrowotna: zdrowotna.ok ? zdrowotna.zdrowotna : null,
      zdrowotnaOdDochodu: null,
      ryczalt: ryczalt.ok ? ryczalt.ryczalt : null,
      pit: null,
      pozycje,
    },
  };
}

type Przyrost = ReturnType<typeof przyrostyZaplat>[number];

/**
 * Skala i liniowy (K7): zaliczka PIT narastająco od stycznia z KPiR
 * i zapłat (społeczne bez FP, przy liniowym też zdrowotna), składka zdrowotna
 * od dochodu z poprzedniego miesiąca. Brak w KPiR od stycznia do miesiąca
 * zabiera zaliczkę; brak w poprzednim miesiącu zabiera składkę zdrowotną.
 */
function miesiacKpir(
  w: WejscieMiesiaca,
  forma: FormaPit,
  p: ParametryRoku,
  przyrosty: readonly Przyrost[],
  termin: (rodzaj: 'ryczalt' | 'zaliczkaPit' | 'zus') => Termin | null,
  pozycjaZus: PozycjaMiesiaca,
  skladki: SkladkiSpoleczne | null,
  wersja: WersjaProfilu,
): WynikMiesiaca {
  const rok = Number(w.miesiac.slice(0, 4));
  const nr = Number(w.miesiac.slice(5, 7));
  const { from: od, to: koniec } = monthRange(w.miesiac);
  const kpir = w.kpir ?? null;
  const zaplaconeW = (miesiac: string, rodzaj: RodzajRozliczenia, pole: 'kwotaGr' | 'spoleczneBezFpGr') =>
    przyrosty.filter((z) => z.rodzaj === rodzaj && z.miesiacZaplaty === miesiac).reduce((s, z) => s + z[pole], 0);
  const brakKpir = (miesiace: string[]) =>
    `KPiR ma braki w miesiącach: ${miesiace.map(monthLabel).join(', ')}. Dopóki są, tej kwoty nie liczymy; lista jest w zakładce „Ewidencja”.`;

  const pit = ((): Czesciowy<{ zaliczka: ZaliczkaMiesiaca; lancuch: MiesiacPit[] }> => {
    if (!kpir) return { ok: false, brak: 'Nie udało się odczytać KPiR, więc zaliczki nie liczymy.' };
    const braki = brakiKpirOkresu(kpir.rok, `${rok}-01-01`, koniec);
    if (braki.length > 0) return { ok: false, brak: brakKpir([...new Set(braki.map((b) => b.dzien.slice(0, 7)))]) };
    const lancuch: MiesiacPit[] = [];
    for (let m = 1; m <= nr; m++) {
      const miesiac = miesiacNr(rok, m);
      const g = monthRange(miesiac);
      const sumy = sumyKpir(wierszeKpirOkresu(kpir.rok, g.from, g.to));
      lancuch.push({
        miesiac,
        przychodGr: sumy.przychodGr,
        kosztyGr: sumy.kosztyGr,
        spoleczneZaplaconeGr: zaplaconeW(miesiac, 'zus_spoleczne', 'spoleczneBezFpGr'),
        zdrowotnaZaplaconaGr: zaplaconeW(miesiac, 'zdrowotna', 'kwotaGr'),
      });
    }
    const z = zaliczkiPit(forma, lancuch, { skala: p.skala.liczby, liniowy: p.liniowy.liczby });
    if (!z.ok) return z;
    return { ok: true, zaliczka: z.miesiace[z.miesiace.length - 1], lancuch };
  })();

  const rokSkladkowy = rokSkladkowyZdrowotnej(w.miesiac);
  const poprzedni = miesiacNr(nr === 1 ? rok - 1 : rok, nr === 1 ? 12 : nr - 1);
  const zdrowotna = ((): Czesciowy<{ zdrowotna: ZdrowotnaOdDochodu }> => {
    const pz = w.parametry(rokSkladkowy);
    if (!pz) {
      return {
        ok: false,
        brak: `Brak parametrów składki zdrowotnej na rok składkowy od lutego ${rokSkladkowy} r. do stycznia ${rokSkladkowy + 1} r., więc tej składki nie liczymy.`,
      };
    }
    const ksiega = nr === 1 ? (kpir?.poprzedni ?? null) : (kpir?.rok ?? null);
    if (!ksiega) return { ok: false, brak: `Nie udało się odczytać KPiR za ${monthLabel(poprzedni)}, więc składki zdrowotnej nie liczymy.` };
    const g = monthRange(poprzedni);
    if (brakiKpirOkresu(ksiega, g.from, g.to).length > 0) return { ok: false, brak: brakKpir([poprzedni]) };
    const sumy = sumyKpir(wierszeKpirOkresu(ksiega, g.from, g.to));
    const dochod = sumy.przychodGr - sumy.kosztyGr - zaplaconeW(poprzedni, 'zus_spoleczne', 'spoleczneBezFpGr');
    return zdrowotnaOdDochodu(forma, dochod, pz.zdrowotna.liczby);
  })();

  const pozycje: PozycjaMiesiaca[] = [
    pit.ok
      ? {
          ok: true,
          rodzaj: 'pit',
          kwotaGr: pit.zaliczka.zaliczkaGr,
          termin: termin('zaliczkaPit'),
          wejscia: { forma, lancuch: pit.lancuch },
          szczegoly: { zaliczka: pit.zaliczka, profil: { id: wersja.id, forma } },
        }
      : { ok: false, rodzaj: 'pit', termin: termin('zaliczkaPit'), brak: pit.brak },
    pozycjaZus,
    zdrowotna.ok
      ? {
          ok: true,
          rodzaj: 'zdrowotna',
          kwotaGr: zdrowotna.zdrowotna.skladkaGr,
          termin: termin('zus'),
          wejscia: { forma, dochodGr: zdrowotna.zdrowotna.dochodGr, zMiesiaca: poprzedni },
        }
      : { ok: false, rodzaj: 'zdrowotna', termin: termin('zus'), brak: zdrowotna.brak },
  ];

  const miesiaca = kpir && brakiKpirOkresu(kpir.rok, od, koniec).length === 0 ? sumyKpir(wierszeKpirOkresu(kpir.rok, od, koniec)) : null;
  return {
    miesiac: w.miesiac,
    profil: wersja,
    przychodGr: miesiaca?.przychodGr ?? null,
    kosztyGr: miesiaca?.kosztyGr ?? null,
    skladki,
    zdrowotna: null,
    zdrowotnaOdDochodu: zdrowotna.ok ? zdrowotna.zdrowotna : null,
    ryczalt: null,
    pit: pit.ok ? pit.zaliczka : null,
    pozycje,
  };
}

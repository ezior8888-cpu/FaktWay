/**
 * Przypomnienia modułu księgowości (plan księgowości JDG, K5, sekcja 9):
 * kiedy wysłać, o czym i jakim tekstem. Funkcje czyste; zadania
 * (`lib/jobs/runners/ksiegowosc-*.ts`) czytają dane i wysyłają.
 *
 * - Termin: 5 i 1 dzień kalendarzowy przed terminem z kalendarza (K1), tylko
 *   rozliczenia bez oznaczonej zapłaty. Kwota z najnowszej zatwierdzonej
 *   wersji (minus to, co już zapłacone), a bez niej ze szkicu; gdy dane
 *   zmieniły się po zatwierdzeniu (inny skrót wejść), ze szkicu, jak dopłata
 *   na stronie (F11-B2); bez kwoty, gdy moduł jej nie liczy (D7), samo
 *   przypomnienie o terminie.
 * - VAT: płatnik VAT składa JPK_V7M co miesiąc także przy VAT 0 zł (termin
 *   ten sam, 25.), więc kwota zero daje przypomnienie o pliku (F11-B5), chyba
 *   że MF przyjął już plik wysłany z FaktWay za ten miesiąc (`jpkPrzyjete`).
 * - Teksty bez trybu rozkazującego i bez porad (D8); kwoty z podpisem „według
 *   Twoich danych i stawek na {rok}”, jak na stronie (NZ-TRESC-02).
 */

import { monthLabel, shiftMonth } from '@/lib/expenses/month';
import { formatIsoDatePl } from '@/lib/format/iso-date';
import { formatPlMoney } from '@/lib/format/pl';
import { addDaysToIsoDate } from '@/lib/format/warsaw-date';
import { terminDla, type Termin } from '@/lib/ksiegowosc/kalendarz';
import { podpisKwotMiesiaca } from '@/lib/ksiegowosc/przelew';
import type { WersjaProfilu } from '@/lib/ksiegowosc/profil';
import type { RodzajRozliczenia } from '@/lib/ksiegowosc/ten-miesiac';
import { aktualne, zaplacono, type PozycjaZeSkrotem, type Rozliczenie } from '@/lib/ksiegowosc/ten-miesiac-dane';

export const DNI_PRZED_TERMINEM = [5, 1] as const;
export type DniPrzed = (typeof DNI_PRZED_TERMINEM)[number];

/**
 * Rozliczenia z jednym terminem: ryczałt albo zaliczka PIT (K7) osobno,
 * składki ZUS razem (jedna deklaracja), VAT (K7.1) z terminem 25. Która
 * z dwóch pierwszych dotyczy firmy, rozstrzyga jej forma (`grupyFormy`);
 * VAT dotyczy płatnika VAT, co sprawdza zadanie.
 */
export type Grupa = 'ryczalt' | 'pit' | 'zus' | 'vat';
export const RODZAJE_GRUPY: Readonly<Record<Grupa, readonly RodzajRozliczenia[]>> = {
  ryczalt: ['ryczalt'],
  pit: ['pit'],
  zus: ['zus_spoleczne', 'zdrowotna'],
  vat: ['vat'],
};

const TERMIN_GRUPY: Readonly<Record<Grupa, 'ryczalt' | 'zaliczkaPit' | 'zus' | 'vatJpk'>> = {
  ryczalt: 'ryczalt',
  pit: 'zaliczkaPit',
  zus: 'zus',
  vat: 'vatJpk',
};

/** Grupy z przypomnienia, które dotyczą firmy o tej formie opodatkowania (VAT od formy nie zależy). */
export function grupyFormy(grupy: readonly Grupa[], forma: WersjaProfilu['forma']): Grupa[] {
  return grupy.filter((g) => g === 'zus' || g === 'vat' || (forma === 'ryczalt' ? g === 'ryczalt' : g === 'pit'));
}

export interface TerminNaDzis {
  /** RRRR-MM: miesiąc rozliczenia. */
  miesiac: string;
  /** Grupy z tym samym terminem: jedno przypomnienie zamiast dwóch. */
  grupy: Grupa[];
  termin: Termin;
  dni: DniPrzed;
  /** Etap w `tax_notifications` (00169): jeden na dzień terminu. */
  etap: string;
}

/**
 * Terminy, o których przypomina się dziś. Termin za miesiąc wypada
 * w następnym miesiącu, więc dziś liczą się rozliczenia za poprzedni miesiąc
 * (i bieżący, gdyby termin z kalendarza wypadł na początku miesiąca).
 * Ryczałt albo zaliczka PIT i składki z tym samym dniem terminu idą w jednym
 * przypomnieniu.
 */
export function terminyNaDzis(dzis: string): TerminNaDzis[] {
  const wynik = new Map<string, TerminNaDzis>();
  const biezacy = dzis.slice(0, 7);
  for (const miesiac of [shiftMonth(biezacy, -1), biezacy]) {
    const [rok, nr] = miesiac.split('-').map(Number);
    for (const grupa of ['ryczalt', 'pit', 'zus', 'vat'] as const) {
      const termin = terminDla({ rodzaj: TERMIN_GRUPY[grupa], rok, miesiac: nr });
      if (!termin) continue;
      for (const dni of DNI_PRZED_TERMINEM) {
        if (addDaysToIsoDate(dzis, dni) !== termin.faktyczny) continue;
        const etap = `termin-${dni}:${termin.faktyczny}`;
        const klucz = `${miesiac}|${etap}`;
        const obecny = wynik.get(klucz);
        if (obecny) obecny.grupy.push(grupa);
        else wynik.set(klucz, { miesiac, grupy: [grupa], termin, dni, etap });
      }
    }
  }
  return [...wynik.values()];
}

export interface PozycjaPrzypomnienia {
  rodzaj: RodzajRozliczenia;
  /** Kwota do zapłaty w groszach; `null`, gdy moduł jej nie liczy. */
  kwotaGr: number | null;
}

/**
 * Rozliczenia grup bez oznaczonej zapłaty. Etap ZUS bez składek społecznych
 * (ulga na start, etat obok) pomija składki społeczne, chyba że silnik daje
 * dla nich brak: ulga się skończyła (6 miesięcy), a ustawień nie zmieniono,
 * albo etap zmienia się w trakcie miesiąca (F11-B1). Wtedy przypomnienie
 * wymienia składki bez kwoty, jak przy każdym braku. Kwota zero nie wymaga
 * przypomnienia.
 */
export function niezaplacone(w: {
  grupy: readonly Grupa[];
  rozliczenia: readonly Rozliczenie[];
  /** Szkic z „Ten miesiąc”, gdy moduł liczy kwoty (`null`, gdy nie liczy). */
  pozycje: readonly PozycjaZeSkrotem[] | null;
  profil: WersjaProfilu;
  /** Czy MF przyjął już JPK_V7M za ten miesiąc wysłany z FaktWay (tego środowiska); tylko VAT 0 zł. */
  jpkPrzyjete?: boolean;
}): PozycjaPrzypomnienia[] {
  const wynik: PozycjaPrzypomnienia[] = [];
  const brakSkladek = w.pozycje?.some((p) => p.rodzaj === 'zus_spoleczne' && !p.ok) ?? false;
  for (const rodzaj of w.grupy.flatMap((g) => RODZAJE_GRUPY[g])) {
    const etapBezSkladek = w.profil.zusEtap === 'ulga_na_start' || w.profil.zusEtap === 'etat_obok';
    if (rodzaj === 'zus_spoleczne' && etapBezSkladek && !brakSkladek) continue;
    const ostatnia = aktualne(w.rozliczenia).get(rodzaj) ?? null;
    const szkic = w.pozycje?.find((p) => p.rodzaj === rodzaj && p.ok);
    // F11-B2: dane zmienione po zatwierdzeniu: kwota według bieżących danych.
    const zmienione = !!ostatnia && !!szkic?.ok && szkic.wejsciaHash !== ostatnia.wejsciaHash;
    const kwotaGr = zmienione && szkic?.ok ? szkic.kwotaGr : ostatnia ? ostatnia.kwotaGr : szkic?.ok ? szkic.kwotaGr : null;
    const zaplaconoGr = zaplacono(w.rozliczenia, rodzaj);
    if (kwotaGr === null) {
      // Bez kwoty: przypomnienie tylko wtedy, gdy nic nie jest oznaczone jako zapłacone.
      if (zaplaconoGr === 0) wynik.push({ rodzaj, kwotaGr: null });
      continue;
    }
    // F11-B5: VAT 0 zł nie ma zapłaty, ale JPK_V7M obowiązuje; kwota 0 zostaje w pozycji.
    if (rodzaj === 'vat' && kwotaGr <= 0 && zaplaconoGr === 0) {
      if (!w.jpkPrzyjete) wynik.push({ rodzaj, kwotaGr: 0 });
      continue;
    }
    if (kwotaGr - zaplaconoGr > 0) wynik.push({ rodzaj, kwotaGr: kwotaGr - zaplaconoGr });
  }
  return wynik;
}

const NAZWY: Readonly<Record<RodzajRozliczenia, string>> = {
  ryczalt: 'ryczałt',
  pit: 'zaliczka PIT',
  zus_spoleczne: 'składki społeczne',
  zdrowotna: 'składka zdrowotna',
  vat: 'VAT',
};

const zl = (gr: number) => `${formatPlMoney(gr / 100)} zł`;
const lista = (pozycje: readonly PozycjaPrzypomnienia[]) =>
  pozycje.map((p) => (p.kwotaGr === null ? NAZWY[p.rodzaj] : `${NAZWY[p.rodzaj]} ${zl(p.kwotaGr)}`)).join(', ');

export interface Tresc {
  tytul: string;
  tresc: string;
  /** Strona „Ten miesiąc” za ten miesiąc. */
  adres: string;
}

const adres = (miesiac: string) => `/reports/ten-miesiac?month=${Number(miesiac.slice(5, 7))}&year=${miesiac.slice(0, 4)}`;

/** Podpis kwot (NZ-TRESC-02), jak na stronie „Ten miesiąc”; treść bez kwot nie ma podpisu. */
function podpisKwot(miesiac: string, pozycje: readonly PozycjaPrzypomnienia[]): string | null {
  if (!pozycje.some((p) => p.kwotaGr !== null)) return null;
  return podpisKwotMiesiaca(miesiac, pozycje.some((p) => p.rodzaj === 'zdrowotna' && p.kwotaGr !== null));
}

/** VAT 0 zł (F11-B5): nie ma czego zapłacić, więc idzie osobnym zdaniem o JPK_V7M. */
const jestVatZero = (p: PozycjaPrzypomnienia) => p.rodzaj === 'vat' && p.kwotaGr === 0;

export function trescTerminu(w: { miesiac: string; termin: Termin; dni: DniPrzed; pozycje: readonly PozycjaPrzypomnienia[] }): Tresc {
  const data = formatIsoDatePl(w.termin.faktyczny);
  const kiedy = w.dni === 1 ? 'Jutro' : `Za ${w.dni} dni`;
  const doZaplaty = w.pozycje.filter((p) => !jestVatZero(p));
  const zdania = [`${kiedy}, ${data}, mija termin za ${monthLabel(w.miesiac)}.`];
  if (doZaplaty.length > 0 || w.pozycje.length === 0) zdania.push(`Bez oznaczonej zapłaty: ${lista(doZaplaty)}.`);
  if (doZaplaty.length < w.pozycje.length) {
    zdania.push(`VAT do zapłaty za ${monthLabel(w.miesiac)}: ${zl(0)}; JPK_V7M za ten miesiąc ma ten sam termin.`);
  }
  const podpis = podpisKwot(w.miesiac, w.pozycje);
  if (podpis) zdania.push(podpis);
  return {
    tytul: `Termin ${data}: rozliczenie za ${monthLabel(w.miesiac)}`,
    tresc: zdania.join(' '),
    adres: adres(w.miesiac),
  };
}

export function trescWyliczenia(w: { miesiac: string; pozycje: readonly PozycjaPrzypomnienia[] }): Tresc {
  return {
    tytul: `Rozliczenie za ${monthLabel(w.miesiac)} jest wyliczone`,
    tresc: [`Do zapłaty: ${lista(w.pozycje)}.`, podpisKwot(w.miesiac, w.pozycje), 'Szczegóły i zatwierdzenie są w zakładce „Ten miesiąc”.']
      .filter((z): z is string => z !== null)
      .join(' '),
    adres: adres(w.miesiac),
  };
}

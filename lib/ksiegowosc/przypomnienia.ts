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
 * - Teksty bez trybu rozkazującego i bez porad (D8).
 */

import { monthLabel, shiftMonth } from '@/lib/expenses/month';
import { formatIsoDatePl } from '@/lib/format/iso-date';
import { formatPlMoney } from '@/lib/format/pl';
import { addDaysToIsoDate } from '@/lib/format/warsaw-date';
import { terminDla, type Termin } from '@/lib/ksiegowosc/kalendarz';
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
 * (ulga na start, etat obok) pomija składki społeczne; kwota zero nie wymaga
 * przypomnienia.
 */
export function niezaplacone(w: {
  grupy: readonly Grupa[];
  rozliczenia: readonly Rozliczenie[];
  /** Szkic z „Ten miesiąc”, gdy moduł liczy kwoty (`null`, gdy nie liczy). */
  pozycje: readonly PozycjaZeSkrotem[] | null;
  profil: WersjaProfilu;
}): PozycjaPrzypomnienia[] {
  const wynik: PozycjaPrzypomnienia[] = [];
  for (const rodzaj of w.grupy.flatMap((g) => RODZAJE_GRUPY[g])) {
    if (rodzaj === 'zus_spoleczne' && (w.profil.zusEtap === 'ulga_na_start' || w.profil.zusEtap === 'etat_obok')) continue;
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

export function trescTerminu(w: { miesiac: string; termin: Termin; dni: DniPrzed; pozycje: readonly PozycjaPrzypomnienia[] }): Tresc {
  const data = formatIsoDatePl(w.termin.faktyczny);
  const kiedy = w.dni === 1 ? 'Jutro' : `Za ${w.dni} dni`;
  return {
    tytul: `Termin ${data}: rozliczenie za ${monthLabel(w.miesiac)}`,
    tresc: `${kiedy}, ${data}, mija termin za ${monthLabel(w.miesiac)}. Bez oznaczonej zapłaty: ${lista(w.pozycje)}.`,
    adres: adres(w.miesiac),
  };
}

export function trescWyliczenia(w: { miesiac: string; pozycje: readonly PozycjaPrzypomnienia[] }): Tresc {
  return {
    tytul: `Rozliczenie za ${monthLabel(w.miesiac)} jest wyliczone`,
    tresc: `Według Twoich danych: ${lista(w.pozycje)}. Szczegóły i zatwierdzenie są w zakładce „Ten miesiąc”.`,
    adres: adres(w.miesiac),
  };
}

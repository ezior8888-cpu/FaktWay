/**
 * Profil podatkowy firmy (plan księgowości JDG, krok K2, D3 i D4).
 *
 * Wersje w `tax_profiles` (migracja 00166) po dacie `valid_from`; profil
 * na dany dzień to wersja z największym `valid_from` nie późniejszym niż ten
 * dzień. Status VAT NIE jest częścią profilu: zostaje w
 * `tenants.vat_exemption_basis`, bo czyta go KSeF.
 *
 * Schemat jest jeden dla kreatora i akcji serwerowej. Reguła „forma tylko
 * od 1 stycznia” jest tu (komunikat dla klienta) i w wyzwalaczu bazy (00166),
 * żeby nie dało się jej ominąć zapisem z pominięciem akcji.
 *
 * Stawka ryczałtu pozycji faktury: `invoice_line_items.ryczalt_rate`, gdy
 * klient ją ustawił, a bez niej stawka domyślna z wersji profilu z dnia
 * sprzedaży (`stawkaRyczaltuPozycji`). Ścieżki wystawiania faktury K2 nie
 * rusza: historia wersji daje ten sam wynik bez zapisu przy każdej fakturze.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

import { formatIsoDatePl } from '@/lib/format/iso-date';
import { czyRachunekNrb } from '@/lib/ksiegowosc/mikrorachunek';

export const FORMY = ['ryczalt', 'skala', 'liniowy'] as const;
export type Forma = (typeof FORMY)[number];

export const ETAPY_ZUS = ['ulga_na_start', 'preferencyjny', 'pelny', 'etat_obok'] as const;
export type EtapZus = (typeof ETAPY_ZUS)[number];

export const NAZWY_FORM: Readonly<Record<Forma, string>> = {
  ryczalt: 'Ryczałt od przychodów ewidencjonowanych',
  skala: 'Skala podatkowa',
  liniowy: 'Podatek liniowy 19 %',
};

export const NAZWY_ETAPOW_ZUS: Readonly<Record<EtapZus, string>> = {
  ulga_na_start: 'Ulga na start',
  preferencyjny: 'Składki preferencyjne',
  pelny: 'Pełne składki',
  etat_obok: 'Etat obok działalności',
};

export const OPISY_ETAPOW_ZUS: Readonly<Record<EtapZus, string>> = {
  ulga_na_start: 'Pierwsze 6 miesięcy działalności bez składek społecznych; składka zdrowotna jest płatna.',
  preferencyjny: 'Składki społeczne od 30 % minimalnego wynagrodzenia, przez 24 miesiące po uldze na start.',
  pelny: 'Składki społeczne od 60 % prognozowanego przeciętnego wynagrodzenia.',
  etat_obok:
    'Umowa o pracę co najmniej za minimalne wynagrodzenie, więc z działalności płaci się tylko składkę zdrowotną.',
};

/** Strona MF z pełną listą stawek ryczałtu (odczyt 5.11.2026). */
export const STAWKI_RYCZALTU_ZRODLO = 'https://podatki.gov.pl/podatki-firmowe/pit/stawki-i-limity/';

/**
 * Stawki domyślne do wyboru, w punktach bazowych (1200 = 12 %). Opisy to
 * skrót grup z podatki.gov.pl („Stawki i limity”, 15.12.2025), bez
 * podpowiadania, która pasuje: tę decyzję podejmuje klient (D4, D8).
 * 12,5 % nie jest stawką do wyboru: dotyczy nadwyżki ponad próg w grupie 8,5 %.
 */
export const STAWKI_RYCZALTU: readonly { pb: number; etykieta: string; opis: string }[] = [
  { pb: 1700, etykieta: '17 %', opis: 'Wolne zawody.' },
  {
    pb: 1500,
    etykieta: '15 %',
    opis: 'Niektóre usługi niematerialne, m.in. pośrednictwo w sprzedaży hurtowej, reklama, fotografia, usługi kulturalne i rozrywkowe.',
  },
  {
    pb: 1400,
    etykieta: '14 %',
    opis: 'Opieka zdrowotna, usługi architektoniczne i inżynierskie, badania i analizy techniczne, specjalistyczne projektowanie.',
  },
  {
    pb: 1200,
    etykieta: '12 %',
    opis: 'Niektóre usługi informatyczne, m.in. oprogramowanie, doradztwo w zakresie sprzętu, zarządzanie sieciami i systemami.',
  },
  { pb: 1000, etykieta: '10 %', opis: 'Kupno i sprzedaż nieruchomości na własny rachunek.' },
  {
    pb: 850,
    etykieta: '8,5 %',
    opis:
      'M.in. usługi bez innej stawki i edukacja. Przy najmie, zakwaterowaniu, wynajmie nieruchomości i B+R do 100 000 zł przychodu, od nadwyżki 12,5 %.',
  },
  { pb: 550, etykieta: '5,5 %', opis: 'M.in. działalność wytwórcza, roboty budowlane, przewóz ładunków powyżej 2 ton.' },
  { pb: 300, etykieta: '3 %', opis: 'M.in. handel i gastronomia (bez napojów powyżej 1,5 % alkoholu).' },
];

const STAWKI_PB = new Set(STAWKI_RYCZALTU.map((s) => s.pb));

const DZIEN = /^\d{4}-\d{2}-\d{2}$/;
/** Najwcześniejsza data wersji: parametry modułu zaczynają się od 2026 r. (CHECK w 00166). */
export const PROFIL_OD_MIN = '2026-01-01';

function czyDataKalendarzowa(wpis: string): boolean {
  if (!DZIEN.test(wpis)) return false;
  const [r, m, d] = wpis.split('-').map(Number);
  const data = new Date(Date.UTC(r!, m! - 1, d!));
  return data.getUTCFullYear() === r && data.getUTCMonth() === m! - 1 && data.getUTCDate() === d;
}

const data = z
  .string()
  .refine(czyDataKalendarzowa, { message: 'Data w formacie DD.MM.RRRR.' });

/** Wejście kreatora i akcji. `nrsZus` z kreatora może mieć spacje. */
export const profilSchema = z
  .object({
    validFrom: data.refine((v) => v >= PROFIL_OD_MIN, { message: 'Ustawienia działają od 1 stycznia 2026 r.' }),
    forma: z.enum(FORMY, { message: 'Brak formy opodatkowania.' }),
    stawkaDomyslna: z.number().int().nullable(),
    zusEtap: z.enum(ETAPY_ZUS, { message: 'Brak rodzaju składek ZUS.' }),
    zusOd: data.nullable(),
    chorobowe: z.boolean(),
    nrsZus: z
      .string()
      .nullable()
      .transform((v) => {
        const cyfry = v?.replace(/\s/g, '') ?? '';
        return cyfry === '' ? null : cyfry;
      }),
  })
  .superRefine((p, ctx) => {
    if (p.forma === 'ryczalt' && (p.stawkaDomyslna === null || !STAWKI_PB.has(p.stawkaDomyslna))) {
      ctx.addIssue({ code: 'custom', path: ['stawkaDomyslna'], message: 'Przy ryczałcie potrzebna jest stawka.' });
    }
    if (p.forma !== 'ryczalt' && p.stawkaDomyslna !== null) {
      ctx.addIssue({ code: 'custom', path: ['stawkaDomyslna'], message: 'Stawka dotyczy tylko ryczałtu.' });
    }
    if ((p.zusEtap === 'ulga_na_start' || p.zusEtap === 'preferencyjny') && p.zusOd === null) {
      ctx.addIssue({ code: 'custom', path: ['zusOd'], message: 'Ulga na start i składki preferencyjne biegną od daty, która jest potrzebna.' });
    }
    if (p.nrsZus !== null && !czyRachunekNrb(p.nrsZus)) {
      ctx.addIssue({ code: 'custom', path: ['nrsZus'], message: 'To nie jest poprawny numer rachunku (26 cyfr).' });
    }
  });

export type ProfilWejscie = z.input<typeof profilSchema>;
export type Profil = z.output<typeof profilSchema>;

export interface WersjaProfilu extends Profil {
  id: string;
}

/** Wiersz `tax_profiles` (lokalny typ do czasu typów z produkcji po 00166). */
interface WierszProfilu {
  id: string;
  valid_from: string;
  forma: Forma;
  stawka_domyslna: number | null;
  zus_etap: EtapZus;
  zus_od: string | null;
  chorobowe: boolean;
  nrs_zus: string | null;
}

export const KOLUMNY_PROFILU = 'id, valid_from, forma, stawka_domyslna, zus_etap, zus_od, chorobowe, nrs_zus';

export function zWiersza(w: WierszProfilu): WersjaProfilu {
  return {
    id: w.id,
    validFrom: w.valid_from,
    forma: w.forma,
    stawkaDomyslna: w.stawka_domyslna,
    zusEtap: w.zus_etap,
    zusOd: w.zus_od,
    chorobowe: w.chorobowe,
    nrsZus: w.nrs_zus,
  };
}

export function doWiersza(tenantId: string, p: Profil) {
  return {
    tenant_id: tenantId,
    valid_from: p.validFrom,
    forma: p.forma,
    stawka_domyslna: p.stawkaDomyslna,
    zus_etap: p.zusEtap,
    zus_od: p.zusOd,
    chorobowe: p.chorobowe,
    nrs_zus: p.nrsZus,
  };
}

/** Wersja obowiązująca w dniu (RRRR-MM-DD); `null`, gdy żadna jeszcze nie działa. */
export function wersjaNa(wersje: readonly WersjaProfilu[], dzien: string): WersjaProfilu | null {
  let znaleziona: WersjaProfilu | null = null;
  for (const w of wersje) {
    if (w.validFrom <= dzien && (znaleziona === null || w.validFrom > znaleziona.validFrom)) znaleziona = w;
  }
  return znaleziona;
}

const PIERWSZY_STYCZNIA = /-01-01$/;

/**
 * Ta sama reguła co wyzwalacz 00166: wersja zmieniająca formę względem
 * sąsiedniej musi zaczynać się 1 stycznia. `null` = wolno zapisać; odmowa
 * mówi, od kiedy nowa forma może obowiązywać albo którą wersję poprawić.
 */
export function sprawdzZmianeFormy(wersje: readonly WersjaProfilu[], nowa: Profil): string | null {
  const inne = wersje.filter((w) => w.validFrom !== nowa.validFrom);
  const poprzednia = inne
    .filter((w) => w.validFrom < nowa.validFrom)
    .sort((a, b) => b.validFrom.localeCompare(a.validFrom))[0];
  const nastepna = inne
    .filter((w) => w.validFrom > nowa.validFrom)
    .sort((a, b) => a.validFrom.localeCompare(b.validFrom))[0];

  if (poprzednia && poprzednia.forma !== nowa.forma && !PIERWSZY_STYCZNIA.test(nowa.validFrom)) {
    const odStycznia = `${Number(nowa.validFrom.slice(0, 4)) + 1}-01-01`;
    return (
      `Forma opodatkowania zmienia się tylko od 1 stycznia, więc ${NAZWY_FORM[nowa.forma].toLowerCase()} ` +
      `może obowiązywać od ${formatIsoDatePl(odStycznia)}. ` +
      `Jeśli forma od początku była inna, wystarczy poprawić wersję od ${formatIsoDatePl(poprzednia.validFrom)}.`
    );
  }
  if (nastepna && nastepna.forma !== nowa.forma && !PIERWSZY_STYCZNIA.test(nastepna.validFrom)) {
    const od = formatIsoDatePl(nastepna.validFrom);
    return (
      `Forma opodatkowania zmienia się tylko od 1 stycznia, a od ${od} obowiązuje ` +
      `${NAZWY_FORM[nastepna.forma].toLowerCase()}. ` +
      `Wcześniejsza wersja może mieć tę samą formę albo wersję od ${od} można poprawić.`
    );
  }
  return null;
}

/**
 * Domyślny początek pierwszej wersji: 1 stycznia bieżącego roku, a gdy
 * działalność ruszyła później w tym roku, dzień startu.
 */
export function domyslnyPoczatek(dzis: string, startDzialalnosci: string | null): string {
  const poczatekRoku = `${dzis.slice(0, 4)}-01-01`;
  const od = startDzialalnosci && startDzialalnosci > poczatekRoku ? startDzialalnosci : poczatekRoku;
  return od < PROFIL_OD_MIN ? PROFIL_OD_MIN : od;
}

/**
 * Stawka ryczałtu pozycji w punktach bazowych: ta zapisana na pozycji
 * (`invoice_line_items.ryczalt_rate`, NUMERIC w procentach), a bez niej
 * domyślna z wersji profilu z dnia sprzedaży. `null` poza ryczałtem.
 */
export function stawkaRyczaltuPozycji(
  stawkaPozycji: number | string | null,
  wersja: WersjaProfilu | null,
): number | null {
  if (wersja?.forma !== 'ryczalt') return null;
  if (stawkaPozycji !== null && stawkaPozycji !== '') {
    const procent = Number(stawkaPozycji);
    if (Number.isFinite(procent)) return Math.round(procent * 100);
  }
  return wersja.stawkaDomyslna;
}

/** Komunikat, gdy na dany dzień nie ma profilu (fail-closed, bez trybu rozkazującego). */
export function komunikatBrakuProfilu(dzien: string): string {
  const [r, m, d] = dzien.split('-');
  return (
    `Bez ustawień podatkowych na ${d}.${m}.${r} nie liczymy podatku ani składek. ` +
    'Ustawienia są w Księgowości, w zakładce „Ustawienia podatkowe”.'
  );
}

function czyBrakTabeli(kod: string | undefined): boolean {
  // Przed wgraniem 00166: Postgres 42P01, PostgREST PGRST205.
  return kod === '42P01' || kod === 'PGRST205';
}

/**
 * Wersje profilu firmy rosnąco po `valid_from`, klientem z sesji (RLS).
 * Przed wgraniem 00166 brak tabeli to „brak profilu”, a nie awaria; każdy
 * inny błąd rzuca.
 */
export async function czytajWersjeProfilu(client: SupabaseClient, tenantId: string): Promise<WersjaProfilu[]> {
  const { data: wiersze, error } = await client
    .from('tax_profiles')
    .select(KOLUMNY_PROFILU)
    .eq('tenant_id', tenantId)
    .order('valid_from', { ascending: true });
  if (error) {
    if (czyBrakTabeli(error.code)) return [];
    throw new Error(`Nie można odczytać ustawień podatkowych: ${error.message}`);
  }
  return ((wiersze ?? []) as WierszProfilu[]).map(zWiersza);
}

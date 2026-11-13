/**
 * Warunki płatności faktury kosztowej z KSeF (plan kompletnej aplikacji,
 * krok 3.4; projekt N7 z `docs/koordynacja/PLAN-FINORA.md`).
 *
 * Odbiór skrzynki zapisuje same metadane, a pełny plik FA(3) leży w archiwum
 * firmy (`archiveInboxInvoiceXml`). Z pliku czytamy to, czego metadane nie
 * mają: termin (`Platnosc/TerminPlatnosci/Termin`), rachunek sprzedawcy
 * (`Platnosc/RachunekBankowy/NrRB`), MPP (`Adnotacje/P_18A`) i zapłatę
 * sprzed wystawienia (`Zaplacono` z `DataZaplaty` albo
 * `ZnacznikZaplatyCzesciowej`). Parser importu (`lib/import/fa3-parser.ts`,
 * `parsePlatnosc`) bierze pierwszy termin i odrzuca faktury w walutach, więc
 * tu jest osobny odczyt tej jednej sekcji z tymi samymi ustawieniami parsera.
 *
 * Zasada: przy wątpliwości koszt zostaje „do zapłaty” z uwagą i nigdy nie
 * znika z listy po cichu; niczego nie zgadujemy.
 *  - kilka terminów: najwcześniejszy, żeby lista nie przegapiła pierwszej raty;
 *  - termin nieczytelny albo tylko opisowy (`TerminOpis`): bez daty, z problemem
 *    albo opisem;
 *  - `P_18A` nieczytelne albo brak: `mpp = null`, ekran prosi o sprawdzenie;
 *  - zapłata częściowa (znacznik 1): suma wpłat do uwag;
 *  - zapłata w całości (`Zaplacono = 1` albo znacznik 2): dzień zapłaty; bez
 *    czytelnej daty koszt zostaje do zapłaty, z problemem.
 *
 * Moduł bez importów serwerowych: testy `tests/unit/koszty-warunki-platnosci.test.ts`.
 */

import { XMLParser } from 'fast-xml-parser';

import { readFa3Annotations, readTDataT } from '@/lib/xml/fa3-annotations';
import { roundToCents } from '@/lib/xml/invoice-calculator';

export interface WarunkiPlatnosciKosztu {
  /** Najwcześniejszy poprawny `Termin` (RRRR-MM-DD) albo `null`. */
  termin: string | null;
  /** Liczba poprawnych dat w `TerminPlatnosci`. */
  liczbaTerminow: number;
  /** `TerminOpis` (np. „14 dni od dostawy”), gdy faktura nie podaje daty. */
  terminOpis: string | null;
  /** Pierwszy poprawny `RachunekBankowy/NrRB`, bez spacji, wielkimi literami. */
  rachunek: string | null;
  /** Pierwszy poprawny `RachunekBankowyFaktora/NrRB`. */
  rachunekFaktora: string | null;
  /** `P_18A`: 1 → true, 2 → false, brak albo nieczytelne → null. */
  mpp: boolean | null;
  /** Dzień zapłaty z pliku (zapłata przed wystawieniem albo w częściach w całości). */
  zaplaconoDnia: string | null;
  /** Suma `KwotaZaplatyCzesciowej` przy znaczniku 1 (zapłacono w części). */
  zaplaconoCzesciowo: number | null;
  /** Kod `FormaPlatnosci` (1-7) albo `null`. */
  formaPlatnosci: string | null;
  /** `KodWaluty` z pliku. */
  waluta: string | null;
  /** Pola, których nie dało się odczytać (do uwag przy koszcie). */
  problemy: string[];
}

/** Ustawienia jak w `lib/import/fa3-parser.ts`: wartości jako tekst (26 cyfr rachunku nie staje się liczbą). */
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: true,
  parseTagValue: false,
  trimValues: true,
  removeNSPrefix: true,
});

/** `TNrRB` ze schematu FA(3): 10-34 znaki; po zdjęciu spacji tylko litery i cyfry. */
const NR_RB = /^[A-Z0-9]{10,34}$/;
/** `TKwotowy`: do dwóch miejsc po przecinku (kropka). */
const KWOTA = /^-?\d{1,16}(\.\d{1,2})?$/;

function pusteWarunki(problemy: string[]): WarunkiPlatnosciKosztu {
  return {
    termin: null,
    liczbaTerminow: 0,
    terminOpis: null,
    rachunek: null,
    rachunekFaktora: null,
    mpp: null,
    zaplaconoDnia: null,
    zaplaconoCzesciowo: null,
    formaPlatnosci: null,
    waluta: null,
    problemy,
  };
}

function wezel(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function lista(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function tekst(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/** Pierwszy poprawny `NrRB` z listy rachunków; zły numer to problem, nie rachunek do kopiowania. */
function pierwszyRachunek(value: unknown, nazwa: string, problemy: string[]): string | null {
  for (const r of lista(value)) {
    const surowy = tekst(wezel(r)?.NrRB);
    if (!surowy) continue;
    const numer = surowy.replace(/\s+/g, '').toUpperCase();
    if (NR_RB.test(numer)) return numer;
    problemy.push(`${nazwa} „${surowy}”`);
  }
  return null;
}

/** Odczyt sekcji płatności z pliku FA(3). Nigdy nie rzuca: zły plik to puste warunki z problemem. */
export function czytajWarunkiPlatnosci(xml: string): WarunkiPlatnosciKosztu {
  let parsed: unknown;
  try {
    parsed = xmlParser.parse(xml, true);
  } catch {
    return pusteWarunki(['plik XML nieczytelny']);
  }
  const fa = wezel(wezel(wezel(parsed)?.Faktura)?.Fa);
  if (!fa) return pusteWarunki(['brak sekcji Fa w pliku']);

  const problemy: string[] = [];
  const w = pusteWarunki(problemy);
  w.waluta = tekst(fa.KodWaluty)?.toUpperCase() ?? null;

  const { annotations } = readFa3Annotations(fa.Adnotacje);
  if (annotations.p18a === 1) w.mpp = true;
  else if (annotations.p18a === 2) w.mpp = false;
  else problemy.push('oznaczenie MPP (P_18A)');

  const p = wezel(fa.Platnosc);
  if (!p) return w;

  const terminy: string[] = [];
  for (const blok of lista(p.TerminPlatnosci)) {
    const b = wezel(blok);
    if (!b) continue;
    if (b.Termin !== undefined && b.Termin !== null) {
      const data = readTDataT(b.Termin);
      if (data) terminy.push(data);
      else problemy.push(`termin płatności „${tekst(b.Termin) ?? '?'}”`);
    }
    const opis = wezel(b.TerminOpis);
    if (opis && !w.terminOpis) {
      const czesci = [tekst(opis.Ilosc), tekst(opis.Jednostka), tekst(opis.ZdarzeniePoczatkowe)].filter(Boolean);
      w.terminOpis = czesci.length ? czesci.join(' ') : null;
    }
  }
  terminy.sort();
  w.termin = terminy[0] ?? null;
  w.liczbaTerminow = terminy.length;

  w.rachunek = pierwszyRachunek(p.RachunekBankowy, 'rachunek', problemy);
  w.rachunekFaktora = pierwszyRachunek(p.RachunekBankowyFaktora, 'rachunek faktora', problemy);
  w.formaPlatnosci = tekst(p.FormaPlatnosci);

  if (tekst(p.Zaplacono) === '1') {
    const data = readTDataT(p.DataZaplaty);
    if (data) w.zaplaconoDnia = data;
    else problemy.push(`data zapłaty „${tekst(p.DataZaplaty) ?? '?'}”`);
  }

  const znacznik = tekst(p.ZnacznikZaplatyCzesciowej);
  if (znacznik === '1' || znacznik === '2') {
    let suma = 0;
    let czytelne = true;
    const daty: string[] = [];
    for (const z of lista(p.ZaplataCzesciowa)) {
      const zw = wezel(z);
      const kwota = tekst(zw?.KwotaZaplatyCzesciowej);
      const data = readTDataT(zw?.DataZaplatyCzesciowej);
      if (kwota && KWOTA.test(kwota)) suma += Number(kwota);
      else czytelne = false;
      if (data) daty.push(data);
      else czytelne = false;
    }
    if (!czytelne) problemy.push('zapłata częściowa');
    if (znacznik === '1' && czytelne) w.zaplaconoCzesciowo = roundToCents(suma);
    if (znacznik === '2') {
      daty.sort();
      const ostatnia = daty[daty.length - 1];
      if (czytelne && ostatnia) w.zaplaconoDnia = ostatnia;
      else problemy.push('data zapłaty w częściach');
    }
  }

  return w;
}

/** Kolumny wydatku z 00177. `paid_at` tylko wtedy, gdy plik mówi o zapłacie. */
export interface KolumnyPlatnosciKosztu {
  payment_due_date: string | null;
  payment_account: string | null;
  payment_split: boolean | null;
  payment_terms: Record<string, string | number | null | string[]>;
  paid_at?: string;
}

export function kolumnyPlatnosci(w: WarunkiPlatnosciKosztu, odczytano: string): KolumnyPlatnosciKosztu {
  return {
    payment_due_date: w.termin,
    payment_account: w.rachunek,
    payment_split: w.mpp,
    payment_terms: {
      zrodlo: 'ksef_xml',
      odczytano,
      liczbaTerminow: w.liczbaTerminow,
      terminOpis: w.terminOpis,
      rachunekFaktora: w.rachunekFaktora,
      zaplaconoCzesciowo: w.zaplaconoCzesciowo,
      formaPlatnosci: w.formaPlatnosci,
      waluta: w.waluta,
      problemy: w.problemy,
    },
    ...(w.zaplaconoDnia ? { paid_at: w.zaplaconoDnia } : {}),
  };
}

/** Fakty z `payment_terms` po odczycie z bazy (JSON z zewnątrz: każde pole sprawdzone osobno). */
export interface UwagiPlatnosci {
  odczytano: string | null;
  liczbaTerminow: number;
  terminOpis: string | null;
  rachunekFaktora: string | null;
  zaplaconoCzesciowo: number | null;
  /** Kod `FormaPlatnosci` zapisany przy odczycie pliku (tekst, np. „1” to gotówka) albo `null`. */
  formaPlatnosci: string | null;
  problemy: string[];
}

export function uwagiPlatnosci(json: unknown): UwagiPlatnosci | null {
  const o = wezel(json);
  if (!o) return null;
  const napis = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const liczba = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    odczytano: napis(o.odczytano),
    liczbaTerminow: liczba(o.liczbaTerminow) ?? 0,
    terminOpis: napis(o.terminOpis),
    rachunekFaktora: napis(o.rachunekFaktora),
    zaplaconoCzesciowo: liczba(o.zaplaconoCzesciowo),
    formaPlatnosci: napis(o.formaPlatnosci),
    problemy: Array.isArray(o.problemy) ? o.problemy.filter((x): x is string => typeof x === 'string') : [],
  };
}

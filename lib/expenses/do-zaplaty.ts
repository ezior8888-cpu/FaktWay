/**
 * Lista „Do zapłaty” w Wydatkach (plan kompletnej aplikacji, krok 3.4,
 * część 1): niezapłacone koszty z terminem, od najbliższego terminu, z sumą,
 * przeterminowane osobno. Przy koszcie rachunek, kwota i gotowy tytuł
 * przelewu z numerem KSeF faktury zakupu (`tytulPrzelewu` z kroku 1.4; przy
 * MPP sam numer KSeF, RP-PLAT-01).
 *
 * Granice listy (fail-closed: koszt nie znika po cichu, a suma nie miesza walut):
 *  - tylko koszty w złotych z faktury KSeF; koszt z terminem w innej walucie
 *    albo bez faktury liczymy osobno (`pominiete`), ekran mówi, gdzie sprawdzić;
 *  - korekta na minus (brutto ≤ 0) nie jest do zapłaty;
 *  - termin dziś nie jest „po terminie”, wczoraj już tak (dzień w Polsce).
 *
 * Biała lista (RP-BL-01): od kwoty brutto ponad 15 000 zł koszt wymaga
 * sprawdzenia rachunku w wykazie podatników VAT (`wymagaBialejListy`).
 *
 * Moduł bez importów serwerowych: strona (serwer) liczy listę, ekran (przeglądarka)
 * ją pokazuje. Testy: `tests/unit/koszty-do-zaplaty.test.tsx`.
 */

import { poprawnyNumerKsef, tytulPrzelewu } from '@/lib/invoices/tytul-przelewu';
import { roundToCents } from '@/lib/xml/invoice-calculator';

import { uwagiPlatnosci } from './platnosc-kosztu';

/** Próg z art. 19 Prawa przedsiębiorców, do którego odnosi się sankcja za rachunek spoza wykazu. */
export const PROG_BIALEJ_LISTY_ZL = 15_000;

/** Wiersz z bazy: wydatek (kolumny 00177) i jego faktura KSeF. */
export interface WierszKosztuDoZaplaty {
  id: string;
  seller_name: string;
  seller_nip: string | null;
  document_number: string | null;
  gross_amount: number | string;
  vat_amount: number | string;
  payment_due_date: string | null;
  payment_account: string | null;
  payment_split: boolean | null;
  payment_terms: unknown;
  paid_at: string | null;
  faktura: { ksef_number: string | null; internal_number: string | null; currency: string | null } | null;
}

export interface KosztDoZaplaty {
  id: string;
  sprzedawca: string;
  nip: string | null;
  numerFaktury: string;
  numerKsef: string | null;
  termin: string;
  /** Dni do terminu; ujemne = po terminie. */
  dniDoTerminu: number;
  przeterminowany: boolean;
  /** Kwota do zapłaty (brutto bez wpłat częściowych z faktury). */
  kwota: number;
  brutto: number;
  vat: number;
  rachunek: string | null;
  /** MPP z faktury; `null` = nie wiadomo (uwaga przy koszcie). */
  mpp: boolean | null;
  tytul: string;
  wymagaBialejListy: boolean;
  /** Pełne zdania: co jest nie tak i co zrobić. */
  uwagi: string[];
}

export interface ListaDoZaplaty {
  pozycje: KosztDoZaplaty[];
  suma: number;
  przeterminowane: { liczba: number; suma: number };
  /** Koszty z terminem spoza listy (waluta obca albo bez faktury KSeF). */
  pominiete: number;
}

const DATA = /^\d{4}-\d{2}-\d{2}$/;

function dniMiedzy(od: string, do_: string): number {
  const ms = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
  return Math.round((ms(do_) - ms(od)) / 86_400_000);
}

const zl = (n: number) => n.toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function terminyText(n: number): string {
  const ostatnia = n % 10;
  const nastolatki = n % 100 >= 12 && n % 100 <= 14;
  return ostatnia >= 2 && ostatnia <= 4 && !nastolatki ? `${n} terminy` : `${n} terminów`;
}

function pozycja(w: WierszKosztuDoZaplaty, dzis: string): KosztDoZaplaty {
  const brutto = roundToCents(Number(w.gross_amount));
  const vat = roundToCents(Number(w.vat_amount));
  const termin = w.payment_due_date!;
  const dniDoTerminu = dniMiedzy(dzis, termin);
  const extra = uwagiPlatnosci(w.payment_terms);
  const numerKsef = poprawnyNumerKsef(w.faktura?.ksef_number);
  const numerFaktury = w.faktura?.internal_number?.trim() || w.document_number?.trim() || '';
  const uwagi: string[] = [];

  let kwota = brutto;
  const czesciowo = extra?.zaplaconoCzesciowo ?? null;
  if (czesciowo !== null) {
    if (czesciowo > 0 && czesciowo < brutto) {
      kwota = roundToCents(brutto - czesciowo);
      uwagi.push(`Faktura podaje wpłaty częściowe na ${zl(czesciowo)} zł, więc do zapłaty zostaje ${zl(kwota)} zł.`);
    } else {
      uwagi.push('Faktura podaje wpłaty częściowe, które nie pasują do jej kwoty. Kwotę do zapłaty sprawdź w fakturze.');
    }
  }
  if (!w.payment_account) {
    uwagi.push('Faktura nie podaje rachunku albo numeru nie dało się odczytać. Rachunek sprawdź w fakturze.');
  }
  if (extra?.rachunekFaktora) {
    uwagi.push(`Faktura podaje też rachunek faktora (${extra.rachunekFaktora}). Sprawdź w fakturze, na który rachunek zapłacić.`);
  }
  if (w.payment_split === null) {
    uwagi.push('Nie udało się odczytać z faktury, czy obowiązuje podzielona płatność (MPP). Sprawdź to w fakturze przed zapłatą.');
  }
  if ((extra?.liczbaTerminow ?? 0) > 1) {
    uwagi.push(`Faktura podaje ${terminyText(extra!.liczbaTerminow)} płatności. Lista pokazuje najwcześniejszy.`);
  }
  if (extra && extra.problemy.length > 0) {
    uwagi.push(`Części danych płatności nie dało się odczytać z pliku KSeF (${extra.problemy.join('; ')}). Sprawdź je w fakturze.`);
  }
  if (!numerKsef) {
    uwagi.push('Faktura nie ma poprawnego numeru KSeF, więc tytuł przelewu to sam numer faktury.');
  }

  return {
    id: w.id,
    sprzedawca: w.seller_name,
    nip: w.seller_nip,
    numerFaktury,
    numerKsef,
    termin,
    dniDoTerminu,
    przeterminowany: dniDoTerminu < 0,
    kwota,
    brutto,
    vat,
    rachunek: w.payment_account,
    mpp: w.payment_split,
    tytul: tytulPrzelewu(numerFaktury, numerKsef, { mpp: w.payment_split === true }),
    wymagaBialejListy: brutto > PROG_BIALEJ_LISTY_ZL,
    uwagi,
  };
}

/** `dzis` to dzień w Polsce (`todayInWarsaw()`), RRRR-MM-DD. */
export function listaDoZaplaty(wiersze: readonly WierszKosztuDoZaplaty[], dzis: string): ListaDoZaplaty {
  const pozycje: KosztDoZaplaty[] = [];
  let pominiete = 0;
  for (const w of wiersze) {
    if (w.paid_at || !w.payment_due_date || !DATA.test(w.payment_due_date)) continue;
    const brutto = Number(w.gross_amount);
    if (!Number.isFinite(brutto) || brutto <= 0) continue;
    if (w.faktura?.currency?.trim().toUpperCase() !== 'PLN') {
      pominiete += 1;
      continue;
    }
    pozycje.push(pozycja(w, dzis));
  }
  pozycje.sort((a, b) =>
    a.termin.localeCompare(b.termin) || b.kwota - a.kwota || a.id.localeCompare(b.id));

  const przeterminowane = pozycje.filter((p) => p.przeterminowany);
  return {
    pozycje,
    suma: roundToCents(pozycje.reduce((s, p) => s + p.kwota, 0)),
    przeterminowane: {
      liczba: przeterminowane.length,
      suma: roundToCents(przeterminowane.reduce((s, p) => s + p.kwota, 0)),
    },
    pominiete,
  };
}

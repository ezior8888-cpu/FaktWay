/**
 * VAT za miesiąc (plan księgowości JDG, K6): część deklaracyjna JPK_V7M
 * z tego samego kodu co plik (`summarizeJpkV7m`), w groszach. Kwoty
 * deklaracji są w pełnych złotych (art. 63 Ordynacji podatkowej), więc
 * grosze to zawsze wielokrotność 100.
 *
 * P_39 to nadwyżka z poprzedniej deklaracji (jej P_62). Silnik jej nie
 * zgaduje: przychodzi z wejścia, a skąd ją wziąć, rozstrzyga `vat-dane.ts`.
 *
 * Faktura, której plik nie wykaże poprawnie (odwrotne obciążenie, waluta,
 * dokument spoza FaktWay), daje brak z treścią generatora zamiast kwoty.
 */

import type { ExportExpense } from '@/lib/exports/data-fetcher';
import { JpkDocumentNotSupportedError, type JpkInvoice } from '@/lib/exports/jpk-fa-generator';
import { JpkV7mReverseChargeNotSupportedError, summarizeJpkV7m } from '@/lib/exports/jpk-v7m-generator';
import { OutgoingInvoiceCurrencyNotSupportedError } from '@/lib/exports/currency-guard';

export interface DaneVat {
  /** Sprzedaż miesiąca, ta sama co w pliku JPK_V7M. */
  sprzedaz: JpkInvoice[];
  /** Koszty miesiąca; do ewidencji VAT trafiają tylko te z prawem do odliczenia (`vatPurchases`). */
  koszty: ExportExpense[];
}

export interface WynikVat {
  /** P_38: podatek należny. */
  naleznyGr: number;
  /** P_39: nadwyżka z poprzedniej deklaracji. */
  nadwyzkaPoprzedniaGr: number;
  /** P_48: podatek naliczony do odliczenia razem z P_39. */
  naliczonyGr: number;
  /** P_51: do wpłaty. */
  doZaplatyGr: number;
  /** P_62: nadwyżka na następny okres (bez zwrotu na rachunek). */
  nadwyzkaNaNastepnyGr: number;
  liczbaSprzedazy: number;
  liczbaZakupow: number;
}

export type VatMiesiaca = ({ ok: true } & WynikVat) | { ok: false; brak: string };

export function vatMiesiaca(dane: DaneVat, nadwyzkaPoprzedniaZl: number): VatMiesiaca {
  if (!Number.isInteger(nadwyzkaPoprzedniaZl) || nadwyzkaPoprzedniaZl < 0) {
    return { ok: false, brak: 'Nadwyżka z poprzedniej deklaracji to pełne złote, nie mniej niż 0.' };
  }
  let s;
  try {
    s = summarizeJpkV7m({ issuedInvoices: dane.sprzedaz, expenses: dane.koszty, previousSurplus: nadwyzkaPoprzedniaZl });
  } catch (e) {
    if (
      e instanceof JpkV7mReverseChargeNotSupportedError ||
      e instanceof JpkDocumentNotSupportedError ||
      e instanceof OutgoingInvoiceCurrencyNotSupportedError
    ) {
      return { ok: false, brak: e.message };
    }
    throw e;
  }
  return {
    ok: true,
    naleznyGr: s.vatDue * 100,
    nadwyzkaPoprzedniaGr: s.previousSurplus * 100,
    naliczonyGr: s.vatDeductible * 100,
    doZaplatyGr: s.toPay * 100,
    nadwyzkaNaNastepnyGr: s.carryForward * 100,
    liczbaSprzedazy: s.salesCount,
    liczbaZakupow: s.purchaseCount,
  };
}

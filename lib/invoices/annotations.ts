/**
 * Adnotacje FA(3) zwykłej faktury — z formularza i ustawień firmy.
 *
 * Czyste funkcje: plik akcji ma `'use server'` i może eksportować wyłącznie
 * funkcje asynchroniczne, więc logika żyje tutaj i tu jest testowana.
 */
import type { Invoice, InvoiceLineItem } from '@/types/invoice';

import { isSubjectiveVatExemption } from './vat-exemption';

/**
 * Próg MPP: kwota należności ogółem PRZEKRACZA 15 000 zł (art. 108a ust. 1a
 * ustawy o VAT; tak też XSD FA(3)) przy towarze/usłudze z zał. 15 (AUD-96). Aplikacja nie zna zał. 15 —
 * podpowiada przy fakturze dla firmy powyżej progu, decyduje klient.
 */
export const SPLIT_PAYMENT_THRESHOLD_PLN = 15_000;

/** Obowiązkowe wyrazy na fakturze firmy na metodzie kasowej (art. 106e ust. 1 pkt 16). */
export const CASH_METHOD_LABEL = 'metoda kasowa';

/** Obowiązkowe wyrazy na fakturze z MPP (art. 106e ust. 1 pkt 18a). */
export const SPLIT_PAYMENT_LABEL = 'mechanizm podzielonej płatności';

/**
 * Obowiązkowe wyrazy, gdy podatek rozlicza nabywca (art. 106e ust. 1 pkt 18).
 * W XML to P_18=1 (`lib/xml/fa3-generator.ts`, JPK_FA P_18=true) przy każdej
 * pozycji z `REVERSE_CHARGE_RATES`: „oo” (art. 17 ust. 1 pkt 7 i 8) oraz
 * „np_ii” — usługa z art. 100 ust. 1 pkt 4 (art. 28b), przy której VAT
 * rozlicza nabywca w swoim państwie UE (AUD-70).
 */
export const REVERSE_CHARGE_LABEL = 'odwrotne obciążenie';

/** Obowiązkowe wyrazy przy samofakturowaniu (art. 106e ust. 1 pkt 17; P_17 = 1 w FA(3)). */
export const SELF_INVOICING_LABEL = 'samofakturowanie';

/**
 * Obowiązkowe wyrazy przy procedurze marży (art. 106e ust. 1 pkt 21 i 24), dosłownie jak
 * w opisach pól schematu FA(3) (`P_PMarzy_2`, `P_PMarzy_3_1`, `P_PMarzy_3_2`, `P_PMarzy_3_3`).
 * Dotyczy faktur z importu KSeF; FaktWay procedury marży nie wystawia.
 */
export const MARGIN_SCHEME_LABELS = {
  P_PMarzy_2: 'procedura marży dla biur podróży',
  P_PMarzy_3_1: 'procedura marży - towary używane',
  P_PMarzy_3_2: 'procedura marży - dzieła sztuki',
  P_PMarzy_3_3: 'procedura marży - przedmioty kolekcjonerskie i antyki',
} as const;

/** Stawki, przy których podatek rozlicza nabywca — P_18 i wyrazy `REVERSE_CHARGE_LABEL`. */
export const REVERSE_CHARGE_RATES: ReadonlySet<string> = new Set(['oo', 'np_ii']);

/** Czy faktura wymaga wyrazów „odwrotne obciążenie” — wystarczy jedna pozycja. */
export function hasReverseChargeLine(lines: ReadonlyArray<{ vatRate: string }>): boolean {
  return lines.some((l) => REVERSE_CHARGE_RATES.has(l.vatRate));
}

export function suggestsSplitPayment(grossTotal: number, buyerIsConsumer: boolean): boolean {
  return !buyerIsConsumer && grossTotal > SPLIT_PAYMENT_THRESHOLD_PLN;
}

export function buildInvoiceAnnotations(input: {
  lines: ReadonlyArray<Pick<InvoiceLineItem, 'vatRate'>>;
  /** Podstawa zwolnienia z VAT firmy (#60) — `null` = czynny podatnik. */
  vatExemptionBasis: string | null;
  splitPayment: boolean;
  /** Metoda kasowa VAT firmy (#76) — nie dotyczy firmy zwolnionej z VAT. */
  cashMethod?: boolean;
}): Invoice['annotations'] {
  const annotations: NonNullable<Invoice['annotations']> = {};
  // P_19A tylko przy pozycji zwolnionej — inaczej FA(3) dostaje P_19N.
  if (input.vatExemptionBasis && input.lines.some((l) => l.vatRate === 'zw')) {
    annotations.vatExemptionBasis = input.vatExemptionBasis;
  }
  // P_18A = 1 — mechanizm podzielonej płatności.
  if (input.splitPayment) annotations.splitPayment = 1;
  // P_16 = 1 — metoda kasowa. Firma zwolniona PODMIOTOWO (art. 113) nie
  // rozlicza VAT-u, więc metoda kasowa jej nie dotyczy; podstawa z art. 43
  // (sprzedaż zwolniona przedmiotowo) jej nie wyklucza — I2, AUD-68.
  if (input.cashMethod && !isSubjectiveVatExemption(input.vatExemptionBasis)) annotations.cashMethod = 1;
  return Object.keys(annotations).length > 0 ? annotations : undefined;
}

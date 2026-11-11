/**
 * Faktura do paragonu (FP) ze skrzynki KSeF a paragon z NIP wgrany wcześniej
 * (krok 1.3 planu kompletnej aplikacji, część 2; RP-FP-01, RP-KSEF-01).
 *
 * Jeden zakup, dwa dokumenty: zdjęcie paragonu z NIP (koszt spoza KSeF) i FP
 * z KSeF (koszt ze skrzynki). Bez połączenia koszt wchodzi do KPiR dwa razy.
 * Kandydat to koszt spoza KSeF, który `costDocumentType` uznaje za paragon
 * z NIP, z tym samym NIP sprzedawcy, tą samą kwotą brutto i datą paragonu
 * w oknie przed datą FP.
 *
 * Okno: żądanie FP przysługuje do końca trzeciego miesiąca po miesiącu
 * sprzedaży (art. 106b ust. 3 ustawy o VAT), a FP na żądanie zgłoszone po
 * miesiącu sprzedaży wystawia się do 15. dnia następnego miesiąca (art. 106i
 * ust. 6 pkt 1). Paragon z miesięcy od trzeciego przed miesiącem FP do dnia
 * FP to dopasowanie pewne; czwarty miesiąc wstecz to jeszcze kandydat, ale
 * tylko z ostrzeżeniem.
 *
 * Samo łączy się tylko dopasowanie pewne: XML potwierdza `Fa/FP = 1`, jest
 * dokładnie jeden kandydat, data paragonu w oknie pewnym i od 1.01.2027.
 * Paragon z NIP z 2026 r. był fakturą uproszczoną z odliczeniem VAT
 * w miesiącu, który klient mógł już rozliczyć, więc zmiana jego kosztu czeka
 * na decyzję klienta. Wszystko inne to ostrzeżenie na obu dokumentach.
 *
 * Moduł bez zależności od serwera (poza parserem XML), testowany wprost.
 */

import { parseFa3Xml } from '@/lib/import/fa3-parser';
import {
  costDocumentType,
  issueDayInWarsaw,
  RECEIPT_WITH_NIP_NOT_INVOICE_FROM,
} from '@/lib/expenses/vat-deduction-document';

/** Paragon z NIP nabywcy (faktura uproszczona), rodzaj z `costDocumentType`. */
const RECEIPT_WITH_NIP = 'simplified_invoice';

/** Ilu kandydatów zapisuje jedno dopasowanie (limit RPC 00175 to 50). */
export const RECEIPT_MATCH_LIMIT = 20;

export interface ReceiptMatchWindow {
  /** Pierwszy dzień szukania kandydatów (czwarty miesiąc przed miesiącem FP). */
  from: string;
  /** Pierwszy dzień dopasowania pewnego (trzeci miesiąc przed miesiącem FP). */
  sureFrom: string;
  /** Dzień wystawienia FP: paragon nie może być późniejszy. */
  to: string;
}

/** Pierwszy dzień miesiąca `months` miesięcy przed miesiącem dnia `day` (RRRR-MM-DD). */
export function firstDayMonthsBefore(day: string, months: number): string {
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7)) - 1;
  return new Date(Date.UTC(year, month - months, 1)).toISOString().slice(0, 10);
}

export function receiptMatchWindow(fpIssueDay: string): ReceiptMatchWindow {
  return {
    from: firstDayMonthsBefore(fpIssueDay, 4),
    sureFrom: firstDayMonthsBefore(fpIssueDay, 3),
    to: fpIssueDay,
  };
}

export function nip10(raw: string | null | undefined): string | null {
  const digits = (raw ?? '').replace(/\D/g, '');
  return digits.length === 10 ? digits : null;
}

function amountGr(raw: unknown): number | null {
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN;
  return Number.isFinite(value) ? Math.round(value * 100) : null;
}

/** Fakty FP potrzebne do szukania paragonu; `null`, gdy szukać nie ma czego. */
export interface FpInvoiceFacts {
  sellerNip: string;
  grossGr: number;
  issueDay: string;
}

export interface FpInvoiceRow {
  issue_date: string | null;
  currency: string | null;
  gross_total: number | string | null;
  seller_nip: string | null;
}

/**
 * Tylko faktura w złotych na kwotę dodatnią z NIP sprzedawcy i datą: paragon
 * jest w złotych, a korekta FP (kwota ujemna) nie jest drugim dokumentem
 * tego samego zakupu.
 */
export function fpInvoiceFacts(row: FpInvoiceRow, sellerNip: string | null): FpInvoiceFacts | null {
  if (row.currency?.trim().toUpperCase() !== 'PLN') return null;
  const grossGr = amountGr(row.gross_total);
  const nip = nip10(sellerNip);
  const issueDay = issueDayInWarsaw(row.issue_date);
  if (grossGr === null || grossGr <= 0 || !nip || !issueDay) return null;
  return { sellerNip: nip, grossGr, issueDay };
}

export interface ReceiptCandidateRow {
  id: string;
  issue_date: string;
  gross_amount: number | string;
  seller_nip: string | null;
  document_type: string | null;
  source: string | null;
  ksef_invoice_id: string | null;
  ocr_extracted_data?: unknown;
}

/** Kandydaci posortowani po dacie i id (kolejność bez wpływu na wynik RPC). */
export function receiptCandidates(fp: FpInvoiceFacts, rows: readonly ReceiptCandidateRow[]): ReceiptCandidateRow[] {
  const window = receiptMatchWindow(fp.issueDay);
  return rows
    .filter((row) => {
      if (row.source === 'ksef_inbox' || row.ksef_invoice_id) return false;
      if (costDocumentType(row) !== RECEIPT_WITH_NIP) return false;
      if (nip10(row.seller_nip) !== fp.sellerNip) return false;
      if (amountGr(row.gross_amount) !== fp.grossGr) return false;
      const day = issueDayInWarsaw(row.issue_date);
      return day !== null && day >= window.from && day <= window.to;
    })
    .sort((a, b) => a.issue_date.localeCompare(b.issue_date) || a.id.localeCompare(b.id));
}

/** `true`: FP, `false`: zwykła faktura, `null`: nie wiadomo (brak albo nieczytelny XML). */
export type FpMarker = boolean | null;

export function fpMarkerFromXml(xml: string): FpMarker {
  try {
    const text = xml.startsWith('﻿') ? xml.slice(1) : xml;
    return parseFa3Xml(text).ksefMarkers?.fp === true;
  } catch {
    return null;
  }
}

export function isSureReceiptMatch(fp: FpMarker, fpIssueDay: string, candidates: readonly ReceiptCandidateRow[]): boolean {
  if (fp !== true || candidates.length !== 1) return false;
  const day = issueDayInWarsaw(candidates[0]!.issue_date);
  const window = receiptMatchWindow(fpIssueDay);
  return day !== null && day >= window.sureFrom && day >= RECEIPT_WITH_NIP_NOT_INVOICE_FROM;
}

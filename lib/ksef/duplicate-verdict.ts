/**
 * Werdykt przy cudzym 440 (decyzja D-A4-1, plan „zero zgubionych faktur”):
 * KSeF ma już fakturę tej firmy o tym numerze (duplikat wykrywa po NIP
 * sprzedawcy, rodzaju faktury i P_2), a sesji oryginału nie ma w historii
 * tej faktury — albo jest, ale treść mogła się zmienić. Porównujemy plik
 * oryginału pobrany z KSeF z naszymi plikami.
 *
 * Kierunek bezpieczny prawnie: „numer zajęty” (klient wystawia z nowym
 * numerem) tylko wtedy, gdy oryginał NIE pochodzi z FaktWay. Każda
 * wątpliwość — oryginał z FaktWay o innej treści albo innej dacie
 * wytworzenia — idzie do operatora, bo może to być nasza wcześniejsza
 * wysyłka tej samej sprzedaży (ponowne wystawienie = dwie faktury).
 *
 * Czysty moduł: bez KSeF i bazy.
 */

import { createHash } from 'node:crypto';

import { DUPLICATE_DECISION_TEXTS } from './duplicate-decision';

/** `<SystemInfo>` w nagłówku każdego pliku FA(3) z FaktWay (fa3-generator, korekty, ZAL/ROZ). */
export const FAKTFLOW_SYSTEM_INFO = 'KSeF SaaS v1.0';

export type DuplicateVerdict =
  /**
   * Nasza faktura: oryginał to bajt w bajt bieżący plik — albo plik
   * wcześniejszej próby, której treść poza nagłówkiem jest ta sama co teraz.
   */
  | 'identical'
  /**
   * Nie wolno rozstrzygnąć automatycznie — operator: oryginał wygenerował
   * FaktWay (może to być nasza wcześniejsza wysyłka tej sprzedaży) albo ma
   * tę samą treść co nasza faktura, tylko inny nagłówek (ta sama sprzedaż).
   */
  | 'operator'
  /** Oryginał z innego programu o innej treści — numer zajęty. */
  | 'foreign';

export type OperatorReason = 'faktflow-original' | 'same-content-other-program';

export interface OriginalInvoiceSummary {
  systemInfo: string | null;
  number: string | null;
  issueDate: string | null;
  buyerNip: string | null;
  buyerName: string | null;
  gross: string | null;
  currency: string | null;
}

export interface DuplicateComparison {
  verdict: DuplicateVerdict;
  /** Przy `operator` — dlaczego automat nie rozstrzyga. */
  reason: OperatorReason | null;
  /** Skrót (Base64) naszego pliku zgodnego z oryginałem — przy `identical`. */
  matchedHash: string | null;
  /** Treść zgodna z naszą poza nagłówkiem (data wytworzenia, SystemInfo) — tylko informacja dla operatora. */
  sameContentExceptHeader: boolean;
  summary: OriginalInvoiceSummary;
}

const sha256Base64 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('base64');

/** Skrót z bazy (hex, `request_payload_hash`) → Base64 jak w KSeF; `null` dla wartości innej niż 64 znaki hex. */
export function hexHashToBase64(hex: string | null | undefined): string | null {
  return hex && /^[0-9a-f]{64}$/i.test(hex) ? Buffer.from(hex, 'hex').toString('base64') : null;
}

function element(xml: string, name: string): string | null {
  const m = new RegExp(`<(?:[\\w.-]+:)?${name}(?:\\s[^>]*)?>([^<]*)</(?:[\\w.-]+:)?${name}>`).exec(xml);
  return m ? m[1]!.trim() : null;
}

function block(xml: string, name: string): string | null {
  const m = new RegExp(`<(?:[\\w.-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?${name}>`).exec(xml);
  return m ? m[1]! : null;
}

/** Dane oryginału do komunikatu (klient decyduje: ta sama sprzedaż czy inna). */
export function summarizeInvoiceXml(xml: string): OriginalInvoiceSummary {
  const buyer = block(xml, 'Podmiot2') ?? '';
  return {
    systemInfo: element(xml, 'SystemInfo'),
    number: element(xml, 'P_2'),
    issueDate: element(xml, 'P_1'),
    buyerNip: element(buyer, 'NIP'),
    buyerName: element(buyer, 'Nazwa'),
    gross: element(xml, 'P_15'),
    currency: element(xml, 'KodWaluty'),
  };
}

/** Treść bez `<Naglowek>` i bez białych znaków między znacznikami — porównanie „ta sama treść, inny nagłówek”. */
function withoutHeader(xml: string): string {
  return xml
    .replace(/^﻿/, '')
    .replace(/<(?:[\w.-]+:)?Naglowek(?:\s[^>]*)?>[\s\S]*?<\/(?:[\w.-]+:)?Naglowek>/, '')
    .replace(/>\s+</g, '><')
    .trim();
}

/**
 * Porównanie pliku oryginału z naszymi plikami tej faktury.
 *  - `currentHashBase64` — skrót pliku, który właśnie odrzucono jako duplikat;
 *  - `earlierHashesBase64` — skróty wcześniejszych prób z historii;
 *  - `ourXml` — bieżący plik (treść do porównania poza nagłówkiem).
 * Zgodność z WCZEŚNIEJSZĄ próbą nie wystarcza: po powrocie do szkicu treść
 * mogła się zmienić, a wtedy numer KSeF należy do starej treści. Taka
 * zgodność jest „nasza” tylko, gdy treść poza nagłówkiem jest ta sama co teraz;
 * inaczej — operator.
 */
export function compareDuplicate(input: {
  originalBytes: Buffer;
  currentHashBase64: string | null | undefined;
  earlierHashesBase64: ReadonlyArray<string | null | undefined>;
  ourXml?: string | null;
}): DuplicateComparison {
  const originalXml = input.originalBytes.toString('utf8');
  const summary = summarizeInvoiceXml(originalXml);
  const sameContentExceptHeader = Boolean(input.ourXml) && withoutHeader(input.ourXml!) === withoutHeader(originalXml);
  const hash = sha256Base64(input.originalBytes);
  if (input.currentHashBase64 && input.currentHashBase64 === hash) {
    return { verdict: 'identical', reason: null, matchedHash: hash, sameContentExceptHeader: true, summary };
  }
  if (sameContentExceptHeader && input.earlierHashesBase64.some((h) => h && h === hash)) {
    return { verdict: 'identical', reason: null, matchedHash: hash, sameContentExceptHeader, summary };
  }
  if (summary.systemInfo === FAKTFLOW_SYSTEM_INFO) {
    return { verdict: 'operator', reason: 'faktflow-original', matchedHash: null, sameContentExceptHeader, summary };
  }
  // Inny program, ale ta sama treść co nasza — ta sama sprzedaż, nie „numer zajęty”.
  if (sameContentExceptHeader) {
    return { verdict: 'operator', reason: 'same-content-other-program', matchedHash: null, sameContentExceptHeader, summary };
  }
  return { verdict: 'foreign', reason: null, matchedHash: null, sameContentExceptHeader, summary };
}

function describeOriginal(ksefNumber: string, s: OriginalInvoiceSummary): string {
  const parts = [`numer KSeF ${ksefNumber}`];
  if (s.issueDate) parts.push(`z ${s.issueDate}`);
  const buyer = [s.buyerName, s.buyerNip ? `NIP ${s.buyerNip}` : null].filter(Boolean).join(', ');
  if (buyer) parts.push(`dla ${buyer}`);
  if (s.gross) parts.push(`na ${s.gross} ${s.currency ?? 'PLN'}`);
  return parts.join(', ');
}

/**
 * Komunikat `KSEF_NUMBER_TAKEN` dla klienta (trafia do `last_error`). Szkic po
 * „Wróć do szkicu” jest wycofany (wpis `number_taken`, 00148): nie wyślesz go,
 * a zwykłej faktury i zaliczki nie usuniesz — stąd bez „usuń go” (decyzje
 * Bartosza 07.10.2026 (3) i (9)). Tekst: `DUPLICATE_DECISION_TEXTS`, przegląd prawnika.
 */
export function numberTakenMessage(invoiceNumber: string, ksefNumber: string, s: OriginalInvoiceSummary): string {
  const T = DUPLICATE_DECISION_TEXTS;
  const opis = describeOriginal(ksefNumber, s);
  return s.systemInfo
    ? T.NUMBER_TAKEN_LAST_ERROR(invoiceNumber, opis, s.systemInfo)
    : T.NUMBER_TAKEN_LAST_ERROR_UNKNOWN_PROGRAM(invoiceNumber, opis);
}

/**
 * Komunikat werdyktu `known-number` (D-A4-1b-3 PR B, C16; trafia do `last_error`):
 * numer KSeF oryginału ma już dokument Y w FaktWay. Gdy oryginał nie może być
 * naszą wysyłką tego dokumentu, klient rozstrzyga na karcie faktury; gdy może
 * (`ownHistory`), klient decyzji nie dostaje — tekst nie mówi, że sprawa czeka
 * na niego. Bez „operatora” (reguła 07.10.2026).
 */
export function knownNumberVerdictMessage(
  ksefNumber: string,
  known: { id: string; internalNumber: string | null },
  ownHistory: boolean,
): string {
  const y = known.internalNumber ?? 'bez numeru';
  return ownHistory
    ? DUPLICATE_DECISION_TEXTS.KNOWN_NUMBER_LAST_ERROR_OWN(ksefNumber, y)
    : DUPLICATE_DECISION_TEXTS.KNOWN_NUMBER_LAST_ERROR(ksefNumber, y);
}

/**
 * D-A4-1b-3 PR C (5.1 punkt 3): `last_error` werdyktu `faktflow-original` —
 * `DUPLICATE_DECISION_TEXTS.FAKTFLOW.LAST_ERROR(K)` przy bramie `importable`,
 * `LAST_ERROR_REVIEW(K)` przy `review` (bez „operatora” i bez obietnicy decyzji;
 * trafia też do e-maila „odrzucona” i karty FLO). `operatorVerdictMessage`
 * zostaje dla `same-content-other-program`.
 */
export function faktflowOriginalVerdictMessage(ksefNumber: string, gateKind: 'importable' | 'review'): string {
  const FF = DUPLICATE_DECISION_TEXTS.FAKTFLOW;
  return gateKind === 'review' ? FF.LAST_ERROR_REVIEW(ksefNumber) : FF.LAST_ERROR(ksefNumber);
}

/** Komunikat werdyktu „operator” (trafia do `last_error`; przy panelu duplikatu klient go nie widzi — karta błędu jest ukryta). */
export function operatorVerdictMessage(ksefNumber: string, cmp: DuplicateComparison): string {
  const original = describeOriginal(ksefNumber, cmp.summary);
  if (cmp.reason === 'same-content-other-program') {
    return (
      `KSeF ma już fakturę o tym numerze (${original}) z tą samą treścią, wystawioną w programie ` +
      `„${cmp.summary.systemInfo ?? 'nieznany'}” — to ta sama sprzedaż. Nie wystawiaj jej ponownie; do uzgodnienia przez operatora.`
    );
  }
  return (
    `KSeF ma już fakturę o tym numerze (${original}) wygenerowaną przez FaktWay, ` +
    `ale ${cmp.sameContentExceptHeader ? 'z inną datą wytworzenia (treść zgodna)' : 'o innej treści'}. ` +
    'Najpewniej to wcześniejsza wysyłka tej faktury — do uzgodnienia przez operatora; nie wystawiaj jej ponownie.'
  );
}

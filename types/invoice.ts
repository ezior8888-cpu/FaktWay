/**
 * Model domenowy faktury FA(3) dla MVP (MŚP / JDG).
 *
 * UWAGA: to jest model UPROSZCZONY - wspiera najczęstsze scenariusze:
 * - faktura krajowa B2B
 * - sprzedaż towarów/usług z VAT 23/8/5/0/zw/oo
 * - zapłata przelewem / gotówką
 * - jedna waluta (PLN)
 *
 * Scenariusze pominięte w MVP (dodamy później):
 * - faktury eksportowe (WDT, WSTO)
 * - procedura marży
 * - samofakturowanie
 * - faktury VAT RR (rolnicze)
 * - załączniki
 * - korekty wielokrotne
 */

import type { AdvanceInvoiceData } from './invoice-types';

// ═══════════════════════════════════════════════════════════════
// Adresy i kontakty
// ═══════════════════════════════════════════════════════════════

export interface Address {
  /** Kod kraju ISO (PL dla Polski) */
  countryCode: 'PL' | string;
  /** Adres w jednej linii (ulica, numer domu, numer lokalu) */
  addressLine1: string;
  /** Druga linia adresu - kod pocztowy i miejscowość */
  addressLine2: string;
  /** Kod GLN lub numer budynku (opcjonalnie) */
  gln?: string;
}

// ═══════════════════════════════════════════════════════════════
// Podmioty (sprzedawca, nabywca)
// ═══════════════════════════════════════════════════════════════

export interface SellerParty {
  nip: string; // 10 cyfr, obowiązkowo
  name: string; // nazwa firmy
  address: Address;
  email?: string;
  phone?: string;
}

export interface BuyerParty {
  /** NIP dla VAT-owców polskich (10 cyfr).
   *  Dla zagranicznych: pole vatUeNumber.
   *  Dla osób fizycznych: jeden z: noIdMarker, pesel / nrInny (FA(3) Podmiot2). */
  nip?: string;
  /** NrPESEL w FA(3) — wyłącznie z nip/vatUeNumber/noIdMarker jako pojedynczy identyfikator. */
  pesel?: string;
  /** NrInny (np. dowód, paszport) — dla B2C bez NIP. */
  nrInny?: string;
  /** VAT UE (kraj + numer, np. DE123456789) dla kontrahentów zagranicznych */
  vatUeNumber?: string;
  /** Marker dla nabywcy bez identyfikatora podatkowego (B2C, pracownik) */
  noIdMarker?: boolean;
  name: string;
  address: Address;
  email?: string;
  /** Znacznik Jednostki Samorządu Terytorialnego (1 = JST, 2 = nie dotyczy).
   *  Obligatoryjne w FA(3). Domyślnie 2 w generatorze. */
  jst?: 1 | 2;
  /** Znacznik Grupy VAT (1 = członek Grupy VAT, 2 = nie dotyczy).
   *  Obligatoryjne w FA(3). Domyślnie 2 w generatorze. */
  gv?: 1 | 2;
}

// ═══════════════════════════════════════════════════════════════
// Pozycja faktury
// ═══════════════════════════════════════════════════════════════

export type VatRate =
  | '23' // podstawowa
  | '8' // obniżona
  | '5' // obniżona
  | '0' // zerowa (generator zmapuje na '0 KR' / '0 WDT' / '0 EX' wg kontekstu; MVP: '0 KR')
  | 'zw' // zwolniona z VAT (wymaga P_19 z podstawą prawną zamiast P_19N)
  | 'oo' // odwrotne obciążenie (wymaga P_18=1)
  | 'np' // nie podlega opodatkowaniu w kraju — XSD 'np I' (P_13_8)
  | 'np_ii'; // usługi z art. 100 ust. 1 pkt 4 (art. 28b, nabywca z UE) — XSD 'np II' (P_13_9, P_18=1); AUD-70

export interface InvoiceLineItem {
  /** Kolejny numer porządkowy pozycji (1, 2, 3...) */
  ordinal: number;
  /** Nazwa towaru/usługi (max 512 znaków w FA(3) - zmiana z FA(2) 256) */
  name: string;
  /** Kod CN (towary), PKWiU (usługi) albo GTIN - opcjonalne */
  classificationCode?: string;
  /** Jednostka miary (szt, kg, godz, usł, mies., itd.) */
  unit: string;
  /** Ilość - do 4 miejsc po przecinku */
  quantity: number;
  /** Cena jednostkowa netto - do 4 miejsc po przecinku */
  unitPriceNet: number;
  /**
   * Import KSeF z cenami brutto (art. 106e ust. 7 i 8; P_9B bez P_9A): pliku nie ma ceny netto,
   * więc `unitPriceNet` (0) nie jest ceną z faktury. Tylko dla PDF; generatory XML tego nie czytają.
   */
  unitPriceNetMissing?: true;
  /** Cena jednostkowa brutto z pliku (P_9B), gdy `unitPriceNetMissing`. */
  unitPriceGross?: number;
  /** Wartość netto pozycji (= quantity * unitPriceNet, zaokrąglone do 2 miejsc) */
  netAmount: number;
  /** Stawka VAT */
  vatRate: VatRate;
  /** Kwota VAT (= netAmount * rate / 100 dla stawek liczbowych; 0 dla zw/oo/np) */
  vatAmount: number;
  /** Wartość brutto pozycji */
  grossAmount: number;
}

// ═══════════════════════════════════════════════════════════════
// Płatność
// ═══════════════════════════════════════════════════════════════

export type PaymentMethod =
  | 'transfer' // przelew
  | 'cash' // gotówka
  | 'card' // karta
  | 'mobile' // płatność mobilna, FA(3) FormaPlatnosci 7; dziś tylko abonament opłacony BLIK-iem
  | 'other';

export interface PaymentInfo {
  /** Kwota do zapłaty (P_15 = suma brutto wszystkich pozycji) */
  amountDue: number;
  /** Waluta (MVP: tylko PLN) */
  currency: 'PLN';
  /** Termin płatności (data) */
  dueDate: string; // ISO YYYY-MM-DD
  /** Metoda płatności */
  method: PaymentMethod;
  /** Numer rachunku (IBAN) - dla przelewu */
  bankAccount?: string;
  /** Nazwa banku - opcjonalnie */
  bankName?: string;
}

// ═══════════════════════════════════════════════════════════════
// Faktura - pełny model
// ═══════════════════════════════════════════════════════════════

export type InvoiceType =
  | 'VAT' // faktura podstawowa
  | 'KOR' // korygująca
  | 'ZAL' // zaliczkowa
  | 'ROZ' // rozliczeniowa
  | 'UPR' // uproszczona
  | 'KOR_ZAL'
  | 'KOR_ROZ';

/**
 * Adnotacje FA(3) - sekcja obligatoryjna pod <Fa>.
 * Wszystkie flagi to XSD etd:TWybor1_2 (1 = tak, 2 = nie).
 * Domyślne wartości w generatorze to 2 (żaden marker nie jest ustawiony).
 */
export interface InvoiceAnnotations {
  /** P_16 - metoda kasowa (art. 19a ust. 5 pkt 1 lub art. 21 ust. 1) */
  cashMethod?: 1 | 2;
  /** P_17 - samofakturowanie (art. 106d ust. 1) */
  selfInvoicing?: 1 | 2;
  /** P_18 - odwrotne obciążenie. Gdy występuje linia z vatRate='oo', generator wymusi 1. */
  reverseCharge?: 1 | 2;
  /** P_18A - mechanizm podzielonej płatności (MPP, >= 15k z zał. nr 15) */
  splitPayment?: 1 | 2;
  /** P_23 - procedura uproszczona (drugi w kolejności podatnik, art. 135) */
  simplifiedProcedure?: 1 | 2;
  /**
   * P_19A/B/C - podstawa prawna zwolnienia (np. „art. 113 ust. 1 ustawy o VAT”).
   * Wymagana, gdy którakolwiek pozycja ma stawkę 'zw'. Na fakturze z FaktWay
   * pochodzi z ustawień firmy (`tenants.vat_exemption_basis`), nie z formularza;
   * na fakturze z importu KSeF — z pliku (C5b).
   */
  vatExemptionBasis?: string;
  /**
   * Rodzaj podstawy zwolnienia z pliku KSeF (C5b): P_19A przepis ustawy,
   * P_19B przepis dyrektywy, P_19C inna podstawa. Brak = P_19A (faktury FaktWay).
   */
  vatExemptionBasisKind?: 'P_19A' | 'P_19B' | 'P_19C';
  /** P_22 - dostawa nowych środków transportu (tylko z importu KSeF; FaktWay jej nie wystawia). */
  newMeansOfTransport?: 1 | 2;
  /** PMarzy - procedura marży z importu KSeF (FaktWay jej nie wystawia); brak = P_PMarzyN. */
  marginScheme?: 'P_PMarzy_2' | 'P_PMarzy_3_1' | 'P_PMarzy_3_2' | 'P_PMarzy_3_3';
}

/**
 * Faktura do paragonu (FP, plan kompletnej aplikacji, krok 1.2): dane paragonu
 * fiskalnego, do którego wystawiono fakturę. Art. 106h ust. 1 ustawy o VAT:
 * w dokumentacji zostaje numer dokumentu i numer unikatowy kasy z paragonu.
 * W FA(3) faktura dostaje `Fa/FP = 1` (art. 109 ust. 3d) i dane paragonu
 * w `Fa/DodatkowyOpis`. Reguły: `lib/invoices/receipt-invoice.ts`.
 */
export interface ReceiptInvoiceData {
  /** Numer paragonu (numer dokumentu z paragonu). */
  receiptNumber: string;
  /** Data paragonu, RRRR-MM-DD. Na fakturze do paragonu to także data sprzedaży. */
  receiptDate: string;
  /** Numer unikatowy kasy rejestrującej z paragonu, bez spacji, wielkimi literami. */
  cashRegisterNumber: string;
  /** Dzień żądania faktury (art. 106b ust. 3), gdy wcześniejszy niż dzień wystawienia. */
  requestDate?: string;
  /** Firma: wystawca potwierdził, że paragon ma NIP nabywcy (art. 106b ust. 5). */
  buyerNipOnReceipt?: true;
}

export interface Invoice {
  /** Wewnętrzny numer faktury (np. FV 2026/04/001) */
  internalNumber: string;
  /** Typ faktury */
  type: InvoiceType;
  /** Data wystawienia (ISO YYYY-MM-DD) - P_1 */
  issueDate: string;
  /** Data sprzedaży/dostawy towaru (jeśli != issueDate) - P_6 */
  saleDate?: string;

  seller: SellerParty;
  buyer: BuyerParty;

  /** Pozycje faktury */
  lines: InvoiceLineItem[];

  /** Suma netto wszystkich pozycji */
  netTotal: number;
  /** Suma VAT ze wszystkich pozycji */
  vatTotal: number;
  /** Suma brutto = netTotal + vatTotal */
  grossTotal: number;

  payment: PaymentInfo;

  /** Adnotacje (P_16, P_17, P_18, P_18A, P_23). Brakujące pola = 2 (nie dotyczy). */
  annotations?: InvoiceAnnotations;

  /** Uwagi dodatkowe - pole Stopka */
  notes?: string;

  /** Faktura do paragonu (FP). Brak = faktura bez paragonu. Tylko zwykła faktura VAT. */
  receipt?: ReceiptInvoiceData;

  /** Frozen source for ZAL XML; the worker must reject a different queued envelope. */
  advanceEnvelope?: AdvanceInvoiceData;
}

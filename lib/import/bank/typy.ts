/**
 * Typy importu wyciągu bankowego (plan kompletnej aplikacji, krok 3.2).
 * Moduł bez importów serwerowych: biorą go parsery, akcje, strona i ekran.
 */

/** Rozpoznane formaty plików; ta sama lista stoi w CHECK-u `payment_imports.file_format` (00180). */
export const BANK_FILE_FORMATS = ['mt940', 'camt053', 'csv_pko_elixir'] as const;
export type BankFileFormat = (typeof BANK_FILE_FORMATS)[number];

/** Jedna operacja z wyciągu. Kwota w groszach na liczbie całkowitej: plus to wpływ, minus wypływ. */
export interface BankOperation {
  /** Własny rachunek z wyciągu: `PL` + 26 cyfr albo IBAN innego kraju. */
  account: string;
  /** Dzień zaksięgowania na rachunku (RRRR-MM-DD); to data wpłaty przy potwierdzeniu. */
  bookingDate: string;
  /** Data waluty, gdy plik ją podaje. */
  valueDate: string | null;
  amountGrosze: number;
  /** Kod waluty ISO 4217 wielkimi literami. */
  currency: string;
  counterpartyName: string | null;
  counterpartyAccount: string | null;
  title: string | null;
  /** Referencja banku (numer operacji); tylko do wglądu, klucz duplikatu jej nie używa. */
  bankReference: string | null;
}

export type BankParseErrorCode = 'empty' | 'unknown_format' | 'invalid_file' | 'no_account';

export type BankParseResult =
  | {
      ok: true;
      format: BankFileFormat;
      operations: BankOperation[];
      /** Wpisy pominięte przez parser: operacje oczekujące (CAMT), linie informacyjne z kwotą zero. */
      skipped: number;
    }
  | { ok: false; code: BankParseErrorCode };

/** Błąd w środku pliku: parser przerywa cały plik, zamiast zgadywać kwotę albo datę. */
export class BankFileError extends Error {
  constructor(public readonly code: BankParseErrorCode = 'invalid_file') {
    super(code);
    this.name = 'BankFileError';
  }
}

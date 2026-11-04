import {
  isExportFormatSuspended,
  replacementForFormat,
  SUSPENDED_EXPORT_FORMATS,
} from '@/lib/exports/suspended-formats';

import { formatLabel, type ManualExportJobWithFiles } from './export-formats';
import { presetHref } from './export-period';

/**
 * Wyjście z nieudanego eksportu (poprawka Bartosza 21.10.2026:
 * przeprojektowanie Księgowości). Historia pokazywała sam powód odmowy;
 * teraz obok stoi przycisk, który prowadzi tam, gdzie da się to naprawić.
 *
 * Moduł działa w przeglądarce, więc nie importuje generatorów z `lib/exports`
 * (ciągną kod serwera). Rozpoznajemy powody po fragmentach ich treści, a test
 * `eksport-naprawy` buduje prawdziwe klasy błędów z `lib/` i sprawdza, że
 * każda trafia we właściwy przycisk — zmiana komunikatu w `lib/` bez zmiany
 * tutaj zapali test. Nie ma przycisku „Bez korekt”: JPK_FA dla urzędu bez
 * korekt byłby niepełnym plikiem (rada z `lib/`: KPiR albo CSV).
 */

export type ExportFix =
  | { kind: 'link'; label: string; href: string }
  | { kind: 'rerun'; label: string };

type FixableJob = Pick<ManualExportJobWithFiles, 'status' | 'format' | 'error_message' | 'period_start' | 'period_end'>;

/** = `JPK_DOCUMENT_REFUSAL_PREFIX` z `lib/exports/jpk-fa-generator.ts` (pilnuje test). */
export const DOCUMENT_REFUSAL_PREFIX = 'JPK wstrzymany:';

/** Fragmenty komunikatów z `lib/` — każdy przypięty testem do prawdziwej klasy błędu. */
export const FIX_MARKERS = {
  /** MissingTaxOfficeError */
  taxOffice: 'Ustaw urząd skarbowy',
  /** MissingIssuerAddressError */
  issuerAddress: 'adresu firmy w rejestrze GUS',
  /** MissingTaxpayerEmailError (JPK_V7M) */
  taxpayerEmail: 'adresu e-mail podatnika',
  /**
   * JpkFaCorrectionNotSupportedError. Nie samo „faktura korygująca”: tak
   * zaczyna się też odmowa dokumentu dla zaimportowanej korekty („to
   * zaimportowana z KSeF faktura korygująca”), a ta ma prowadzić do faktury.
   */
  jpkCorrections: 'JPK_FA z korektami jeszcze nie działa',
  /** KsefExpenseCurrencyNotSupportedError */
  ksefExpense: 'koszt ze skrzynki KSeF',
  /** OutgoingInvoiceCurrencyNotSupportedError, JpkFa…, Csv…, Optima…ForeignCurrencyNotSupportedError */
  currency: ['faktura sprzedaży nie ma potwierdzonej waluty PLN', 'faktura walutowa', 'potwierdzoną walutę PLN'],
} as const;

/**
 * Numer faktury z odmowy dokumentu: „JPK wstrzymany: faktura FV/1 (KSeF …) ma …”.
 * Numer może mieć spacje, więc tniemy przed „(KSeF” albo przed powodem
 * („ma …”, „to …”, „jest …”); w razie wątpliwości — pierwsze słowo.
 */
export function refusedInvoiceNumber(message: string): string | null {
  const head = `${DOCUMENT_REFUSAL_PREFIX} faktura `;
  if (!message.startsWith(head)) return null;
  const rest = message.slice(head.length);
  const m = /^(.+?)(?: \(KSeF [^)]*\))? (?:ma|to|jest) /.exec(rest);
  const number = (m?.[1] ?? rest.split(/\s+/)[0] ?? '').trim();
  return number || null;
}

/** Przycisk naprawy dla nieudanego albo wygasłego eksportu; `null` dla pozostałych. */
export function exportFixFor(job: FixableJob): ExportFix | null {
  if (job.status !== 'failed' && job.status !== 'expired') return null;

  // Format wyłączony — przed „Wygeneruj ponownie”, bo ponowienie i tak by odmówiło.
  if (isExportFormatSuspended(job.format)) {
    const replacement = replacementForFormat(job.format);
    return {
      kind: 'link',
      label: `Wybierz ${formatLabel(replacement)}`,
      href: presetHref(replacement, job.period_start, job.period_end),
    };
  }

  if (job.status === 'expired') return { kind: 'rerun', label: 'Wygeneruj ponownie' };

  const message = job.error_message ?? '';

  if (message.includes(FIX_MARKERS.taxOffice)) {
    return { kind: 'link', label: 'Ustaw urząd', href: '/settings/accountant' };
  }
  if (message.includes(FIX_MARKERS.issuerAddress) || message.includes(FIX_MARKERS.taxpayerEmail)) {
    return { kind: 'link', label: 'Dane firmy', href: '/settings' };
  }
  if (message.includes(FIX_MARKERS.jpkCorrections)) {
    return { kind: 'link', label: 'Wybierz CSV', href: presetHref('csv_universal', job.period_start, job.period_end) };
  }
  const invoiceNumber = refusedInvoiceNumber(message);
  if (invoiceNumber) {
    return { kind: 'link', label: 'Otwórz fakturę', href: `/invoices?q=${encodeURIComponent(invoiceNumber)}` };
  }
  if (message.includes(FIX_MARKERS.ksefExpense)) {
    return { kind: 'link', label: 'Skrzynka KSeF', href: '/inbox' };
  }
  if (FIX_MARKERS.currency.some((marker) => message.includes(marker))) {
    return { kind: 'link', label: 'Faktury', href: '/invoices' };
  }
  return { kind: 'rerun', label: 'Ponów' };
}

/** Odpowiedzi `startExportAction` o datach — klient poprawia okres, nie format. */
const DATE_ERRORS = ['Niepoprawny format dat (YYYY-MM-DD)', 'Data końcowa < początkowa'];

/**
 * Błąd zlecenia eksportu po ludzku. Powody wyłączenia formatu idą dalej bez
 * zmian; surowe teksty (np. błąd bazy przy zapisie joba) zastępujemy prośbą
 * o ponowienie — nie pokazujemy klientowi szczegółów technicznych.
 */
export function friendlyStartError(error: string): string {
  if (DATE_ERRORS.includes(error)) return 'Popraw daty okresu.';
  if (Object.values(SUSPENDED_EXPORT_FORMATS).includes(error)) return error;
  return 'Nie udało się zlecić eksportu. Spróbuj ponownie.';
}

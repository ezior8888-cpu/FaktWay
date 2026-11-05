import type { Database } from '@/types/database';

/**
 * Zakres eksportu: co wchodzi do pliku danego formatu (FIR-01, 27.10.2026).
 *
 * Jedno źródło reguły dla formularza, ponowienia z historii, akcji serwera,
 * portalu księgowej i runnera. Do 27.10 znał ją tylko formularz w przeglądarce,
 * a runner ufał flagom joba — Co-Pilot z odznaczonymi „Fakturami korygującymi”
 * wysyłał KPiR bez zaliczek, ROZ i korekt, a z odznaczonymi „Fakturami
 * wystawionymi” — KPiR bez przychodu. Moduł bez kodu serwera i bez Reacta:
 * importuje go i komponent kliencki, i worker.
 */

export type ExportFormatValue = Database['public']['Enums']['export_format_enum'];

/** O co prosi człowiek (pola formularza) albo ustawienia Co-Pilota (kolumny joba). */
export interface ExportIncludes {
  includeIssued: boolean;
  includeReceived: boolean;
  includeCorrections: boolean;
}

/**
 * Zakres po regule formatu. Trzy flagi trafiają do `export_jobs` i mówią, co
 * plik obejmuje — widok `ksef_history_export_changes` (00155) czyta
 * `include_issued` / `include_received`, żeby ostrzec o fakturach, które
 * doszły po eksporcie.
 */
export interface ExportScope extends ExportIncludes {
  /** Koszty z `expenses` (faktury otrzymane i paragony) — KPiR i JPK_V7M. */
  includeExpenses: boolean;
  /** Które faktury czytać z `invoices`: tylko te, które generator formatu czyta. */
  invoiceDirection: 'issued' | 'received' | 'both';
}

/** Wartości domyślne prośby — te same co kolumny `export_jobs` (00024). */
const DEFAULT_REQUEST: ExportIncludes = {
  includeIssued: true,
  includeReceived: false,
  includeCorrections: true,
};

/**
 * Format spoza reguły — enum w bazie wyprzedza kod. Ponowienie nic nie
 * zmieni: runner kończy job bez prób, a ekrany pokazują bezpieczny wariant.
 */
export class UnknownExportFormatError extends Error {
  constructor(format: string) {
    super(`Brak zakresu eksportu dla formatu ${format}`);
    this.name = 'UnknownExportFormatError';
  }
}

/**
 * - KPiR i JPK_V7M: zawsze cała sprzedaż (z zaliczkami, ROZ i korektami)
 *   i koszty — jak KPiR na ekranie (`lib/reports/kpir-data.ts`). Koszty idą
 *   z wydatków, więc z `invoices` czytamy tylko wystawione: generator nie
 *   czyta faktur otrzymanych, a ich pobieranie poszerzało kontrolę środowiska
 *   KSeF i dokładało zakupy do sumy joba. `includeReceived` znaczy tu „koszty
 *   w pliku” (także faktury ze skrzynki KSeF).
 * - JPK_FA: tylko faktury wystawione; korekty według prośby (generator ich
 *   odmawia — C-01 — a Co-Pilot sprawdza je tą samą flagą w `jpkFaBlocker`).
 * - CSV i formaty programów: według prośby. Bez żadnego kierunku — wystawione,
 *   jak runner robił dotąd.
 */
export function exportScopeFor(
  format: ExportFormatValue,
  requested: Partial<ExportIncludes> = {},
): ExportScope {
  const ask = { ...DEFAULT_REQUEST, ...definedOnly(requested) };
  switch (format) {
    case 'kpir_excel':
    case 'jpk_v7m':
      return {
        includeIssued: true,
        includeReceived: true,
        includeCorrections: true,
        includeExpenses: true,
        invoiceDirection: 'issued',
      };
    case 'jpk_fa':
      return {
        includeIssued: true,
        includeReceived: false,
        includeCorrections: ask.includeCorrections,
        includeExpenses: false,
        invoiceDirection: 'issued',
      };
    case 'csv_universal':
    case 'comarch_optima':
    case 'insert_subiekt':
    case 'symfonia':
    case 'wapro': {
      const includeIssued = ask.includeIssued || !ask.includeReceived;
      return {
        includeIssued,
        includeReceived: ask.includeReceived,
        includeCorrections: ask.includeCorrections,
        includeExpenses: false,
        invoiceDirection: includeIssued && ask.includeReceived ? 'both' : includeIssued ? 'issued' : 'received',
      };
    }
    default: {
      const unexpected: never = format;
      throw new UnknownExportFormatError(String(unexpected));
    }
  }
}

/** Same flagi zakresu — do zapisu w `export_jobs` i do `startExportAction`. */
export function exportIncludesFor(
  format: ExportFormatValue,
  requested: Partial<ExportIncludes> = {},
): ExportIncludes {
  const { includeIssued, includeReceived, includeCorrections } = exportScopeFor(format, requested);
  return { includeIssued, includeReceived, includeCorrections };
}

const INCLUDE_KEYS = ['includeIssued', 'includeReceived', 'includeCorrections'] as const;

/** Tylko trzy flagi; `undefined` z pominiętego pola nie nadpisuje wartości domyślnej. */
function definedOnly(requested: Partial<ExportIncludes>): Partial<ExportIncludes> {
  const out: Partial<ExportIncludes> = {};
  for (const key of INCLUDE_KEYS) {
    const value = requested[key];
    if (typeof value === 'boolean') out[key] = value;
  }
  return out;
}

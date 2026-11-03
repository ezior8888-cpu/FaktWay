import {
  RiFileChart2Line,
  RiFileCodeLine,
  RiFileExcel2Line,
  RiFileTextLine,
  type RemixiconComponentType,
} from '@remixicon/react';

import { exportIncludesFor, UnknownExportFormatError, type ExportIncludes } from '@/lib/exports/export-scope';
import { isExportFormatSuspended } from '@/lib/exports/suspended-formats';
import { Constants, type Tables } from '@/types/database';

/**
 * Formaty eksportu dla ekranu Eksport (poprawka Bartosza 21.10.2026:
 * przeprojektowanie Księgowości). Moduł bez Reacta i bez kodu serwera —
 * czytają go formularz, historia, `export-fixes` i strona.
 *
 * Błąd z podwójnym kluczem: dawna lista doklejała ręcznie `jpk_v7m`
 * („regenerujemy typy przed Fazą 35”), a enum w `types/database.ts` ma go od
 * dawna — JPK_V7M był na liście dwa razy, powód wyłączenia też, i React
 * zgłaszał dwa elementy z tym samym kluczem („1 Issue” na /reports/exports).
 * Teraz lista idzie wprost z enuma, bez duplikatów, a klucz to format.
 */

export type ExportFormat = Tables<'export_jobs'>['format'];
export type ExportJobStatus = Tables<'export_jobs'>['status'];

/** Wiersz joba + pliki z nested select (historia ręcznych eksportów). */
export type ManualExportJobWithFiles = Tables<'export_jobs'> & {
  export_files: Pick<Tables<'export_files'>, 'id' | 'filename' | 'format' | 'size_bytes' | 'download_count'>[];
};

/** Formaty do wyboru w formularzu — KPiR pierwszy, bo to comiesięczny plik dla księgowej. */
export type EnabledExportFormat = 'kpir_excel' | 'csv_universal' | 'jpk_fa';

export const ENABLED_EXPORT_FORMATS: readonly EnabledExportFormat[] = (
  ['kpir_excel', 'csv_universal', 'jpk_fa'] as const
).filter((format) => !isExportFormatSuspended(format));

/** Formaty wyłączone (każdy raz) — z enuma bazy, nie z ręcznej listy. */
export const SUSPENDED_FORMATS: readonly ExportFormat[] = Array.from(
  new Set(Constants.public.Enums.export_format_enum),
).filter(isExportFormatSuspended);

export const FORMAT_LABELS: Readonly<Record<ExportFormat, string>> = {
  jpk_fa: 'JPK_FA(4)',
  jpk_v7m: 'JPK_V7M',
  kpir_excel: 'KPiR Excel',
  comarch_optima: 'Comarch Optima',
  insert_subiekt: 'Insert Subiekt',
  symfonia: 'Symfonia',
  wapro: 'Wapro',
  csv_universal: 'CSV uniwersalny',
};

/** Nazwa formatu dla człowieka; nieznana wartość nigdy nie trafia na ekran surowo. */
export function formatLabel(format: string): string {
  return Object.prototype.hasOwnProperty.call(FORMAT_LABELS, format)
    ? FORMAT_LABELS[format as ExportFormat]
    : 'Inny format';
}

/** Do czego służy plik — nazwy programów, które go wczytują. */
export const FORMAT_PURPOSE: Readonly<Record<EnabledExportFormat, string>> = {
  kpir_excel: 'Księga dla księgowej',
  csv_universal: 'Optima, Subiekt i inne programy',
  jpk_fa: 'Urząd, Symfonia, Wapro',
};

export const FORMAT_ICONS: Readonly<Record<ExportFormat, RemixiconComponentType>> = {
  kpir_excel: RiFileExcel2Line,
  csv_universal: RiFileTextLine,
  jpk_fa: RiFileCodeLine,
  jpk_v7m: RiFileChart2Line,
  comarch_optima: RiFileChart2Line,
  insert_subiekt: RiFileChart2Line,
  symfonia: RiFileChart2Line,
  wapro: RiFileChart2Line,
};

/** Krótkie nazwy do linii „Wyłączone: …” pod kafelkami formatów. */
const SUSPENDED_SHORT_LABELS: Readonly<Partial<Record<ExportFormat, string>>> = {
  jpk_v7m: 'JPK_V7M',
  comarch_optima: 'Optima',
  insert_subiekt: 'Subiekt',
  symfonia: 'Symfonia',
  wapro: 'Wapro',
};

/** Wyłączone formaty do pokazania: JPK pierwszy, reszta w kolejności enuma (każdy raz). */
export function suspendedFormatsInOrder(): ExportFormat[] {
  return [...SUSPENDED_FORMATS].sort((a, b) => Number(b.startsWith('jpk')) - Number(a.startsWith('jpk')));
}

/** „JPK_V7M, Optima, Subiekt, Symfonia, Wapro”. */
export function suspendedFormatsSummary(): string {
  return suspendedFormatsInOrder()
    .map((format) => SUSPENDED_SHORT_LABELS[format] ?? formatLabel(format))
    .join(', ');
}

export type { ExportIncludes };

export interface ExportScopeState {
  csv: { issued: boolean; received: boolean; corrections: boolean };
  jpkCorrections: boolean;
}

/**
 * Co wysyłamy do `startExportAction`: pola formularza (CSV ma trzy, JPK_FA
 * tylko „Korekty”), a co z nich wchodzi do pliku — reguła z
 * `lib/exports/export-scope.ts` (FIR-01), ta sama co w runnerze.
 */
export function includesFor(format: EnabledExportFormat, state: ExportScopeState): ExportIncludes {
  return exportIncludesFor(format, {
    includeIssued: state.csv.issued,
    includeReceived: state.csv.received,
    includeCorrections: format === 'jpk_fa' ? state.jpkCorrections : state.csv.corrections,
  });
}

/** Ponowienie eksportu z historii: zakres joba po regule formatu (KPiR zawsze cały). */
export function includesForJob(
  job: Pick<ManualExportJobWithFiles, 'format' | 'include_issued' | 'include_received' | 'include_corrections'>,
): ExportIncludes {
  try {
    return exportIncludesFor(job.format, {
      includeIssued: job.include_issued,
      includeReceived: job.include_received,
      includeCorrections: job.include_corrections,
    });
  } catch (error) {
    if (!(error instanceof UnknownExportFormatError)) throw error;
    // Format spoza reguły: flagi joba bez zmian — `startExportAction` odmówi
    // komunikatem „Nieobsługiwany format eksportu” zamiast wywracać stronę.
    return {
      includeIssued: job.include_issued ?? true,
      includeReceived: job.include_received ?? false,
      includeCorrections: job.include_corrections ?? true,
    };
  }
}

/** Rozmiar pliku po polsku: „512 B”, „12,4 KB”, „1,2 MB”. */
export function formatFileSize(bytes: number | null | undefined): string | null {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const comma = (value: number) => value.toFixed(1).replace('.', ',');
  if (bytes < 1024 * 1024) return `${comma(bytes / 1024)} KB`;
  return `${comma(bytes / (1024 * 1024))} MB`;
}

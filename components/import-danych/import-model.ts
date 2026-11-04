import type { FileImportSource } from '@/app/actions/import-danych';
import { countLabel } from '@/lib/i18n/plural';
import type { Database } from '@/types/database';

/**
 * Model widoku Centrum importu (poprawka Bartosza 22.10.2026: import danych
 * w stylu Finory). Same czyste funkcje nad wierszami `import_jobs` — bez
 * zapytań i bez logiki importu (ta zostaje w `lib/import/**` i runnerach).
 *
 * Liczby na kaflach biorą się WYŁĄCZNIE z liczników, które joby same zapisują
 * w `import_jobs` (`invoices_imported`, `contractors_created`,
 * `products_created`). Silnik liczy tylko nowo zapisane faktury (duplikaty
 * pomija), więc suma po jobach to liczba faktur, które import naprawdę dodał.
 *
 * Decyzja Bartosza 22.10.2026: Magicznego importu już nie ma — historię
 * z KSeF FaktWay pobiera sam (karta „Historia z KSeF”). Dawne wiersze
 * `ksef_history` zostają w historii jako „Import z KSeF (ręczny)”, a taki
 * wiersz, który utknął „w toku”, pokazujemy jako przerwany: jego kolejki już
 * nie ma, więc nigdy się nie skończy. Tak samo nieudany: jego zapisany powód
 * („Zawęź zakres dat i ponów import”) każe ponowić import, którego już nie
 * ma (poprawka po przeglądzie).
 */

type ImportJobRow = Database['public']['Tables']['import_jobs']['Row'];

/** Kolumny, które czyta strona — bez ścieżki pliku w magazynie i bez `triggered_by`. */
export const IMPORT_HISTORY_COLUMNS =
  'id, source, direction, date_from, date_to, status, progress_percent, progress_message, invoices_imported, contractors_created, contractors_updated, products_created, warnings, source_filename, created_at, completed_at' as const;

export type ImportHistoryJob = Pick<
  ImportJobRow,
  | 'id'
  | 'source'
  | 'direction'
  | 'date_from'
  | 'date_to'
  | 'status'
  | 'progress_percent'
  | 'progress_message'
  | 'invoices_imported'
  | 'contractors_created'
  | 'contractors_updated'
  | 'products_created'
  | 'warnings'
  | 'source_filename'
  | 'created_at'
  | 'completed_at'
>;

/** Ile ostatnich importów czytamy; przy pełnej liście kafle mówią „z ostatnich 100”. */
export const IMPORT_HISTORY_LIMIT = 100;

/** Odświeżanie historii, gdy coś się importuje: co 4 s, najwyżej 45 razy (3 minuty). */
export const POLL_INTERVAL_MS = 4000;
export const MAX_POLL_TICKS = 45;

/** Szczegóły i postęp joba — istniejąca strona z odświeżaniem na żywo. */
export function importProgressHref(jobId: string): string {
  return `/onboarding/progress/${encodeURIComponent(jobId)}`;
}

/**
 * Źródła importu z pliku — te same i w tej samej kolejności co w onboardingu.
 * Decyzja Bartosza 22.10.2026: tylko cztery duże programy, bez „Inny program
 * (JPK_FA)”.
 */
export const FILE_SOURCES: readonly {
  id: FileImportSource;
  label: string;
  description: string;
  format: 'CSV';
}[] = [
  { id: 'fakturownia_csv', label: 'Fakturownia', description: 'Plik CSV z eksportu faktur', format: 'CSV' },
  { id: 'infakt_csv', label: 'inFakt', description: 'Plik CSV z eksportu faktur', format: 'CSV' },
  { id: 'wfirma_csv', label: 'wFirma', description: 'Plik CSV z eksportu faktur', format: 'CSV' },
  { id: 'ifirma_csv', label: 'iFirma', description: 'Plik CSV z eksportu faktur', format: 'CSV' },
];

const SOURCE_LABELS: Readonly<Record<string, string>> = {
  // Dawny ręczny import (Magiczny import) — wiersze z historii zostają czytelne.
  ksef_history: 'Import z KSeF (ręczny)',
  fakturownia_csv: 'Fakturownia',
  infakt_csv: 'inFakt',
  wfirma_csv: 'wFirma',
  ifirma_csv: 'iFirma',
  // Dawny import pliku JPK_FA — z ekranu zniknął, wiersze w historii zostają.
  jpk_fa: 'Plik JPK_FA',
};

/** Nazwa źródła w historii; nieznane albo puste źródło nie wywraca listy. */
export function sourceLabel(source: string | null): string {
  return (source && SOURCE_LABELS[source]) || 'Import';
}

export function isKsefSource(source: string | null): boolean {
  return source === 'ksef_history';
}

export type ImportStatusGroup = 'running' | 'completed' | 'failed' | 'cancelled';

/** Kroki joba w toku — te same nazwy co na stronie postępu (`import-progress-view`). */
const RUNNING_STEPS: Readonly<Record<string, string>> = {
  pending: 'Inicjalizacja',
  queued: 'Kolejkowanie',
  parsing: 'Wczytywanie danych',
  extracting: 'Pobieranie faktur',
  deduplicating: 'Analiza danych',
  inserting: 'Zapisywanie',
};

export function statusGroup(status: string): ImportStatusGroup {
  if (status === 'completed') return 'completed';
  if (status === 'cancelled') return 'cancelled';
  if (status in RUNNING_STEPS) return 'running';
  // `failed` i każdy status spoza listy — nie udajemy, że coś trwa albo się udało.
  return 'failed';
}

/**
 * Dawny ręczny import z KSeF, który się nie zakończył — „w toku” albo
 * nieudany. Kolejki `import.ksef-history.requested` już nie ma (decyzja
 * Bartosza 22.10.2026), więc import „w toku” się nie skończy, a nieudanego
 * nie da się ponowić. Nie udajemy postępu ani nie podpowiadamy ponowienia:
 * oba są zastąpione automatyczną historią z KSeF (poprawka po przeglądzie —
 * zapisany powód błędu kazał „ponowić import”).
 */
export function isInterruptedLegacyImport(job: Pick<ImportHistoryJob, 'status' | 'source'>): boolean {
  if (!isKsefSource(job.source)) return false;
  const group = statusGroup(job.status);
  return group === 'running' || group === 'failed';
}

export const INTERRUPTED_LEGACY_NOTE = 'Przerwany — zastąpiony automatyczną historią z KSeF';

/** Grupa statusu wiersza historii: przerwany dawny import z KSeF to „Anulowano”. */
export function jobStatusGroup(job: Pick<ImportHistoryJob, 'status' | 'source'>): ImportStatusGroup {
  return isInterruptedLegacyImport(job) ? 'cancelled' : statusGroup(job.status);
}

export const isRunning = (job: Pick<ImportHistoryJob, 'status' | 'source'>) => jobStatusGroup(job) === 'running';

export function runningStep(status: string): string {
  return RUNNING_STEPS[status] ?? 'W toku';
}

export function progressPercent(job: Pick<ImportHistoryJob, 'progress_percent'>): number {
  const value = Number(job.progress_percent);
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

/** „2026-04-01” → „01.04.2026”; niepoprawna wartość wraca bez zmian. */
export function formatIsoDay(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : iso;
}

const WARSAW_DAY = new Intl.DateTimeFormat('pl-PL', {
  timeZone: 'Europe/Warsaw',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

/** Znacznik czasu z bazy jako „DD.MM.RRRR” w czasie polskim. */
export function formatWarsawDay(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : WARSAW_DAY.format(date);
}

/** Podpis pod nazwą źródła: nazwa pliku albo zakres dat KSeF (z kierunkiem, gdy to zakupy). */
export function sourceDetail(job: Pick<ImportHistoryJob, 'source' | 'source_filename' | 'date_from' | 'date_to' | 'direction'>): string | null {
  if (job.source_filename) return job.source_filename;
  if (job.date_from && job.date_to) {
    const range = `${formatIsoDay(job.date_from)} – ${formatIsoDay(job.date_to)}`;
    return job.direction === 'received' ? `${range} · otrzymane` : range;
  }
  return null;
}

const n = (value: number | null | undefined) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

export function warningCount(job: Pick<ImportHistoryJob, 'warnings'>): number {
  return Array.isArray(job.warnings) ? job.warnings.filter((w) => typeof w === 'string').length : 0;
}

/** Wynik zakończonego importu: „124 faktury · 18 kontrahentów · 40 produktów”. */
export function completedSummary(
  job: Pick<ImportHistoryJob, 'invoices_imported' | 'contractors_created' | 'contractors_updated' | 'products_created'>,
): string {
  const invoices = n(job.invoices_imported);
  // Jak kafel „Kontrahenci” na stronie postępu: nowi i uzupełnieni.
  const contractors = n(job.contractors_created) + n(job.contractors_updated);
  const products = n(job.products_created);
  if (invoices + contractors + products === 0) return 'Brak nowych faktur';
  const parts = [countLabel(invoices, ['faktura', 'faktury', 'faktur'])];
  if (contractors > 0) parts.push(countLabel(contractors, ['kontrahent', 'kontrahenci', 'kontrahentów']));
  if (products > 0) parts.push(countLabel(products, ['produkt', 'produkty', 'produktów']));
  return parts.join(' · ');
}

/** Powód błędu z joba (np. „Zawęź zakres dat i ponów import”) i co mimo to zapisano. */
export function failureNote(job: Pick<ImportHistoryJob, 'progress_message' | 'invoices_imported'>): {
  reason: string;
  saved: string | null;
} {
  const saved = n(job.invoices_imported);
  return {
    reason: job.progress_message?.trim() || 'Import się nie udał.',
    saved: saved > 0 ? `Zapisano ${countLabel(saved, ['fakturę', 'faktury', 'faktur'])}` : null,
  };
}

export interface ImportSummary {
  invoices: number;
  contractors: number;
  products: number;
  /** Faktury z importów plików (bez dawnego ręcznego importu z KSeF). */
  fileInvoices: number;
  /** Nowi kontrahenci z importów plików. */
  fileContractors: number;
  /** Dawny ręczny import z KSeF: sprzedaż (`issued`) i zakupy (`received`). */
  legacyKsefIssued: number;
  legacyKsefReceived: number;
  /** Najnowszy zakończony import (lista idzie od najnowszych). */
  lastCompleted: ImportHistoryJob | null;
  /** Lista ucięta limitem — sumy są z ostatnich `limit` importów. */
  partial: boolean;
}

/**
 * Sumy do kafli. Faktury liczymy też z nieudanych jobów: przy „Część faktur
 * KSeF nie została zapisana” runner zapisuje w `invoices_imported` te, które
 * już są w bazie. Kontrahenci i produkty — tylko nowo utworzeni (uzupełnieni
 * w kolejnych importach to ci sami kontrahenci, suma by ich dublowała).
 *
 * Decyzja Bartosza 22.10.2026: kafle rozdzielają pliki od KSeF — dawny
 * ręczny import z KSeF dolicza się do kafla „Historia z KSeF”.
 */
export function summarizeImports(jobs: readonly ImportHistoryJob[], limit = IMPORT_HISTORY_LIMIT): ImportSummary {
  const sum = (list: readonly ImportHistoryJob[], pick: (job: ImportHistoryJob) => number | null) =>
    list.reduce((total, job) => total + n(pick(job)), 0);
  const files = jobs.filter((job) => !isKsefSource(job.source));
  const legacy = jobs.filter((job) => isKsefSource(job.source));
  return {
    invoices: sum(jobs, (job) => job.invoices_imported),
    contractors: sum(jobs, (job) => job.contractors_created),
    products: sum(jobs, (job) => job.products_created),
    fileInvoices: sum(files, (job) => job.invoices_imported),
    fileContractors: sum(files, (job) => job.contractors_created),
    legacyKsefIssued: sum(
      legacy.filter((job) => job.direction !== 'received'),
      (job) => job.invoices_imported,
    ),
    legacyKsefReceived: sum(
      legacy.filter((job) => job.direction === 'received'),
      (job) => job.invoices_imported,
    ),
    lastCompleted: jobs.find((job) => jobStatusGroup(job) === 'completed') ?? null,
    partial: jobs.length >= limit,
  };
}

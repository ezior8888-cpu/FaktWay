import { z } from 'zod';

/**
 * Okres i rodzaj paczki archiwum (plan kompletnej aplikacji, krok 6.4).
 * Ten sam schemat sprawdza formularz w przeglądarce i akcję serwerową; baza
 * powtarza reguły okresu w CHECK `document_archives_period_check` (00178).
 *
 * Paczka obejmuje pełne miesiące, najwyżej 12, od stycznia 2015 r. do
 * bieżącego miesiąca (Europe/Warsaw): 12 miesięcy to górna granica pamięci
 * workera razem z limitem rozmiaru w `lib/archiwum/paczka.ts`.
 */

export const ARCHIVE_KINDS = ['archive', 'audit'] as const;
export type ArchiveKind = (typeof ARCHIVE_KINDS)[number];

export const ARCHIVE_MIN_MONTH = '2015-01';
export const ARCHIVE_MAX_MONTHS = 12;
/** Link do gotowej paczki działa tyle dni od jej powstania. */
export const ARCHIVE_LINK_DAYS = 7;

export const ARCHIVE_KIND_LABELS: Record<ArchiveKind, string> = {
  archive: 'Archiwum dokumentów',
  audit: 'Paczka na kontrolę',
};

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export const archiveRequestSchema = z.object({
  kind: z.enum(ARCHIVE_KINDS),
  from: z.string().regex(MONTH, 'Podaj miesiąc w formacie RRRR-MM.'),
  to: z.string().regex(MONTH, 'Podaj miesiąc w formacie RRRR-MM.'),
});
export type ArchiveRequest = z.infer<typeof archiveRequestSchema>;

export interface ArchivePeriod {
  periodStart: string;
  periodEnd: string;
}

function monthIndex(month: string): number {
  const [y, m] = month.split('-').map(Number);
  return y! * 12 + (m! - 1);
}

/** Ostatni dzień miesiąca RRRR-MM jako RRRR-MM-DD (bez strefy czasowej). */
function lastDay(month: string): string {
  const [y, m] = month.split('-').map(Number);
  const day = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
  return `${month}-${String(day).padStart(2, '0')}`;
}

/**
 * Okres zlecenia z miesięcy „od” i „do”. `today` to dzisiejsza data
 * w Europe/Warsaw (RRRR-MM-DD): miesiąc z przyszłości nie ma dokumentów.
 */
export function archivePeriod(input: { from: string; to: string }, today: string): ArchivePeriod | { error: string } {
  if (!MONTH.test(input.from) || !MONTH.test(input.to)) return { error: 'Podaj miesiące w formacie RRRR-MM.' };
  const from = monthIndex(input.from);
  const to = monthIndex(input.to);
  if (to < from) return { error: 'Miesiąc końcowy jest wcześniejszy niż początkowy.' };
  if (to - from + 1 > ARCHIVE_MAX_MONTHS) return { error: `Jedna paczka obejmuje najwyżej ${ARCHIVE_MAX_MONTHS} miesięcy. Wybierz krótszy okres.` };
  if (from < monthIndex(ARCHIVE_MIN_MONTH)) return { error: 'Paczka obejmuje dokumenty od stycznia 2015 r.' };
  if (to > monthIndex(today.slice(0, 7))) return { error: 'Okres nie może obejmować przyszłych miesięcy.' };
  return { periodStart: `${input.from}-01`, periodEnd: lastDay(input.to) };
}

function plDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}.${m}.${y}`;
}

/** „rok 2026”, „03.2026” albo „od 01.03.2026 do 31.05.2026”, bez myślników. */
export function archivePeriodLabel(periodStart: string, periodEnd: string): string {
  const year = periodStart.slice(0, 4);
  if (periodStart === `${year}-01-01` && periodEnd === `${year}-12-31`) return `rok ${year}`;
  if (periodStart.slice(0, 7) === periodEnd.slice(0, 7)) return `${periodStart.slice(5, 7)}.${year}`;
  return `od ${plDate(periodStart)} do ${plDate(periodEnd)}`;
}

export { plDate as archivePlDate };

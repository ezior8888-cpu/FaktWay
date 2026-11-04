/**
 * Daty po polsku w formacie DD.MM.RRRR (plan Finora §7.1) — moduł bez
 * importów, działa i na serwerze, i w przeglądarce.
 *
 * `toLocaleDateString('pl-PL')` daje „2.09.2026” (dzień bez zera) i zależy od
 * strefy procesu; tutaj data kalendarzowa idzie wprost z napisu RRRR-MM-DD,
 * a znacznik czasu — w strefie Europe/Warsaw.
 */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})/;

/** „2026-09-02” → „02.09.2026”; pusta albo niepoprawna wartość → „—”. */
export function formatIsoDatePl(iso: string | null | undefined): string {
  if (!iso) return '—';
  const m = ISO_DATE.exec(iso);
  if (!m) return '—';
  return `${m[3]}.${m[2]}.${m[1]}`;
}

const WARSAW_DATE = new Intl.DateTimeFormat('pl-PL', {
  timeZone: 'Europe/Warsaw',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

/** Znacznik czasu z bazy (UTC) jako dzień w Polsce: „20.10.2026”; niepoprawny → „—”. */
export function formatTimestampDatePl(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return WARSAW_DATE.format(d);
}

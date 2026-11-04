// Daty w ustawieniach w formacie z planu Finora §7.1: DD.MM.RRRR, strefa
// Europe/Warsaw (domyślne `toLocaleDateString('pl-PL')` daje „1.03.2027”
// i liczy w strefie serwera). Niepoprawna wartość wraca jako „—”.

const PL_DATE = new Intl.DateTimeFormat('pl-PL', {
  timeZone: 'Europe/Warsaw',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric'
})

export function formatSettingsDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)

  return Number.isNaN(d.getTime()) ? '—' : PL_DATE.format(d)
}

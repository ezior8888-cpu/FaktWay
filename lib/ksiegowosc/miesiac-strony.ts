import { shiftMonth } from '@/lib/expenses/month';

/**
 * Miesiąc ekranu modułu z adresu (`?month=&year=`, jak `MonthSelector`).
 * Domyślnie poprzedni miesiąc: ten, który właśnie się rozlicza.
 */
export function miesiacZParametrow(sp: { month?: string; year?: string }, dzis: string): string {
  const m = Number(sp.month);
  const r = Number(sp.year);
  if (Number.isInteger(m) && m >= 1 && m <= 12 && Number.isInteger(r) && r >= 2026 && r <= 2100) {
    return `${r}-${String(m).padStart(2, '0')}`;
  }
  return shiftMonth(dzis.slice(0, 7), -1);
}

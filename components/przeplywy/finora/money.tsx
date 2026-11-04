import { formatPlMoney } from '@/lib/format/pl';

/** Kwota z walutą: „12 345,67 zł” (plan Finora §7.1). */
export function zl(amount: number): string {
  return `${formatPlMoney(amount)} zł`;
}

/**
 * Wiersz dymku wykresu z kwotą w złotych — `ChartTooltipContent` domyślnie
 * formatuje liczby `toLocaleString()` bez waluty i groszy.
 */
export function MoneyTooltipRow({ label, amount, color }: { label: string; amount: number; color?: string }) {
  return (
    <div className="flex w-full items-center justify-between gap-4">
      <span className="text-muted-foreground flex items-center gap-1.5">
        {color ? (
          <span className="size-2.5 shrink-0 rounded-[2px]" style={{ backgroundColor: color }} aria-hidden />
        ) : null}
        {label}
      </span>
      <span className="text-foreground font-mono font-medium tabular-nums">{zl(amount)}</span>
    </div>
  );
}

/** „2026-10-05” → „05.10.2026” (bez `Date`, więc bez strefy czasowej). */
export function plDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : iso;
}

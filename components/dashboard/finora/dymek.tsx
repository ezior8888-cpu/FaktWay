// React Imports
import type { CSSProperties } from 'react'

/**
 * Wiersz dymku wykresu Pulpitu z kwotą w złotych (PLAN-PRAWDZIWE-DANE E5).
 * `ChartTooltipContent` bez `formatter` pisze surową liczbę bez „zł”;
 * z `formatter` gubi kropkę koloru serii — tu ta sama kropka i te same
 * klasy co w `components/ui/chart.tsx`, więc dymek wygląda jak w Finorze.
 */
export function DymekWiersz({ color, label, value }: { color: string | undefined; label: string; value: string }) {
  return (
    <>
      <div
        className='h-2.5 w-2.5 shrink-0 rounded-[2px] border-(--color-border) bg-(--color-bg)'
        style={{ '--color-bg': color, '--color-border': color } as CSSProperties}
      />
      <div className='flex flex-1 items-center justify-between gap-2 leading-none'>
        <span className='text-muted-foreground'>{label}</span>
        <span className='text-foreground font-mono font-medium tabular-nums'>{value}</span>
      </div>
    </>
  )
}

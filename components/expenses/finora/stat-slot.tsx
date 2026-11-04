import { Suspense, type ReactNode } from 'react'

import { SectionErrorBoundary } from '@/components/dashboard/section-error-boundary'
import { PULPIT_GENERIC_ERROR, pulpitErrorMessage } from '@/components/dashboard/pulpit/pulpit-grid'

import { StatCell, StatCellError, StatCellSkeleton, type StatCellProps } from './stats-cards'

/**
 * Jeden kafel z danymi = jedno źródło awarii (plan Finora §2.4 pkt 15).
 *
 * Treść wyjątku bierzemy w ładowarce (try/catch) i filtrujemy przez
 * `pulpitErrorMessage` — granica błędu nie przekazuje tekstu, a ogon
 * PostgREST-a po angielsku nie trafia do klienta. Granica zostaje siatką
 * bezpieczeństwa na błąd renderu.
 */
export async function loadStatCell(
  label: string,
  load: () => Promise<Omit<StatCellProps, 'label'>>,
): Promise<ReactNode> {
  try {
    return <StatCell label={label} {...await load()} />
  } catch (error) {
    const message = pulpitErrorMessage(error)
    if (message === PULPIT_GENERIC_ERROR) console.error(`[koszty] kafel „${label}”:`, error)
    return <StatCellError label={label} message={message} />
  }
}

export function StatSlot({ label, children }: { label: string; children: ReactNode }) {
  return (
    <SectionErrorBoundary fallback={<StatCellError label={label} message='Nie udało się wyświetlić kafla.' />}>
      <Suspense fallback={<StatCellSkeleton />}>{children}</Suspense>
    </SectionErrorBoundary>
  )
}

import type { CashFlowOperation } from '@/lib/dashboard/cash-movements'

import { zl } from './money'

/** Znak kwoty operacji: wpływ „+”, wydatek „−”, korekta kosztu in minus „+”. */
export function signedAmount(operation: Pick<CashFlowOperation, 'direction' | 'amount'>): string {
  const negative = operation.amount < 0
  const sign = operation.direction === 'in' ? (negative ? '−' : '+') : negative ? '+' : '−'
  return `${sign}${zl(Math.abs(operation.amount))}`
}

/** Kolor kwoty: przychodzi — zielony, wychodzi — czerwony (Finora: `green-600` / `destructive`). */
export function amountTone(operation: Pick<CashFlowOperation, 'direction' | 'amount'>): string {
  const incoming = operation.direction === 'in' ? operation.amount >= 0 : operation.amount < 0
  return incoming ? 'text-green-700 dark:text-green-400' : 'text-destructive'
}

import { RiAlertLine, RiCheckLine, RiTimeLine } from '@remixicon/react';

import { PAYMENT_STATE_LABELS } from '@/components/invoices/invoice-row-types';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import type { InvoicePaymentState } from '@/lib/invoices/list-row-facts';
import { cn } from '@/lib/utils';

/**
 * Finora `invoice-table/data-table.tsx`, kolumna „Status”: ikona w kółku
 * `Avatar` na tle `INVOICE_STATUS_STYLES` (paid → zielony ✓, pending →
 * bursztynowy zegar, past due → czerwony trójkąt). U nas: opłacona,
 * nieopłacona, po terminie.
 */
const STATES = {
  paid: {
    Icon: RiCheckLine,
    avatar: 'bg-green-600/10 text-green-700 dark:bg-green-400/10 dark:text-green-400',
    tone: 'text-green-700 dark:text-green-400',
  },
  unpaid: {
    Icon: RiTimeLine,
    avatar: 'bg-amber-600/10 text-amber-700 dark:bg-amber-400/10 dark:text-amber-400',
    tone: 'text-amber-700 dark:text-amber-400',
  },
  overdue: {
    Icon: RiAlertLine,
    avatar: 'bg-destructive/10 text-destructive',
    tone: 'text-destructive',
  },
} as const satisfies Record<InvoicePaymentState, { Icon: typeof RiTimeLine; avatar: string; tone: string }>;

/**
 * Ikona płatności. Etykieta dla czytników ekranu i w `title` — kolor sam
 * niczego nie niesie. `null` = „—”: faktura spoza należności (szkic, import,
 * korekta, waluta obca).
 */
export function PaymentIndicator({
  state,
  className,
  showLabel = false,
}: {
  state: InvoicePaymentState | null;
  className?: string;
  /** Karty telefonu: mała ikona z widoczną etykietą; domyślnie kółko Finory. */
  showLabel?: boolean;
}) {
  if (state === null) {
    return (
      <span className={cn('text-muted-foreground', className)} title="Brak płatności do rozliczenia">
        —
      </span>
    );
  }
  const { Icon, avatar, tone } = STATES[state];
  const label = PAYMENT_STATE_LABELS[state];

  if (showLabel) {
    return (
      <span className={cn('inline-flex items-center gap-1', tone, className)} title={label}>
        <Icon className="size-4" aria-hidden />
        <span className="text-xs font-medium">{label}</span>
      </span>
    );
  }

  return (
    <Avatar className={cn('after:border-none', className)} title={label}>
      <AvatarFallback className={avatar}>
        <Icon className="size-4" aria-hidden />
        <span className="sr-only">{label}</span>
      </AvatarFallback>
    </Avatar>
  );
}

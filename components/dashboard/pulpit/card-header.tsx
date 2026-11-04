import type { ReactNode } from 'react';

import { CardHeader } from '@/components/ui/card';
import { cn } from '@/lib/utils';

/**
 * Nagłówek karty Pulpitu — `card-header-with-menu.tsx` Finory bez menu
 * „⋯”: jego pozycje (Share / Update / Refresh) w szablonie nic nie robią,
 * a karta bez działającej akcji nie dostaje pustego przycisku. Miejsce po
 * prawej bierze `action` (np. link „Szczegóły”).
 */
export function PulpitCardHeader({
  title,
  subtitle,
  action,
  className,
}: {
  title: string;
  subtitle?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <CardHeader className={cn('flex items-start justify-between gap-3', className)}>
      <div className="flex min-w-0 flex-col gap-1">
        <h2 className="text-lg font-semibold">{title}</h2>
        {subtitle ? <span className="text-muted-foreground text-sm">{subtitle}</span> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </CardHeader>
  );
}

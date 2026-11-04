import Link from 'next/link';

import { RiTimeLine } from '@remixicon/react';

import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { formatPlMoney } from '@/lib/format/pl';
import { cn } from '@/lib/utils';

import { PulpitEmptyState } from './card-states';

export type AgingBucket = {
  key: 'notDue' | 'upTo30' | 'over30';
  label: string;
  amount: number;
  count: number;
  pct: number;
};

const BAR_TONE: Record<AgingBucket['key'], string> = {
  notDue: 'bg-chart-1/20',
  upTo30: 'bg-chart-1/50',
  over30: 'bg-chart-1',
};

/** Należności według terminu — `chart-total-visitors.tsx` Finory, słupki CSS. */
export function ReceivablesAgingCard({
  total,
  count,
  buckets,
  note,
  className,
}: {
  total: number;
  count: number;
  buckets: AgingBucket[];
  note: string;
  className?: string;
}) {
  return (
    <Card className={cn('gap-4 shadow-none', className)}>
      <CardHeader className="flex flex-col">
        <div className="flex w-full items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-base">
            <Avatar className="after:border-0">
              <AvatarFallback className="bg-primary/15 dark:bg-primary/25 text-primary shrink-0">
                <RiTimeLine className="size-4" aria-hidden />
              </AvatarFallback>
            </Avatar>
            <h2>Należności według terminu</h2>
          </div>
          <Link
            href="/payments/overdue"
            className={buttonVariants({ variant: 'outline', size: 'xs' })}
          >
            Szczegóły
          </Link>
        </div>
        {total > 0 ? (
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-semibold" title={`Liczba faktur: ${count}`}>
              {formatPlMoney(total)} zł
            </span>
          </div>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-4">
        {total > 0 ? (
          <>
            <Separator />
            <div className="flex flex-1">
              {buckets.map((b) => (
                <div
                  key={b.key}
                  className="flex min-w-0 grow basis-0 flex-col gap-2.5 border-dashed p-2 not-last:border-r"
                >
                  <span className="text-muted-foreground text-sm">{b.label}</span>
                  <div className="text-2xl font-medium">{b.pct}%</div>
                  <div className="flex min-h-35 flex-1 items-end">
                    <div
                      className={cn('grow rounded-xl', BAR_TONE[b.key])}
                      style={{ height: `${Math.max(0, Math.min(100, b.pct))}%` }}
                      aria-hidden
                    />
                  </div>
                  <span className="text-muted-foreground text-sm" title={`Liczba faktur: ${b.count}`}>
                    {formatPlMoney(b.amount)} zł
                  </span>
                </div>
              ))}
            </div>
            <p className="text-muted-foreground text-xs">{note}</p>
          </>
        ) : (
          <PulpitEmptyState message="Brak otwartych należności" />
        )}
      </CardContent>
    </Card>
  );
}

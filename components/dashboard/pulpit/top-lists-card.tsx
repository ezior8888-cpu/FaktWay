import type { ComponentType } from 'react';

import { RiBuilding2Line, RiGroupLine, RiShoppingBag3Line } from '@remixicon/react';

import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { formatPlMoney, formatPlPercentChange } from '@/lib/format/pl';
import { cn } from '@/lib/utils';

import { PulpitCardHeader } from './card-header';
import { PULPIT_EMPTY, PulpitEmptyState } from './card-states';

export type TopProduct = { key: string; name: string; unit: string | null; net: number };
export type TopClient = {
  key: string;
  name: string;
  nip: string | null;
  consumers: boolean;
  net: number;
  changePct: number | null;
};

const ICON_TONES = [
  'bg-chart-1/10 text-chart-1',
  'bg-chart-2/10 text-chart-2',
  'bg-chart-3/10 text-chart-3',
  'bg-chart-4/10 text-chart-4',
  'bg-chart-5/10 text-chart-5',
] as const;

function RowIcon({ icon: Icon, index }: { icon: ComponentType<{ className?: string }>; index: number }) {
  return (
    <Avatar className="size-9 after:border-0">
      <AvatarFallback className={cn('shrink-0 [&>svg]:size-4.5', ICON_TONES[index % ICON_TONES.length])}>
        <Icon aria-hidden />
      </AvatarFallback>
    </Avatar>
  );
}

function changeTone(pct: number): string {
  if (pct > 0) return 'bg-green-700/10 text-green-800 dark:bg-green-400/15 dark:text-green-400';
  if (pct < 0) return 'bg-destructive/10 text-destructive';
  return 'bg-muted text-muted-foreground';
}

/** Najlepiej sprzedające się + najwięksi klienci — `widget-top-products.tsx` Finory. */
export function TopListsCard({
  products,
  clients,
  productsNote,
  className,
}: {
  products: TopProduct[];
  clients: TopClient[];
  productsNote: string;
  className?: string;
}) {
  return (
    <Card className={cn('gap-x-2 gap-y-6 shadow-none lg:flex-row', className)}>
      <div className="flex flex-1 flex-col gap-6">
        <PulpitCardHeader title="Najlepiej sprzedające się" subtitle="Ostatnie 12 miesięcy" />
        <CardContent className="flex flex-1 flex-col gap-4">
          {products.length === 0 ? (
            clients.length > 0 ? (
              <PulpitEmptyState message={PULPIT_EMPTY.noProductSales} />
            ) : (
              <PulpitEmptyState message={PULPIT_EMPTY.noInvoices} action={PULPIT_EMPTY.issueInvoice} />
            )
          ) : (
            <>
              {products.map((p, i) => (
                <div key={p.key} className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-3">
                    <RowIcon icon={RiShoppingBag3Line} index={i} />
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate text-base" title={p.name}>
                        {p.name}
                      </span>
                      {p.unit ? <span className="text-muted-foreground text-sm">j.m.: {p.unit}</span> : null}
                    </div>
                  </div>
                  <span className="shrink-0 text-sm">{formatPlMoney(p.net)} zł</span>
                </div>
              ))}
              <p className="text-muted-foreground text-xs">{productsNote}</p>
            </>
          )}
        </CardContent>
      </div>
      <div className="flex max-lg:px-6">
        <Separator orientation="vertical" className="hidden lg:block" />
        <Separator className="block lg:hidden" />
      </div>
      <div className="flex flex-1 flex-col gap-6">
        <PulpitCardHeader title="Najwięksi klienci" subtitle="Ostatnie 12 miesięcy" />
        <CardContent className="flex flex-1 flex-col gap-4">
          {clients.length === 0 ? (
            <PulpitEmptyState message={PULPIT_EMPTY.noInvoices} action={PULPIT_EMPTY.issueInvoice} />
          ) : (
            clients.map((c, i) => (
              <div key={c.key} className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-3">
                  <RowIcon icon={c.consumers ? RiGroupLine : RiBuilding2Line} index={i} />
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate text-base" title={c.name}>
                      {c.name}
                    </span>
                    {c.nip ? <span className="text-muted-foreground text-sm">NIP {c.nip}</span> : null}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-3 text-sm">
                  <span>{formatPlMoney(c.net)} zł</span>
                  <Badge
                    className={cn(
                      'h-6 px-3 py-1',
                      // Odstępstwo od Finory (WCAG 1.4.3): tekst `accent-foreground`, nie `primary`
                      // — `text-primary` na `bg-primary/10` ma 4,44:1 (jasny), na
                      // `dark:bg-primary/25` 3,76:1 (ciemny); `accent-foreground` daje 9,00 i
                      // 6,76:1.
                      c.changePct === null ? 'bg-primary/10 text-accent-foreground dark:bg-primary/25' : changeTone(c.changePct),
                    )}
                  >
                    {c.changePct === null ? 'nowy' : formatPlPercentChange(c.changePct)}
                  </Badge>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </div>
    </Card>
  );
}

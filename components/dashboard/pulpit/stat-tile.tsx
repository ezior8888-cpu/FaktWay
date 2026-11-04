import type { ComponentType, ReactNode } from 'react';

import { RiArrowDownSLine, RiArrowUpSLine } from '@remixicon/react';

import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { formatPlPercentChange } from '@/lib/format/pl';
import { cn } from '@/lib/utils';

export type StatTileChange = { pct: number } | { note: string } | null;

/** Kafel statystyki Pulpitu — `statistics-card-03.tsx` Finory, treść z propsów. */
export function StatTile({
  icon: Icon,
  title,
  value,
  valueTitle,
  change,
  badge,
  footnote,
  className,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  value: string;
  valueTitle?: string;
  change?: StatTileChange;
  badge: string;
  footnote?: ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn('shadow-none', className)}>
      <CardHeader className="flex items-center justify-between">
        <Avatar className="size-9.5 after:border-0">
          <AvatarFallback className="bg-primary/10 text-primary size-9.5 shrink-0 [&>svg]:size-4.75">
            <Icon />
          </AvatarFallback>
        </Avatar>
        {change ? <TileChange change={change} /> : null}
      </CardHeader>
      <CardContent className="flex flex-1 flex-col justify-between gap-4">
        <div className="flex flex-col gap-1">
          <span className="text-lg font-semibold" title={valueTitle}>
            {value}
          </span>
          <span className="text-muted-foreground text-sm">{title}</span>
          {footnote ? <span className="text-muted-foreground text-xs">{footnote}</span> : null}
        </div>
        {/*
          Odstępstwo od Finory (WCAG 1.4.3): tekst `accent-foreground`, nie `primary` —
          `text-primary` na `bg-primary/10` ma 4,44:1 (jasny), na `dark:bg-primary/25`
          3,76:1 (ciemny); `accent-foreground` daje 9,00 i 6,76:1.
        */}
        <Badge className="bg-primary/10 text-accent-foreground dark:bg-primary/25">{badge}</Badge>
      </CardContent>
    </Card>
  );
}

/** Zieleń tekstu „wzrostu” z kontrastem AA na białej karcie (≈ 4,9:1). */
export const POSITIVE_TEXT_TONE = 'text-green-700 dark:text-green-400';

function TileChange({ change }: { change: NonNullable<StatTileChange> }) {
  if ('note' in change) {
    return <p className="text-muted-foreground text-xs">{change.note}</p>;
  }
  const { pct } = change;
  const tone =
    pct > 0 ? POSITIVE_TEXT_TONE : pct < 0 ? 'text-destructive' : 'text-muted-foreground';
  return (
    <p className={cn('flex items-center gap-1 text-base', tone)}>
      {formatPlPercentChange(pct)}
      {pct > 0 ? <RiArrowUpSLine className="size-4" aria-hidden /> : null}
      {pct < 0 ? <RiArrowDownSLine className="size-4" aria-hidden /> : null}
    </p>
  );
}

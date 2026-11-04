'use client';

import { AnimatePresence, motion } from 'framer-motion';

import { PulpitEmptyState } from '@/components/dashboard/pulpit/card-states';
import { POSITIVE_TEXT_TONE } from '@/components/dashboard/pulpit/stat-tile';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { ClientMover } from '@/lib/analytics-finance/clients';
import { cn } from '@/lib/utils';

import type { EmptyStateProps } from './empty';

/**
 * Port Finory `investments/mover-list-card.tsx` („Top Gainers / Top
 * Losers”) → „Klienci: rośnie” / „Klienci: spada” (P11). `AnimatePresence`
 * i `motion` z `framer-motion` (to samo API co `motion/react` z Finory).
 * Avatar bez logo (danych przykładowych Finory nie przenosimy) — inicjały
 * nazwy. Procent z jedną cyfrą po przecinku, minus typograficzny (§7.1).
 * Dopisany podpis okresu: bez niego procent nie mówi, do czego porównujemy.
 */

export type MoverListMode = 'gainers' | 'losers';

const MODE_TITLE: Record<MoverListMode, string> = {
  gainers: 'Klienci: rośnie',
  losers: 'Klienci: spada',
};

export function formatMoverPercent(percent: number): string {
  const text = Math.abs(percent).toLocaleString('pl-PL', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  if (percent > 0) return `+${text}%`;
  if (percent < 0) return `−${text}%`;
  return `${text}%`;
}

function initials(name: string): string {
  const letters = name
    .split(/\s+/)
    .filter((part) => /\p{L}/u.test(part))
    .slice(0, 2)
    .map((part) => part.match(/\p{L}/u)?.[0] ?? '')
    .join('');
  return (letters || name.slice(0, 2)).toUpperCase();
}

type MoverListCardProps = {
  mode: MoverListMode;
  items: ClientMover[];
  empty: EmptyStateProps;
  className?: string;
};

const MoverListCard = ({ mode, items, empty, className }: MoverListCardProps) => {
  return (
    <Card className={cn('shadow-none', className)}>
      <CardHeader>
        <CardTitle className="text-lg font-semibold">{MODE_TITLE[mode]}</CardTitle>
        <CardDescription>Sprzedaż netto: 3 ostatnie miesiące wobec 3 poprzednich</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {items.length === 0 ? (
          <PulpitEmptyState {...empty} />
        ) : (
          <AnimatePresence initial={false}>
            {items.map((item) => (
              <motion.div key={item.key} layout transition={{ type: 'spring', stiffness: 400, damping: 35 }}>
                <MoverRow item={item} />
              </motion.div>
            ))}
          </AnimatePresence>
        )}
      </CardContent>
    </Card>
  );
};

const MoverRow = ({ item }: { item: ClientMover }) => {
  const isPositive = item.percent >= 0;

  return (
    <div className="flex items-center gap-3">
      <Avatar className="size-10 items-center justify-center after:border-0">
        <AvatarFallback className="text-xs">{initials(item.name)}</AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium" title={item.name}>
          {item.name}
        </p>
        <p className="text-muted-foreground truncate text-xs">{item.subtitle}</p>
      </div>
      <motion.span
        key={item.percent.toFixed(1)}
        initial={{ opacity: 0.4, scale: 1.15 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.3 }}
        className={cn('shrink-0 text-sm font-medium tabular-nums', isPositive ? POSITIVE_TEXT_TONE : 'text-destructive')}
      >
        {formatMoverPercent(item.percent)}
      </motion.span>
    </div>
  );
};

export default MoverListCard;

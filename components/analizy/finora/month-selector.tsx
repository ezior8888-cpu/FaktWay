'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useTransition } from 'react';

import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ANALYTICS_MONTH_PARAM, type MonthOption } from '@/lib/analytics-finance/months';
import { cn } from '@/lib/utils';

/**
 * Port Finory `monthly-analytics/month-selector.tsx`. W Finorze miesiąc
 * trzyma `nuqs` (`useQueryState('month')`); u nas parametr `?miesiac=RRRR-MM`
 * czyta strona (`searchParams`), a wybór przechodzi pod nowy adres
 * (`router.push` w `startTransition`, jak `history: 'push', shallow: false`).
 * Lista miesięcy przychodzi z serwera (strefa Europe/Warsaw, nazwy po polsku).
 */
type MonthSelectorProps = {
  options: MonthOption[];
  value: string;
  className?: string;
};

const MonthSelector = ({ options, value, className }: MonthSelectorProps) => {
  const router = useRouter();
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();

  return (
    <Select
      items={options}
      value={value}
      disabled={isPending}
      onValueChange={(next) => {
        if (typeof next !== 'string' || next === value) return;
        startTransition(() => {
          router.push(`${pathname}?${ANALYTICS_MONTH_PARAM}=${encodeURIComponent(next)}`);
        });
      }}
    >
      <SelectTrigger className={cn('w-48', className)} aria-label="Wybierz miesiąc">
        <SelectValue placeholder="Wybierz miesiąc" />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false} className="p-1">
        <SelectGroup>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
};

export default MonthSelector;

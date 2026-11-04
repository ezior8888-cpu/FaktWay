import Link from 'next/link';

import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

import { PulpitCardHeader } from './card-header';

/**
 * Stany kart Pulpitu wspólne dla wszystkich kart (plan Finora §2.4 pkt 15,
 * §7.3). Karta z danymi to osobny Server Component: gdy jej strażnik rzuci
 * (faktura w EUR, przyjęta faktura bez środowiska, niepełna strona), karta
 * pokazuje TĘ treść wyjątku i wyjście do `/przeplywy`, a reszta Pulpitu
 * i slot FLO działają dalej.
 */

/** Karta błędu jednej karty: tytuł, treść wyjątku, link do przepływów. */
export function PulpitCardError({
  title,
  message,
  className,
}: {
  title: string;
  message: string;
  className?: string;
}) {
  return (
    <Card className={cn('shadow-none', className)} role="status">
      <PulpitCardHeader title={title} />
      <CardContent className="space-y-2">
        <p className="text-muted-foreground text-sm">{message}</p>
        <Link href="/przeplywy" className="text-primary text-sm underline-offset-4 hover:underline">
          Sprawdź w Przepływach
        </Link>
      </CardContent>
    </Card>
  );
}

/** Szkielet ładowania karty w tej samej siatce (Finora: `Skeleton`). */
export function PulpitCardSkeleton({
  className,
  variant = 'tile',
}: {
  className?: string;
  variant?: 'tile' | 'chart' | 'list';
}) {
  return (
    <Card className={cn('shadow-none', className)} aria-busy="true">
      <CardContent className="flex flex-col gap-4">
        <Skeleton className="h-5 w-40" />
        {variant === 'chart' ? <Skeleton className="h-48 w-full" /> : null}
        {variant === 'list'
          ? Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-8 w-full" />)
          : null}
        {variant === 'tile' ? <Skeleton className="h-8 w-24" /> : null}
      </CardContent>
    </Card>
  );
}

/**
 * Pusty stan zamiast pustego wykresu (§7.3). Bez `action` — sam tekst.
 * Domyślna akcja dla kart sprzedaży: „Wystaw fakturę”.
 */
export function PulpitEmptyState({
  message,
  action,
  className,
}: {
  message: string;
  action?: { label: string; href: string } | null;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-1 flex-col items-center justify-center gap-3 py-6 text-center', className)}>
      <p className="text-muted-foreground text-sm">{message}</p>
      {action ? (
        <Link href={action.href} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
          {action.label}
        </Link>
      ) : null}
    </div>
  );
}

/** Teksty pustych stanów z §7.3 — jedno źródło dla kart i testów. */
export const PULPIT_EMPTY = {
  noInvoices: 'Pokażemy to, gdy wystawisz pierwszą fakturę',
  issueInvoice: { label: 'Wystaw fakturę', href: '/invoices/new' },
  noProductSales: 'Brak sprzedaży poza zaliczkami i korektami',
  trendAfterSecondMonth: 'Wykres pojawi się po drugim miesiącu',
  connectKsef: 'Podłącz KSeF, a faktury kosztowe pobierzemy same',
  connectKsefHref: '/settings/ksef',
} as const;

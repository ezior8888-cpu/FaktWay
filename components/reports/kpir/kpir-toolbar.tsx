import Link from 'next/link';

import { DemoBadge } from '@/components/dashboard/demo-badge';
import { RiArrowLeftSLine, RiArrowRightSLine, RiDownload2Line } from '@remixicon/react';

import MonthSelector from '@/components/expenses/finora/month-selector';
import { buttonVariants } from '@/components/ui/button';
import { shiftMonth } from '@/lib/expenses/month';
import { cn } from '@/lib/utils';

/** Adres KPiR dla miesiąca RRRR-MM — ten sam kształt co w `MonthSelector` (`query="month-year"`). */
function kpirHref(period: string): string {
  const [year, month] = period.split('-');
  return `/reports/kpir?month=${Number(month)}&year=${year}`;
}

// `cn()`, nie samo `buttonVariants()`: bez scalenia klas zostaje `border-transparent` z bazy cva.
const ARROW = cn(buttonVariants({ variant: 'outline', size: 'icon' }));

/**
 * Pasek nad kartami KPiR: wybór miesiąca (ten sam przełącznik co na Kosztach,
 * w adresie `?month=M&year=RRRR`) i „Eksport KPiR” z gotowym miesiącem
 * i formatem w formularzu eksportu.
 *
 * Poprawka Bartosza 21.10.2026 (przeprojektowanie Księgowości). Bez hooków
 * i bez `'use client'`: rysuje go i `KpirView`, i strona serwerowa w stanie
 * „Raport wstrzymany” (wtedy bez eksportu). Prop nazywa się `period`, nie
 * `month` — test strefy czasowej szuka wśród dzieci strony JEDNEGO elementu
 * z liczbowym `month` (to `KpirView`).
 *
 * Strzałki „Poprzedni / Następny miesiąc” po obu stronach listy: lista ma
 * 24 miesiące wstecz, a dawne przyciski KPiR prowadziły dowolnie daleko
 * (np. do faktur z importu historii KSeF). Zwykłe linki, więc działają też
 * w komponencie serwerowym i na ekranie błędu.
 */
export function KpirToolbar({
  period,
  currentMonth,
  monthTitle,
  exportHref,
  demo = false,
}: {
  /** Wybrany miesiąc RRRR-MM. */
  period: string;
  /** Bieżący miesiąc RRRR-MM (Europe/Warsaw). */
  currentMonth: string;
  /** „Wrzesień 2026”. */
  monthTitle: string;
  exportHref?: string;
  /** Dane przykładowe (przed weryfikacją KSeF) — plakietka po lewej. */
  demo?: boolean;
}) {
  return (
    <div className={cn('flex items-center gap-2 sm:justify-end', demo && 'flex-wrap')}>
      {demo ? (
        // Na telefonie plakietka w osobnym rzędzie nad wyborem miesiąca.
        <span className="max-sm:basis-full sm:mr-auto">
          <DemoBadge />
        </span>
      ) : null}
      <Link href={kpirHref(shiftMonth(period, -1))} aria-label="Poprzedni miesiąc" className={ARROW}>
        <RiArrowLeftSLine aria-hidden />
      </Link>
      <MonthSelector
        month={period}
        currentMonth={currentMonth}
        basePath="/reports/kpir"
        query="month-year"
        ariaLabel="Miesiąc KPiR"
        // Na dotyku wysokość jak strzałek i „Eksport KPiR” (cel dotyku 44 px).
        className="max-sm:w-auto max-sm:min-w-0 max-sm:flex-1 [@media(pointer:coarse)]:min-h-[44px]"
      />
      <Link href={kpirHref(shiftMonth(period, 1))} aria-label="Następny miesiąc" className={ARROW}>
        <RiArrowRightSLine aria-hidden />
      </Link>
      {/* Nazwa miesiąca w znaczniku z serwera (nie zależy od wnętrza Select) i ogłoszenie zmiany miesiąca. */}
      <span className="sr-only" aria-live="polite">
        {monthTitle}
      </span>
      {exportHref ? (
        <Link href={exportHref} className={cn(buttonVariants())}>
          <RiDownload2Line aria-hidden />
          Eksport KPiR
        </Link>
      ) : null}
    </div>
  );
}

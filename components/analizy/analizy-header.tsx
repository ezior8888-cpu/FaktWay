import type { MonthOption } from '@/lib/analytics-finance/months';

import { DemoBadge } from '@/components/dashboard/demo-badge';

import { AnalizyModeSwitch } from './analizy-mode-switch';
import { ANALIZY_MODES, type AnalizyMode } from './analizy-modes';
import MonthSelector from './finora/month-selector';

export { ANALIZY_MODES, type AnalizyMode };

/**
 * Nagłówek strony analiz — 1:1 z Finory `monthly-analytics/index.tsx`:
 * tytuł i podpis po lewej, po prawej sterowanie. Poprawka Bartosza
 * 21.10.2026 (Analizy 1:1 z Finory, jedna pozycja menu): obok wyboru
 * miesiąca stoi przełącznik „Sprzedaż | Koszty”, a tytuł i podpis wynikają
 * z rodzaju analizy — każdy ma własny `<h1>`, jak zakładki Wydatki / Skrzynka.
 *
 * Odstępstwo od Finory: tam sam wybór miesiąca dostaje `max-sm:self-end`.
 * U nas po prawej są dwa elementy, więc to grupa `max-sm:justify-between`
 * (na telefonie przełącznik z lewej, miesiąc z prawej, jedna linia),
 * a `MonthSelector` nie dostaje klasy.
 */
export function AnalizyHeader({
  mode,
  options,
  month,
  currentMonth,
  demo = false,
}: {
  mode: AnalizyMode;
  options: MonthOption[];
  /** Wybrany miesiąc RRRR-MM (już sprawdzony przez `resolveAnalyticsMonth`). */
  month: string;
  /** Bieżący miesiąc w Polsce — przełącznik nie dokleja go do adresu. */
  currentMonth: string;
  /** Firma przed weryfikacją KSeF — na stronie są dane przykładowe. */
  demo?: boolean;
}) {
  const { title, description } = ANALIZY_MODES[mode];

  return (
    <div className="flex justify-between gap-3 max-sm:flex-col sm:items-center">
      <div>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">{title}</h1>
          {demo ? <DemoBadge /> : null}
        </div>
        <p className="text-muted-foreground text-sm">{description}</p>
      </div>
      <div className="flex items-center gap-3 max-sm:justify-between">
        <AnalizyModeSwitch mode={mode} month={month} currentMonth={currentMonth} />
        <MonthSelector options={options} value={month} />
      </div>
    </div>
  );
}

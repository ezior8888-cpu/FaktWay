import Link from 'next/link';

import { ANALYTICS_MONTH_PARAM } from '@/lib/analytics-finance/months';
import { cn } from '@/lib/utils';

import { ANALIZY_MODE_ORDER, ANALIZY_MODES, type AnalizyMode } from './analizy-modes';

/**
 * Przełącznik „Sprzedaż | Koszty” (poprawka Bartosza 21.10.2026: Analizy 1:1
 * z Finory, jedna pozycja menu „Analizy”). Wygląd to segment `RadioGroup`
 * z Finory, jak `components/reports/segmented-control.tsx`, ale każda opcja
 * to osobny adres (`/analizy/sprzedaz`, `/analizy/koszty`), więc to nawigacja
 * z dwoma linkami i `aria-current`, a nie grupa radiowa — Server Component,
 * bez JS, działa też ze środkowego kliknięcia i „otwórz w nowej karcie”.
 *
 * `h-8` zamiast `h-9` segmentu Księgowości: w skali SM wyrównuje przełącznik
 * do 28 px `SelectTrigger` wyboru miesiąca obok. W ciemnym motywie tor
 * `dark:bg-card`, pigułka `dark:bg-input`: przełącznik stoi na STRONIE
 * (`bg-background`), nie na karcie jak `segmented-control.tsx`, a korzeń
 * `/analizy` ustawia `--muted` na `--background` — tor w `bg-muted` albo
 * `bg-background` zlewał się ze stroną i „Koszty” wisiały jako goły tekst.
 * `bg-card` daje warstwy Finory: jaśniejszy tor na stronie, jeszcze jaśniejsza
 * pigułka (poprawka z przeglądu 21.10.2026).
 *
 * Wybrany miesiąc przechodzi na drugi rodzaj analizy (`?miesiac=`), ale tylko
 * gdy nie jest bieżącym — adres bieżącego miesiąca zostaje czysty.
 */
export function AnalizyModeSwitch({
  mode,
  month,
  currentMonth,
}: {
  mode: AnalizyMode;
  month: string;
  currentMonth: string;
}) {
  const query = month !== currentMonth ? `?${ANALYTICS_MONTH_PARAM}=${encodeURIComponent(month)}` : '';

  return (
    <nav
      aria-label="Rodzaj analizy"
      className="bg-muted text-muted-foreground inline-flex h-8 w-fit items-center gap-0 p-1 dark:bg-card"
    >
      {ANALIZY_MODE_ORDER.map((m) => {
        const active = m === mode;
        return (
          <Link
            key={m}
            href={`${ANALIZY_MODES[m].href}${query}`}
            prefetch={false}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'inline-flex h-full items-center justify-center px-2 py-1 text-sm font-medium whitespace-nowrap transition-all outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-4',
              active && 'bg-card text-foreground dark:bg-input',
            )}
          >
            {ANALIZY_MODES[m].label}
          </Link>
        );
      })}
    </nav>
  );
}
